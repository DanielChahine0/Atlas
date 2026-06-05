---
phase: 02-weekly-value
plan: "01"
subsystem: shared-incident-substrate
tags: [flag, incidents, rawincident, migration, d2-05, d2-04]
dependency_graph:
  requires: []
  provides:
    - RawIncident type + zod schema (packages/shared)
    - flag() reworked to target atlas-incidents queue
    - INCIDENTS producer binding on every Phase-0/1 Worker
    - D1 migration 0004 (events/windows/jobs/flags tables)
  affects:
    - apps/atlas
    - apps/steward
    - apps/herald
    - apps/forge
    - apps/sundial
    - apps/compass
    - apps/filer
    - apps/dlq-sink
    - packages/model
    - packages/shared
tech_stack:
  added:
    - "RawIncident zod schema (packages/shared/src/incident.ts)"
    - "atlas-incidents queue topology (D2-04 — producers in all Phase-0/1 wrangler.jsonc)"
  patterns:
    - "fire-and-forget RawIncident enqueue (env.INCIDENTS.send) — replaces WireEvent flag emit"
    - "Omit<SharedEnv, 'INCIDENTS'> + required INCIDENTS redeclaration pattern for per-Worker Env"
key_files:
  created:
    - packages/shared/src/incident.ts
    - migrations/0004_incidents_flagger.sql
  modified:
    - packages/shared/src/flag.ts
    - packages/shared/src/env.ts
    - packages/shared/src/index.ts
    - packages/shared/test/flag.test.ts
    - apps/atlas/src/coordinator.ts
    - apps/atlas/src/env.ts
    - apps/atlas/src/index.ts
    - apps/atlas/src/morning-chain.ts
    - apps/atlas/wrangler.jsonc
    - apps/atlas/wrangler.test.jsonc
    - apps/atlas/test/halt.test.ts
    - apps/atlas/test/heartbeat.test.ts
    - apps/atlas/test/scheduled.test.ts
    - apps/steward/src/steward-consumer.ts
    - apps/steward/wrangler.jsonc
    - apps/steward/wrangler.test.jsonc
    - apps/steward/test/malformed.test.ts
    - apps/herald/src/guardrail.ts
    - apps/herald/src/index.ts
    - apps/herald/wrangler.jsonc
    - apps/herald/wrangler.test.jsonc
    - apps/forge/src/index.ts
    - apps/forge/wrangler.jsonc
    - apps/forge/wrangler.test.jsonc
    - apps/sundial/src/index.ts
    - apps/sundial/src/reconcile.ts
    - apps/sundial/wrangler.jsonc
    - apps/sundial/wrangler.test.jsonc
    - apps/compass/src/index.ts
    - apps/compass/wrangler.jsonc
    - apps/compass/wrangler.test.jsonc
    - apps/filer/src/index.ts
    - apps/filer/wrangler.jsonc
    - apps/filer/wrangler.test.jsonc
    - apps/dlq-sink/src/index.ts
    - apps/dlq-sink/wrangler.jsonc
    - apps/dlq-sink/wrangler.test.jsonc
    - apps/dlq-sink/test/dlq.test.ts
    - packages/model/src/claude.ts
    - packages/model/test/claude.test.ts
decisions:
  - "flag() now enqueues a RawIncident to atlas-incidents (env.INCIDENTS.send) — never emits a WireEvent to atlas-wire"
  - "SharedEnv.INCIDENTS is optional (INCIDENTS?) for backward compat; per-Worker local Env redeclares it required via Omit pattern"
  - "coordinator.ts uses AtlasEnv (not SharedEnv) so DurableObject<AtlasEnv> gets required INCIDENTS"
  - "FlagRecord, contentHash, DEFAULT_TRUST, localDate kept exported from @atlas/shared for Flagger (02-02) reuse"
  - "dlq-sink test fixed to query WHERE action=? AND agent=? to avoid cross-test row collision in shared D1"
  - "0004 migration adds events/windows/jobs/flags tables; FlaggerState DO SQLite holds live flag state; D1 flags table is audit trail"
metrics:
  duration: "~2 hours (continuation session)"
  completed: "2026-06-05T19:00:38Z"
  tasks: 3
  files_changed: 42
  commits: 4
---

# Phase 02 Plan 01: Incident Substrate Rework Summary

**One-liner:** RawIncident schema + atlas-incidents queue topology introduced; flag() reworked to enqueue to INCIDENTS; all 17 call sites migrated with kind tags; 0004 D1 migration adds events/windows/jobs/flags tables.

## What Was Built

### Task 1 — RawIncident schema + reworked flag()
- Created `packages/shared/src/incident.ts` with `RawIncidentSchema` (zod) and `RawIncident` type
- Reworked `flag()` in `packages/shared/src/flag.ts`: env param changed from `{ WIRE: Queue<WireEvent> }` to `{ INCIDENTS: Queue<RawIncident> }`; builds a RawIncident and calls `env.INCIDENTS.send(incident)`
- Added `INCIDENTS?: Queue<RawIncident>` (optional) to `SharedEnv` in `packages/shared/src/env.ts`
- Re-exported `RawIncident`, `RawIncidentSchema`, `DEFAULT_TRUST`, `contentHash` from `packages/shared/src/index.ts`
- Rewrote `packages/shared/test/flag.test.ts` to assert RawIncident shape on INCIDENTS (4 tests)
- **TDD cycle:** RED commit (c5bddab) → GREEN commit (09f381f)

### Task 2 — Migrate all ~17 flag() call sites + INCIDENTS producers
- Migrated all call sites with kind tags:
  - `apps/steward` (3 calls): `malformed_event`, `steward_nonretryable`, `steward_write_fail`
  - `apps/atlas` (3 calls): `heartbeat_stale`, `chain_halted`, `workflow_create_failed`
  - `apps/herald` (1 call): `security_leak_blocked`
  - `apps/forge` (1 call): `phishing_skipped`
  - `apps/sundial` (2 calls): `calendar_sync_failed`
  - `apps/compass` (1 call): `overcommit`
  - `apps/filer` (1 call): `watch_renewal_due`
  - `apps/dlq-sink` (1 call): `dlq_dead_letter`
  - `packages/model` (2 functions): `model_error` (flagBadModelId + flagGatewayError)
- Added `{ "binding": "INCIDENTS", "queue": "atlas-incidents" }` producer to 8 wrangler.jsonc + wrangler.test.jsonc files
- Updated all test suites to spy on INCIDENTS.send instead of WIRE.send for flag assertions
- Fixed coordinator.ts to use AtlasEnv (required INCIDENTS) instead of SharedEnv (optional)

### Task 3 — D1 migration 0004
Created `migrations/0004_incidents_flagger.sql` with 4 tables:
- `events` — Scout/Usher event discovery + registration lifecycle
- `windows` — Headhunter hiring-cycle windows (per company + role class)
- `jobs` — Headhunter individual job postings (UNIQUE idx_jobs_fingerprint on company/title_norm/cycle)
- `flags` — Flagger resolved flag audit trail
Plus 9 indexes (2 events, 2 windows, 3 jobs, 2 flags additional).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] coordinator.ts using SharedEnv (optional INCIDENTS) instead of AtlasEnv (required INCIDENTS)**
- **Found during:** Task 2 — typecheck after migrating call sites
- **Issue:** `apps/atlas/src/coordinator.ts` imported `Env` from `@atlas/shared` (which has `INCIDENTS?` optional) instead of `AtlasEnv` from `./env.js` (which has `INCIDENTS` required). Caused `TS2345` during typecheck.
- **Fix:** Changed import from `import type { Env } from "@atlas/shared"` to `import type { AtlasEnv } from "./env.js"` and `DurableObject<Env>` to `DurableObject<AtlasEnv>`
- **Files modified:** `apps/atlas/src/coordinator.ts`
- **Commit:** b799454

**2. [Rule 1 - Bug] dlq-sink test cross-test D1 row collision**
- **Found during:** Task 2 — running full test suite
- **Issue:** Both dlq-sink tests insert rows with `action='dlq.dead_letter'`. The second test's query `WHERE action = ?` returned the FIRST test's row (agent='Forge'), causing the `expect(row?.agent).toBe("unknown")` assertion to fail.
- **Fix:** Changed the second test's query to `WHERE action = ? AND agent = ?` with binding `'unknown'` to uniquely target the malformed event row.
- **Files modified:** `apps/dlq-sink/test/dlq.test.ts`
- **Commit:** b799454

**3. [Rule 1 - Bug] Atlas/halt/heartbeat/scheduled tests asserting WIRE.send for flags**
- **Found during:** Task 2 — running full test suite after call site migration
- **Issue:** `apps/atlas/test/heartbeat.test.ts`, `halt.test.ts`, and `scheduled.test.ts` spied on `WIRE.send` to assert Flagger events, but flag() now sends to `INCIDENTS.send`.
- **Fix:** Updated all three test files to spy on `INCIDENTS.send` and assert on `RawIncident` fields (severity_hint, kind, source_agent, title) instead of WireEvent fields (op, entity, payload.severity, idempotencyKey).
- **Files modified:** `apps/atlas/test/heartbeat.test.ts`, `halt.test.ts`, `scheduled.test.ts`
- **Commit:** b799454

**4. [Rule 1 - Bug] packages/model test asserting WIRE.send for model error flags**
- **Found during:** Task 2 — full test suite
- **Issue:** `packages/model/test/claude.test.ts` makeEnv() returned a WIRE.send spy, but flagBadModelId/flagGatewayError use INCIDENTS now.
- **Fix:** Updated makeEnv() to spy on `INCIDENTS.send`, added `incidents` array to capture RawIncidents, updated all assertions to check `incidents[0].severity_hint`, `kind`, `source_agent`, `title` instead of WireEvent fields.
- **Files modified:** `packages/model/test/claude.test.ts`
- **Commit:** b799454

## Known Stubs

None — plan fully wired. No placeholder data or mock responses reach user-visible output.

## Threat Flags

No new network endpoints, auth paths, or trust-boundary schema changes introduced beyond the plan's declared threat model (T-02-01 through T-02-SC). The atlas-incidents queue is internal (no external producer). The 0004 migration is additive DDL only.

## Self-Check: PASSED

Files exist:
- FOUND: packages/shared/src/incident.ts
- FOUND: migrations/0004_incidents_flagger.sql
- FOUND: packages/shared/src/flag.ts

Commits exist:
- c5bddab: test(02-01): RED phase — failing flag tests
- 09f381f: feat(02-01): GREEN — RawIncident schema + reworked flag()
- b799454: feat(02-01): migrate all flag() call sites + INCIDENTS wrangler bindings
- 5a5e7c4: feat(02-01): add D1 migration 0004 — events, windows, jobs, flags tables

Acceptance criteria:
- `grep -c "INCIDENTS.send" packages/shared/src/flag.ts` = 1 ✓
- `grep -c "env.WIRE" packages/shared/src/flag.ts` = 0 ✓
- `grep -rl "atlas-incidents" apps/*/wrangler.jsonc | wc -l` = 8 ✓
- No atlas-incidents consumer anywhere ✓
- atlas-wire consumer only in apps/steward ✓
- `pnpm -r typecheck` exits 0 ✓
- `pnpm test` exits 0, 314 passed + 2 skipped (≥315 total) ✓
- `grep -c "CREATE TABLE IF NOT EXISTS" migrations/0004_incidents_flagger.sql` = 4 ✓
- `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_fingerprint` present ✓
