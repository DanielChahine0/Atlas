---
phase: 04-outward-gated
plan: "01"
subsystem: gate
tags: [gate, d1, ntfy, audit-log, confirmation, security, fail-closed]
dependency_graph:
  requires: [packages/shared, packages/security, packages/wire, migrations/0007_gate.sql]
  provides: [packages/gate — openGate/decideGate/sweepExpired/getGate/buildConfirmPush/renderConfirmPage/timingSafeEqual/sha256]
  affects: [apps/gate (Wave 1), apps/usher (Wave 2), apps/envoy (Wave 3), apps/sundial retrofit (Wave 2)]
tech_stack:
  added: [packages/gate (workspace library), migrations/0007_gate.sql, inline ULID generator]
  patterns: [D1 batch atomic write, SecretsStoreSecret async binding, best-effort push with P2 fallback, AND-status-pending mutual exclusion guard, dual audit_log rows per gate, workerd vitest-pool-workers test harness]
key_files:
  created:
    - migrations/0007_gate.sql
    - packages/gate/package.json
    - packages/gate/tsconfig.json
    - packages/gate/vitest.config.ts
    - packages/gate/wrangler.test.jsonc
    - packages/gate/test/apply-migrations.ts
    - packages/gate/src/auth.ts
    - packages/gate/src/auth.test.ts
    - packages/gate/src/render.ts
    - packages/gate/src/render.test.ts
    - packages/gate/src/push.ts
    - packages/gate/src/push.test.ts
    - packages/gate/src/schema.ts
    - packages/gate/src/index.ts
    - packages/gate/src/index.test.ts
  modified:
    - packages/gate/tsconfig.json (added @cloudflare/vitest-pool-workers/types for cloudflare:test resolution)
decisions:
  - "Inline ULID generator: project has no ulid package; implemented 26-char Crockford Base32 (10-char timestamp + 16-char random) using crypto.getRandomValues — no new dependency, cryptographically random, lexicographically sortable"
  - "decideGate runs UPDATE standalone before audit INSERT (not in a single batch): D1 batch() does not expose per-statement meta.changes; splitting into two statements allows the double-decide guard (no second audit row if UPDATE matched 0 rows). Fail-closed invariant still holds: rethrow on any error before side effect"
  - "SecretBinding interface in OpenGateEnv: widened from SecretsStoreSecret to accept test stubs returning null; null-check on the result (if !topic) preserves runtime correctness"
  - "sweepExpired selects candidates then individually UPDATE-guards: per-row guarded UPDATE (AND status='pending' AND expires_at<now) makes the sweep idempotent and mutually exclusive with decideGate at the approve-vs-expire boundary"
metrics:
  duration: "~45 minutes (continuation — Task 3 only)"
  completed: "2026-06-08"
  tasks_completed: 3
  tasks_total: 3
  tests_added: 70
  files_created: 15
  files_modified: 1
---

# Phase 4 Plan 01: Gate Primitive Summary

One-liner: Shared `packages/gate` confirmation-gate library — D1-backed openGate/decideGate/sweepExpired lifecycle with constant-time token, dual audit_log rows, ntfy push SEND in openGate (best-effort, P2-on-failure), and workerd test suite covering audit / expire / race / fail-closed / push paths.

## What Was Built

The `packages/gate` workspace library is the sole enforcement point for Atlas Pillar 2 (suggest-don't-destroy). It ships:

- **`migrations/0007_gate.sql`** — `gate_pending` (UNIQUE idx on `idempotency_key`, SHA-256 `token_hash`) + `browser_action_outbox` (claim/lease `claimed_at` column)
- **`src/auth.ts`** — `timingSafeEqual` (HMAC-SHA-256, constant-time) + `sha256` (hex digest)
- **`src/push.ts`** — `buildConfirmPush` (builds ntfy payload with `view` action; does NOT dispatch — pure builder)
- **`src/render.ts`** — `renderConfirmPage/renderOutcomePage/renderExpiredPage` + `authHtmlResponse/authResponse/isSameOrigin/AUTH_SECURITY_HEADERS`
- **`src/schema.ts`** — Zod schemas + D1 row types (`GatePendingRow`, `GateOptions`, `GateRecord`, `BrowserActionWorkItem`, `BrowserActionOutcome`, `NtfyPayload`)
- **`src/index.ts`** — `openGate / getGate / decideGate / sweepExpired` lifecycle

### Key Behaviors

**openGate:**
- Writes `gate_pending` row + `'pending'` audit_log row in a D1 batch (atomic)
- AFTER the batch commits, dispatches the ntfy confirm push via `fetch("https://ntfy.sh/", ...)` exactly as `apps/flagger/src/push.ts` does (topic in JSON body, NTFY_TOKEN in Authorization header)
- Push is best-effort: try/catch → P2 `gate_push_failed` flag, GateRecord still returned, gate row never rolled back
- Unseeded NTFY_TOPIC → skip send silently (go-live gate, not a code gap)
- Duplicate idempotencyKey → return existing gate; no second row, no second push

**decideGate:**
- Runs guarded UPDATE (`WHERE id=? AND status='pending'`), checks `meta.changes`
- If 0 rows matched (double-decide): returns immediately, no second terminal audit row
- If 1 row matched: inserts terminal audit_log row (decision='approved'/'rejected', outcome='ok')
- Rethrows on any D1 error (fail-closed: caller returns 5xx, no side effect runs)

**sweepExpired:**
- Per-row guarded UPDATE (`WHERE id=? AND status='pending' AND expires_at<?`)
- Terminal audit row + P3 `gate_expired` flag ONLY when `meta.changes===1`
- A gate approved between SELECT and UPDATE → UPDATE matches 0 rows → no double-terminal-state
- Re-sweep over already-expired gates → 0 rows matched → idempotent
- Returns count of rows actually transitioned

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | `07c1694` | migrations/0007_gate.sql + @atlas/gate scaffold + workerd test harness |
| Task 2 | `9ee1cba` | auth/render/push utilities + security tests (TDD GREEN) |
| Task 3 | `c369e7a` | gate lifecycle openGate/decideGate/sweepExpired + ntfy push send + dual audit rows |

## Test Results

```
Test Files  4 passed (4)
     Tests  70 passed (70)
  Duration  ~2s (workerd)
```

- `auth.test.ts` (6 tests): timingSafeEqual + sha256
- `render.test.ts` (21 tests): renderConfirmPage/renderExpiredPage/renderOutcomePage/authHtmlResponse/authResponse/isSameOrigin + 2FA/reset/login security invariants
- `push.test.ts` (9 tests): buildConfirmPush payload shape, redaction, no fetch()
- `index.test.ts` (34 tests): openGate lifecycle, getGate, decideGate, sweepExpired, all --grep groups

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Inline ULID generator (no package installed)**
- **Found during:** Task 3 implementation
- **Issue:** Plan specifies `ulid()` but the project has no `ulid` npm package installed. The plan's own instruction says "if the project uses a local ulid helper, reuse it rather than adding a new dep" — no local helper existed.
- **Fix:** Implemented a 26-character Crockford Base32 ULID generator inline in `index.ts` using `crypto.getRandomValues`. The package legitimacy exclusion in Rule 3 prevents auto-installing unfamiliar packages.
- **Files modified:** `packages/gate/src/index.ts`

**2. [Rule 2 - Critical] decideGate as two statements instead of one batch**
- **Found during:** Task 3 implementation
- **Issue:** Plan calls for "one D1 batch" for decideGate, but D1's `batch()` API doesn't expose per-statement `meta.changes`, making it impossible to detect a double-decide (0-rows-matched = no second audit row). A true batch would insert the terminal audit row even when the UPDATE matched 0 rows.
- **Fix:** Run UPDATE standalone first, check `meta.changes`, then insert audit row only if matched. This preserves the fail-closed invariant (rethrow on error) while adding the no-second-audit-row correctness requirement from the acceptance criteria.

**3. [Rule 1 - Bug] tsconfig.json missing vitest-pool-workers types**
- **Found during:** Task 3 typecheck
- **Issue:** `cloudflare:test` module not resolvable by `tsc` — `@cloudflare/vitest-pool-workers/types` was missing from tsconfig.
- **Fix:** Added to `packages/gate/tsconfig.json` (matching `apps/flagger/tsconfig.json` pattern).

**4. [Rule 1 - Bug] OpenGateEnv SecretsStoreSecret type too narrow**
- **Found during:** Task 3 typecheck
- **Issue:** `SecretsStoreSecret.get()` returns `Promise<string>` (never null), but test stubs need to return `null` to simulate unseeded secrets.
- **Fix:** Introduced local `SecretBinding` interface (`get(): Promise<string | null | undefined>`) used in `OpenGateEnv`. The runtime code already null-checks the result (`if (!topic)`), so the wider type is semantically correct.

## Known Stubs

None. The `packages/gate` library is fully implemented. All four lifecycle functions (`openGate`, `getGate`, `decideGate`, `sweepExpired`) are wired and tested end-to-end against the real 0007 schema in workerd.

## Threat Flags

No new security-relevant surface beyond what the plan's threat model covered. The `packages/gate` library is not a Worker — it has no network endpoint. The ntfy push egress and gate_pending D1 surface were pre-planned in the threat register (T-04-08, T-04-09, T-04-10, T-04-04).

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `packages/gate/src/index.ts` exists | FOUND |
| `packages/gate/src/index.test.ts` exists | FOUND |
| `04-01-SUMMARY.md` exists | FOUND |
| commit c369e7a (Task 3) exists | FOUND |
| commit 9ee1cba (Task 2) exists | FOUND |
| commit 07c1694 (Task 1) exists | FOUND |
| `fetch("https://ntfy.sh/` present in index.ts | PASS |
| `fetch(` absent from push.ts | PASS |
| No `crypto.randomUUID` or `new Date()` in production code | PASS (comment only) |
| No `consumers` block in package JSON/JSONC | PASS |
| `pnpm --filter @atlas/gate test` | 70/70 PASS |
| `pnpm --filter @atlas/gate typecheck` | PASS |
