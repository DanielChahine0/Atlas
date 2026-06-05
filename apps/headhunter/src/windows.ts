// RED PHASE placeholder — exports exist but behavior not implemented yet
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
  // extra optional fields for job mapping
  deadline?: string | null;
  fit_score?: number | null;
}

export interface JobRow {
  id: string;
  company: string;
  title_norm: string;
  location_norm: string | null;
  cycle: string | null;
  window_id: string | null;
  sources: string;
  deadline: string | null;
  fit_score: number | null;
  status: string;
  first_seen: string;
  last_seen: string;
}

export interface TaskDecision {
  idempotencyKey: string;
  title: string;
  due: string | null;
  due_kind: "explicit" | "inferred";
  priority: "P1" | "P2";
}

export async function upsertWindow(_db: D1Database, _window: WindowRow): Promise<void> {
  throw new Error("not implemented");
}

export async function upsertJob(_db: D1Database, _job: JobRow): Promise<void> {
  throw new Error("not implemented");
}

export function decideWindow(
  _window: WindowRow,
  _opts: { leadTimeDays: number; fitFloor: number; date: string },
): TaskDecision | null {
  throw new Error("not implemented");
}

export function shouldFlagLowConfidence(
  _w: { confidence: number | null; source: string | null },
): boolean {
  throw new Error("not implemented");
}

export function isUrgent(
  _closesEst: string | null,
  _deadline: string | null | undefined,
  _leadTimeDays: number,
  _today: string,
): boolean {
  throw new Error("not implemented");
}

export function buildScanSummaryEvent(
  _date: string,
  _total: number,
  _tasks: number,
): import("@atlas/wire").WireEvent {
  throw new Error("not implemented");
}
