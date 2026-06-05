---
phase: 01-core-loop-morning-pipeline
plan: 05
subsystem: api
tags: [forge, tasks, extraction, deadline, dedupe, durable-object, security]

requires:
  - phase: 01-core-loop-morning-pipeline
    provides: "@atlas/tasks upsertTask/dedupeKey/normalizeTitle (Plan 02); mcp-google Forge read tools (Plan 01); @atlas/security; @atlas/wire; @atlas/shared; @atlas/steward-core"
provides:
  - "apps/forge Worker — Forge.morning WorkerEntrypoint (forge-morning step target) writing D1 tasks + emitting per-task events"
  - "ForgeLock DO (blockConcurrencyWhile) wrapping the dedupe+write critical section"
  - "extract.ts security-skip + sanitize; deadline.ts inference (explicit/Due/ThisWeek→Fri17:00/Job-OA→+5d/EOD→23:59 owner-local)"
affects: [sundial, compass, morning-chain, steward]

tech-stack:
  added: []
  patterns:
    - "Per-task Wire event keyed on the task id (insert→increment, merge→upsert, noop→nothing)"
    - "Dedupe+write critical section runs inside the ForgeLock DO (serializes overlapping runs)"
    - "Security-skip + sanitizeExtracted so no 2FA code / reset URL ever reaches a task field"

key-files:
  created:
    - apps/forge/src/index.ts
    - apps/forge/src/extract.ts
    - apps/forge/src/deadline.ts
    - apps/forge/src/lock.ts
    - apps/forge/wrangler.jsonc
    - apps/forge/wrangler.test.jsonc
    - apps/forge/vitest.config.ts
    - apps/forge/package.json
    - apps/forge/tsconfig.json
    - apps/forge/test/dedupe.test.ts
    - apps/forge/test/wire.test.ts
    - apps/forge/test/security.test.ts
    - apps/forge/test/apply-migrations.ts

key-decisions:
  - "The task id (task-<dedupeKey[:16]>) is the idempotency anchor end-to-end: it is re-derived from the dedupe key on every run, so a re-run produces the SAME id and a same-source merge/noop emits nothing new."
  - "Owner-local deadline strings are computed via Intl longOffset (workerd forces TZ=UTC) so a date-only vs datetime distinction survives."
  - "A noop merge (same-source hit / owner-locked) emits NO Wire event — only inserts and cross-channel merges emit, keeping the daily re-run a true no-op."

patterns-established:
  - "Forge emits one event per new/changed task keyed on task id — WIRE producer only, no atlas-wire consumer"
  - "runMorning(env, db, today, candidates, extractor, runUnderLock) is fully injectable for testing"

requirements-completed: [FORGE-01]

duration: 18 min
completed: 2026-06-05
---

# Phase 1 Plan 05: Forge (task/subtask extractor) Summary

**Built the Forge Worker — it filters Herald's ① Action Required refs, security-skips code/link-only and phishing items (P2), extracts {title,subtasks,priority} (sanitized so no secret reaches a field), infers deadlines, dedupes/merges into the D1 tasks store inside a per-run DO lock, and emits one replay-safe event per new/changed task keyed on the task id.**

## Performance
- **Duration:** ~18 min
- **Tasks:** 3 blocks (7 logical tasks; Task 3 TDD)
- **Files modified:** 13 created

## Accomplishments
- Forge.morning + ForgeLock DO + deadline inference + extraction security-skip/sanitize.
- Dedupe via @atlas/tasks: re-run creates 0 duplicate tasks; per-task events keyed on task id.
- 11/11 DoD tests pass: dedupe no-dup, exact Wire-contract + replay no-op, security-skip.

## Task Commits
1. **Task 1+2: Worker + lock DO + extract + deadline** - `(feat 01-05)`
2. **Task 3: dedupe/wire/security DoD tests** - `(test 01-05)`

## Verification
- `pnpm --filter @atlas/forge build && typecheck && test` — all green (11/11 tests, 3 files).
- No KV write of task state (tasks live in D1); task-id idempotencyKey present.
- `queues.producers` only (no atlas-wire consumer).

## Deviations from Plan
None - plan executed as written.

**Total deviations:** 0.

## Self-Check: PASSED
- apps/forge/src/index.ts exports Forge (WorkerEntrypoint) + ForgeLock + buildTaskEvent; deadline.ts + extract.ts + lock.ts present (verified).
- `git log --grep="01-05"` returns 2 commits.

## Next
Ready — Sundial (01-06) reads readOpenDeadlineTasks; Compass (01-07) reads readOpenTasks; the chain (01-08) calls Forge.morning as step 3.
