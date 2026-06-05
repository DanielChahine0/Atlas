# Phase 1: Core Loop / Morning Pipeline - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-05
**Phase:** 1-Core Loop / Morning Pipeline
**Areas discussed:** Herald output surface, Measurement commitments, Cost guardrails, Success-metric window

---

## Herald output surface

| Option | Description | Selected |
|--------|-------------|----------|
| Gmail draft (v1 plan) | Keep the build-plan v1 Gmail draft (never sent) + the Wire event feeding the Vault morning-glance | ✓ |
| Vault-glance-only | Drop the Gmail draft; digest lives only as the Vault glance | |
| Both, equal weight | Gmail draft AND a full Vault digest note beyond the glance | |

**User's choice:** Gmail draft (v1 plan)
**Notes:** Inbox is where the owner already triages; the draft is harmless (no send scope). → D1-01.

### Friday daily behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Keep daily every weekday | 08:00 daily Mon–Fri unconditionally; Friday weekly review (Phase 2) is additive | ✓ |
| Suppress daily on Fridays | Skip the 08:00 daily on Fridays since the 16:00 weekly review covers the week | |

**User's choice:** Keep daily every weekday
**Notes:** Simplest rule; Phase 1 ships before the weekly even exists, so no day-of-week branch. → D1-02.

---

## Measurement commitments

### Pre-launch baseline

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — commit to 1-week baseline | Log triage/planning minutes ~5 working days before go-live | ✓ |
| Lighter — 2-3 day spot check | A shorter, rougher baseline | |
| Skip — metrics stay directional | No formal baseline | |

**User's choice:** Yes — commit to 1-week baseline
**Notes:** Ground truth for the time-saved headline metric; "baseline captured" is a go-live gate. → D1-03.

### Daily review

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — commit to the daily review | ~1-min daily "did Atlas miss anything?" confirmation, logging misses | ✓ |
| Weekly instead of daily | Once-a-week sweep | |
| Skip — no formal accuracy check | Notice misses organically | |

**User's choice:** Yes — commit to the daily review
**Notes:** Ground truth for the ≥95% action-required-caught metric; early-warning for Filer/Herald misclassification. → D1-04.

---

## Cost guardrails

### Compass Opus effort

| Option | Description | Selected |
|--------|-------------|----------|
| Medium | effort:medium, KV-overridable (compass.effort) | ✓ |
| Low | Cheapest daily pass | |
| High (default) | Maximum reasoning every day | |

**User's choice:** Medium
**Notes:** Daily plan synthesis is largely deterministic; medium balances cost/quality; KV-overridable for hard days. → D1-05.

### AI Gateway ceilings

| Option | Description | Selected |
|--------|-------------|----------|
| Conservative starter caps | atlas-reasoning ≈ $20/mo, atlas-highvolume ≈ $10/mo as a go-live checklist item | ✓ |
| I'll provide exact numbers | Owner-supplied budgets | |
| Defer to dashboard later | Note as open action, no numbers | |

**User's choice:** Conservative starter caps
**Notes:** No per-agent hard-budget primitive exists; caps must be set in dashboard before Filer's continuous push goes live; tunable from real volume. → D1-06.

---

## Success-metric window

| Option | Description | Selected |
|--------|-------------|----------|
| Rolling 30 days | Trailing-30-day success rate (SRE-style) | ✓ |
| Since-launch cumulative | All runs since go-live | |

**User's choice:** Rolling 30 days
**Notes:** Reflects current reliability, ages out early hiccups, stays sensitive to recent regressions. → D1-07.

---

## Claude's Discretion

- Per-step retry/timeout tuning (build-plan §3 starting policy, KV-overridable).
- `invokeAgent` step return shapes (transport locked to service-binding RPC by Phase-0 D-11).
- D1 `tasks`/`subtasks` schema + `idx_tasks_dedupe`, Forge dedupe/merge, Sundial `extendedProperties` stamp, Compass scoring weights / free-busy grid params.
- OAuth scope strings, label-taxonomy bootstrap diff, `step.sleepUntil` `localTime()` helper.

## Deferred Ideas

- Herald weekly review (Fri 16:00) + 16:30 weekly-review Steward build — Phase 2.
- Filer continuous push + 06:00 watch renewal — Phase-1 scope but gated on D1-06 before go-live; sweep step ships first.
- AI Gateway ceiling exact tuning — after observing real volume.
- Workflow-state retention >3 days — Phase-4 (Usher/Envoy) concern.
- Headhunter → Forge event-driven path — Phase 2.
