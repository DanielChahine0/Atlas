---
phase: 01-core-loop-morning-pipeline
plan: 01
subsystem: api
tags: [mcp, oauth, scopes, least-privilege, redaction, gmail, calendar]

requires:
  - phase: 00-spine
    provides: "mcp-google stateless MCP Worker, safeToolOutput() redaction egress, getMcpAuthContext() scope reading, @atlas/security redact/containsSecret"
provides:
  - "apps/mcp-google/src/scopes.ts — the per-agent least-privilege scope floors (gmail.modify/compose/readonly, calendar.events/readonly) + exact, independent predicates"
  - "Herald tools: gmail_search_threads + gmail_get_thread (gmail.readonly), gmail_create_draft (gmail.compose, draft-only)"
  - "Forge tools: reuse gmail_search_threads / gmail_get_thread (gmail.readonly, read-only)"
  - "Sundial tools: calendar_list_events / calendar_create_event / calendar_update_event / calendar_suggest_time (calendar.events, NO delete)"
  - "Compass tools: calendar_list_events_readonly / calendar_freebusy (calendar.readonly)"
affects: [filer, herald, forge, sundial, compass, morning-chain]

tech-stack:
  added: []
  patterns:
    - "Per-agent exact scope-floor predicate (a granted scope never implies a broader one)"
    - "forbiddenResult(requiredScope) names the missing scope in the 403"
    - "Pillar-2 outward/destructive paths absent by construction (no send/delete tool registered)"

key-files:
  created:
    - apps/mcp-google/src/scopes.ts
    - apps/mcp-google/test/herald-tools.test.ts
  modified:
    - apps/mcp-google/src/index.ts

key-decisions:
  - "Predicates are exact and independent: gmail.modify does NOT imply gmail.readonly; calendar.events does NOT imply calendar.readonly. A token must carry the specific scope the tool requires."
  - "Compass gets read-only variants (calendar_list_events_readonly, calendar_freebusy) so its read path never depends on the calendar.events write floor."
  - "Tool bodies are Phase-1 placeholders proving scope-floor + redaction are wired; live Gmail/Calendar fetch lands in each agent's Wave-2 plan."
  - "MCP SDK 1.29.0 stores the registerTool() callback under _registeredTools[name].handler (not .callback) — used by the test harness to invoke tools directly."

patterns-established:
  - "scopes.ts is the single source of truth for OAuth floors; index.ts re-exports so importers are unchanged"
  - "every new tool checks its floor BEFORE any work and funnels output through safeToolOutput(body, env)"

requirements-completed: [CORE-01]

duration: 8 min
completed: 2026-06-05
---

# Phase 1 Plan 01: mcp-google per-agent scope expansion Summary

**Extended the Phase-0 mcp-google MCP server with the least-privilege Gmail/Calendar tool surfaces for Herald, Forge, Sundial, and Compass — each enforcing an exact scope floor (403 fail-closed) and funneling output through the existing redaction egress, with no send/delete tool registered anywhere.**

## Performance

- **Duration:** ~8 min
- **Tasks:** 3
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments
- Extracted scope concerns into `scopes.ts` with five floors and five exact predicates; existing gmail.modify behavior unchanged.
- Registered nine new tools across the four agents, each gated on its exact scope and redacted on egress.
- Pillar-2 enforced by construction: no `gmail_send`, no gmail delete/archive, no `calendar_delete` tool exists.

## Task Commits

1. **Task 1+2: Extract scopes.ts + register Herald/Forge/Sundial/Compass tools** - `67816d6` (feat)
2. **Task 3: Scope-floor + redaction tests** - `44645b6` (test)

## Files Created/Modified
- `apps/mcp-google/src/scopes.ts` - per-agent scope floors + predicates + grantedScopes/forbiddenResult.
- `apps/mcp-google/src/index.ts` - imports scopes.ts; registers the nine Phase-1 tools.
- `apps/mcp-google/test/herald-tools.test.ts` - predicate exactness, fail-closed tool calls, Pillar-2 registry assertion, redaction-egress proof.

## Verification
- `pnpm --filter @atlas/mcp-google build && typecheck && test` — all green (30/30 tests, 3 files).
- Existing scope.test.ts + redact.test.ts still pass (no gmail.modify regression).
- No `queues.consumers` block in mcp-google wrangler.jsonc (Steward stays sole atlas-wire consumer).

## Deviations from Plan

**[Rule 1 - bug] MCP SDK registry key** — Found during: Task 3 | The plan's test harness assumed the tool callback lives at `_registeredTools[name].callback`; MCP SDK 1.29.0 stores it under `.handler`. Fixed the harness accessor. | Files: apps/mcp-google/test/herald-tools.test.ts | Verified: 30/30 pass | Commit: `44645b6`.

**Total deviations:** 1 auto-fixed (1 bug). **Impact:** test-only; no production-code change.

## Self-Check: PASSED
- scopes.ts exports the five predicates + grantedScopes/forbiddenResult (verified on disk).
- index.ts imports from "./scopes.js" and every tool funnels safeToolOutput (verified).
- `git log --grep="01-01"` returns 2 commits.

## Next
Ready for Wave 2 (01-03 Filer, 01-04 Herald, 01-05 Forge, 01-06 Sundial, 01-07 Compass) — all consume this scope substrate.
