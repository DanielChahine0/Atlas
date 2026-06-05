/**
 * Compass free/busy grid — working hours minus calendar events, with buffer + min-block.
 *
 * Builds the day's free gaps from the Codex working hours (default 09:00-18:00) minus the
 * day's calendar events, padding each event by `meeting_buffer_min` (default 10) and keeping
 * only gaps ≥ `min_block_min` (default 25). Both knobs are CONFIG-tunable. All math is in
 * MINUTES-FROM-MIDNIGHT (owner-local), so it is timezone-pure for the grid logic.
 */

/** A busy interval (owner-local minutes from midnight). */
export interface BusyInterval {
  startMin: number;
  endMin: number;
}

/** A free gap (owner-local minutes from midnight). */
export interface FreeGap {
  startMin: number;
  endMin: number;
}

export interface GridParams {
  /** Working-hours start, minutes from midnight (default 540 = 09:00). */
  workStartMin?: number;
  /** Working-hours end, minutes from midnight (default 1080 = 18:00). */
  workEndMin?: number;
  /** Padding around each event in minutes (default 10). */
  meetingBufferMin?: number;
  /** Minimum usable gap in minutes (default 25). */
  minBlockMin?: number;
}

export const DEFAULTS: Required<GridParams> = {
  workStartMin: 9 * 60,
  workEndMin: 18 * 60,
  meetingBufferMin: 10,
  minBlockMin: 25,
};

/** Parse "HH:MM" → minutes from midnight. */
export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Build the free gaps for the day. Events are padded by the buffer, clamped to working hours,
 * merged, and subtracted from the working window; only gaps ≥ minBlock survive.
 */
export function buildGrid(events: BusyInterval[], params: GridParams = {}): FreeGap[] {
  const p = { ...DEFAULTS, ...params };

  // Pad + clamp events to the working window.
  const busy = events
    .map((e) => ({
      startMin: Math.max(p.workStartMin, e.startMin - p.meetingBufferMin),
      endMin: Math.min(p.workEndMin, e.endMin + p.meetingBufferMin),
    }))
    .filter((e) => e.endMin > e.startMin)
    .sort((a, b) => a.startMin - b.startMin);

  // Merge overlapping busy intervals.
  const merged: BusyInterval[] = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (last && b.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, b.endMin);
    } else {
      merged.push({ ...b });
    }
  }

  // Subtract busy from the working window → free gaps.
  const gaps: FreeGap[] = [];
  let cursor = p.workStartMin;
  for (const b of merged) {
    if (b.startMin > cursor) gaps.push({ startMin: cursor, endMin: b.startMin });
    cursor = Math.max(cursor, b.endMin);
  }
  if (cursor < p.workEndMin) gaps.push({ startMin: cursor, endMin: p.workEndMin });

  // Keep only gaps ≥ min block.
  return gaps.filter((g) => g.endMin - g.startMin >= p.minBlockMin);
}

/** Total free minutes across the gaps. */
export function freeMinutes(gaps: FreeGap[]): number {
  return gaps.reduce((sum, g) => sum + (g.endMin - g.startMin), 0);
}
