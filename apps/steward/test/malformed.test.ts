import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import { stewardConsumer, type Env } from "../src/steward-consumer.js";
import type { StewardWriter } from "../src/steward.js";

// SPINE-02 — the failure-path test (no poison-loop).
//
// A batch message that fails the §6.4 field-presence shape check (missing
// op/entity/idempotencyKey) must be:
//   - ack()'d (NEVER retried — a malformed event can never become valid, so a retry
//     would poison-loop the queue), and
//   - reported as a Flagger P3 (the consumer calls flag(env,"P3",…), which emits the
//     canonical op:"upsert"/entity:"flag" event with payload.severity==="P3").
// The malformed event must NOT reach apply() — no counter/ledger row is written.

const STEWARD_LOCK = (
  env as unknown as { STEWARD_LOCK: DurableObjectNamespace<StewardWriter> }
).STEWARD_LOCK;

/** A fake MessageBatch over a single message, with spied ack()/retry(). */
function fakeBatch(body: unknown) {
  const ack = vi.fn();
  const retry = vi.fn();
  const msg = { id: "m1", timestamp: new Date(), attempts: 1, body, ack, retry };
  const batch = {
    queue: "atlas-wire",
    messages: [msg],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
  return { batch, ack, retry };
}

describe("malformed — ack + Flagger P3, no poison-loop (no write)", () => {
  it("missing op/entity/idempotencyKey → ack(), P3 raised, no apply()", async () => {
    // Spy WIRE.send so we can assert the P3 Flagger emission (flag() routes through it).
    const sent: unknown[] = [];
    const spyEnv = {
      ...(env as unknown as Env),
      WIRE: { send: vi.fn(async (e: unknown) => { sent.push(e); }) },
    } as unknown as Env;

    // A malformed event: has agent, but no op/entity/idempotencyKey.
    const { batch, ack, retry } = fakeBatch({ agent: "Forge", payload: { delta: 1 } });

    await stewardConsumer.queue(
      batch as unknown as MessageBatch<WireEvent>,
      spyEnv,
    );

    // ack()'d exactly once; NEVER retried (no poison-loop).
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    // Exactly one canonical Flagger P3 event was emitted.
    expect(sent).toHaveLength(1);
    const parsed = WireEvent.parse(sent[0]);
    expect(parsed.op).toBe("upsert"); // a flag is a stable row, mutated in place
    expect(parsed.entity).toBe("flag");
    expect(parsed.type).toBe("flag");
    expect((parsed.payload as { severity?: string }).severity).toBe("P3");

    // No write reached apply(): the real DB has no counter/ledger row for this event.
    const steward = STEWARD_LOCK.getByName("vault");
    expect((await steward.counter("tasks")).value).toBe(0);
    const db = (env as unknown as { DB: D1Database }).DB;
    const ledger = await db
      .prepare("SELECT COUNT(*) AS c FROM idempotency_keys")
      .first<{ c: number }>();
    expect(ledger?.c).toBe(0);
  });
});
