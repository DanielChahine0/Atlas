import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runSync, type Env } from "../src/index.js";
import { taskToBlock } from "../src/block.js";
import type { CalendarTools, ExistingEvent } from "../src/reconcile.js";
import type { TaskRow } from "@atlas/tasks";

// DoD test 3 — idempotency: a re-run creates 0 new events (all match + skip).

const env2 = env as unknown as Env;
const db = (env as unknown as { DB: D1Database }).DB;

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

/**
 * A stateful stub: createEvent records a new ExistingEvent (with the same contentHash the
 * block carried) so a SECOND sync over the same tasks finds a matching block and skips it.
 */
function makeStatefulTools(): {
  tools: CalendarTools;
  store: ExistingEvent[];
  creates: () => number;
} {
  const store: ExistingEvent[] = [];
  let creates = 0;
  const tools: CalendarTools = {
    async listOwnEvents() {
      return [...store];
    },
    async createEvent(block) {
      creates++;
      store.push({
        eventId: `ev-${store.length}`,
        extendedProperties: {
          private: {
            atlasTaskId: block.extendedProperties.private.atlasTaskId,
            contentHash: block.extendedProperties.private.contentHash,
          },
        },
      });
    },
    async patchEvent() {
      /* no-op for this test */
    },
  };
  return { tools, store, creates: () => creates };
}

describe("Sundial idempotency", () => {
  it("a second sync over the same deadline tasks creates 0 new events", async () => {
    const tasks = [task({ id: "id1", due: "2026-06-06" }), task({ id: "id2", due: "2026-06-07" })];
    const { tools, creates } = makeStatefulTools();

    const r1 = await runSync(env2, db, "2026-06-05", tools, tasks);
    expect(r1.created).toBe(2);
    expect(creates()).toBe(2);

    // Re-run: the blocks now exist (same contentHash) → all skip, 0 new creates.
    const r2 = await runSync(env2, db, "2026-06-05", tools, tasks);
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBe(2);
    expect(creates()).toBe(2); // unchanged — no duplicate events
  });

  it("the block contentHash is stable for the same task (drives skip-on-match)", () => {
    const t = task({ id: "stable1", due: "2026-06-06" });
    const h1 = taskToBlock(t).extendedProperties.private.contentHash;
    const h2 = taskToBlock(t).extendedProperties.private.contentHash;
    expect(h1).toBe(h2);
  });
});
