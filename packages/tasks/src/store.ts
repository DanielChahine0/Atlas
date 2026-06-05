/**
 * @atlas/tasks — D1 data-access for the tasks/subtasks system-of-record.
 *
 * STORAGE ONLY: this package holds the SQL + the dedupe/merge critical section. It has
 * NO extraction/LLM logic (that lives in Forge) and emits NO Wire event (Forge emits one
 * per new/changed task). Sundial/Compass call the read functions; Forge calls upsertTask.
 *
 * Hard rules (CLAUDE.md gotchas):
 *   - D1 takes anonymous positional `?` params ONLY — every statement below binds with
 *     `.bind(...positional)`; no task field is ever string-interpolated into the SQL
 *     (T-1-D1-01: no SQL injection surface).
 *   - Tasks live in D1, never KV.
 *   - The dedupe/merge path is idempotent: a same-key re-insert is a no-op (replay-safe),
 *     and a cross-channel hit MERGES (union subtasks, earliest due, max priority) rather
 *     than duplicating. A locked_by_owner=1 row short-circuits to noop (never clobbered).
 */

/** A task to insert/merge. `id`/`dedupe_key` are caller-derived (Forge); timestamps too. */
export interface TaskInput {
  id: string;
  dedupe_key: string;
  thread: string | null;
  title: string;
  priority: string | null;
  due: string | null;
  due_kind: string | null;
  status?: string;
  source_agent?: string | null;
  locked_by_owner?: number;
  subtasks?: SubtaskInput[];
}

export interface SubtaskInput {
  id: string;
  title: string;
  done?: number;
}

/** A persisted task row (the read shape Sundial/Compass consume). */
export interface TaskRow {
  id: string;
  dedupe_key: string;
  thread: string | null;
  title: string;
  priority: string | null;
  due: string | null;
  due_kind: string | null;
  status: string;
  source_agent: string | null;
  locked_by_owner: number;
  created_at: number;
  updated_at: number;
}

export type UpsertAction = "inserted" | "merged" | "noop";

/** Priority ordering: P1 is the strongest. A lower index = higher priority. */
const PRIORITY_ORDER = ["P1", "P2", "P3", "P4"];

/** Return the stronger (lower-numbered) of two priorities; tolerant of null/unknown. */
function maxPriority(a: string | null, b: string | null): string | null {
  const ia = a ? PRIORITY_ORDER.indexOf(a) : -1;
  const ib = b ? PRIORITY_ORDER.indexOf(b) : -1;
  if (ia === -1) return b ?? a;
  if (ib === -1) return a ?? b;
  return ia <= ib ? a : b;
}

/** Return the earliest of two ISO-8601 due strings; null is "no deadline" (loses). */
function earliestDue(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

/**
 * Insert a task on a dedupe miss; merge on a dedupe hit. Returns the action taken.
 *
 *   - miss              → INSERT the task row (+ its subtasks). action: "inserted".
 *   - hit, owner-locked → no-op (never clobber an owner edit). action: "noop".
 *   - hit, not locked   → MERGE: union subtasks, take earliest due + strongest priority,
 *                         re-open if currently open, bump updated_at. action: "merged".
 *
 * The dedupe is structural (idx_tasks_dedupe unique on dedupe_key). We FIRST read the
 * existing row by dedupe_key; if absent we INSERT guarded by ON CONFLICT(dedupe_key) DO
 * NOTHING so a racing concurrent insert (app-side miss → DB-side collision) does not
 * throw — we detect the collision via meta.changes===0 and fall into the merge path
 * (CONTEXT AC: "Catch a unique-collision after an app-side miss and fall into merge").
 */
export async function upsertTask(
  db: D1Database,
  task: TaskInput,
): Promise<{ action: UpsertAction; id: string }> {
  const now = Date.now();
  const existing = await db
    .prepare(
      `SELECT id, dedupe_key, thread, title, priority, due, due_kind, status,
              source_agent, locked_by_owner, created_at, updated_at
         FROM tasks WHERE dedupe_key = ?`,
    )
    .bind(task.dedupe_key)
    .first<TaskRow>();

  if (existing === null) {
    // Dedupe miss → attempt INSERT. ON CONFLICT DO NOTHING absorbs a concurrent race.
    const ins = await db
      .prepare(
        `INSERT INTO tasks
           (id, dedupe_key, thread, title, priority, due, due_kind, status,
            source_agent, locked_by_owner, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .bind(
        task.id,
        task.dedupe_key,
        task.thread,
        task.title,
        task.priority,
        task.due,
        task.due_kind,
        task.status ?? "open",
        task.source_agent ?? null,
        task.locked_by_owner ?? 0,
        now,
        now,
      )
      .run();

    if (ins.meta.changes === 0) {
      // A concurrent insert won the race between our SELECT and our INSERT. Re-read and
      // merge into the row that landed (collision-safe; we do not throw).
      const winner = await db
        .prepare(
          `SELECT id, dedupe_key, thread, title, priority, due, due_kind, status,
                  source_agent, locked_by_owner, created_at, updated_at
             FROM tasks WHERE dedupe_key = ?`,
        )
        .bind(task.dedupe_key)
        .first<TaskRow>();
      if (winner) return await mergeInto(db, winner, task, now);
      // Extremely unlikely (row vanished); report noop rather than crash.
      return { action: "noop", id: task.id };
    }

    // Insert succeeded → write any subtasks (replay-safe via INSERT OR IGNORE on PK).
    await insertSubtasks(db, task.id, task.subtasks ?? []);
    return { action: "inserted", id: task.id };
  }

  // Dedupe hit → merge into the existing row (or noop if owner-locked).
  return await mergeInto(db, existing, task, now);
}

/** Merge `task` into the existing `row`; owner-locked rows short-circuit to noop. */
async function mergeInto(
  db: D1Database,
  row: TaskRow,
  task: TaskInput,
  now: number,
): Promise<{ action: UpsertAction; id: string }> {
  if (row.locked_by_owner === 1) {
    // Never clobber an owner edit.
    return { action: "noop", id: row.id };
  }
  const mergedPriority = maxPriority(row.priority, task.priority ?? null);
  const mergedDue = earliestDue(row.due, task.due ?? null);
  // due_kind follows whichever due survived; prefer "explicit" over "inferred".
  const mergedDueKind =
    mergedDue === task.due && mergedDue !== row.due ? (task.due_kind ?? null) : row.due_kind;

  await db
    .prepare(
      `UPDATE tasks
          SET priority = ?, due = ?, due_kind = ?, updated_at = ?
        WHERE id = ? AND locked_by_owner = 0`,
    )
    .bind(mergedPriority, mergedDue, mergedDueKind, now, row.id)
    .run();

  // Union the incoming subtasks under the EXISTING row's id (replay-safe).
  await insertSubtasks(db, row.id, task.subtasks ?? []);
  return { action: "merged", id: row.id };
}

/** Insert subtasks under a task id; INSERT OR IGNORE on PK makes re-inserts no-ops. */
async function insertSubtasks(
  db: D1Database,
  taskId: string,
  subtasks: SubtaskInput[],
): Promise<void> {
  if (subtasks.length === 0) return;
  const now = Date.now();
  const stmts = subtasks.map((s) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO subtasks (id, task_id, title, done, created_at)
           VALUES (?,?,?,?,?)`,
      )
      .bind(s.id, taskId, s.title, s.done ?? 0, now),
  );
  await db.batch(stmts);
}

/** Sundial's input: open tasks that carry a deadline (due IS NOT NULL). */
export async function readOpenDeadlineTasks(db: D1Database): Promise<TaskRow[]> {
  const res = await db
    .prepare(
      `SELECT id, dedupe_key, thread, title, priority, due, due_kind, status,
              source_agent, locked_by_owner, created_at, updated_at
         FROM tasks
        WHERE due IS NOT NULL AND status = 'open'
        ORDER BY due ASC`,
    )
    .all<TaskRow>();
  return res.results ?? [];
}

/** Compass's input: all open tasks (with or without a deadline). */
export async function readOpenTasks(db: D1Database): Promise<TaskRow[]> {
  const res = await db
    .prepare(
      `SELECT id, dedupe_key, thread, title, priority, due, due_kind, status,
              source_agent, locked_by_owner, created_at, updated_at
         FROM tasks
        WHERE status = 'open'
        ORDER BY due ASC`,
    )
    .all<TaskRow>();
  return res.results ?? [];
}
