---
phase: 04-outward-gated
plan: "04"
subsystem: daemon-browser
tags: [daemon, playwright, browser-automation, outbound-only, serial-drain, hard-stop, envoy, usher]
dependency_graph:
  requires: [packages/gate (04-01 — BrowserActionWorkItem/BrowserActionOutcome types), daemon/src/drain.ts (Obsidian drain analog), apps/gate (04-03 — /browser/poll + /browser/ack endpoints)]
  provides: [daemon/src/browser-drain.ts (poll/drain/ack loop), daemon/src/browser-runner.ts (Playwright executor), daemon/src/main.ts (both loops in one process)]
  affects: [apps/usher (04-06 — enqueues browser_action_outbox items), apps/envoy (04-07 — enqueues linkedin_prefill/x_prefill items)]
tech_stack:
  added: [playwright@1.60.0 (daemon dependency, go-live install), node:fs ambient (stale-lock clear), playwright ambient declarations (for tsc without binary)]
  patterns: [serial for...of drain (never concurrent), ack-after-attempt, per-item try/catch to error-outcome, loadBrowserConfig fail-loud, MockPage injectable dep for unit tests, withBrowserContext persistent-context lifecycle]
key_files:
  created:
    - daemon/src/browser-drain.ts
    - daemon/src/browser-runner.ts
    - daemon/src/main.ts
    - daemon/test/browser-drain.test.ts
    - daemon/test/browser-runner.test.ts
  modified:
    - daemon/package.json (added playwright@1.60.0 dependency, updated main entrypoint)
    - daemon/src/node-ambient.d.ts (added playwright ambient module + node:fs declaration)
    - daemon/tsconfig.json (added allowImportingTsExtensions: true for .ts relative imports)
decisions:
  - "Relative import for BrowserActionWorkItem/BrowserActionOutcome: daemon is outside pnpm workspace (apps/* packages/* only) so workspace: protocol is not available. Used relative path ../../packages/gate/src/schema.ts — equivalent to @atlas/gate/schema, not a redeclaration."
  - "Playwright ambient declaration in node-ambient.d.ts: Playwright@1.60.0 is a go-live owner action (npx playwright install chromium). The daemon must tsc-compile before the binary is installed. Added a minimal ambient module declaration with only the surface browser-runner.ts uses."
  - "allowImportingTsExtensions: true added to daemon tsconfig: main.ts imports ./drain.ts, ./browser-drain.ts, ./browser-runner.ts with .ts extensions (matching Node 22 --experimental-strip-types runtime). The existing tests already used .ts import paths; tsc rejected them only because the flag was missing."
  - "withBrowserContext does NOT close context across items: per the plan and Pitfall 2, the persistent context must stay alive across work items. The stale-lock (SingletonLock) is deleted on startup to handle forced-kill restarts cleanly."
  - "MockPage injectable interface: runBrowserAction accepts an optional third argument _page?: MockPage. Tests inject a mock; production uses the real Playwright page. No real Chromium is launched in unit tests."
metrics:
  duration: "~7 minutes"
  completed: "2026-06-08"
  tasks_completed: 2
  tasks_total: 2
  tests_added: 27
  files_created: 5
  files_modified: 3
---

# Phase 4 Plan 04: Daemon Browser-Action Runner Summary

One-liner: Daemon browser-action runner — serial poll/drain/ack loop for browser_action_outbox + Playwright persistent-context executor with hard-stop detection (captcha/payment before irreversible steps, Envoy never auto-submits, Usher requires scraped confirmation #).

## What Was Built

### daemon/src/browser-drain.ts

The outbound browser-action drain loop — mirrors `daemon/src/drain.ts` (Obsidian bridge drain) exactly, substituting the browser-action endpoints and types.

- **`pollOnce`**: GET `/browser/poll` with Bearer `ATLAS_BRIDGE_TOKEN` → `BrowserActionWorkItem[]`
- **`drainOnce`**: Serial `for...of` (never concurrent), per-item `try/catch` → error outcome → `ackOutcome`, continues. Ack happens ONLY after the action attempt (pending never lost).
- **`ackOutcome`**: POST `/browser/ack` with `{ id, outcome: BrowserActionOutcome }`
- **`loadBrowserConfig`**: Fails loud on missing `ATLAS_BRIDGE_URL` / `ATLAS_BRIDGE_TOKEN` / `ATLAS_BROWSER_PROFILE` — never defaults the profile path.
- **`drainLoop`**: Backoff-sleep on empty/error; `runForever` + `sleep` injectable for tests.
- Types imported from `../../packages/gate/src/schema.ts` (single source, not redeclared).

### daemon/src/browser-runner.ts

The Playwright executor — the injectable `runBrowserAction` dep for the drain loop.

- **`MockPage` interface**: Minimal page abstraction injected in unit tests (no real Chromium).
- **`withBrowserContext`**: Wraps `chromium.launchPersistentContext(profilePath, {headless:false, slowMo:50})`; clears stale `SingletonLock` on startup; does NOT close context across items.
- **`runBrowserAction(item, cfg, _page?)`**: Dispatches on `action_type`. Mock page injected in tests; real Playwright page used in production.
  - **Usher `event_fill_submit`**: captcha BEFORE fill → fill fields → payment/sold_out/login_wall BEFORE submit → `submitForm` → scrape confirmation # (hard_stop if empty). No card entry. No captcha solver.
  - **Envoy `linkedin_prefill` / `x_prefill`**: goto → fill fields → return WITHOUT submitting. NO submit/post click anywhere in the Envoy branches (D4-08). Fill timeout → `{status:'error'}` (caller keeps draft, P2 — D4-13).

### daemon/src/main.ts

Wires both drain loops in ONE process (single launchd LaunchAgent):

```
obsidianDrainLoop(...)   // Obsidian bridge drain (unchanged)
withBrowserContext(..., async (_ctx) => {
  browserDrainLoop(...)  // Browser-action drain inside persistent context
})
```

### daemon/package.json

Added `playwright@1.60.0` as a runtime dependency (go-live owner action: `npx playwright install chromium`).

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 RED | `51038e1` | test(04-04): add failing browser-drain tests (TDD RED) |
| Task 1 GREEN | `6c34c83` | feat(04-04): Task 1 — browser-drain.ts poll/drain/ack |
| Task 2 RED | `30e5457` | test(04-04): add failing browser-runner tests (TDD RED) |
| Task 2 GREEN | `ba5d677` | feat(04-04): Task 2 — browser-runner.ts + main.ts wiring |

## Test Results

```
 RUN  v4.1.8 /Users/danielchahine/Desktop/Programs/Atlas/daemon

 Test Files  3 passed (3)
      Tests  38 passed (38)
   Start at  12:52:37
   Duration  132ms (transform 96ms, setup 0ms, import 129ms, tests 21ms, environment 0ms)
```

- `drain.test.ts` (11 tests): existing Obsidian drain tests — still green (no regression)
- `browser-drain.test.ts` (15 tests): pollOnce, ackOutcome, drainOnce serial+ack-after-attempt+one-item-error-continues, drainLoop, loadBrowserConfig fail-loud
- `browser-runner.test.ts` (12 tests): captcha-before-fill, payment-before-submit, Usher success+no-confirmation, sold_out, login_wall, Envoy prefill-without-submit (linkedin + x), Envoy selector-timeout→error, unknown action_type, unexpected throw

## TypeScript Check

```
cd /Users/danielchahine/Desktop/Programs/Atlas/daemon && npx tsc --noEmit -p tsconfig.json
(exit 0 — clean)
```

## Acceptance Criteria Verification

| Check | Result |
|-------|--------|
| `grep -n 'Promise.all' daemon/src/browser-drain.ts` → no match | PASS |
| `grep -n 'ATLAS_BROWSER_PROFILE' daemon/src/browser-drain.ts` → present + throws on unset | PASS |
| `BrowserActionWorkItem/BrowserActionOutcome` imported from `packages/gate/src/schema.ts`, not redeclared | PASS |
| `grep -nE 'submitForm' runEnvoyPrefill` → no match (Envoy never submits) | PASS |
| Captcha check precedes any `fill` in Usher branch (source order: detectCaptcha L8, fillField L16) | PASS |
| Payment check precedes submit (detectPaymentWall L20, submitForm L35) | PASS |
| No card-entry code path in `browser-runner.ts` | PASS |
| `daemon/package.json` declares `playwright` at 1.60.0 | PASS |
| `main.ts` starts both drain loops in one process | PASS |
| `tsc --noEmit` clean | PASS |
| 38/38 daemon tests green | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `arguments` keyword in arrow function inside test**
- **Found during:** Task 1 GREEN — test run showed `ReferenceError: arguments is not defined`
- **Issue:** The serial-drain order test used `arguments[1]` inside a `vi.fn(async (url) => { ... })` arrow function. Arrow functions do not have `arguments` binding.
- **Fix:** Changed to use the explicit function parameter `(url, init)` instead of `arguments`.
- **Files modified:** `daemon/test/browser-drain.test.ts`

**2. [Rule 3 - Blocking] `allowImportingTsExtensions` missing from daemon tsconfig**
- **Found during:** Task 2 tsc check — `main.ts` imports `./drain.ts` etc. with `.ts` extensions but tsc TS5097 rejected them.
- **Issue:** `daemon/tsconfig.json` lacked `allowImportingTsExtensions: true`. The existing test files used `.ts` imports (vitest handled them via esbuild), but `main.ts` cross-imports between daemon source files triggered the error.
- **Fix:** Added `"allowImportingTsExtensions": true` to daemon tsconfig.

**3. [Rule 2 - Critical] Playwright + node:fs ambient declarations**
- **Found during:** Task 2 tsc check — `playwright` and `node:fs` not installed/declared in the daemon's minimal ambient type setup.
- **Issue:** `browser-runner.ts` imports `playwright` (go-live dep, not installed) and `node:fs` (for stale-lock clear). Neither was in `node-ambient.d.ts`.
- **Fix:** Added minimal ambient `declare module "playwright"` (only the surface browser-runner.ts uses) and `declare module "node:fs"` with `unlinkSync`. This matches the daemon's established pattern of declaring only what is needed rather than installing `@types/node`.

**4. [Rule 1 - Bug] `daemon/src/browser-runner.ts` references `makePlaywrightPageFromContext` that didn't exist**
- **Found during:** Task 2 — first draft of `main.ts` imported a function that wasn't exported.
- **Fix:** Simplified `main.ts` to call `runBrowserAction(item, cfg)` without a page arg (which creates its own context), keeping the design clean without an extra export.

### Out-of-scope Items

None deferred. All items were within the task scope.

## Deferred Owner-Setup Items (Go-Live Gates)

These are OWNER actions required before the browser drain loop runs in production. The code and mock-page unit tests run completely without them.

| Item | Why deferred | What to do at go-live |
|------|-------------|----------------------|
| Install Playwright Chromium binary | `playwright install chromium` downloads a managed Chromium binary (~150 MB). This is an owner action on the local macOS machine — not a CI step. | `cd daemon && pnpm add playwright && npx playwright install chromium` |
| Create and seed owner's Chromium profile | The profile at `ATLAS_BROWSER_PROFILE` must exist with the owner's LinkedIn/X/Meetup/Eventbrite sessions. | Create the profile dir (e.g. `~/.atlas/browser-profile`), launch Chromium against it once, log into each platform. |
| Set `ATLAS_BROWSER_PROFILE` in daemon launchd env | The `com.atlas.bridge.plist` LaunchAgent must set this env var (never a tracked file). | Add `ATLAS_BROWSER_PROFILE` to the plist `EnvironmentVariables` dict alongside `ATLAS_BRIDGE_TOKEN`. |

## Known Stubs

None. Both `browser-drain.ts` and `browser-runner.ts` are fully implemented for the mock-test path. The real Playwright execution path is guarded behind the go-live owner setup items above.

## Threat Flags

No new security surface beyond the plan's threat model (T-04-18 through T-04-SC). The mitigations are mechanically enforced:
- T-04-18 (credential exfiltration): Atlas never reads/stores the profile — `ATLAS_BROWSER_PROFILE` is a path only.
- T-04-19 (captcha auto-solved): `detectCaptcha()` before any fill → hard_stop; no solver.
- T-04-20 (payment auto-submitted): `detectPaymentWall()` before submit → hard_stop; no card-entry code path.
- T-04-21 (Envoy irreversible post): `runEnvoyPrefill` contains no `submitForm` call — verified by grep + test.
- T-04-22 (unauthenticated poll/ack): Bearer `ATLAS_BRIDGE_TOKEN` on every request; outbound-only.
- T-04-23 (profile lock): `SingletonLock` deleted on `withBrowserContext` startup.
- T-04-24 (2FA in fields): fields JSON carries only Codex values; runner never logs field values.

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `daemon/src/browser-drain.ts` exists | FOUND |
| `daemon/src/browser-runner.ts` exists | FOUND |
| `daemon/src/main.ts` exists | FOUND |
| `daemon/test/browser-drain.test.ts` exists | FOUND |
| `daemon/test/browser-runner.test.ts` exists | FOUND |
| `daemon/package.json` has `playwright@1.60.0` | FOUND |
| commit `51038e1` (Task 1 RED) exists | FOUND |
| commit `6c34c83` (Task 1 GREEN) exists | FOUND |
| commit `30e5457` (Task 2 RED) exists | FOUND |
| commit `ba5d677` (Task 2 GREEN) exists | FOUND |
| `pnpm --filter ./daemon test -- browser-drain` (38/38 green) | PASS |
| `pnpm --filter ./daemon test -- browser-runner` (38/38 green) | PASS |
| `tsc --noEmit` clean | PASS |
| No `Promise.all` in `browser-drain.ts` | PASS |
| No `submitForm` in `runEnvoyPrefill` | PASS |
| `ATLAS_BROWSER_PROFILE` throws when unset | PASS |
| Types imported from `@atlas/gate/schema` (relative path) | PASS |
