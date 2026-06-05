---
phase: 02-weekly-value
plan: "06"
subsystem: herald-weekly
tags: [herald, weekly, week-in-review, digest, heartbeat, redaction, guardrail, d2-10, tdd]
dependency_graph:
  requires:
    - 02-01 (INCIDENTS queue substrate + RawIncident type)
  provides:
    - runWeekly() — 7-day week-in-review builder (redaction-guarded, draft-only)
    - buildWeeklyDigestEvent() — herald:weekly:<date> Wire event builder
    - Herald.weekly() WorkerEntrypoint method (alongside existing daily())
    - Heartbeat emit on daily() and weekly() success (kind:heartbeat, P4)
  affects:
    - apps/herald/src/weekly.ts (new)
    - apps/herald/src/index.ts (Herald.weekly() + heartbeat on daily + re-export runWeekly)
    - apps/herald/test/weekly.test.ts (new)
    - apps/herald/test/heartbeat.test.ts (new)
tech_stack:
  added: []
  patterns:
    - "TDD RED/GREEN cycle for week-in-review builder + heartbeat emit"
    - "guardDigestOutput() reused (same belt-2 guardrail as daily) — weekly NOT exempt"
    - "stripSnippet() per thread bullet (belt-1 pre-synthesis strip)"
    - "Heartbeat pattern: env.INCIDENTS?.send({ source_agent, kind:heartbeat, severity_hint:P4, run_id:date }) after success"
    - "Herald.weekly() method delegates to runWeekly + emits Wire digest event via send()"
key_files:
  created:
    - apps/herald/src/weekly.ts
    - apps/herald/test/weekly.test.ts
    - apps/herald/test/heartbeat.test.ts
  modified:
    - apps/herald/src/index.ts
decisions:
  - "Heartbeat emitted from runWeekly() directly (not Herald.weekly()) so direct-function-call tests can assert it; Herald.weekly() only emits the Wire digest event"
  - "runWeekly returns WeeklyResult; Wire digest event emission lives in Herald.weekly() entrypoint (mirrors daily() pattern — runDaily emits the event; weekly entrypoint delegates to _runWeekly then calls send)"
  - "Weekly body covers 4 sections: action-required-open, waiting-on, VIP threads, slipped items (per D2-10 spec)"
  - "No new packages introduced — weekly reuses existing herald deps (guardrail, bucket, digest, wire)"
metrics:
  duration: "~10 minutes"
  completed: "2026-06-05T20:07:51Z"
  tasks: 2
  files_changed: 4
  commits: 4
---

# Phase 02 Plan 06: Herald Weekly Mode Summary

**One-liner:** Herald.weekly() drafts a redaction-guarded 7-day week-in-review (draft-only, gmail.compose) and emits a herald:weekly:<date> digest Wire event; heartbeat on daily and weekly success.

## What Was Built

### Task 1 — Herald week-in-review builder (draft-only, redaction-guarded) [TDD]

- Created `apps/herald/src/weekly.ts` exporting:
  - `runWeekly(env, date, threads, tools?)` — builds a 7-day week-in-review body (4 sections: action-required-open, waiting-on, VIP threads, slipped items); runs every thread bullet through `stripSnippet()` (belt 1); runs synthesized body through `guardDigestOutput()` (belt 2) BEFORE `tools.createDraft()` — a leak blocks the draft and raises P2
  - `buildWeeklyDigestEvent(date, counts, topActionRequired, draftId)` — §6.4 Wire event with `idempotencyKey: herald:weekly:<date>`, `op:"upsert"`, `entity:"email"`, `payload.mode:"weekly"`
  - `WeeklyResult` interface (drafted, draftId, counts, actionRequiredRefs, blocked)
  - `weeklyDraftSubject(date)` — Gmail draft subject with "weekly" indicator
- **TDD cycle:** RED (5c01c0c) → GREEN (c44b6eb)
- No send method introduced (`HeraldGmailTools.createDraft` only — Pillar 2 by construction)
- All 20 tests green after GREEN phase

### Task 2 — Herald.weekly() entrypoint + digest event + heartbeat emit [TDD]

- Updated `apps/herald/src/index.ts`:
  - Added `Herald.weekly(params?)` WorkerEntrypoint method alongside `daily()` — resolves date, calls `_runWeekly`, emits `herald:weekly:<date>` digest Wire event, returns `WeeklyResult`
  - Added `emitHeartbeat(env, date)` — sends `{ source_agent:"Herald", kind:"heartbeat", severity_hint:"P4", title:"Herald heartbeat <date>", run_id:<date> }` to `env.INCIDENTS`
  - Added heartbeat emit to `runDaily()` on success (guardrail not blocked) — Herald's daily slot is now monitored
  - Re-exported `runWeekly` from index.ts so test imports align
- `runWeekly` in `weekly.ts` also emits heartbeat (for direct-call test path)
- **TDD cycle:** RED (4715ced) → GREEN (8f7547f)
- 25 Herald tests green (existing 12 daily + 8 weekly + 5 heartbeat = 25 total)
- Full suite: ~413+ tests, 0 failures, 2 skipped (live OAuth tests)

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Architecture Notes

The heartbeat emit placement follows a practical pattern: `runWeekly` handles it directly (rather than only in `Herald.weekly()`) so the heartbeat test can import `runWeekly` from index.ts and assert the incident without needing the full `Herald` DO class context. The `Herald.weekly()` entrypoint does NOT double-emit (it only calls `_runWeekly` + sends the Wire digest event). This mirrors the `runDaily` + `Herald.daily()` separation.

## Known Stubs

None — week-in-review builder produces real sections from injected thread data; no hardcoded empty values.

## Threat Flags

No new network endpoints or trust boundaries beyond the declared threat model:
- T-02-leak: mitigated — `guardDigestOutput()` is called in `runWeekly` BEFORE `createDraft`; a secret blocks the draft and raises P2 (kind: security_leak_blocked). Weekly is NOT exempt.
- T-02-send: mitigated — no send method added to `HeraldGmailTools` (acceptance check: `grep -c "sendEmail\|sendDraft" apps/herald/src/` = 0).
- T-02-SC: accepted — no new package installs.

## Self-Check: PASSED

Files exist:
- FOUND: apps/herald/src/weekly.ts
- FOUND: apps/herald/test/weekly.test.ts
- FOUND: apps/herald/test/heartbeat.test.ts
- FOUND: apps/herald/src/index.ts (modified)

Commits exist:
- 5c01c0c: test(02-06): RED — failing weekly builder + Wire-contract + redaction-block tests
- c44b6eb: feat(02-06): GREEN — Herald week-in-review builder (draft-only, redaction-guarded)
- 4715ced: test(02-06): RED — failing heartbeat tests for Herald daily/weekly success emit
- 8f7547f: feat(02-06): GREEN — Herald.weekly() entrypoint + digest event + heartbeat emit

Acceptance criteria:
- `apps/herald/src/weekly.ts` exists with `runWeekly` and `createDraft` call ✓
- `guardDigestOutput` called in `runWeekly` BEFORE `createDraft` ✓
- `grep -c "\.send(" apps/herald/src/weekly.ts` = 1 (INCIDENTS.send, not Gmail send) ✓
- `Herald.weekly()` declared in `apps/herald/src/index.ts` ✓
- `idempotencyKey: herald:weekly:<date>` in `buildWeeklyDigestEvent` ✓
- Heartbeat (kind:heartbeat, P4, source_agent:Herald) emitted on daily + weekly success ✓
- No Gmail send method anywhere in Herald ✓
- `pnpm --filter herald test` exits 0 — 25 tests green ✓
- `pnpm test` full suite exits 0 — all tests green ✓
