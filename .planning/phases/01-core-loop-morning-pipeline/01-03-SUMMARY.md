---
phase: 01-core-loop-morning-pipeline
plan: 03
subsystem: api
tags: [filer, gmail, labels, durable-object, idempotency, security, taxonomy]

requires:
  - phase: 01-core-loop-morning-pipeline
    provides: "mcp-google Filer label tools (Plan 01); @atlas/wire send, @atlas/shared flag/localDate, @atlas/steward-core applyEvent for the replay test"
provides:
  - "apps/filer Worker — Filer.sweep WorkerEntrypoint (filer-sweep Workflow-step RPC target) emitting filer:sweep:<date>"
  - "FilerCursor SQLite DO holding the Gmail historyId + watchExpiration"
  - "taxonomy bootstrap diff (parent-before-child, palette-valid colors)"
  - "classify.ts security guard (strip Needs/Suggest off Type/Security/Phishing) + consistency pass (one triage tier + AI/Uncertain)"
affects: [herald, forge, morning-chain]

tech-stack:
  added: []
  patterns:
    - "Idempotent sweep via newer_than:2d -label:AI/Reviewed query + AI/Reviewed appended LAST"
    - "Injected GmailTools interface (no delete/trash/archive method) → unit-testable + Pillar-2 by construction"
    - "Continuous-push path flag-gated off (CONFIG filer.push_enabled, D1-06) until gateway ceilings set"

key-files:
  created:
    - apps/filer/src/index.ts
    - apps/filer/src/cursor.ts
    - apps/filer/src/taxonomy.ts
    - apps/filer/src/classify.ts
    - apps/filer/wrangler.jsonc
    - apps/filer/wrangler.test.jsonc
    - apps/filer/vitest.config.ts
    - apps/filer/package.json
    - apps/filer/tsconfig.json
    - apps/filer/test/sweep.test.ts
    - apps/filer/test/wire.test.ts
    - apps/filer/test/security.test.ts
    - apps/filer/test/apply-migrations.ts

key-decisions:
  - "GmailTools is an injected interface with NO delete/trash/archive method — the destructive path is unreachable by construction (Pillar 2), and the sweep is unit-testable without a live network."
  - "sweep() with no injected tools emits a zero-summary filer:sweep:<date> (still observable + replay-safe) rather than fabricating label writes — the live Gmail binding lands with owner-provisioned OAuth."
  - "06:00 watch-renewal cron is the ONLY Filer cron (0 10 * * * = 06:00 EDT); the 07:45 sweep is the MorningChain step, not a Filer cron."

patterns-established:
  - "Filer emits filer:sweep:<date> (op:increment, counter emails_labeled) — WIRE producer only, no atlas-wire consumer"
  - "finalizeLabels = security guard ∘ consistency pass, run before any write"

requirements-completed: [FILER-01]

duration: 14 min
completed: 2026-06-05
---

# Phase 1 Plan 03: Filer (Gmail labeler) Summary

**Built the Filer Worker — an idempotent Gmail labeler (sweep RPC + FilerCursor DO + taxonomy bootstrap + security/consistency guards) that labels delta-only, skips AI/Reviewed threads on re-run, never surfaces a 2FA code or acts on a phish, and emits a replay-safe filer:sweep:<date> counter — gmail.modify only with no reachable delete path.**

## Performance
- **Duration:** ~14 min
- **Tasks:** 3 (Task 3 TDD)
- **Files modified:** 13 created

## Accomplishments
- Filer.sweep + FilerCursor + 06:00 renewal cron + flag-gated push path.
- Taxonomy bootstrap creates only missing labels, parent-before-child, palette-valid colors.
- 9/9 DoD tests pass: idempotent re-run (0 new writes), exact Wire-contract + replay no-op, security guard.

## Task Commits
1. **Task 1+2: Worker + DO + taxonomy + classify** - `(feat 01-03)`
2. **Task 3: sweep/wire/security DoD tests** - `(test 01-03)`

## Verification
- `pnpm --filter @atlas/filer build && typecheck && test` — all green (9/9 tests, 3 files).
- No delete/trash/archive method on GmailTools; no `mail.google.com/` scope in src.
- `filer:sweep:` structured key present; `queues.producers` only (no atlas-wire consumer).

## Deviations from Plan
None - plan executed as written (the continuous-push history.list wiring is intentionally
stubbed behind filer.push_enabled per D1-06; live Gmail tools wire in with OAuth).

**Total deviations:** 0.

## Self-Check: PASSED
- apps/filer/src/index.ts exports Filer (WorkerEntrypoint) + FilerCursor; taxonomy/classify present (verified on disk).
- `git log --grep="01-03"` returns 2 commits.

## Next
Ready — Herald (01-04) consumes Filer's labels; the morning chain (01-08) calls Filer.sweep as step 1.
