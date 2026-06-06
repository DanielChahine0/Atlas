// apps/archivist/test/archivist.test.ts
//
// CAPTURE-01-e: effort-set — Opus pass sets effort explicitly (D5)
// CAPTURE-01-f: wire-contract — meeting.note + action-item events canonical shape
// CAPTURE-01-g: idempotent — same session_id produces same idempotencyKey
// CAPTURE-01-h: consent-discarded — NonRetryableError, no Wire events
// CAPTURE-01-j: failure-path — missing transcript flags P2
// CAPTURE-01-k: steward-replay — Archivist events through Steward → meta.changes===0

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import { applyEvent } from "@atlas/steward-core";
import type { RawIncident } from "@atlas/shared";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStep } from "cloudflare:workers";
import {
  runArchivist,
  buildMeetingNoteEvent,
  buildActionItemEvent,
} from "../src/archivist.js";
import type { ArchivistEnv } from "../src/env.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const TEST_SESSION_ID = "echo-2026-06-06T14-00-00";
const TEST_SERIES = "weekly-atlas-sync";
const TEST_DATE = "2026-06-06";

/** A minimal valid transcript with consent:granted */
function makeTranscript(override: Partial<Record<string, unknown>> = {}) {
  return {
    session_id: TEST_SESSION_ID,
    consent: "granted",
    audio_disposition: "local-only",
    segments: [
      {
        speaker: "Owner",
        text: "We need to send the deck by Friday.",
        start_ts: 0,
        end_ts: 5000,
        confidence: 0.95,
        idx: 0,
      },
    ],
    duration_seconds: 3600,
    ...override,
  };
}

/** A fake step.do that executes the callback immediately (no Workflow overhead). */
function makeFakeStep(): Pick<WorkflowStep, "do"> {
  return {
    do: (async (_name: string, _configOrFn: unknown, fn?: unknown): Promise<unknown> => {
      // step.do can be called as step.do(name, fn) or step.do(name, config, fn)
      const cb = typeof _configOrFn === "function"
        ? (_configOrFn as () => Promise<unknown>)
        : (fn as () => Promise<unknown>);
      return cb();
    }) as unknown as WorkflowStep["do"],
  };
}

/** Build a spy env with WIRE/INCIDENTS/BLOBS/FORGE/AI/CONFIG mocked */
function makeSpyEnv(blobsGet: (key: string) => Promise<R2ObjectBody | null> = async () => null) {
  const wireSent: WireEvent[] = [];
  const incidents: RawIncident[] = [];
  const forgeTasks: Array<{ task: unknown; opts: unknown }> = [];

  // Build a mock Claude client that asserts explicit effort setting
  let lastCreateParams: Record<string, unknown> | null = null;
  const mockClaude = {
    messages: {
      create: vi.fn(async (params: Record<string, unknown>) => {
        lastCreateParams = params;
        // Return a minimal valid meeting note structure
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                series: TEST_SERIES,
                date: TEST_DATE,
                title: "Weekly Atlas Sync",
                attendees: ["Owner", "Speaker 2"],
                agenda: "Discuss Atlas progress",
                decisions: ["Proceed with Phase 3"],
                ownerActionItems: [
                  {
                    action: "Send the deck",
                    due: "2026-06-10",
                    due_kind: "explicit",
                    confidence: 0.9,
                    priority: "high",
                  },
                ],
                followUps: [],
                note_status: "draft",
              }),
            },
          ],
          usage: { input_tokens: 100, output_tokens: 200 },
        };
      }),
    },
    model: "claude-opus-4-8",
    agent: "archivist",
    client: {} as unknown,
  };

  const spyEnv = {
    ...(env as unknown as ArchivistEnv),
    WIRE: {
      send: vi.fn(async (event: WireEvent) => {
        wireSent.push(event);
      }),
    },
    INCIDENTS: {
      send: vi.fn(async (inc: RawIncident) => {
        incidents.push(inc);
      }),
    },
    BLOBS: {
      get: vi.fn(blobsGet) as unknown as R2Bucket["get"],
    } as unknown as R2Bucket,
    FORGE: {
      createTask: vi.fn(async (task: unknown, opts: unknown) => {
        forgeTasks.push({ task, opts });
        return { id: "task-1" };
      }),
    } as unknown as Fetcher,
    CONFIG: {
      get: vi.fn(async () => null),
    } as unknown as KVNamespace,
    AI: {} as Ai,
    AIG_ACCOUNT_ID: "test-account",
    AIG_GATEWAY_ID: "atlas-reasoning",
    MODEL_ARCHIVIST: "claude-opus-4-8",
    // Inject the mock Claude client via a special test hook
    _mockClaude: mockClaude,
    _getLastCreateParams: () => lastCreateParams,
  } as unknown as ArchivistEnv & { _mockClaude: typeof mockClaude; _getLastCreateParams: () => Record<string, unknown> | null };

  return { spyEnv, wireSent, incidents, forgeTasks, mockClaude, getLastCreateParams: () => lastCreateParams };
}

/** Create an R2ObjectBody-like mock that returns the given JSON. */
function makeR2Body(data: unknown): R2ObjectBody {
  return {
    json: async <T>() => data as T,
    text: async () => JSON.stringify(data),
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob([]),
    body: null as unknown as ReadableStream,
    bodyUsed: false,
    key: `transcripts/${TEST_SESSION_ID}.json`,
    version: "v1",
    size: 100,
    etag: "abc",
    httpEtag: '"abc"',
    checksums: {},
    uploaded: new Date(),
    httpMetadata: {},
    customMetadata: {},
    range: undefined,
    writeHttpMetadata: () => {},
  } as unknown as R2ObjectBody;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE-01-e: Opus pass sets effort explicitly (D5 cost discipline)
// ─────────────────────────────────────────────────────────────────────────────
describe("effort-set", () => {
  it("Opus pass sets effort explicitly (never omits it)", async () => {
    const transcript = makeTranscript();
    const { spyEnv, getLastCreateParams } = makeSpyEnv(
      async () => makeR2Body(transcript)
    );

    const fakeStep = makeFakeStep();
    const fakeEvent = { payload: { session_id: TEST_SESSION_ID } };

    await runArchivist(spyEnv, fakeEvent as never, fakeStep);

    // The Opus pass MUST set thinking/effort explicitly (never rely on Opus default "high")
    const params = getLastCreateParams();
    expect(params).not.toBeNull();
    // Either thinking is explicitly disabled OR budget_tokens is set explicitly
    // (never just omitted — Opus defaults to high effort)
    const hasExplicitEffort =
      (params?.thinking !== undefined) ||
      (params?.max_tokens !== undefined && params?.max_tokens !== null);
    expect(hasExplicitEffort).toBe(true);
    // Specifically: thinking must be set (not missing) or it must be disabled
    expect(params?.thinking).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE-01-f: Wire-contract — canonical §6.4 shape + structured keys
// ─────────────────────────────────────────────────────────────────────────────
describe("wire-contract", () => {
  it("buildMeetingNoteEvent produces canonical §6.4 meeting.note upsert", () => {
    const evt = buildMeetingNoteEvent(TEST_SESSION_ID, { title: "Test Note" });
    expect(evt.agent).toBe("Archivist");
    expect(evt.type).toBe("meeting.note");
    expect(evt.op).toBe("upsert");
    expect(evt.entity).toBe("note");
    expect(evt.idempotencyKey).toBe(`archivist:${TEST_SESSION_ID}:note`);
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });

  it("buildActionItemEvent produces idempotencyKey archivist:<series>:<date>:ai-NN", () => {
    const evt = buildActionItemEvent(TEST_SERIES, TEST_DATE, 1);
    expect(evt.idempotencyKey).toBe(`archivist:${TEST_SERIES}:${TEST_DATE}:ai-01`);
    expect(evt.agent).toBe("Archivist");
    expect(evt.type).toBe("action-item");
    expect(evt.op).toBe("upsert");
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });

  it("zero-padded NN: index 0 → ai-00, index 9 → ai-09, index 10 → ai-10", () => {
    expect(buildActionItemEvent(TEST_SERIES, TEST_DATE, 0).idempotencyKey).toBe(
      `archivist:${TEST_SERIES}:${TEST_DATE}:ai-00`
    );
    expect(buildActionItemEvent(TEST_SERIES, TEST_DATE, 9).idempotencyKey).toBe(
      `archivist:${TEST_SERIES}:${TEST_DATE}:ai-09`
    );
    expect(buildActionItemEvent(TEST_SERIES, TEST_DATE, 10).idempotencyKey).toBe(
      `archivist:${TEST_SERIES}:${TEST_DATE}:ai-10`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE-01-g: Idempotent — same session_id → same idempotencyKeys both runs
// ─────────────────────────────────────────────────────────────────────────────
describe("idempotent", () => {
  it("running runArchivist twice with the same session_id produces identical idempotencyKeys", async () => {
    const transcript = makeTranscript();
    let callCount = 0;
    const blobsGet = async () => {
      callCount++;
      return makeR2Body(transcript);
    };
    const { spyEnv, wireSent, forgeTasks } = makeSpyEnv(blobsGet);

    const fakeEvent = { payload: { session_id: TEST_SESSION_ID } };

    // First run
    await runArchivist(spyEnv, fakeEvent as never, makeFakeStep());
    const firstRunKeys = wireSent.map((e) => e.idempotencyKey);
    const firstForgeKeys = forgeTasks.map((t) => (t.opts as { idempotencyKey: string }).idempotencyKey);

    // Reset spies
    (spyEnv.WIRE as unknown as { send: ReturnType<typeof vi.fn> }).send.mockClear();
    (spyEnv.INCIDENTS as unknown as { send: ReturnType<typeof vi.fn> }).send.mockClear();
    (spyEnv.FORGE as unknown as { createTask: ReturnType<typeof vi.fn> }).createTask.mockClear();
    wireSent.length = 0;
    forgeTasks.length = 0;

    // Second run — same session_id
    await runArchivist(spyEnv, fakeEvent as never, makeFakeStep());
    const secondRunKeys = wireSent.map((e) => e.idempotencyKey);
    const secondForgeKeys = forgeTasks.map((t) => (t.opts as { idempotencyKey: string }).idempotencyKey);

    // Both runs produce identical idempotencyKeys
    expect(firstRunKeys).toEqual(secondRunKeys);
    expect(firstForgeKeys).toEqual(secondForgeKeys);

    // Wire events contain the session idempotency key
    expect(firstRunKeys).toContain(`archivist:${TEST_SESSION_ID}:note`);
    expect(firstRunKeys).toContain(`archivist:${TEST_SESSION_ID}:count`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE-01-h: Consent discarded → NonRetryableError, no Wire events
// ─────────────────────────────────────────────────────────────────────────────
describe("consent-discarded", () => {
  it("consent:discarded transcript → NonRetryableError, WIRE.send never called", async () => {
    const discardedTranscript = makeTranscript({ consent: "discarded" });
    const { spyEnv, wireSent, incidents } = makeSpyEnv(
      async () => makeR2Body(discardedTranscript)
    );

    const fakeEvent = { payload: { session_id: TEST_SESSION_ID } };

    await expect(
      runArchivist(spyEnv, fakeEvent as never, makeFakeStep())
    ).rejects.toThrow(NonRetryableError);

    // WIRE.send must NEVER be called for a discarded transcript
    expect(wireSent).toHaveLength(0);
    // No incident for discarded (it's a benign owner decline, not an error)
    expect(incidents).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE-01-j: Failure path — missing transcript → Flagger P2 + NonRetryableError
// ─────────────────────────────────────────────────────────────────────────────
describe("failure-path", () => {
  it("BLOBS.get returns null → NonRetryableError AND Flagger P2 via INCIDENTS", async () => {
    // Blob returns null (transcript not found)
    const { spyEnv, wireSent, incidents } = makeSpyEnv(async () => null);

    const fakeEvent = { payload: { session_id: TEST_SESSION_ID } };

    await expect(
      runArchivist(spyEnv, fakeEvent as never, makeFakeStep())
    ).rejects.toThrow(NonRetryableError);

    // WIRE.send must NOT be called (no note without a transcript)
    expect(wireSent).toHaveLength(0);

    // Exactly one P2 RawIncident with kind:transcript_missing
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.severity_hint).toBe("P2");
    expect(incidents[0]!.kind).toBe("transcript_missing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE-01-k: Steward replay — Archivist Wire events through Steward are idempotent
// Definition-of-Done replay-through-Steward test
// ─────────────────────────────────────────────────────────────────────────────
describe("steward-replay", () => {
  it("Archivist meeting.note upsert through Steward → meta.changes===0 on second apply", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;

    const noteEvt = buildMeetingNoteEvent(TEST_SESSION_ID, { title: "Replay Test Note" });

    // First apply: applied=true
    expect(await applyEvent(db, noteEvt)).toEqual({ applied: true });
    // Replay: applied=false (no double note)
    expect(await applyEvent(db, noteEvt)).toEqual({ applied: false });
    // Third replay: still no-op (ledger has no TTL, D-08)
    expect(await applyEvent(db, noteEvt)).toEqual({ applied: false });
  });

  it("Archivist meetings-this-week increment through Steward → meta.changes===0 on second apply", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;

    // Use a unique session_id to avoid collision with the note test above
    const sessionId = "echo-2026-06-06T15-00-00";
    const countEvt: WireEvent = {
      agent: "Archivist",
      type: "meeting.count",
      entity: "meetings-this-week",
      op: "increment",
      payload: { counter: "meetings-this-week", delta: 1 },
      idempotencyKey: `archivist:${sessionId}:count`,
    };

    // First apply increments the counter
    const first = await applyEvent(db, countEvt);
    expect(first).toEqual({ applied: true });

    // Replay must be a no-op
    const second = await applyEvent(db, countEvt);
    expect(second).toEqual({ applied: false });

    // Counter should be exactly 1 (not 2)
    const row = await db
      .prepare("SELECT value FROM counters WHERE entity = ?")
      .bind("meetings-this-week")
      .first<{ value: number }>();
    expect(row?.value).toBe(1);
  });

  it("Archivist meeting.note upsert AND meetings-this-week increment both replay as no-ops", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const sessionId = "echo-2026-06-06T16-00-00";

    const noteEvt = buildMeetingNoteEvent(sessionId, { title: "Dual Replay Test" });
    const countEvt: WireEvent = {
      agent: "Archivist",
      type: "meeting.count",
      entity: "meetings-this-week",
      op: "increment",
      payload: { counter: "meetings-this-week", delta: 1 },
      idempotencyKey: `archivist:${sessionId}:count`,
    };

    // Apply both events once
    expect(await applyEvent(db, noteEvt)).toEqual({ applied: true });
    expect(await applyEvent(db, countEvt)).toEqual({ applied: true });

    // Replay both — both must be no-ops
    expect(await applyEvent(db, noteEvt)).toEqual({ applied: false });
    expect(await applyEvent(db, countEvt)).toEqual({ applied: false });
  });
});
