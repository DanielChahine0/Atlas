import type { Env as SharedEnv } from "@atlas/shared";
import { flag } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import type { StewardWriter } from "./steward.js";

/**
 * Steward's local Env: the shared binding surface with `STEWARD_LOCK` narrowed to a
 * `StewardWriter` namespace (so `steward.apply(e)` typechecks over the DO RPC). The
 * shared `Env` types STEWARD_LOCK as an optional, untyped namespace (it is
 * Steward-only), so we `Omit` then re-declare it required+typed rather than
 * `extends` (which cannot change a property's type). WIRE is required here —
 * Steward PRODUCES Flagger events on it.
 */
export interface Env extends Omit<SharedEnv, "STEWARD_LOCK"> {
  STEWARD_LOCK: DurableObjectNamespace<StewardWriter>;
}

/**
 * The SINGLE `atlas-wire` consumer (Pillar 1). apps/steward is the ONLY Worker
 * whose `queues.consumers[].queue` is `atlas-wire`; a second consumer anywhere is
 * a hard CI failure.
 *
 * Serialization is double-enforced: `max_concurrency: 1` on the consumer block
 * (the belt) + the single named DO lock `getByName("vault")` (the suspenders).
 * The batch is processed with a SERIAL `for…of` — never a parallel fan-out over
 * the batch (which would break ordering / overlap writes).
 *
 * Failure handling:
 *   - Malformed (fails the §6.4 field-presence shape check) → flag P3 + `msg.ack()`
 *     + continue. ACK, never retry — a malformed event can never become valid, so
 *     retrying would poison-loop. The write never reaches `apply()`.
 *   - Transient `apply()` throw → `msg.retry({delaySeconds:60})` (redelivery is
 *     safe; the ledger dedups). At `msg.attempts >= 4` also flag P2; exhausted
 *     retries fall through to the `atlas-wire-dlq` dead-letter queue (SPINE-05).
 *
 * `flag()` is called EXACTLY as `flag(env, severity, title, detail?)`
 * (GLOBAL DECISION 2). The helper builds the full flag record and emits the
 * canonical Flagger event (op:"upsert" / entity:"flag" / idempotencyKey===flag.id,
 * GLOBAL DECISION 1) — the consumer NEVER hand-builds a Flagger event.
 */
export const stewardConsumer = {
  async queue(batch: MessageBatch<WireEvent>, env: Env): Promise<void> {
    const steward = env.STEWARD_LOCK.getByName("vault"); // single global writer
    for (const msg of batch.messages) {
      // SERIAL — never a parallel fan-out (would break the single-writer ordering).
      const e = msg.body;
      if (!e?.agent || !e?.op || !e?.entity || !e?.idempotencyKey) {
        // Malformed: ack (don't poison-loop) + raise a P3 incident.
        await flag(env, "P3", "malformed wire event", JSON.stringify(e ?? null));
        msg.ack();
        continue;
      }
      try {
        await steward.apply(e); // replay & success both ⇒ ack
        msg.ack();
      } catch (err) {
        if (msg.attempts >= 4) {
          await flag(
            env,
            "P2",
            "steward write failing",
            JSON.stringify({ key: e.idempotencyKey, err: String(err) }),
          );
        }
        // Redelivery is safe — the ledger dedups; exhausted retries → atlas-wire-dlq.
        msg.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, WireEvent>;
