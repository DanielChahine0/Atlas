-- 0005_flags_kind.sql — add `kind` column to flags table (M6 gap-closure, gap-pass 2).
--
-- Previously the OpenFlag interface did not store `kind`, so recurrence re-scores fell back
-- to kind:"unknown" (baseTrust=50), collapsing trust for recurring P1 heartbeat_stale flags
-- from 100 to 55. Adding the column allows Flagger to re-score with the original incident kind.
--
-- The column is nullable (TEXT) so existing rows remain valid with NULL kind
-- (treated as "unknown" by Flagger's score() baseTrust fallback).

ALTER TABLE flags ADD COLUMN kind TEXT;
