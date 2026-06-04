---
phase: 00-spine
plan: 02
subsystem: shared-foundation
tags: [wire-contract, zod, flagger, redaction, env-types, monorepo-packages, vitest-workerd]

# Dependency graph
requires:
  - phase: 00-spine (00-01)
    provides: pnpm monorepo (apps/* + packages/*), tsconfig.base.json (strict), root vitest.workspace.ts glob, migrations/0001_init_core.sql (run_log §5.2 superset), zod@4.4.3, the canonical CLAUDE.md binding/version strings
provides:
  - "@atlas/wire — the SINGLE canonical §6.4 WireEvent zod schema + inferred type + a parse-then-send producer helper (the only definition of the Wire shape)"
  - "@atlas/shared — the canonical Env binding-type surface (incl. the ANTHROPIC_API_KEY/CF_AIG_TOKEN/AIG_*/MODEL_<CODENAME> TYPE surface for 00-07), flag(env, severity, title, detail?) emitting the canonical op:'upsert'/entity:'flag' full-flag-record event via @atlas/wire, and a positional-? run_log helper"
  - "@atlas/security — SECRET_PATTERNS + redact() + containsSecret() (the 2FA/reset-link/login-URL redaction primitive) + its CI-backstop test; Wire-free so the Google MCP can reuse it"
affects:
  - "00-03 (Atlas DO + scheduled dispatcher — imports WireEvent + send from @atlas/wire, Env from @atlas/shared)"
  - "00-04 (Steward crux + the lone Wire consumer — imports WireEvent; the consumer calls flag() on malformed/retry-exhaustion)"
  - "00-05 (DLQ sink — calls the same flag() helper for P2/P3 dead-letter incidents)"
  - "00-07 (model factory — imports the ANTHROPIC_API_KEY/CF_AIG_TOKEN/AIG_*/MODEL_<CODENAME> Env type surface without extending a Wave-2 file)"
  - "00-08 (Google MCP — reuses the Wire-free redact()/containsSecret() primitive server-side; redaction backstop CI invariant)"

# Tech tracking
tech-stack:
  added:
    - "zod@4.4.3 as a direct dependency of @atlas/wire (range ^3.25 || ^4.0; resolved 4.4.3 — the version already in the lockfile)"
  patterns:
    - "Single Wire definition: the §6.4 WireEvent schema lives in exactly ONE file (packages/wire/src/contract.ts); every producer + Steward import it (build-plan acceptance #6 CI gate)"
    - "Parse-then-send at the producer boundary: send() calls WireEvent.parse() BEFORE env.WIRE.send so a malformed event never reaches the at-least-once Queue (T-00-21)"
    - "Canonical Flagger event: op:'upsert' / entity:'flag' / payload:<full flag record> / idempotencyKey === flag.id (a flag is a stable row keyed by id, mutated in place)"
    - "Structured, replay-safe flag id: flg:<localDate>:<source_agent>:<djb2 contentHash> — never a random UUID (Pillar 5 / T-00-23)"
    - "Wire-free redaction primitive: packages/security imports nothing from the Wire/bindings so the stateless Google MCP can reuse it"
    - "TS-source-consumed-directly packages: each package.json main = src/index.ts, type = module, .js-suffixed relative imports for NodeNext/Bundler ESM resolution; no build step in the monorepo"

key-files:
  created:
    - "packages/wire/{package.json,tsconfig.json,vitest.config.ts,src/contract.ts,src/send.ts,src/index.ts,test/contract.test.ts}"
    - "packages/shared/{package.json,tsconfig.json,vitest.config.ts,src/env.ts,src/flag.ts,src/runlog.ts,src/index.ts,test/flag.test.ts}"
    - "packages/security/{package.json,tsconfig.json,vitest.config.ts,src/redact.ts,src/index.ts,test/redact.test.ts}"
  modified:
    - "docs/13-build-plan.md (line 1269 stale Flagger stub annotated [SUPERSEDED — reconciled in 00-02])"
    - "pnpm-lock.yaml (three new workspace importer entries)"

key-decisions:
  - "zod-4 record API: used z.record(z.string(), z.unknown()) — the build-plan/PATTERNS snippet shows the zod-3 single-arg z.record(z.unknown()), which is a strict-TS error under the resolved zod 4.4.3 ('Expected 2-3 arguments, but got 1'). Inferred type is identical (Record<string, unknown>). [Rule 3 — blocking]"
  - "flag() default trust per severity (P1→100, P2→95, P3→50, P4→70) from the build-plan severity table + docs/08-flagger.md §3; recurrence re-scores later (Flagger, Phase 2)"
  - "flag id uses a deterministic djb2 contentHash of severity+title+detail (not random) so two calls describing the same incident produce the SAME id ⇒ Steward re-upserts one row"
  - "packages/security kept dependency-light (NO @atlas/wire/@atlas/shared) so the primitive stays reusable inside the stateless Google MCP (00-08); the P1-flag-on-catch convenience is documented as a caller responsibility via @atlas/shared flag(), not wired into the primitive"
  - "Rephrased explanatory comments to avoid literal forbidden tokens (entity:\"flagger\", op:\"increment\", crypto.randomUUID, ?1/:name) so the structural grep gates read the CODE, not the prose"

patterns-established:
  - "WireEvent is declared as BOTH a value (the schema) and a type (z.infer); a single export { WireEvent } re-exports both bindings so consumers can parse() or annotate with the same name"
  - "Every test-bearing package owns its own vitest.config.ts (cloudflareTest plugin + nodejs_compat); the root vitest.workspace.ts glob auto-discovers it (Wave-1 GLOBAL DECISION 3)"

requirements-completed: [SPINE-02]

# Metrics
duration: ~7min
completed: 2026-06-04
---

# Phase 0 Plan 02: Shared Foundation Packages Summary

**The three leaf-dependency packages every Wave-3 DO and Phase-1+ agent imports — the single §6.4 `WireEvent` zod contract + parse-then-send producer (`@atlas/wire`), the canonical `Env` surface + `flag()` Flagger-emit + positional-`?` `run_log` helper (`@atlas/shared`), and the Wire-free `SECRET_PATTERNS`/`redact()` 2FA-redaction primitive (`@atlas/security`) — all building, typechecking under strict TS, and passing 21 tests inside `workerd`.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-06-04T20:30:23Z
- **Completed:** 2026-06-04T20:37:28Z
- **Tasks:** 3 (all `tdd="true"`)
- **Files created:** 21 source/config/test files across three packages (+ 1 doc edit, + lockfile)

## Accomplishments

- **`@atlas/wire`** — the SINGLE canonical §6.4 `WireEvent` zod schema (`agent`/`type`/`entity`/`op`/`payload`/`idempotencyKey`) is the only definition of the Wire shape in the repo (`grep -rl 'op: *z.enum(["increment"' packages/ apps/` returns ONLY `contract.ts`). `send(env, event)` parses BEFORE `env.WIRE.send` so a malformed event is rejected at the producer boundary before it can enter the at-least-once Queue. The mandatory Wire-contract test (8 cases) passes in `workerd`.
- **`@atlas/shared`** — the canonical `Env` binding-type surface (`WIRE`/`DB`/`CONFIG`/`OAUTH_KV`/`BLOBS`/`AI`/`STEWARD_LOCK`/`ATLAS`/`MORNING_CHAIN_DO`), plus the 00-07 model/AI-Gateway TYPE surface (`ANTHROPIC_API_KEY`/`CF_AIG_TOKEN` as `SecretsStoreSecret`, `AIG_ACCOUNT_ID`/`AIG_GATEWAY_ID`, per-codename `MODEL_<CODENAME>` template-literal index). `flag(env, severity, title, detail?)` builds the full flag record and emits the canonical `op:"upsert"`/`entity:"flag"` event via `@atlas/wire` `send()` (NOT a raw queue enqueue), with `idempotencyKey === flag.id` (a structured, replay-safe id). `writeRunLog()` inserts the §5.2 superset with positional-`?` binds only. 6 tests pass.
- **`@atlas/security`** — the four `SECRET_PATTERNS` (6-digit 2FA code, reset-password/-link phrase, "verification code" phrase, reset|verify|confirm URL); `redact()` masks every match globally; `containsSecret()` returns the P1-block signal. The CI-backstop test (7 cases) proves the literal 2FA code `482913` does NOT survive, each reset/verify/confirm URL is removed, and the benign `"Lunch at 12:30 with Sam"` is unchanged (no over-redaction). The primitive imports nothing from the Wire — reusable inside the stateless Google MCP (00-08).
- **Doc reconciled** — `docs/13-build-plan.md:1269`'s stale `entity:"flagger"`/`op:"increment"` Flagger stub is annotated `[SUPERSEDED — reconciled in 00-02]` pointing to the canonical `op:"upsert"`/`entity:"flag"` full-flag-record form (SPEC-CANON §8 / docs/08-flagger.md §4/§6).

## Task Commits

Each task was committed atomically:

1. **Task 1: `@atlas/wire` — §6.4 WireEvent contract + send() + Wire-contract test** — `4565d08` (feat)
2. **Task 2: `@atlas/shared` — Env surface + flag() + writeRunLog()** — `383cffd` (feat)
3. **Task 3: `@atlas/security` — SECRET_PATTERNS + redact() + CI-backstop test** — `7e2e709` (feat)

**Plan metadata:** (this commit) `docs(00-02): complete shared foundation packages plan`

## Files Created/Modified

- `packages/wire/src/contract.ts` — the single §6.4 `WireEvent` schema + inferred type
- `packages/wire/src/send.ts` — parse-then-send producer helper (`WireEvent.parse` then `env.WIRE.send`)
- `packages/wire/src/index.ts` — re-exports `WireEvent` (value + type) and `send`
- `packages/wire/test/contract.test.ts` — mandatory Wire-contract test (8 cases)
- `packages/shared/src/env.ts` — canonical `Env` + `Severity` + the 00-07 model/AIG TYPE surface
- `packages/shared/src/flag.ts` — `flag()` + `localDate()` + `FlagRecord`/`FlagOptions`
- `packages/shared/src/runlog.ts` — `writeRunLog()` (positional-`?`, §5.2 superset)
- `packages/shared/src/index.ts` — re-exports the shared surface
- `packages/shared/test/flag.test.ts` — flag() + writeRunLog() tests (6 cases)
- `packages/security/src/redact.ts` — `SECRET_PATTERNS` + `redact()` + `containsSecret()`
- `packages/security/src/index.ts` — re-exports the primitive
- `packages/security/test/redact.test.ts` — CI-backstop redaction test (7 cases)
- `packages/{wire,shared,security}/{package.json,tsconfig.json,vitest.config.ts}` — workspace + test wiring
- `docs/13-build-plan.md` — line 1269 stale Flagger stub annotated (touched only that line)
- `pnpm-lock.yaml` — three new workspace importer entries

## Decisions Made

- **zod-4 record API (Rule 3 deviation — see below).** Verified against the resolved `zod@4.4.3` that the build-plan's `z.record(z.unknown())` single-arg form is a strict-TS compile error. Used the explicit `z.record(z.string(), z.unknown())` form; the inferred type is identical.
- **flag() default trust per severity** (P1→100, P2→95, P3→50, P4→70) from the build-plan severity table + docs/08-flagger.md §3. Recurrence re-scoring is a Phase-2 Flagger concern.
- **Deterministic flag id** (`flg:<localDate>:<source_agent>:<djb2 contentHash>`) so the same incident maps to one row across replays. `localDate()` derives owner-local `YYYY-MM-DD` via `Intl`/`America/Toronto` (the `TZ=UTC` gotcha).
- **`@atlas/security` kept Wire-free.** The primitive must be reusable inside the stateless Google MCP server (00-08), so it imports nothing from the Wire/bindings. The P1-flag-on-catch is documented as a caller responsibility (`@atlas/shared` `flag(env, "P1", ...)`), not wired into the primitive.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] zod-4 `z.record` two-arg form**
- **Found during:** Task 1 (`packages/wire/src/contract.ts` typecheck)
- **Issue:** The build-plan §5.1 / 00-PATTERNS.md schema uses `payload: z.record(z.unknown())` (the zod-3 single-arg form). The resolved version is `zod@4.4.3` (Wave-1 added it; it is the version every other tree dep uses). Under zod 4, single-arg `z.record` is a strict-TS error: `TS2554: Expected 2-3 arguments, but got 1`.
- **Fix:** Used the zod-4-correct `payload: z.record(z.string(), z.unknown())`. Verified the inferred type is identical (`Record<string, unknown>`) and runtime parsing of valid/`op:"delete"`/empty-key/missing-`agent` events is unchanged. Documented inline in `contract.ts`.
- **Files modified:** `packages/wire/src/contract.ts`
- **Verification:** `pnpm --filter @atlas/wire typecheck` exits 0; the 8-case Wire-contract test passes.
- **Committed in:** `4565d08`

**2. [Rule 1 - Bug avoidance] Rephrased comments to keep the structural grep gates honest**
- **Found during:** Task 2 acceptance verification
- **Issue:** Explanatory docstrings in `flag.ts`/`runlog.ts` quoted the forbidden tokens they exist to warn against (`entity:"flagger"`, `op:"increment"`, `crypto.randomUUID()`, `?1`/`:name`). The acceptance grep gates (`grep -c 'entity: *"flagger"' == 0`, etc.) matched the prose, returning false-positive counts of 1 even though the CODE was correct.
- **Fix:** Rephrased the comments to describe the forbidden forms without the literal tokens. No behavior change. After the edit every gate reads `0` for the forbidden patterns and `>=1` for the required ones.
- **Files modified:** `packages/shared/src/flag.ts`, `packages/shared/src/runlog.ts`
- **Verification:** Re-ran all Task-2 greps (all pass) + re-ran typecheck (0) + 6/6 tests.
- **Committed in:** `383cffd`

**Total deviations:** 2 auto-fixed (1 blocking zod-4 API, 1 grep-gate hygiene). No scope creep, no architectural changes, no checkpoints.

## Issues Encountered

- None blocking. `pnpm install` reported "Already up to date" each time because the dependency closure was already resolved by Wave-1; the only lockfile change was the three new workspace importer stanzas.

## Known Stubs

None. All three packages are fully wired: the WireEvent schema is real and parsed, `flag()` builds and emits a real §6.4 event, `writeRunLog()` issues a real positional-`?` INSERT, and `redact()`/`containsSecret()` run the real patterns. The `ANTHROPIC_API_KEY`/`CF_AIG_TOKEN`/`AIG_*`/`MODEL_*` Env entries are intentional TYPE-only declarations (no Phase-0 secret binding required — live Claude calls are Phase 1, consumed by 00-07's `modelFor`); this is documented in `env.ts` and is not a data-wiring stub.

## Next Phase Readiness

- **Wave 3 (00-03 Atlas DO, 00-04 Steward crux + consumer, 00-05 DLQ sink):** import `WireEvent`/`send` from `@atlas/wire`, `Env`/`flag`/`writeRunLog` from `@atlas/shared` with zero re-definition. The consumer's `flag(env, "P3", "malformed wire event", e)` / `flag(env, "P2", "steward write failing", ...)` callsites match the shipped signature exactly.
- **Wave 4 (00-08 Google MCP):** reuses the Wire-free `redact()`/`containsSecret()` for the server-side strip — the redaction CI-backstop invariant is satisfiable.
- **00-07 (model factory):** imports the `ANTHROPIC_API_KEY`/`CF_AIG_TOKEN`/`AIG_*`/`MODEL_<CODENAME>` Env type surface without extending a Wave-2-owned file.
- **CI invariants satisfied:** single Wire definition (one file) + the 2FA/reset-link redaction backstop test.

## Self-Check: PASSED

- All three packages' created files exist on disk (verified below).
- All three task commits present in git history (`4565d08`, `383cffd`, `7e2e709`).
- Verification gates green: all three `typecheck` exit 0; `pnpm test` → wire 8/8, shared 6/6, security 7/7 (+ Wave-1 atlas 2/2) inside `workerd` (TZ=UTC).
- Single-Wire-definition gate: `grep -rl` returns ONLY `packages/wire/src/contract.ts`.
- No secret value appears in any of the three packages' tracked files.

---
*Phase: 00-spine*
*Completed: 2026-06-04*
