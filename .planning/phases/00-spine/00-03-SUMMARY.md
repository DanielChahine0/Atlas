---
phase: 00-spine
plan: 03
subsystem: orchestrator-runtime
tags: [atlas, durable-objects, scheduled-dispatcher, service-binding-rpc, heartbeat, wire-producer, spine-01, vitest-workerd]

# Dependency graph
requires:
  - phase: 00-spine (00-01)
    provides: apps/atlas/wrangler.jsonc base config (ATLAS/MORNING_CHAIN_DO DO bindings, new_sqlite_classes:[AtlasCoordinator] migration, WIRE atlas-wire producer, D1/KV/R2/AI), apps/atlas/vitest.config.ts + wrangler.test.jsonc (vitest-pool-workers v4, nodejs_compat), the placeholder AtlasCoordinator DO seam
  - phase: 00-spine (00-02)
    provides: "@atlas/wire (the single §6.4 WireEvent zod schema + parse-then-send send() producer), @atlas/shared (the canonical Env binding surface + flag(env, severity, title, detail?) Flagger-emit + localDate())"
provides:
  - "The Atlas orchestrator runtime: scheduled() dispatcher proving SPINE-01 end-to-end (cron tick -> no-op agent invoke over service-binding RPC (D-11) -> canonical §6.4 WIRE.send with a structured atlas:noop:<date> key)"
  - "AtlasCoordinator Durable Object: 1-min alarm() heartbeat self-monitor (D-10) — >5-min staleness raises a P1 incident to Flagger via flag(); alarm always reschedules; addressed only as getByName(\"root\")"
  - "NoopAgent — the D-11 service-binding RPC target (WorkerEntrypoint with a single tick() method, no domain work, no public HTTP surface)"
  - "Two workerd test suites: scheduled.test.ts (SPINE-01 Wire-contract + tick-before-send order + unknown-cron no-op) and heartbeat.test.ts (healthy no-emit, >5-min-stale P1, single-instance getByName)"
  - "The W3 leg of the GLOBAL-4 cross-wave handoff: the NOOP services self-binding added to apps/atlas/wrangler.jsonc, every 00-01 block preserved"
affects:
  - "00-04 (Steward crux + the lone Wire consumer): Atlas now emits real §6.4 events onto atlas-wire that Steward will dedup/apply; Atlas is confirmed producer-only so Steward remains the sole consumer"
  - "00-06 (OAuth front door): re-owns apps/atlas/src/index.ts to compose the inbound-auth provider WITH this dispatcher (kept cleanly separable); adds the W4 secrets_store_secrets leg to the same wrangler.jsonc handoff"
  - "Phase 1 (morning chain): inherits a working orchestrator skeleton — the dispatcher switch, getByName(\"root\") DO, structured idempotency keys, and the heartbeat self-supervision"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "DurableObject<Env> + WorkerEntrypoint<Env> base classes imported from \"cloudflare:workers\" (confirmed agents@0.14.1 / @cloudflare/workers-types@4.20260603.1); the protected base field is `ctx` (a DurableObjectState), NOT `state`"
    - "scheduled() dispatcher: switch(controller.cron) routes ONLY known crons; an unknown cron falls through and does nothing (T-00-32)"
    - "D-11 invoke transport = a same-Worker SELF service-binding RPC (service:\"atlas\", entrypoint:\"NoopAgent\") — env.NOOP.tick(...), no public HTTP surface (T-00-31)"
    - "Heartbeat self-supervision (D-10): one alarm per DO on a 1-min cadence; alarm() ALWAYS reschedules at the end so the heartbeat never stops (T-00-37)"
    - "Atlas escalates to Flagger ONLY over the Wire via the @atlas/shared flag() helper (canonical op:\"upsert\"/entity:\"flag\") — never a hand-rolled WIRE.send, never writing the Vault directly"
    - "workerd DO testing via cloudflare:test runInDurableObject(stub, (instance,state) => …) + getByName(\"root\"); per-test storage isolation is the vitest-pool-workers v4 default"

key-files:
  created:
    - "apps/atlas/src/coordinator.ts — AtlasCoordinator DO (beat/startHeartbeat/alarm; D-10 heartbeat self-monitor)"
    - "apps/atlas/src/noop-agent.ts — NoopAgent WorkerEntrypoint (the D-11 service-binding RPC target, single tick())"
    - "apps/atlas/test/scheduled.test.ts — SPINE-01 Wire-contract + dispatcher tests"
    - "apps/atlas/test/heartbeat.test.ts — D-10 heartbeat + single-instance (Pillar 1) tests"
  modified:
    - "apps/atlas/src/index.ts — REPLACED the Wave-1 hello-world with the scheduled() dispatcher; re-exports AtlasCoordinator + NoopAgent"
    - "apps/atlas/wrangler.jsonc — ADDED the NOOP services self-binding (GLOBAL-4 W3 leg); all 00-01 blocks preserved"
    - "apps/atlas/wrangler.test.jsonc — mirrored the NOOP binding for workerd parity"
    - "apps/atlas/package.json — added @atlas/wire + @atlas/shared workspace deps"
    - "apps/atlas/tsconfig.json — registered the cloudflare:test ambient types (@cloudflare/vitest-pool-workers/types)"
    - "pnpm-lock.yaml — apps/atlas importer now links the two workspace packages"

key-decisions:
  - "Confirmed the agents@0.14.1 base-class API by READING the installed type declaration (@cloudflare/workers-types@4.20260603.1, the version agents@0.14.1 transitively pins) rather than copying possibly-stale snippets — Open Question 1 closed. DurableObject<Env> and WorkerEntrypoint<Env> both export from \"cloudflare:workers\"; the build-plan T4 snippet matches the installed API verbatim."
  - "NoopAgent is a WorkerEntrypoint (not an agents-SDK Agent) — the lightest correct shape for a no-domain-work RPC target; arbitrary public methods (tick()) are callable over the service binding. Avoids pulling the Agent runtime for a Phase-0 smoke target."
  - "The D-11 binding is a SELF-binding (service:\"atlas\") so the no-op target stays in-Worker over a private RPC with no public HTTP route (T-00-31)."
  - "scheduled.test.ts drives the dispatcher with a synthetic spy-backed Env (the pattern packages/wire/test established) — deterministic, lets us assert BOTH the §6.4 shape AND the tick-before-send call order. heartbeat.test.ts uses the REAL DO in workerd via runInDurableObject + getByName(\"root\")."

patterns-established:
  - "Structured idempotency key for scheduled work: `atlas:noop:<owner-local-date>` (Intl/America/Toronto) — never a random per-run UUID; a re-fired or missed-then-recovered cron replays as a downstream no-op via Steward's ledger dedup (T-00-35)"
  - "Explanatory comments avoid the literal forbidden tokens (the random-UUID call, the inbound-OAuth provider name) so the structural grep gates read the CODE, not the prose (same hygiene as 00-02 deviation #2)"
  - "tsconfig `types` does NOT merge across `extends` — a Worker that needs the cloudflare:test module must re-list @cloudflare/workers-types AND add @cloudflare/vitest-pool-workers/types (the ./types subpath, where the cloudflare:test ambient module is declared — NOT the package's main types entry)"

requirements-completed: [SPINE-01]

# Metrics
duration: ~20min active (152min wall-clock incl. a transient-error interruption gap)
completed: 2026-06-04
---

# Phase 0 Plan 03: Atlas Orchestrator Runtime Summary

**The Atlas orchestrator runtime is live: a `scheduled()` dispatcher proves SPINE-01 end-to-end (a cron tick invokes the no-op agent over a private service-binding RPC (D-11), then routes a canonical §6.4 event onto the Wire with a structured `atlas:noop:<date>` key), the `AtlasCoordinator` DO self-supervises on a 1-min heartbeat (D-10: >5-min staleness raises a P1 to Flagger), and 8 workerd tests pass — all producer-only, no second `atlas-wire` consumer.**

## API confirmation (agents@0.14.1)

Open Question 1 / RESEARCH Assumption A3 (the single LOW-confidence area: the exact `agents@0.14.1` DO/Worker base-class API) was resolved by **reading the installed type declaration** in `@cloudflare/workers-types@4.20260603.1` — the version `agents@0.14.1` transitively pins (confirmed in the pnpm store: `agents@0.14.1_…_@cloudflare+workers-types@4.2026…`). Context7 / cloudflare-docs MCP tools were not reachable from this agent (the known upstream tool-stripping bug) and the `ctx7` CLI fallback was not installed; reading the resolved `.d.ts` is the authoritative equivalent and was used instead of copying possibly-stale snippets.

Confirmed surface (`experimental/index.d.ts`):
- **`DurableObject<Env, Props>`** is exported from **`"cloudflare:workers"`**. `constructor(ctx: DurableObjectState, env: Env)` — the protected base field is **`ctx`** (a `DurableObjectState`), with **`this.ctx.storage`** (`DurableObjectStorage`): `put(key, val)` / `get<T>(key): Promise<T | undefined>` / `getAlarm(): Promise<number | null>` / `setAlarm(scheduledTime: number | Date)`. The handler is `alarm?(alarmInfo?: AlarmInvocationInfo)`.
- **`WorkerEntrypoint<Env, Props>`** is also exported from **`"cloudflare:workers"`** with `protected ctx: ExecutionContext`, `protected env: Env`; arbitrary public methods (here `tick()`) are callable over a service binding as RPC.
- The build-plan T4 / 00-PATTERNS / 00-RESEARCH `AtlasCoordinator` snippet (`this.ctx.storage.put/get/getAlarm/setAlarm`) **matches the installed API verbatim**.

## Cross-wave handoff (GLOBAL-4, W3 leg)

The no-op **services self-binding** `{ "binding": "NOOP", "service": "atlas", "entrypoint": "NoopAgent" }` was **ADDED** to `apps/atlas/wrangler.jsonc` as the **W3 leg** of the documented 3-way cross-wave handoff (00-01 base in W1 → **00-03 services NOOP in W3** → 00-06 `secrets_store_secrets` in W4; strictly increasing waves keep the shared file race-free, and the NOOP binding lands in the SAME wave as the `env.NOOP.tick()` dispatcher code that uses it). **Every 00-01 block was preserved** — the `ATLAS`/`MORNING_CHAIN_DO` DO bindings, the `new_sqlite_classes:["AtlasCoordinator"]` migration, the `WIRE` `atlas-wire` producer, `D1`/`KV`/`R2`/`AI`/`vars`/`observability`/`staging-crons:[]`. The `wrangler deploy --dry-run` resolves `env.NOOP (atlas#NoopAgent)` as a Worker service binding. No `queues.consumers` block was added anywhere (Pillar 1).

## Accomplishments

- **SPINE-01 (ROADMAP Phase-0 Success Criterion 1) proven by an automated workerd test.** The `scheduled()` dispatcher routes only the known `45 12 * * *` cron (07:45 ET, EST form); inside the branch it (1) invokes the no-op agent over the private `env.NOOP.tick(...)` RPC, then (2) routes a canonical §6.4 event (`agent:"Atlas"`, `type:"noop.tick"`, `entity:"spine"`, `op:"append"`) onto the Wire via the `@atlas/wire` `send()` producer with a structured `atlas:noop:<owner-local-date>` idempotency key. An unknown cron is a no-op (T-00-32).
- **AtlasCoordinator DO + D-10 heartbeat.** `beat()` persists `lastBeat`; `startHeartbeat()` arms the first alarm only if none is set; `alarm()` raises a P1 to Flagger via `flag(env, "P1", "orchestrator heartbeat stale", …)` when `Date.now() - lastBeat > 5 * 60_000`, then ALWAYS reschedules at +60s. Addressed only as `getByName("root")`.
- **NoopAgent (D-11 RPC target).** A `WorkerEntrypoint` with a single `tick()` returning `{ ok: true, at }` — no domain work, no public HTTP, reached only over the private self-binding.
- **`index.ts` rewritten** from the Wave-1 hello-world to the dispatcher; re-exports `AtlasCoordinator` (so the `new_sqlite_classes` migration resolves) and `NoopAgent` (so the services `entrypoint` resolves). The inbound-OAuth front door is deliberately NOT here (deferred to 00-06).
- **8/8 tests pass in workerd** (TZ=UTC): `scheduled.test.ts` (3) — Wire-contract via `WireEvent.parse`, tick-before-send order, unknown-cron no-op; `heartbeat.test.ts` (3) — healthy no-emit, >5-min-stale single P1 + reschedule, two `getByName("root")` resolve to one DO; plus the 2 Wave-1 smoke cases. Full repo: wire 8/8, shared 6/6, security passing, atlas 8/8.

## Task Commits

Each task was committed atomically:

1. **Task 1: AtlasCoordinator DO + 1-min heartbeat self-monitor (D-10)** — `acbb14d` (feat)
2. **Task 2: scheduled() dispatcher (SPINE-01) + no-op agent RPC target (D-11)** — `9be6c1d` (feat)
3. **Task 3: SPINE-01 + heartbeat suites in workerd** — `91cc294` (test)
4. **Task 4: no-op services self-binding (NOOP -> atlas) (GLOBAL-4 W3 leg)** — `a50cae6` (feat)

**Plan metadata:** (this commit) `docs(00-03): complete Atlas orchestrator runtime plan`

## Files Created/Modified

- `apps/atlas/src/coordinator.ts` — `class AtlasCoordinator extends DurableObject<Env>`: `beat()`/`startHeartbeat()`/`override alarm()`; D-10 staleness → P1 via `flag()`; Intl/America/Toronto date.
- `apps/atlas/src/noop-agent.ts` — `class NoopAgent extends WorkerEntrypoint<Env>`: single `tick()` RPC, no domain work.
- `apps/atlas/src/index.ts` — the `scheduled()` dispatcher (replaces the Wave-1 hello-world); `localDate()` helper; re-exports `AtlasCoordinator` + `NoopAgent`; local `Env` extends `@atlas/shared` `Env` with `NOOP: Service<NoopAgent>`.
- `apps/atlas/test/scheduled.test.ts`, `apps/atlas/test/heartbeat.test.ts` — the two workerd suites.
- `apps/atlas/wrangler.jsonc` — added the `services` NOOP self-binding (W3 leg); all 00-01 blocks preserved.
- `apps/atlas/wrangler.test.jsonc` — mirrored the NOOP binding (`service:"atlas-test"`).
- `apps/atlas/package.json` — `@atlas/wire` + `@atlas/shared` workspace deps.
- `apps/atlas/tsconfig.json` — `types: ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types"]`.
- `pnpm-lock.yaml` — apps/atlas importer links the two packages.

## Decisions Made

- **NoopAgent = `WorkerEntrypoint`, not an agents-SDK `Agent`.** A no-domain-work RPC smoke target needs only a callable public method over a service binding; `WorkerEntrypoint` is the lightest correct shape and avoids the Agent runtime for a Phase-0 target.
- **D-11 transport = a SELF service-binding** (`service:"atlas"` / `service:"atlas-test"`) so the no-op target is reachable only over a private in-Worker RPC, never a public HTTP route (T-00-31).
- **Heartbeat detail surfaces the owner-local date** (Intl/America/Toronto) for observability; the canonical structured flag `id` (and its own date) is built inside `@atlas/shared` `flag()`.
- **Tests split by capture need:** synthetic spy-Env for the dispatcher (asserts shape + call order deterministically); real DO + `runInDurableObject` for the heartbeat (exercises real `ctx.storage` + `alarm()` + the `getByName("root")` single-instance invariant in workerd).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `override` modifier required on `alarm()`**
- **Found during:** Task 1 typecheck.
- **Issue:** The repo's `tsconfig.base.json` sets `noImplicitOverride: true`. `alarm()` overrides the optional base-class `alarm?()` on `DurableObject`, so strict TS errored `TS4114: This member must have an 'override' modifier`.
- **Fix:** Added the `override` modifier to `alarm()`. No behavior change.
- **Files modified:** `apps/atlas/src/coordinator.ts`.
- **Verification:** `pnpm --filter @atlas/atlas typecheck` exits 0.
- **Committed in:** `acbb14d`.

**2. [Rule 3 - Blocking] Comment-token grep hygiene (randomUUID / OAuthProvider)**
- **Found during:** Task 2 acceptance verification.
- **Issue:** The plan's acceptance greps require `grep -c 'randomUUID'` == 0 and `grep -c 'OAuthProvider'` == 0 in `index.ts`. My explanatory comments quoted both forbidden tokens (to warn against them), tripping the structural gates with false-positive counts — the exact issue 00-02 hit (deviation #2).
- **Fix:** Rephrased the comments ("a random per-run UUID", "inbound-OAuth provider") without the literal tokens. No code/behavior change.
- **Files modified:** `apps/atlas/src/index.ts`.
- **Verification:** Both greps now read 0; full Task-2 gate set PASS.
- **Committed in:** `9be6c1d`.

**3. [Rule 3 - Blocking] cloudflare:test ambient types not registered for tsc**
- **Found during:** Task 3 typecheck (the tests run fine in workerd; `tsc --noEmit` could not resolve `import … from "cloudflare:test"`).
- **Issue:** `apps/atlas/tsconfig.json` inherited only `types: ["@cloudflare/workers-types"]`, and `types` does NOT merge across `extends`. The `cloudflare:test` ambient module is declared in the package's `./types` subpath export (`types/cloudflare-test.d.ts`), not its main types entry — so `@cloudflare/vitest-pool-workers` alone did not resolve it.
- **Fix:** Set `types: ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types"]` in `apps/atlas/tsconfig.json`.
- **Files modified:** `apps/atlas/tsconfig.json`.
- **Verification:** `pnpm --filter @atlas/atlas typecheck` exits 0; 8/8 tests pass in workerd.
- **Committed in:** `91cc294`.

**4. [Rule 3 - Blocking] @atlas/wire + @atlas/shared not yet workspace deps of apps/atlas**
- **Found during:** Task 1 (importing `flag`/`Env` from `@atlas/shared` in `coordinator.ts`).
- **Issue:** `apps/atlas/package.json` declared no `dependencies`; the Wave-2 packages were not linked into the app, so the imports would not resolve.
- **Fix:** Added `"@atlas/shared": "workspace:*"` + `"@atlas/wire": "workspace:*"` and ran `pnpm install` (workspace LINK only — no new registry package was downloaded, so the package-legitimacy checkpoint does not apply).
- **Files modified:** `apps/atlas/package.json`, `pnpm-lock.yaml`.
- **Verification:** typecheck + tests pass; `pnpm install` reported "Already up to date" (deps already in the closure from Wave 1/2).
- **Committed in:** `acbb14d`.

**Total deviations:** 4 auto-fixed (all Rule 3 blocking — strict-TS modifier, grep hygiene, test-types registration, workspace linking). No scope creep, no architectural changes, no checkpoints. The plan's intended behavior shipped exactly.

## Issues Encountered

- **Transient connection error mid-execution** (not a work failure): the agent was interrupted by a `ConnectionRefused` after Task 1 was committed and Tasks 2's WIP (`index.ts` + `noop-agent.ts`) were in the tree. The orchestrator verified disk state and resumed; `git log` was the source of truth (`acbb14d` intact, no redo). The orchestrator also removed two stale macOS-sync `" 2"` duplicate artifacts (`.planning/STATE 2.md`, `apps/atlas/vitest.config 2.ts`) — the canonical files were used and no duplicates were recreated.
- **A project pre-edit hook flagged a Pillar-1 false positive** when the `services` edit's diff context spanned the adjacent `queues` (`atlas-wire`) block. Re-anchoring the same `services` addition away from the `queues` block (after the `ai` binding) cleared it. No consumer block was ever added (`grep -c consumers apps/atlas/wrangler.jsonc` == 0).

## Known Stubs

None. The dispatcher routes a real §6.4 event through the real `@atlas/wire` producer; the DO runs a real `ctx.storage` heartbeat and emits a real Flagger event via `@atlas/shared` `flag()`; the NoopAgent is a real RPC target resolved by a real services self-binding (confirmed in the dry-run). The `NOOP.tick()` is intentionally a no-op smoke target (that is its specified Phase-0 role — SPINE-01 proves the schedule→invoke→send path, not domain work).

## Threat Flags

None. No new security-relevant surface beyond the plan's `<threat_model>` was introduced. The mitigations the register assigned `mitigate` are all in place: known-cron-only routing (T-00-32), private service-binding RPC / no public HTTP (T-00-31), producer-only posture (T-00-33), preserved cross-wave config (T-00-38), heartbeat-staleness escalation (T-00-34), stable idempotency key / no random UUID (T-00-35), and always-reschedule alarm (T-00-37).

## Next Phase Readiness

- **00-04 (Steward crux + the lone Wire consumer):** Atlas now emits real §6.4 events onto `atlas-wire`; Atlas is confirmed producer-only, so Steward can safely become the sole consumer. Steward's `consumers` block (the ONE allowed) lands in 00-04 — repo-wide there are currently zero consumer blocks.
- **00-06 (OAuth front door):** `apps/atlas/src/index.ts` is kept cleanly separable so 00-06 can compose the inbound-auth provider WITH this dispatcher; 00-06 also adds the W4 `secrets_store_secrets` leg to the same `wrangler.jsonc` (GLOBAL-4).
- **Phase 1 (morning chain):** inherits the dispatcher switch, the `getByName("root")` DO, the structured idempotency-key convention, and the heartbeat self-supervision.

## Self-Check: PASSED

- All created files exist on disk (`coordinator.ts`, `noop-agent.ts`, `scheduled.test.ts`, `heartbeat.test.ts`) and all modified files reflect the changes (`index.ts` dispatcher, `wrangler.jsonc` NOOP services, `tsconfig.json` types).
- All four task commits present in git history (`acbb14d`, `9be6c1d`, `91cc294`, `a50cae6`).
- Verification gates green: `pnpm --filter @atlas/atlas typecheck` exits 0; `pnpm --filter @atlas/atlas test` → 8/8 in workerd (TZ=UTC); `wrangler deploy --dry-run` resolves `env.NOOP (atlas#NoopAgent)` and all 8 bindings.
- Pillar 1 confirmed: `grep -cE 'consumers|async queue'` == 0 in `index.ts` and `coordinator.ts`; `grep -c 'consumers'` == 0 in `wrangler.jsonc`; no second `atlas-wire` consumer anywhere in the repo.
- `grep -c 'randomUUID'` == 0 and `grep -c 'OAuthProvider'` == 0 in `index.ts`; `export { AtlasCoordinator }` present.

---
*Phase: 00-spine*
*Completed: 2026-06-04*
