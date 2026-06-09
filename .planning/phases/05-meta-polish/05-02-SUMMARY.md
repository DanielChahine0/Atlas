---
phase: 05-meta-polish
plan: "02"
subsystem: apps/librarian
tags: [librarian, prompt-library, bearer-gate, dedupe, haiku, wire-upsert, full-note]
dependency_graph:
  requires:
    - fullNote PUT branch in toOutboxIntent (05-01)
    - librarian -> claude-haiku-4-5 in TIER_MAP (05-01)
    - D1 prompts table + idx_prompts_tool (05-01 / 0008_prompts.sql)
  provides:
    - apps/librarian Worker (POST /prompt/save, Bearer-gated, fail-closed)
    - deterministic token-set Jaccard dedupe within tool bucket
    - Haiku title/tags derivation + once-only stable slug
    - op:upsert Wire events (fullNote:true, notePath:Prompts/<slug>.md)
    - structured idempotency keys (librarian:<slug>:save / :save:<date>)
  affects:
    - apps/librarian (new)
    - atlas-wire (producer)
    - atlas-incidents (producer)
    - D1 prompts table (reader + writer)
tech_stack:
  added: []
  patterns:
    - ExportedHandler<Env> satisfies pattern (not annotated)
    - timingSafeEqual from @atlas/gate (import, never re-implement)
    - claudeFor("librarian", env as unknown as ...) cast (archivist/envoy precedent)
    - dedupeLookup D1 positional ? pattern (steward-core/apply.ts style)
    - localDate(env) for owner-local timestamps (America/Toronto, TZ=UTC safe)
    - resolveSlug() collision suffix -2/-3 (Pitfall 3)
    - passWithNoTests: true (tests land in 05-03)
key_files:
  created:
    - apps/librarian/package.json
    - apps/librarian/wrangler.jsonc
    - apps/librarian/wrangler.test.jsonc
    - apps/librarian/tsconfig.json
    - apps/librarian/vitest.config.ts
    - apps/librarian/src/env.ts
    - apps/librarian/src/auth.ts
    - apps/librarian/src/dedupe.ts
    - apps/librarian/src/derive.ts
    - apps/librarian/src/index.ts
    - apps/librarian/test/apply-migrations.ts
  modified: []
decisions:
  - D-01: POST /prompt/save is Bearer-gated (ATLAS_LIBRARIAN_TOKEN, constant-time timingSafeEqual from @atlas/gate, fail-closed 401 on missing binding), auth before body parse
  - D-02: Deterministic token-set Jaccard dedupe (no model), KV-tunable thresholds 0.75/0.55; borderline → single P4 flag naming both slugs + keep-separate
  - D-03: Haiku title/tags derivation via claudeFor("librarian", env); slug derived once, never re-derived
  - D-04: Re-save bumps uses/last_used on same slug; bump key date-suffixed (one bump/slug/day replay-safe)
  - D-05: Append-only forever; INSERT new row, never soft-delete
  - T-5-Auth: fail-closed Bearer gate, constant-time, auth before body parse
  - T-5-DoS: 50KB soft limit on full_prompt, P3 flag + no Wire event
  - T-5-Tamper: notePath always Prompts/<slug>.md; Steward's regex constraint is defense-in-depth
  - T-5-Pillar1: producer-only (WIRE + INCIDENTS producers, NO consumers block); guard passes
  - T-5-Replay: stable structured keys; no crypto.randomUUID()
metrics:
  duration: "~18 minutes"
  completed_date: "2026-06-09"
  tasks_completed: 3
  files_modified: 11
---

# Phase 5 Plan 2: Librarian Worker Summary

**One-liner:** Bearer-gated, producer-only Librarian Worker with Jaccard dedupe (Jaccard 0.75/0.55), Haiku title/tags derivation, stable slug, and replay-safe op:upsert Wire events for Steward's fullNote PUT path.

## What Was Built

Three atomic tasks delivering the full `apps/librarian/` Worker (source + config):

**Task 1 — Worker scaffold + producer-only config + Bearer auth + env**

- `package.json`: `@atlas/librarian`, deps `@atlas/gate + @atlas/model + @atlas/shared + @atlas/wire` (workspace:*)
- `wrangler.jsonc`: producer-only queues (WIRE + INCIDENTS producers, NO consumers block), D1 atlas-db, KV CONFIG, three Secrets Store secrets (ATLAS_LIBRARIAN_TOKEN, ANTHROPIC_API_KEY, CF_AIG_TOKEN), `AIG_GATEWAY_ID: atlas-highvolume` (Haiku gateway), `observability.enabled`, staging crons []
- `src/env.ts`: `Env extends SharedEnv { ATLAS_LIBRARIAN_TOKEN?: SecretsStoreSecret }` — inherits all AI-Gateway bindings
- `src/auth.ts`: imports `timingSafeEqual` from `@atlas/gate` (never re-implements); `authorizeSave()` reads `ATLAS_LIBRARIAN_TOKEN` async, fail-closed on missing binding or wrong token; `unauthorized()` returns 401 + `WWW-Authenticate: Bearer` + `Cache-Control: no-store`

**Task 2 — Deterministic dedupe + Haiku derivation + stable slug**

- `src/dedupe.ts`: `normalise()` (dates→DATE, URLs→URL, lowercase, whitespace collapse), `tokenSet()` (split, drop ≤2 chars), `jaccard()` (intersection/union, 1 on empty), `dedupeLookup()` (SELECT slug, full_prompt FROM prompts WHERE tool = ? positional ?, returns bump/borderline/new; KV thresholds with defaults 0.75/0.55)
- `src/derive.ts`: `deriveRecord()` calls `claudeFor("librarian", env)` (Haiku via atlas-highvolume), clamps title ≤6 words, tags ≤5, derives slug once as kebab-case `[a-z0-9-]` — strict subset of Steward's `[A-Za-z0-9][A-Za-z0-9._-]*` allowlist; `resolveSlug()` handles collisions with -2/-3 suffix

**Task 3 — Wire the fetch handler — save flow + idempotency + Flagger paths**

- `src/index.ts`: `satisfies ExportedHandler<Env>`; POST /prompt/save → handleSave (auth → zod validate → dedupe → derive → D1 → Wire); 405 for non-POST; 404 all other paths
- Empty prompt → P4 flag + no Wire event (200/action:empty_skipped); oversized >50KB → P3 flag + 413
- Bump path: UPDATE same slug, bumped uses+1, idempotencyKey `librarian:<slug>:save:<YYYY-MM-DD>` (one bump/day; replay = ledger no-op)
- Borderline path: derive incoming slug FIRST, emit single P4 flag naming `existing_slug=X, incoming_slug=Y, score=S.SS`, then keep-separate (new-slug Wire event — never silently merge)
- New path: deriveRecord + resolveSlug + INSERT + Wire event, idempotencyKey `librarian:<slug>:save` (stable, no date)
- `buildNoteMarkdown()`: YAML frontmatter (title, tool, tags, created, last_used, uses) + blank line + full_prompt; dates sliced to YYYY-MM-DD via `localDate(env)`

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Worker scaffold + producer-only config + Bearer auth + env | a2a5f26 | 7 files |
| 2 | Deterministic dedupe + Haiku derivation + stable slug | a05b5bf | 2 files |
| 3 | Wire the fetch handler — save flow + idempotency + Flagger paths | 42a2948 | 3 files |

## Verification Results

- `pnpm --filter @atlas/librarian typecheck`: 0 errors (all tasks)
- `guard-wire-consumer.js apps/librarian/wrangler.jsonc`: passes (no atlas-wire consumer)
- `pnpm test` (full suite): all packages pass (librarian: passWithNoTests, 05-03 adds tests)
- No `crypto.randomUUID()` in any source file
- Idempotency keys verified: `librarian:<slug>:save` (new) and `librarian:<slug>:save:<YYYY-MM-DD>` (bump)
- `payload.fullNote===true` and `payload.notePath` starts with `Prompts/` on all emit paths

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] vitest exits with code 1 on no test files**
- **Found during:** Task 3 verification (`pnpm test` full suite)
- **Issue:** `vitest run` exits code 1 when no test files found, breaking the full suite
- **Fix:** Added `passWithNoTests: true` to `apps/librarian/vitest.config.ts` — the established repo pattern (see `apps/atlas/vitest.config.ts`, `apps/mcp-github/vitest.config.ts`). Tests land in 05-03.
- **Files modified:** `apps/librarian/vitest.config.ts`
- **Commit:** 42a2948 (included in Task 3 commit)

**2. [Rule 1 - Bug] ModelEnv `Record<string,unknown>` index signature incompatibility**
- **Found during:** Task 2 typecheck
- **Issue:** `claudeFor("librarian", env)` — `ModelEnv` requires `Record<string,unknown>` (index signature) but `Env` is a named interface with no index signature → TS2345
- **Fix:** Applied the established repo cast pattern `env as unknown as Parameters<typeof claudeFor>[1]` (identical to `apps/archivist/src/archivist.ts` line 254 and `apps/envoy/src/draft.ts` line 86). Safe: claudeFor only reads specific typed bindings, all present on Env.
- **Files modified:** `apps/librarian/src/derive.ts`
- **Commit:** a05b5bf

## Known Stubs

None. The Librarian Worker is fully wired: D1 reads/writes, Wire emission, Flagger paths, and auth are all connected. No hardcoded empty values, placeholders, or mock data sources in any production path.

## Threat Flags

None. All T-5-* mitigations from the plan's threat register are implemented:
- T-5-Auth: Bearer gate, constant-time, fail-closed, auth before body parse
- T-5-DoS: 50KB soft limit, P3 flag
- T-5-Tamper: notePath always `Prompts/<slug>.md`; Steward's regex is defense-in-depth
- T-5-Pillar1: producer-only, guard passes
- T-5-Info: token never logged or written to D1
- T-5-Replay: stable structured keys, no randomUUID
- T-5-SC: no new external packages

## Self-Check: PASSED

- FOUND: apps/librarian/package.json
- FOUND: apps/librarian/wrangler.jsonc
- FOUND: apps/librarian/src/env.ts
- FOUND: apps/librarian/src/auth.ts
- FOUND: apps/librarian/src/dedupe.ts
- FOUND: apps/librarian/src/derive.ts
- FOUND: apps/librarian/src/index.ts
- FOUND commits: a2a5f26, a05b5bf, 42a2948
