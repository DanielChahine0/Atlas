/**
 * One run_log row (the §5.2 superset — migrations/0001_init_core.sql, owned by 00-01):
 *   id (AUTOINCREMENT), agent, type, entity, op, rows_read, rows_written, duration_ms, result, ts
 * Flagger (Phase 2) reads rows_read/duration_ms to detect missing/late runs, so the helper
 * writes the rich superset from day 0.
 */
export interface RunLogRow {
  agent: string;
  type: string;
  entity: string;
  op: string;
  rows_read?: number;
  rows_written?: number;
  duration_ms?: number;
  /** e.g. "ok" | "error". */
  result: string;
}

/**
 * Insert one run_log row.
 *
 * D1 supports ANONYMOUS POSITIONAL `?` params ONLY — no named or numbered params
 * (CLAUDE.md gotcha). `ts` is derived here (epoch ms; the column is NOT NULL). Optional
 * numeric columns pass `null` when absent.
 */
export async function writeRunLog(
  env: { DB: D1Database },
  row: RunLogRow,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO run_log(agent, type, entity, op, rows_read, rows_written, duration_ms, result, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      row.agent,
      row.type,
      row.entity,
      row.op,
      row.rows_read ?? null,
      row.rows_written ?? null,
      row.duration_ms ?? null,
      row.result,
      Date.now(),
    )
    .run();
}
