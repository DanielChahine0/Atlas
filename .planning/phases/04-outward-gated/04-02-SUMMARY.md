---
phase: 04-outward-gated
plan: 02
subsystem: api
tags: [mcp, github-app, pull-requests, zod, installation-token]

# Dependency graph
requires:
  - phase: 00-spine
    provides: mcp-github Worker with McpAgent + OAuthProvider + github_put_file pattern

provides:
  - github_create_branch tool: creates a git branch via two-call REST sequence (read base SHA + create ref)
  - github_open_pr tool: opens a non-draft PR via POST /repos/{owner}/{repo}/pulls
  - mintTokenForUse() private helper enabling server-side GitHub API calls without token egress

affects: [04-06-envoy, integration-tests]

# Tech tracking
tech-stack:
  added: [zod@^4.4.3 (mcp-github package — Zod raw shapes for MCP SDK 1.29.0 registerTool inputSchema)]
  patterns:
    - mintTokenForUse() pattern for server-side GitHub REST calls with T-00-32/T-04-09 token containment
    - Zod raw shape inputSchema for MCP SDK 1.29.0 registerTool() (JSON Schema objects not accepted)

key-files:
  created: [apps/mcp-github/test/pr-tools.test.ts]
  modified: [apps/mcp-github/src/index.ts, apps/mcp-github/package.json, pnpm-lock.yaml]

key-decisions:
  - "Added mintTokenForUse() private method returning the token for server-side GitHub REST calls; mintToken() void stays unchanged for tools that only mint without calling GitHub"
  - "Used Zod raw shapes (not JSON Schema objects) for registerTool() inputSchema — MCP SDK 1.29.0 rejects JSON Schema; added zod@^4.4.3 to mcp-github dependencies"
  - "Both tools mint { contents:write, metadata:read, pull_requests:write } — same permissions object per plan T-04-10 (least-privilege but pull_requests:write required for PR creation)"
  - "[ASSUMED A1] pull_requests permission key name confirmed by plan — live App grant verification deferred to Task 2 checkpoint"

patterns-established:
  - "mintTokenForUse() pattern: returns the ghs_ token for local GitHub API use only; never returned in tool result, never logged (extends T-00-32 invariant)"
  - "githubHeaders(token) helper: assembles standard GitHub REST headers consuming the token synchronously"
  - "githubApiError(operation, status) helper: surfaces only HTTP status code in error result — no response body leakage"

requirements-completed: [OUTWARD-02]

# Metrics
duration: 20min
completed: 2026-06-08
---

# Phase 04 Plan 02: mcp-github PR Tools Summary

**github_create_branch + github_open_pr registered in mcp-github via MCP SDK 1.29.0 Zod raw shapes, gated by github.write, minting pull_requests:write with token contained server-side**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-06-08T09:49:00Z
- **Completed:** 2026-06-08T09:54:00Z
- **Tasks:** 1 of 2 complete (Task 2 is a blocking human-verify checkpoint)
- **Files modified:** 4

## Accomplishments

- Added `github_create_branch` tool: reads base branch SHA via `GET /repos/{owner}/{repo}/git/ref/heads/{fromBranch}`, then creates the new ref via `POST /repos/{owner}/{repo}/git/refs`. Gated by `hasScope("github.write")` → `forbidden()`.
- Added `github_open_pr` tool: calls `POST /repos/{owner}/{repo}/pulls` with `{ title, body, head, base, draft: false }`. Returns `pr_url` and `pr_number`. Gated by `github.write`.
- Added `mintTokenForUse()` private method — like `mintToken()` but returns the opaque token for server-side GitHub REST calls. Token consumed synchronously, never returned to MCP client (T-04-09 / T-00-32).
- Added `githubHeaders(token)` + `githubApiError(operation, status)` private helpers for GitHub REST call structure.
- Added `apps/mcp-github/test/pr-tools.test.ts`: 7 tests covering scope-pass (create-branch + open-pr with mocked GitHub responses), scope-fail (T-04-08), token-never-leaked (T-04-09), pull_requests:write permission assertion (T-04-10), and mintError on GitHub non-2xx.
- Added `zod@^4.4.3` to mcp-github dependencies — required for MCP SDK 1.29.0 `registerTool()` inputSchema (Zod raw shapes, not JSON Schema objects).

## Task Commits

1. **Task 1: Add github_create_branch + github_open_pr tools** - `c6be210` (feat)

## Files Created/Modified

- `apps/mcp-github/src/index.ts` — Added two `registerTool()` entries + `mintTokenForUse()`, `githubHeaders()`, `githubApiError()` private helpers; added `zod` import
- `apps/mcp-github/test/pr-tools.test.ts` — New test file: 7 tests for both tools (scope-pass, scope-fail, token-never-leaked, mintError)
- `apps/mcp-github/package.json` — Added `zod@^4.4.3` dependency
- `pnpm-lock.yaml` — Updated with zod addition

## Decisions Made

- **mintTokenForUse() vs. extending mintToken():** Added a new private method that returns the token rather than changing mintToken() to optionally return it. This preserves the existing void-returning helper and its existing test coverage for tools that only need to prove the token can be minted.
- **Zod raw shapes for inputSchema:** MCP SDK 1.29.0's `registerTool()` uses `isZodRawShapeCompat()` to detect valid schemas — it checks that values are Zod instances, not JSON Schema objects. Passed JSON Schema objects caused `getZodSchemaObject()` to throw "inputSchema must be a Zod schema or raw shape". Fixed by using Zod raw shapes and adding zod as a dependency.
- **No new scope string:** Both tools reuse the existing `github.write` scope (as directed by plan — GITHUB_SCOPES unchanged).
- **pull_requests:write in both tools:** Both `github_create_branch` and `github_open_pr` mint `{ contents:write, metadata:read, pull_requests:write }` per plan. The branch-create tool uses `contents:write` for the ref creation and `pull_requests:write` is included as the token will be used in a PR flow.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] MCP SDK 1.29.0 rejects JSON Schema inputSchema objects**
- **Found during:** Task 1 (GREEN phase — first test run)
- **Issue:** `registerTool()` with `inputSchema: { type: "object", properties: {...} }` threw `"inputSchema must be a Zod schema or raw shape, received an unrecognized object"`. The SDK's `getZodSchemaObject()` only accepts Zod instances or Zod raw shapes (objects where values are Zod schemas).
- **Fix:** Replaced JSON Schema object with Zod raw shape: `{ owner: z.string().describe(...), repo: z.string().describe(...), ... }`. Added `zod@^4.4.3` to mcp-github dependencies.
- **Files modified:** `apps/mcp-github/src/index.ts`, `apps/mcp-github/package.json`, `pnpm-lock.yaml`
- **Verification:** All 10 tests green, tsc --noEmit clean
- **Committed in:** `c6be210` (same task commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug in inputSchema format)
**Impact on plan:** Required fix for tools to register at all. Zod raw shapes are the SDK-native format and semantically equivalent to JSON Schema here. No scope creep.

## Issues Encountered

None beyond the auto-fixed deviation above.

## Known Stubs

None — both tools make real GitHub REST API calls using the installation token. The results return actual data from the GitHub response (branch name + SHA for create-branch; html_url + number for open-pr).

## Threat Flags

No new threat surface introduced beyond what the plan's threat model covers.

## Self-Check

- [x] `apps/mcp-github/src/index.ts` exists and contains `github_create_branch` + `github_open_pr`
- [x] `apps/mcp-github/test/pr-tools.test.ts` exists and all 7 tests pass
- [x] Commit `c6be210` exists
- [x] `pnpm --filter @atlas/mcp-github test` — 10 passed (3 existing + 7 new)
- [x] `pnpm --filter @atlas/mcp-github typecheck` — clean (no errors)

## Self-Check: PASSED

## User Setup Required

**Task 2 is a blocking human-verify checkpoint** (gate="blocking-human"). The owner must:

1. Go to GitHub → Settings → Developer settings → GitHub Apps → Atlas → Permissions & events.
2. Set "Pull requests" to "Read and write".
3. Verify the permission key is `pull_requests` (REST API field name).
4. Re-install / accept updated permissions on the scoped repos.
5. Confirm `GH_APP_INSTALLATION_ID` remains valid.

Resume signal: type "approved" (and the exact permission key string if it is not `pull_requests`), or describe any issue.

## Next Phase Readiness

- `github_create_branch` + `github_open_pr` are implemented and tested — ready for Envoy (plan 04-06) to call them via service binding.
- **Blocked:** plan 04-02 is NOT marked complete — Task 2 (GitHub App pull_requests:write permission grant) requires owner action before Envoy can fire a live PR end-to-end.

---
*Phase: 04-outward-gated*
*Completed: 2026-06-08 (Task 1 only — Task 2 awaiting owner checkpoint)*
