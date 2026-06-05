/**
 * localTime — a DST-safe owner-local wall-clock instant for Workflow budget gates.
 *
 * The morning chain's per-step budget gates use `step.sleepUntil(name, localTime(date,"08:00",
 * tz))`, NOT a UTC cron. `step.sleepUntil` is DST-safe (it sleeps to a real instant); this
 * helper computes the absolute UTC instant corresponding to a given owner-local wall-clock time
 * on a given date. workerd forces TZ=UTC, so the offset is derived explicitly via Intl
 * (never `new Date(localString)` which would parse as UTC).
 */

/**
 * The UTC offset (minutes) for `tz` at noon on `dateYMD`. Noon avoids midnight DST-boundary
 * ambiguity. Returns minutes EAST of UTC (e.g. America/Toronto EDT = -240).
 */
function offsetMinutes(dateYMD: string, tz: string): number {
  const at = new Date(`${dateYMD}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * The absolute instant for `hhmm` owner-local wall-clock on `dateYMD` in `tz`. Used by
 * `step.sleepUntil` so a per-step budget gate fires at the owner-local target regardless of DST.
 */
export function localTime(dateYMD: string, hhmm: string, tz: string): Date {
  const [h, min] = hhmm.split(":").map((x) => Number(x));
  const offMin = offsetMinutes(dateYMD, tz);
  // The desired local wall-clock as a UTC instant: subtract the east-offset from the local
  // wall-clock expressed in UTC. (local = utc + offset ⇒ utc = local - offset.)
  const localAsUtcMs = Date.parse(`${dateYMD}T${pad(h)}:${pad(min)}:00Z`);
  return new Date(localAsUtcMs - offMin * 60_000);
}

function pad(n: number | undefined): string {
  return String(n ?? 0).padStart(2, "0");
}
