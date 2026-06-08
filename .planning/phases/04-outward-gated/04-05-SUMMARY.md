---
phase: 04-outward-gated
plan: "05"
subsystem: sundial-gate-retrofit
tags: [gate, sundial, calendar, pillar-2, confirm-gate, openGate, applyRemoval, fail-closed]
dependency_graph:
  requires: [packages/gate (04-01), apps/sundial (existing), migrations/0007_gate.sql]
  provides: [apps/sundial openGate retrofit — propose-removal routed through packages/gate]
  affects: [apps/gate (wave 2 gate Worker can now invoke Sundial.applyRemoval on approval)]
tech_stack:
  added: [@atlas/gate workspace dep added to apps/sundial]
  patterns: [openGate call-site in runSync loop, RemovalTools injection interface, applyRemoval WorkerEntrypoint method, D1 assertion tests (no module patching)]
key_files:
  created:
    - apps/sundial/test/gate-retrofit.test.ts
  modified:
    - apps/sundial/src/index.ts
    - apps/sundial/wrangler.jsonc
    - apps/sundial/wrangler.test.jsonc
    - apps/sundial/package.json
    - pnpm-lock.yaml
decisions:
  - "D1 assertion test approach: ESM modules in workerd are sealed (read-only getters on module namespace), so vi.mock module-patching of @atlas/gate is impossible at runtime. Switched to testing openGate's real D1 side-effect (gate_pending row) against the real workerd D1 — more faithful than a mock and verifies the actual integration."
  - "RemovalTools defined in index.ts (not reconcile.ts): reconcile.ts is byte-unchanged (Pitfall 7). The gate-approved re-invoke path uses its own minimal interface exported from index.ts, avoiding any reconcile.ts modification."
  - "GATE_BASE_URL as required string (not optional) in Env: openGate always needs a confirmBaseUrl; making it required ensures callers can't accidentally omit it. The wrangler.test.jsonc provides a test placeholder value."
metrics:
  duration: "~30 minutes"
  completed: "2026-06-08"
  tasks_completed: 1
  tasks_total: 1
  tests_added: 9
  files_created: 1
  files_modified: 5
---

# Phase 4 Plan 05: Sundial Gate Retrofit Summary

One-liner: Sundial's propose-removal decisions now route through packages/gate openGate() — real audited fail-safe D1 gate with NTFY confirm push, idempotent re-runs, and gated-delete-only applyRemoval() re-invoke entrypoint.

## What Was Built

**apps/sundial/src/index.ts** — two changes:
1. After `reconcile()` returns in `runSync()`, iterates `result.decisions` and calls `openGate(env, {...})` for each `action === "propose-removal"` decision with an `eventId`. Gate opts: `agent:"Sundial"`, `action:"calendar.remove"`, `target:eventId`, `idempotencyKey:"sundial:remove:<eventId>"`, `expiresInMs:7d`, `scopeUsed:"calendar.events"`, `confirmBaseUrl:env.GATE_BASE_URL`. The env passed to openGate carries `DB + INCIDENTS + NTFY_TOPIC + NTFY_TOKEN` so the confirm push is delivered.
2. Adds `applyRemoval({ gateId, eventId, tools? })` WorkerEntrypoint method — the gate Worker re-invokes this on approval. Uses the new `RemovalTools` interface (also in index.ts). Fail-closed: throws + flags P2 if tools absent or `removeEvent` throws.

**apps/sundial/wrangler.jsonc** — adds:
- `"vars": { "GATE_BASE_URL": "https://gate.atlas.workers.dev" }` (plaintext non-secret)
- `"secrets_store_secrets"` block with NTFY_TOPIC + NTFY_TOKEN (same shape as apps/flagger)

**apps/sundial/wrangler.test.jsonc** — adds `"vars": { "GATE_BASE_URL": "https://gate.test.invalid" }` for the test env binding.

**apps/sundial/package.json** — adds `"@atlas/gate": "workspace:*"` to dependencies.

**apps/sundial/test/gate-retrofit.test.ts** — 9 new tests:
- `gate_pending` row written with correct agent/action/target/idempotency_key/scope_used/status
- P2 flag still fires (ADDITIVE — reconcile unchanged)
- Orphan propose-removal also opens a gate row
- Re-run idempotency: UNIQUE constraint → exactly 1 row (no duplicate)
- No propose-removal → no gate row opened
- CalendarTools has no removeEvent (no delete verb on the sync path)
- `applyRemoval` calls `removeEvent` correctly on approval re-invoke
- `applyRemoval` throws (no tools → fail-closed)
- `applyRemoval` rethrows on `removeEvent` failure + P2 flag

**reconcile.ts: ZERO changes** — byte-unchanged as required (Pitfall 7).

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | `bc9e99f` | feat(04-05): retrofit Sundial propose-removal through openGate() + applyRemoval() re-invoke |

## Test Results

```
$ pnpm --filter @atlas/sundial test

 Test Files  5 passed (5)
      Tests  31 passed (31)
   Start at  13:03:28
   Duration  3.47s (transform 2.85s, setup 10.86s, import 170ms, tests 305ms, environment 0ms)
```

Pre-existing 22 tests + 9 new gate-retrofit tests = 31 total. All green.

```
$ pnpm --filter @atlas/sundial typecheck
(clean — no output)

$ pnpm -r typecheck
(all packages/apps pass — no errors)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Module patching impossible in workerd ESM (sealed module namespace)**
- **Found during:** Task 1 test authoring
- **Issue:** Attempted `(gateModule as {...}).openGate = mockFn` after dynamic import. ESM modules in vitest-pool-workers are sealed (read-only getters on the module namespace), so assignment throws `TypeError: Cannot set property openGate of [object Module] which has only a getter`. Standard `vi.mock` hoisting requires a static `vi.mock()` call at file scope, which cannot be done when the mock behavior depends on runtime values.
- **Fix:** Rewrote the test to assert on D1 side-effects directly. `openGate` writes to `gate_pending` in real D1 (migrations applied by `beforeAll`). Tests query `gate_pending` by `idempotency_key` and assert the row shape — more faithful to the real integration than a mock, and covers the actual acceptance criteria (agent, action, target, idempotency_key, scope_used).
- **Files modified:** `apps/sundial/test/gate-retrofit.test.ts`

**2. [Rule 2 - Critical] RemovalTools interface in index.ts (not reconcile.ts)**
- **Found during:** Task 1 implementation
- **Issue:** `applyRemoval()` needs a `removeEvent(eventId): Promise<void>` surface, but `CalendarTools` in `reconcile.ts` has no delete method (correct — Pillar 2) and `reconcile.ts` is byte-unchanged (Pitfall 7). Adding `removeEvent` to `CalendarTools` would modify `reconcile.ts`.
- **Fix:** Defined a separate `RemovalTools` interface in `index.ts` used exclusively by `applyRemoval()`. This keeps the reconcile interface delete-free while giving the gate-approved re-invoke path a typed surface.
- **Files modified:** `apps/sundial/src/index.ts`

## Known Stubs

None. `openGate` is fully implemented (04-01). `applyRemoval` is fully implemented. NTFY_TOPIC/NTFY_TOKEN bindings are declared with `<atlas-store-id>` placeholder (standard go-live gate — the same placeholder is in flagger and every other agent that uses Secrets Store).

## Threat Flags

No new threat surface beyond the plan's threat register. `applyRemoval()` is a WorkerEntrypoint method reachable only via an approved gate re-invoke from the gate Worker — no new network endpoint is introduced.

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `apps/sundial/src/index.ts` contains `openGate` | FOUND |
| `apps/sundial/src/index.ts` contains `applyRemoval` | FOUND |
| `apps/sundial/test/gate-retrofit.test.ts` exists | FOUND |
| `git diff --stat apps/sundial/src/reconcile.ts` = 0 changes | PASS |
| NTFY_TOPIC in wrangler.jsonc | FOUND |
| NTFY_TOKEN in wrangler.jsonc | FOUND |
| GATE_BASE_URL in wrangler.jsonc [vars] | FOUND |
| No `ntfy.sh` in apps/sundial/src/ | PASS |
| `pnpm --filter @atlas/sundial test` | 31/31 PASS |
| `pnpm --filter @atlas/sundial typecheck` | PASS |
| `pnpm -r typecheck` | PASS (all clean) |
| commit bc9e99f exists | FOUND |
