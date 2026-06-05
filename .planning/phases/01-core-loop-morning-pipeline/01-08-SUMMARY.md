---
phase: 01-core-loop-morning-pipeline
plan: 08
subsystem: infra
tags: [workflow, morning-chain, cron, service-binding, rpc, halt, flagger, go-live]

requires:
  - phase: 01-core-loop-morning-pipeline
    provides: "the five agent Workers (Filer.sweep/Herald.daily/Forge.morning/Sundial.sync/Compass.plan) from Plans 03-07; @atlas/shared flag; the Phase-0 Atlas dispatcher + localDate"
provides:
  - "MorningChain Workflow (atlas-morning-chain) — five await-ed start-after-success steps with step.sleepUntil budget gates"
  - "invokeAgent(env, codename, params) service-binding RPC transport (D-11)"
  - "localTime(date, hhmm, tz) DST-safe budget-gate helper"
  - "the ONE 07:45 cron dispatcher case creating instance id morning-<date> + halt→chain.halted P2"
  - "GO-LIVE-CHECKLIST.md (D1-03 baseline + D1-04 miss-review + D1-06 gateway ceilings)"
affects: [steward, dashboard, phase-2]

tech-stack:
  added: []
  patterns:
    - "ONE cron → ONE Workflow with await-ed start-after-success steps (NOT five racing crons)"
    - "instance id morning-<date> as the idempotency handle (re-fire = no-op)"
    - "halt-downstream: a step's terminal failure rethrows → instance errors, Sundial/Compass never run on stale data, ONE chain.halted P2"
    - "orchestration factored into runMorningChain(env,event,step) for unit-testability"

key-files:
  created:
    - apps/atlas/src/morning-chain.ts
    - apps/atlas/src/invoke-agent.ts
    - apps/atlas/src/localtime.ts
    - apps/atlas/test/morning-chain.test.ts
    - apps/atlas/test/halt.test.ts
    - .planning/phases/01-core-loop-morning-pipeline/GO-LIVE-CHECKLIST.md
  modified:
    - apps/atlas/src/index.ts
    - apps/atlas/src/env.ts
    - apps/atlas/wrangler.jsonc

key-decisions:
  - "The orchestration body is a standalone exported runMorningChain(env, event, step) the class delegates to — directly constructing a WorkflowEntrypoint is unsupported in vitest-pool-workers, so this makes the crux (ordering/halt/state-forward) fully unit-testable with a fake step + injected agent bindings."
  - "Step results are JSON-encoded to a flat string for memoization — a deep recursive JSON value type tripped TS2589 (Rpc.Serializable constraint blowup); a flat string sidesteps it while preserving state-forward."
  - "The dispatcher handles both the EDT (45 11 * * 1-5) and EST (45 12 * * 1-5) cron forms so the DST hand-edit only changes wrangler.jsonc, not code."
  - "filer.push_enabled stays false (D1-06): the continuous push path does not go live until the owner sets the two AI-Gateway ceilings."

patterns-established:
  - "invokeAgent dispatches over the five service bindings (FILER/HERALD/FORGE/SUNDIAL/COMPASS) — Atlas stays a Wire producer only (no atlas-wire consumer)"
  - "chain.halted P2 uses flag()'s structured stable id so a replayed halt re-upserts ONE board row"

requirements-completed: [CORE-01]

duration: 28 min
completed: 2026-06-05
---

# Phase 1 Plan 08: MorningChain Workflow + dispatcher + go-live Summary

**Wired the five Phase-1 agents into ONE durable MorningChain Workflow — five await-ed start-after-success steps with DST-safe step.sleepUntil budget gates, dispatched by the ONE 07:45 cron creating instance id morning-<date> (re-fire = no-op), with invokeAgent service-binding RPC transport, halt-downstream that leaves upstream intact + emits exactly one chain.halted P2, and the go-live checklist capturing the three owner gates — closing CORE-01.**

## Performance
- **Duration:** ~28 min
- **Tasks:** 4 automated (Task 3 TDD) + 1 owner checkpoint (deferred, human_needed)
- **Files modified:** 9 (6 created, 3 modified)

## Accomplishments
- MorningChain Workflow + invokeAgent + localTime + the 07:45 dispatcher case + halt→P2.
- Chain crux proven in tests: ordered start-after-success, halt-downstream (one P2, upstream intact), re-fire same-id, dispatcher instance id, DST-safe budget gates requested.
- GO-LIVE-CHECKLIST.md records D1-03/D1-04/D1-06 gates; `filer.push_enabled` stays false until ceilings set.
- `wrangler dev --test-scheduled --local` loads Atlas with the Workflow + five service bindings + cron (Ready on localhost) — the wiring is valid in workerd.

## Task Commits
1. **Task 1+2: invokeAgent + localTime + MorningChain + dispatcher** - `(feat 01-08)`
2. **Task 3: chain crux tests** - `(test 01-08)`
3. **Task 4: go-live checklist** - `(docs 01-08)`
4. **Task 5: owner checkpoint** - DEFERRED (human_needed — see VERIFICATION.md)

## Verification
- `pnpm --filter @atlas/atlas build && typecheck && test` — all green (43 passed, 2 skipped).
- `NonRetryableError`-from-`cloudflare:workflows` gotcha documented; cron case creates id `morning-${date}`; staging triggers.crons is `[]`.
- The CI single-`atlas-wire`-consumer gate still passes (Atlas is a producer only).
- Local `wrangler dev --test-scheduled` reaches "Ready" with the Workflow binding recognized.

## Owner checkpoint (Task 5 — human_needed, NOT blocking)
The live chain dry-run (`__scheduled` fire + `wrangler workflows instances describe`) and the three
go-live gates are OWNER-ONLY actions that cannot be satisfied by code (mirrors how Phase 0 ended):
- **D1-06** — set the two AI-Gateway dollar ceilings in the Cloudflare dashboard (cannot be set from code).
- **D1-03** — one-week pre-launch baseline capture.
- **D1-04** — the daily ~1-min review habit + the Dashboard/Home.md "Misses" affordance.
- A live end-to-end morning-chain smoke needs all six Workers connected + live Google/Obsidian creds.
These are tracked as `human_needed` items in `01-VERIFICATION.md` / the HUMAN-UAT file.

## Deviations from Plan

**[Rule 2 - testability] orchestration extracted from the class** — Found during: Task 3 | Constructing a WorkflowEntrypoint directly throws in vitest-pool-workers ("constructor parameter 1 is not of type 'ExecutionContext'"). Extracted runMorningChain(env,event,step) so the crux is unit-testable with a fake step + injected bindings; the class run() is a thin delegate. | Files: apps/atlas/src/morning-chain.ts | Verified: 43/45 pass | Commit: `(test 01-08)`.

**[Rule 1 - bug] step memoization type** — Found during: Task 2 | A recursive JSON value type for step results tripped TS2589 (Rpc.Serializable constraint blowup). JSON-encoded the step result to a flat string. | Files: apps/atlas/src/morning-chain.ts | Verified: typecheck clean | Commit: `(feat 01-08)`.

**Total deviations:** 2 auto-fixed (1 testability, 1 type bug). **Impact:** the orchestration contract is unchanged and more rigorously tested.

## Self-Check: PASSED
- apps/atlas/src/morning-chain.ts exports MorningChain + runMorningChain; invoke-agent.ts exports invokeAgent; GO-LIVE-CHECKLIST.md contains baseline/push/missed (verified on disk).
- `git log --grep="01-08"` returns 3 commits.

## Next
Phase 1 code-complete. The owner checkpoint (Task 5) + the three go-live gates are tracked as human_needed (Phase-0-style live owner-gates). After the owner satisfies them, the chain flips live.
