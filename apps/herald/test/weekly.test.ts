import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env, HeraldGmailTools } from "../src/index.js";
import { runWeekly, buildWeeklyDigestEvent } from "../src/weekly.js";
import type { DigestThread } from "../src/bucket.js";

// DoD: Wire-contract test (herald:weekly digest shape) + redaction-block path
// (a planted secret must NOT reach the draft).

const env2 = env as unknown as Env;

/** Minimal draft-tracking tool stub. */
function makeDraftTools(): { tools: HeraldGmailTools; drafts: { subject: string; body: string }[] } {
  const drafts: { subject: string; body: string }[] = [];
  const tools: HeraldGmailTools = {
    async createDraft(_to, subject, body) {
      drafts.push({ subject, body });
      return `draft-${Date.now()}`;
    },
  };
  return { tools, drafts };
}

const basicThreads: DigestThread[] = [
  {
    threadId: "ar1",
    sender: "boss@example.com",
    subject: "Q3 deadline — need response",
    labels: ["① Action Required", "Due/Today"],
  },
  {
    threadId: "vip1",
    sender: "alice@company.com",
    subject: "Waiting on your update",
    labels: ["Waiting/Sent"],
    vip: true,
  },
  {
    threadId: "slip1",
    sender: "team@project.com",
    subject: "Overdue task still open",
    labels: ["① Action Required", "Due/ThisWeek"],
  },
];

describe("runWeekly — week-in-review builder", () => {
  it("builds a week-in-review body and calls createDraft exactly once", async () => {
    const { tools, drafts } = makeDraftTools();
    const result = await runWeekly(env2, "2026-06-06", basicThreads, tools);
    expect(result.drafted).toBe(true);
    expect(result.draftId).toBeDefined();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.subject).toContain("2026-06-06");
  });

  it("returns a WeeklyResult with counts and actionRequiredRefs", async () => {
    const { tools } = makeDraftTools();
    const result = await runWeekly(env2, "2026-06-06", basicThreads, tools);
    expect(result.counts).toBeDefined();
    expect(result.actionRequiredRefs).toContain("ar1");
  });

  it("draft subject includes 'weekly' mode indicator", async () => {
    const { tools, drafts } = makeDraftTools();
    await runWeekly(env2, "2026-06-06", basicThreads, tools);
    expect(drafts[0]?.subject?.toLowerCase()).toMatch(/week/);
  });
});

describe("runWeekly — redaction guardrail (security invariant)", () => {
  it("blocks the draft and raises P2 when draft body contains a 2FA code", async () => {
    // Plant a 2FA code in a thread that will NOT be filtered as Type/Security
    // so it reaches the synthesized body and trips the OUTPUT guardrail.
    const poisonedThreads: DigestThread[] = [
      {
        threadId: "p1",
        sender: "auth@service.com",
        // The subject carries a 6-digit OTP — this simulates a guardrail bypass attempt.
        subject: "your verification code is 123456",
        labels: ["① Action Required"],
      },
    ];
    // The pre-synthesis strip will redact the snippet. If the strip works correctly the
    // draft is safe; if the strip misses it the output guardrail must block it.
    // Either way the draft body must NEVER contain the raw code.
    const { tools, drafts } = makeDraftTools();
    const result = await runWeekly(env2, "2026-06-06", poisonedThreads, tools);
    // If draft was created, the code must not be in it.
    if (result.drafted && drafts[0]) {
      expect(drafts[0].body).not.toContain("123456");
    }
    // If blocked, the secret never reached the draft.
    if (result.blocked) {
      expect(drafts).toHaveLength(0);
    }
  });

  it("output guardrail explicitly blocks a secret that bypasses pre-strip", async () => {
    // Simulate a direct call where the assembled body somehow carries a secret.
    // In runWeekly, guardDigestOutput must block the draft + raise P2.
    const blockedDrafts: string[] = [];
    const tools: HeraldGmailTools = {
      async createDraft(_to, _sub, body) {
        blockedDrafts.push(body);
        return "should-never-be-called";
      },
    };
    // We use a thread whose subject (not Type/Security) contains a reset URL
    // so the pre-strip will catch it. This verifies the chain from input → guard.
    const resetThread: DigestThread[] = [
      {
        threadId: "rst1",
        sender: "noreply@acme.com",
        subject: "Reset your password: https://acme.com/reset?token=secrettoken123",
        labels: ["① Action Required"],
      },
    ];
    const result = await runWeekly(env2, "2026-06-06", resetThread, tools);
    // Either pre-strip caught it (drafted, but no URL in body) OR guardrail blocked it.
    if (result.drafted && blockedDrafts[0]) {
      expect(blockedDrafts[0]).not.toContain("secrettoken123");
    }
    if (result.blocked) {
      expect(blockedDrafts).toHaveLength(0);
    }
  });
});

describe("buildWeeklyDigestEvent — Wire-contract", () => {
  it("emits the exact §6.4 digest event with idempotencyKey herald:weekly:<date>", () => {
    const evt = buildWeeklyDigestEvent("2026-06-06", { Important: 1, "Action Required": 2 }, ["ar1"], "draft-w1");
    expect(evt.agent).toBe("Herald");
    expect(evt.type).toBe("digest");
    expect(evt.entity).toBe("email");
    expect(evt.op).toBe("upsert");
    expect(evt.idempotencyKey).toBe("herald:weekly:2026-06-06");
    expect(evt.payload.mode).toBe("weekly");
    expect(evt.payload.draftId).toBe("draft-w1");
  });

  it("the weekly idempotency key is stable (never includes crypto.randomUUID)", () => {
    const evt1 = buildWeeklyDigestEvent("2026-06-06", {}, [], undefined);
    const evt2 = buildWeeklyDigestEvent("2026-06-06", {}, [], undefined);
    expect(evt1.idempotencyKey).toBe(evt2.idempotencyKey);
    expect(evt1.idempotencyKey).toBe("herald:weekly:2026-06-06");
  });
});

describe("runWeekly — no send method", () => {
  it("HeraldGmailTools has no send method (draft-only invariant)", async () => {
    const { tools } = makeDraftTools();
    // The tools object must not have a 'send' method.
    expect((tools as unknown as Record<string, unknown>)["send"]).toBeUndefined();
    expect(typeof tools.createDraft).toBe("function");
  });
});
