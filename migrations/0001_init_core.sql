-- migrations/0001_init_core.sql
--
-- Atlas D1 system-of-record (atlas-db) — the five reconciled core tables.
-- D1 is authoritative (Pillar 4); the Vault is a rendered projection of it.
--
-- HARD RULES (CLAUDE.md gotchas):
--   * D1 supports anonymous positional `?` params ONLY at the call site — no
--     named params (`?1`/`:name`). The DDL below does not bind anything; the
--     constraint is enforced where Steward prepares statements.
--   * Counter increment math is ABSOLUTE in D1 (no atomic +1 in the Vault
--     frontmatter later); Steward bumps `value = value + ?` conditionally and
--     the bridge PATCHes the absolute value.
--   * Idempotency keys are retained FOREVER (D-08) — no TTL window. A replay at
--     any age is a guaranteed no-op (meta.changes === 0).
--   * Counters + idempotency keys live HERE, never in KV (KV is 1 write/s/key
--     + ≤60s lag).

-- Replay-dedup ledger. INSERT OR IGNORE on `key` is the replay detector:
-- meta.changes === 0 on a second apply of the same idempotencyKey.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  agent      TEXT NOT NULL,
  type       TEXT,
  entity     TEXT,
  op         TEXT,
  applied_at INTEGER NOT NULL
);

-- Counters (the dashboard metrics). Absolute value; bumped conditionally inside
-- Steward's atomic batch only when the idempotency key was newly inserted.
CREATE TABLE IF NOT EXISTS counters (
  entity TEXT PRIMARY KEY,
  value  INTEGER NOT NULL DEFAULT 0
);

-- Observability run log — the §5.2 RICHER superset (rows_read/rows_written/
-- duration_ms), not the slimmer T1 shape, so Flagger (Phase 2) can read it.
CREATE TABLE IF NOT EXISTS run_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent         TEXT,
  type          TEXT,
  entity        TEXT,
  op            TEXT,
  rows_read     INTEGER,
  rows_written  INTEGER,
  duration_ms   INTEGER,
  result        TEXT,
  ts            INTEGER NOT NULL
);

-- Security forensic record. Records `scope_used` (the OAuth scope exercised) —
-- NEVER the token itself (security hard invariant). ULID/TEXT primary key.
CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  ts           INTEGER,
  agent        TEXT,
  action       TEXT,
  target       TEXT,
  scope_used   TEXT,
  gated        INTEGER,
  decision     TEXT,
  outcome      TEXT,
  trust        INTEGER,
  consent_flag INTEGER,
  flag_id      TEXT
);

-- Outbound delivery intents, drained by the OUTBOUND-ONLY local macOS daemon
-- (no inbound port on the laptop). Steward enqueues an intent inside the lock;
-- the slow Obsidian PATCH happens outside it. Steward NEVER issues DELETE.
CREATE TABLE IF NOT EXISTS vault_outbox (
  idem    TEXT PRIMARY KEY,
  path    TEXT NOT NULL,
  method  TEXT NOT NULL,
  headers TEXT NOT NULL,
  body    TEXT,
  state   TEXT NOT NULL DEFAULT 'pending',
  ts      INTEGER NOT NULL
);
