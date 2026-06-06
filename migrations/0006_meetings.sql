-- migrations/0006_meetings.sql
--
-- Atlas D1 Phase-3 table — transcript index for Echo/Archivist pipeline.
-- D1 is authoritative (Pillar 4); transcript blobs live in R2 (transcripts/ prefix,
-- no expiry; audio/raw/ prefix, 7d lifecycle rule per D-03).
--
-- HARD RULES (same as 0001/0004 — see CLAUDE.md gotchas):
--   * D1 supports anonymous positional `?` params ONLY at the call site (no named
--     params). The DDL here binds nothing; the constraint is enforced in agent code.
--   * KV is NOT the system-of-record for any of these entities — D1 is.
--   * Idempotency is on session_id (PRIMARY KEY); re-run is INSERT OR REPLACE.
--   * No 2FA codes / reset links / login URLs are ever stored here.
--   * No FK constraints (D1 does not enforce FKs — enforce at the application layer,
--     same convention as 0004 jobs→windows).

-- ─────────────────────────────────────────────────────────────────────────────
-- meetings — transcript index for the Echo → Archivist pipeline.
--
-- One row per Echo session. session_id is the natural stable key ("echo-<ISO-timestamp>")
-- assigned by the local capture app when the EchoSession DO is first addressed via
-- getByName("echo-<timestamp>"). Not autoincrement.
--
-- Consent and audio disposition are explicit lifecycle fields (NOT NULL) so that
-- the row always reflects the owner's decision — there is no "unknown" state.
--
-- transcript_r2_key is null until the transcript is uploaded; audio_r2_key is null
-- unless the owner approved raw-audio retention (audio_disposition = "r2-approved").
-- archivist_run is set to the Workflow instance id when Archivist is triggered on
-- meeting end (null until then).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meetings (
  session_id        TEXT PRIMARY KEY,        -- "echo-2026-06-06T14-00-03" (stable structured key)
  calendar_event    TEXT,                    -- null for audio-active arm (no matching calendar entry)
  consent           TEXT NOT NULL,           -- "granted" | "discarded"
  audio_disposition TEXT NOT NULL,           -- "local-only" | "r2-approved" | "discarded"
  transcript_r2_key TEXT,                    -- null until transcript uploaded to R2 transcripts/ prefix
  audio_r2_key      TEXT,                    -- null unless audio_disposition = "r2-approved"
  started           INTEGER NOT NULL,        -- epoch ms (Date.now() when session opens)
  ended             INTEGER,                 -- epoch ms (null until session ends)
  archivist_run     TEXT,                    -- Workflow instance id once Archivist is triggered
  created_at        INTEGER NOT NULL         -- epoch ms (Date.now() at row creation)
);

-- Index for the Archivist read path: consent-gated queries (consent = "granted" only).
CREATE INDEX IF NOT EXISTS idx_meetings_consent  ON meetings(consent);

-- Index for time-ordered session queries (dashboard view, staleness detection).
CREATE INDEX IF NOT EXISTS idx_meetings_started  ON meetings(started);
