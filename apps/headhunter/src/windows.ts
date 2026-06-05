/**
 * windows.ts — Headhunter window + job state machine + D1 persistence.
 *
 * Responsibilities:
 *   - WindowRow / JobRow types (maps to D1 windows/jobs from 0004 migration)
 *   - upsertWindow / upsertJob — INSERT OR REPLACE with positional ? only (D1 rule)
 *   - fingerprint() — djb2 of normalize(company)+normalize(title)+location+cycle (dedup key)
 *   - isUrgent() — closes_est within lead_time_days OR explicit deadline set
 *   - shouldFlagLowConfidence() — confidence < 0.4 AND source === "historical"
 *   - decideWindow() — the core branch: null (flag) OR TaskDecision (create apply-by task)
 *   - buildScanSummaryEvent() — produces the headhunter:scan:<date> upsert Wire event
 *
 * HARD RULES:
 *   - D1 positional ? only; NEVER named params
 *   - No tasks table writes here — those go through env.FORGE.createTask in index.ts
 *   - No crypto.randomUUID() — all IDs are deterministic structured strings
 *   - UNIQUE idx_jobs_fingerprint on (company, title_norm, cycle) handles dedup
 */

import type { WireEvent } from "@atlas/wire";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Maps to the D1 `windows` table (migration 0004). */
export interface WindowRow {
  id: string;
  company: string;
  cycle: string;
  role_class: string;
  opens_est: string | null;
  closes_est: string | null;
  confidence: number | null;
  source: string | null;
  status: string;
  last_seen_open: string | null;
  created_at: number;
  updated_at: number;
  // Optional: used by decideWindow for the apply-by task
  deadline?: string | null;
  fit_score?: number | null;
}

/** Maps to the D1 `jobs` table (migration 0004). */
export interface JobRow {
  id: string;
  company: string;
  title_norm: string;
  location_norm: string | null;
  cycle: string | null;
  window_id: string | null;
  sources: string; // JSON array of posting URLs
  deadline: string | null;
  fit_score: number | null;
  status: string;
  first_seen: string;
  last_seen: string;
}

/** The decision produced by decideWindow — passed back to index.ts for Forge emission. */
export interface TaskDecision {
  idempotencyKey: string;
  title: string;
  due: string | null;
  due_kind: "explicit" | "inferred";
  priority: "P1" | "P2";
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 persistence (positional ? only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * INSERT OR REPLACE INTO windows — idempotent by primary key (window.id).
 * A second call with the same id replaces the row (updates all columns including
 * updated_at). The UNIQUE constraint on id means only one row ever exists per window.
 */
export async function upsertWindow(db: D1Database, w: WindowRow): Promise<void> {
  await db
    .prepare(
      // H5 fix: include deadline and fit_score columns (added to windows table in 0004).
      `INSERT OR REPLACE INTO windows(id,company,cycle,role_class,opens_est,closes_est,confidence,source,status,last_seen_open,created_at,updated_at,deadline,fit_score)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      w.id,
      w.company,
      w.cycle,
      w.role_class,
      w.opens_est ?? null,
      w.closes_est ?? null,
      w.confidence ?? null,
      w.source ?? null,
      w.status,
      w.last_seen_open ?? null,
      w.created_at,
      w.updated_at,
      w.deadline ?? null,
      w.fit_score ?? null,
    )
    .run();
}

/**
 * INSERT OR REPLACE INTO jobs — idempotent via UNIQUE idx_jobs_fingerprint
 * on (company, title_norm, cycle). A second call with the same fingerprint
 * replaces the row in place (updating last_seen, fit_score, sources, etc.).
 */
export async function upsertJob(db: D1Database, j: JobRow): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO jobs(id,company,title_norm,location_norm,cycle,window_id,sources,deadline,fit_score,status,first_seen,last_seen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      j.id,
      j.company,
      j.title_norm,
      j.location_norm ?? null,
      j.cycle ?? null,
      j.window_id ?? null,
      j.sources,
      j.deadline ?? null,
      j.fit_score ?? null,
      j.status,
      j.first_seen,
      j.last_seen,
    )
    .run();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a string for fingerprinting: lowercase, collapse whitespace, strip punctuation.
 * This is consistent so the same logical company/title produces the same hash.
 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * djb2 hash — same family as @atlas/shared contentHash. Returns a base-36 string.
 * Used for the jobs fingerprint: normalize(company)+normalize(title)+location+cycle.
 */
export function fingerprint(company: string, titleNorm: string, locationNorm: string, cycle: string): string {
  const input = normalize(company) + normalize(titleNorm) + normalize(locationNorm) + normalize(cycle);
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

// ─────────────────────────────────────────────────────────────────────────────
// Urgency + low-confidence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the window has an explicit deadline set OR closes_est is within
 * leadTimeDays of today (D2-14: urgency bypasses the fit floor).
 *
 * @param closesEst  ISO-8601 date string for estimated closing (e.g. "2026-09-30")
 * @param deadline   ISO-8601 explicit deadline or undefined/null
 * @param leadTimeDays  default 21
 * @param today      ISO-8601 date string for "now" (e.g. "2026-07-10")
 */
export function isUrgent(
  closesEst: string | null | undefined,
  deadline: string | null | undefined,
  leadTimeDays: number,
  today: string,
): boolean {
  // An explicit deadline always makes a window urgent
  if (deadline != null && deadline !== "") return true;

  if (!closesEst) return false;

  // Compute days until closes_est from today
  const todayMs = new Date(today).getTime();
  const closeMs = new Date(closesEst).getTime();
  const daysUntilClose = (closeMs - todayMs) / (1000 * 60 * 60 * 24);

  // Inside lead time means closes_est is STRICTLY LESS than leadTimeDays away
  return daysUntilClose >= 0 && daysUntilClose < leadTimeDays;
}

/**
 * Returns true if this window should be routed to a Flagger P3 instead of creating
 * a task (D2-14): confidence < 0.4 AND source === "historical".
 */
export function shouldFlagLowConfidence(w: {
  confidence: number | null | undefined;
  source: string | null | undefined;
}): boolean {
  return (w.confidence ?? 1) < 0.4 && w.source === "historical";
}

// ─────────────────────────────────────────────────────────────────────────────
// Core decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The central branch for a window:
 *   - Returns null if the window should be routed to a Flagger P3
 *     (shouldFlagLowConfidence === true).
 *   - Returns null if not urgent AND fit_score < fitFloor (hidden by score).
 *   - Otherwise returns a TaskDecision with the structured idempotencyKey and priority.
 *
 * The caller (index.ts) is responsible for:
 *   - Emitting the P3 flag via flag(env, ...) when null is returned due to low-confidence
 *   - Calling env.FORGE.createTask when a TaskDecision is returned
 */
export function decideWindow(
  window: WindowRow,
  opts: { leadTimeDays: number; fitFloor: number; date: string },
): TaskDecision | null {
  const { leadTimeDays, fitFloor, date } = opts;

  // Low-confidence historical window → flag, not a task
  if (shouldFlagLowConfidence({ confidence: window.confidence, source: window.source })) {
    return null;
  }

  const urgent = isUrgent(window.closes_est, window.deadline, leadTimeDays, date);

  // Only apply fit_floor filter when fit_score is explicitly known (non-null).
  // A null fit_score means the window hasn't been scored yet — allow it through.
  const fitScore = window.fit_score;
  if (!urgent && fitScore !== null && fitScore !== undefined && fitScore < fitFloor) {
    return null;
  }

  // Build the idempotencyKey: lowercase company (no spaces) + raw cycle value + role_class.
  // We preserve the cycle as-is (e.g. "fall-2026") because it's already a stable structured tag.
  // Company is lowercased and spaces removed so "Google LLC" → "googlellc".
  // role_class is included (H2 fix) so "new-grad" and "intern" windows for the same company/cycle
  // produce DISTINCT keys — omitting it caused Forge to silently dedup one deadline.
  const coKey = window.company.toLowerCase().replace(/\s+/g, "");
  const cycleKey = window.cycle.toLowerCase().replace(/\s+/g, "");
  const roleKey = window.role_class.toLowerCase().replace(/\s+/g, "");
  const idempotencyKey = `headhunter:window:${coKey}:${cycleKey}:${roleKey}`;

  const due = window.closes_est ?? null;
  const dueKind: "explicit" | "inferred" =
    (window.confidence ?? 0) >= 0.7 ? "explicit" : "inferred";

  const title = `apply by ${due ?? "?"} — ${window.company} ${window.role_class} (${window.cycle})`;

  // Priority: urgent (inside lead time) = P1, non-urgent = P2
  const priority: "P1" | "P2" = urgent ? "P1" : "P2";

  return { idempotencyKey, title, due, due_kind: dueKind, priority };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the headhunter:scan:<date> scan summary event (op:upsert → Steward → Vault).
 * Emitted once per full() or deadlines() run as the tracking summary.
 */
export function buildScanSummaryEvent(date: string, total: number, tasks: number): WireEvent {
  return {
    agent: "Headhunter",
    type: "windows.scan",
    entity: "windows",
    op: "upsert",
    payload: { date, total, tasks },
    idempotencyKey: `headhunter:scan:${date}`,
  };
}

/**
 * Build a funnel increment Wire event for a (thread, stage) pair.
 * idempotencyKey: headhunter:funnel:<threadId>:<stage>
 */
export function buildFunnelEvent(threadId: string, stage: string): WireEvent {
  return {
    agent: "Headhunter",
    type: "funnel.increment",
    entity: "pipeline",
    op: "increment",
    payload: { stage, thread_id: threadId },
    idempotencyKey: `headhunter:funnel:${threadId}:${stage}`,
  };
}
