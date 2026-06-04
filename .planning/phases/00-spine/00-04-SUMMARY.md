---
phase: 00-spine
plan: 04
subsystem: steward-crux
tags: [steward, durable-objects, queues-consumer, d1, idempotency, blockConcurrencyWhile, vault-outbox, dlq, single-writer, spine-02, spine-05, vitest-workerd]

# Dependency graph
requires:
  - phase: 00-spine (00-01)
    provides: "apps/steward/wrangler.jsonc skeleton (STEWARD_LOCK DO, WIRE producer, DB/CONFIG, new_sqlite_classes:[StewardWriter]), migrations/0001_init_core.sql (idempotency_keys/counters/run_log/audit_log/vault_outbox), atlas-wire + atlas-wire-dlq queues, apps/steward/vitest.config.ts + wrangler.test.jsonc (vitest-pool-workers v4, nodejs_compat)"
  - phase: 00-spine (00-02)
    provides: "@atlas/wire (the single §6.4 WireEvent zod schema), @atlas/shared (Env binding surface + flag(env,severity,title,detail?) Flagger-emit)"
  - phase: 00-spine (00-03)
    provides: "Confirmed agents@0.14.1 DurableObject<Env> base-class API (cloudflare:workers, protected ctx, blockConcurrencyWhile); Atlas confirmed producer-only so Steward is safely the sole consumer; vitest-pool-workers v4 cloudflareTest plugin + cloudflare:test-types registration pattern"
provides:
  - "@atlas/steward-core: applyEvent(db,e) — the atomic op→D1 critical section (ONE db.batch: conditional absolute counter bump + INSERT OR IGNORE ledger; meta.changes===0 ⇒ {applied:false} replay-skip; positional ? only) + toOutboxIntent(e) — the SINGLE op→Local-REST-v3 map (GLOBAL DECISION 5; never a destructive verb, Pillar 2)"
  - "StewardWriter DO: apply() wraps applyEvent in this.ctx.blockConcurrencyWhile (the slow Obsidian write is NOT in the lock — only dedup+ledger+counter+vault_outbox-enqueue); counter(entity) read; addressed ONLY as getByName(\"vault\")"
  - "The SINGLE atlas-wire consumer (apps/steward/src/steward-consumer.ts): env.STEWARD_LOCK.getByName(\"vault\"), serial for…of, malformed→flag P3+msg.ack() (no poison-loop), transient→msg.retry({delaySeconds:60})+P2 at attempts>=4 → atlas-wire-dlq"
  - "apps/steward/wrangler.jsonc: the SOLE atlas-wire consumers block (max_concurrency:1, dead_letter_queue:atlas-wire-dlq, no retry_delay_secs) — Pillar 1 CI one-writer gate passes (exactly 1)"
  - "The three mandatory SPINE-02 tests green in workerd: replay (meta.changes===0), serialize (50 concurrent → exact sum), malformed (ack+P3, no write)"
affects:
  - "00-05 (DLQ sink): the consumer→DLQ wiring (dead_letter_queue:atlas-wire-dlq + transient→P2) is in place; the atlas-wire-dlq CONSUMER + audit-row sink is 00-05"
  - "00-08 (Obsidian bridge / outbound daemon): IMPORTS toOutboxIntent from @atlas/steward-core (must NOT define a second op→REST map); drains the pending vault_outbox intents Steward enqueues inside the lock"
  - "Phase 1 morning chain: every agent's §6.4 events now have a real serialized, idempotent sink — Steward applies them once, replay-safe"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "The atomic critical section runs as ONE db.batch([counter-bump, ledger-insert]) inside blockConcurrencyWhile — STATEMENT ORDER is load-bearing (counter bump BEFORE ledger insert so its WHERE NOT EXISTS sees pre-insert state)"
    - "Replay detection reads the LEDGER INSERT OR IGNORE's meta.changes (0 ⇒ key present ⇒ replay ⇒ {applied:false}); counters are ABSOLUTE (value = value + ?)"
    - "Local Env narrows the shared STEWARD_LOCK via Omit+re-declare (interface extends cannot retype a property) so steward.apply() typechecks over DO RPC; queue handler typed satisfies ExportedHandler<Env, WireEvent> (the 2nd generic is the queue message type)"
    - "D1 migrations are applied per-test in a setupFiles beforeAll via applyD1Migrations(env.DB, inject('migrations')); the pool does NOT auto-apply (readD1Migrations on the Node side → provide → inject)"
    - "Pool storage resets between test FILES (each file's beforeAll re-applies migrations to a fresh D1) but NOT between it() blocks within one file — tests use distinct counter names to stay independent"

key-files:
  created:
    - "packages/steward-core/{package.json,tsconfig.json,vitest.config.ts,src/apply.ts,src/op-mapping.ts,src/index.ts}"
    - "apps/steward/src/steward.ts — StewardWriter DO (apply via blockConcurrencyWhile + counter read)"
    - "apps/steward/src/steward-consumer.ts — the SINGLE atlas-wire consumer"
    - "apps/steward/test/{replay,serialize,malformed}.test.ts + apps/steward/test/apply-migrations.ts (migration setup)"
  modified:
    - "apps/steward/src/index.ts — wires the consumer queue() handler + re-exports StewardWriter (replaced the Wave-1 skeleton)"
    - "apps/steward/wrangler.jsonc — ADDED the SOLE atlas-wire consumers block (Pillar 1)"
    - "apps/steward/wrangler.test.jsonc — mirrored the consumers block so the pool delivers batches to queue()"
    - "apps/steward/vitest.config.ts — reads migrations/ + provides them; setupFiles applies them per test"
    - "apps/steward/package.json — @atlas/wire/@atlas/shared/@atlas/steward-core workspace deps; tsconfig.json — cloudflare:test ambient types + test/**/*.ts include"
    - "pnpm-lock.yaml — new steward-core importer + apps/steward links"

key-decisions:
  - "[Rule 1 - Bug] Fixed a double-count in the build-plan T5 critical-section snippet: with the ledger insert FIRST and the counter bump SECOND inside one db.batch(), SQLite makes statement (1)'s key insert visible to statement (2), so the bump's WHERE NOT EXISTS (... key=?) always finds the just-inserted key and the UPDATE is silently skipped — distinct keys never advance the counter past the first row's initial INSERT. Reordered to [counter-bump, ledger-insert]; replay detection now reads result[1] (the ledger insert). serialize.test.ts proves 50 distinct-key applies sum to 50 (was 1)."
  - "agents@0.14.1 DO base-class API re-confirmed (Open Question 1) by reading the installed @cloudflare/workers-types@4.20260603.1 .d.ts: DurableObject<Env> from cloudflare:workers, constructor(ctx: DurableObjectState, env: Env), protected ctx, this.ctx.blockConcurrencyWhile, D1Result.meta.changes:number, DurableObjectNamespace.getByName. The build-plan T5 snippet matches the installed API verbatim (other than the ordering bug above)."
  - "Used the vitest-pool-workers v4 cloudflareTest plugin (NOT the plan's defineWorkersConfig/isolatedStorage — removed in pool 0.16, same Rule-3 deviation Wave-1 established). Per-test storage isolation is the v4 default."
  - "Wired D1 migrations into the pool via readD1Migrations (Node) → provide → inject → applyD1Migrations in a setupFiles beforeAll — the pool does not auto-apply migrations to the test D1."
  - "op-mapping defines exactly ONE op→Local-REST-v3 map (GLOBAL DECISION 5) with a safe-verb allow-list (PATCH/POST only); no branch can yield a destructive verb (Pillar 2)."

patterns-established:
  - "STATEMENT ORDER inside the critical-section batch is part of the contract: counter-bump BEFORE ledger-insert (documented at length in apply.ts) — any future op handler MUST preserve it or it silently double-skips counters"
  - "Tests own no cross-it state assumptions: distinct counter names per it() (pool resets D1 per-file, not per-it in this pool version)"
  - "Explanatory comments avoid the literal forbidden tokens (the parallel-fan-out helper name, the stale per-consumer retry-delay key) so the structural grep gates read the CODE, not the prose (same hygiene as 00-02/00-03)"

requirements-completed: [SPINE-02, SPINE-05]

# Metrics
duration: ~30min
completed: 2026-06-04
---

# Phase 0 Plan 04: Steward Crux (Serialization + Idempotency) Summary

**THE CRUX of the spine is live: the `StewardWriter` DO runs the atomic dedup + counter-bump + ledger-insert as ONE `db.batch()` inside `blockConcurrencyWhile`, the SINGLE `atlas-wire` consumer routes every event through `getByName("vault")` with a serial `for…of` (malformed→ack+P3, transient→retry+P2→DLQ), `apps/steward` is the SOLE Worker with a consumers block on the bus (Pillar 1), and the three mandatory tests prove replay-idempotency (counter is 1 not 2), single-writer serialization (50 concurrent applies sum exactly), and malformed-ack-with-no-poison-loop — all green in workerd.**

## API confirmation (agents@0.14.1)

Open Question 1 (the single LOW-confidence area — the exact `agents@0.14.1` DO base-class API) was re-confirmed by **reading the installed type declaration** `@cloudflare/workers-types@4.20260603.1` (the version `agents@0.14.1` transitively pins). Context7 / cloudflare-docs MCP tools were not reachable from this agent (the known upstream tool-stripping bug); reading the resolved `.d.ts` is the authoritative equivalent (same method 00-03 used).

Confirmed surface (`experimental/index.d.ts`):
- **`DurableObject<Env, Props>`** exported from **`cloudflare:workers`**; `constructor(ctx: DurableObjectState, env: Env)`; the protected base field is **`ctx`** with **`this.ctx.blockConcurrencyWhile<T>(cb): Promise<T>`** and `this.ctx.storage`.
- **`DurableObjectNamespace.getByName(name)`** resolves the single named instance (one name = one instance = the single lock).
- **`D1Database.batch<T>(stmts): Promise<D1Result<T>[]>`**; **`D1Result.meta.changes: number`** (the replay detector).
- The build-plan T5 snippet matches the installed API **verbatim** — except for the statement-ordering double-count bug fixed here (see Deviations).

## Accomplishments

- **`@atlas/steward-core`** — `applyEvent(db, e)` is the pure, unit-testable op→D1 critical section: ONE `db.batch([conditional-absolute-counter-bump, INSERT-OR-IGNORE-ledger])` with positional `?` params only; the ledger insert's `meta.changes === 0` ⇒ `{ applied: false }` (replay-skip, any age — the ledger has no TTL, D-08). On apply it also writes a `run_log` row and enqueues a PENDING `vault_outbox` intent. `toOutboxIntent(e)` is the SINGLE op→Local-REST-v3 map (GLOBAL DECISION 5) — `increment`→`PATCH /vault/Counters/metrics.md`, `upsert`→`PATCH /vault/<note>.md`, `append`→`POST /vault/Dashboard/Heartbeat.md` — behind a PATCH/POST-only allow-list; no branch can emit a destructive verb (Pillar 2).
- **`StewardWriter` DO** — `apply(e)` wraps `applyEvent` in `this.ctx.blockConcurrencyWhile` so this single named DO serializes ALL writes; the slow Obsidian PATCH is NOT in the lock (only the `vault_outbox` PENDING intent is enqueued inside it). A `counter(entity)` read backs the tests. Addressed ONLY as `getByName("vault")`.
- **The SINGLE `atlas-wire` consumer** — `env.STEWARD_LOCK.getByName("vault")`, serial `for (const msg of batch.messages)` (never a parallel fan-out). Malformed (fails the §6.4 field-presence check) → `flag(env,"P3",…)` + `msg.ack()` + continue (ack, never retry — no poison-loop). Transient `apply()` throw → `msg.retry({delaySeconds:60})`, and at `msg.attempts >= 4` also `flag(env,"P2",…)`; exhausted retries fall to `atlas-wire-dlq`. `flag()` is called exactly `flag(env, severity, title, detail?)` (GLOBAL DECISION 2) — the consumer never hand-builds a Flagger event.
- **`apps/steward/wrangler.jsonc`** — the SOLE `atlas-wire` consumers block: `max_concurrency:1` (the belt) + `dead_letter_queue:atlas-wire-dlq` (SPINE-05) + `max_batch_size:10`/`max_batch_timeout:10`/`max_retries:5`, and NO invalid `retry_delay_secs` key (RESEARCH Pitfall 6). The CI one-writer structural gate (node-parse each `apps/*/wrangler.jsonc`) confirms exactly ONE consumer (Pillar 1; atlas has 0).
- **Three mandatory tests green in workerd** (TZ=UTC, 137ms total): `replay.test.ts` (2) — same key twice ⇒ `{applied:false}` + counter==1; `serialize.test.ts` (2) — two `getByName("vault")` ⇒ one DO, 50 concurrent distinct applies sum to 50; `malformed.test.ts` (1) — `msg.ack()` (no retry) + canonical Flagger P3 + zero counter/ledger writes. Full repo: security 7, wire 8, shared 6, atlas 8, **steward 5** = 34 tests green; `pnpm -r build` + `pnpm -r typecheck` pass.

## Task Commits

Each task was committed atomically:

1. **Task 1: `@atlas/steward-core` — atomic op→D1 critical section + op→Local-REST mapping** — `d475728` (feat)
2. **Task 2: StewardWriter DO + the SINGLE atlas-wire consumer + consumers block** — `59f8a2a` (feat)
3. **Task 3: replay/serialize/malformed suites green in workerd + fix double-count ordering bug** — `008488f` (test)

**Plan metadata:** (this commit) `docs(00-04): complete steward crux plan`

## Files Created/Modified

- `packages/steward-core/src/apply.ts` — `applyEvent(db,e)`: the atomic `db.batch([counter-bump, ledger-insert])` (positional `?`, absolute math, `meta.changes===0` replay-skip), run_log + vault_outbox enqueue.
- `packages/steward-core/src/op-mapping.ts` — `toOutboxIntent(e)`: the single op→Local-REST-v3 map with the PATCH/POST-only safe-verb guard.
- `packages/steward-core/src/index.ts` + `package.json`/`tsconfig.json`/`vitest.config.ts` — workspace package wiring.
- `apps/steward/src/steward.ts` — `StewardWriter extends DurableObject<Env>`: `apply()` (blockConcurrencyWhile) + `counter()`.
- `apps/steward/src/steward-consumer.ts` — the single consumer; local `Env` (Omit+retype `STEWARD_LOCK`); `satisfies ExportedHandler<Env, WireEvent>`.
- `apps/steward/src/index.ts` — wires `queue()` + re-exports `StewardWriter` (replaced the Wave-1 skeleton).
- `apps/steward/wrangler.jsonc` — the SOLE consumers block (`dead_letter_queue:atlas-wire-dlq`, `max_concurrency:1`, no `retry_delay_secs`).
- `apps/steward/wrangler.test.jsonc` — mirrored consumers block (test pool delivers batches to `queue()`).
- `apps/steward/test/{replay,serialize,malformed}.test.ts` + `test/apply-migrations.ts` — the three suites + the per-test D1 migration setup.
- `apps/steward/vitest.config.ts` — reads `migrations/` + `provide`s them; `setupFiles` applies them per test.
- `apps/steward/package.json` + `tsconfig.json`, `pnpm-lock.yaml` — workspace deps + cloudflare:test types + test include.

## Decisions Made

- **Statement order is the contract (see Deviations #1).** `[counter-bump, ledger-insert]` — the bump's `WHERE NOT EXISTS` must evaluate BEFORE the key is inserted, or the bump self-suppresses for every distinct key. Documented at length in `apply.ts`.
- **DO RPC typing.** The shared `Env` types `STEWARD_LOCK?` as an optional, untyped `DurableObjectNamespace`. A local `Env` `Omit`s and re-declares it as `DurableObjectNamespace<StewardWriter>` (interface `extends` cannot retype a property) so `steward.apply(e)` typechecks. The queue handler is `satisfies ExportedHandler<Env, WireEvent>` (the 2nd generic is the queue message type; without it the handler's `MessageBatch<WireEvent>` is incompatible with the default `MessageBatch<unknown>`).
- **Migrations into the pool.** The pool does not auto-apply D1 migrations; `readD1Migrations("../../migrations")` (Node side) → `provide({migrations})` → `inject("migrations")` → `applyD1Migrations(env.DB, …)` in a `setupFiles` `beforeAll`.
- **vitest-pool-workers v4 API** (`cloudflareTest`, not `defineWorkersConfig`) per the Wave-1-established deviation; per-test storage isolation is the v4 default (resets per file).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a double-count in the build-plan T5 critical-section (statement ordering)**
- **Found during:** Task 3 — `serialize.test.ts` (the test exists precisely to catch this).
- **Issue:** The build-plan T5 snippet (copied into `apply.ts` initially) orders the batch as `[INSERT OR IGNORE ledger, conditional counter bump]`. Inside ONE `db.batch()`, SQLite makes statement (1)'s key insert visible to statement (2), so the bump's `ON CONFLICT DO UPDATE SET value=value+? WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key=?)` ALWAYS finds the just-inserted key ⇒ the UPDATE is silently skipped. Effect: the counter only ever reflects the FIRST row's plain `INSERT INTO counters` (which the `WHERE` does not gate); every subsequent distinct-key apply leaves the counter unchanged. The 50-concurrent serialize test ended at **1, not 50**. (A targeted D1 probe confirmed: first apply → value 1, second DISTINCT-key apply → bump `meta.changes:0`, value stays 1.)
- **Fix:** Reordered the batch to `[conditional counter bump, INSERT OR IGNORE ledger]` so the bump evaluates `WHERE NOT EXISTS` against the state BEFORE the key is inserted; replay detection now reads `result[1]` (the ledger insert's `meta.changes`). The batch stays atomic (all-or-nothing), so a crash rolls back both and a retry re-applies once. Documented the ordering as a load-bearing contract in `apply.ts`.
- **Files modified:** `packages/steward-core/src/apply.ts`.
- **Verification:** `serialize.test.ts` now sums 50 distinct applies to exactly 50; `replay.test.ts` still gives counter==1 on replay; the probe confirmed first→1, distinct→2, replay→2 (no double-count).
- **Committed in:** `008488f`.

**2. [Rule 3 - Blocking] vitest-pool-workers v4 API + D1 migration wiring**
- **Found during:** Task 3 config.
- **Issue:** The plan's acceptance asked for `defineWorkersConfig` + `isolatedStorage:true`; the installed pool (`0.16.13`) ships only the v4 `cloudflareTest` plugin (the Wave-1 deviation). Separately, the pool does NOT auto-apply D1 migrations, so the steward tests (which need the five tables) would hit "no such table".
- **Fix:** Used the v4 `cloudflareTest({wrangler:{configPath},miniflare:{compatibilityFlags:["nodejs_compat"]}})` shape; wired migrations via `readD1Migrations` → `provide` → `inject` → `applyD1Migrations` in a `setupFiles` `beforeAll`. Avoided Node-only globals in the config (`readD1Migrations("../../migrations")` resolves against the app-dir cwd) since the toolchain has no `@types/node`.
- **Files modified:** `apps/steward/vitest.config.ts`, `apps/steward/test/apply-migrations.ts`, `packages/steward-core/vitest.config.ts`.
- **Verification:** All 5 steward tests green in workerd.
- **Committed in:** `008488f`.

**3. [Rule 3 - Blocking] DO RPC + queue-handler typing under strict TS**
- **Found during:** Task 2 typecheck.
- **Issue:** (a) A local `Env extends SharedEnv { STEWARD_LOCK: DurableObjectNamespace<StewardWriter> }` errored — `extends` cannot retype the shared optional `STEWARD_LOCK?`. (b) `satisfies ExportedHandler<Env>` rejected a `queue` handler typed `MessageBatch<WireEvent>` (incompatible with the default `MessageBatch<unknown>`).
- **Fix:** `Env extends Omit<SharedEnv,"STEWARD_LOCK"> { STEWARD_LOCK: DurableObjectNamespace<StewardWriter> }`; `satisfies ExportedHandler<Env, WireEvent>` (the 2nd generic types the queue message). Also added the `cloudflare:test` ambient types + `test/**/*.ts` include to `apps/steward/tsconfig.json` (the 00-03 pattern).
- **Files modified:** `apps/steward/src/steward-consumer.ts`, `apps/steward/src/index.ts`, `apps/steward/tsconfig.json`.
- **Verification:** `pnpm -r typecheck` exits 0.
- **Committed in:** `59f8a2a`.

**4. [Rule 1 - Bug avoidance] Grep-gate comment hygiene + array-index strict TS**
- **Found during:** Task 1/2 acceptance verification.
- **Issue:** (a) `result[0]` tripped `noUncheckedIndexedAccess` ("possibly undefined"). (b) Explanatory comments quoted the forbidden tokens the gates check against (the parallel-fan-out helper name in `steward-consumer.ts`, the stale per-consumer retry-delay key in `wrangler.jsonc`), tripping `! grep -q "Promise.all"` / `! grep -q "retry_delay_secs"` on the PROSE (the same false-positive 00-02/00-03 hit).
- **Fix:** Guarded the array access (`const r = result[1]; if (!r || …)`); rephrased the comments to describe the forbidden forms without the literal tokens. No behavior change.
- **Files modified:** `packages/steward-core/src/apply.ts`, `apps/steward/src/steward-consumer.ts`, `apps/steward/wrangler.jsonc`.
- **Verification:** typecheck 0; all structural gates read the intended counts.
- **Committed in:** `d475728` / `59f8a2a`.

**Total deviations:** 2 auto-fixed bugs (1 real double-count caught by the serialize test, 1 grep/strict-TS hygiene) + 2 Rule-3 blocking (test-harness API/migration wiring, DO-RPC/queue typing). No scope creep, no architectural changes, no checkpoints. The intended behavior — serialized, idempotent, single-writer Steward — shipped.

## Issues Encountered

- The build-plan's own T5 code had a latent double-count (Deviation #1) — exactly the class of bug the phase exists to prevent ("retrofitting idempotency after counters exist means reconciling double-counts"). The serialize test caught it before any counter went live. A standalone D1 `batch()` probe pinned the root cause (same-batch insert visibility) and validated the reordered fix before editing `apply.ts`.
- No new external packages were installed — `steward-core` depends only on workspace `@atlas/wire`/`@atlas/shared` + `typescript`. `pnpm install` reported "Already up to date" (workspace LINK only); the package-legitimacy checkpoint does not apply.

## Known Stubs

- `apps/steward/src/index.ts` exports a placeholder `fetch()` returning a plain text Response. This is **intentional** — Steward has no public HTTP surface in Phase 0; the outbound bridge endpoints (`/bridge/poll`, `/bridge/ack`) that drain `vault_outbox` land in **00-08**. The `queue()` handler (the real Phase-0 surface) is fully wired. Not a data-wiring stub.
- The `vault_outbox` intents Steward enqueues are PENDING and not yet drained — that is by design (the outbound-only daemon in 00-08 is the drainer; an unreachable bridge must never stall the Wire). Documented in the plan's threat register as T-00-26 (accepted; transport lands in 00-08).

## Threat Flags

None. No new security-relevant surface beyond the plan's `<threat_model>` was introduced. The mitigations the register assigned `mitigate` are all in place: atomic critical section + replay-skip (T-00-20, `replay.test.ts`), single named DO + serial consumer (T-00-21, `serialize.test.ts`), DLQ wiring + transient→P2 (T-00-22), malformed→ack+P3 (T-00-23, `malformed.test.ts`), sole atlas-wire consumer / CI one-writer gate (T-00-24), no destructive verb in op-mapping (T-00-25), slow write deferred to the outbox (T-00-26, accepted), positional-`?` only (T-00-27).

## Next Phase Readiness

- **00-05 (DLQ sink):** the consumer→DLQ half is wired (`dead_letter_queue:atlas-wire-dlq` + transient→`msg.retry`→P2 at attempts>=4). 00-05 adds the `atlas-wire-dlq` CONSUMER + the audit-row/Flagger incident sink so exhausted messages never drop silently.
- **00-08 (Obsidian bridge / outbound daemon):** IMPORT `toOutboxIntent` from `@atlas/steward-core` (do NOT define a second op→REST map); drain the PENDING `vault_outbox` intents Steward enqueues, PATCH Obsidian Local REST v3 outbound-only, then mark them done.
- **Phase 1 (morning chain):** every agent's §6.4 events now land in a serialized, idempotent, single-writer sink — apply once, replay-safe (`meta.changes===0`).

## Self-Check: PASSED

- All created files exist on disk: `packages/steward-core/src/{apply,op-mapping,index}.ts` + config; `apps/steward/src/{steward,steward-consumer}.ts`; `apps/steward/test/{replay,serialize,malformed}.test.ts` + `apply-migrations.ts`; both new `vitest.config.ts`.
- All three task commits present in git history (`d475728`, `59f8a2a`, `008488f`).
- Verification gates green: `pnpm -r build`, `pnpm -r typecheck`; `pnpm test` → steward 5/5 in workerd (replay/serialize/malformed), full repo 34/34. CI one-writer gate: exactly 1 atlas-wire consumer (apps/steward; atlas 0). op-mapping emits no destructive verb / no named params. `dead_letter_queue:atlas-wire-dlq` present; no `retry_delay_secs`.

---
*Phase: 00-spine*
*Completed: 2026-06-04*
