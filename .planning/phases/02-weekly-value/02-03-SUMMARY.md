---
phase: 02-weekly-value
plan: "03"
subsystem: watchdog-heartbeat
tags: [watchdog, heartbeat, flagger, d2-08, d2-07, pillar1, weekly-02]
dependency_graph:
  requires:
    - RawIncident + flag() reworked (Plan 02-01)
    - FlaggerState DO with alarm scheduler (Plan 02-02)
    - INCIDENTS producer binding on all Phase-0/1 workers (Plan 02-01)
  provides:
    - apps/flagger-watchdog Worker (single-cron, direct atlas-wire self-P1 on Flagger silence)
    - kind:heartbeat emit at end of successful Filer/Forge/Sundial/Compass runs
    - Kill test (GATING criterion for Phase 3)
  affects:
    - apps/flagger-watchdog (new)
    - apps/filer
    - apps/forge
    - apps/sundial
    - apps/compass
tech_stack:
  added:
    - "apps/flagger-watchdog workspace package (separate Cron Worker, producer-only)"
  patterns:
    - "Fail-toward-alerting: absent flagger:last_seen → age = Date.now() → always stale"
    - "Watchdog bypasses atlas-incidents (Flagger may be dead) → send() directly to atlas-wire"
    - "Optional-chaining heartbeat: env.INCIDENTS?.send — absent binding never throws"
    - "WorkerEntrypoint constructor order: (ctx: ExecutionContext, env: Env)"
key_files:
  created:
    - apps/flagger-watchdog/src/index.ts
    - apps/flagger-watchdog/wrangler.jsonc
    - apps/flagger-watchdog/wrangler.test.jsonc
    - apps/flagger-watchdog/vitest.config.ts
    - apps/flagger-watchdog/package.json
    - apps/flagger-watchdog/tsconfig.json
    - apps/flagger-watchdog/test/kill.test.ts
    - apps/filer/test/heartbeat.test.ts
    - apps/forge/test/heartbeat.test.ts
    - apps/sundial/test/heartbeat.test.ts
    - apps/compass/test/heartbeat.test.ts
  modified:
    - apps/filer/src/index.ts
    - apps/forge/src/index.ts
    - apps/sundial/src/index.ts
    - apps/compass/src/index.ts
decisions:
  - "Watchdog emits DIRECTLY to atlas-wire via send() — NOT via flag() (which targets atlas-incidents, and Flagger is the atlas-incidents consumer that may be dead)"
  - "Fail-toward-alerting: absent flagger:last_seen treated as lastSeen=0 so age=Date.now() always exceeds threshold"
  - "Heartbeat optional-chaining (env.INCIDENTS?.send) — absent binding never throws (backward compat)"
  - "WorkerEntrypoint constructor is (ctx, env) not (env, ctx) — required fix found during GREEN phase"
  - "Kill test validates direct send() path (no flag() call in flagger-watchdog — grep confirms 0 occurrences)"
metrics:
  duration: "~45 minutes"
  completed: "2026-06-05T20:05:00Z"
  tasks: 2
  files_changed: 15
  commits: 4
---

# Phase 02 Plan 03: Watchdog + Heartbeat Retrofit Summary

**One-liner:** Externalized flagger-watchdog Worker (direct atlas-wire self-P1 on 15m silence) + kind:heartbeat emit retrofitted into Filer/Forge/Sundial/Compass; kill test green (GATING criterion); 356 tests passing.

## What Was Built

### Task 1 — flagger-watchdog Worker (single-cron, direct atlas-wire self-P1)

Created `apps/flagger-watchdog` as a separate Cloudflare Worker with its own `wrangler.jsonc`:
- `scheduled()` handler reads `selfwatch_threshold` (default 900000ms / 15m) and `flagger:last_seen` from CONFIG KV
- Fail-toward-alerting: absent `last_seen` → lastSeen=0 → age=Date.now() always exceeds threshold → P1 emitted
- Emits DIRECTLY to `atlas-wire` via `send(env, event)` — NOT via `flag()` (which targets `atlas-incidents`, and Flagger may be dead)
- Wire event shape: `{ agent:"Flagger", type:"flag", entity:"flag", op:"upsert", payload:{id, source_agent:"Flagger", severity:"P1", trust:100, title, detail, status:"open"}, idempotencyKey:"flg:<date>:Flagger:watchdog" }`
- Belt-and-suspenders: also attempts a direct ntfy POST when NTFY_TOPIC/NTFY_TOKEN secrets are seeded (failure non-fatal)
- `wrangler.jsonc`: WIRE producer only, NO consumers block, staging crons [], `*/5 * * * *` cron

**Kill test (5/5 passing — GATING criterion):**
- Stale last_seen (20m > 15m threshold) → exactly one self-P1 upsert to WIRE
- Fresh last_seen (0ms ago) → nothing emitted
- Absent last_seen → self-P1 emitted (fail-toward-alerting)
- Custom threshold respected
- Idempotency key is date-keyed (not random) — Steward deduplicates replays

**TDD cycle:** RED commit (e8746db) → GREEN commit (73e0042)

### Task 2 — Heartbeat emit retrofit (Filer, Forge, Sundial, Compass)

Added `await this.env.INCIDENTS?.send({ source_agent, kind:"heartbeat", severity_hint:"P4", title, run_id })` at the END of each agent's WorkerEntrypoint method, after all existing Wire emits:

- **Filer** (`Filer.sweep()`): emits `Filer heartbeat <date>` after `send(env, buildSweepEvent(...))`
- **Forge** (`Forge.morning()`): emits `Forge heartbeat <date>` after the extraction result is assembled
- **Sundial** (`Sundial.sync()`): emits `Sundial heartbeat <date>` after `send(env, buildSyncEvent(...))`
- **Compass** (`Compass.plan()`): emits `Compass heartbeat <date>` after `runPlan()` returns

All four use optional-chaining (`?.send`) so Workers without the INCIDENTS binding still run.
Heartbeat is NOT emitted on failure paths (never inside a catch block).

**Per-agent heartbeat tests (12 tests total, all green):**
- Shape validation: source_agent, kind, severity_hint, title, run_id
- Exactly one heartbeat per run
- Optional-chaining: absent INCIDENTS does not throw

**TDD cycle:** RED commit (64d5297) → GREEN commit (caf1e49)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] WorkerEntrypoint constructor order is (ctx, env) not (env, ctx)**
- **Found during:** Task 2 GREEN phase — test run failed with WIRE.send undefined
- **Issue:** Tests instantiated `new Filer(env, {})` but `WorkerEntrypoint` constructor signature is `(ctx: ExecutionContext, env: Env)` — ctx is first. With args reversed, `this.env` was set to the mock ctx `{}` (which had no WIRE/INCIDENTS), causing `env.WIRE.send` to be undefined.
- **Fix:** Changed all four test instantiations to `new Agent({} as ExecutionContext, testEnv)` — verified against `@cloudflare/workers-types` `.d.ts`.
- **Files modified:** `apps/filer/test/heartbeat.test.ts`, `apps/forge/test/heartbeat.test.ts`, `apps/sundial/test/heartbeat.test.ts`, `apps/compass/test/heartbeat.test.ts`
- **Commit:** caf1e49

## Known Stubs

None — all modules fully implemented. The `store_id` placeholder `<atlas-store-id>` in `apps/flagger-watchdog/wrangler.jsonc` `secrets_store_secrets` is a deploy-time configuration (same pattern as all other workers).

## Threat Flags

No new threat surfaces beyond the plan's declared threat register:
- T-02-wd1: mitigated (NO `"consumers"` block in flagger-watchdog wrangler.jsonc; kill test + guard hook verify)
- T-02-wd2: mitigated (externalized watchdog; fail-toward-alerting on absent last_seen)
- T-02-hb: accepted (one heartbeat per scheduled run; P4 severity_hint; low cardinality)
- T-02-topic: mitigated (NTFY_TOPIC/NTFY_TOKEN via Secrets Store async get(); never in [vars]/KV/logs)
- T-02-SC: accepted (no new package installs — workspace deps only)

## Self-Check: PASSED

Files exist:
- FOUND: apps/flagger-watchdog/src/index.ts
- FOUND: apps/flagger-watchdog/wrangler.jsonc
- FOUND: apps/flagger-watchdog/test/kill.test.ts
- FOUND: apps/filer/test/heartbeat.test.ts
- FOUND: apps/forge/test/heartbeat.test.ts
- FOUND: apps/sundial/test/heartbeat.test.ts
- FOUND: apps/compass/test/heartbeat.test.ts

Commits exist:
- e8746db: test(02-03): RED — failing kill test for flagger-watchdog
- 73e0042: feat(02-03): flagger-watchdog Worker — direct atlas-wire self-P1 on Flagger silence
- 64d5297: test(02-03): RED — failing heartbeat tests for Filer/Forge/Sundial/Compass
- caf1e49: feat(02-03): heartbeat emit retrofit — Filer/Forge/Sundial/Compass emit kind:heartbeat on success

Acceptance criteria:
- wrangler.jsonc has crons */5 * * * *: ✓
- wrangler.jsonc has NO "consumers" key: ✓ (grep -c '"consumers"' = 0)
- Watchdog emits via send() not flag(): ✓ (grep -c "flag(env" apps/flagger-watchdog/src/index.ts = 0)
- Kill test: stale → P1 upsert; fresh → nothing; absent → P1: ✓
- pnpm --filter flagger-watchdog test exits 0: ✓ (5/5 passing — GATING criterion met)
- Each of filer/forge/sundial/compass has exactly one INCIDENTS?.send with kind:heartbeat: ✓
- Heartbeat uses severity_hint P4: ✓
- Heartbeat NOT in catch block: ✓
- All four heartbeat tests exit 0: ✓ (12 tests)
- pnpm test full suite green: ✓ (356 tests passing, 2 skipped — existing OAuth live-test skips)
- Pillar 1 intact (steward sole atlas-wire consumer): ✓
