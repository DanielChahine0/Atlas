import { describe, it, expect } from "vitest";
import { runSweep, buildSweepEvent, type GmailTools, type ThreadSummary } from "../src/index.js";
import {
  finalizeLabels,
  stripActionLabelsForSecurity,
  isSecurityOrPhishing,
} from "../src/classify.js";

// DoD test 3 — security. A Type/Security or ⚠ Phishing-Suspect thread is read-and-label
// only: it gets NO Needs/* and NO Suggest/* label, and no 2FA code / reset link is ever
// reproduced in a label or the emitted payload.

function makeTools(threads: ThreadSummary[]): {
  tools: GmailTools;
  labelWrites: { threadId: string; addLabels: string[] }[];
} {
  const labelWrites: { threadId: string; addLabels: string[] }[] = [];
  const tools: GmailTools = {
    async listLabels() {
      const { TAXONOMY } = await import("../src/taxonomy.js");
      return TAXONOMY.map((l) => l.name); // taxonomy already bootstrapped
    },
    async createLabel() {
      /* no-op */
    },
    async searchThreads() {
      return threads;
    },
    async labelThread(threadId, addLabels) {
      labelWrites.push({ threadId, addLabels });
    },
  };
  return { tools, labelWrites };
}

describe("Filer security guard", () => {
  it("a Type/Security thread gets no Needs/* or Suggest/* label", () => {
    const proposed = ["④ FYI / Read Later", "Type/Security", "Needs/Reply", "Suggest/Keep"];
    const finalized = finalizeLabels(proposed);
    expect(isSecurityOrPhishing(finalized)).toBe(true);
    expect(finalized.some((l) => l.startsWith("Needs/"))).toBe(false);
    expect(finalized.some((l) => l.startsWith("Suggest/"))).toBe(false);
  });

  it("a ⚠ Phishing-Suspect thread receives no action labels (never nudged to act)", () => {
    const proposed = ["① Action Required", "⚠ Phishing-Suspect", "Needs/Pay"];
    const out = stripActionLabelsForSecurity(proposed);
    expect(out).not.toContain("Needs/Pay");
    expect(out).toContain("⚠ Phishing-Suspect");
  });

  it("no label written for a security thread ever contains a 2FA code", async () => {
    // The thread body already redacted server-side; the proposal must carry no code. Even
    // if a code-like token leaked into the proposal, it is not a taxonomy label so it would
    // never be a triage tier / Needs / Type — assert no written label contains the digits.
    const security: ThreadSummary = {
      threadId: "sec-1",
      labels: [],
      proposed: ["⑤ No Action", "Type/Security"],
    };
    const { tools, labelWrites } = makeTools([security]);
    const summary = await runSweep(tools);
    expect(summary.phishing).toBe(1); // counted as a security/phishing thread
    for (const w of labelWrites) {
      for (const l of w.addLabels) {
        expect(l).not.toMatch(/\d{6}/); // no 6-digit code in any label
      }
    }
  });

  it("the emitted payload never carries a code/link (only counts)", () => {
    const evt = buildSweepEvent("2026-06-05", { labeled: 2, uncertain: 0, phishing: 1 });
    const json = JSON.stringify(evt.payload);
    expect(json).not.toMatch(/\d{6}/);
    expect(json.toLowerCase()).not.toContain("http");
    expect(json.toLowerCase()).not.toContain("verification code");
  });
});
