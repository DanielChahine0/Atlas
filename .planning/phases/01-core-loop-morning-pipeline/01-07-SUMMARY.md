---
phase: 01-core-loop-morning-pipeline
plan: 07
subsystem: api
tags: [compass, planner, overcommitment, opus-effort, free-busy, day-plan]

requires:
  - phase: 01-core-loop-morning-pipeline
    provides: "@atlas/tasks readOpenTasks (Plan 02); mcp-google Compass calendar.readonly tool (Plan 01); @atlas/model claudeFor + per-call effort; @atlas/codex; @atlas/wire; @atlas/shared; @atlas/steward-core"
provides:
  - "apps/compass Worker — Compass.plan WorkerEntrypoint (compass-plan step target) + 21:00 preview cron emitting compass:plan:<date>"
  - "score.ts deadline-distance + priority scoring (overdue never buried)"
  - "grid.ts free/busy grid (working hours minus events, buffer + min-block)"
  - "plan.ts bin-pack + overcommitment Couldn't-fit + resolveEffort (medium default, compass.effort KV override)"
affects: [morning-chain, steward, dashboard]

tech-stack:
  added: []
  patterns:
    - "Overcommitment: demand>free → visible Couldn't-fit list (surface, never drop) + at-risk + P3"
    - "Opus effort resolved from CONFIG compass.effort, default medium, NEVER high hardcoded (D1-05)"
    - "day_plan op:upsert REPLACES the Today note (compass:plan:<date>), never appends"

key-files:
  created:
    - apps/compass/src/index.ts
    - apps/compass/src/score.ts
    - apps/compass/src/grid.ts
    - apps/compass/src/plan.ts
    - apps/compass/wrangler.jsonc
    - apps/compass/wrangler.test.jsonc
    - apps/compass/vitest.config.ts
    - apps/compass/package.json
    - apps/compass/tsconfig.json
    - apps/compass/test/overcommit.test.ts
    - apps/compass/test/wire.test.ts
    - apps/compass/test/effort.test.ts
    - apps/compass/test/apply-migrations.ts

key-decisions:
  - "resolveEffort(env) is the single source for the Opus effort: CONFIG compass.effort ?? 'medium' — never 'high' as a literal default (D1-05). A hard day is bumped via KV, not by shipping high."
  - "Overcommitment is computed deterministically (demand>free), not LLM-judged; every overflowed task is surfaced under Couldn't-fit and an at-risk Due/Today/overdue overflow raises P3 — no task is ever silently dropped."
  - "Compass has NO calendar write tool — calendar.readonly only; it suggests, never moves an event (one-writer rule; Sundial/Usher own the calendar)."

patterns-established:
  - "Compass emits compass:plan:<date> (op:upsert) — WIRE producer only, no atlas-wire consumer"
  - "runPlan(env, date, mode, {tasks, events, gridParams}) is fully injectable for testing"

requirements-completed: [COMPASS-01]

duration: 17 min
completed: 2026-06-05
---

# Phase 1 Plan 07: Compass (daily planner) Summary

**Built the Compass Worker — the last chain stage: it scores open tasks (overdue never buried), builds a free/busy grid, bin-packs a time-blocked plan with a top-3, surfaces overcommitment as a visible '⚠ Couldn't fit today' list + at-risk marking + P3 (never drops a task), resolves the Opus effort from CONFIG (medium default, never high), and emits a replay-safe compass:plan:<date> upsert that replaces the Today note — calendar.readonly only.**

## Performance
- **Duration:** ~17 min
- **Tasks:** 3 (Task 3 TDD)
- **Files modified:** 13 created

## Accomplishments
- Scoring + free/busy grid + bin-pack with surface-don't-drop overcommitment + P3.
- Opus effort=medium default with working compass.effort KV override (D1-05).
- 8/8 DoD tests pass: overcommit, exact Wire-contract + replay no-op, effort default+override.

## Task Commits
1. **Task 1+2: Worker + score + grid + plan** - `(feat 01-07)`
2. **Task 3: overcommit/wire/effort DoD tests** - `(test 01-07)`

## Verification
- `pnpm --filter @atlas/compass build && typecheck && test` — all green (8/8 tests, 3 files).
- No calendar write tool call in src; no hardcoded "high" effort literal (only CONFIG-resolved); `compass.effort` + `compass:plan:` present.
- `queues.producers` only (no atlas-wire consumer).

## Deviations from Plan
None - plan executed as written.

**Total deviations:** 0.

## Self-Check: PASSED
- apps/compass/src/index.ts exports Compass (WorkerEntrypoint) + CompassState + buildDayPlanEvent; plan.ts contains compass.effort + resolveEffort (verified).
- `git log --grep="01-07"` returns 2 commits.

## Next
Ready — the morning chain (01-08) calls Compass.plan as step 5 (the final stage).
