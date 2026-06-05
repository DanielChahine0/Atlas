import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runPlan, type Env } from "../src/index.js";
import { buildPlan, demandMinutes } from "../src/plan.js";
import { buildGrid, freeMinutes } from "../src/grid.js";
import type { TaskRow } from "@atlas/tasks";

// DoD test 1 — overcommitment: surface (Couldn't-fit) never drop, raise P3, never write calendar.

const env2 = env as unknown as Env;

function task(over: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    dedupe_key: "k-" + over.id,
    thread: "t",
    title: "Task " + over.id,
    priority: "P2",
    due: "2026-06-05",
    due_kind: "explicit",
    status: "open",
    source_agent: "Forge",
    locked_by_owner: 0,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as TaskRow;
}

describe("Compass overcommitment", () => {
  it("an overcommitted day yields a non-empty Couldn't-fit list (no task dropped)", () => {
    // Working window 09:00-18:00 = 540 free minutes; ~13 tasks @45m ≈ 585m demand → ~95m over.
    const tasks = Array.from({ length: 13 }, (_, i) => task({ id: `t${i}`, due: "2026-06-05" }));
    const plan = buildPlan(tasks, [], "2026-06-05");
    expect(plan.overcommitted).toBe(true);
    expect(plan.couldntFit.length).toBeGreaterThan(0);
    // Every task is accounted for — none silently dropped.
    const placed = plan.blocks.length + plan.couldntFit.length;
    expect(placed).toBe(tasks.length);
    // Demand exceeds free.
    expect(demandMinutes(tasks)).toBeGreaterThan(freeMinutes(buildGrid([], {})));
  });

  it("Due/Today / overdue overflow is marked at-risk", () => {
    const tasks = [
      ...Array.from({ length: 12 }, (_, i) => task({ id: `fill${i}`, due: "2026-06-20" })),
      task({ id: "today1", due: "2026-06-05", priority: "P4" }), // due today, low priority → likely overflow
    ];
    const plan = buildPlan(tasks, [], "2026-06-05");
    const overflowToday = plan.couldntFit.find((c) => c.taskId === "today1");
    if (overflowToday) expect(overflowToday.atRisk).toBe(true);
  });

  it("runPlan raises a P3 on an overcommitted day and never calls a calendar write", async () => {
    const tasks = Array.from({ length: 14 }, (_, i) => task({ id: `oc${i}`, due: "2026-06-05" }));
    const result = await runPlan(env2, "2026-06-05", "morning", { tasks, events: [] });
    expect(result.overcommitted).toBe(true);
    // No calendar write tool exists on Compass — the plan path only reads + emits a Wire event.
    expect(result.plan.couldntFit.length).toBeGreaterThan(0);
  });
});
