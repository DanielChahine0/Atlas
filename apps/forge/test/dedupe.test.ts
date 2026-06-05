import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runMorning, type Env } from "../src/index.js";
import type { CandidateThread, Extractor } from "../src/extract.js";

// DoD test 1 — dedupe (no duplicate tasks on re-run) + a deadline is inferred.

const env2 = env as unknown as Env;
const db = (env as unknown as { DB: D1Database }).DB;

/** A deterministic extractor stub (no model/network). */
const extractor: Extractor = {
  async extract(t: CandidateThread) {
    return { title: t.subject, subtasks: ["open link", "do work", "submit"], priority: "P2" };
  },
};

function thread(over: Partial<CandidateThread> & { threadId: string }): CandidateThread {
  return { subject: "Submit Shopify OA", labels: ["① Action Required", "Needs/Upload"], snippet: "do the thing", ...over };
}

async function countTasks(): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();
  return r?.n ?? -1;
}

describe("Forge dedupe", () => {
  it("the action-required set yields ≥1 task with a deadline", async () => {
    const candidates = [thread({ threadId: "oa1", labels: ["① Action Required", "Job/OA", "Needs/Upload"] })];
    const r = await runMorning(env2, db, "2026-06-02", candidates, extractor);
    expect(r.inserted).toBe(1);
    const row = await db
      .prepare("SELECT due, due_kind FROM tasks WHERE thread = ?")
      .bind("oa1")
      .first<{ due: string | null; due_kind: string }>();
    expect(row?.due).not.toBeNull(); // Job/OA → +5d inferred deadline
    expect(row?.due_kind).toBe("inferred");
  });

  it("running morning() twice over the same set creates the task once (no duplicate)", async () => {
    const candidates = [thread({ threadId: "dup1" })];
    const before = await countTasks();
    const r1 = await runMorning(env2, db, "2026-06-02", candidates, extractor);
    const r2 = await runMorning(env2, db, "2026-06-02", candidates, extractor);
    expect(r1.inserted).toBe(1);
    // Second run: same dedupe key → no new insert (a same-source merge/noop), 0 new rows.
    expect(r2.inserted).toBe(0);
    expect(await countTasks()).toBe(before + 1);
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE thread = ?")
      .bind("dup1")
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("drops non-action-required threads (④ FYI / ⑤ No Action are filtered out)", async () => {
    const candidates = [
      thread({ threadId: "fyi1", labels: ["④ FYI / Read Later"] }),
      thread({ threadId: "na1", labels: ["⑤ No Action"] }),
    ];
    const r = await runMorning(env2, db, "2026-06-02", candidates, extractor);
    expect(r.inserted).toBe(0);
    expect(r.skipped + r.inserted + r.merged + r.phishing).toBe(0); // filtered before processing
  });
});
