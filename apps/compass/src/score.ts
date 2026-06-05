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

/**
 * The owner's local UTC offset (e.g. "-04:00") on a given owner-local date. workerd forces
 * TZ=UTC, so anchoring "today" at "T00:00:00Z" is UTC midnight — 4-5h ahead of owner-local
 * midnight. Forge writes real dues as owner-local datetimes WITH an offset (e.g.
 * "<date>T23:59:00-04:00"); a UTC-midnight anchor would misclassify every datetime-bearing due
 * one urgency band too low (and break the "OVERDUE never buried" guarantee). Derive the offset
 * explicitly via Intl America/Toronto (never a bare Date) so the anchor is owner-local midnight.
 */
function ownerOffset(date: string): string {
  // Anchor at owner-local noon of `date` to avoid a DST-boundary midnight ambiguity.
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const longOffset = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    timeZoneName: "longOffset",
  })
    .formatToParts(noonUtc)
    .find((p) => p.type === "timeZoneName")?.value;
  // longOffset looks like "GMT-04:00" (or "GMT" at exactly UTC). Normalize to "±HH:MM".
  if (!longOffset || longOffset === "GMT") return "+00:00";
  const m = /GMT([+-]\d{2}:\d{2})/.exec(longOffset);
  return m?.[1] ?? "+00:00";
}

/**
 * The owner-local calendar date (YYYY-MM-DD) of a due string.
 *
 * A bare date-only string ("YYYY-MM-DD") ALREADY denotes an owner-local calendar date — it
 * carries no time/offset, so reinterpreting it through a timezone would wrongly roll it back a
 * day (UTC midnight is the prior owner-local evening). Pass those through unchanged. Only a due
 * that carries a time/offset (a Forge datetime) is projected onto the owner's calendar via Intl.
 */
function ownerLocalDate(due: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due; // already an owner-local calendar date
  const ms = new Date(due).getTime();
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(ms));
}

/** Deadline-distance weight from the due date relative to `today` (owner-local YYYY-MM-DD). */
export function deadlineWeight(task: TaskRow, today: string): number {
  if (!task.due) return 40; // undated — lowest urgency band
  // Anchor "today" at OWNER-LOCAL midnight, not UTC midnight, so a Forge-shaped datetime due
  // ("<date>T23:59:00-04:00") classifies on the owner's calendar day rather than UTC's.
  const todayMs = new Date(`${today}T00:00:00${ownerOffset(today)}`).getTime();
  // Compare on the owner-local calendar date of the due (collapses datetimes to their owner day).
  const dueLocal = ownerLocalDate(task.due);
  if (dueLocal === null) return 40;
  const dueMs = new Date(`${dueLocal}T00:00:00${ownerOffset(dueLocal)}`).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.round((dueMs - todayMs) / dayMs);
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
