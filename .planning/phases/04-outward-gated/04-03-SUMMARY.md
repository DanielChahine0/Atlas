---
phase: 04-outward-gated
plan: "03"
subsystem: gate
tags: [gate, worker, confirm-page, browser-action, scheduled, fail-closed, d1, security, pillar2]
dependency_graph:
  requires:
    - phase: 04-01
      provides: packages/gate — openGate/getGate/decideGate/sweepExpired/renderConfirmPage/timingSafeEqual/sha256
  provides:
    - apps/gate Worker — fetch (GET/POST /confirm, /browser/poll, /browser/ack) + scheduled (sweepExpired)
  affects: [apps/usher (04-06), apps/envoy (04-07), apps/sundial (04-05), daemon browser-drain (04-04)]
tech_stack:
  added: ["@atlas/gate-worker package (apps/gate — Worker)"]
  patterns:
    - fail-closed POST /confirm — decideGate commits BEFORE any re-invoke; error → 500 + "no action taken"
    - constant-time Bearer auth on /browser/poll + /browser/ack (GATE_CONFIRM_TOKEN Secrets Store)
    - service-binding re-invoke after atomic decision commit (Usher/Envoy/Sundial)
    - sweepExpired cron (hourly) — gates transition to expired with P3 flag; no action taken
    - satisfies ExportedHandler<Env>; no queues.consumers (Pillar 1)
key_files:
  created:
    - apps/gate/package.json
    - apps/gate/tsconfig.json
    - apps/gate/wrangler.jsonc
    - apps/gate/wrangler.test.jsonc
    - apps/gate/vitest.config.ts
    - apps/gate/test/apply-migrations.ts
    - apps/gate/src/index.ts
    - apps/gate/src/index.test.ts
  modified: []
key_decisions:
  - "SELF.scheduled() API rejects ExecutionContext in vitest-pool-workers — use direct handler import + fake ScheduledController (same pattern as flagger self-tick tests)"
  - "reinvokeAgent returns false on binding-absent (P2 flag) but does NOT roll back decideGate — gate decision (status=approved) is permanent; the re-invoke is a best-effort side effect"
  - "NTFY_TOPIC/NTFY_TOKEN intentionally absent from wrangler.jsonc — push SEND lives in openGate on the AGENTS; apps/gate is the recipient side only"
requirements-completed: [OUTWARD-01, OUTWARD-02]
duration: "~30 minutes"
completed: "2026-06-08"
---

# Phase 4 Plan 03: apps/gate Worker Summary

**`apps/gate` Worker — fail-closed token-gated confirm page (GET/POST /confirm), Bearer-gated browser-action transport (/browser/poll+/ack), and hourly expiry-sweep scheduled() — 22 workerd tests green.**

## Performance

- **Duration:** ~30 minutes
- **Started:** 2026-06-08
- **Completed:** 2026-06-08
- **Tasks:** 2 (Task 1: scaffold + config; Task 2: implementation — TDD)
- **Files created:** 8

## Accomplishments

- `apps/gate` Worker fully scaffolded: `package.json` (@atlas/gate-worker, no name collision with @atlas/gate library), `tsconfig.json`, `wrangler.jsonc` with all bindings (DB/WIRE/INCIDENTS/CONFIG/GATE_CONFIRM_TOKEN secret/GATE_BASE_URL/USHER+ENVOY+SUNDIAL service bindings), hourly sweep cron, staging-no-crons, zero `queues.consumers` (Pillar 1 preserved).
- `src/index.ts` implements the full confirm-page lifecycle: GET /confirm (sha256 token lookup → renderConfirmPage or 410 renderExpiredPage), POST /confirm (isSameOrigin 403 guard → validate decision {approve,reject} → decideGate atomic commit FIRST → reinvokeAgent via service binding → renderOutcomePage).
- `/browser/poll` and `/browser/ack` behind constant-time Bearer check against `GATE_CONFIRM_TOKEN`; /poll claims pending rows with AND status='pending' lease guard; /ack idempotent with AND status='claimed'.
- `scheduled()` calls `sweepExpired(env)` — gates past expires_at transition to 'expired' with terminal audit row + P3 flag.
- 22 workerd tests covering all --grep groups: confirm-get, expire, confirm-post, fail-closed, browser.

## Task Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 (scaffold) | `6db1ade` | chore(04-03): apps/gate scaffold — wrangler.jsonc, package.json, tsconfig, vitest harness |
| Task 2 (RED) | `f52c250` | test(04-03): add failing tests for apps/gate Worker (RED) |
| Task 2 (GREEN) | `2fbc32b` | feat(04-03): apps/gate Worker — fetch /confirm + /browser poll/ack + scheduled sweep |

## Test Results

```
 Test Files  1 passed (1)
      Tests  22 passed (22)
   Duration  772ms (workerd)
```

- `index.test.ts` (22 tests): confirm-get (5), expire (1), confirm-post (6), fail-closed (3), browser (7)

Full suite (all apps + packages): 553+ tests pass, 0 fail.

Typecheck: `pnpm --filter @atlas/gate-worker typecheck` → clean (no errors).

## Files Created

- `apps/gate/package.json` — @atlas/gate-worker; deps: @atlas/gate, @atlas/shared, @atlas/wire
- `apps/gate/tsconfig.json` — extends tsconfig.base.json; workers-types + vitest-pool-workers types
- `apps/gate/wrangler.jsonc` — $schema, compat 2026-04-25, nodejs_compat; DB/WIRE/INCIDENTS/CONFIG/GATE_CONFIRM_TOKEN/GATE_BASE_URL; USHER/ENVOY/SUNDIAL service bindings; hourly cron; no consumers
- `apps/gate/wrangler.test.jsonc` — test-only config (local D1 only)
- `apps/gate/vitest.config.ts` — cloudflareTest, readD1Migrations (all 0001-0007)
- `apps/gate/test/apply-migrations.ts` — beforeAll applyD1Migrations pattern
- `apps/gate/src/index.ts` — Worker implementation (satisfies ExportedHandler<Env>)
- `apps/gate/src/index.test.ts` — 22-test workerd suite

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] SELF.scheduled() API incompatible with ExecutionContext in vitest-pool-workers**
- **Found during:** Task 2 (TDD GREEN iteration)
- **Issue:** `await SELF.scheduled({ cron, scheduledTime }, ctx)` threw `DataCloneError: Could not serialize object of type "ExecutionContext"`. The SELF.scheduled() API in this version of vitest-pool-workers does not accept an ExecutionContext as the second argument.
- **Fix:** Switched to direct handler import (`import gateWorker from "./index.js"`) and called `gateWorker.scheduled(fakeController, testEnv)` directly — identical to the pattern used in `apps/flagger/test/self-tick.test.ts`. The real D1 from `cloudflare:test` `env` is still used, so the sweep actually runs against the test DB.
- **Files modified:** `apps/gate/src/index.test.ts`
- **Verification:** `expire` test group passes; DB state verified before/after sweep.
- **Committed in:** `2fbc32b`

---

**Total deviations:** 1 auto-fixed (Rule 1 — Bug)
**Impact on plan:** No scope change. The test still exercises the real scheduled() handler against a real D1 — only the invocation mechanism changed to match the established project pattern.

## Security Verification

- No NTFY_TOPIC/NTFY_TOKEN in wrangler.jsonc (grep returns no match — intentionally absent; push send is on the AGENTS).
- No `queues.consumers` block on atlas-wire in apps/gate (guard-wire-consumer.js passes).
- Bearer auth on /browser/poll and /browser/ack uses `timingSafeEqual` (HMAC-SHA-256, constant-time) from @atlas/gate/auth — fail-closed if GATE_CONFIRM_TOKEN binding is unseeded.
- POST /confirm is CSRF-guarded via `isSameOrigin()` from @atlas/gate/render — fail-closed on missing Origin header.
- decideGate commits to D1 BEFORE any service-binding re-invoke (T-04-11 satisfied).
- renderConfirmPage applies `redact()` to artifact content before interpolation (T-04-16).

## Known Stubs

None. The Worker is fully implemented. Service binding stubs (USHER/ENVOY/SUNDIAL absent in test env) are handled by fail-safe P2 flagging — not silent success. The actual Usher/Envoy/Sundial entrypoints are built in 04-05, 04-06, 04-07.

## Threat Flags

No new security-relevant surface beyond the plan's threat model. All T-04-11 through T-04-17 mitigations implemented and test-covered.

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `apps/gate/src/index.ts` exists | FOUND |
| `apps/gate/src/index.test.ts` exists | FOUND |
| `apps/gate/wrangler.jsonc` exists | FOUND |
| `04-03-SUMMARY.md` exists | FOUND |
| commit 6db1ade (Task 1 scaffold) exists | FOUND |
| commit f52c250 (Task 2 RED) exists | FOUND |
| commit 2fbc32b (Task 2 GREEN) exists | FOUND |
| `satisfies ExportedHandler` in index.ts | PASS (grep count = 1) |
| `decideGate` present in index.ts | PASS |
| No `queues.consumers` for atlas-wire in apps/gate | PASS |
| No NTFY_TOPIC/NTFY_TOKEN in wrangler.jsonc | PASS |
| `pnpm --filter @atlas/gate-worker test` | 22/22 PASS |
| `pnpm --filter @atlas/gate-worker typecheck` | PASS |
