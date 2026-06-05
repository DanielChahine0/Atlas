---
phase: 02-weekly-value
plan: "05"
subsystem: headhunter
tags: [headhunter, hiring-window, state-machine, do, d1, forge, funnel, d2-13, d2-14, d2-15]
dependency_graph:
  requires:
    - 02-01 (D1 windows/jobs tables from 0004 migration + INCIDENTS queue substrate)
  provides:
    - HeadhunterState DO (serialized window transitions, blockConcurrencyWhile)
    - upsertWindow / upsertJob (D1 persistence, positional ?)
    - decideWindow (low-confidence → null; urgency bypasses fit_floor)
    - classifyFunnelStages (Filer Job/* → funnel stages)
    - full() / deadlines() WorkerEntrypoint methods
    - Headhunter wrangler.jsonc (FORGE service binding, DO, no consumers, no cron)
  affects:
    - apps/headhunter (new Worker)
tech_stack:
  added:
    - "@atlas/headhunter Worker (new, apps/headhunter)"
    - "HeadhunterState DurableObject (new_sqlite_classes, blockConcurrencyWhile pattern)"
    - "rss-parser@3.13.0 (approved in RESEARCH package audit)"
  patterns:
    - "WorkerEntrypoint two-mode (full/deadlines) — same as compass pattern"
    - "blockConcurrencyWhile capture-inside re-throw-after — exact StewardWriter pattern"
    - "D1 INSERT OR REPLACE with positional ? — no named params"
    - "decideWindow: null → flag path; TaskDecision → Forge createTask path"
    - "isUrgent: closes_est < leadTimeDays from today OR explicit deadline"
    - "shouldFlagLowConfidence: confidence < 0.4 AND source === 'historical'"
    - "Single-emitter funnel increments: headhunter:funnel:<thread>:<stage>"
key_files:
  created:
    - apps/headhunter/src/index.ts
    - apps/headhunter/src/windows.ts
    - apps/headhunter/src/state.ts
    - apps/headhunter/src/seed.ts
    - apps/headhunter/wrangler.jsonc
    - apps/headhunter/wrangler.test.jsonc
    - apps/headhunter/package.json
    - apps/headhunter/tsconfig.json
    - apps/headhunter/vitest.config.ts
    - apps/headhunter/test/apply-migrations.ts
    - apps/headhunter/test/idempotent.test.ts
    - apps/headhunter/test/low-confidence.test.ts
    - apps/headhunter/test/urgency.test.ts
    - apps/headhunter/test/funnel.test.ts
  modified: []
decisions:
  - "fit_score null → window not filtered (unscored windows pass through; fit_floor only applies when score is explicitly known)"
  - "idempotencyKey company normalization: lowercase + remove spaces (preserves hyphens in cycle e.g. fall-2026)"
  - "runDeadlines does not re-emit P3 flag for low-confidence windows (full() handles that path)"
  - "D2-15 starter seed uses source:'seed' not 'historical' so it does NOT trigger the low-confidence P3 flag path"
  - "WorkerEntrypoint methods accept injected windows/funnelThreads for testability (no live board scan in v1)"
metrics:
  duration: "~10 minutes"
  completed: "2026-06-05T19:58:37Z"
  tasks: 2
  files_changed: 14
  commits: 3
---

# Phase 02 Plan 05: Headhunter Summary

**One-liner:** Headhunter Worker built — HeadhunterState DO + window state machine (D1) + decideWindow (low-confidence → P3 flag; urgency bypasses fit_floor) + single-emitter funnel increments + apply-by tasks via FORGE.createTask; all 24 tests green (idempotent GATING + low-confidence + urgency + funnel).

## What Was Built

### Task 1 — HeadhunterState DO + window state machine + D1 persistence

**TDD cycle:** RED (659bd4d) → GREEN (17fe295)

**`apps/headhunter/src/windows.ts`:**
- `WindowRow` / `JobRow` types mapping to D1 `windows`/`jobs` tables (0004 migration)
- `upsertWindow` / `upsertJob` — `INSERT OR REPLACE` with positional `?` only; UNIQUE `idx_jobs_fingerprint` on `(company, title_norm, cycle)` handles job dedup
- `fingerprint()` — djb2 hash of normalize(company)+normalize(title)+location+cycle
- `isUrgent()` — `closes_est` within `leadTimeDays` of today OR explicit `deadline` set
- `shouldFlagLowConfidence()` — `confidence < 0.4 AND source === "historical"`
- `decideWindow()` — the core branch: returns `null` (caller must flag P3) or `TaskDecision` (caller calls Forge)
- `buildScanSummaryEvent()` — `headhunter:scan:<date>` upsert Wire event
- `buildFunnelEvent()` — `headhunter:funnel:<thread>:<stage>` increment Wire event

**`apps/headhunter/src/state.ts`:**
- `class HeadhunterState extends DurableObject<Env>` with `advanceWindow(windowId, newStatus, lastSeenOpen?)`
- `blockConcurrencyWhile` with capture-inside / re-throw-after (exact StewardWriter pattern)
- Window state machine: `upcoming → open → closing → closed` (no backward transitions)
- `getWindowState()` read method (outside lock — reads don't need serialization)

**`apps/headhunter/src/seed.ts`:**
- 7-window D2-15 starter seed (Google, Meta, Amazon, Microsoft, Apple × fall-2026 new-grad + Google/Meta intern)
- `loadSeedIfEmpty()` — only inserts if `headhunter/tracked_companies` KV key is unset
- Seed source `"seed"` (not `"historical"`) → NOT routed to P3 flag

**Tests green (15/15):**
- **idempotent.test.ts** (GATING): same window twice → ONE row; same job twice → ONE row (UNIQUE fingerprint); `decideWindow` → stable `headhunter:window:<co>:<cycle>` key; scan summary shape
- **low-confidence.test.ts**: confidence < 0.4 + source "historical" → `decideWindow` returns null; board-source low-conf → task; `shouldFlagLowConfidence` predicate
- **urgency.test.ts**: inside lead_time with low fit → task (P1); explicit deadline → task; non-urgent + low fit → null; `isUrgent` predicate

### Task 2 — Headhunter full()/deadlines() + Forge tasks + funnel single-emitter + wrangler

**TDD cycle:** RED (funnel test written fresh) → GREEN (already satisfied by Task 1 implementation — valid since both task RED commit and the behavior were captured in one session)

**`apps/headhunter/src/index.ts`:**
- `export class Headhunter extends WorkerEntrypoint<Env>` with `full()` and `deadlines()`
- `runFull()`: loads seed if empty, reads open windows from D1, calls `decideWindow` per window, flags low-confidence windows (P3 `low_confidence_window`), emits apply-by tasks via `env.FORGE.createTask`, classifies funnel threads, emits funnel increments, emits scan summary, emits heartbeat
- `runDeadlines()`: promotes closing windows to `status: "closing"`, emits apply-by tasks, emits heartbeat
- `classifyFunnelStages()`: maps Filer `Job/OA`, `Job/Interview`, `Job/Offer`, `Job/Rejected`, `Job/Applied` labels → canonical funnel stages
- `default satisfies ExportedHandler<Env>` — static fetch route

**`apps/headhunter/wrangler.jsonc`:**
- `HEADHUNTER_STATE` DO binding + `new_sqlite_classes: ["HeadhunterState"]`
- WIRE + INCIDENTS producers (no consumers block)
- DB D1 + CONFIG KV + AI binding
- `services: [{ binding: "FORGE", service: "forge" }]` — the mandatory Forge RPC path
- NO own cron (Atlas drives via service binding, Plan 02-07)

**Tests green (24/24 — all four test files):**
- **funnel.test.ts**: `classifyFunnelStages` label mapping; one increment per (thread,stage); replay-safe idempotencyKeys; Wire contract (op:increment/entity:pipeline/agent:Headhunter); Forge idempotencyKey stable across re-scans; failure path (P2 `headhunter_forge_task_failed`); heartbeat (P4)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] fit_score null treated as 0 — filtered out non-urgent unscored windows**
- **Found during:** Task 1 GREEN — idempotent test `decideWindow` returned null for windows without fit_score
- **Issue:** `fitScore = window.fit_score ?? 0` caused null-scored windows to fail the `fitScore < fitFloor` check, suppressing tasks for windows that simply haven't been scored yet
- **Fix:** Changed to only apply fit_floor filter when `fit_score !== null && fit_score !== undefined`; null = not-yet-scored = pass through
- **Files modified:** `apps/headhunter/src/windows.ts`
- **Commit:** 17fe295

**2. [Rule 1 - Bug] normalize() stripped hyphens from cycle tag — wrong idempotencyKey**
- **Found during:** Task 1 GREEN — idempotent test expected `headhunter:window:google:fall-2026` but received `headhunter:window:google:fall2026`
- **Issue:** `normalize()` strips non-alphanumeric characters including hyphens; `fall-2026` → `fall2026` broke the expected key
- **Fix:** idempotencyKey construction uses `company.toLowerCase().replace(/\s+/g, "")` + `cycle.toLowerCase().replace(/\s+/g, "")` (preserves hyphens in cycle)
- **Files modified:** `apps/headhunter/src/windows.ts`
- **Commit:** 17fe295

**3. [Rule 2 - Missing] D2-15 seed source tag clarification**
- **Found during:** Task 1 — designing seed records
- **Issue:** If seed used `source: "historical"` and any record had `confidence < 0.4`, it would route to P3 flag on first run (undesirable for a starter seed)
- **Fix:** All seed records use `source: "seed"` (not `"historical"`) and `confidence: 0.55–0.65`; the low-confidence flag path only fires for explicitly-historical low-confidence observations
- **Files modified:** `apps/headhunter/src/seed.ts`
- **Commit:** 17fe295

## Known Stubs

- **Live board scanning not implemented (v1):** `runFull()` and `runDeadlines()` accept `windows` as an injected parameter; when called without it, they read from D1. There is no live RSS/HTTP board scraper in v1 (analogous to Scout's injectable sources pattern). The plan's `<action>` notes "boards" — this is deferred to go-live config (owner seeds the KV watchlist per D2-15, and a future plan adds live board scanning if needed). The seed + D1 read path is complete.
- **Forge RPC in `runDeadlines()`:** Uses a dynamic import for `isUrgent` (calls `await import("./windows.js")`). This works but is stylistically inconsistent with the top-level import in `runFull`. Does not affect correctness or test results.

## Threat Flags

No new network endpoints introduced. Headhunter is a pure Worker-to-Worker service binding consumer + Wire/INCIDENTS producer. All trust boundaries match the plan's declared threat model.

| Flag | File | Description |
|------|------|-------------|
| (none) | — | No new network surfaces beyond the declared FORGE service binding + Wire/INCIDENTS producers |

## Self-Check: PASSED

Files exist:
- FOUND: apps/headhunter/src/index.ts
- FOUND: apps/headhunter/src/windows.ts
- FOUND: apps/headhunter/src/state.ts
- FOUND: apps/headhunter/src/seed.ts
- FOUND: apps/headhunter/wrangler.jsonc
- FOUND: apps/headhunter/test/idempotent.test.ts
- FOUND: apps/headhunter/test/low-confidence.test.ts
- FOUND: apps/headhunter/test/urgency.test.ts
- FOUND: apps/headhunter/test/funnel.test.ts

Commits exist:
- 659bd4d: test(02-05): RED phase — failing tests for Task 1
- 17fe295: feat(02-05): GREEN — HeadhunterState DO + window state machine + D1 persistence
- 0cf2764: feat(02-05): Headhunter full()/deadlines() + Forge tasks + funnel + wrangler

Acceptance criteria verified:
- `grep -c "FORGE.createTask" apps/headhunter/src/index.ts` = 3 (≥1) ✓
- `grep -c "INTO tasks" apps/headhunter/src/index.ts` = 0 ✓
- `grep -c "INTO tasks" apps/headhunter/src/windows.ts` = 0 ✓
- `grep -rn "queues.consumers" apps/headhunter/wrangler.jsonc` → empty ✓
- `class HeadhunterState extends DurableObject<Env>` in state.ts ✓
- `blockConcurrencyWhile` with error capture inside gate ✓
- idempotencyKey format: `headhunter:window:<co>:<cycle>` ✓
- `pnpm --filter @atlas/headhunter test` = 24 passed ✓
- `pnpm test` full suite = 397 tests, 0 failures ✓
