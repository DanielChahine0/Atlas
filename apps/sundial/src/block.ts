/**
 * Sundial block mapping — turn a deadline task into a Google Calendar block (deterministic).
 *
 * Mapping (docs/agents/sundial.md):
 *   - date-only due → an ALL-DAY block; end.date is EXCLUSIVE, so a 2026-06-06 deadline has
 *     start.date 2026-06-06 and end.date 2026-06-07 (Google's all-day end-exclusive rule).
 *   - datetime due → a TIMED marker ENDING AT due (a short block leading up to the deadline).
 *
 * Every block is stamped extendedProperties.private = { atlasTaskId, agent:"sundial",
 * syncedDue, contentHash } so reconcile can find ONLY Sundial's own blocks (server-side
 * filter privateExtendedProperty agent=sundial) and detect drift via contentHash.
 */

import type { TaskRow } from "@atlas/tasks";

/** The Google Calendar event body Sundial creates/patches (the fields it controls). */
export interface CalendarBlock {
  summary: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  extendedProperties: {
    private: {
      atlasTaskId: string;
      agent: "sundial";
      syncedDue: string;
      contentHash: string;
    };
  };
  reminders: {
    useDefault: false;
    overrides: { method: "popup"; minutes: number }[];
  };
}

/** True iff the ISO due string is date-only (no time component). */
export function isDateOnly(due: string): boolean {
  // date-only is exactly YYYY-MM-DD; a datetime carries a 'T'.
  return /^\d{4}-\d{2}-\d{2}$/.test(due);
}

/** The exclusive end date for an all-day block (due date + 1 day). */
export function exclusiveEndDate(dateYMD: string): string {
  const d = new Date(`${dateYMD}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A small, stable, NON-random content hash (djb2) over the synced fields. */
export function contentHashOf(task: TaskRow): string {
  const material = `${task.title}|${task.priority ?? ""}|${task.due ?? ""}|${task.status}`;
  let h = 5381;
  for (let i = 0; i < material.length; i++) {
    h = ((h << 5) + h + material.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/**
 * Map a deadline task to a calendar block. The task MUST have a non-null due (Sundial only
 * syncs readOpenDeadlineTasks). Returns the full block body including the atlasTaskId stamp.
 */
export function taskToBlock(task: TaskRow): CalendarBlock {
  const due = task.due as string; // guaranteed non-null for deadline tasks
  const stamp = {
    atlasTaskId: task.id,
    agent: "sundial" as const,
    syncedDue: due,
    contentHash: contentHashOf(task),
  };
  // Default reminders: a single popup at the due time (idempotent override set).
  const reminders = {
    useDefault: false as const,
    overrides: [{ method: "popup" as const, minutes: 0 }],
  };

  if (isDateOnly(due)) {
    return {
      summary: `⏰ ${task.title}`,
      start: { date: due },
      end: { date: exclusiveEndDate(due) }, // end EXCLUSIVE
      extendedProperties: { private: stamp },
      reminders,
    };
  }
  // Datetime due → a 15-minute timed marker ending AT due.
  const end = new Date(due);
  const start = new Date(end.getTime() - 15 * 60_000);
  return {
    summary: `⏰ ${task.title}`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: { private: stamp },
    reminders,
  };
}
