/**
 * flagger-watchdog — separate Cron Worker that detects Flagger silence (D2-08).
 *
 * The one alert path that does NOT depend on the thing it alerts about:
 * it emits DIRECTLY to atlas-wire (bypassing atlas-incidents, since Flagger
 * is the atlas-incidents consumer and may be dead). NOT a flag() call.
 *
 * Pillar 1: this Worker is a PRODUCER on atlas-wire only. NO consumers block.
 * Cron: every 5 minutes — checks if Flagger has been silent past selfwatch_threshold.
 */

import { send } from "@atlas/wire";
import type { WireEvent } from "@atlas/wire";
import { localDate } from "@atlas/shared";

/** Flagger watchdog's env surface — minimal: WIRE producer + CONFIG KV + optional ntfy secrets. */
export interface WatchdogEnv {
  /** Wire producer (atlas-wire) — emits self-P1 directly when Flagger is stale. */
  WIRE: Queue<WireEvent>;
  /** CONFIG KV: reads selfwatch_threshold + flagger:last_seen. */
  CONFIG: KVNamespace;
  /** ntfy.sh topic (Secrets Store async binding). Optional belt-and-suspenders push. */
  NTFY_TOPIC?: SecretsStoreSecret;
  /** ntfy.sh auth token (Secrets Store async binding). */
  NTFY_TOKEN?: SecretsStoreSecret;
}

/** Default staleness threshold: 15 minutes in ms. */
const DEFAULT_THRESHOLD_MS = 900_000;

/**
 * Build the canonical self-flag Wire event that the watchdog emits directly to atlas-wire.
 * Bypasses atlas-incidents because Flagger (the incidents consumer) may be dead.
 *
 * Wire event shape per §6.4:
 *   { agent:"Flagger", type:"flag", entity:"flag", op:"upsert",
 *     payload:{ id, source_agent:"Flagger", severity:"P1", trust:100, ... status:"open" },
 *     idempotencyKey:"flg:<date>:Flagger:watchdog" }
 */
function buildSelfFlagEvent(date: string, ageMs: number, thresholdMs: number): WireEvent {
  const idempotencyKey = `flg:${date}:Flagger:watchdog`;
  const ageMins = Math.round(ageMs / 60_000);
  const thresholdMins = Math.round(thresholdMs / 60_000);
  return {
    agent: "Flagger",
    type: "flag",
    entity: "flag",
    op: "upsert",
    payload: {
      id: idempotencyKey,
      source_agent: "Flagger",
      severity: "P1",
      trust: 100,
      title: "Flagger may be down — no heartbeat",
      detail: `Last seen ${ageMins} min ago (threshold ${thresholdMins}m)`,
      status: "open",
    },
    idempotencyKey,
  };
}

/**
 * Attempt a direct ntfy push as belt-and-suspenders when Flagger is stale.
 * Failure is non-fatal — the Wire event (above) is the primary channel.
 */
async function directPush(env: WatchdogEnv, title: string, detail: string): Promise<void> {
  const topic = await env.NTFY_TOPIC?.get();
  if (!topic) return; // push gated off if NTFY_TOPIC not seeded
  const token = await env.NTFY_TOKEN?.get();

  const body = {
    topic,
    title: "[P1] Flagger",
    message: `${title} — ${detail}`,
    priority: 5, // urgent
    tags: ["p1", "flagger", "watchdog"],
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  await fetch("https://ntfy.sh/", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }).catch((err) => {
    // Push failure is non-fatal — the Wire event lands the flag on the board regardless.
    console.error("flagger-watchdog: direct ntfy push failed", err);
  });
}

export default {
  /**
   * Scheduled cron handler — runs every 5 minutes.
   *
   * Reads `flagger:last_seen` (epoch ms string) from CONFIG KV (written by Flagger
   * on each successfully processed batch). Computes age = Date.now() - lastSeen.
   * If age > selfwatch_threshold (default 15m): emit self-P1 DIRECTLY to atlas-wire
   * and attempt a belt-and-suspenders ntfy push.
   *
   * Fail-toward-alerting: absent last_seen (never set) → lastSeen = 0 → age = Date.now()
   * which always exceeds the threshold → self-P1 emitted.
   */
  async scheduled(
    _controller: ScheduledController,
    env: WatchdogEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Read threshold (ms) from CONFIG, default 15m.
    const thresholdStr = await env.CONFIG.get("selfwatch_threshold");
    const threshold = thresholdStr ? parseInt(thresholdStr, 10) : DEFAULT_THRESHOLD_MS;

    // Read Flagger's last-seen timestamp. Absent = 0 (fail-toward-alerting).
    const lastSeenStr = await env.CONFIG.get("flagger:last_seen");
    const lastSeen = lastSeenStr ? parseInt(lastSeenStr, 10) : 0;

    const age = Date.now() - lastSeen;

    if (age > threshold) {
      const date = localDate(env as unknown as Parameters<typeof localDate>[0]);
      const event = buildSelfFlagEvent(date, age, threshold);

      // Emit DIRECTLY to atlas-wire — NOT via flag() which targets atlas-incidents.
      // Flagger is the atlas-incidents consumer and may be dead.
      await send(env, event);

      // Belt-and-suspenders: also attempt a direct ntfy push.
      const title = "Flagger may be down — no heartbeat";
      const detail = event.payload
        ? (event.payload as Record<string, unknown>).detail as string
        : `Last seen ${Math.round(age / 60_000)} min ago`;
      await directPush(env, title, detail);
    }
  },
} satisfies ExportedHandler<WatchdogEnv>;
