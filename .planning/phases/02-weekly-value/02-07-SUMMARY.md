---
phase: 02-weekly-value
plan: "07"
subsystem: atlas-cadence-integration
tags: [atlas, scheduled, cron, dst, service-binding, steward, weekly-review, d2-11, weekly-01]
dependency_graph:
  requires:
    - "02-04 (Scout.weekly service-binding target)"
    - "02-05 (Headhunter full/deadlines service-binding targets + funnel upserts)"
    - "02-06 (Herald.weekly service-binding target + herald:weekly digest)"
    - "02-01 (RawIncident/flag substrate + steward-core applyEvent/vault_outbox path)"
  provides:
    - "Atlas scheduled() 4 standalone Phase-2 cron cases (D2-11) — NOT MorningChain steps"
    - "Atlas SCOUT/HEADHUNTER/STEWARD service bindings + expanded EDT crons"
    - "Steward.weeklyReviewBuild() WorkerEntrypoint RPC (Fri-16:30 build target)"
    - "weeklyReview() / buildWeeklyReviewEvent() — idempotent op:upsert weekly-review build"
    - "op:upsert/entity:flag replay-idempotency test (CLAUDE.md DoD #2 for the flag-upsert shape)"
  affects:
    - apps/atlas
    - apps/steward
tech_stack:
  added: []
  patterns:
    - "Dual EDT/EST cron CASES route to one handler (DST-safe; only the active form in triggers.crons)"
    - "Promise.allSettled Friday fan-in (one leg's failure never discards the other's result)"
    - "Per-leg catch→flag(P2)→continue under _ctx.waitUntil (surface, never throw out of scheduled())"
    - "Plain-object RPC-surface binding types (Headhunter-FORGE pattern, NOT Service<T> which needs WorkerEntrypointBranded)"
    - "WorkerEntrypoint default export hosting queue() consumer + fetch() + RPC method (combined entrypoint)"
    - "weekly-review build emits ONE op:upsert Wire event via existing producer path (no new writer/consumer)"
    - "steward:weekly-review:<date> stable idempotency key (REPLACE, like compass:plan:<date>)"
key_files:
  created:
    - apps/steward/src/weekly-review.ts
    - apps/steward/test/weekly-review.test.ts
  modified:
    - apps/atlas/src/index.ts
    - apps/atlas/src/env.ts
    - apps/atlas/wrangler.jsonc
    - apps/atlas/test/scheduled.test.ts
    - apps/steward/src/index.ts
    - apps/steward/test/replay.test.ts
decisions:
  - "triggers.crons lists ONLY the active (EDT) form per ET slot — listing both DST forms would double-fire (the off-season form runs an hour off); the switch carries both forms as cases so the Nov hand-edit only touches wrangler crons (Rule-1 correction vs the literal 'both forms in crons' phrasing)"
  - "New RPC bindings typed as plain object types with the minimal method surface (the existing Headhunter-FORGE pattern), because Service<T> requires T to extend WorkerEntrypointBranded which a bare interface does not satisfy"
  - "Steward default export converted to a WorkerEntrypoint class that DELEGATES queue() verbatim to stewardConsumer — Steward stays the SOLE atlas-wire consumer (guard-wire-consumer.js exit 0)"
  - "weeklyReviewBuild v1 reads an EMPTY week (live D1/digest/funnel/flags reads deferred to go-live, matching Scout/Headhunter injectable-data deferral); the note still renders a real quiet-week summary, not a stub"
  - "weekly-review writes via ONE op:upsert Wire event (RESEARCH 'Event bus → Steward; Steward compiles'), applied by Steward's own consumer through the existing vault_outbox path — no new writer/consumer"
metrics:
  duration: "~12 minutes (post-checkpoint execution)"
  completed: "2026-06-05T23:25:30Z"
  tasks: 3
  files_changed: 8
  commits: 4
---

# Phase 02 Plan 07: Atlas Phase-2 Cadence Integration Summary

**One-liner:** Atlas's `scheduled()` dispatcher gains 4 standalone dual-EDT/EST cron cases (Headhunter deadlines + full, Friday Scout+Herald via `Promise.allSettled`, Friday 16:30 build) wired to new SCOUT/HEADHUNTER/STEWARD service bindings; Steward gains an idempotent `weeklyReviewBuild()` that compiles the 16:30 weekly-review note via one `op:upsert` Wire event — Steward stays the sole atlas-wire consumer; full suite green.

## What Was Built

### Task 1 — Cron-cap human-verify checkpoint (owner-approved)

The blocking `checkpoint:human-verify` gate (RESEARCH A1, LOW confidence) was reached FIRST (it is the plan's first task) and returned as a structured checkpoint. The owner resolved it **"approved — crons fit"** with evidence:

- **Docs:** Cloudflare changelog (2023-10-18, confirmed via Context7) — *"The previous limit of 3 Cron Triggers per Worker has been removed. However, account-level limits on the total number of Cron Triggers across all Workers still apply."* The historical per-Worker 3-cron Free cap no longer exists.
- **Dry-run:** `wrangler deploy --dry-run --config apps/atlas/wrangler.jsonc` with the full 5-cron list (`45 11 * * 1-5` · `0 13 * * *` · `0 13 * * 1` · `0 20 * * 5` · `30 20 * * 5`) → exit 0, no trigger-limit error. Config reverted afterward.
- **Account total:** 6 cron triggers across 2 Workers post-Phase-2 (atlas 5 + flagger-watchdog 1) — fits Free. No secret seeded, no flag flipped (infra-verify only).

The executor did NOT self-approve — it halted and returned checkpoint state; the owner supplied the approval before Tasks 2–3 ran.

### Task 2 — Atlas scheduled() 4 standalone cron cases + bindings + crons (TDD)

**RED commit:** `910691c` — 10 new tests assert each dual EDT/EST cron form routes to the right agent RPC, the Friday case uses `allSettled` (Scout reject → Herald still runs + P2 surfaced), and each leg never throws out of `scheduled()`.

**GREEN commit:** `d2514da`

- `apps/atlas/src/index.ts`: 4 new STANDALONE cron cases appended to the existing `switch (controller.cron)` — NOT new MorningChain Workflow steps (the morning chain is untouched; `MORNING_CHAIN` reference count unchanged at 1):
  - `"0 13 * * *" / "0 14 * * *"` → `env.HEADHUNTER!.deadlines({ date })`
  - `"0 13 * * 1" / "0 14 * * 1"` → `env.HEADHUNTER!.full({ date })`
  - `"0 20 * * 5" / "0 21 * * 5"` → `Promise.allSettled([SCOUT.weekly, HERALD.weekly])` (each leg wrapped in `catch→flag(P2)→return null`)
  - `"30 20 * * 5" / "30 21 * * 5"` → `env.STEWARD!.weeklyReviewBuild({ date })`
  - Each leg runs under `_ctx.waitUntil` with a best-effort `catch→flag(P2, kind:chain_halted)→swallow`; uses `localDate(env)` for the date.
- `apps/atlas/src/env.ts`: typed RPC-surface bindings for `SCOUT`, `HEADHUNTER`, `STEWARD` (and `HERALD.weekly`) using the plain-object-type pattern (matching Headhunter's FORGE binding) so `env.X.method({date})` typechecks without coupling Atlas to each agent's full type.
- `apps/atlas/wrangler.jsonc`: added `SCOUT`/`HEADHUNTER`/`STEWARD` service bindings; `triggers.crons` expanded to the 5 active EDT forms, each annotated with its ET meaning + the EST form to hand-edit at the Nov DST boundary. Staging crons remain `[]`.
- **Tests:** 58 atlas tests green (10 new + 48 existing), 2 skipped (live OAuth). `pnpm --filter @atlas/atlas typecheck` exit 0.

### Task 3 — Steward.weeklyReviewBuild() weekly-review build (TDD)

**RED commit:** `8eb3333` — `weekly-review.test.ts` (§6.4 Wire-contract: `op:upsert`, `steward:weekly-review:<date>` key, `Dashboard/Weekly Review` note, all 4 sections in the body, graceful empty-week, no placeholder leakage; `weeklyReview()` emits exactly one event; re-run = same stable key) + extended `replay.test.ts` with an `op:upsert`/`entity:flag` replay-idempotency case (`flg:<date>:<agent>:<hash>` — second apply returns `{applied:false}`, no double-write).

**GREEN commit:** `4a09a94`

- `apps/steward/src/weekly-review.ts`: `buildWeeklyReviewBody()` (pure; 4 sections — surfaced Scout events, Herald week-in-review digest, jobs-funnel snapshot, open flags), `buildWeeklyReviewEvent()` (`op:upsert`, `Dashboard/Weekly Review` note, stable `steward:weekly-review:<date>` key), and `weeklyReview(env, date, input)` which emits ONE `op:upsert` Wire event via `send()`.
- `apps/steward/src/index.ts`: default export converted from a plain `ExportedHandler` object to a `WorkerEntrypoint` class `Steward` that hosts (a) the SOLE atlas-wire `queue()` consumer (delegated verbatim to `stewardConsumer.queue` — Pillar 1), (b) the `fetch()` stub, and (c) the new `weeklyReviewBuild({date})` RPC. Atlas's `STEWARD` binding has no `entrypoint`, so RPC calls resolve against this default export.
- **Pillar 1 intact:** the new build writes via ONE `op:upsert` Wire event that Steward's own consumer applies through the existing `applyEvent → vault_outbox` path — no new Vault writer, no new atlas-wire consumer. `node .claude/hooks/guard-wire-consumer.js` exits 0; Steward is the only `atlas-wire` consumer (flagger → `atlas-incidents`, dlq-sink → `atlas-wire-dlq`).
- **Idempotent:** re-running for the same date emits the same stable key → `op:upsert` REPLACES the weekly note; the ledger dedups the second apply (`meta.changes===0`), proven by the new replay case.
- **Tests:** 26 steward tests green (20 prior + 6 new), `pnpm --filter @atlas/steward typecheck` exit 0.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `triggers.crons` must NOT carry both DST forms (would double-fire)**
- **Found during:** Task 2 — wiring the wrangler crons against the owner's "include BOTH the EDT and EST forms" phrasing
- **Issue:** Listing both the EDT and EST UTC forms in `triggers.crons` would register both as live triggers — during EDT, both `0 20 * * 5` AND `0 21 * * 5` would fire (one at 16:00 ET, the other an hour off at 17:00 ET), double-running the Friday build. The CLAUDE.md gotcha ("Hand-edit at each DST boundary") and the existing morning-cron (`45 11 * * 1-5` only) confirm the convention is to list ONLY the currently-active form. The owner's own dry-run evidence used exactly the 5 EDT forms, not 9.
- **Fix:** `triggers.crons` lists only the active EDT form per ET slot; the EST form is annotated inline for the Nov hand-edit. The dual EDT/EST requirement is satisfied by the dual CASES in the `scheduled()` switch (both forms route to one handler), so a DST hand-edit only swaps the wrangler cron line — never the switch.
- **Files modified:** `apps/atlas/wrangler.jsonc`
- **Commit:** `d2514da`

**2. [Rule 3 - Blocking] Typed RPC bindings via plain object types, not `Service<T>`**
- **Found during:** Task 2 — typecheck after adding the cron cases
- **Issue:** Typing the new bindings as `Service<ScoutRpc>` etc. failed with TS2344 — the `Service<T>` generic constrains `T` to `WorkerEntrypointBranded`, which a plain RPC-surface interface does not satisfy. Without typing, `env.HEADHUNTER!.deadlines(...)` failed with TS2339 (the bare `Service` type only exposes `fetch`/`connect`).
- **Fix:** Typed each binding as a plain object type with the minimal RPC method surface (the exact pattern Headhunter already uses for its FORGE binding) — `env.X.method({date})` typechecks without the branded-type constraint.
- **Files modified:** `apps/atlas/src/env.ts`
- **Commit:** `d2514da`

**3. [Rule 3 - Blocking] `queue` needs an `override` modifier on the WorkerEntrypoint subclass**
- **Found during:** Task 3 — typecheck after converting Steward's default export to a `WorkerEntrypoint` class
- **Issue:** `WorkerEntrypoint` declares `queue` as a base-class member, so the subclass override required the `override` modifier (TS4114) under the repo's `strict` tsconfig.
- **Fix:** Added `override` to both `queue()` and `fetch()`.
- **Files modified:** `apps/steward/src/index.ts`
- **Commit:** `4a09a94`

### Checkpoint Note

The cron-cap blocking human-verify gate (Task 1) was **owner-approved ("crons fit")** with docs (per-Worker 3-cron cap removed Oct 2023) + dry-run (exit 0, no trigger-limit error) evidence. This is normal gated flow, not a deviation — recorded here per the orchestrator's request.

## Known Stubs

- **`weeklyReviewBuild` v1 reads an EMPTY week.** The live reads (week's Scout events from D1, the `herald:weekly` digest, the Headhunter funnel counters, open Flagger flags) are deferred to go-live — the same injectable-data deferral Scout (02-04) and Headhunter (02-05) made. This is NOT a goal-blocking stub: the build path, the idempotent `op:upsert` emit, the Steward RPC wiring, and the Atlas cron case are all complete and tested; the note renders a real quiet-week summary (not a placeholder). When the OAuth/read paths clear, only the `emptyWeek()` helper in `apps/steward/src/index.ts` is replaced with the live reads — the contract and tests stand.

## Threat Flags

No new network endpoints, auth paths, or trust boundaries beyond the plan's declared threat model. The 4 new crons are Cloudflare-internal triggers (no external input); the agent RPCs are private Worker-to-Worker service bindings (D-11). Mitigations applied:

- **T-02-cron1** (wrong DST cron form): mitigated — EDT form in wrangler now (active June); dual EDT/EST cases in the switch; EST forms annotated for the Nov hand-edit.
- **T-02-cron2** (Scout failure discards Herald's work): mitigated — `Promise.allSettled`, each leg wrapped in `catch→flag(P2)`; the 16:30 build runs on a partial summary, never blocked.
- **T-02-cron3** (Free per-Worker cron cap): mitigated — blocking human-verify owner-approved before the cron expansion; per-Worker cap confirmed removed (Oct 2023).
- **T-02-wr** (second Vault writer / atlas-wire consumer): mitigated — the build writes via ONE `op:upsert` Wire event Steward's own consumer applies; `guard-wire-consumer.js` exit 0; Steward is the sole atlas-wire consumer (Pillar 1).
- **T-02-SC** (npm installs): accepted — no new package installs in this plan.

## Self-Check: PASSED

Files exist:
- FOUND: apps/steward/src/weekly-review.ts
- FOUND: apps/steward/test/weekly-review.test.ts
- FOUND: apps/atlas/src/index.ts (modified)
- FOUND: apps/atlas/wrangler.jsonc (modified)
- FOUND: apps/steward/src/index.ts (modified)

Commits exist:
- 910691c: test(02-07): RED — failing tests for Atlas Phase-2 standalone cron cases
- d2514da: feat(02-07): GREEN — Atlas Phase-2 standalone cron cases + bindings + crons
- 8eb3333: test(02-07): RED — Steward weekly-review build + flag-upsert replay case
- 4a09a94: feat(02-07): GREEN — Steward.weeklyReviewBuild() weekly-review build

Acceptance criteria:
- 4 new cases dispatch standalone RPCs, NOT new MorningChain steps (`grep -c "MORNING_CHAIN" apps/atlas/src/index.ts` = 1, unchanged) ✓
- Friday 16:00 uses `Promise.allSettled` (`grep -c "Promise.allSettled" apps/atlas/src/index.ts` ≥ 1) ✓
- Both EDT and EST forms are dual cases in the switch; wrangler crons use the EDT forms ✓
- `apps/atlas/wrangler.jsonc` services include scout, headhunter, steward bindings ✓
- `apps/steward/src/index.ts` exposes `weeklyReviewBuild()` as a WorkerEntrypoint RPC ✓
- Build writes via existing vault_outbox path; Steward remains the SOLE atlas-wire consumer (guard exit 0) ✓
- Re-running for the same date REPLACES the weekly note (idempotent, stable key) ✓
- `replay.test.ts` contains an `op:upsert`/`entity:flag` replay case (second apply `{applied:false}`) ✓
- `pnpm --filter @atlas/atlas typecheck` exit 0 · `pnpm --filter @atlas/steward typecheck` exit 0 ✓
- `pnpm --filter @atlas/atlas test` (58 passed, 2 skipped) · `pnpm --filter @atlas/steward test` (26 passed) ✓
- `pnpm -r typecheck` exit 0 · full `pnpm test` exit 0 (all packages green, no regression) ✓
