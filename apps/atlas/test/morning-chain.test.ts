import { describe, it, expect, vi } from "vitest";
import { runMorningChain } from "../src/morning-chain.js";
import type { Env } from "../src/index.js";

// CORE-01 chain crux — start-after-success ordering + the dispatcher instance id.
//
// We drive MorningChain.run() with a FAKE step harness whose step.do executes the callback
// immediately and step.sleepUntil is a no-op, and inject the five agent service bindings on
// env so invokeAgent dispatches to our stubs. This unit-tests the orchestration contract
// (ordering, state-forward, the budget gates being requested) without a live Workflow runtime.

interface FakeStep {
  do: <T>(name: string, configOrFn: unknown, fn?: () => Promise<T>) => Promise<T>;
  sleepUntil: (name: string, t: Date | number) => Promise<void>;
  calls: string[];
  sleeps: string[];
}

function makeStep(): FakeStep {
  const calls: string[] = [];
  const sleeps: string[] = [];
  return {
    calls,
    sleeps,
    async do<T>(name: string, configOrFn: unknown, fn?: () => Promise<T>): Promise<T> {
      const cb = (typeof configOrFn === "function" ? configOrFn : fn) as () => Promise<T>;
      calls.push(name);
      return await cb();
    },
    async sleepUntil(name: string): Promise<void> {
      sleeps.push(name);
    },
  };
}

/** Build an env with the five agent service bindings stubbed to record their invocation. */
function makeAgentEnv(order: string[], onCall?: (codename: string, params: unknown) => unknown): Env {
  const mk = (codename: string, method: string) => ({
    [method]: async (params: unknown) => {
      order.push(codename);
      return onCall ? onCall(codename, params) : { ok: true, codename };
    },
  });
  return {
    WIRE: { send: vi.fn() },
    FILER: mk("filer", "sweep"),
    HERALD: mk("herald", "daily"),
    FORGE: mk("forge", "morning"),
    SUNDIAL: mk("sundial", "sync"),
    COMPASS: mk("compass", "plan"),
  } as unknown as Env;
}

function makeEvent(date = "2026-06-05") {
  return { payload: { date, tz: "America/Toronto" } };
}

describe("MorningChain — start-after-success ordering", () => {
  it("runs the five steps in order, invoking each agent exactly once", async () => {
    const order: string[] = [];
    const env = makeAgentEnv(order);
    const step = makeStep();
    await runMorningChain(env, makeEvent() as never, step as never);

    expect(order).toEqual(["filer", "herald", "forge", "sundial", "compass"]);
    expect(step.calls).toEqual([
      "filer-sweep",
      "herald-daily",
      "forge-morning",
      "sundial-sync",
      "compass-plan",
    ]);
    // A budget gate (sleepUntil) was requested for the four gated stages (filer has none).
    expect(step.sleeps).toEqual([
      "budget-herald",
      "budget-forge",
      "budget-sundial",
      "budget-compass",
    ]);
  });

  it("passes prior step state forward (never mutates event.payload)", async () => {
    const order: string[] = [];
    const seenParams: Record<string, unknown>[] = [];
    const env = makeAgentEnv(order, (codename, params) => {
      seenParams.push(params as Record<string, unknown>);
      return { from: codename };
    });
    const event = makeEvent("2026-06-05");
    await runMorningChain(env, event as never, makeStep() as never);

    // event.payload is untouched (no step mutated it).
    expect(event.payload).toEqual({ date: "2026-06-05", tz: "America/Toronto" });
    // Every step received the run date in its params (state-forward).
    for (const p of seenParams) expect(p.date).toBe("2026-06-05");
    // Later steps carry the encoded results of earlier steps (state accumulates forward).
    const compassParams = seenParams[seenParams.length - 1]!;
    expect(compassParams.filer).toBeDefined();
  });
});

describe("Atlas dispatcher — morning-chain cron case", () => {
  function makeController(cron: string): ScheduledController {
    return { cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController;
  }

  it("the 07:45 cron creates the MorningChain instance with id morning-<date>", async () => {
    const worker = (await import("../src/index.js")).default;
    const created: { id: string; params: unknown }[] = [];
    const waited: Promise<unknown>[] = [];
    const env = {
      WIRE: { send: vi.fn() },
      MORNING_CHAIN: {
        async create(opts: { id: string; params: unknown }) {
          created.push(opts);
          return { id: opts.id };
        },
      },
    } as unknown as Env;
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        waited.push(p);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    await worker.scheduled!(makeController("45 11 * * 1-5"), env, ctx);
    await Promise.all(waited);

    expect(created).toHaveLength(1);
    expect(created[0]!.id).toMatch(/^morning-\d{4}-\d{2}-\d{2}$/);
    expect((created[0]!.params as { tz: string }).tz).toBe("America/Toronto");
  });

  it("the EST cron form also creates the instance (DST translation)", async () => {
    const worker = (await import("../src/index.js")).default;
    const created: unknown[] = [];
    const waited: Promise<unknown>[] = [];
    const env = {
      WIRE: { send: vi.fn() },
      MORNING_CHAIN: { async create(o: unknown) { created.push(o); return {}; } },
    } as unknown as Env;
    const ctx = { waitUntil(p: Promise<unknown>) { waited.push(p); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    await worker.scheduled!(makeController("45 12 * * 1-5"), env, ctx);
    await Promise.all(waited);
    expect(created).toHaveLength(1);
  });
});
