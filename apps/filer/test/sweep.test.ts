import { describe, it, expect } from "vitest";
import { runSweep, type GmailTools, type ThreadSummary } from "../src/index.js";

// DoD test 1 — sweep idempotency. A second sweep over threads already carrying AI/Reviewed
// issues 0 new label writes (the -label:AI/Reviewed query + the defensive skip).

/** A stub Gmail tool surface that records label writes and serves a fixed thread set. */
function makeTools(threads: ThreadSummary[], existingLabels: string[] = []): {
  tools: GmailTools;
  labelWrites: { threadId: string; addLabels: string[] }[];
  created: string[];
} {
  const labelWrites: { threadId: string; addLabels: string[] }[] = [];
  const created: string[] = [];
  const tools: GmailTools = {
    async listLabels() {
      return existingLabels;
    },
    async createLabel(name) {
      created.push(name);
    },
    async searchThreads() {
      return threads;
    },
    async labelThread(threadId, addLabels) {
      labelWrites.push({ threadId, addLabels });
    },
  };
  return { tools, labelWrites, created };
}

describe("Filer sweep idempotency", () => {
  it("labels a fresh thread, then a re-run over an AI/Reviewed thread writes 0 new labels", async () => {
    const fresh: ThreadSummary = {
      threadId: "t1",
      labels: [],
      proposed: ["① Action Required", "Type/Job", "Needs/Reply"],
    };
    const { tools, labelWrites } = makeTools([fresh]);
    const s1 = await runSweep(tools);
    expect(s1.labeled).toBe(1);
    // The delta write + the AI/Reviewed append both happened.
    expect(labelWrites.some((w) => w.addLabels.includes("AI/Reviewed"))).toBe(true);

    // Second run: the same thread now carries AI/Reviewed (the query would also exclude it).
    const reviewed: ThreadSummary = {
      threadId: "t1",
      labels: ["① Action Required", "Type/Job", "Needs/Reply", "AI/Reviewed"],
      proposed: ["① Action Required", "Type/Job", "Needs/Reply"],
    };
    const { tools: tools2, labelWrites: writes2 } = makeTools([reviewed]);
    const s2 = await runSweep(tools2);
    expect(s2.labeled).toBe(0);
    expect(writes2.length).toBe(0); // ZERO new label writes on re-run
  });

  it("only creates missing taxonomy labels (bootstrap diff is idempotent)", async () => {
    // Pretend every taxonomy label already exists → no create_label calls.
    const { TAXONOMY } = await import("../src/taxonomy.js");
    const allNames = TAXONOMY.map((l) => l.name);
    const { tools, created } = makeTools([], allNames);
    await runSweep(tools);
    expect(created.length).toBe(0);
  });

  it("writes only the DELTA of labels not already present", async () => {
    const partial: ThreadSummary = {
      threadId: "t2",
      labels: ["Type/Job"], // already has Type/Job
      proposed: ["① Action Required", "Type/Job"],
    };
    const { tools, labelWrites } = makeTools([partial]);
    await runSweep(tools);
    const delta = labelWrites.find((w) => w.threadId === "t2" && !w.addLabels.includes("AI/Reviewed"));
    expect(delta?.addLabels).toContain("① Action Required");
    expect(delta?.addLabels).not.toContain("Type/Job"); // not re-written
  });
});
