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
  if (!m) {
    // The longOffset token did not parse — make the miss OBSERVABLE rather than silently
    // returning "-04:00" (wrong half the year). We still return a value (never crash); a
    // warn surfaces the unparsed token in logs so a runtime/Intl change is caught.
    console.warn(`ownerOffset: unparsed timeZoneName token "${tzName}" — falling back to -04:00`);
    return "-04:00";
  }
  return m[1] ?? "-04:00";
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
  // Days until the NEXT (or same) Friday, mod 7: Mon-Thu count forward, Fri→0 (same day),
  // Sat→+6 and Sun→+5 roll to the upcoming Friday (never a past Friday). A bare `5 - dow`
  // returns a NEGATIVE delta on Saturday (dow=6 → -1), pointing at yesterday's Friday.
  const delta = (5 - dow + 7) % 7;
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

/** Matches a date-only ISO string (YYYY-MM-DD) with no time component. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Infer the deadline for a task from its signals, anchored at the run date `today`.
 * Explicit wins; then EOD; then Due/ThisWeek → Fri 17:00; then Job/OA → +5d; else none.
 */
export function inferDeadline(today: string, signals: DeadlineSignals): DeadlineResult {
  if (signals.explicitDue) {
    // The email STATED a due date verbatim → due_kind "explicit", never "inferred".
    // If the stated date is date-only and the email said "EOD", compose 23:59 owner-local
    // on that date (so "by EOD Monday June 2" → 2026-06-02T23:59:00-04:00, explicit). A
    // date that already carries a time is used exactly as parsed.
    if (signals.eod && DATE_ONLY.test(signals.explicitDue)) {
      return { due: ownerLocalDateTime(signals.explicitDue, "23:59"), due_kind: "explicit" };
    }
    return { due: signals.explicitDue, due_kind: "explicit" };
  }
  if (signals.dueLabel === "Due/Today") {
    return { due: ownerLocalDateTime(today, "23:59"), due_kind: "inferred" };
  }
  if (signals.eod) {
    // EOD stated but no explicit date → anchor at the run date (inferred).
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
