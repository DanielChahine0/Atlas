import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import type { RawIncident } from "@atlas/shared";
import { stewardConsumer, type Env } from "../src/steward-consumer.js";
import type { StewardWriter } from "../src/steward.js";

// SPINE-02 — the failure-path test (no poison-loop).
//
// A batch message that fails the §6.4 field-presence shape check (missing
// op/entity/idempotencyKey) must be:
//   - ack()'d (NEVER retried — a malformed event can never become valid, so a retry
//     would poison-loop the queue), and
//   - reported as a Flagger incident (D2-05: flag() now enqueues a RawIncident onto
//     atlas-incidents via env.INCIDENTS.send, not a WireEvent onto WIRE).
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

/** Build a spy env with INCIDENTS.send tracked (D2-05: flag() -> INCIDENTS, not WIRE). */
function makeSpyEnv() {
  const incidents: RawIncident[] = [];
  const spyEnv = {
    ...(env as unknown as Env),
    INCIDENTS: {
      send: vi.fn(async (inc: RawIncident) => { incidents.push(inc); }),
    },
  } as unknown as Env;
  return { spyEnv, incidents };
}

describe("malformed — ack + Flagger incident (INCIDENTS queue), no poison-loop (no write)", () => {
  it("missing op/entity/idempotencyKey → ack(), RawIncident P3 enqueued to INCIDENTS, no apply()", async () => {
    const { spyEnv, incidents } = makeSpyEnv();

    // A malformed event: has agent, but no op/entity/idempotencyKey.
    const { batch, ack, retry } = fakeBatch({ agent: "Forge", payload: { delta: 1 } });

    await stewardConsumer.queue(
      batch as unknown as MessageBatch<WireEvent>,
      spyEnv,
    );

    // ack()'d exactly once; NEVER retried (no poison-loop).
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    // Exactly one RawIncident was enqueued to INCIDENTS (D2-05).
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.severity_hint).toBe("P3");
    expect(incidents[0]!.kind).toBe("malformed_event");

    // No write reached apply(): the real DB has no counter/ledger row for this event.
    const steward = STEWARD_LOCK.getByName("vault");
    expect((await steward.counter("tasks")).value).toBe(0);
    const db = (env as unknown as { DB: D1Database }).DB;
    const ledger = await db
      .prepare("SELECT COUNT(*) AS c FROM idempotency_keys")
      .first<{ c: number }>();
    expect(ledger?.c).toBe(0);
  });

  // W8 — the malformed gate must also reject a PAYLOAD-less (or non-object payload)
  // event. Without the `payload` clause it reaches apply(), throws a TypeError on
  // `e.payload.counter`, and is mis-routed to the transient-retry path → DLQ. With the
  // fix it is ack()'d + P3 immediately, like any other malformed event (no retry).
  it("W8 — a payload-less event is ack()'d + P3 incident immediately (no retry/DLQ)", async () => {
    const { spyEnv, incidents } = makeSpyEnv();

    // Has every §6.4 scalar field, but NO payload at all.
    const { batch, ack, retry } = fakeBatch({
      agent: "Forge",
      type: "task.created",
      entity: "tasks",
      op: "increment",
      idempotencyKey: "forge:task:nopayload",
    });

    await stewardConsumer.queue(batch as unknown as MessageBatch<WireEvent>, spyEnv);

    // Immediate ack, NEVER retried (no poison-loop / no DLQ).
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    // A RawIncident P3 was enqueued to INCIDENTS.
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.severity_hint).toBe("P3");

    // It never reached apply(): no ledger row for the key.
    const db = (env as unknown as { DB: D1Database }).DB;
    const ledger = await db
      .prepare("SELECT COUNT(*) AS c FROM idempotency_keys WHERE key = ?")
      .bind("forge:task:nopayload")
      .first<{ c: number }>();
    expect(ledger?.c).toBe(0);
  });

  it("W8 — a non-object payload (string) is ack()'d + P3 incident immediately", async () => {
    const { spyEnv, incidents } = makeSpyEnv();
    const { batch, ack, retry } = fakeBatch({
      agent: "Forge",
      type: "task.created",
      entity: "tasks",
      op: "increment",
      idempotencyKey: "forge:task:strpayload",
      payload: "not-an-object",
    });
    await stewardConsumer.queue(batch as unknown as MessageBatch<WireEvent>, spyEnv);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(incidents[0]!.severity_hint).toBe("P3");
  });

  // C2 (consumer mapping) — a well-formed event whose delta is non-integer makes
  // apply() throw a NonRetryableError ACROSS the DO RPC boundary. The consumer must
  // map it to ack() + P3 (NOT retry → it would poison-loop, never reaching the DLQ).
  it("C2 — a non-integer delta (NonRetryableError) is ack()'d + P3 incident, not retried", async () => {
    const { spyEnv, incidents } = makeSpyEnv();

    // Structurally valid §6.4 event, but the delta is a non-numeric string.
    const { batch, ack, retry } = fakeBatch({
      agent: "Forge",
      type: "task.created",
      entity: "tasks",
      op: "increment",
      payload: { counter: "c2_consumer", delta: "not-a-number" },
      idempotencyKey: "forge:task:c2:consumer",
    });

    await stewardConsumer.queue(batch as unknown as MessageBatch<WireEvent>, spyEnv);

    // ack + P3 incident, NEVER retried.
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.severity_hint).toBe("P3");
    expect(incidents[0]!.kind).toBe("steward_nonretryable");

    // The counter column was never corrupted (no row written).
    const db = (env as unknown as { DB: D1Database }).DB;
    const counter = await db
      .prepare("SELECT value FROM counters WHERE entity = ?")
      .bind("c2_consumer")
      .first<{ value: number }>();
    expect(counter).toBe(null);

    // The DO is NOT bricked by the NonRetryableError (it was captured inside the
    // gate and re-thrown outside) — a subsequent valid apply still serializes.
    const steward = STEWARD_LOCK.getByName("vault");
    expect(
      await steward.apply({
        agent: "Forge",
        type: "task.created",
        entity: "tasks",
        op: "increment",
        payload: { counter: "c2_after_bad", delta: 1 },
        idempotencyKey: "forge:task:c2:after-bad",
      }),
    ).toEqual({ applied: true });
    expect((await steward.counter("c2_after_bad")).value).toBe(1);
  });
});
