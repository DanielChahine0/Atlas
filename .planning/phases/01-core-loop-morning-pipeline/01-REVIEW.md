---
phase: 01-core-loop-morning-pipeline
reviewed: 2026-06-05
depth: standard
files_reviewed: 35
verification: adversarial (13 per-finding verifiers + 4 fresh cluster re-reviewers)
findings:
  original_total: 13
  original_confirmed: 11
  original_not_a_bug: 2
  new_from_completeness_sweep: 12
  applying: 20
  deferred: 3
status: remediated
remediation:
  applied: 20
  deferred: 3
  tests_after: "315 passed, 2 skipped (was 265)"
  regression: "pnpm -r build + typecheck + test all green; one atlas-wire consumer; mcp-google no queue binding"
---

# Phase 1: Code Review Report (verified + remediated)

**Reviewed:** 2026-06-05 · **Depth:** standard · **Files reviewed:** 35
**Status:** remediated — all 20 confirmed fixes applied, 3 deferred to backlog; full regression green (315 tests pass, 2 skipped; Pillar-1 one-consumer invariant intact).

This report was produced in two passes: an initial `gsd-code-reviewer` pass (13 findings), then an **adversarial verification + completeness sweep** (17 agents: one skeptical verifier per finding + four fresh security/correctness re-reviewers over the critical clusters). The verification **downgraded 2 findings to not-a-bug, corrected 2 reviewer-proposed fixes, and surfaced 12 genuinely new defects** the first pass missed — all four clusters returned `invariantsHold=false`.

## Invariants that hold (verified, not flagged)
- **Pillar 1 (one consumer):** all six Phase-1 `wrangler.jsonc` files are `atlas-wire` producers only — no second consumer. Steward stays sole writer.
- **Pillar 2 (suggest-don't-destroy):** mcp-google registers no send/delete/archive/calendar-delete tool — destructive paths unreachable by construction; scope floors per-tool, fail-closed.
- **Redaction is code-enforced** (not prompt-only) on every mcp-google egress + Herald guardrail + Forge skip — *except* the fragment/path-token URL bypass (NEW-MH2) and the dead mcp-google flag (NEW-MH1).
- **Idempotency keys** stable/structured; no `crypto.randomUUID` on a replayable path — *except* the merge-key collision (NEW-F3) and the preview/plan key collision (NEW-SC2).
- **D1** positional `?` params only; absolute counter math. **Workflow** awaits steps (start-after-success), carries state forward (no `event.payload` mutation) — *except* the `emitHalt` memoization/key issues (NEW-AW1/2).

---

## Original 13 — adjudicated verdicts

| ID | Verdict | Severity | Action |
|----|---------|----------|--------|
| CR-01 | real | critical→**warning** (ON CONFLICT guard absorbs worst case) | **FIX** — engage `ForgeLock` in `Forge.morning()` |
| WR-01 | real | warning→**info** | **FIX** — conditional overcommit message |
| WR-02 | real | warning | **FIX** — NUL separator + comment + test |
| WR-03 | real | warning | **FIX** — full-digest id (reviewer's `ON CONFLICT(id)` alt **rejected** — corrupts data) |
| WR-04 | **not a bug** | — | won't fix (date frozen at cron time; past gate resolves immediately by design) + doc comment |
| WR-05 | real but mis-cited | warning→**info** | reviewer cited a non-existent `sundial/score.ts` + a test-breaking fix; real bug is in `compass/score.ts` → NEW-SC1 |
| WR-06 | real but moot | warning | **superseded by NEW-MH1** (the flag can never fire, so the hardcoded `sourceAgent` is moot) |
| IN-01 | **not a bug** | — | won't fix (deliberate defense-in-depth double-scan) |
| IN-02 | real | info | **FIX** — observable fallback (`console.warn`) in `localtime.ts` + `deadline.ts` |
| IN-03 | real | info | **FIX** — remove dead `MORNING_CHAIN_DO` binding (3 sites) |
| IN-04 | real (broader than cited) | warning | **FIX** — reminder lead times `[1440,60]` / `[1440]` (minimal; full ladder deferred) |
| IN-05 | real | info | **FIX** — `fridayOf` roll-to-coming-Friday (reviewer's `Math.max` alt rejected) |
| IN-06 | real | info | **FIX** — `upcoming7d` lower bound + owner-local anchor |

## 12 new defects from the completeness sweep

**forge+tasks**
- **NEW-F1** (warning) — explicit-deadline path is **dead code**: `ExtractedTask` has no `due`/`eod`, so `inferDeadline`'s explicit branch never fires → a stated "by EOD Mon Jun 2" is mis-inferred (**fails a Phase-1 AC**; also pollutes the `due`-bearing dedupe key). **FIX** — thread `explicitDue`/`eod` through extractor → signals.
- **NEW-F3** (warning) — insert & merge events share `idempotencyKey=taskId`; Steward dedups → a real merge (priority bump / earlier due) **never reaches the Vault** (Pillar 4 divergence). **FIX** — merge event key carries change identity.
- **NEW-F4** (info) — subtask identity is positional (`<id>-s<i>`); reordering silently drifts titles. **DEFER** (content-stability nicety).

**mcp-google+herald**
- **NEW-MH1** (warning) — mcp-google's documented P1 secret-block flag **can never emit** (no `WIRE` binding → throws → swallowed). Redaction still holds (not a leak) but the observability leg is dead; supersedes WR-06. **FIX** — drop the dead emit, `console.warn`, return `isError`, fix header.
- **NEW-MH2** (warning) — **redaction bypass**: tokens in a URL fragment (`#access_token=…`) or opaque path segment evade `redact()` + `containsSecret()` on the primary egress. **FIX** — fragment/path-token patterns + adversarial fixtures.
- **NEW-MH3** (info) — Herald `bucket` under-ranks "③ Awaiting Reply from a company" vs spec. **DEFER** (low; most company threads also carry VIP/Job labels).

**sundial+compass**
- **NEW-SC1** (warning) — Compass `score.ts` anchors "today" at **UTC midnight**, mis-ranking every offset-bearing due one urgency band too low (overdue not pinned); masked by date-only tests. **FIX** — owner-local anchor + datetime-due test.
- **NEW-SC2** (warning) — Compass 21:00 preview reuses `compass:plan:<date>` → **silently deduped by Steward**, and plans today not tomorrow. **FIX** — `compass:preview:<targetDate>` + plan tomorrow.
- **NEW-SC3** (warning) — Sundial **orphan propose-removal** (spec-required, gated) is unimplemented (only duplicates handled). **FIX** — orphan loop (proposal only, no delete).
- **NEW-SC4** (info) — `upcoming7d` UTC anchor (folded into IN-06 fix); payload shape count-vs-list **DEFER** (needs Steward-consumer coordination).
- **NEW-SC5** (info) — at-risk items double-listed in `couldnt_fit` + `at_risk`. **FIX** — disjoint sets.

**atlas-workflow**
- **NEW-AW1** (warning) — `emitHalt` not memoized (re-sends on replay) + key derived from volatile `err.message` → violates "exactly one chain.halted P2". **FIX** — `step.do` memoize + stable `date+step` key.
- **NEW-AW2** (warning) — if `emitHalt` throws, the original error is masked and the P2 is silently dropped. **FIX** — best-effort emit + always rethrow.
- **NEW-AW3** (info) — `create().catch(()=>{})` swallows a transient first-fire failure → whole-day silent skip. **FIX** — discriminate id-exists vs real error + observe.

---

## Deferred (accepted for backlog, not Phase-1 blocking)
- **NEW-F4** — subtask positional-identity drift → hash subtask ids by normalized title.
- **NEW-MH3** — Herald company-awaiting-reply ranking vs spec (or update spec).
- **NEW-SC4 (payload shape)** — `upcoming7d` count vs list contract with the Steward/Vault renderer.

_Verified: 2026-06-05 · Reviewer: gsd-code-reviewer + adversarial verification workflow (17 agents)_
