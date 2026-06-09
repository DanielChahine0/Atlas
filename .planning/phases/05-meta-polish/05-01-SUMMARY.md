---
phase: 05-meta-polish
plan: "01"
subsystem: steward-core / model / migrations
tags: [op-mapping, PUT, full-note, librarian, tier-map, d1-migration]
dependency_graph:
  requires: []
  provides:
    - fullNote PUT branch in toOutboxIntent (Prompts/ path constraint)
    - librarian -> claude-haiku-4-5 in TIER_MAP
    - D1 prompts table + idx_prompts_tool
  affects:
    - packages/steward-core (op-mapping.ts)
    - packages/model (claude.ts)
    - migrations (0008_prompts.sql)
    - apps/librarian (05-02 depends on these)
tech_stack:
  added: []
  patterns:
    - NonRetryableError from cloudflare:workflows (mirrors apply.ts import pattern)
    - Early-return fullNote sub-branch in upsert case (PATTERNS.md change 2)
    - D1 CREATE TABLE IF NOT EXISTS with CREATE INDEX IF NOT EXISTS (0003_tasks.sql style)
key_files:
  created:
    - packages/steward-core/test/op-mapping.test.ts
    - migrations/0008_prompts.sql
  modified:
    - packages/steward-core/src/op-mapping.ts
    - packages/model/src/claude.ts
decisions:
  - D-05: librarian -> claude-haiku-4-5 registered; routes through atlas-highvolume gateway
  - T-5-Tamper mitigated: Prompts/ path constraint enforced as NonRetryableError
metrics:
  duration: "275 seconds (~5 minutes)"
  completed_date: "2026-06-09"
  tasks_completed: 2
  files_modified: 4
---

# Phase 5 Plan 1: Upstream Foundations (Op-Mapping + TIER_MAP + Prompts Migration) Summary

**One-liner:** fullNote PUT branch in Steward op-mapping with hard Prompts/ path constraint + librarian->haiku TIER_MAP entry + D1 prompts table for deterministic dedupe lookup.

## What Was Built

Three upstream integration foundations that unblock Librarian Worker (05-02) and its tests (05-03):

1. **`packages/steward-core/src/op-mapping.ts`** — Extended with a `fullNote` PUT sub-branch at the top of the `upsert` case. When `payload.fullNote === true`, the function validates that `notePath` starts with `"Prompts/"` (throws `NonRetryableError` otherwise — fail-loud, ack+P3 downstream), then returns an early `OutboxIntent` with `method:"PUT"`, `path:"/vault/Prompts/<slug>.md"`, `Content-Type: text/markdown` headers, and the raw `noteBody` string as the body (not JSON-wrapped). Added `"PUT"` to `SAFE_METHODS`. Added `import { NonRetryableError } from "cloudflare:workflows"` (mirroring `apply.ts`). The existing frontmatter-field upsert path is fully unchanged below the new sub-branch.

2. **`packages/steward-core/test/op-mapping.test.ts`** — New pure-logic unit test file (no D1, no DO) with 6 tests covering the fullNote branch: PUT return shape, raw body, headers, non-Prompts/ rejection, missing-notePath rejection, and the existing PATCH path regression.

3. **`packages/model/src/claude.ts`** — Added `librarian: "claude-haiku-4-5"` to `TIER_MAP` so `claudeFor("librarian", env)` resolves to Haiku via `atlas-highvolume` gateway rather than falling through to Sonnet (4x cost, D-05).

4. **`migrations/0008_prompts.sql`** — New D1 migration: `prompts` table (`slug TEXT PRIMARY KEY`, `tool`, `full_prompt`, `title`, `tags TEXT` JSON array, `created`, `last_used`, `uses INTEGER DEFAULT 1`) + `idx_prompts_tool` index for the `WHERE tool = ?` scoped dedupe scan.

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Failing tests for fullNote PUT branch | 4656dc6 | packages/steward-core/test/op-mapping.test.ts |
| 1 (GREEN) | Implement fullNote PUT branch in op-mapping | 716cfcf | packages/steward-core/src/op-mapping.ts |
| 2 | Register librarian in TIER_MAP + create prompts migration | b7de394 | packages/model/src/claude.ts, migrations/0008_prompts.sql |

## Verification Results

- `pnpm --filter @atlas/steward-core test`: 6/6 passed (4 were failing in RED phase, all green after implementation)
- `pnpm --filter @atlas/model test`: 18/18 passed
- `pnpm test` (full suite): all packages passed — no regressions

## Deviations from Plan

None — plan executed exactly as written.

The PATTERNS.md early-return style for the fullNote branch was followed precisely. The entity fallback (`e.payload.notePath ?? e.entity`) from PATTERNS.md was intentionally NOT used — the plan's `<action>` explicitly says "the entity fallback is REMOVED for this branch" so an empty/missing notePath cannot resolve to a non-Prompts path. Using `""` as the fallback (not `e.entity`) ensures a missing notePath always triggers the `!startsWith("Prompts/")` guard.

## TDD Gate Compliance

- RED gate: commit `4656dc6` — 4 failing tests (NonRetryableError + PUT path tests) confirmed RED before implementation
- GREEN gate: commit `716cfcf` — all 6 tests pass after implementation
- No REFACTOR needed (code is clean as written)

## Threat Flags

None. All T-5-Tamper mitigations are in place:
- `notePath` MUST start with `"Prompts/"` — enforced as `NonRetryableError`, structurally unreachable otherwise
- `PUT` added to `SAFE_METHODS` but no DELETE ever added (Pillar 2 preserved)
- Migration is additive-only (`CREATE TABLE IF NOT EXISTS`) — touches no existing table

## Self-Check: PASSED

- FOUND: packages/steward-core/src/op-mapping.ts
- FOUND: packages/steward-core/test/op-mapping.test.ts
- FOUND: packages/model/src/claude.ts
- FOUND: migrations/0008_prompts.sql
- FOUND commits: 4656dc6, 716cfcf, b7de394
