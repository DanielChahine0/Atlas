---
phase: 03-capture-local
plan: 03
subsystem: archivist
tags: [workflow, archivist, transcript, meeting-notes, forge-rpc, steward-trigger, cross-script-binding]
dependency_graph:
  requires: ["03-01", "03-02"]
  provides: ["archivist-workflow", "transcript-ready-trigger", "capture-pipeline-cloud"]
  affects: ["apps/archivist", "apps/steward", "apps/atlas"]
tech_stack:
  added: ["ArchivistWorkflow (WorkflowEntrypoint)", "cross-script workflows binding (ARCHIVIST_WF)"]
  patterns: ["TDD RED/GREEN", "durable step.do with retry+timeout", "isInstanceExistsError swallow", "makeSpyEnv injection for cross-script bindings"]
key_files:
  created:
    - apps/archivist/src/archivist.ts
    - apps/steward/test/archivist-trigger.test.ts
  modified:
    - apps/archivist/src/index.ts
    - apps/archivist/test/archivist.test.ts
    - apps/archivist/package.json
    - apps/steward/src/steward-consumer.ts
    - apps/steward/wrangler.jsonc
    - apps/steward/wrangler.test.jsonc
    - apps/atlas/wrangler.jsonc
decisions:
  - "ARCHIVIST_WF declared as optional (Workflow | undefined) in Steward Env — graceful degradation when not yet wired, no runtime crash pre-go-live"
  - "wrangler.test.jsonc does NOT declare workflows binding — workerd test pool cannot resolve cross-script external Worker; tests inject ARCHIVIST_WF spy via makeSpyEnv() (same pattern as INCIDENTS)"
  - "Codex context loaded from CONFIG.get('codex:archivist_snapshot') instead of @atlas/codex read() — codex.read() requires OAuth accessToken that is not available in the Workflow context; best-effort, never blocks"
  - "ClaudeClient intermediate type defined to bridge AgentClaude and test mock without type collision"
  - "applyEvent imported from @atlas/steward-core directly for steward-replay test — applies events without the DO RPC layer (analog to apps/steward/test/replay.test.ts)"
metrics:
  duration: "~2 hours (cross-session)"
  completed: "2026-06-06"
  tasks: 2
  files_changed: 10
  tests_added: 16
  tests_total_passing: 335
---

# Phase 3 Plan 03: ArchivistWorkflow + Steward Trigger Summary

**One-liner:** ArchivistWorkflow with 6 durable steps (fetch transcript -> prior notes -> Codex -> Opus pass with explicit effort -> Steward upsert + counter -> Forge.createTask action items), triggered idempotently from Steward on transcript.ready via cross-script workflows binding.

## What Was Built

### Task 1: ArchivistWorkflow (CAPTURE-01-e,f,g,h,j,k)

`apps/archivist/src/archivist.ts` implements `class ArchivistWorkflow extends WorkflowEntrypoint` with a testable `runArchivist(env, event, step)` factored body. Six durable `step.do` steps:

1. **fetch-transcript** — R2 `BLOBS.get(transcripts/${session_id}.json)`: null → flag P2 `kind:"transcript_missing"` then `NonRetryableError`; consent:"discarded" → `NonRetryableError` (no flag — owner decline)
2. **load-prior-notes** — last 3 sessions of same series from D1 (conservative: prefers new-series over wrong-series threading)
3. **load-codex** — `CONFIG.get("codex:archivist_snapshot")` best-effort (no block if absent)
4. **structure-note** — ONE `claudeFor("archivist", env)` Opus pass with `thinking: { type: "enabled", budget_tokens: 0 }` explicitly set (D5 — never default "high"); produces fixed notes template with `note_status:"draft"`, owner-only action items (emit_others_actions false, action_item_confidence 0.6 — low-confidence items kept + flagged, never dropped)
5. **emit-steward** — `send()` meeting.note upsert (`archivist:${session_id}:note`) + meetings-this-week increment (`archivist:${session_id}:count`)
6. **emit-action-items** — `env.FORGE.createTask(...)` for each owner action item with structured key `archivist:${series}:${date}:ai-NN` (Forge RPC, never direct tasks write)

`NonRetryableError` imported from `"cloudflare:workflows"` (Pitfall 4 — correct import; TypeScript cannot catch the wrong import path).

**Tests (10/10):** effort-set, wire-contract, idempotent, consent-discarded, failure-path, steward-replay (CAPTURE-01-k).

### Task 2: Steward Trigger + Atlas Service Bindings

**steward-consumer.ts:** Added `ARCHIVIST_WF?: Workflow` to local Env. After successful `steward.apply(e)` + `msg.ack()`, checks `e.type === "transcript.ready"` + `consent:"granted"` + `env.ARCHIVIST_WF` and calls `env.ARCHIVIST_WF.create({ id: \`archivist-${session_id}\`, params: { session_id } })`. The `.catch()` swallows `isInstanceExistsError` silently; other errors surface as `console.error` + P2 flag (best-effort). Trigger fires OUTSIDE the DO write critical path, never blocking the single-writer lock.

**apps/steward/wrangler.jsonc:** Added cross-script workflows binding with all 4 required keys (`binding`, `name`, `class_name`, `script_name: "archivist"`). NOT a second `atlas-wire` consumer — Pillar 1 preserved.

**apps/atlas/wrangler.jsonc:** Added `ARCHIVIST` + `ECHO_SESSION` service bindings following Phase-2 pattern.

**archivist-trigger.test.ts:** 6 tests verifying trigger wiring, idempotent re-trigger (collision swallowed), discarded consent = no trigger, non-transcript events = no trigger, non-fatal create error → P2, malformed events unaffected, Pillar 1 structural assertion.

## Decisions Made

1. **ARCHIVIST_WF optional in Env** — graceful degradation pre-go-live; no runtime crash if binding not yet wired
2. **No workflows block in wrangler.test.jsonc** — workerd pool cannot resolve cross-script external Worker `archivist`; tests inject via `makeSpyEnv()` (same pattern as INCIDENTS binding)
3. **Codex via CONFIG KV snapshot** — `codex.read()` requires an OAuth `accessToken` not available in Workflow context; `CONFIG.get("codex:archivist_snapshot")` is best-effort and never blocks the Workflow
4. **`@atlas/steward-core` dep in archivist** — `applyEvent` needed for CAPTURE-01-k steward-replay test; applies events directly (no DO RPC layer)
5. **Intermediate ClaudeClient type** — bridges AgentClaude return type and test mock without type collision on the `messages.create` signature

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `@atlas/codex` removed — `codex.read()` requires OAuth accessToken**
- **Found during:** Task 1 (GREEN phase)
- **Issue:** `codex.read()` requires `{ accessToken }` as second argument; no OAuth context inside a Workflow
- **Fix:** Replaced dynamic `@atlas/codex` import with `CONFIG.get("codex:archivist_snapshot")` best-effort read; removed `@atlas/codex` dep from archivist package.json
- **Files modified:** `apps/archivist/src/archivist.ts`, `apps/archivist/package.json`
- **Commit:** `0a49085`

**2. [Rule 3 - Blocking] `wrangler.test.jsonc` workflows binding causes `ERR_RUNTIME_FAILURE`**
- **Found during:** Task 2 (steward test run)
- **Issue:** Adding `workflows` block to `wrangler.test.jsonc` caused workerd pool to try resolving `"core:user:archivist"` service which is not co-loaded in the test pool, producing `ERR_RUNTIME_FAILURE`
- **Fix:** Removed workflows block from `wrangler.test.jsonc`; added explanatory comment directing to `makeSpyEnv()` injection pattern
- **Files modified:** `apps/steward/wrangler.test.jsonc`
- **Commit:** `386ea9e`

**3. [Rule 1 - Bug] `continue` missing after `msg.retry` in steward-consumer.ts**
- **Found during:** Task 2 code review
- **Issue:** Without `continue` at the end of the transient-retry path, execution would fall through to the Archivist trigger block even after a retry
- **Fix:** Added `continue` statement at end of retry path before the Archivist trigger block
- **Files modified:** `apps/steward/src/steward-consumer.ts`
- **Commit:** `386ea9e`

## Known Stubs

None — all plan goals achieved. `archivist.ts` does not contain hardcoded empty values, placeholder text, or unwired data sources. The Codex snapshot path (`CONFIG.get("codex:archivist_snapshot")`) is best-effort by design (documented in the step) and returns null when unset — this is the correct degraded behavior, not a stub.

## Threat Flags

No new security-relevant surface beyond what the plan's threat model covers:

- T-03-03-06: cross-script `ARCHIVIST_WF.create` binding is mitigated as designed (Worker-to-Worker private transport, not public HTTP; carries only `{ session_id }` from an already-validated Wire event)
- T-03-03-02: Pillar 1 verified — `atlas-wire` has exactly one consumer (`apps/steward/wrangler.jsonc`); `dlq-sink` consumes `atlas-wire-dlq`, `flagger` consumes `atlas-incidents`; no other app gained a consumers block

## Self-Check: PASSED

**Files verified:**
- `apps/archivist/src/archivist.ts` — FOUND (486 lines, ArchivistWorkflow class + runArchivist export)
- `apps/steward/test/archivist-trigger.test.ts` — FOUND (269 lines, 6 tests)
- `apps/steward/wrangler.jsonc` — contains `"script_name": "archivist"` — FOUND
- `apps/atlas/wrangler.jsonc` — contains `ARCHIVIST` + `ECHO_SESSION` service bindings — FOUND

**Commits verified:**
- `0a49085` — Task 1: ArchivistWorkflow — FOUND
- `386ea9e` — Task 2: Steward trigger — FOUND

**Test results:** 10/10 archivist, 33/33 steward, full suite 335 tests passing
**Typecheck:** `pnpm -r typecheck` — all packages clean
**Pillar 1:** `atlas-wire` consumer count = 1 (steward only) — VERIFIED
**`INSERT INTO tasks` in archivist.ts:** 0 — VERIFIED (action items via Forge.createTask RPC only)
**`from "cloudflare:workflows"` in archivist.ts:** FOUND — VERIFIED (Pitfall 4 correct import)
