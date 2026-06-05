---
phase: 02-weekly-value
plan: "04"
subsystem: scout-weekly-events
tags: [scout, events, rss, html, gmail, relevance, idempotency, d2-09, d2-12, weekly-01]
dependency_graph:
  requires:
    - "02-01 (D1 events table from 0004 migration, flag()/RawIncident, INCIDENTS binding)"
  provides:
    - "Scout WorkerEntrypoint weekly() — Friday 16:00 events digest"
    - "ScoutSources injectable interface (fetchRss / fetchHtml / fetchGmailEvents)"
    - "buildGmailQueries() — D2-09 safe query builder"
    - "relevance() — pure 0-100 scorer against Codex skills/projects + KV keywords"
    - "apps/scout Worker ready for Atlas service-binding wiring (Plan 02-07)"
  affects:
    - apps/scout (new)
tech_stack:
  added:
    - "rss-parser@3.13.0 (RESEARCH Package Legitimacy Audit — Approved)"
    - "cheerio@1.2.0 (RESEARCH Package Legitimacy Audit — Approved)"
  patterns:
    - "WorkerEntrypoint + scheduled() export (compass analog)"
    - "injectable ScoutSources interface (filer GmailTools analog — testability without live network)"
    - "pure relevance() function (no I/O; compass/score.ts analog)"
    - "INSERT OR REPLACE INTO events with positional ? binds (D1 rule)"
    - "scout:evt_<date>_<contentHash(title+start)> idempotency key (never crypto.randomUUID)"
    - "scout:digest:<date> summary event on every run"
    - "D2-09: buildGmailQueries() structurally excludes Type/Security + Phishing-Suspect"
    - "sparse-week relaxation: if < sparseFloor candidates clear minRelevance, drop to relaxedMinRelevance"
key_files:
  created:
    - apps/scout/src/index.ts
    - apps/scout/src/sources.ts
    - apps/scout/src/score.ts
    - apps/scout/wrangler.jsonc
    - apps/scout/wrangler.test.jsonc
    - apps/scout/package.json
    - apps/scout/tsconfig.json
    - apps/scout/vitest.config.ts
    - apps/scout/test/safety.test.ts
    - apps/scout/test/idempotent.test.ts
    - apps/scout/test/apply-migrations.ts
  modified: []
decisions:
  - "buildGmailQueries() is a named exported function — safety tests assert the returned strings at runtime, not via grep; this provides a stronger guarantee than text-search over source"
  - "gmailCallCount closure in test stub prevents double-counting candidates across the two buildGmailQueries() calls"
  - "Wire contract test uses a distinct date (2026-09-05) and unique URL to prevent cross-test D1 url-dedupe collision (shared D1 in beforeAll)"
  - "Codex skills/projects integration deferred: runWeekly uses empty skills/projects arrays in v1 (no injected drive.readonly token); KV keywords still scored"
metrics:
  duration: "~90 minutes"
  completed: "2026-06-05T19:52:00Z"
  tasks: 2
  files_changed: 11
  commits: 4
---

# Phase 02 Plan 04: Scout Weekly Events Digest Summary

**One-liner:** Scout Worker with injectable RSS/HTML/Gmail sources, pure relevance scorer (Codex+KV), D1 events persist (INSERT OR REPLACE), Wire upserts per-event + digest summary — idempotent, D2-09 safe, 17 tests green.

## What Was Built

### Task 1 — Scout sources + pure relevance scorer (TDD)

**RED commit:** `c73431b` — failing safety test (no sources.ts/score.ts/index.ts yet)

**GREEN commit:** `6ca1799`

- `apps/scout/src/sources.ts`: Injectable `ScoutSources` interface (`fetchRss`, `fetchHtml`, `fetchGmailEvents`) + live implementations using `rss-parser` (static XML parse) and `cheerio` (static HTML parse — no JS execution).
  - `buildGmailQueries()` exported function returns only `label:Type/Newsletter newer_than:7d` and `label:Type/Events newer_than:7d` — structurally incapable of including `Type/Security` or `Phishing-Suspect` (D2-09 / T-02-link).
  - `fetchGmailEventsLive` uses subject/date metadata ONLY — never follows links from email bodies (D2-09).
  - `defaultSources(gmailTools?)` factory for live wiring.

- `apps/scout/src/score.ts`: Pure `relevance(candidate, skills, projects, keywords): number` (0-100). Additive: +15 per skill/project match (cap 60), +10 per KV keyword match (cap 40), +5 for online events. No I/O — `grep -E "fetch\(|env\." apps/scout/src/score.ts` = 0.

- Safety tests (9 tests): Gmail query safety (D2-09), no link-follow, `Type/Security` absent from queries, scorer purity (pure function, matching > unrelated, deterministic).

### Task 2 — Scout weekly() entrypoint, D1 persist, Steward upsert (TDD)

**RED+GREEN commit:** `9f3b035` — idempotent + heartbeat + wire contract + failure-path tests

**Completion commit:** `54b932a` — wrangler.jsonc + typecheck fix

- `apps/scout/src/index.ts`: `class Scout extends WorkerEntrypoint<Env>` with:
  - `weekly(params?)` — date defaults to `localDate(env)` (NEVER `new Date()`); calls `runWeekly`; emits `kind:heartbeat` P4 on success; calls `flag(env, "P3", ..., { kind: "scout_failed" })` on failure; re-throws for Atlas error propagation.
  - `scheduled()` default export `satisfies ExportedHandler<Env>` — standalone dev/fallback.
  - `runWeekly(env, date, sources?)`: fetches candidates from CONFIG RSS/HTML URLs + 2 Gmail queries; scores via `relevance()`; sparse-week relaxation; dedupes against D1 by url OR (title,start) within `dedupe_window_weeks`; `INSERT OR REPLACE INTO events(...)` with 14 positional `?` binds; per-event `op:upsert` Wire event; digest summary `op:upsert` Wire event.
  - Idempotency key structure: `scout:evt_${date}_${contentHash(title+start)}` (per-event); `scout:digest:${date}` (digest). No `crypto.randomUUID()`.

- `apps/scout/wrangler.jsonc`: WIRE + INCIDENTS producers; D1 `atlas-db`; CONFIG KV; AI binding; `nodejs_compat`; NO `triggers.crons` for production (Atlas drives via service binding); staging `crons=[]`; NO `queues.consumers` block (Pillar 1 — Scout is producer-only).

- Idempotent tests (8 tests): D1 row count equals first-run surfaced count after two identical runs; second run surfaced=0; digest key identical; per-event key pattern match; failure path P3 scout_failed; heartbeat P4.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test cross-test D1 dedupe collision**
- **Found during:** Task 2 — initial test run
- **Issue:** Wire contract test used same date `2026-07-18` as the idempotency tests. Since all tests share the same D1 (beforeAll migration), the url-based dedupe from the idempotency test's first run caused the Wire contract test to surface 0 events.
- **Fix:** Wire contract tests use distinct dates (`2026-08-01`, `2026-09-05`) and unique candidate URLs to avoid cross-test D1 collision.
- **Files modified:** `apps/scout/test/idempotent.test.ts`
- **Commit:** `9f3b035`

**2. [Rule 1 - Bug] TS2358 instanceof Promise on plain number**
- **Found during:** Task 2 — pnpm typecheck
- **Issue:** `safety.test.ts` had `expect(result instanceof Promise).toBe(false)` where `result` is typed as `number`. TypeScript correctly flagged: left-hand side of instanceof must be an object type, not `number`.
- **Fix:** Replaced with `expect(typeof result).toBe("number")` which is both correct and sufficient.
- **Files modified:** `apps/scout/test/safety.test.ts`
- **Commit:** `54b932a`

**3. [Rule 2 - Missing functionality] Codex skills/projects integration not wired**
- **Found during:** Task 2 implementation
- **Issue:** The plan calls for reading Codex `skills`/`projects` via `@atlas/codex read()`, which requires an injected `drive.readonly` access token. Scout v1 has no OAuth token path yet — the Codex reader in `runWeekly` would need the token injected.
- **Decision:** Use empty `skills=[]` / `projects=[]` arrays in v1. KV `scout/interests` keywords still scored. The scoring function works with any combination. Codex integration deferred to when Atlas wires the service binding (Plan 02-07) and the OAuth gate clears.
- **Impact:** Relevance scoring is keyword-only in v1 (no Codex skill matching). Still correct and functional. Documented as a known limitation.
- **Files modified:** `apps/scout/src/index.ts` (comment noting the deferred wiring)

## Known Stubs

- `runWeekly` uses `skills=[]` and `projects=[]` for relevance scoring. KV keywords still apply. Codex integration requires the `drive.readonly` OAuth token injection path (deferred to Plan 02-07 Atlas wiring / Phase-1 go-live gates).

## Threat Flags

No new network endpoints or auth paths introduced beyond the plan's declared threat model:
- T-02-link (mitigated): `buildGmailQueries()` structurally safe; `fetchGmailEventsLive` never follows email body links; safety test asserts at runtime.
- T-02-html (mitigated): cheerio static parse only — no JS execution.
- T-02-pii (accepted): Codex read-only; no Codex write; no schema change.
- T-02-SC (mitigated): rss-parser + cheerio both Approved per RESEARCH Package Legitimacy Audit.

## Self-Check: PASSED

Files exist:
- FOUND: apps/scout/src/index.ts
- FOUND: apps/scout/src/sources.ts
- FOUND: apps/scout/src/score.ts
- FOUND: apps/scout/wrangler.jsonc
- FOUND: apps/scout/test/safety.test.ts
- FOUND: apps/scout/test/idempotent.test.ts

Commits exist:
- c73431b: test(02-04): RED phase — failing safety test for Scout sources + relevance scorer
- 6ca1799: feat(02-04): GREEN — Scout sources (RSS/HTML/Gmail) + pure relevance scorer
- 9f3b035: test(02-04): RED+GREEN — idempotent test for Scout.weekly() D1 persist + Wire upsert
- 54b932a: feat(02-04): Scout wrangler.jsonc + typecheck fix (Task 2 complete)

Acceptance criteria:
- `apps/scout/package.json` lists rss-parser@3.13.0 and cheerio@1.2.0 ✓
- `ScoutSources` interface exported from sources.ts ✓
- `buildGmailQueries()` returns only Type/Newsletter + Type/Events queries ✓
- No Type/Security or Phishing-Suspect in RUNTIME query strings ✓
- `score.ts` has no fetch( or env. calls (grep returns 0) ✓
- No `crypto.randomUUID` in index.ts (grep returns 0) ✓
- `class Scout extends WorkerEntrypoint<Env>` with `weekly()` method ✓
- D1 persists via positional `?` binds (INSERT OR REPLACE INTO events) ✓
- `grep -rn "queues.consumers" apps/scout/wrangler.jsonc` → empty ✓
- `pnpm --filter scout test` exits 0 (17 tests pass) ✓
- `pnpm test` full suite: 373 tests, 0 failed, 2 skipped (live OAuth) ✓
- `pnpm --filter @atlas/scout typecheck` exits 0 ✓
