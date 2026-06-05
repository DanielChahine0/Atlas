---
status: human_needed
phase: 01-core-loop-morning-pipeline
verified: 2026-06-05
requirements_checked: [CORE-01, FILER-01, HERALD-01, FORGE-01, SUNDIAL-01, COMPASS-01]
must_haves_verified: 8/8 plans (all automated checks pass)
human_verification:
  - id: HV-01-01
    item: "Live end-to-end morning-chain smoke (all six Workers connected + live Google/Obsidian creds)"
    expected: "wrangler dev with filer/herald/forge/sundial/compass running; fire __scheduled?cron=45+11+*+*+1-5; wrangler workflows instances describe atlas-morning-chain latest shows five ordered steps (filer-sweep→herald-daily→forge-morning→sundial-sync→compass-plan) + a terminal complete"
    why_human: "needs live Google OAuth + Obsidian bridge credentials + all six Workers in parallel dev — owner-provisioned, cannot run in CI"
  - id: HV-01-02
    item: "D1-06 — set the two AI-Gateway dollar ceilings in the Cloudflare dashboard"
    expected: "atlas-reasoning ≈ $20/mo + atlas-highvolume ≈ $10/mo set in Cloudflare dashboard → AI Gateway → Settings; filer.push_enabled stays false until both are set"
    why_human: "per-gateway spend ceilings cannot be set from code (no API primitive); owner-only dashboard action"
  - id: HV-01-03
    item: "D1-03 — one-week pre-launch baseline capture"
    expected: "≥5 working days of current inbox-triage + day-planning minutes logged in GO-LIVE-CHECKLIST.md before flipping the chain live"
    why_human: "an owner measurement commitment — only the owner can log their actual minutes"
  - id: HV-01-04
    item: "D1-04 — daily ~1-min miss-review habit + the Dashboard/Home.md Misses affordance"
    expected: "the Misses affordance present in Dashboard/Home.md; the owner runs the ~1-min 'did Atlas miss anything?' review each morning"
    why_human: "an owner habit + a Vault affordance the owner maintains; not an agent action"
---

# Phase 1 Verification: Core Loop / Morning Pipeline

## Status: human_needed

All **automated** acceptance criteria pass (build + typecheck + 264 tests green; every CI
invariant holds). The remaining items are **owner-only** go-live gates + a live-credential smoke
that cannot be satisfied by code — mirroring how Phase 0 ended (code-complete with live owner-gates
tracked). The phase is **code-complete**.

## Requirement Traceability (6/6 covered)

| Requirement | Plan(s) | Status |
|-------------|---------|--------|
| CORE-01 (one cron → one Workflow → 5 ordered steps; halt-downstream; re-fire no-op) | 01-01, 01-08 | ✓ code + tests |
| FILER-01 (Gmail labeler, gmail.modify only, idempotent, no 2FA surfaced) | 01-03 | ✓ code + tests |
| HERALD-01 (daily draft digest, 5 sections, output redaction guardrail) | 01-04 | ✓ code + tests |
| FORGE-01 (task/subtask extractor → D1, dedupe/merge, security-skip) | 01-02, 01-05 | ✓ code + tests |
| SUNDIAL-01 (task → calendar deadline blocks, reconcile no-delete, no dup) | 01-06 | ✓ code + tests |
| COMPASS-01 (day planner, overcommit surface, effort=medium KV-override, read-only) | 01-07 | ✓ code + tests |

## Automated Verification (all pass)

### Build / typecheck / test
- `pnpm -r build` → exit 0
- `pnpm -r typecheck` → exit 0
- `pnpm test` → exit 0 — **264 passed, 2 skipped** across 17 packages:
  - mcp-google 30 · tasks 12 · filer 9 · herald 12 · forge 11 · sundial 12 · compass 8 · atlas 43(+2 skip)
  - (plus the Phase-0 packages: security 39 · wire 11 · shared 6 · codex 11 · model 18 · steward 19 · dlq-sink 4 · mcp-github 3 · mcp-obsidian-bridge 17)

### CI hard invariants (Pillar-enforced)
- **Exactly ONE `atlas-wire` consumer** — `apps/steward/wrangler.jsonc` only; dlq-sink consumes
  `atlas-wire-dlq` (a different queue). All five Phase-1 agents + Atlas declare `producers` only.
  The `.claude/hooks/guard-wire-consumer.js` guard passes (exit 0) for every new wrangler file.
- **Digest 2FA/reset/login redaction backstop** — present and green: `apps/mcp-google/test/redact.test.ts`
  (server-side egress) + `apps/herald/test/redaction.test.ts` (pre-synthesis strip + output guardrail block+P2).

### Per-agent least-privilege + Pillar-2 (no destructive/outward path by construction)
- Filer: `gmail.modify` only — GmailTools has NO delete/trash/archive method; no `mail.google.com/` scope.
- Herald: `gmail.readonly` + `gmail.compose` — HeraldGmailTools has NO send method (draft-only).
- Forge: `gmail.readonly` read substrate — no Gmail/calendar/Vault write; tasks in D1 (never KV).
- Sundial: `calendar.events` — CalendarTools has NO delete method; dup/orphan → gated removal proposal.
- Compass: `calendar.readonly` — no calendar write tool; effort never hardcoded `high` (CONFIG-resolved, default medium, D1-05).
- mcp-google (Plan 01): each new tool fail-closed on its exact scope; no send/delete/trash/archive tool registered.

### Structured idempotency keys (no crypto.randomUUID for scheduled work)
- `filer:sweep:<date>` · `herald:daily:<date>` · `<task id>` (Forge) · `sundial-<date>` ·
  `compass:plan:<date>` · `morning-<date>` (Workflow instance id) — all stable + structured.

### Chain crux (CORE-01) — proven in apps/atlas/test
- Start-after-success: five steps run filer→herald→forge→sundial→compass, each agent invoked once.
- Halt-downstream: a forced Forge failure → Sundial/Compass NEVER invoked, Filer/Herald intact,
  exactly ONE `chain.halted` P2 emitted, the instance errors (run rethrows).
- Re-fire no-op: the dispatcher passes the SAME instance id `morning-<date>` on a re-fire.
- DST-safe budget gates: `step.sleepUntil` requested for the four gated stages.
- Dispatcher: both the EDT (`45 11 * * 1-5`) and EST (`45 12 * * 1-5`) cron forms create the instance.

### Local dry-run (credential-light)
- `wrangler dev --test-scheduled --local` loads the Atlas Worker with the `MORNING_CHAIN` Workflow
  binding + the five agent service bindings + the cron recognized, and reaches "Ready on localhost".
  (The agent service bindings show `[not connected]` because the agent Workers were not run in
  parallel dev — a full live chain smoke is the owner-gated item HV-01-01 below.)

## Human Verification Required (owner-only — NOT blocking, tracked)

See the frontmatter `human_verification` block and `GO-LIVE-CHECKLIST.md`:
1. **HV-01-01** — live end-to-end morning-chain smoke (all six Workers + live creds).
2. **HV-01-02 (D1-06)** — set the two AI-Gateway dollar ceilings in the Cloudflare dashboard.
3. **HV-01-03 (D1-03)** — one-week pre-launch baseline capture.
4. **HV-01-04 (D1-04)** — the daily ~1-min miss-review habit + the Dashboard/Home.md Misses affordance.

These cannot be satisfied by code (live credentials / dashboard-only settings / owner habits). The
phase is code-complete; flip the chain live after the owner satisfies them.
