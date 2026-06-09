---
phase: 05-meta-polish
plan: "04"
subsystem: switchboard
tags: [switchboard, mcp-registry, slash-command, design-time, meta]
dependency_graph:
  requires: []
  provides:
    - .claude/registry/mcp-registry.json (machine-readable MCP registry)
    - .claude/commands/switchboard.md (read-only /switchboard slash-command)
    - docs/10-switchboard.md (formalized 6-step runbook with actionable gap emit)
    - test/mcp-registry.test.mjs (persistent registry-schema validation)
  affects:
    - package.json (root test script chains test:registry)
tech_stack:
  added: []
  patterns:
    - tracked-json-registry (read at design time via Read tool, no KV required)
    - slash-command-read-only (allowed-tools: Read/Glob/context7/WebSearch only)
    - node-builtin-test (node --test for repo-root file reads outside workerd pool)
    - d07-raw-incident-gap-emit (severity-annotated §6.4 RawIncident + flag() producer path)
key_files:
  created:
    - .claude/registry/mcp-registry.json
    - .claude/commands/switchboard.md
    - test/mcp-registry.test.mjs
  modified:
    - docs/10-switchboard.md
    - package.json
decisions:
  - "Registry stored as tracked JSON at .claude/registry/mcp-registry.json rather than CONFIG KV: design-time /switchboard command reads it via the Read tool with zero runtime dependencies; KV is unreachable at design time."
  - "Persistent registry-schema test uses Node built-in node:test (not vitest workerd pool): the workerd pool in @atlas/shared cannot reach repo-root files outside the workerd bundle boundary; plain Node reads the file directly."
  - "Switchboard remains NOT a deployed Worker (D-07): zero wrangler.jsonc entries added; zero new atlas-wire or atlas-incidents consumers."
metrics:
  duration: "~9 minutes (535 seconds)"
  completed: "2026-06-09"
  tasks_completed: 3
  files_modified: 5
---

# Phase 5 Plan 04: Switchboard Design-Time Deliverable Summary

**One-liner:** Switchboard shipped as D-06 three-part design-time artifact — machine-readable MCP registry JSON, read-only /switchboard slash-command with Pillar hard rules + actionable D-07 gap emit, and formalized 6-step runbook in docs/10-switchboard.md, backed by a persistent registry-schema test under `pnpm test`.

---

## Objective

Ship Switchboard (META-02) as the D-06 three-part design-time deliverable — NOT a deployed Worker: (a) `.claude/registry/mcp-registry.json`, (b) `.claude/commands/switchboard.md`, and (c) a formalized `docs/10-switchboard.md`. Bake Pillar-1 + Pillar-2 hard rules into the algorithm. Define the actionable D-07 producer-only gap→Flagger emit (severity-annotated §6.4 RawIncident + one-command emit path). Add a persistent registry-schema test.

---

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Machine-readable MCP registry JSON | 48eea16 | `.claude/registry/mcp-registry.json` |
| 2 | /switchboard slash-command + runbook formalization | 1223cfd | `.claude/commands/switchboard.md`, `docs/10-switchboard.md` |
| 3 | Persistent registry-schema validation test | 498b749 | `test/mcp-registry.test.mjs`, `package.json` |

---

## What Was Built

### Task 1: `.claude/registry/mcp-registry.json`

A tracked, version-controlled JSON file mirroring the `docs/10-switchboard.md` REGISTRY table. Shape:

```
{
  version: "1",
  servers: [12 entries — Gmail, Google Calendar, Google Drive, Google Sheets,
            GitHub, Obsidian, Playwright/browser, Canva, Notion, Slack,
            context7, cloudflare-docs],
  side_effect_verbs: [post, register, pay, delete, submit, send, publish, ...],
  ranking_weights: { specificity_over_generality, read_before_write, health_penalty,
                     pillar1_single_writer (HARD_RULE), pillar2_gate_irreversible (HARD_RULE) },
  gap_severity_map: { no_mcp_for_capability→P3, mcp_disconnected_blocks_goal→P2,
                      missing_oauth_scope→P3, ungated_outward_toolset→P1 }
}
```

Every server entry includes: `name`, `best_at` (capability tags), `tools` (representative tool names), `owning_agents` (Pillar-1 single-writer data), `scopes` (OAuth), `health` (connected|degraded|absent), `notes`.

### Task 2: `.claude/commands/switchboard.md`

Read-only slash-command (`allowed-tools: Read, Glob, mcp__context7__resolve-library-id, mcp__context7__query-docs, WebSearch`) with `model: inherit`. NEVER includes Write, Edit, or Bash.

Body runs the 6-step algorithm for `$ARGUMENTS`:
1. Intent extraction (verb + object + outcome + side-effect class)
2. Capability map (abstract capabilities, not product names)
3. MCP shortlist (with Pillar-1 hard rule: no second writer via `owning_agents` field)
4. Tool + resource resolve (minimal tool set, bind concrete resources)
5. Scope check (required scopes, `needs-consent` if missing)
6. Assemble toolset (with Pillar-2 hard rule: `confirmation_gate: true` for outward verbs)

**Gap Protocol (D-07):** On a gap, outputs a severity-annotated §6.4 RawIncident JSON plus the documented one-command producer-only emit path (`flag()` from `@atlas/shared`, `atlas-incidents` PRODUCER, no new consumer).

Formalization pass on `docs/10-switchboard.md`:
- Added invocation note (slash-command + registry location)
- Hardened selection heuristics with explicit HARD RULE annotations for Pillar-1 and Pillar-2
- Added registry note: machine-readable source at `.claude/registry/mcp-registry.json`
- Added D-07 actionable gap emit section: severity map table, §6.4 RawIncident shape, one-command emit
- Updated Config section: registry lives at `.claude/registry/mcp-registry.json` (not KV)
- Added Deferred items section (health cadence, auto-execute, learning loop — all out of scope)

### Task 3: `test/mcp-registry.test.mjs` + `package.json`

Persistent registry-schema test using Node.js built-in `node:test` (LTS v22+). Reads `.claude/registry/mcp-registry.json` from the repo root and asserts:
- `version` is a non-empty string
- `servers` is a non-empty array
- Every server has `name`, `best_at`, `tools`, `owning_agents`, `scopes`, `health` (all required keys)
- `health` ∈ {connected, degraded, absent}
- `side_effect_verbs` contains post, register, pay, delete, submit, send
- `ranking_weights` is a non-null object
- Gmail, GitHub, and Obsidian servers are present (minimum required)

8/8 tests pass. Chained into the root `test` script via `"test:registry": "node --test test/mcp-registry.test.mjs"`.

**Why plain Node instead of workerd vitest:** The `@atlas/shared` vitest pool runs inside real `workerd`, which cannot read files from the repo root outside the workerd bundle boundary. A plain Node test reads the file directly without any framework overhead and introduces no new tooling.

---

## Deviations from Plan

None — plan executed exactly as written.

The workerd/Node fallback for Task 3 was explicitly documented in the plan's action spec ("If `@atlas/shared`'s workerd pool cannot read a repo-root file cleanly, fall back to the next-lowest-friction option: add a `test:registry` script to the ROOT `package.json`..."). The fallback was invoked as specified.

---

## Known Stubs

None. This plan ships documentation, configuration JSON, and a test — no UI or data-source wiring required.

---

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. This plan is entirely design-time: a tracked JSON file, a Claude Code slash-command (markdown), a doc edit, and a Node test. No Worker, no wrangler entry, no Cloudflare binding, no new `atlas-wire` or `atlas-incidents` consumer.

---

## Self-Check

### Files exist:
- `.claude/registry/mcp-registry.json`: present ✓
- `.claude/commands/switchboard.md`: present ✓
- `test/mcp-registry.test.mjs`: present ✓
- `docs/10-switchboard.md`: updated ✓
- `package.json`: updated with test:registry ✓

### Commits exist:
- 48eea16: feat(05-04): create machine-readable MCP registry JSON ✓
- 1223cfd: feat(05-04): add /switchboard slash-command and formalize runbook ✓
- 498b749: test(05-04): add persistent registry-schema validation test ✓

### Test suite:
- `pnpm test` exits 0; all workspace tests pass; registry test 8/8 pass ✓

## Self-Check: PASSED
