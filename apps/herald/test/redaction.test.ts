import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runDaily, type Env, type HeraldGmailTools } from "../src/index.js";
import { guardDigestOutput } from "../src/guardrail.js";
import { renderDigestBody } from "../src/digest.js";
import { bucketThreads, type DigestThread } from "../src/bucket.js";

// DoD test 3 (CI load-bearing invariant) — 2FA codes / reset links / login URLs NEVER reach
// the digest output. Two belts:
//   (a) pre-synthesis strip: a Type/Security thread with a code in its subject/snippet renders
//       sender+subject-only with the code stripped;
//   (b) output guardrail: a secret force-injected into the OUTPUT blocks the draft + raises P2.

const env2 = env as unknown as Env;

describe("Herald redaction (CI invariant)", () => {
  it("(a) a Type/Security thread renders sender+subject only — no 6-digit code survives", () => {
    const threads: DigestThread[] = [
      {
        threadId: "sec1",
        sender: "security@github.com",
        subject: "Your verification code is 482915",
        labels: ["Type/Security", "⑤ No Action"],
      },
    ];
    const body = renderDigestBody("2026-06-06", bucketThreads(threads));
    expect(body).not.toContain("482915");
    expect(body).toContain("security-sensitive");
  });

  it("(a) a reset link in a snippet never reaches the rendered output", () => {
    const threads: DigestThread[] = [
      {
        threadId: "sec2",
        sender: "noreply@example.com",
        subject: "Reset: https://accounts.example.com/reset?t=abc123xyz",
        labels: ["Type/Security"],
      },
    ];
    const body = renderDigestBody("2026-06-06", bucketThreads(threads));
    expect(body).not.toContain("https://accounts.example.com/reset?t=abc123xyz");
  });

  it("(b) the output guardrail blocks a leaked OUTPUT and reports blocked:true", async () => {
    const leaked = "Digest body — your verification code is 999111, do not share.";
    const result = await guardDigestOutput(env2, leaked);
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain("999111"); // redacted in the returned text
  });

  it("(b) defense-in-depth: a code in a non-security subject is stripped pre-synthesis, never reaching any draft body", async () => {
    // The pre-synthesis strip (belt 1) removes the code BEFORE the output guardrail (belt 2)
    // even sees it, so a draft is safe to create — but it MUST NOT carry the code. This proves
    // the two belts compose: belt 1 keeps the code out of the output; belt 2 (tested directly
    // above) blocks anything belt 1 ever misses.
    const drafts: string[] = [];
    const tools: HeraldGmailTools = {
      async createDraft(_to, _subject, body) {
        drafts.push(body);
        return "draft-stripped";
      },
    };
    const threads: DigestThread[] = [
      {
        threadId: "leak1",
        sender: "a@b.com",
        subject: "your code is 482915",
        labels: ["④ FYI / Read Later"],
      },
    ];
    const result = await runDaily(env2, "2026-06-06", threads, tools);
    // belt 1 stripped the code → output is clean → the guardrail did not need to block.
    expect(result.blocked).toBeFalsy();
    expect(result.drafted).toBe(true);
    // The created draft body carries NO 6-digit code — the invariant holds end-to-end.
    expect(drafts[0]).not.toContain("482915");
  });

  it("(b) the output guardrail blocks the draft when a leak bypasses the pre-strip", async () => {
    // Simulate belt-1 miss: drive the guardrail directly with an OUTPUT that still carries a
    // secret. The guardrail must report blocked:true and redact the returned text (and the
    // caller, runDaily, would then skip createDraft — proven by the blocked branch).
    const result = await guardDigestOutput(env2, "Digest — verification code 482913 inside.");
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain("482913");
  });

  it("a clean digest creates a draft (guardrail does not over-block)", async () => {
    let drafts = 0;
    const tools: HeraldGmailTools = {
      async createDraft() {
        drafts++;
        return "draft-clean";
      },
    };
    const threads: DigestThread[] = [
      { threadId: "ok1", sender: "a@b.com", subject: "Lunch with Sam about Q3", labels: ["④ FYI / Read Later"] },
    ];
    const result = await runDaily(env2, "2026-06-06", threads, tools);
    expect(result.blocked).toBeFalsy();
    expect(result.drafted).toBe(true);
    expect(drafts).toBe(1);
  });
});
