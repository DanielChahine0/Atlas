-- migrations/0007_gate.sql
--
-- Atlas D1 Phase-4 tables — the shared confirmation-gate primitive (D4-04).
-- D1 is authoritative (Pillar 4); Vault projections are rendered derivatives.
-- Phase 0's 0001_init_core.sql created the spine tables; 0004_incidents_flagger.sql
-- added the phase-2 tables. THIS migration adds two new tables:
--
--   gate_pending           — confirmation-gate pending rows (Pillar 2 enforce point)
--   browser_action_outbox  — work items drained by the local macOS daemon (Phase-3 extension)
--
-- HARD RULES (same as 0001/0004 — see CLAUDE.md gotchas):
--   * D1 supports anonymous positional `?` params ONLY at the call site (no named
--     params). The DDL below does not bind anything; the constraint is enforced in
--     agent code.
--   * KV is NOT the system-of-record for any of these entities — D1 is.
--   * No 2FA codes / reset links / login URLs are ever stored here.
--   * No migration applies retroactively to existing rows in other tables.
--   * Rows are never dropped; only status transitions. Steward never destroys rows.
--     Terminal statuses are: approved | rejected | expired.

-- ─────────────────────────────────────────────────────────────────────────────
-- gate_pending — confirmation-gate rows (one per gated action).
--
-- Lifecycle: open (openGate) → decide (decideGate: approved | rejected) or expire
-- (sweepExpired: expired). Each row has exactly ONE terminal status and exactly ONE
-- terminal audit_log row (enforced by the AND status='pending' guards in decideGate
-- and sweepExpired).
--
-- token_hash stores SHA-256 hex of the random opaque token — the plaintext is NEVER
-- persisted. The confirm page receives the plaintext via the URL ?t= param, hashes it,
-- and looks up the row by token_hash.
--
-- fields/artifact carry only Codex-derived field values (name, email, phone) and
-- agent-drafted artifact text — NEVER passwords, session tokens, or 2FA codes.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gate_pending (
  id              TEXT PRIMARY KEY,             -- unique per gate (local random hex)
  agent           TEXT NOT NULL,                -- "Usher" | "Envoy" | "Sundial"
  action          TEXT NOT NULL,                -- "event.register" | "brand.publish" | "calendar.remove"
  target          TEXT NOT NULL,                -- event-id, project-slug, or calendar event-id
  artifact        TEXT NOT NULL,                -- JSON literal artifact (post text / form values)
  edited_artifact TEXT,                         -- JSON edited artifact (null until owner edits)
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | expired
  decision        TEXT NOT NULL DEFAULT 'pending',
  scope_used      TEXT NOT NULL DEFAULT '',         -- the scope the approved action will exercise
  idempotency_key TEXT NOT NULL,                -- caller's stable key; UNIQUE enforces no duplicate gates
  token_hash      TEXT NOT NULL,                -- SHA-256 of the opaque plaintext token (never plaintext)
  expires_at      INTEGER NOT NULL,             -- epoch ms
  flag_id         TEXT,                         -- FK to flags.id (if raised at gate open)
  created_at      INTEGER NOT NULL,             -- Unix epoch ms (Date.now())
  updated_at      INTEGER NOT NULL              -- Unix epoch ms (updated on decide/expire)
);

-- UNIQUE index on idempotency_key: enforces exactly one gate per caller key.
-- A second openGate with the same key hits a UNIQUE constraint → handled as an
-- existing-gate return (no duplicate row, no duplicate push).
CREATE UNIQUE INDEX IF NOT EXISTS idx_gate_idem_key ON gate_pending(idempotency_key);

-- Supporting index for the expiry sweep (status filter + sort by expires_at).
CREATE INDEX IF NOT EXISTS idx_gate_status ON gate_pending(status, expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- browser_action_outbox — work items enqueued for the local macOS daemon.
--
-- Mirrors the vault_outbox claim/lease pattern from 0002_vault_outbox_claim.sql:
-- `claimed_at` is set when the daemon claims an item so concurrent polls don't
-- double-drain the same work item.
--
-- `fields` carries only Codex-derived field values (name, email, phone) for the
-- browser form fill — NEVER passwords, session tokens, or 2FA codes.
-- `gate_id` is an app-enforced FK → gate_pending.id (D1 does not enforce FKs).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS browser_action_outbox (
  id          TEXT PRIMARY KEY,                 -- unique per work item (local random hex)
  agent       TEXT NOT NULL,                    -- "Usher" | "Envoy"
  action_type TEXT NOT NULL,                    -- "event_fill_submit" | "linkedin_prefill" | "x_prefill"
  fields      TEXT NOT NULL,                    -- JSON: resolved field values (name, email, phone — NEVER passwords)
  gate_id     TEXT NOT NULL,                    -- FK → gate_pending.id (app-enforced, no DB constraint)
  target_url  TEXT NOT NULL,                    -- registration URL or platform composer URL
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | done | failed
  claimed_at  INTEGER,                          -- epoch ms when daemon claimed (prevents double-drain)
  outcome     TEXT,                             -- JSON BrowserActionOutcome on done/failed
  created_at  INTEGER NOT NULL                  -- Unix epoch ms (Date.now())
);

-- Supporting index for the daemon drain path (status filter + FIFO order).
CREATE INDEX IF NOT EXISTS idx_browser_action_status ON browser_action_outbox(status, created_at);
