/**
 * funnel.test.ts — Headhunter funnel single-emitter + Wire contract tests (Plan 02-05 Task 2).
 *
 * Verifies:
 *   1. Given two Filer Type/Job threads classified to stages (thread A → "oa",
 *      thread B → "interview"), Headhunter emits one funnel increment per (thread, stage)
 *      with idempotencyKey `headhunter:funnel:<thread>:<stage>`.
 *
 *   2. Re-processing the same threads emits the SAME idempotencyKeys (replay-safe —
 *      Steward dedupes, meta.changes===0).
 *
 *   3. Headhunter is the ONLY emitter of funnel increments (single-emitter, D2-13) —
 *      no other source emits headhunter:funnel:* events.
 *
 *   4. Failure path: runFull() failure flags P2 kind:headhunter_failed + source_agent Headhunter.
 *
 *   5. Wire contract: funnel increments have op:"increment" entity:"pipeline" agent:"Headhunter".
 *
 *   6. Scan summary event has op:"upsert" idempotencyKey:"headhunter:scan:<date>".
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { runFull, classifyFunnelStages, Headhunter, type Env } from "../src/index.js";
import type { WindowRow } from "../src/windows.js";

// ── helpers ───────────────────────────────────────────────────────────────────

type TestEnv = {
  testEnv: Env;
  wireEvents: WireEvent[];
  incidents: RawIncident[];
  forgeTasks: Array<{ task: object; opts: object }>;
};

function makeEnv(forgeCreateTaskFn?: (task: unknown, opts: unknown) => Promise<{ id: string } | null>): TestEnv {
  const wireEvents: WireEvent[] = [];
  const incidents: RawIncident[] = [];
  const forgeTasks: Array<{ task: object; opts: object }> = [];

  const wireSend = vi.fn(async (event: WireEvent) => {
    wireEvents.push(event);
  });

  const incidentsSend = vi.fn(async (incident: RawIncident) => {
    incidents.push(incident);
  });

  const defaultForge = vi.fn(async (task: unknown, opts: unknown) => {
    forgeTasks.push({ task: task as object, opts: opts as object });
    return { id: "test-task-id" };
  });

  const testEnv: Env = {
    ...(env as unknown as Env),
    WIRE: { send: wireSend } as unknown as Queue<WireEvent>,
    INCIDENTS: { send: incidentsSend } as unknown as Queue<RawIncident>,
    CONFIG: {
      get: vi.fn(async (_key: string) => null),
    } as unknown as KVNamespace,
    FORGE: {
      createTask: forgeCreateTaskFn ?? defaultForge,
    },
  };

  return { testEnv, wireEvents, incidents, forgeTasks };
}

const BASE_DATE = "2026-07-15";

function makeWindow(overrides: Partial<WindowRow> = {}): WindowRow {
  return {
    id: "shopify:fall-2026:new-grad",
    company: "Shopify",
    cycle: "fall-2026",
    role_class: "new-grad",
    opens_est: "2026-07-01",
    closes_est: "2026-10-31",
    confidence: 0.80,
    source: "board:levels.fyi",
    status: "open",
    last_seen_open: BASE_DATE,
    created_at: Date.now(),
    updated_at: Date.now(),
    fit_score: 0.75,
    ...overrides,
  };
}

// ── funnel single-emitter tests ────────────────────────────────────────────────

describe("Headhunter funnel single-emitter (D2-13)", () => {
  it("classifyFunnelStages: classifies Job/* labels to stages correctly", () => {
    const threads = [
      { threadId: "thread-oa-1", labels: ["Type/Job", "Job/OA"] },
      { threadId: "thread-int-1", labels: ["Type/Job", "Job/Interview"] },
      { threadId: "thread-rej-1", labels: ["Type/Job", "Job/Rejected"] },
      { threadId: "thread-nolabel-1", labels: ["Type/Job"] }, // no stage label
    ];

    const stages = classifyFunnelStages(threads);

    expect(stages).toHaveLength(3); // thread-nolabel-1 not classified
    expect(stages.find((s) => s.threadId === "thread-oa-1")?.stage).toBe("oa");
    expect(stages.find((s) => s.threadId === "thread-int-1")?.stage).toBe("interview");
    expect(stages.find((s) => s.threadId === "thread-rej-1")?.stage).toBe("rejected");
  });

  it("emits one funnel increment per (thread, stage) with correct idempotencyKey", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const threads = [
      { threadId: "thread-oa-1", labels: ["Type/Job", "Job/OA"] },
      { threadId: "thread-int-2", labels: ["Type/Job", "Job/Interview"] },
    ];

    await runFull(testEnv, BASE_DATE, [], threads);

    const funnelEvents = wireEvents.filter((e) => e.type === "funnel.increment");
    expect(funnelEvents).toHaveLength(2);

    const oaEvent = funnelEvents.find((e) => e.idempotencyKey === "headhunter:funnel:thread-oa-1:oa");
    const intEvent = funnelEvents.find((e) => e.idempotencyKey === "headhunter:funnel:thread-int-2:interview");

    expect(oaEvent).toBeDefined();
    expect(intEvent).toBeDefined();
  });

  it("re-processing the same threads emits the SAME idempotencyKeys (replay-safe)", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const threads = [
      { threadId: "thread-oa-replay", labels: ["Type/Job", "Job/OA"] },
    ];

    await runFull(testEnv, BASE_DATE, [], threads);
    const firstRunFunnelKeys = wireEvents
      .filter((e) => e.type === "funnel.increment")
      .map((e) => e.idempotencyKey);

    wireEvents.length = 0;

    await runFull(testEnv, BASE_DATE, [], threads);
    const secondRunFunnelKeys = wireEvents
      .filter((e) => e.type === "funnel.increment")
      .map((e) => e.idempotencyKey);

    expect(firstRunFunnelKeys).toEqual(secondRunFunnelKeys);
    expect(firstRunFunnelKeys[0]).toBe("headhunter:funnel:thread-oa-replay:oa");
  });
});

// ── Wire contract tests ─────────────────────────────────────────────────────

describe("Headhunter Wire event contract", () => {
  it("funnel increment has op:increment entity:pipeline agent:Headhunter", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const threads = [{ threadId: "thread-wire-contract", labels: ["Job/OA"] }];

    await runFull(testEnv, BASE_DATE, [], threads);

    const funnelEvent = wireEvents.find(
      (e) => e.idempotencyKey === "headhunter:funnel:thread-wire-contract:oa",
    );
    expect(funnelEvent).toBeDefined();
    expect(funnelEvent!.agent).toBe("Headhunter");
    expect(funnelEvent!.op).toBe("increment");
    expect(funnelEvent!.entity).toBe("pipeline");
  });

  // M5 — per-stage funnel counter: payload.counter must be "funnel:<stage>"
  // Without this, Steward maps all 5 stages onto the single "pipeline" counter
  // (apply.ts derives counter ?? entity) → per-stage funnel counts unreconstructable.
  it("M5: each funnel stage emits a distinct payload.counter = funnel:<stage>", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const threads = [
      { threadId: "t-oa", labels: ["Job/OA"] },
      { threadId: "t-int", labels: ["Job/Interview"] },
      { threadId: "t-off", labels: ["Job/Offer"] },
      { threadId: "t-rej", labels: ["Job/Rejected"] },
      { threadId: "t-app", labels: ["Job/Applied"] },
    ];

    await runFull(testEnv, BASE_DATE, [], threads);

    const funnelEvents = wireEvents.filter((e) => e.type === "funnel.increment");
    expect(funnelEvents).toHaveLength(5);

    const expectedCounters = ["funnel:oa", "funnel:interview", "funnel:offer", "funnel:rejected", "funnel:applied"];
    for (const expected of expectedCounters) {
      const evt = funnelEvents.find((e) => e.payload?.counter === expected);
      expect(evt, `expected event with payload.counter=${expected}`).toBeDefined();
    }

    // Each event still has stage + thread_id in payload
    for (const evt of funnelEvents) {
      expect(evt.payload?.stage, "stage must be in payload").toBeTruthy();
      expect(evt.payload?.thread_id, "thread_id must be in payload").toBeTruthy();
    }
  });

  it("scan summary has op:upsert idempotencyKey:headhunter:scan:<date>", async () => {
    const { testEnv, wireEvents } = makeEnv();

    await runFull(testEnv, BASE_DATE, []);

    const scanEvent = wireEvents.find((e) => e.idempotencyKey === `headhunter:scan:${BASE_DATE}`);
    expect(scanEvent).toBeDefined();
    expect(scanEvent!.op).toBe("upsert");
    expect(scanEvent!.agent).toBe("Headhunter");
  });
});

// ── Apply-by task emission tests ────────────────────────────────────────────

describe("Headhunter apply-by task via Forge (T-02-hh3)", () => {
  it("calls FORGE.createTask with correct idempotencyKey for each window", async () => {
    const { testEnv, forgeTasks } = makeEnv();
    const windows = [makeWindow()];

    await runFull(testEnv, BASE_DATE, windows);

    expect(forgeTasks.length).toBeGreaterThanOrEqual(1);
    const taskOpts = forgeTasks[0]?.opts as { idempotencyKey: string };
    // H2 fix: key now includes role_class to prevent same-company/cycle dedup across roles
    // role_class "new-grad" → "new-grad" (spaces stripped, hyphens preserved)
    expect(taskOpts.idempotencyKey).toBe("headhunter:window:shopify:fall-2026:new-grad");
  });

  it("task idempotencyKey is stable across re-scans (replay produces same key)", async () => {
    const { testEnv, forgeTasks } = makeEnv();
    const windows = [makeWindow()];

    await runFull(testEnv, BASE_DATE, windows);
    const firstKey = (forgeTasks[0]?.opts as { idempotencyKey: string }).idempotencyKey;

    forgeTasks.length = 0;

    await runFull(testEnv, BASE_DATE, windows);
    const secondKey = (forgeTasks[0]?.opts as { idempotencyKey: string }).idempotencyKey;

    expect(firstKey).toBe(secondKey);
    // H2 fix: key now includes role_class
    expect(firstKey).toBe("headhunter:window:shopify:fall-2026:new-grad");
  });
});

// ── Failure path test ────────────────────────────────────────────────────────

describe("Headhunter failure path", () => {
  // L6 fix: previously this test allowed either kind — tightened to assert the
  // SPECIFIC kind it actually exercises (per-task Forge error, not fatal runFull throw).
  it("Forge task creation failure flags P2 kind:headhunter_forge_task_failed (per-task catch)", async () => {
    const { testEnv, incidents } = makeEnv();

    // Force an error by injecting a window that causes Forge to throw
    const forgeError = new Error("Forge RPC failed");
    const errorForge = {
      createTask: vi.fn(async () => {
        throw forgeError;
      }),
    };
    const errEnv: Env = { ...testEnv, FORGE: errorForge };

    // Run with a window that should create a task
    const headhunter = new Headhunter({} as ExecutionContext, errEnv);
    // full() catches the Forge error in the per-task try/catch and flags P2.
    // runFull itself does NOT throw — this is the per-task error path, not the fatal path.
    await headhunter.full({ date: BASE_DATE, windows: [makeWindow()] });

    // L6 fix: assert the SPECIFIC kind — headhunter_forge_task_failed, not headhunter_failed
    const failIncident = incidents.find((i) => i.kind === "headhunter_forge_task_failed");
    expect(failIncident).toBeDefined();
    expect(failIncident!.source_agent).toBe("Headhunter");
    expect(failIncident!.severity_hint).toBe("P2");

    // Confirm the fatal kind was NOT emitted (runFull did not throw)
    const fatalIncident = incidents.find((i) => i.kind === "headhunter_failed");
    expect(fatalIncident).toBeUndefined();
  });

  // L6 fix: dedicated test for the FATAL outer catch path (runFull itself throws).
  // Previously this path had no dedicated test — a regression could silently drop
  // the headhunter_failed P2 incident while the above test would still pass.
  it("Fatal runFull error flags P2 kind:headhunter_failed (outer catch in Headhunter.full)", async () => {
    const { testEnv, incidents } = makeEnv();

    // Force runFull to throw by making the WIRE.send explode on the scan summary event
    // (i.e., after all tasks, when send() is called — the outer try/catch in full() catches it)
    let sendCallCount = 0;
    const fatalEnv: Env = {
      ...testEnv,
      WIRE: {
        send: vi.fn(async () => {
          sendCallCount++;
          // First send is the scan summary — throw to force runFull to throw
          throw new Error("WIRE send fatal failure");
        }),
      } as unknown as Queue<WireEvent>,
    };

    const headhunter = new Headhunter({} as ExecutionContext, fatalEnv);
    // full() should catch the fatal error and flag headhunter_failed, then re-throw
    await expect(headhunter.full({ date: BASE_DATE, windows: [] })).rejects.toThrow();

    // L6 fix: assert the FATAL kind — headhunter_failed with P2
    const fatalIncident = incidents.find((i) => i.kind === "headhunter_failed");
    expect(fatalIncident).toBeDefined();
    expect(fatalIncident!.source_agent).toBe("Headhunter");
    expect(fatalIncident!.severity_hint).toBe("P2");
  });
});

// ── Heartbeat test ─────────────────────────────────────────────────────────

describe("Headhunter heartbeat", () => {
  it("emits kind:heartbeat to INCIDENTS after a successful full() run", async () => {
    const { testEnv, incidents } = makeEnv();

    const headhunter = new Headhunter({} as ExecutionContext, testEnv);
    await headhunter.full({ date: BASE_DATE, windows: [] });

    const hb = incidents.find((i) => i.kind === "heartbeat");
    expect(hb).toBeDefined();
    expect(hb!.source_agent).toBe("Headhunter");
    expect(hb!.severity_hint).toBe("P4");
    expect(hb!.run_id).toBe(BASE_DATE);
  });
});
