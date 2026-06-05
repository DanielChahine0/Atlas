-- migrations/0004_incidents_flagger.sql
--
-- Atlas D1 Phase-2 tables — the substrate for Scout, Headhunter, and Flagger.
-- D1 is authoritative (Pillar 4); Vault projections are rendered derivatives.
-- Phase 0's 0001_init_core.sql created the spine tables; 0003_tasks.sql added
-- the task store. THIS migration adds four new tables:
--
--   events   — Scout/Usher event discovery + registration lifecycle
--   windows  — Headhunter hiring-cycle windows (per company + role class)
--   jobs     — Headhunter individual job postings (child of a window)
--   flags    — Flagger audit trail of resolved flag records (long-term history)
--
-- HARD RULES (same as 0001/0003 — see CLAUDE.md gotchas):
--   * D1 supports anonymous positional `?` params ONLY at the call site (no named
--     params). The DDL here binds nothing; the constraint is enforced in agent code.
--   * KV is NOT the system-of-record for any of these entities — D1 is.
--   * No 2FA codes / reset links / login URLs are ever stored here.
--   * No migration applies retroactively to existing rows in other tables.

-- ─────────────────────────────────────────────────────────────────────────────
-- events — Scout-discovered events + Usher registration lifecycle.
--
-- One row per unique event (id = Scout-derived stable slug, e.g. "mlconf-2026-09").
-- `status` tracks the lifecycle: discovered → relevant → registered | skipped.
-- `digest_date` is the ISO-8601 date the event first appeared in a Scout digest
-- (used for staleness gating — a "happening soon" event from months ago is low value).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,              -- stable Scout-derived slug (e.g. mlconf-2026-09)
  title        TEXT NOT NULL,
  start        TEXT,                          -- ISO-8601 datetime or date
  end          TEXT,                          -- ISO-8601 datetime or date; NULL if single-day
  location     TEXT,                          -- venue address or city
  online       INTEGER NOT NULL DEFAULT 0,    -- 1 = virtual event
  url          TEXT,                          -- registration / info URL
  source       TEXT,                          -- discovery source (web, calendar, etc.)
  relevance    INTEGER,                       -- Scout's relevance score (0-100)
  why          TEXT,                          -- Scout's one-liner justification
  horizon      TEXT,                          -- "this_week" | "this_month" | "further"
  status       TEXT NOT NULL DEFAULT 'discovered',  -- discovered | relevant | registered | skipped
  digest_date  TEXT,                          -- ISO-8601 date of first Scout digest (YYYY-MM-DD)
  created_at   INTEGER NOT NULL              -- Unix epoch ms (Date.now())
);

-- Index for the Scout/Usher read path (time-ordered; status filter for Usher queue).
CREATE INDEX IF NOT EXISTS idx_events_start  ON events(start);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- windows — Headhunter hiring-cycle windows (one per company + role class).
--
-- A "window" models a company's hiring cycle for a particular role class (e.g.
-- "Google / SWE-New-Grad"). One company may have multiple windows (internship vs
-- new-grad vs experienced). `opens_est` / `closes_est` are estimated ISO-8601 dates.
-- `confidence` is Headhunter's confidence that the window is still open (0.0-1.0).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS windows (
  id             TEXT PRIMARY KEY,            -- stable Headhunter-derived id (company:cycle:role_class)
  company        TEXT NOT NULL,
  cycle          TEXT NOT NULL,               -- "2026-NG" | "2027-intern" etc.
  role_class     TEXT NOT NULL,               -- "new-grad" | "intern" | "experienced"
  opens_est      TEXT,                        -- ISO-8601 date (estimated opening)
  closes_est     TEXT,                        -- ISO-8601 date (estimated closing)
  confidence     REAL,                        -- 0.0 – 1.0; Headhunter-assigned
  source         TEXT,                        -- discovery source URL or identifier
  status         TEXT NOT NULL DEFAULT 'open',  -- open | closed | unknown
  last_seen_open TEXT,                        -- ISO-8601 date of last confirmed-open observation
  created_at     INTEGER NOT NULL,            -- Unix epoch ms
  updated_at     INTEGER NOT NULL,            -- Unix epoch ms (upsert bumps this)
  -- H5 fix: decideWindow needs deadline + fit_score from this table (not just from jobs).
  -- Without these columns both SELECTs returned undefined for both fields, making the
  -- fit-floor guard and the explicit-deadline urgency override structurally unreachable.
  deadline       TEXT,                        -- ISO-8601 explicit apply-by deadline (nullable)
  fit_score      REAL                         -- Headhunter fit score 0.0-1.0 (nullable = unscored)
);

-- Index for Headhunter's status sweep (open windows only) + sort by closes_est.
CREATE INDEX IF NOT EXISTS idx_windows_status      ON windows(status);
CREATE INDEX IF NOT EXISTS idx_windows_closes_est  ON windows(closes_est);

-- ─────────────────────────────────────────────────────────────────────────────
-- jobs — Individual job postings (child of a hiring window).
--
-- One row per unique (company, normalized title, location) posting. `window_id`
-- FK references windows.id (no FOREIGN KEY constraint — D1 does not enforce FKs;
-- enforced at the application layer). `sources` is a JSON array of posting URLs
-- (default '[]'; multiple job boards may list the same role). `fit_score` is
-- Headhunter's computed fit against the Codex resume profile (0.0-1.0).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,            -- stable Headhunter-derived id
  company        TEXT NOT NULL,
  title_norm     TEXT NOT NULL,               -- Headhunter-normalized job title
  location_norm  TEXT,                        -- normalized location (or "remote")
  cycle          TEXT,                        -- hiring cycle tag (mirrors parent window)
  window_id      TEXT,                        -- FK → windows.id (app-enforced, no DB constraint)
  sources        TEXT NOT NULL DEFAULT '[]',  -- JSON array of posting URLs
  deadline       TEXT,                        -- ISO-8601 date or NULL (no stated deadline)
  fit_score      REAL,                        -- 0.0 – 1.0; Headhunter fit assessment
  status         TEXT NOT NULL DEFAULT 'new', -- new | applied | rejected | offer | closed
  first_seen     TEXT NOT NULL,               -- ISO-8601 date of first discovery
  last_seen      TEXT NOT NULL               -- ISO-8601 date of most recent observation
);

-- Deduplication: exactly one row per (company, title_norm, cycle). A second upsert
-- for the same posting updates last_seen rather than inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_fingerprint ON jobs(company, title_norm, cycle);

-- Supporting indexes for Headhunter read paths.
CREATE INDEX IF NOT EXISTS idx_jobs_window ON jobs(window_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- flags — Flagger audit trail of resolved flag records (long-term history).
--
-- One row per unique flag signature (derived by Flagger from severity + title + detail
-- hash — the same contentHash djb2 the @atlas/shared flag() helper uses). This is the
-- D1 audit trail; the live board state lives in the FlaggerState DO SQLite. Flagger
-- upserts here each time it resolves a RawIncident, setting recurrence >= 1 for
-- repeated incidents. `status` tracks owner acknowledgement.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flags (
  id           TEXT PRIMARY KEY,              -- stable flag id (flg:<date>:<agent>:<hash>)
  signature    TEXT NOT NULL,                 -- contentHash(severity|title|detail) — dedupe key
  source_agent TEXT NOT NULL,                 -- RawIncident.source_agent
  severity     TEXT NOT NULL,                 -- P1 | P2 | P3 | P4
  trust        INTEGER NOT NULL DEFAULT 50,   -- 0-100 trust score (DEFAULT_TRUST per severity)
  status       TEXT NOT NULL DEFAULT 'open',  -- open | ack | resolved
  title        TEXT NOT NULL,
  detail       TEXT,
  recurrence   INTEGER NOT NULL DEFAULT 1,    -- count of times this flag class fired (>1 = repeated)
  created_at   INTEGER NOT NULL,             -- Unix epoch ms (first occurrence)
  updated_at   INTEGER NOT NULL             -- Unix epoch ms (most recent upsert)
);

-- Primary query paths for Flagger's board view and owner triage.
CREATE INDEX IF NOT EXISTS idx_flags_severity ON flags(severity, trust);
CREATE INDEX IF NOT EXISTS idx_flags_status   ON flags(status);
CREATE INDEX IF NOT EXISTS idx_flags_source   ON flags(source_agent);
