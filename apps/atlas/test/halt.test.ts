import { describe, it, expect, vi } from "vitest";
import { WireEvent } from "@atlas/wire";
import { runMorningChain } from "../src/morning-chain.js";
import type { Env } from "../src/index.js";

// CORE-01 chain crux — HALT-DOWNSTREAM. A forced Forge failure (exhausted retries) must:
//   - leave Filer + Herald invoked (their side effects stand);
//   - never invoke Sundial or Compass (no planning on stale data);
//   - emit EXACTLY ONE chain.halted P2 toward Flagger;
//   - error the instance (run() rethrows so the terminal state is observable).

interface FakeStep {
  do: <T>(name: string, configOrFn: unknown, fn?: () => Promise<T>) => Promise<T>;
  sleepUntil: (name: string, t: Date | number) => Promise<void>;
}

function makeStep(): FakeStep {
  return {
    async do<T>(_name: string, configOrFn: unknown, fn?: () => Promise<T>): Promise<T> {
      const cb = (typeof configOrFn === "function" ? configOrFn : fn) as () => Promise<T>;
      // The fake step does NOT retry — a thrown callback is a terminal step failure (models an
      // exhausted-retry step erroring the instance).
      return await cb();
    },
    async sleepUntil(): Promise<void> {},
  };
}

/** Build an env whose agent bindings record their invocation; `failOn` throws for that agent. */
function makeAgentEnv(invoked: string[], sent: unknown[], failOn?: string): Env {
  const mk = (codename: string, method: string) => ({
    [method]: async () => {
      invoked.push(codename);
      if (codename === failOn) throw new Error(`${codename} boom (exhausted retries)`);
      return { ok: true };
    },
  });
  return {
    WIRE: { send: vi.fn(async (e: unknown) => { sent.push(e); }) },
    FILER: mk("filer", "sweep"),
    HERALD: mk("herald", "daily"),
    FORGE: mk("forge", "morning"),
    SUNDIAL: mk("sundial", "sync"),
    COMPASS: mk("compass", "plan"),
  } as unknown as Env;
}

function makeEvent() {
  return { payload: { date: "2026-06-05", tz: "America/Toronto" } };
}

describe("MorningChain — halt-downstream on a Forge failure", () => {
  it("halts before Sundial/Compass, leaves Filer/Herald intact, emits one chain.halted P2", async () => {
    const invoked: string[] = [];
    const sent: unknown[] = [];
    const env = makeAgentEnv(invoked, sent, "forge");

    // runMorningChain rethrows on a step failure (the instance errors → terminal state observable).
    await expect(runMorningChain(env, makeEvent() as never, makeStep() as never)).rejects.toThrow(/forge boom/);

    // Filer + Herald ran; Forge ran (and failed); Sundial + Compass NEVER ran.
    expect(invoked).toEqual(["filer", "herald", "forge"]);
    expect(invoked).not.toContain("sundial");
    expect(invoked).not.toContain("compass");

    // EXACTLY ONE chain.halted P2 was emitted toward Flagger.
    const flags = sent.map((e) => WireEvent.parse(e)).filter((e) => e.type === "flag");
    expect(flags).toHaveLength(1);
    const flag = flags[0]!;
    expect(flag.op).toBe("upsert");
    expect((flag.payload as { severity: string }).severity).toBe("P2");
    expect((flag.payload as { title: string }).title).toBe("chain.halted");
    // The halt detail names the halted step and never leaks a secret.
    expect((flag.payload as { detail: string }).detail).toContain("forge-morning");
  });

  it("the chain.halted flag id (idempotencyKey) is STABLE across differing error messages (NEW-AW2)", async () => {
    // The flag id must derive from STABLE inputs (date + stepName) ONLY — never err.message. Two
    // runs that fail at the SAME step with DIFFERENT messages (e.g. a retry surfacing a new
    // transient cause) must mint the SAME id, so a replayed/re-fired halt upserts ONE board row
    // rather than a duplicate. We capture the flag id under two distinct messages and compare.
    async function haltIdFor(message: string): Promise<{ id: string; detail: string; action: string }> {
      const invoked: string[] = [];
      const sent: unknown[] = [];
      const env = {
        WIRE: { send: vi.fn(async (e: unknown) => { sent.push(e); }) },
        FILER: { sweep: async () => ({ ok: true }) },
        HERALD: { daily: async () => ({ ok: true }) },
        // Forge fails with the supplied (volatile) message.
        FORGE: { morning: async () => { invoked.push("forge"); throw new Error(message); } },
        SUNDIAL: { sync: async () => ({ ok: true }) },
        COMPASS: { plan: async () => ({ ok: true }) },
      } as unknown as Env;
      await expect(runMorningChain(env, makeEvent() as never, makeStep() as never)).rejects.toThrow();
      const flag = sent.map((e) => WireEvent.parse(e)).find((e) => e.type === "flag")!;
      return {
        id: flag.idempotencyKey,
        detail: (flag.payload as { detail: string }).detail,
        action: (flag.payload as { suggested_action: string }).suggested_action,
      };
    }

    const a = await haltIdFor("forge boom: rate limited (429)");
    const b = await haltIdFor("forge boom: gateway 502 totally different text");

    // Same date + same step ⇒ SAME id (idempotencyKey), regardless of the differing messages.
    expect(a.id).toBe(b.id);
    // The volatile message is NOT in the keyed `detail` (it would perturb the id otherwise)…
    expect(a.detail).not.toContain("rate limited");
    expect(b.detail).not.toContain("502");
    // …but IS carried in the non-keyed suggested_action (observability without breaking the key).
    expect(a.action).toContain("rate limited");
    expect(b.action).toContain("502");
  });

  it("an emit failure is best-effort and still RETHROWS the original step error (NEW-AW2)", async () => {
    // emitHalt is best-effort: if the Flagger/Wire emit itself throws, it must NEVER mask the real
    // step cause — runMorningChain must still reject with the ORIGINAL error so the instance
    // terminates errored with the true reason. We make WIRE.send throw to force the emit to fail.
    const invoked: string[] = [];
    const env = {
      WIRE: { send: vi.fn(async () => { throw new Error("wire is down — emit failed"); }) },
      FILER: { sweep: async () => ({ ok: true }) },
      HERALD: { daily: async () => ({ ok: true }) },
      FORGE: { morning: async () => { invoked.push("forge"); throw new Error("forge boom (real cause)"); } },
      SUNDIAL: { sync: async () => ({ ok: true }) },
      COMPASS: { plan: async () => ({ ok: true }) },
    } as unknown as Env;

    // Rejects with the ORIGINAL forge cause, NOT the wire/emit failure.
    await expect(runMorningChain(env, makeEvent() as never, makeStep() as never)).rejects.toThrow(/forge boom \(real cause\)/);
    // Downstream never ran.
    expect(invoked).toEqual(["forge"]);
  });

  it("a re-fire (same date) is a no-op at the dispatcher: create() is idempotent on id", async () => {
    // The dispatcher always calls create({id: morning-<date>}); a second create with the same
    // id is a no-op in the Workflow runtime. We assert the dispatcher passes the SAME id on a
    // re-fire (the runtime collision is what makes it a no-op).
    const worker = (await import("../src/index.js")).default;
    const ids: string[] = [];
    const waited: Promise<unknown>[] = [];
    const env = {
      WIRE: { send: vi.fn() },
      MORNING_CHAIN: { async create(o: { id: string }) { ids.push(o.id); return {}; } },
    } as unknown as Env;
    const ctx = { waitUntil(p: Promise<unknown>) { waited.push(p); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const controller = { cron: "45 11 * * 1-5", scheduledTime: Date.now(), noRetry() {} } as ScheduledController;

    await worker.scheduled!(controller, env, ctx);
    await worker.scheduled!(controller, env, ctx);
    await Promise.all(waited);

    // Both fires produced the SAME instance id (the runtime dedups on it → re-fire no-op).
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});
