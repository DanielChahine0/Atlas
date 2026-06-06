import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { dlqSink, type Env } from "../src/index.js";

// M1 gap-closure — `atlas-incidents-dlq` consumer path (DoD back half).
//
// Flagger's `atlas-incidents` consumer declares `dead_letter_queue: "atlas-incidents-dlq"`.
// An incident that exhausts Flagger's 3 retries lands on that orphan DLQ and would drop
// after retention with no signal. dlq-sink is extended as a SECOND consumer (for a DIFFERENT
// queue — Pillar 1 is preserved: Steward remains the sole atlas-wire consumer).
//
// For a dead incident the sink must:
//   (1) write a forensic `audit_log` row (outcome="dlq", scope_used="" — NEVER a token),
//   (2) emit a flag upsert event DIRECTLY to atlas-wire (NOT via flag()/atlas-incidents —
//       Flagger is the consumer that just failed; we cannot route through it),
//   (3) always ack() — never retry() (no poison-loop).
//
// The direct atlas-wire emit mirrors the flagger-watchdog "alert path that can't depend
// on the thing it alerts about" pattern (apps/flagger-watchdog emits directly to WIRE).
// Shape: op:"upsert", entity:"flag", severity P1, structured idempotencyKey.

const DB = (env as unknown as { DB: D1Database }).DB;

/** A fake MessageBatch over a single dead incident on atlas-incidents-dlq. */
function fakeIncidentDlqBatch(body: unknown, opts: { id?: string; attempts?: number } = {}) {
  const ack = vi.fn();
  const retry = vi.fn();
  const msg = {
    id: opts.id ?? "dead-inc-1",
    timestamp: new Date(),
    attempts: opts.attempts ?? 3,
    body,
    ack,
    retry,
  };
  const batch = {
    queue: "atlas-incidents-dlq",
    messages: [msg],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
  return { batch, ack, retry, msg };
}

/** An env that spies on WIRE.send (the direct atlas-wire emit path). */
function spyEnvWithWire() {
  const wireEvents: WireEvent[] = [];
  const e = {
    ...(env as unknown as Env),
    WIRE: {
      send: vi.fn(async (evt: WireEvent) => {
        wireEvents.push(evt);
      }),
      sendBatch: vi.fn(async () => {}),
    },
    INCIDENTS: {
      send: vi.fn(async (_inc: RawIncident) => {}),
      sendBatch: vi.fn(async () => {}),
    },
  } as unknown as Env;
  return { env: e, wireEvents };
}

describe("dlq-sink — atlas-incidents-dlq consumer path (M1 gap closure)", () => {
  it("dead RawIncident → audit_log(outcome='dlq') + DIRECT atlas-wire flag upsert (P1), ack() (never retry)", async () => {
    const deadIncident: RawIncident = {
      source_agent: "Filer",
      kind: "chain_halted",
      severity_hint: "P2",
      title: "Filer sweep failed",
    };
    const { env: e, wireEvents } = spyEnvWithWire();
    const { batch, ack, retry } = fakeIncidentDlqBatch(deadIncident);

    await dlqSink.queue(batch as unknown as MessageBatch<unknown>, e, {} as ExecutionContext);

    // Always ack()'d, NEVER retried.
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    // DIRECT atlas-wire flag upsert emitted (NOT via flag()/atlas-incidents).
    expect(wireEvents).toHaveLength(1);
    const evt = wireEvents[0]!;
    expect(evt.op).toBe("upsert");
    expect(evt.entity).toBe("flag");
    expect(evt.agent).toBe("dlq-sink");
    // Severity P1 — dead incident is the highest-consequence substrate.
    expect((evt.payload as Record<string, unknown>)["severity"]).toBe("P1");
    // Structured idempotencyKey — never random.
    expect(evt.idempotencyKey).toMatch(/^flg:/);

    // Forensic audit_log row written.
    const row = await DB.prepare(
      "SELECT agent, action, outcome, scope_used, flag_id FROM audit_log WHERE action = ?",
    )
      .bind("dlq.incidents_dead_letter")
      .first<{
        agent: string;
        action: string;
        outcome: string;
        scope_used: string | null;
        flag_id: string;
      }>();
    expect(row).not.toBeNull();
    expect(row?.outcome).toBe("dlq");
    // scope_used is empty — queue failure is not a token-scoped action; NEVER a token.
    expect(row?.scope_used ?? "").toBe("");
  });

  it("malformed / non-RawIncident dead message on atlas-incidents-dlq → P1 direct atlas-wire flag, ack()", async () => {
    const { env: e, wireEvents } = spyEnvWithWire();
    const { batch, ack, retry } = fakeIncidentDlqBatch({ garbage: true }, { id: "dead-inc-2" });

    await dlqSink.queue(batch as unknown as MessageBatch<unknown>, e, {} as ExecutionContext);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    // Still emits a direct atlas-wire flag for any dead message on this queue.
    expect(wireEvents).toHaveLength(1);
    expect(wireEvents[0]!.op).toBe("upsert");
    expect(wireEvents[0]!.entity).toBe("flag");
    expect((wireEvents[0]!.payload as Record<string, unknown>)["severity"]).toBe("P1");
  });

  it("atlas-incidents-dlq path does NOT call flag() (no atlas-incidents enqueue — Flagger is the failing consumer)", async () => {
    const deadIncident: RawIncident = {
      source_agent: "Forge",
      kind: "model_error",
      severity_hint: "P2",
      title: "Forge model error",
    };
    const incidentsSpy = vi.fn(async (_inc: RawIncident) => {});
    const { env: e } = spyEnvWithWire();
    // Override INCIDENTS.send with a spy to assert it is NOT called.
    (e as unknown as { INCIDENTS: { send: typeof incidentsSpy } }).INCIDENTS.send = incidentsSpy;

    const { batch } = fakeIncidentDlqBatch(deadIncident, { id: "dead-inc-3" });
    await dlqSink.queue(batch as unknown as MessageBatch<unknown>, e, {} as ExecutionContext);

    // NEVER enqueues to atlas-incidents (that's the failing queue we're already past).
    expect(incidentsSpy).not.toHaveBeenCalled();
  });

  it("internal sink error on atlas-incidents-dlq path still ack()s (no poison-loop)", async () => {
    const deadIncident: RawIncident = {
      source_agent: "Scout",
      kind: "heartbeat",
      severity_hint: "P4",
      title: "Scout heartbeat",
    };
    const broken = {
      ...(env as unknown as Env),
      INCIDENTS: { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) },
      WIRE: { send: vi.fn(async () => { throw new Error("Wire unavailable"); }), sendBatch: vi.fn(async () => {}) },
      DB: {
        prepare: () => { throw new Error("D1 unavailable"); },
      },
    } as unknown as Env;

    const { batch, ack, retry } = fakeIncidentDlqBatch(deadIncident, { id: "dead-inc-4" });
    await expect(
      dlqSink.queue(batch as unknown as MessageBatch<unknown>, broken, {} as ExecutionContext),
    ).resolves.toBeUndefined();

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});
