/**
 * Compass planning — bin-pack ranked tasks into the free grid + overcommitment handling.
 *
 * Bin-pack ranked tasks (highest priority first) into the earliest fitting gaps. If demand
 * exceeds free capacity, pack by priority and push the overflow to a VISIBLE "⚠ Couldn't fit
 * today" list — NEVER deleted/hidden (Pillar: surface, don't drop). Overflow that is
 * Due/Today or overdue is marked at-risk and a P3 raised. Compass NEVER writes the calendar.
 *
 * Cost control (D1-05): the Opus `effort` is resolved from CONFIG `compass.effort` with a
 * "medium" default — NEVER "high" hardcoded. resolveEffort() is the single source.
 */

import type { TaskRow } from "@atlas/tasks";
import { rankTasks, isOverdue, isDueToday } from "./score.js";
import { buildGrid, freeMinutes, type BusyInterval, type FreeGap, type GridParams } from "./grid.js";

/** The CONFIG key for the Opus effort override (D1-05). */
export const COMPASS_EFFORT_KEY = "compass.effort";

/** The standing default effort — NEVER "high" as the daily default (D1-05). */
export const DEFAULT_EFFORT = "medium";

/** A planned block: a task assigned to a grid slot. */
export interface PlannedBlock {
  taskId: string;
  title: string;
  startMin: number;
  endMin: number;
}

/** The full day plan. */
export interface DayPlan {
  blocks: PlannedBlock[];
  top3: { taskId: string; title: string }[];
  couldntFit: { taskId: string; title: string; atRisk: boolean }[];
  overcommitted: boolean;
}

/** A default per-task estimate (minutes) — CONFIG-tunable in a later phase. */
const DEFAULT_TASK_MIN = 45;

/**
 * Resolve the Opus effort per D1-05: read CONFIG `compass.effort`, defaulting to "medium".
 * NEVER hardcode "high" — a hard day is bumped up via the KV key, not by shipping high.
 */
export async function resolveEffort(env: { CONFIG: KVNamespace }): Promise<string> {
  const override = await env.CONFIG.get(COMPASS_EFFORT_KEY);
  return override ?? DEFAULT_EFFORT;
}

/**
 * Build the day plan: rank tasks, bin-pack into the free grid (earliest fitting gap), and push
 * the overflow to a visible Couldn't-fit list (at-risk if Due/Today / overdue). Deterministic —
 * the LLM only writes the narrative prose around this skeleton.
 */
export function buildPlan(
  tasks: TaskRow[],
  events: BusyInterval[],
  today: string,
  gridParams: GridParams = {},
  taskMinutes: (t: TaskRow) => number = () => DEFAULT_TASK_MIN,
): DayPlan {
  const ranked = rankTasks(tasks, today);
  const gaps: FreeGap[] = buildGrid(events, gridParams);

  // Mutable copy of the gaps' free cursors for bin-packing.
  const cursors = gaps.map((g) => ({ ...g }));
  const blocks: PlannedBlock[] = [];
  const couldntFit: DayPlan["couldntFit"] = [];

  for (const t of ranked) {
    const need = taskMinutes(t);
    // Find the earliest gap that can still fit `need`.
    const gap = cursors.find((g) => g.endMin - g.startMin >= need);
    if (gap) {
      blocks.push({ taskId: t.id, title: t.title, startMin: gap.startMin, endMin: gap.startMin + need });
      gap.startMin += need;
    } else {
      // Overflow — surface, never drop. At-risk if due today or overdue.
      const atRisk = isOverdue(t, today) || isDueToday(t, today);
      couldntFit.push({ taskId: t.id, title: t.title, atRisk });
    }
  }

  const top3 = blocks.slice(0, 3).map((b) => ({ taskId: b.taskId, title: b.title }));
  return {
    blocks,
    top3,
    couldntFit,
    overcommitted: couldntFit.length > 0,
  };
}

/** Total task demand minutes (for the overcommitment calc). */
export function demandMinutes(
  tasks: TaskRow[],
  taskMinutes: (t: TaskRow) => number = () => DEFAULT_TASK_MIN,
): number {
  return tasks.reduce((sum, t) => sum + taskMinutes(t), 0);
}

/** Re-export freeMinutes for callers computing the demand>free overcommitment check. */
export { freeMinutes, buildGrid };
