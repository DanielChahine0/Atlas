/**
 * dlq-sink — the consumer of BOTH dead-letter queues (SPINE-05 + D2-05-dlq):
 *   • `atlas-wire-dlq`      — dead WireEvents that exhausted Steward's retries
 *   • `atlas-incidents-dlq` — dead RawIncidents that exhausted Flagger's retries
 *
 * Without a consumer on a DLQ, exhausted-retry messages drop silently after the
 * retention window with no signal (RESEARCH Pitfall 5 / M1). This Worker is the
 * mandatory sink that makes every dead message LOUD instead of lost.
 *
 * For EACH dead message (regardless of queue) it:
 *   (1) writes a durable `audit_log` row (outcome="dlq", scope_used="" — NEVER a
 *       token; security hard invariant), and
 *   (2) raises an owner-visible alert that BYPASSES the failing queue path:
 *       - atlas-wire-dlq path: calls flag() → enqueues a RawIncident onto
 *         atlas-incidents; Flagger is the sole consumer and emits the canonical
 *         flag upsert to atlas-wire → Steward → Vault.
 *       - atlas-incidents-dlq path: emits a flag upsert event DIRECTLY to
 *         atlas-wire (NOT via flag()/atlas-incidents — Flagger is the consumer
 *         that just failed). This mirrors the flagger-watchdog's "alert path that
 *         can't depend on the thing it alerts about" pattern: op:"upsert",
 *         entity:"flag", severity P1, structured idempotencyKey.
 * then ALWAYS `ack()`s. It NEVER `retry()`s: a dead-letter message already
 * exhausted its retries, so re-queuing would poison-loop (Pillar 2 fail-safe).
 *
 * Severity is DETERMINISTIC (never LLM-assigned):
 *   atlas-wire-dlq:
 *     - well-shaped dead WireEvent (real Steward write failure) → P2
 *     - unparseable dead message                                 → P3 (agent="unknown")
 *   atlas-incidents-dlq:
 *     - any dead incident (Flagger exhausted retries)           → P1 (highest-
 *       consequence substrate; dead incident = Flagger cannot process it)
 *
 * Idempotency: all flag ids are deterministic (localDate + contentHash), never
 * crypto.randomUUID(). A redelivered DLQ message produces the SAME flag id and
 * re-targets ONE flag row rather than spamming the board.
 *
 * This Worker consumes `atlas-wire-dlq` and `atlas-incidents-dlq` ONLY. It is a
 * WIRE producer and an INCIDENTS producer. It is NEVER an `atlas-wire` consumer
 * (Pillar 1; Steward alone reads the bus).
 */

import { WireEvent, send } from "@atlas/wire";
import { flag, localDate } from "@atlas/shared";
import type { Env as SharedEnv, Severity, RawIncident } from "@atlas/shared";

/**
 * dlq-sink's local Env: the shared binding surface with `WIRE` + `DB` + `INCIDENTS` required
 * (the sink PRODUCES Flagger incidents onto atlas-incidents via flag() (D2-05) and WRITES the
 * audit_log row). CONFIG is inherited optional from the shared surface.
 */
export interface Env extends Omit<SharedEnv, "INCIDENTS"> {
  WIRE: SharedEnv["WIRE"];
  DB: SharedEnv["DB"];
  INCIDENTS: Queue<RawIncident>;
}

/** Default trust per severity (mirrors @atlas/shared flag()'s DEFAULT_TRUST so the
 * audit_log `trust` column matches the trust the emitted incident carries). A caught,
 * deterministic exception is high-trust (docs/08-flagger.md §3). */
const TRUST: Record<Severity, number> = { P1: 100, P2: 95, P3: 50, P4: 70 };

/** A small, stable, NON-random djb2 content hash — the same family @atlas/shared uses
 * for flag ids. Used to fold an arbitrary-length original key/body into a short,
 * deterministic suffix so the derived title/detail (and therefore flag.id) is stable
 * across DLQ redeliveries — never a random UUID. */
function contentHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Stable structured audit_log row id. Derived (never random) from the local date +
 * the dedupe key so a replay re-targets the SAME forensic row class. */
function auditId(dedupeKey: string): string {
  return `dlq:${localDate()}:${contentHash(dedupeKey)}`;
}

/**
 * Build a DIRECT atlas-wire flag upsert event for a dead `atlas-incidents-dlq` message.
 *
 * This path BYPASSES flag()/atlas-incidents — Flagger is the atlas-incidents consumer
 * that just exhausted its retries; routing through it would be circular. Instead we emit
 * directly to atlas-wire, exactly as flagger-watchdog does for its self-P1 alert.
 *
 * Shape: §6.4 canonical WireEvent (op:"upsert", entity:"flag", agent:"dlq-sink",
 * payload.severity:"P1", structured + stable idempotencyKey).
 */
function buildDeadIncidentFlagEvent(dedupeKey: string, sourceAgent: string): WireEvent {
  const idempotencyKey = `flg:${localDate()}:dlq-sink:${contentHash(`incidents-dlq:${dedupeKey}`)}`;
  const title = `dead incident on atlas-incidents-dlq (P1)`;
  const detail = `A RawIncident from '${sourceAgent}' exhausted Flagger's retries and landed on the DLQ. ` +
    `Flagger could not process it. Direct atlas-wire alert (no atlas-incidents enqueue — Flagger is the failing consumer).`;
  return {
    agent: "dlq-sink",
    type: "flag",
    entity: "flag",
    op: "upsert",
    payload: {
      id: idempotencyKey,
      source_agent: sourceAgent,
      severity: "P1",
      trust: 100,
      title,
      detail,
      status: "open",
    },
    idempotencyKey,
  };
}

/**
 * Handle a dead message from `atlas-incidents-dlq`.
 *
 * Writes an audit_log row + emits a DIRECT atlas-wire flag upsert (P1). Does NOT call
 * flag() (which enqueues to atlas-incidents — Flagger is the failing consumer).
 * Always acks (try/finally) — never retries, no poison-loop.
 */
async function handleDeadIncident(msg: Message<unknown>, env: Env): Promise<void> {
  try {
    // Extract source_agent from the dead incident if parseable; fall back to "unknown".
    let sourceAgent = "unknown";
    let dedupeKey: string;
    if (
      msg.body !== null &&
      typeof msg.body === "object" &&
      "source_agent" in msg.body &&
      typeof (msg.body as Record<string, unknown>)["source_agent"] === "string"
    ) {
      sourceAgent = (msg.body as Record<string, unknown>)["source_agent"] as string;
      dedupeKey = `${sourceAgent}:${safeBodyString(msg.body)}`;
    } else {
      dedupeKey = safeBodyString(msg.body);
    }

    const flagEvent = buildDeadIncidentFlagEvent(dedupeKey, sourceAgent);
    const flagId = flagEvent.idempotencyKey;

    // (1) Durable forensic record FIRST — outcome="dlq", scope_used="" (NEVER a token).
    await env.DB.prepare(
      "INSERT OR REPLACE INTO audit_log(id, ts, agent, action, target, scope_used, gated, decision, outcome, trust, consent_flag, flag_id) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        `dlq:inc:${localDate()}:${contentHash(dedupeKey)}`, // id (stable, structured — not random)
        Date.now(),                // ts
        sourceAgent,               // agent
        "dlq.incidents_dead_letter", // action
        "atlas-incidents-dlq",     // target
        "",                        // scope_used — NEVER a token; queue failure has no scope
        0,                         // gated
        "flagged",                 // decision
        "dlq",                     // outcome
        TRUST["P1"],               // trust — P1 is the highest-consequence substrate
        0,                         // consent_flag
        flagId,                    // flag_id ties this row to the direct Wire alert
      )
      .run();

    // (2) DIRECT atlas-wire flag upsert — bypasses atlas-incidents (Flagger failed).
    // Uses send() (validates §6.4 shape + 128 KB cap before Queue.send).
    await send(env, flagEvent);
  } catch (err) {
    // Sink error must NOT lose the message and must NOT poison-loop.
    console.error("dlq-sink: failed to record dead incident", msg.id, err);
  } finally {
    // ALWAYS ack — never retry(). A message that exhausted retries must not re-loop.
    msg.ack();
  }
}

export const dlqSink = {
  async queue(
    batch: MessageBatch<unknown>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    for (const msg of batch.messages) {
      // SERIAL for…of — never a parallel fan-out (matches the Steward-consumer
      // convention; max_concurrency:1 + this loop keep load/ordering bounded).

      // Branch on the queue that delivered this batch. The two DLQ paths have different
      // alert strategies: atlas-wire-dlq → flag() (Flagger is healthy, can process it);
      // atlas-incidents-dlq → DIRECT atlas-wire emit (Flagger is the failing consumer,
      // so we must bypass it).
      if (batch.queue === "atlas-incidents-dlq") {
        await handleDeadIncident(msg, env);
        continue;
      }

      // atlas-wire-dlq path (default — existing behavior).
      try {
        const parsed = WireEvent.safeParse(msg.body);

        // Deterministic classification + a STABLE dedupe key derived from the
        // ORIGINAL event (its idempotencyKey when parseable, else the raw body) so a
        // redelivered DLQ message folds into ONE flag.
        let severity: Severity;
        let agent: string;
        let entity: string;
        let dedupeKey: string;

        if (parsed.success) {
          // It reached the DLQ ⇒ it exhausted atlas-wire's retries ⇒ a real Steward
          // write failure ⇒ P2 High.
          severity = "P2";
          agent = parsed.data.agent;
          entity = parsed.data.entity;
          dedupeKey = parsed.data.idempotencyKey;
        } else {
          // Unparseable / non-WireEvent dead message ⇒ lower consequence, still
          // deterministic ⇒ P3 Medium. We never trust it as a typed event.
          severity = "P3";
          agent = "unknown";
          entity = "atlas-wire-dlq";
          dedupeKey = safeBodyString(msg.body);
        }

        // The Flagger incident's idempotencyKey === flag.id is STABLE because both
        // title and detail are pure functions of (severity, dedupeKey). flag() hashes
        // (severity|title|detail) into the id, so the same dead message ⇒ the same id
        // ⇒ op:"upsert" re-targets ONE flag row (no duplicate board row on redelivery).
        const title = `dead-letter on atlas-wire-dlq (${severity})`;
        const detail = JSON.stringify({
          agent,
          entity,
          key: dedupeKey,
          attempts: msg.attempts,
        });

        // (1) Durable forensic record FIRST — outcome="dlq", scope_used="" (a queue
        // failure is not a token-scoped action; the row carries NO secret). Positional
        // `?` binds only (no named params). flag_id ties the row to the incident.
        const flagId = `flg:${localDate()}:dlq-sink:${contentHash(`${severity}|${title}|${detail}`)}`;
        await env.DB.prepare(
          "INSERT OR REPLACE INTO audit_log(id, ts, agent, action, target, scope_used, gated, decision, outcome, trust, consent_flag, flag_id) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
          .bind(
            auditId(dedupeKey), // id (stable, structured — not random)
            Date.now(), // ts
            agent, // agent ("unknown" when unparseable)
            "dlq.dead_letter", // action
            entity, // target
            "", // scope_used — NEVER a token; a queue failure has no scope
            0, // gated
            "flagged", // decision
            "dlq", // outcome
            TRUST[severity], // trust
            0, // consent_flag
            flagId, // flag_id ties this row to the Flagger incident
          )
          .run();

        // (2) Emit the Flagger incident (D2-05: flag() now enqueues a RawIncident onto
        // atlas-incidents; Flagger is the sole consumer and routes to atlas-wire + Vault).
        await flag(env, severity, title, detail, {
          sourceAgent: "dlq-sink",
          kind: "dlq_dead_letter",
          suggestedAction:
            severity === "P2"
              ? "investigate the Steward write that exhausted retries for this event"
              : "inspect the malformed dead message; it never parsed as a WireEvent",
        });
      } catch (err) {
        // An internal sink error must NOT lose the message and must NOT poison-loop:
        // log and fall through to the unconditional ack() below. (A dead-letter sink
        // never re-queues — the message already exhausted its retries.)
        console.error("dlq-sink: failed to record dead message", msg.id, err);
      } finally {
        // ALWAYS ack — never retry(). Recording happened (or was logged on error);
        // re-queuing a message that already exhausted retries would poison-loop.
        msg.ack();
      }
    }
  },
} satisfies ExportedHandler<Env>;

/** Best-effort stable string of an arbitrary dead body for the dedupe hash. */
function safeBodyString(body: unknown): string {
  try {
    return typeof body === "string" ? body : JSON.stringify(body);
  } catch {
    return String(body);
  }
}

export default dlqSink;
