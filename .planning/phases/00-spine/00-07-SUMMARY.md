---
phase: 00-spine
plan: 07
subsystem: shared-services
tags: [codex, drive-readonly, prompt-caching, ai-gateway, model-tiering, anthropic-sdk, flagger, monorepo-packages, vitest-workerd]

# Dependency graph
requires:
  - phase: 00-spine (00-01)
    provides: pnpm monorepo (apps/* + packages/*), tsconfig.base.json (strict), root vitest.workspace.ts glob, the vitest-pool-workers v4 cloudflareTest plugin convention, @anthropic-ai/sdk@0.100.1 in the lockfile
  - phase: 00-spine (00-02)
    provides: "@atlas/shared Env type surface (CONFIG/WIRE/ANTHROPIC_API_KEY/CF_AIG_TOKEN/AIG_ACCOUNT_ID/AIG_GATEWAY_ID/MODEL_<CODENAME>) + flag(env, severity, title, detail?) emitting the canonical op:'upsert'/entity:'flag' event; @atlas/wire WireEvent + send"
provides:
  - "@atlas/codex — read-only Codex reader: read(env,{accessToken,fetch}) fetches codex.md via the Drive files.get media path with a drive.readonly Bearer and parses the seven §11 sections (identity/education/work/skills/projects/bios/socials); codexSystemBlock() returns a system TextBlockParam with cache_control {type:'ephemeral', ttl:'1h'}. NO agent write path (read-only invariant in code)."
  - "@atlas/model — claudeFor(agent,env)/modelFor(agent,env) AI-Gateway factory: every Claude call routes through the gateway Anthropic endpoint (never the direct host); per-agent tiering reads KV model:<codename> → [vars] MODEL_<CODENAME> → the CLAUDE.md map; a non-2xx Gateway response calls flag(env,'P3',…)."
affects:
  - "Phase 1 (Filer/Herald/Forge/Sundial/Compass) — read the Codex for context via @atlas/codex and call Claude through @atlas/model's one canonical factory"
  - "Archivist (Phase 3) — reads the Codex (drive.readonly) for meeting-notes context"
  - "Envoy/Quill (Phase 3/4) — read the Codex identity/bios/socials sections for autofill + brand sync"

# Tech tracking
tech-stack:
  added:
    - "@anthropic-ai/sdk@0.100.1 as a direct dependency of @atlas/model (claudeFor client) and @atlas/codex (TextBlockParam type only) — the version already in the Wave-1 lockfile"
  patterns:
    - "Read-only-by-absence: @atlas/codex enforces the Codex read-only invariant by exporting ONLY a read helper + types — no write/update/patch/put/post/delete/mutate export exists anywhere (T-00-71); agents get a 403 because no write code path exists"
    - "Injected drive.readonly token: read(env, {accessToken, fetch}) takes the access token + an overridable fetch as injected deps so the unit test exercises the full read path with no live network (the live token is minted by the oauth layer in 00-06/00-11)"
    - "Codex-as-ephemeral-system-block: codexSystemBlock(text) returns the SDK's TextBlockParam shape with cache_control {type:'ephemeral', ttl:'1h'} so a Worker spreads it straight into system:[...] (Anthropic prompt caching at 0.1x read)"
    - "Config-driven model tiering: modelFor resolves KV model:<codename> override → [vars] MODEL_<CODENAME> default → the CLAUDE.md TIER_MAP fallback → Sonnet default; re-tunable without a redeploy (D-05); only dateless 4.x ids"
    - "AI-Gateway-only Claude: claudeFor builds the Anthropic client with baseURL = gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic, the Authenticated-Gateway cf-aig-authorization Bearer, and cf-aig-metadata{agent} set ONCE in the factory; the direct Anthropic host never appears in src"
    - "Flag-on-non-2xx: claudeFor's messages.create wraps the SDK call; a non-2xx APIError (numeric status outside 200–299) calls flag(env,'P3',…, {sourceAgent:'Model'}) then rethrows — never a silent model failure (T-00-75)"

key-files:
  created:
    - "packages/codex/{package.json,tsconfig.json,vitest.config.ts,src/codex.ts,src/index.ts,test/read.test.ts}"
    - "packages/model/{package.json,tsconfig.json,vitest.config.ts,src/claude.ts,src/index.ts,test/claude.test.ts}"
  modified:
    - "pnpm-lock.yaml (two new workspace importer entries: @atlas/codex, @atlas/model)"

key-decisions:
  - "Both new packages carry build + typecheck scripts (= tsc --noEmit) like @atlas/steward-core, because the plan's verify calls `pnpm --filter @atlas/<pkg> build` (the leaf packages @atlas/wire/shared/security only define typecheck)"
  - "@atlas/codex ships a focused, dependency-free Codex-shaped YAML reader (parseCodex) rather than pulling a general YAML engine — the Codex is a fixed owner-authored shape (docs/07 schema), keeping the package dep-light (only @atlas/shared for Env + @anthropic-ai/sdk for the TextBlockParam type)"
  - "read() injects the drive.readonly token + fetch as deps (not read from env) so the Phase-0 unit test stubs the Drive fetch with zero live network; the CONFIG KV holds ONLY the Drive file id (key codex:drive_file_id) — config, never the token"
  - "claudeFor flags ONLY a genuine non-2xx HTTP error (Anthropic.APIError with a numeric status outside 200–299); a plain non-HTTP throw (network blip) is rethrown UNflagged — avoids spurious P3 incidents for transient client errors that aren't gateway responses"
  - "flag() sourceAgent set to 'Model' so the flag id (flg:<localDate>:Model:<hash>) and the Wire event agent attribute the incident to the model spine, not a default 'Atlas'"
  - "Rephrased explanatory comments off the literal forbidden tokens (the direct Anthropic host string, the broad Drive write scope strings) so the structural grep gates read the CODE, not the prose — same hygiene fix documented in 00-02 deviation #2"

patterns-established:
  - "A shared-service package that needs build+typecheck verify defines both scripts as tsc --noEmit (the no-emit monorepo: TS source consumed directly, main = src/index.ts)"
  - "Every test-bearing package owns its own vitest.config.ts (cloudflareTest plugin + nodejs_compat); the root vitest.workspace.ts glob auto-discovers it (GLOBAL DECISION 3)"

requirements-completed: [SPINE-03]

# Metrics
duration: ~7min
completed: 2026-06-05
---

# Phase 0 Plan 07: Codex + Model Packages Summary

**The two shared service packages every Phase-1 reasoning agent consumes from day one — `@atlas/codex` (a read-only `drive.readonly` reader returning the seven §11 sections, cached as an ephemeral `system` block, with NO agent write path) and `@atlas/model` (the `claudeFor`/`modelFor` AI-Gateway factory routing every Claude call through the gateway Anthropic endpoint, config-driven tiering re-tunable without redeploy, raising a Flagger P3 flag on a non-2xx response) — both building, typechecking under strict TS, and passing 16 tests inside `workerd`. Completes SPINE-03.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-06-04T23:53:51Z
- **Completed:** 2026-06-05 (UTC)
- **Tasks:** 2 (both `tdd="true"`)
- **Files created:** 12 source/config/test files across two packages (+ lockfile)

## Accomplishments

- **`@atlas/codex`** — `read(env, {accessToken, fetch})` reads the Codex Drive file id from `CONFIG` KV (key `codex:drive_file_id` — config only, never the token), fetches `codex.md` via the Drive `files.get` MEDIA path (`/drive/v3/files/{id}?alt=media`) with an injected `drive.readonly` Bearer, and parses the seven SPINE-03 sections — `identity`, `education`, `work` (YAML `work_experience`), `skills`, `projects`, `bios`, `socials` — each present and non-empty. `codexSystemBlock(text)` returns the SDK's `TextBlockParam` with `cache_control: { type: "ephemeral", ttl: "1h" }`. **The public barrel exports a read helper + types ONLY** — no `write/update/patch/put/post/delete/mutate` export anywhere (the read-only invariant is enforced by the absence of a write surface; T-00-71). Least-privilege `drive.readonly` only (no broad write scope in src). The Codex carries zero credentials (T-00-72). 6 tests pass in `workerd`.
- **`@atlas/model`** — `modelFor(agent, env)` resolves the model id by KV `model:<codename>` override → `[vars]` `MODEL_<CODENAME>` default → the CLAUDE.md `TIER_MAP` (Opus `claude-opus-4-8` for Atlas/Compass/Archivist; Sonnet `claude-sonnet-4-6` for Forge/Herald/Scout/Headhunter; Haiku `claude-haiku-4-5` for Filer) → Sonnet default; only dateless 4.x ids, never a retired `-20250514`. `claudeFor(agent, env)` builds an `@anthropic-ai/sdk` client whose `baseURL` is the AI-Gateway Anthropic endpoint (`gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic`) — the direct Anthropic host never appears in `src`; `apiKey` + `cf-aig-authorization` come from the async Secrets-Store bindings; `cf-aig-metadata: {"agent":"<codename>"}` is set once. Its `messages.create` wraps the SDK call so a non-2xx `APIError` calls `flag(env, "P3", …, {sourceAgent: "Model"})`, emitting exactly one canonical `op:"upsert"`/`entity:"flag"` full-flag-record event with a structured `idempotencyKey` (the flag id, no `crypto.randomUUID`), then rethrows. 10 tests pass in `workerd`.

## Task Commits

Each task was committed atomically:

1. **Task 1: `@atlas/codex` — read-only Codex reader (drive.readonly, 7 §11 sections)** — `327dba2` (feat)
2. **Task 2: `@atlas/model` — claudeFor/modelFor AI-Gateway factory (KV→[vars] tiering, P3 flag on non-2xx)** — `f4ddbf7` (feat)
3. **Grep-gate hygiene: rephrase @atlas/model barrel comment off the direct-host literal** — `a7ace2f` (style)

**Plan metadata:** (this commit) `docs(00-07): complete codex + model packages plan`

## Files Created/Modified

- `packages/codex/src/codex.ts` — `read()` (drive.readonly Drive media fetch) + `codexSystemBlock()` (ephemeral TextBlockParam) + `parseCodex()` (focused Codex-shaped YAML reader) + `CODEX_DRIVE_SCOPE`/`CODEX_FILE_ID_KEY` constants
- `packages/codex/src/index.ts` — public barrel: read helper + types ONLY (read-only invariant)
- `packages/codex/test/read.test.ts` — 6 cases: all 7 sections non-empty; drive.readonly Bearer on the media path; throws on missing file id; no write export; cache-as-system-block shape; zero credentials in the parsed result
- `packages/model/src/claude.ts` — `modelFor()` (KV→[vars]→map tiering) + `claudeFor()` (gateway client + flag-on-non-2xx wrapper) + `gatewayBaseURL()` + the `TIER_MAP`
- `packages/model/src/index.ts` — public barrel: `claudeFor` + `modelFor` + `gatewayBaseURL` + `AgentClaude` type
- `packages/model/test/claude.test.ts` — 10 cases: tiering (compass/forge/filer), [vars] default, KV override re-tier, case-insensitivity, no retired ids; gateway baseURL not the direct host; cf-aig-metadata{agent} + cf-aig-authorization headers; bound model; non-2xx → one canonical P3 flag event with a structured key + rethrow; non-HTTP throw NOT flagged
- `packages/{codex,model}/{package.json,tsconfig.json,vitest.config.ts}` — workspace + test wiring
- `pnpm-lock.yaml` — two new workspace importer entries

## Decisions Made

- **`build` + `typecheck` scripts on both packages.** The plan's verify calls `pnpm --filter @atlas/codex build` / `pnpm --filter @atlas/model build`; the leaf packages (`@atlas/wire`/`shared`/`security`) only define `typecheck`, but `@atlas/steward-core` (a workspace-dep package) defines `build: tsc --noEmit` too — followed that pattern.
- **Dependency-free Codex YAML reader.** The Codex is a fixed owner-authored shape (docs/07 schema example). `parseCodex` parses the top-level §11 sections without a general YAML engine, keeping the package dep-light (`@atlas/shared` for `Env`, `@anthropic-ai/sdk` for the `TextBlockParam` type only).
- **Injected `drive.readonly` token + fetch.** `read()` takes the access token and an overridable `fetch` as deps so the Phase-0 unit test stubs the Drive fetch with zero live network; the live token is minted by the oauth layer (00-06/00-11). `CONFIG` KV holds only the Drive file id.
- **Flag only genuine non-2xx HTTP errors.** `claudeFor` flags only an `Anthropic.APIError` (or `{status}`-shaped throw) with a numeric status outside 200–299; a plain non-HTTP throw is rethrown UNflagged — avoids spurious P3 incidents for non-gateway client errors.
- **`sourceAgent: "Model"`.** The flag id (`flg:<localDate>:Model:<hash>`) and the Wire event `agent` attribute the incident to the model spine.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug avoidance] Rephrased comments to keep the structural grep gates honest**
- **Found during:** Task 1 + Task 2 acceptance verification
- **Issue:** Explanatory comments quoted the literal tokens they exist to warn against — the direct Anthropic host string in `claude.ts`/`index.ts`, and the broad Drive write scope strings in `codex.ts`. The acceptance grep gates (`grep -c "api.anthropic.com" packages/model/src/claude.ts == 0`; `grep -E '\bdrive\.file\b|"drive"' codex.ts` returns nothing; the read-only `export` gate) matched the PROSE, returning false-positive counts even though the CODE was correct.
- **Fix:** Rephrased the comments to describe the forbidden forms without the literal tokens (same hygiene fix documented in 00-02 deviation #2). No behavior change.
- **Files modified:** `packages/codex/src/codex.ts`, `packages/codex/src/index.ts`, `packages/model/src/claude.ts`, `packages/model/src/index.ts`
- **Verification:** After the edit every gate reads correctly — `READ-ONLY-OK`, `NO-BROAD-SCOPE-OK`, `NO-DIRECT-ANTHROPIC`, `NO-RETIRED-IDS`, `NO-RANDOM-UUID`; both packages' tests + typecheck green.
- **Committed in:** `327dba2` (Task 1 — codex comments fixed pre-commit), `f4ddbf7` (Task 2 — claude.ts comments fixed pre-commit), `a7ace2f` (the index.ts barrel comment, isolated style commit)

**Total deviations:** 1 auto-fixed (grep-gate comment hygiene). No scope creep, no architectural changes, no checkpoints, no missing-critical additions.

## TDD Gate Compliance

Both tasks are `tdd="true"`. Implementation and the failing test were authored together per package, then the test was run (RED→GREEN in one pass: 6/6 codex, 10/10 model). No test passed unexpectedly during RED that would indicate a pre-existing feature. The plan-level commits are `feat(...)` (the GREEN gate); no separate RED `test(...)` commit was emitted because impl + test landed in the same atomic per-package commit (the monorepo convention used by every prior Wave-2/3 plan, e.g. 00-02's three `feat(...)` commits). The behavior is fully test-covered.

## Issues Encountered

- The plan's Task-1 acceptance suggested `import { env } from "cloudflare:test"` for the CONFIG KV. That requires registering `@cloudflare/vitest-pool-workers/types` in the package tsconfig AND a wrangler config to provide a real KV binding to the pool. The established `@atlas/shared` test convention instead stubs the binding surface with `vi.fn()` (no wrangler config for a pure-logic package). Followed the `@atlas/shared` convention — `read()` takes the file id via a stubbed `CONFIG.get()` and the Drive fetch via an injected stub. No `cloudflare:test` env needed; tests still run inside real `workerd`.
- `@anthropic-ai/sdk` `buildRequest` is async (returns a `Promise`) — the cf-aig-metadata header test `await`s it.

## Known Stubs

None. Both packages are fully wired: `read()` performs a real Drive media fetch + parses real §11 sections; `codexSystemBlock()` builds a real ephemeral cache block; `modelFor` resolves a real KV→[vars]→map chain; `claudeFor` builds a real `@anthropic-ai/sdk` client against the gateway endpoint and the non-2xx path emits a real canonical Flagger event via `@atlas/shared` `flag()`. No live Claude call is required for Phase-0 completion (the gateway + Anthropic key are owner-provisioned in 00-06; the factory is first invoked in Phase 1) — this is documented Phase-0 scope, not a data-wiring stub.

## Next Phase Readiness

- **Phase 1 (Filer/Herald/Forge/Sundial/Compass):** import `read`/`codexSystemBlock` from `@atlas/codex` for owner-fact context and `claudeFor`/`modelFor` from `@atlas/model` for every Claude call. Tiering is a KV/[vars] flip (no redeploy); the read-only Codex and AI-Gateway-only invariants are enforced in code.
- **Owner provisioning (00-06, non-blocking for Phase 0):** the `ANTHROPIC_API_KEY` + `CF_AIG_TOKEN` Secrets-Store secrets and the two AI Gateways (`atlas-reasoning`/`atlas-highvolume`) must exist before the first live Phase-1 call; the `codex:drive_file_id` CONFIG key + the `drive.readonly` token plumbing (00-11) before the first live Codex read. The TYPE surface (00-02) and the factory (this plan) are ready.

## Self-Check: PASSED

- All listed created files exist on disk (codex + model package.json/tsconfig/vitest.config/src/test — verified below).
- All task commits present in git history (`327dba2`, `f4ddbf7`, `a7ace2f`).
- Verification gates green: both `build` + `typecheck` exit 0; `pnpm test` → codex 6/6, model 10/10 inside `workerd` (TZ=UTC), full suite 54/54 across 8 packages/apps.
- Grep gates: `READ-ONLY-OK` (no write export in the codex barrel), `NO-BROAD-SCOPE-OK` (drive.readonly only), `NO-DIRECT-ANTHROPIC` (no direct host in `claude.ts`; clean across both packages' `src/`), `NO-RETIRED-IDS` (no `-20250514`), `NO-RANDOM-UUID`, `cf-aig-metadata` >= 1, no secret read from the Codex.

---
*Phase: 00-spine*
*Completed: 2026-06-05*
