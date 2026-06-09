-- migrations/0008_prompts.sql
--
-- Atlas D1 prompt library (system-of-record for Librarian's dedupe lookup).
-- D1 is authoritative (Pillar 4); the Vault Prompts/<slug>.md notes are the rendered
-- projections that Steward writes on receipt of the Wire upsert event (op:"upsert",
-- payload.fullNote:true). This table is written DIRECTLY by Librarian (system-of-record
-- write); the Vault write is a separate, downstream Steward action.
--
-- HARD RULES (same as 0001/0003):
--   * D1 supports anonymous positional `?` params ONLY at the call site — no named
--     params (`?1` / `:name`). The constraint is enforced in Librarian's dedupe.ts.
--   * D1 is authoritative (Pillar 4). The Vault Prompts/<slug>.md note is a rendered
--     projection Steward writes; never hand-edit counters — the Fri 16:30 build
--     re-derives them from D1 and overwrites drift.
--   * No per-edit history (D-04 chose overwrite); append-only forever (D-05).
--   * tags stored as JSON array TEXT (not a separate table) — personal use, ≤500
--     rows/tool, never queried by tag in hot paths.
--   * Librarian writes this table (system-of-record). Steward writes the Vault note
--     (rendered projection). These are separate writes; this table is NOT a Vault write
--     and does not break Pillar 1 (one Vault writer = Steward).

-- Prompts — one row per unique saved prompt.
-- `slug` is the PRIMARY KEY — a short, URL-safe, human-readable identifier derived
-- by Librarian (e.g. "forge-task-extract-2026-06-09-abc").
-- `tool` is the AI tool name (e.g. "Claude", "Cursor") — used by the dedupe scan to
-- limit similarity comparison to same-tool prompts (SELECT slug, full_prompt FROM prompts WHERE tool = ?).
-- `full_prompt` is the raw prompt text (the full string, never truncated).
-- `title` is the Haiku-derived short description (≤60 chars).
-- `tags` is a JSON array of strings (e.g. '["forge","task-extraction"]') stored as TEXT.
-- `created` / `last_used` are ISO-8601 owner-local strings (e.g. 2026-06-09T14:00:00-04:00).
-- `uses` is the number of times this prompt has been used; defaults to 1 on insert.
CREATE TABLE IF NOT EXISTS prompts (
  slug        TEXT PRIMARY KEY,
  tool        TEXT NOT NULL DEFAULT 'Claude',
  full_prompt TEXT NOT NULL,
  title       TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',   -- JSON array as TEXT
  created     TEXT NOT NULL,                -- ISO-8601 owner-local
  last_used   TEXT NOT NULL,                -- ISO-8601 owner-local
  uses        INTEGER NOT NULL DEFAULT 1
);

-- Scoped dedupe scan index: Librarian reads `SELECT slug, full_prompt FROM prompts WHERE tool = ?`
-- to find same-tool prompts before similarity comparison. This index makes that scan O(k)
-- where k is the number of prompts for that tool, not O(n) across all tools.
CREATE INDEX IF NOT EXISTS idx_prompts_tool ON prompts(tool);
