import { describe, it, expect, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { Forge, type Env } from "../src/index.js";
import type { CandidateThread, Extractor } from "../src/extract.js";

// CR-01 — Forge.morning() must actually ENGAGE the ForgeLock DO around the dedupe/upsert
// critical section. Before the fix, runMorning was called with 5 args, so runUnderLock fell
// back to its identity default and the DO was never addressed. We stub FORGE_LOCK.getByName +
// the returned stub's withLock and assert the closure (which extracts/dedupes/upserts) ran
// INSIDE the lock. The Wire send() calls sit OUTSIDE the locked section (the for-loop runs
// after runUnderLock returns) — we do not assert anything about send() here.

function thread(over: Partial<CandidateThread> & { threadId: string }): CandidateThread {
  return {
    subject: "Submit Shopify OA",
    labels: ["① Action Required", "Needs/Upload"],
    snippet: "do the thing",
    ...over,
  };
}

describe("Forge.morning lock engagement (CR-01)", () => {
  it("addresses FORGE_LOCK by run date and runs the dedupe/upsert section inside withLock", async () => {
    // Witnesses: `insideLock` is true only while the withLock closure runs; the extractor —
    // invoked by processThread, which runs INSIDE that closure — records that it fired while
    // the lock was held. That proves the critical section is gated, not run after the lock.
    let insideLock = false;
    let extractRanInsideLock = false;
    const withLock = vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
      insideLock = true;
      try {
        return await fn();
      } finally {
        insideLock = false;
      }
    });
    const lockStub = { withLock };
    const getByName = vi.fn((_name: string) => lockStub);

    const extractor: Extractor = {
      async extract(t: CandidateThread) {
        if (insideLock) extractRanInsideLock = true;
        return { title: t.subject, subtasks: ["open link", "submit"], priority: "P2" };
      },
    };

    const spyEnv = {
      ...(env as unknown as Env),
      FORGE_LOCK: { getByName } as unknown as DurableObjectNamespace,
    } as unknown as Env;

    const ctx = createExecutionContext();
    const forge = new Forge(ctx, spyEnv);
    const today = "2026-06-02";
    const res = await forge.morning({
      date: today,
      candidates: [
        thread({ threadId: "lock-oa1", labels: ["① Action Required", "Job/OA", "Needs/Upload"] }),
      ],
      extractor,
    });

    // The lock was addressed by the RUN DATE (one instance per date serializes its writes).
    expect(getByName).toHaveBeenCalledWith(today);
    // withLock was invoked exactly once (the single critical section for the run).
    expect(withLock).toHaveBeenCalledTimes(1);
    // The dedupe/extract/upsert section fired WHILE the lock was held (not after it returned).
    expect(extractRanInsideLock).toBe(true);
    // The work still completed end-to-end (the closure actually ran, not just spied).
    expect(res.inserted).toBe(1);
  });

  it("falls back to running unlocked when FORGE_LOCK is absent (identity runner, still works)", async () => {
    // FORGE_LOCK is optional-typed (absent in some dev/test wiring). When absent, morning()
    // must still run the pass via the identity runner — never throw on a missing binding.
    const extractor: Extractor = {
      async extract(t: CandidateThread) {
        return { title: t.subject, subtasks: ["submit"], priority: "P3" };
      },
    };
    const noLockEnv = { ...(env as unknown as Env) } as unknown as Env;
    delete (noLockEnv as { FORGE_LOCK?: unknown }).FORGE_LOCK;

    const ctx = createExecutionContext();
    const forge = new Forge(ctx, noLockEnv);
    const res = await forge.morning({
      date: "2026-06-03",
      candidates: [
        thread({ threadId: "nolock-oa1", labels: ["① Action Required", "Job/OA", "Needs/Upload"] }),
      ],
      extractor,
    });
    expect(res.inserted).toBe(1);
  });
});
