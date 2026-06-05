---
phase: 1
slug: core-loop-morning-pipeline
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-05
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Frontend-free phase — Cloudflare Workers + Obsidian markdown; no browser/E2E suite.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest + `@cloudflare/vitest-pool-workers` (runs in real `workerd`) |
| **Config file** | per-app `vitest.config.ts` (existing pattern: `apps/steward/vitest.config.ts`) |
| **Quick run command** | `pnpm --filter <app> test` |
| **Full suite command** | `pnpm -r build && pnpm -r typecheck && pnpm test` |
| **Estimated runtime** | ~20-30 seconds per app suite |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter <app> test`
- **After every plan wave:** Run `pnpm -r typecheck && pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

Each agent PR ships the three CLAUDE.md Definition-of-Done tests (Wire-contract, replay-through-Steward, failure-path Flagger-severity). `workerd` forces `TZ=UTC`; derive owner-local dates via `Intl`.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|--------|
| 01-01-* | 01 | 1 | CORE-01 | T-1-MCP | new MCP tools enforce per-scope floor (403 fail-closed) + redaction egress | unit | `pnpm --filter mcp-google test` | ⬜ pending |
| 01-02-* | 02 | 1 | FORGE-01 | T-1-D1 | tasks/dedupe in D1; positional `?` only | unit | `pnpm --filter @atlas/migrations-tasks test` (or `pnpm --filter forge test`) | ⬜ pending |
| 01-03-* | 03 | 2 | FILER-01 | T-1-SEC | labels-only; phishing/2FA never surfaced; idempotent on `AI/Reviewed` | unit | `pnpm --filter filer test` | ⬜ pending |
| 01-04-* | 04 | 3 | HERALD-01 | T-1-SEC | draft-only; redaction trip blocks draft + P2 | unit | `pnpm --filter herald test` | ⬜ pending |
| 01-05-* | 05 | 4 | FORGE-01 | T-1-SEC | task extraction; security-skip; replay no-op | unit | `pnpm --filter forge test` | ⬜ pending |
| 01-06-* | 06 | 5 | SUNDIAL-01 | T-1-CAL | calendar.events only; reconcile by atlasTaskId; re-run no dup | unit | `pnpm --filter sundial test` | ⬜ pending |
| 01-07-* | 07 | 6 | COMPASS-01 | T-1-CAL | calendar.readonly; overcommit→Couldn't-fit + P3; upsert not append | unit | `pnpm --filter compass test` | ⬜ pending |
| 01-08-* | 08 | 7 | CORE-01 | T-1-CHAIN | start-after-success + resume + halt-downstream; re-fire no-op | unit | `pnpm --filter atlas test` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- Existing infrastructure (Vitest + `@cloudflare/vitest-pool-workers`, `apply-migrations.ts` test helper) covers all phase requirements. Each new app scaffolds its own `vitest.config.ts` + `wrangler.test.jsonc` mirroring `apps/steward`. No separate Wave-0 test-scaffold plan is required — test files are authored alongside each agent in its own plan (Definition of Done).

*If a per-agent plan's `<automated>` references a test file not yet created, that test file is authored within the SAME plan's tasks (no cross-plan MISSING references).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| AI Gateway ceilings set ($20/$10) before Filer push goes live (D1-06) | FILER-01 | Cloudflare dashboard caps cannot be set from code | Owner sets per-gateway monthly ceilings in the AI Gateway dashboard; confirm before enabling the push path. |
| One-week pre-launch baseline captured (D1-03) | CORE-01 | Owner logs real triage/planning minutes over ~5 working days | Owner fills the baseline capture note before flipping the chain live (M1 go-live gate). |
| Live morning-chain dry run against real Gmail/Calendar | CORE-01 | Requires owner Google account + provisioned secrets/gateway | `wrangler workflows trigger atlas-morning-chain` after secrets are seeded; inspect labels/draft/tasks/calendar/Today note. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are authored in-plan (no cross-plan MISSING)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (existing infra covers all)
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-06-05
