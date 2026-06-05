---
phase: 01-core-loop-morning-pipeline
plan: 02
subsystem: database
tags: [d1, tasks, dedupe, sha256, migration, system-of-record]

requires:
  - phase: 00-spine
    provides: "migrations/0001_init_core.sql spine tables, steward test infra (vitest-pool-workers + apply-migrations pattern), D1 positional-? discipline"
provides:
  - "migrations/0003_tasks.sql — tasks + subtasks tables + idx_tasks_dedupe unique index + idx_tasks_status_due"
  - "@atlas/tasks package: normalizeTitle + dedupeKey (stable sha256), upsertTask (insert/merge/noop), readOpenDeadlineTasks (Sundial), readOpenTasks (Compass)"
affects: [forge, sundial, compass]

tech-stack:
  added: []
  patterns:
    - "Structural dedupe via D1 UNIQUE index on sha256(thread+normalizedTitle+dueDate)"
    - "Merge-on-collision (union subtasks / earliest due / strongest priority) — replay-safe, never duplicates"
    - "locked_by_owner short-circuit so an owner edit is never clobbered"

key-files:
  created:
    - migrations/0003_tasks.sql
    - packages/tasks/src/dedupe.ts
    - packages/tasks/src/store.ts
    - packages/tasks/src/index.ts
    - packages/tasks/package.json
    - packages/tasks/tsconfig.json
    - packages/tasks/vitest.config.ts
    - packages/tasks/wrangler.test.jsonc
    - packages/tasks/test/dedupe.test.ts
    - packages/tasks/test/store.test.ts
    - packages/tasks/test/apply-migrations.ts
    - packages/tasks/test/worker-entry.ts
  modified:
    - pnpm-lock.yaml

key-decisions:
  - "dedupeKey uses a NUL separator between fields so ('ab','c') cannot collide with ('a','bc')."
  - "upsertTask reads by dedupe_key first, then INSERT ... ON CONFLICT(dedupe_key) DO NOTHING; meta.changes===0 means a concurrent insert won the race → re-read + merge (collision-safe, never throws)."
  - "due is an ISO-8601 owner-local string so a date-only vs datetime distinction survives; earliestDue treats null as 'no deadline' (loses to any concrete due)."
  - "wrangler.test.jsonc points main at a test-only no-op worker-entry.ts because @atlas/tasks is a package, not a deployed Worker, but the pool requires a main entry to mount the D1 binding."

patterns-established:
  - "@atlas/tasks is storage + dedupe ONLY — no extraction/LLM logic and no Wire emit (Forge emits)"
  - "all SQL uses positional ? params; no task field is string-interpolated (no SQL-injection surface)"

requirements-completed: [FORGE-01]

duration: 12 min
completed: 2026-06-05
---

# Phase 1 Plan 02: D1 tasks store + @atlas/tasks Summary

**Created the tasks/subtasks D1 system-of-record (migration 0003 with a unique dedupe index) and a thin @atlas/tasks data-access package that makes duplicate tasks structurally impossible via a sha256 dedupe key + merge-on-collision path, with all access through positional-? params and no Wire/KV writes.**

## Performance

- **Duration:** ~12 min
- **Tasks:** 3 (Task 3 TDD)
- **Files modified:** 12 (11 created, 1 modified)

## Accomplishments
- `0003_tasks.sql` adds `tasks` + `subtasks` + `idx_tasks_dedupe` (UNIQUE) + `idx_tasks_status_due`, mirroring 0001 conventions.
- `@atlas/tasks` builds and typechecks; `dedupeKey` is deterministic (no salt/UUID).
- 12/12 tests pass against a real D1 in workerd — the unique index prevents duplicate rows and the merge path is collision-safe.

## Task Commits

1. **Task 1: 0003_tasks.sql migration** - `(feat 01-02)`
2. **Task 2: @atlas/tasks dedupe.ts + store.ts + package** - `(feat 01-02)`
3. **Task 3: dedupe + store tests (TDD, real D1)** - `(test 01-02)`

## Files Created/Modified
- `migrations/0003_tasks.sql` - task store DDL + dedupe/read indexes.
- `packages/tasks/src/dedupe.ts` - normalizeTitle + stable sha256 dedupeKey.
- `packages/tasks/src/store.ts` - upsertTask (insert/merge/noop) + read functions, positional ? only.
- `packages/tasks/test/*` - pure dedupe tests + real-D1 store tests + apply-migrations helper.

## Verification
- `pnpm --filter @atlas/tasks build && typecheck && test` — all green (12/12 tests, 2 files).
- Migration applies cleanly on top of 0001/0002 (the test harness applies ../../migrations).
- store.ts contains no template-literal-interpolated SQL values (only `?` placeholders); no Wire emit, no KV.

## Deviations from Plan

**[Rule 2 - missing critical] test-only Worker entry** — Found during: Task 3 | The plan's wrangler.test.jsonc mirror needs a `main` for the pool to mount the D1 binding, but @atlas/tasks has no Worker handler. Added `test/worker-entry.ts` (a no-op fetch handler used by no test) and pointed `main` at it. | Files: packages/tasks/test/worker-entry.ts, packages/tasks/wrangler.test.jsonc | Verified: 12/12 pass | Commit: `(test 01-02)`.

**Total deviations:** 1 auto-fixed (1 missing-critical). **Impact:** test-only harness wiring; no production change.

## Self-Check: PASSED
- migrations/0003_tasks.sql contains idx_tasks_dedupe (verified on disk).
- store.ts exports upsertTask/readOpenDeadlineTasks/readOpenTasks; dedupe.ts exports dedupeKey/normalizeTitle (verified).
- `git log --grep="01-02"` returns 3 commits.

## Next
Ready for Wave 2 — Forge (01-05) writes via upsertTask; Sundial (01-06) reads readOpenDeadlineTasks; Compass (01-07) reads readOpenTasks.
