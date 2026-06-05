import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { reconcile, type CalendarTools, type ExistingEvent } from "../src/reconcile.js";
import { taskToBlock, isDateOnly, exclusiveEndDate, contentHashOf } from "../src/block.js";
import type { TaskRow } from "@atlas/tasks";
import type { Env } from "../src/index.js";

// DoD test 1 — block mapping + reconcile (skip-on-match / create-on-new / NO delete).

const env2 = env as unknown as Env;

function task(over: Partial<TaskRow> & { id: string; due: string }): TaskRow {
  return {
    dedupe_key: "k-" + over.id,
    thread: "t",
    title: "Submit OA",
    priority: "P2",
    due_kind: "explicit",
    status: "open",
    source_agent: "Forge",
    locked_by_owner: 0,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as TaskRow;
}

/** A recording calendar tool stub (no delete method exists on the interface). */
function makeTools(existing: ExistingEvent[]): {
  tools: CalendarTools;
  state: { creates: number; patches: number };
} {
  const state = { creates: 0, patches: 0 };
  const tools: CalendarTools = {
    async listOwnEvents() {
      return existing;
    },
    async createEvent() {
      state.creates++;
    },
    async patchEvent() {
      state.patches++;
    },
  };
  return { tools, state };
}

describe("Sundial block mapping", () => {
  it("a date-only deadline produces an all-day block with end EXCLUSIVE", () => {
    const block = taskToBlock(task({ id: "x", due: "2026-06-06" }));
    expect(isDateOnly("2026-06-06")).toBe(true);
    expect(block.start.date).toBe("2026-06-06");
    expect(block.end.date).toBe("2026-06-07"); // exclusive
    expect(exclusiveEndDate("2026-06-06")).toBe("2026-06-07");
  });

  it("a datetime deadline produces a timed block ending at due", () => {
    const block = taskToBlock(task({ id: "y", due: "2026-06-06T17:00:00-04:00" }));
    expect(block.end.dateTime).toBe(new Date("2026-06-06T17:00:00-04:00").toISOString());
    expect(block.start.dateTime).toBeDefined();
  });

  it("stamps extendedProperties.private with atlasTaskId + agent:sundial + contentHash", () => {
    const t = task({ id: "z", due: "2026-06-06" });
    const block = taskToBlock(t);
    expect(block.extendedProperties.private.atlasTaskId).toBe("z");
    expect(block.extendedProperties.private.agent).toBe("sundial");
    expect(block.extendedProperties.private.contentHash).toBe(contentHashOf(t));
  });
});

describe("Sundial reconcile (create/patch/skip — no delete)", () => {
  it("creates a block for a task with no existing match", async () => {
    const { tools, state } = makeTools([]);
    const result = await reconcile(env2, [task({ id: "new1", due: "2026-06-06" })], tools);
    expect(result.created).toBe(1);
    expect(state.creates).toBe(1);
    // No decision is ever a delete (the union has no delete verb).
    for (const d of result.decisions) expect(d.action).not.toMatch(/delete/i);
  });

  it("SKIPS a task whose existing block has the same contentHash (no API write)", async () => {
    const t = task({ id: "skip1", due: "2026-06-06" });
    const hash = contentHashOf(t);
    const existing: ExistingEvent[] = [
      { eventId: "ev1", extendedProperties: { private: { atlasTaskId: "skip1", contentHash: hash } } },
    ];
    const { tools, state } = makeTools(existing);
    const result = await reconcile(env2, [t], tools);
    expect(result.skipped).toBe(1);
    expect(state.creates).toBe(0);
    expect(state.patches).toBe(0); // identical → no write
  });

  it("PATCHES on contentHash drift (re-asserts, never deletes)", async () => {
    const t = task({ id: "drift1", due: "2026-06-06", title: "new title" });
    const existing: ExistingEvent[] = [
      { eventId: "ev2", extendedProperties: { private: { atlasTaskId: "drift1", contentHash: "STALE" } } },
    ];
    const { tools, state } = makeTools(existing);
    const result = await reconcile(env2, [t], tools);
    expect(result.updated).toBe(1);
    expect(state.patches).toBe(1);
  });

  it("a duplicate atlasTaskId → keep earliest + propose-removal (gated, NOT delete) + P2", async () => {
    const existing: ExistingEvent[] = [
      { eventId: "dupA", extendedProperties: { private: { atlasTaskId: "dup1", contentHash: "h" } } },
      { eventId: "dupB", extendedProperties: { private: { atlasTaskId: "dup1", contentHash: "h" } } },
    ];
    const { tools } = makeTools(existing);
    const result = await reconcile(env2, [], tools);
    expect(result.proposedRemovals).toBe(1);
    expect(result.decisions.some((d) => d.action === "propose-removal")).toBe(true);
    // propose-removal is a GATED proposal, never an autonomous delete.
  });
});
