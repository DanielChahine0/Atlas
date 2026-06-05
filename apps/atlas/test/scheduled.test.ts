import { describe, it, expect, vi } from "vitest";
import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import worker, { type Env } from "../src/index.js";
import type { AtlasCoordinator } from "../src/coordinator.js";

// SPINE-01 / Wire-contract test (CLAUDE.md Definition of Done #1).
//
// Drives the scheduled() dispatcher for the 07:45-ET Filer-sweep cron and asserts the
// end-to-end SPINE-01 leg: a cron tick invokes the no-op agent over the service binding
// (D-11), THEN routes EXACTLY ONE canonical §6.4 event onto the Wire whose shape validates
// against the 00-02 WireEvent zod schema (agent "Atlas", op "append", structured
// idempotencyKey atlas:noop:<YYYY-MM-DD>).
//
// Capture mechanism: spy env.WIRE.send + env.NOOP.tick on a synthetic Env (the pattern
// the 00-02 wire send() test establishes — packages/wire/test/contract.test.ts). This is
// fully deterministic in workerd and lets us assert BOTH the emitted shape AND the
// tick-before-send call order. The pool forces TZ=UTC, so we assert the idempotencyKey's
// structured regex shape, never a specific calendar date.

const FILER_SWEEP_CRON = "45 12 * * *"; // EST form of 07:45 ET (D-06)

function makeController(cron: string): ScheduledController {
  return {
    cron,
    scheduledTime: Date.now(),
    noRetry() {},
  } as ScheduledController;
}

function makeCtx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as ExecutionContext;
}

describe("Atlas scheduled() dispatcher — SPINE-01", () => {
  it("invokes the no-op agent (D-11) BEFORE routing onto the Wire, exactly once", async () => {
    const callOrder: string[] = [];
    const tick = vi.fn(async () => {
      callOrder.push("tick");
      return { ok: true as const, at: Date.now() };
    });
    const sentEvents: unknown[] = [];
    const wireSend = vi.fn(async (e: unknown) => {
      callOrder.push("send");
      sentEvents.push(e);
    });

    const env = {
      NOOP: { tick },
      WIRE: { send: wireSend },
    } as unknown as Env;

    await worker.scheduled!(makeController(FILER_SWEEP_CRON), env, makeCtx());

    // The no-op agent ran exactly once, and BEFORE the Wire send (D-11 schedule->invoke leg).
    expect(tick).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["tick", "send"]);

    // Exactly one event reached the Wire.
    expect(wireSend).toHaveBeenCalledTimes(1);
    expect(sentEvents).toHaveLength(1);
  });

  it("routes a canonical §6.4 event that validates against the 00-02 WireEvent schema", async () => {
    let captured: unknown;
    const env = {
      NOOP: { tick: vi.fn(async () => ({ ok: true as const, at: Date.now() })) },
      WIRE: { send: vi.fn(async (e: unknown) => { captured = e; }) },
    } as unknown as Env;

    await worker.scheduled!(makeController(FILER_SWEEP_CRON), env, makeCtx());

    // Wire-contract test: the emitted event parses cleanly against the single §6.4 schema.
    const parsed = WireEvent.parse(captured);
    expect(parsed.agent).toBe("Atlas");
    expect(parsed.op).toBe("append");
    expect(parsed.type).toBe("noop.tick");
    expect(parsed.entity).toBe("spine");
    // Structured, date-derived idempotency key — NOT a random per-run UUID.
    expect(parsed.idempotencyKey).toMatch(/^atlas:noop:\d{4}-\d{2}-\d{2}$/);
  });

  it("does nothing for an unknown cron (dispatcher routes ONLY known crons, T-00-32)", async () => {
    const tick = vi.fn(async () => ({ ok: true as const, at: Date.now() }));
    const wireSend = vi.fn(async () => {});
    const env = { NOOP: { tick }, WIRE: { send: wireSend } } as unknown as Env;

    await worker.scheduled!(makeController("0 0 * * *"), env, makeCtx());

    expect(tick).not.toHaveBeenCalled();
    expect(wireSend).not.toHaveBeenCalled();
  });

  // C5 (D-10 heartbeat supervision must be LIVE): a scheduled() tick is the real runtime path
  // that arms + feeds the self-monitor on the AtlasCoordinator (env.ATLAS.getByName("root")).
  // Drive scheduled() against the REAL bindings (testEnv has ATLAS) and assert the supervisor is
  // now live: the alarm is armed and lastBeat advanced. Use an UNKNOWN cron so the arm/feed
  // (which runs OUTSIDE the cron switch) is exercised WITHOUT needing the NOOP service RPC.
  it("arms the alarm and feeds lastBeat on the coordinator DO (supervisor is live)", async () => {
    const ATLAS = (testEnv as unknown as { ATLAS: DurableObjectNamespace<AtlasCoordinator> }).ATLAS;
    const stub = ATLAS.getByName("root");

    // Pre-state: a fresh per-test DO has no alarm and no beat yet.
    const before = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      lastBeat: await state.storage.get<number>("lastBeat"),
    }));
    expect(before.alarm).toBeNull();
    expect(before.lastBeat).toBeUndefined();

    const t0 = Date.now();
    // Fire a tick through the REAL worker default export with the REAL env (has ATLAS).
    await worker.scheduled!(makeController("0 0 * * *"), testEnv as unknown as Env, makeCtx());

    // Post-state: the supervisor is armed (alarm set) and fed (lastBeat advanced to ~now).
    const after = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      lastBeat: await state.storage.get<number>("lastBeat"),
    }));
    expect(after.alarm).not.toBeNull();
    expect(after.lastBeat).toBeGreaterThanOrEqual(t0);
  });
});

// NEW-AW3 — the morning-chain create() must DISCRIMINATE its failure modes. A same-day re-fire
// collides on the instance id (benign idempotency no-op → swallow silently); ANY OTHER create
// error (rate-limit / 5xx / transient) means the whole morning pipeline never started and MUST be
// surfaced (console.error + a P2 toward Flagger), because missed crons are not auto-replayed.
const MORNING_CRON = "45 11 * * 1-5"; // EDT form of the 07:45-ET morning-chain slot

describe("Atlas dispatcher — morning-chain create() error discrimination (NEW-AW3)", () => {
  function makeWaitUntilCtx(waited: Promise<unknown>[]): ExecutionContext {
    return {
      waitUntil(p: Promise<unknown>) { waited.push(p); },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
  }

  it("SWALLOWS a benign id-already-exists collision: no console.error, no P2 RawIncident", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const incidents: unknown[] = [];
    const waited: Promise<unknown>[] = [];
    const env = {
      WIRE: { send: vi.fn(async () => {}) },
      INCIDENTS: { send: vi.fn(async (inc: unknown) => { incidents.push(inc); }) },
      MORNING_CHAIN: {
        async create() { throw new Error("instance with id morning-2026-06-05 already exists"); },
      },
    } as unknown as Env;

    await worker.scheduled!(makeController(MORNING_CRON), env, makeWaitUntilCtx(waited));
    await Promise.all(waited);

    // A re-fire collision is the desired no-op: nothing surfaced.
    expect(errSpy).not.toHaveBeenCalled();
    expect(incidents).toHaveLength(0);
    errSpy.mockRestore();
  });

  it("SURFACES a non-collision create error: console.error + exactly one P2 RawIncident (D2-05)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const incidents: unknown[] = [];
    const waited: Promise<unknown>[] = [];
    const env = {
      WIRE: { send: vi.fn(async () => {}) },
      INCIDENTS: { send: vi.fn(async (inc: unknown) => { incidents.push(inc); }) },
      MORNING_CHAIN: {
        async create() { throw new Error("rate limited (429) — gateway unavailable"); },
      },
    } as unknown as Env;

    await worker.scheduled!(makeController(MORNING_CRON), env, makeWaitUntilCtx(waited));
    await Promise.all(waited);

    // The whole-day skip is now observable in logs…
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toContain("MorningChain create failed");

    // …and exactly one P2 RawIncident was enqueued onto atlas-incidents (D2-05).
    expect(incidents).toHaveLength(1);
    const inc = incidents[0] as { severity_hint: string; kind: string; source_agent: string };
    expect(inc.severity_hint).toBe("P2");
    expect(inc.kind).toBe("workflow_create_failed");
    expect(inc.source_agent).toBe("Atlas");
    errSpy.mockRestore();
  });

  it("a non-collision create error never throws out of scheduled() (best-effort flag)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const waited: Promise<unknown>[] = [];
    // Even if the Flagger INCIDENTS emit ALSO fails, the waitUntil promise must resolve.
    const env = {
      WIRE: { send: vi.fn(async () => {}) },
      INCIDENTS: { send: vi.fn(async () => { throw new Error("incidents down"); }) },
      MORNING_CHAIN: {
        async create() { throw new Error("transient 503"); },
      },
    } as unknown as Env;

    await worker.scheduled!(makeController(MORNING_CRON), env, makeWaitUntilCtx(waited));
    // The create-failure handler swallows the secondary flag failure → waitUntil resolves cleanly.
    await expect(Promise.all(waited)).resolves.toBeDefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

// Phase 2 (D2-11) — the 4 NEW STANDALONE cron cases the dispatcher gains: Headhunter
// deadlines-light (09:00 ET daily), Headhunter full (Mon 09:00 ET), Friday Scout+Herald
// (16:00 ET, fanned via Promise.allSettled), and the Friday 16:30 ET weekly-review build.
// These are STANDALONE cron cases — NOT new MorningChain Workflow steps (the morning chain
// is untouched). Each owner-local time carries DUAL cron forms (EDT now / EST after the Nov
// DST boundary — Cron Triggers are UTC-only, no DST, D1); BOTH forms route to the SAME
// handler, asserted below. The Friday fan-in uses Promise.allSettled (NOT Promise.all) so a
// Scout failure never discards Herald's completed work (T-02-cron2).
//
// Cron forms (June 2026 = EDT/UTC-4):
//   Headhunter daily-light 09:00 ET → EDT "0 13 * * *"  / EST "0 14 * * *"
//   Headhunter full Mon 09:00 ET    → EDT "0 13 * * 1"  / EST "0 14 * * 1"
//   Friday Scout+Herald 16:00 ET    → EDT "0 20 * * 5"  / EST "0 21 * * 5"
//   Friday 16:30 build              → EDT "30 20 * * 5" / EST "30 21 * * 5"
describe("Atlas dispatcher — Phase-2 standalone cron cases (D2-11)", () => {
  function makeWaitUntilCtx(waited: Promise<unknown>[]): ExecutionContext {
    return {
      waitUntil(p: Promise<unknown>) { waited.push(p); },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
  }

  /** A fresh env whose four Phase-2 agent bindings record the calls each received. */
  function makePhase2Env() {
    const calls = {
      headhunterDeadlines: [] as Array<{ date?: string }>,
      headhunterFull: [] as Array<{ date?: string }>,
      scoutWeekly: [] as Array<{ date?: string }>,
      heraldWeekly: [] as Array<{ date?: string }>,
      stewardBuild: [] as Array<{ date?: string }>,
    };
    const incidents: unknown[] = [];
    const env = {
      WIRE: { send: vi.fn(async () => {}) },
      INCIDENTS: { send: vi.fn(async (inc: unknown) => { incidents.push(inc); }) },
      HEADHUNTER: {
        deadlines: vi.fn(async (p: { date?: string }) => { calls.headhunterDeadlines.push(p); }),
        full: vi.fn(async (p: { date?: string }) => { calls.headhunterFull.push(p); }),
      },
      SCOUT: { weekly: vi.fn(async (p: { date?: string }) => { calls.scoutWeekly.push(p); }) },
      HERALD: { weekly: vi.fn(async (p: { date?: string }) => { calls.heraldWeekly.push(p); }) },
      STEWARD: { weeklyReviewBuild: vi.fn(async (p: { date?: string }) => { calls.stewardBuild.push(p); }) },
    } as unknown as Env;
    return { env, calls, incidents };
  }

  // Headhunter deadlines-light (09:00 ET daily) — both DST forms map to the same handler.
  for (const cron of ["0 13 * * *", "0 14 * * *"]) {
    it(`routes "${cron}" → HEADHUNTER.deadlines({date}) (and NOTHING else)`, async () => {
      const { env, calls } = makePhase2Env();
      const waited: Promise<unknown>[] = [];
      await worker.scheduled!(makeController(cron), env, makeWaitUntilCtx(waited));
      await Promise.all(waited);
      expect(calls.headhunterDeadlines).toHaveLength(1);
      expect(calls.headhunterDeadlines[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Standalone — it does NOT also fire full / scout / herald / steward.
      expect(calls.headhunterFull).toHaveLength(0);
      expect(calls.scoutWeekly).toHaveLength(0);
      expect(calls.heraldWeekly).toHaveLength(0);
      expect(calls.stewardBuild).toHaveLength(0);
    });
  }

  // Headhunter full (Mon 09:00 ET) — both DST forms map to the same handler.
  for (const cron of ["0 13 * * 1", "0 14 * * 1"]) {
    it(`routes "${cron}" → HEADHUNTER.full({date}) (and NOTHING else)`, async () => {
      const { env, calls } = makePhase2Env();
      const waited: Promise<unknown>[] = [];
      await worker.scheduled!(makeController(cron), env, makeWaitUntilCtx(waited));
      await Promise.all(waited);
      expect(calls.headhunterFull).toHaveLength(1);
      expect(calls.headhunterFull[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(calls.headhunterDeadlines).toHaveLength(0);
      expect(calls.scoutWeekly).toHaveLength(0);
      expect(calls.heraldWeekly).toHaveLength(0);
    });
  }

  // Friday 16:00 ET — Scout + Herald fanned via Promise.allSettled. Both DST forms map.
  for (const cron of ["0 20 * * 5", "0 21 * * 5"]) {
    it(`routes "${cron}" → BOTH SCOUT.weekly + HERALD.weekly (fan-in)`, async () => {
      const { env, calls } = makePhase2Env();
      const waited: Promise<unknown>[] = [];
      await worker.scheduled!(makeController(cron), env, makeWaitUntilCtx(waited));
      await Promise.all(waited);
      expect(calls.scoutWeekly).toHaveLength(1);
      expect(calls.heraldWeekly).toHaveLength(1);
      expect(calls.scoutWeekly[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(calls.heraldWeekly[0]!.date).toBe(calls.scoutWeekly[0]!.date);
      // Standalone — it does NOT also fire the Headhunter or Steward slots.
      expect(calls.headhunterDeadlines).toHaveLength(0);
      expect(calls.stewardBuild).toHaveLength(0);
    });
  }

  it("Friday 16:00 uses allSettled — if SCOUT.weekly REJECTS, HERALD.weekly STILL runs (T-02-cron2)", async () => {
    const { env, calls, incidents } = makePhase2Env();
    // Make Scout reject; Herald must STILL be invoked (allSettled, not all).
    (env.SCOUT as unknown as { weekly: ReturnType<typeof vi.fn> }).weekly = vi.fn(async () => {
      throw new Error("scout boom");
    });
    const waited: Promise<unknown>[] = [];
    await worker.scheduled!(makeController("0 20 * * 5"), env, makeWaitUntilCtx(waited));
    // The waitUntil promise must RESOLVE even though Scout threw (allSettled swallows).
    await expect(Promise.all(waited)).resolves.toBeDefined();
    // Herald's leg ran despite Scout's failure — the whole point of allSettled.
    expect(calls.heraldWeekly).toHaveLength(1);
    // Scout's failure was surfaced as a P2 incident (best-effort flag), not silently dropped.
    const scoutFlag = (incidents as Array<{ severity_hint?: string; source_agent?: string }>).find(
      (i) => i.severity_hint === "P2" && i.source_agent === "Atlas",
    );
    expect(scoutFlag).toBeTruthy();
  });

  // Friday 16:30 ET — the weekly-review build (Steward). Both DST forms map.
  for (const cron of ["30 20 * * 5", "30 21 * * 5"]) {
    it(`routes "${cron}" → STEWARD.weeklyReviewBuild({date}) (and NOTHING else)`, async () => {
      const { env, calls } = makePhase2Env();
      const waited: Promise<unknown>[] = [];
      await worker.scheduled!(makeController(cron), env, makeWaitUntilCtx(waited));
      await Promise.all(waited);
      expect(calls.stewardBuild).toHaveLength(1);
      expect(calls.stewardBuild[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(calls.scoutWeekly).toHaveLength(0);
      expect(calls.heraldWeekly).toHaveLength(0);
      expect(calls.headhunterDeadlines).toHaveLength(0);
    });
  }

  it("a Headhunter.deadlines REJECTION surfaces a P2 and never throws out of scheduled()", async () => {
    const { env, incidents } = makePhase2Env();
    (env.HEADHUNTER as unknown as { deadlines: ReturnType<typeof vi.fn> }).deadlines = vi.fn(
      async () => { throw new Error("headhunter down"); },
    );
    const waited: Promise<unknown>[] = [];
    await worker.scheduled!(makeController("0 13 * * *"), env, makeWaitUntilCtx(waited));
    await expect(Promise.all(waited)).resolves.toBeDefined();
    const hhFlag = (incidents as Array<{ severity_hint?: string; source_agent?: string }>).find(
      (i) => i.severity_hint === "P2" && i.source_agent === "Atlas",
    );
    expect(hhFlag).toBeTruthy();
  });
});
