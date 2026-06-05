/**
 * Forge deadline inference — derive {due, due_kind} for an extracted task.
 *
 * Rules (docs/agents/forge.md "Deadline inference"):
 *   - EXPLICIT always wins: a stated due date/time is used verbatim (due_kind "explicit").
 *   - Due/ThisWeek (no explicit) → Friday 17:00 owner-local (due_kind "inferred").
 *   - Job/OA (no explicit) → +5 days default (due_kind "inferred").
 *   - "EOD" / "end of day" → 23:59 owner-local (explicit if a date is stated).
 *   - none stated and none inferable → {due:null, due_kind:"none"}.
 *
 * All times are ISO-8601 OWNER-LOCAL strings (e.g. 2026-06-02T23:59:00-04:00) so a
 * date-only vs datetime distinction survives. workerd forces TZ=UTC, so owner-local math is
 * done explicitly (never new Date() local). The owner-local offset is derived from the date.
 */

/** The owner timezone (America/Toronto). */
const OWNER_TZ = "America/Toronto";

export type DueKind = "explicit" | "inferred" | "none";

export interface DeadlineResult {
  due: string | null;
  due_kind: DueKind;
}

/** The owner-local UTC offset string (e.g. "-04:00") for a given YYYY-MM-DD. */
export function ownerOffset(dateYMD: string): string {
  // Format a noon-UTC instant on that date in the owner tz and read the offset via the
  // longOffset token. Noon avoids DST-boundary edge cases at midnight.
  const dt = new Date(`${dateYMD}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OWNER_TZ,
    timeZoneName: "longOffset",
  }).formatToParts(dt);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-04:00";
  // tzName looks like "GMT-04:00" → "-04:00".
  const m = tzName.match(/GMT([+-]\d{2}:\d{2})/);
  return m?.[1] ?? "-04:00";
}

/** Compose an owner-local ISO datetime for a date + HH:MM. */
export function ownerLocalDateTime(dateYMD: string, hhmm: string): string {
  return `${dateYMD}T${hhmm}:00${ownerOffset(dateYMD)}`;
}

/** Add N days to a YYYY-MM-DD (UTC date math; the date label is what matters). */
export function addDays(dateYMD: string, days: number): string {
  const d = new Date(`${dateYMD}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Friday (YYYY-MM-DD) of the week containing `dateYMD` (Mon-anchored week). */
export function fridayOf(dateYMD: string): string {
  const d = new Date(`${dateYMD}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  // Days until Friday (5). If already past Friday, this week's Friday is behind; clamp to it.
  const delta = 5 - dow;
  return addDays(dateYMD, delta);
}

export interface DeadlineSignals {
  /** An explicit ISO-8601 due string the extractor parsed from the thread (wins). */
  explicitDue?: string | null;
  /** The Due/* label, if any (Due/Today, Due/ThisWeek, Due/Expired). */
  dueLabel?: string | null;
  /** Whether the thread carries Job/OA (drives the +5d default). */
  isOA?: boolean;
  /** True when the thread states "EOD"/"end of day" without an explicit time. */
  eod?: boolean;
}

/**
 * Infer the deadline for a task from its signals, anchored at the run date `today`.
 * Explicit wins; then EOD; then Due/ThisWeek → Fri 17:00; then Job/OA → +5d; else none.
 */
export function inferDeadline(today: string, signals: DeadlineSignals): DeadlineResult {
  if (signals.explicitDue) {
    return { due: signals.explicitDue, due_kind: "explicit" };
  }
  if (signals.dueLabel === "Due/Today") {
    return { due: ownerLocalDateTime(today, "23:59"), due_kind: "inferred" };
  }
  if (signals.eod) {
    return { due: ownerLocalDateTime(today, "23:59"), due_kind: "inferred" };
  }
  if (signals.dueLabel === "Due/ThisWeek") {
    return { due: ownerLocalDateTime(fridayOf(today), "17:00"), due_kind: "inferred" };
  }
  if (signals.isOA) {
    return { due: ownerLocalDateTime(addDays(today, 5), "23:59"), due_kind: "inferred" };
  }
  return { due: null, due_kind: "none" };
}
