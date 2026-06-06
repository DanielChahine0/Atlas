---
phase: 03-capture-local
plan: 01
subsystem: echo, archivist, migrations
tags: [scaffold, d1-migration, worker-shell, test-infra, wave-0-stubs]
dependency_graph:
  requires: []
  provides: [migrations/0006_meetings.sql, apps/echo, apps/archivist]
  affects: [pnpm-workspace, migrations]
tech_stack:
  added: []
  patterns:
    - D1 migration DDL (0004 convention: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS)
    - cloudflare:workers DurableObject<Env> + WorkflowEntrypoint<Env, Payload>
    - vitest-pool-workers cloudflareTest + readD1Migrations + applyD1Migrations inject pattern
    - satisfies ExportedHandler<Env> on every default export
key_files:
  created:
    - migrations/0006_meetings.sql
    - apps/echo/package.json
    - apps/echo/tsconfig.json
    - apps/echo/wrangler.jsonc
    - apps/echo/wrangler.test.jsonc
    - apps/echo/vitest.config.ts
    - apps/echo/src/env.ts
    - apps/echo/src/index.ts
    - apps/echo/test/apply-migrations.ts
    - apps/echo/test/echo-session.test.ts
    - apps/echo/test/presign.test.ts
    - apps/archivist/package.json
    - apps/archivist/tsconfig.json
    - apps/archivist/wrangler.jsonc
    - apps/archivist/wrangler.test.jsonc
    - apps/archivist/vitest.config.ts
    - apps/archivist/src/env.ts
    - apps/archivist/src/index.ts
    - apps/archivist/test/apply-migrations.ts
    - apps/archivist/test/archivist.test.ts
  modified:
    - pnpm-lock.yaml (new workspace packages)
decisions: []
metrics:
  duration: "~10 minutes"
  completed: "2026-06-06"
  tasks: 3
  files_created: 20
---

# Phase 3 Plan 1: Phase-3 Cloud Substrate Scaffold Summary

**One-liner:** D1 meetings transcript-index migration (0006) + apps/echo (EchoSession DO + producer-only queues) + apps/archivist (ArchivistWorkflow + FORGE RPC + Opus model tier) — both shells typecheck clean and run green skipped suites with Wave-0 named stubs closing all six 03-VALIDATION Wave-0 Gaps.

## What Was Built

### Task 1: D1 meetings migration (0006)
`migrations/0006_meetings.sql` following the 0004 header-comment convention. Defines the `meetings` table with `session_id TEXT PRIMARY KEY` ("echo-<ISO-timestamp>"), `consent` + `audio_disposition` columns (NOT NULL — no unknown state), `transcript_r2_key`, `audio_r2_key`, `started` (NOT NULL, epoch ms), `ended`, `archivist_run` (Workflow instance id), and `created_at`. Two indexes: `idx_meetings_consent ON meetings(consent)` and `idx_meetings_started ON meetings(started)`. No FK constraints (D1 does not enforce; app-layer only per 0004 convention). No named SQL params (positional `?` only). No DROP/DELETE statements. Idempotency: `INSERT OR REPLACE` on session_id PRIMARY KEY.

**Commit:** 74aa9e8

### Task 2: apps/echo package shell + Wave-0 stubs
`@atlas/echo` package shell with:
- `wrangler.jsonc`: EchoSession DO (`new_sqlite_classes`), WIRE + INCIDENTS producers (NO consumers — Pillar 1), DB/CONFIG/BLOBS/AI/secrets_store_secrets for R2 presign credentials
- `wrangler.test.jsonc`: stripped to DO + queue producers + D1 + CONFIG only (no r2/ai — avoids remote proxy mode in workerd test pool)
- `vitest.config.ts` + `test/apply-migrations.ts`: copied verbatim from headhunter
- `src/env.ts`: full Env type with EchoSession, WIRE, INCIDENTS, DB, CONFIG, BLOBS, AI, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID
- `src/index.ts`: EchoSession DO stub (setWebSocketAutoResponse ping/pong) + Echo WorkerEntrypoint + default fetch handler (satisfies ExportedHandler<Env>)
- `test/echo-session.test.ts`: Wave-0 stubs for CAPTURE-01-a (echo-session), CAPTURE-01-b (reconnect), CAPTURE-01-c (wire-contract), CAPTURE-01-d (replay)
- `test/presign.test.ts`: Wave-0 stub for CAPTURE-01-i (presign)

Typecheck: clean. Tests: 7 skipped (green).

**Commit:** c75b681

### Task 3: apps/archivist package shell + Wave-0 stub
`@atlas/archivist` package shell with:
- `wrangler.jsonc`: atlas-archivist Workflow (ARCHIVIST_WF / ArchivistWorkflow), empty new_sqlite_classes (required alongside workflows), WIRE + INCIDENTS producers (NO consumers — Pillar 1), DB/CONFIG/BLOBS/AI + FORGE service binding, `MODEL_ARCHIVIST = "claude-opus-4-8"` in [vars] (D5: never hardcoded in code)
- `wrangler.test.jsonc`: stripped to queue producers + D1 + CONFIG + vars only (no r2/ai/services)
- `vitest.config.ts` + `test/apply-migrations.ts`: copied verbatim from headhunter
- `src/env.ts`: ArchivistEnv with ARCHIVIST_WF, WIRE, INCIDENTS, DB, CONFIG, BLOBS, AI, FORGE (Fetcher), AIG_ACCOUNT_ID, AIG_GATEWAY_ID, MODEL_ARCHIVIST
- `src/index.ts`: ArchivistWorkflow stub (WorkflowEntrypoint<ArchivistEnv, ArchivistPayload>) + default fetch handler (satisfies ExportedHandler<ArchivistEnv>)
- `test/archivist.test.ts`: Wave-0 stubs for CAPTURE-01-e (effort-set), CAPTURE-01-f (wire-contract), CAPTURE-01-g (idempotent), CAPTURE-01-h (consent-discarded), CAPTURE-01-j (failure-path)

Typecheck: clean. Tests: 6 skipped (green).

**Commit:** 2603c8a

## Verification Results

- `pnpm -r typecheck`: passes (all packages including new echo + archivist shells)
- `pnpm test`: full suite green — 315+ existing tests unchanged; echo (7 skipped), archivist (6 skipped)
- `grep -c '"consumers"' apps/echo/wrangler.jsonc apps/archivist/wrangler.jsonc`: returns 0 for both (Pillar 1 preserved)
- `sqlite3 :memory: < migrations/0006_meetings.sql`: applies cleanly (no errors)
- Wave-0 Gaps closed: 2 vitest configs, 3 test files, 1 migration = all six gaps from 03-VALIDATION Wave-0

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed r2_buckets + ai bindings from wrangler.test.jsonc**
- **Found during:** Task 2 (echo test run)
- **Issue:** Including `r2_buckets` and `ai` in wrangler.test.jsonc triggered wrangler's "remote proxy session" connection to Cloudflare (R2 and AI Workers require a real CF account in remote mode). This broke the local workerd test pool.
- **Fix:** Removed `r2_buckets`, `ai`, and the R2_* vars from `apps/echo/wrangler.test.jsonc`. Applied the same stripped approach to `apps/archivist/wrangler.test.jsonc`. The stub tests don't exercise BLOBS or AI bindings, so the test pool works correctly with only DO + queues + D1 + KV declared.
- **Files modified:** `apps/echo/wrangler.test.jsonc`, `apps/archivist/wrangler.test.jsonc`
- **Commit:** Included in c75b681 / 2603c8a

## Known Stubs

The following stubs exist intentionally — they are Wave-0 scaffolds whose implementations land in downstream plans:

| Stub | File | Line | Reason |
|------|------|------|--------|
| EchoSession.fetch() returns 503 | `apps/echo/src/index.ts` | ~49 | WebSocket Hibernation implementation in 03-02 |
| Echo WorkerEntrypoint (no methods) | `apps/echo/src/index.ts` | ~57 | RPC methods (finalize) in 03-02 |
| /echo/presign returns 503 | `apps/echo/src/index.ts` | ~67 | Presign endpoint in 03-03 |
| ArchivistWorkflow.run() is no-op | `apps/archivist/src/index.ts` | ~49 | Full Workflow orchestration in 03-04 |
| All echo-session.test.ts tests | `apps/echo/test/echo-session.test.ts` | all | Implementation in 03-02 |
| All presign.test.ts tests | `apps/echo/test/presign.test.ts` | all | Implementation in 03-03 |
| All archivist.test.ts tests | `apps/archivist/test/archivist.test.ts` | all | Implementation in 03-04 |

All stubs are `it.skip` — they show as "skipped" (not "failed") in vitest output. The Wave-0 goal is naming compliance with 03-VALIDATION.md filter commands, not implementation.

## Threat Flags

No new threat surface introduced — this plan creates configuration files and minimal stub Worker code with no live network endpoints, no R2 access, no authentication paths, and no schema changes beyond the DDL-only migration. The EchoSession stub returns 503; the presign endpoint returns 503. No new security-relevant surface beyond what the threat register already covers (T-03-01-01 through T-03-01-SC).

## Self-Check: PASSED

- migrations/0006_meetings.sql: FOUND
- apps/echo/package.json: FOUND
- apps/echo/wrangler.jsonc: FOUND (no consumers)
- apps/echo/vitest.config.ts: FOUND
- apps/echo/test/echo-session.test.ts: FOUND (echo-session / reconnect / wire-contract / replay)
- apps/echo/test/presign.test.ts: FOUND (presign)
- apps/archivist/package.json: FOUND
- apps/archivist/wrangler.jsonc: FOUND (atlas-archivist, no consumers)
- apps/archivist/vitest.config.ts: FOUND
- apps/archivist/test/archivist.test.ts: FOUND (effort-set / wire-contract / idempotent / consent-discarded / failure-path)
- Commits 74aa9e8, c75b681, 2603c8a: all present in git log
