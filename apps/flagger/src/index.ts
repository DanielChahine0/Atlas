/**
 * index.ts — Flagger Worker: sole consumer of `atlas-incidents` (WEEKLY-02, Plan 02-02).
 *
 * Architecture:
 * - queue(batch): consumes atlas-incidents; scores, dedupes, routes each incident
 *   through FlaggerState DO; pushes P1/P2 via ntfy; emits canonical flag upsert to atlas-wire
 * - fetch(request): token-gated /ack inbound route (only inbound surface in Phase 2)
 *
 * Pillar 1: this Worker consumes atlas-incidents ONLY (NOT atlas-wire). Steward
 * remains the sole atlas-wire consumer. Flagger is a PRODUCER on atlas-wire.
 */

import { RawIncidentSchema } from "@atlas/shared";
import type { RawIncident, FlagRecord } from "@atlas/shared";
import type { Env as SharedEnv } from "@atlas/shared";
import { send } from "@atlas/wire";
import { redact } from "@atlas/security";
import type { WireEvent } from "@atlas/wire";
import { FlaggerState } from "./state.js";
import { score } from "./score.js";
import { pushFlag } from "./push.js";
import { timingSafeEqual } from "./auth.js";

// Export FlaggerState class so vitest-pool-workers can discover it as a DO class.
export { FlaggerState };

/** Flagger's local Env — extends SharedEnv with required bindings. */
export interface Env extends Omit<SharedEnv, "INCIDENTS"> {
  /** Consumer binding for atlas-incidents (Flagger is the sole consumer). */
  INCIDENTS: Queue<RawIncident>;
  /** FlaggerState DO namespace — addressed as getByName("fleet"). */
  FLAGGER_STATE: DurableObjectNamespace<FlaggerState>;
  /** ntfy.sh topic (Secrets Store async binding). */
  NTFY_TOPIC?: SecretsStoreSecret;
  /** ntfy.sh auth token (Secrets Store async binding). */
  NTFY_TOKEN?: SecretsStoreSecret;
  /** Ack endpoint Bearer token (Secrets Store async binding). */
  ACK_TOKEN?: SecretsStoreSecret;
}

/**
 * Build the canonical flag upsert Wire event for atlas-wire → Steward → Vault.
 *
 * The §6.4 WireEvent contract types `payload` as `Record<string, unknown>` (the wire
 * schema is `z.record(z.string(), z.unknown())` — intentionally NO index signature on the
 * shared FlagRecord type). We cast the FlagRecord into the wire payload locally at the
 * emit boundary; we do NOT weaken FlagRecord or the WireEvent contract.
 */
function buildFlagWireEvent(flag: FlagRecord): WireEvent {
  return {
    agent: "Flagger",
    type: "flag",
    entity: "flag",
    op: "upsert",
    payload: flag as unknown as Record<string, unknown>,
    idempotencyKey: flag.id,
  };
}

/** Build a P3 flag upsert Wire event for malformed incidents (sent directly to WIRE). */
function buildMalformedFlagEvent(msgId: string, body: unknown): WireEvent {
  const hash = simpleHash(String(msgId));
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  const id = `flg:${date}:Flagger:${hash}`;
  const flag: FlagRecord = {
    id,
    ts: new Date().toISOString(),
    source_agent: "Flagger",
    severity: "P3",
    trust: 50,
    title: "malformed incident on atlas-incidents",
    detail: redact(JSON.stringify(body)).slice(0, 500),
    status: "open",
  };
  return buildFlagWireEvent(flag);
}

function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export default {
  // The batch body is typed `unknown` (not `MessageBatch<RawIncident>`): a queued message
  // is untrusted until RawIncidentSchema.safeParse narrows it at runtime, and typing it as
  // RawIncident here is not assignable to ExportedHandlerQueueHandler's body parameter.
  // safeParse below is the single source of truth for the incident shape.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // Update KV last_seen FIRST (best-effort — watchdog depends on this)
    await env.CONFIG.put("flagger:last_seen", String(Date.now())).catch(() => {});

    for (const msg of batch.messages) {
      // SERIAL for...of — never Promise.all (single-writer discipline through the DO)
      try {
        const parsed = RawIncidentSchema.safeParse(msg.body);

        if (!parsed.success) {
          // Malformed: ack() immediately (never retry) + P3 flag sent directly to WIRE
          await send(env, buildMalformedFlagEvent(msg.id, msg.body));
          msg.ack();
          continue;
        }

        const incident = parsed.data;

        // H1: heartbeat incidents seed the alarm scheduler — never become flags.
        // Heartbeats carry run_id (e.g. "filer:sweep:2026-06-05") as the cron_utc key.
        // recordHeartbeat writes hb:<agent> slot and refreshes the DO alarm.
        if (incident.kind === "heartbeat") {
          await env.FLAGGER_STATE.getByName("fleet").recordHeartbeat(
            incident.source_agent,
            Date.now(),
            incident.run_id ?? "",
          );
          msg.ack();
          continue;
        }

        // Build signature: source_agent + kind + hash of title+detail
        const fingerprint = simpleHash(`${incident.title}|${incident.detail ?? ""}`);
        const signature = `${incident.source_agent}:${incident.kind}:${fingerprint}`;

        const stateStub = env.FLAGGER_STATE.getByName("fleet");

        // Score the incident (pure function — no LLM)
        const scored = score(incident, 0);

        // Upsert flag (dedup by signature, recurrence bump)
        const flag = await stateStub.upsertFlag(signature, {
          source_agent: incident.source_agent,
          severity: scored.severity,
          trust: scored.trust,
          title: incident.title,
          detail: incident.detail,
          status: "open",
        });

        // Re-score with actual recurrence from the DO
        const rescore = score(incident, flag.recurrence);
        const finalSeverity = rescore.severity;

        // P1/P2: route to ntfy push (fire-and-forget, board fallback on failure)
        const pushEnabled = (await env.CONFIG.get("flagger.push_enabled")) === "true";
        if (pushEnabled && (finalSeverity === "P1" || finalSeverity === "P2")) {
          // Build ack URL: we don't know our own hostname here; use a placeholder
          const ackUrl = `https://flagger.workers.dev/ack`;
          await pushFlag(env, flag, ackUrl).catch(() => {});
        }

        // Emit canonical flag upsert to atlas-wire → Steward → Vault
        await send(env, buildFlagWireEvent(flag));
        msg.ack();
      } catch (err) {
        console.error("flagger: incident processing failed", msg.id, err);
        msg.retry({ delaySeconds: 30 });
      }
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ack" && request.method === "POST") {
      // Constant-time token auth (D2-02) — fail-closed on missing binding
      const token = await env.ACK_TOKEN?.get();
      if (!token) return new Response("Unauthorized", { status: 401 });

      const auth = request.headers.get("Authorization") ?? "";
      if (!(await timingSafeEqual(auth, `Bearer ${token}`))) {
        return new Response("Unauthorized", { status: 401 });
      }

      const { id } = await request.json<{ id: string }>();
      await env.FLAGGER_STATE.getByName("fleet").ackFlag(id);
      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
