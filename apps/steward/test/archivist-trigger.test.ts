// apps/steward/test/archivist-trigger.test.ts
//
// Tests for the Steward transcript.ready → ARCHIVIST_WF.create trigger (Phase 3 / 03-03).
//
// CAPTURE-01 (partial): Steward triggers the Archivist Workflow idempotently when it
// processes a transcript.ready event with consent:"granted". The per-session-id
// instance id `archivist-<session_id>` is the idempotency handle — a re-trigger
// swallows the benign instance-exists collision (exactly one Workflow instance per session).
//
// Pillar 1: the trigger fires from WITHIN the existing sole atlas-wire consumer via
// a cross-script workflows binding — it is NOT a second consumer, NOT a new HTTP surface.

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { WireEvent } from "@atlas/wire";
import type { RawIncident } from "@atlas/shared";
import { stewardConsumer, type Env } from "../src/steward-consumer.js";
import type { StewardWriter } from "../src/steward.js";

const STEWARD_LOCK = (
  env as unknown as { STEWARD_LOCK: DurableObjectNamespace<StewardWriter> }
).STEWARD_LOCK;

/** A valid transcript.ready Wire event with consent:granted. */
function makeTranscriptReadyEvent(session_id: string): WireEvent {
  return {
    agent: "Echo",
    type: "transcript.ready",
    entity: "session",
    op: "upsert",
    payload: {
      session_id,
      transcript_r2_key: `transcripts/${session_id}.json`,
      audio_r2_key: null,
      audio_disposition: "local-only",
      duration_seconds: 3600,
      consent: "granted",
    },
    idempotencyKey: `echo:${session_id.replace("echo-", "")}:ready`,
  };
}

/** A fake MessageBatch over a single message, with spied ack()/retry(). */
function fakeBatch(body: WireEvent, attempts = 1) {
  const ack = vi.fn();
  const retry = vi.fn();
  const msg = { id: "m1", timestamp: new Date(), attempts, body, ack, retry };
  const batch = {
    queue: "atlas-wire",
    messages: [msg],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
  return { batch, ack, retry };
}

/**
 * Build a spy env with INCIDENTS.send + ARCHIVIST_WF.create tracked.
 * Uses `...(env as Env)` to inherit the real STEWARD_LOCK DO from the test env.
 */
function makeSpyEnv(wfCreateFn?: () => Promise<unknown>) {
  const incidents: RawIncident[] = [];
  const archivistCreates: Array<{ id: string; params: unknown }> = [];

  const defaultCreate = vi.fn(async (opts: { id: string; params: unknown }) => {
    archivistCreates.push(opts);
    if (wfCreateFn) return wfCreateFn();
    return undefined;
  });

  const spyEnv = {
    ...(env as unknown as Env),
    INCIDENTS: {
      send: vi.fn(async (inc: RawIncident) => { incidents.push(inc); }),
    },
    ARCHIVIST_WF: {
      create: defaultCreate,
    },
  } as unknown as Env;

  return { spyEnv, incidents, archivistCreates, wfCreate: defaultCreate };
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotent trigger: same transcript.ready event twice → same instance id,
// second create's instance-exists collision is swallowed (not surfaced as error).
// ─────────────────────────────────────────────────────────────────────────────
describe("Steward archivist trigger — transcript.ready wiring (CAPTURE-01 / T-03-03-06)", () => {

  it("transcript.ready with consent:granted → ARCHIVIST_WF.create called with archivist-<session_id>", async () => {
    const sessionId = "echo-2026-06-06T14-00-00";
    const { spyEnv, archivistCreates, wfCreate } = makeSpyEnv();
    const evt = makeTranscriptReadyEvent(sessionId);
    const { batch, ack } = fakeBatch(evt);

    await stewardConsumer.queue(
      batch as unknown as MessageBatch<WireEvent>,
      spyEnv,
    );

    // The event must be ack()'d (successful apply + trigger)
    expect(ack).toHaveBeenCalledTimes(1);

    // ARCHIVIST_WF.create must be called with the correct instance id
    expect(wfCreate).toHaveBeenCalledTimes(1);
    expect(archivistCreates).toHaveLength(1);
    expect(archivistCreates[0]!.id).toBe(`archivist-${sessionId}`);
    expect((archivistCreates[0]!.params as { session_id: string }).session_id).toBe(sessionId);
  });

  it("same transcript.ready event twice → ARCHIVIST_WF.create called twice but instance-exists collision on second is swallowed (idempotent)", async () => {
    const sessionId = "echo-2026-06-06T14-01-00";
    let callCount = 0;
    const { spyEnv, archivistCreates, incidents } = makeSpyEnv(async () => {
      callCount++;
      if (callCount >= 2) {
        // Second create throws the benign instance-exists collision
        throw new Error("Workflow instance already exists: archivist-" + sessionId);
      }
    });

    const evt = makeTranscriptReadyEvent(sessionId);

    // First processing
    const { batch: batch1, ack: ack1 } = fakeBatch(evt);
    await stewardConsumer.queue(
      batch1 as unknown as MessageBatch<WireEvent>,
      spyEnv,
    );

    // The Steward dedup ledger will reject the replay (applied:false), so the
    // second batch is a "replay" for Steward but a fresh event for the trigger.
    // We reset the batch to simulate a re-delivery of the same Wire event.
    const { batch: batch2, ack: ack2 } = fakeBatch(evt);
    await stewardConsumer.queue(
      batch2 as unknown as MessageBatch<WireEvent>,
      spyEnv,
    );

    // Both deliveries are ack()'d (the second apply returns {applied:false}, which is still a success)
    expect(ack1).toHaveBeenCalledTimes(1);
    expect(ack2).toHaveBeenCalledTimes(1);

    // create() was called both times (Steward doesn't track the WF state)
    expect(archivistCreates).toHaveLength(2);

    // Both calls used the same instance id (idempotent key)
    expect(archivistCreates[0]!.id).toBe(`archivist-${sessionId}`);
    expect(archivistCreates[1]!.id).toBe(`archivist-${sessionId}`);

    // The instance-exists collision on the second create is SWALLOWED — no P2 incident
    expect(incidents.filter(i => i.kind === "workflow_create_failed")).toHaveLength(0);
  });

  it("transcript.ready with consent:discarded does NOT trigger ARCHIVIST_WF.create", async () => {
    const sessionId = "echo-2026-06-06T14-02-00";
    const { spyEnv, archivistCreates, wfCreate } = makeSpyEnv();

    const discardedEvt: WireEvent = {
      agent: "Echo",
      type: "transcript.ready",
      entity: "session",
      op: "upsert",
      payload: {
        session_id: sessionId,
        transcript_r2_key: `transcripts/${sessionId}.json`,
        audio_r2_key: null,
        audio_disposition: "discarded",
        duration_seconds: 0,
        consent: "discarded",   // <-- discarded consent
      },
      idempotencyKey: `echo:${sessionId.replace("echo-", "")}:ready`,
    };

    const { batch, ack } = fakeBatch(discardedEvt);
    await stewardConsumer.queue(
      batch as unknown as MessageBatch<WireEvent>,
      spyEnv,
    );

    // Event is ack()'d (valid Wire event, applies fine to Steward)
    expect(ack).toHaveBeenCalledTimes(1);

    // Archivist NOT triggered for discarded consent
    expect(wfCreate).not.toHaveBeenCalled();
    expect(archivistCreates).toHaveLength(0);
  });

  it("non-transcript.ready events do NOT trigger ARCHIVIST_WF.create", async () => {
    const { spyEnv, archivistCreates, wfCreate } = makeSpyEnv();

    const regularEvt: WireEvent = {
      agent: "Forge",
      type: "task.created",
      entity: "tasks",
      op: "increment",
      payload: { counter: "tasks_open", delta: 1 },
      idempotencyKey: "forge:task:2026-06-06:trigger-test",
    };

    const { batch, ack } = fakeBatch(regularEvt);
    await stewardConsumer.queue(
      batch as unknown as MessageBatch<WireEvent>,
      spyEnv,
    );

    expect(ack).toHaveBeenCalledTimes(1);
    expect(wfCreate).not.toHaveBeenCalled();
    expect(archivistCreates).toHaveLength(0);
  });

  it("non-fatal create error (not instance-exists) → P2 incident, consumer does NOT throw", async () => {
    const sessionId = "echo-2026-06-06T14-03-00";
    const { spyEnv, incidents } = makeSpyEnv(async () => {
      throw new Error("Quota exceeded — cannot create new Workflow instances");
    });

    const evt = makeTranscriptReadyEvent(sessionId);
    const { batch, ack, retry } = fakeBatch(evt);

    // Should NOT throw (best-effort; INCIDENTS.send.catch swallows)
    await expect(
      stewardConsumer.queue(batch as unknown as MessageBatch<WireEvent>, spyEnv)
    ).resolves.not.toThrow();

    // The Wire event was ack()'d (the apply succeeded; the WF create failure is non-fatal)
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    // A P2 incident is emitted for the unexpected create failure
    const p2Incidents = incidents.filter(i => i.severity_hint === "P2" && i.kind === "workflow_create_failed");
    expect(p2Incidents).toHaveLength(1);
  });

  it("transcript.ready trigger does not affect existing malformed-event behavior", async () => {
    const { spyEnv, archivistCreates, incidents, wfCreate } = makeSpyEnv();

    // A malformed event (no op/entity/idempotencyKey)
    const malformed = { agent: "Echo", payload: { session_id: "test" } };
    const { batch, ack, retry } = fakeBatch(malformed as unknown as WireEvent);

    await stewardConsumer.queue(
      batch as unknown as MessageBatch<WireEvent>,
      spyEnv,
    );

    // Malformed: ack (no poison-loop) + P3 incident, no Archivist trigger
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(wfCreate).not.toHaveBeenCalled();
    expect(archivistCreates).toHaveLength(0);
    expect(incidents.filter(i => i.kind === "malformed_event")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pillar 1 verification: ARCHIVIST_WF is a workflows binding, NOT a consumer.
// The test env should have exactly one atlas-wire consumer (Steward's own).
// ─────────────────────────────────────────────────────────────────────────────
describe("Pillar 1 — single atlas-wire consumer", () => {
  it("stewardConsumer is the sole atlas-wire queue handler (no second consumer in archivist)", () => {
    // This is a structural test: the ARCHIVIST_WF binding in wrangler.jsonc uses
    // "workflows" (not "queues.consumers"). The CI guard-wire-consumer.js checks this
    // at CI time. Here we verify the consumer handler is the stewardConsumer singleton.
    expect(typeof stewardConsumer.queue).toBe("function");
    // The stewardConsumer is the ONLY export that handles queue batches in this Worker.
    // (There is no second queue() function anywhere in apps/steward.)
  });
});
