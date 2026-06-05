import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import type { RawIncident } from "@atlas/shared";
import { dlqSink, type Env } from "../src/index.js";

// SPINE-05 — the failure-path test (Definition of Done): the back half of the
// "never silent loss" guarantee.
//
// Steward's consumer (00-04) routes exhausted-retry messages to atlas-wire-dlq.
// Without a consumer on that dead-letter queue, those dead events drop silently and
// counters go stale with no signal (RESEARCH Pitfall 5). This sink is the mandatory
// consumer that makes a dead event LOUD: every dead message becomes (1) a durable
// audit_log row (outcome="dlq", scope_used recorded, NEVER a token) AND (2) a
// RawIncident on atlas-incidents via flag() (D2-05: kind "dlq_dead_letter"),
// then is ack()'d (never retried — it already exhausted atlas-wire's retries).
//
// Routing is deterministic:
//   - a well-shaped dead WireEvent (it reached the DLQ ⇒ a real Steward write
//     failure) → P2 High
//   - an unparseable / non-WireEvent dead message → P3 Medium (agent="unknown")

const DB = (env as unknown as { DB: D1Database }).DB;

/** A fake MessageBatch over a single dead message, with spied ack()/retry(). */
function fakeBatch(body: unknown, opts: { id?: string; attempts?: number } = {}) {
  const ack = vi.fn();
  const retry = vi.fn();
  const msg = {
    id: opts.id ?? "dead-1",
    timestamp: new Date(),
    attempts: opts.attempts ?? 5,
    body,
    ack,
    retry,
  };
  const batch = {
    queue: "atlas-wire-dlq",
    messages: [msg],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
  return { batch, ack, retry, msg };
}

/** An env whose INCIDENTS.send is spied (D2-05: flag() -> INCIDENTS, not WIRE). */
function spyEnv() {
  const incidents: RawIncident[] = [];
  const e = {
    ...(env as unknown as Env),
    INCIDENTS: {
      send: vi.fn(async (inc: RawIncident) => {
        incidents.push(inc);
      }),
    },
  } as unknown as Env;
  return { env: e, incidents };
}

describe("dlq-sink — exhausted message → audit_log row + RawIncident (never silent)", () => {
  it("well-shaped dead WireEvent → P2 RawIncident (kind dlq_dead_letter) + audit_log(outcome='dlq'), ack() (never retry)", async () => {
    const { env: e, incidents } = spyEnv();
    const dead: WireEvent = {
      agent: "Forge",
      type: "task",
      entity: "tasks",
      op: "increment",
      payload: { delta: 1 },
      idempotencyKey: "forge:task:2026-06-04:abc123",
    };
    const { batch, ack, retry } = fakeBatch(dead);

    await dlqSink.queue(batch as unknown as MessageBatch<unknown>, e, {} as ExecutionContext);

    // Always ack()'d, NEVER retried (a dead-letter sink must not poison-loop).
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    // Exactly one RawIncident enqueued to INCIDENTS (D2-05), P2, kind "dlq_dead_letter".
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.severity_hint).toBe("P2");
    expect(incidents[0]!.kind).toBe("dlq_dead_letter");
    expect(incidents[0]!.source_agent).toBe("dlq-sink");

    // A durable audit_log row was written: outcome="dlq", and NO token column exists
    // on the row (scope_used recorded, never a secret).
    const row = await DB.prepare(
      "SELECT agent, action, outcome, scope_used, flag_id, trust FROM audit_log WHERE action = ?",
    )
      .bind("dlq.dead_letter")
      .first<{
        agent: string;
        action: string;
        outcome: string;
        scope_used: string | null;
        flag_id: string;
        trust: number;
      }>();
    expect(row).not.toBeNull();
    expect(row?.outcome).toBe("dlq");
    expect(row?.agent).toBe("Forge");
    expect(row?.action).toBe("dlq.dead_letter");
    // scope_used is empty — a queue failure is not a token-scoped action.
    expect(row?.scope_used ?? "").toBe("");
  });

  it("malformed / non-WireEvent dead message → P3 RawIncident + audit_log(agent='unknown'), ack()", async () => {
    const { env: e, incidents } = spyEnv();
    // Missing op/entity/idempotencyKey — fails WireEvent.safeParse.
    const { batch, ack, retry } = fakeBatch({ foo: "not a wire event" }, { id: "dead-2" });

    await dlqSink.queue(batch as unknown as MessageBatch<unknown>, e, {} as ExecutionContext);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.severity_hint).toBe("P3");
    expect(incidents[0]!.kind).toBe("dlq_dead_letter");

    const row = await DB.prepare(
      "SELECT agent, outcome FROM audit_log WHERE action = ? AND agent = ?",
    )
      .bind("dlq.dead_letter", "unknown")
      .first<{ agent: string; outcome: string }>();
    expect(row).not.toBeNull();
    expect(row?.agent).toBe("unknown"); // unparseable ⇒ no trustworthy agent field
    expect(row?.outcome).toBe("dlq");
  });

  it("replay — the SAME dead message twice yields IDENTICAL kind/source_agent RawIncidents (same incident class)", async () => {
    const dead: WireEvent = {
      agent: "Filer",
      type: "sweep",
      entity: "emails",
      op: "increment",
      payload: { labeled: 3 },
      idempotencyKey: "filer:sweep:2026-06-04",
    };

    const first = spyEnv();
    await dlqSink.queue(
      fakeBatch(dead, { id: "dead-3" }).batch as unknown as MessageBatch<unknown>,
      first.env,
      {} as ExecutionContext,
    );

    const second = spyEnv();
    await dlqSink.queue(
      fakeBatch(dead, { id: "dead-3" }).batch as unknown as MessageBatch<unknown>,
      second.env,
      {} as ExecutionContext,
    );

    expect(first.incidents[0]!.kind).toBe(second.incidents[0]!.kind);
    expect(first.incidents[0]!.source_agent).toBe(second.incidents[0]!.source_agent);
    expect(first.incidents[0]!.severity_hint).toBe(second.incidents[0]!.severity_hint);
  });

  it("an internal sink error still ack()s — never loses the message (no poison-loop)", async () => {
    // Force the audit_log INSERT to throw by handing the sink a broken DB.
    const broken = {
      ...(env as unknown as Env),
      INCIDENTS: { send: vi.fn(async () => {}) },
      DB: {
        prepare: () => {
          throw new Error("D1 unavailable");
        },
      },
    } as unknown as Env;
    const dead: WireEvent = {
      agent: "Forge",
      type: "task",
      entity: "tasks",
      op: "increment",
      payload: {},
      idempotencyKey: "forge:task:2026-06-04:err",
    };
    const { batch, ack, retry } = fakeBatch(dead, { id: "dead-4" });

    await expect(
      dlqSink.queue(batch as unknown as MessageBatch<unknown>, broken, {} as ExecutionContext),
    ).resolves.toBeUndefined();

    // Even when the sink itself errors, the message is ack()'d (never retried) so a
    // message that already exhausted retries can never re-loop on the DLQ.
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});
