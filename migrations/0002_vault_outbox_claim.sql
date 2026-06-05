-- migrations/0002_vault_outbox_claim.sql
--
-- W14 — vault_outbox CLAIM/LEASE boundary.
--
-- 0001 gave vault_outbox only `state` (pending → done). With no in-flight/claim state,
-- two overlapping (or retried) /bridge/poll calls SELECT the same `pending` rows and
-- hand them to the daemon twice → a double-drain duplicates append (POST) feed lines.
--
-- This migration adds the CLAIM boundary:
--   * a third `state` value `'sent'` (in-flight / claimed) — no DDL change needed for the
--     value itself (state is free TEXT), but we record the transition timestamp so a
--     crashed daemon's stale claim can be RECLAIMED (never lost — T-00-37).
--   * `claimed_at` — the epoch-ms when poll claimed the row. NULL while pending. poll
--     reclaims a `'sent'` row whose claim is older than the lease window (the daemon
--     died mid-drain) so the intent is re-delivered rather than stranded.
--
-- The claim itself is an ATOMIC `UPDATE ... RETURNING` in poll.ts (one SQLite statement,
-- so two overlapping polls serialize and cannot both claim the same row). ack flips
-- sent→done. D1 takes positional `?` params ONLY (enforced at the call site).

ALTER TABLE vault_outbox ADD COLUMN claimed_at INTEGER;

-- Index the drain hot path (poll filters by state, orders by ts). Keeps the claim
-- UPDATE's inner SELECT cheap as the outbox grows.
CREATE INDEX IF NOT EXISTS idx_vault_outbox_state_ts ON vault_outbox(state, ts);
