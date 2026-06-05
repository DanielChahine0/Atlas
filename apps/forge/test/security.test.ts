import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runMorning, type Env } from "../src/index.js";
import {
  shouldSecuritySkip,
  sanitizeExtracted,
  isPhishing,
  type CandidateThread,
  type Extractor,
} from "../src/extract.js";

// DoD test 3 — security. A code/link-only item produces NO task; a ⚠ Phishing-Suspect thread
// produces no task and raises P2; no task title/subtask ever contains a code/reset URL.

const env2 = env as unknown as Env;
const db = (env as unknown as { DB: D1Database }).DB;

const extractor: Extractor = {
  async extract(t: CandidateThread) {
    return { title: t.subject, subtasks: ["step"], priority: "P2" };
  },
};

describe("Forge security-skip", () => {
  it("a thread whose only content is a verification code is skipped (no task)", async () => {
    const candidates: CandidateThread[] = [
      {
        threadId: "sec1",
        subject: "Your verification code is 482915",
        labels: ["① Action Required", "Due/Today"], // qualifies as action-required by label…
        snippet: "Your verification code is 482915, do not share.", // …but the only content is a code
      },
    ];
    const r = await runMorning(env2, db, "2026-06-02", candidates, extractor);
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(1);
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE thread = ?")
      .bind("sec1")
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("shouldSecuritySkip is true for a Type/Security thread", () => {
    expect(
      shouldSecuritySkip({
        threadId: "x",
        subject: "s",
        labels: ["① Action Required", "Type/Security"],
        snippet: "anything",
      }),
    ).toBe(true);
  });

  it("a ⚠ Phishing-Suspect thread produces no task and raises P2", async () => {
    const candidates: CandidateThread[] = [
      {
        threadId: "phish1",
        subject: "Verify your account now",
        labels: ["① Action Required", "Needs/Reply", "⚠ Phishing-Suspect"],
        snippet: "click here to verify",
      },
    ];
    const r = await runMorning(env2, db, "2026-06-02", candidates, extractor);
    expect(r.phishing).toBe(1);
    expect(r.inserted).toBe(0);
    expect(isPhishing(candidates[0]!)).toBe(true);
  });

  it("sanitizeExtracted scrubs a code from a title and a reset URL from subtasks", () => {
    const out = sanitizeExtracted({
      title: "code is 482915",
      subtasks: ["open https://accounts.example.com/reset?t=abc123xyz", "do work"],
      priority: "P2",
    });
    expect(out.title).toBe(""); // a secret-bearing title is dropped
    expect(out.subtasks).not.toContain("open https://accounts.example.com/reset?t=abc123xyz");
    expect(out.subtasks).toContain("do work");
  });

  it("no persisted task field ever contains a 6-digit code (end-to-end)", async () => {
    const codeEchoer: Extractor = {
      async extract() {
        // A misbehaving model echoes a code — sanitize must scrub it before persistence.
        return { title: "Submit form", subtasks: ["enter code 482915"], priority: "P2" };
      },
    };
    const candidates: CandidateThread[] = [
      {
        threadId: "echo1",
        subject: "Submit the form",
        labels: ["① Action Required", "Needs/Upload"],
        snippet: "submit the form",
      },
    ];
    await runMorning(env2, db, "2026-06-02", candidates, codeEchoer);
    const subs = await db
      .prepare(
        "SELECT s.title FROM subtasks s JOIN tasks t ON s.task_id = t.id WHERE t.thread = ?",
      )
      .bind("echo1")
      .all<{ title: string }>();
    for (const row of subs.results ?? []) {
      expect(row.title).not.toMatch(/\d{6}/);
    }
  });
});
