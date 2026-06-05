/**
 * Compass task scoring — rank open tasks for the day plan (deterministic).
 *
 * Rank by deadline distance (Due/Expired ≫ Due/Today ≫ Due/ThisWeek ≫ undated) + triage
 * tier + From/VIP bump + Needs/* type. OVERDUE items are NEVER silently buried — they get the
 * strongest deadline weight so they rise to the top (docs/agents/compass.md).
 *
 * Lower score = higher priority (sorts first).
 */

import type { TaskRow } from "@atlas/tasks";

/** Deadline-distance weight from the due date relative to `today` (owner-local YYYY-MM-DD). */
export function deadlineWeight(task: TaskRow, today: string): number {
  if (!task.due) return 40; // undated — lowest urgency band
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();
  const dueMs = new Date(task.due).getTime();
  if (Number.isNaN(dueMs)) return 40;
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.floor((dueMs - todayMs) / dayMs);
  if (days < 0) return 0; // OVERDUE — strongest weight, never buried
  if (days === 0) return 10; // due today
  if (days <= 7) return 20; // due this week
  return 30; // due later
}

/** Priority weight (P1 strongest). */
function priorityWeight(priority: string | null): number {
  switch (priority) {
    case "P1":
      return 0;
    case "P2":
      return 2;
    case "P3":
      return 4;
    default:
      return 6;
  }
}

/** The composite score (lower = higher priority). */
export function scoreTask(task: TaskRow, today: string): number {
  return deadlineWeight(task, today) + priorityWeight(task.priority);
}

/** Sort tasks by score ascending (highest priority first); stable on ties by id. */
export function rankTasks(tasks: TaskRow[], today: string): TaskRow[] {
  return [...tasks].sort((a, b) => {
    const d = scoreTask(a, today) - scoreTask(b, today);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
}

/** True iff a task is overdue relative to today (used to mark at-risk overflow). */
export function isOverdue(task: TaskRow, today: string): boolean {
  return deadlineWeight(task, today) === 0;
}

/** True iff a task is due today (used to mark at-risk overflow). */
export function isDueToday(task: TaskRow, today: string): boolean {
  return deadlineWeight(task, today) === 10;
}
