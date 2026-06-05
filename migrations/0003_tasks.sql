-- migrations/0003_tasks.sql
--
-- Atlas D1 task store (the system-of-record for Forge's extracted tasks + subtasks).
-- D1 is authoritative (Pillar 4); the Vault deadline board is a rendered projection.
-- Phase 0's 0001_init_core.sql created the spine tables (ledger / counters / run_log /
-- audit_log / vault_outbox); THIS migration adds the task store that Forge writes and
-- that Sundial (deadline → calendar) and Compass (day plan) read.
--
-- HARD RULES (CLAUDE.md gotchas — same as 0001):
--   * D1 supports anonymous positional `?` params ONLY at the call site — no named
--     params (`?1` / `:name`). The DDL below binds nothing; the constraint is enforced
--     where @atlas/tasks prepares statements (store.ts).
--   * Tasks live HERE (D1), NEVER in KV (KV is 1 write/s/key + ≤60s lag, and is not the
--     system-of-record).
--   * Dedupe is STRUCTURAL: idx_tasks_dedupe is a UNIQUE index on dedupe_key =
--     sha256(thread + normalizedTitle + dueDate). Two inserts that collide are
--     impossible to duplicate — the store's merge-on-collision path absorbs the second.
--   * No 2FA codes / reset links / login URLs are ever stored here — Forge security-skips
--     any item whose only actionable content is a code/link upstream.

-- Tasks — one row per actionable item Forge extracts. `due` is an ISO-8601 owner-local
-- string (e.g. 2026-06-02T23:59:00-04:00) so a date-only vs datetime distinction
-- survives. `locked_by_owner=1` means the owner hand-edited the row; a later upsert
-- short-circuits to a no-op (the store never clobbers an owner edit).
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,        -- stable task id (Forge derives; also the Wire idempotencyKey)
  dedupe_key      TEXT NOT NULL,           -- sha256(thread + normalizedTitle + dueDate)
  thread          TEXT,                    -- source Gmail thread id (NULL for non-email sources)
  title           TEXT NOT NULL,
  priority        TEXT,                    -- P1 | P2 | P3 | P4
  due             TEXT,                    -- ISO-8601 owner-local string, or NULL (no deadline)
  due_kind        TEXT,                    -- explicit | inferred | none
  status          TEXT NOT NULL DEFAULT 'open',   -- open | done | dropped
  source_agent    TEXT,                    -- 'Forge' (Phase 1); 'Headhunter' etc. later
  locked_by_owner INTEGER NOT NULL DEFAULT 0,     -- 1 ⇒ owner-edited; upsert short-circuits to noop
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Subtasks — the ordered, independently-checkable steps of a task.
CREATE TABLE IF NOT EXISTS subtasks (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- THE dedupe guarantee: one row per (thread, normalizedTitle, dueDate). A second
-- insert of the same dedupe_key cannot create a duplicate — the unique index rejects
-- it and the store's merge path absorbs the collision (replay-safe).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe ON tasks(dedupe_key);

-- Supporting index for the Sundial/Compass read path (filter by status, order by due).
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due);
