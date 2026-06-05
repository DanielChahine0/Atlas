---
phase: 01-core-loop-morning-pipeline
plan: 06
subsystem: api
tags: [sundial, calendar, reconcile, idempotency, no-delete, deterministic]

requires:
  - phase: 01-core-loop-morning-pipeline
    provides: "@atlas/tasks readOpenDeadlineTasks (Plan 02); mcp-google Sundial calendar tools (Plan 01); @atlas/wire; @atlas/shared; @atlas/steward-core"
provides:
  - "apps/sundial Worker — Sundial.sync WorkerEntrypoint (sundial-sync step target) emitting sundial-<date>"
  - "block.ts deterministic task→block mapping (all-day end-exclusive / timed-at-due + atlasTaskId/contentHash stamp)"
  - "reconcile.ts create/patch/skip keyed on atlasTaskId — NO delete; dup→gated removal proposal + P2"
affects: [morning-chain, steward]

tech-stack:
  added: []
  patterns:
    - "Reconcile keyed on atlasTaskId with contentHash drift detection; list-before-create insert-race guard"
    - "CalendarTools interface has NO delete method — the autonomous-delete path is unreachable (Pillar 2)"
    - "Deterministic mapping (no model) — own-events-only via privateExtendedProperty agent=sundial"

key-files:
  created:
    - apps/sundial/src/index.ts
    - apps/sundial/src/reconcile.ts
    - apps/sundial/src/block.ts
    - apps/sundial/wrangler.jsonc
    - apps/sundial/wrangler.test.jsonc
    - apps/sundial/vitest.config.ts
    - apps/sundial/package.json
    - apps/sundial/tsconfig.json
    - apps/sundial/test/reconcile.test.ts
    - apps/sundial/test/wire.test.ts
    - apps/sundial/test/idempotency.test.ts
    - apps/sundial/test/apply-migrations.ts

key-decisions:
  - "An all-day deadline uses end EXCLUSIVE (a 2026-06-06 deadline has end.date 2026-06-07) per Google's all-day rule."
  - "Duplicate/orphan removal is a GATED Steward proposal (propose-removal) + P2 — never an autonomous delete; the ReconcileAction union has no delete verb."
  - "The block contentHash (djb2 over title|priority|due|status) is the skip-on-match key; identical → no API write, drift → patch re-asserting the full reminders set."

patterns-established:
  - "Sundial emits sundial-<date> (op:upsert) — WIRE producer only, no atlas-wire consumer"
  - "runSync(env, db, date, tools, tasksOverride) is fully injectable for testing"

requirements-completed: [SUNDIAL-01]

duration: 15 min
completed: 2026-06-05
---

# Phase 1 Plan 06: Sundial (task → calendar sync) Summary

**Built the Sundial Worker — it reads Forge's deadline tasks, maps each to a calendar block (all-day end-exclusive / timed-at-due, stamped with atlasTaskId + contentHash), lists only its own blocks, and reconciles create/patch/skip keyed on atlasTaskId with NO delete path (duplicates/orphans become gated removal proposals + P2), emitting a replay-safe sundial-<date> event — calendar.events only, fully deterministic.**

## Performance
- **Duration:** ~15 min
- **Tasks:** 3 (Task 3 TDD)
- **Files modified:** 12 created

## Accomplishments
- Deterministic block mapping + atlasTaskId/contentHash stamp; own-events-only listing.
- Reconcile create/patch/skip with no delete; dup→keep-earliest+gated-removal+P2.
- 12/12 DoD tests pass: mapping + reconcile, exact Wire-contract + replay no-op, idempotent re-run.

## Task Commits
1. **Task 1+2: Worker + block + reconcile** - `(feat 01-06)`
2. **Task 3: reconcile/wire/idempotency DoD tests** - `(test 01-06)`

## Verification
- `pnpm --filter @atlas/sundial build && typecheck && test` — all green (12/12 tests, 3 files).
- No calendar_delete/delete_event call in src; `sundial-` structured key present.
- `queues.producers` only (no atlas-wire consumer).

## Deviations from Plan

**[Rule 1 - bug] test helper getter destructure** — Found during: Task 3 | The reconcile test's makeTools returned live counters via getters; destructuring `const { creates } = makeTools()` reads a getter ONCE (capturing 0 before reconcile runs). Switched to returning a `state` object so the assertions read the live count. | Files: apps/sundial/test/reconcile.test.ts | Verified: 12/12 pass | Commit: `(test 01-06)`.

**Total deviations:** 1 auto-fixed (1 test-helper bug). **Impact:** test-only; production code unchanged.

## Self-Check: PASSED
- apps/sundial/src/index.ts exports Sundial (WorkerEntrypoint) + SundialState + buildSyncEvent; reconcile.ts contains atlasTaskId, no delete verb (verified).
- `git log --grep="01-06"` returns 2 commits.

## Next
Ready — the morning chain (01-08) calls Sundial.sync as step 4.
