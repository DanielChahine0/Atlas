# Morning-Chain Go-Live Checklist (Phase 1 / CORE-01)

> The three committed owner gates that must be satisfied **before** flipping the morning chain
> fully live and **before** enabling Filer's continuous push. These are OWNER actions — they
> cannot be set from code. Steward/Obsidian can render this checklist on the dashboard.
>
> Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

---

## Gate 1 — D1-03: One-week pre-launch baseline (the "time saved" ground truth)

**Why:** the headline "time saved" metric is only falsifiable against a real baseline. Log the
current inbox-triage + day-planning minutes for **~5 working days BEFORE** flipping the chain live.

**Owner action — capture template (log one row per working day):**

| Date | Inbox-triage minutes | Day-planning minutes | Notes |
|------|----------------------|----------------------|-------|
|      |                      |                      |       |
|      |                      |                      |       |
|      |                      |                      |       |
|      |                      |                      |       |
|      |                      |                      |       |

- [ ] Baseline capture started (≥1 working day logged).
- [ ] Five working days logged → baseline complete (required before M1 go-live).

---

## Gate 2 — D1-04: Daily ~1-min "did Atlas miss anything?" review

**Why:** ground truth for the **≥95% action-required-caught** metric and the early-warning signal
for Filer/Herald misclassification. Each morning, during the glance, confirm Atlas caught the real
action-required items and log any miss with one tap.

**Where it lives:** the morning glance in `Dashboard/Home.md` (the §6.3 morning-glance set the
Compass `day_plan` event already drives — top-3 + counters). The "missed" affordance is a one-line
**owner append** in `Dashboard/Home.md` (the owner appends it — never an agent; Steward renders the
glance, the owner records the miss):

```
## Misses (owner log)
- 2026-06-05 — Missed: <thread/subject> — should have been ① Action Required
```

- [ ] The "missed" affordance is present in `Dashboard/Home.md` (a Misses section exists).
- [ ] The daily ~1-min review habit is in place (the owner knows where to log a miss).

---

## Gate 3 — D1-06: AI-Gateway monthly spend ceilings (BEFORE Filer's push goes live)

**Why:** there is no per-agent hard-budget primitive — only per-gateway. The continuous-push path
(Filer task #2) must **NOT** go live until the dashboard caps exist. `filer.push_enabled` stays
`false` until then.

**Owner action — set in the Cloudflare dashboard → AI Gateway → (each gateway) → Settings:**

- [ ] `atlas-reasoning` monthly spend ceiling set ≈ **$20/mo** (Opus: Atlas/Compass/Archivist).
- [ ] `atlas-highvolume` monthly spend ceiling set ≈ **$10/mo** (Haiku: Filer continuous + sweep).
- [ ] **`filer.push_enabled` stays `false`** (CONFIG KV) until BOTH ceilings are set.

> The ceilings are conservative **starters** to tune from real volume — not a hard budget the owner
> is married to. Revisit after observing real morning-chain + push volume.

---

## Success-metric window (D1-07)

- Morning-chain success-rate is measured over a **rolling 30 days** (SRE-style window) — NOT
  since-launch cumulative. The ≥99% target ages out early-launch hiccups and stays sensitive to
  recent regressions.

---

## Local chain dry-run (credential-light, before live)

```bash
# 1. Start the dev server with scheduled() enabled:
npx wrangler dev --test-scheduled
# 2. Fire the 07:45 morning-chain cron (spaces → +):
curl "http://localhost:8787/__scheduled?cron=45+11+*+*+1-5"
# 3. Inspect the latest MorningChain instance — expect five ordered steps + a terminal status:
npx wrangler workflows instances describe atlas-morning-chain latest
```

- [ ] Dry-run shows five ordered steps (filer-sweep → herald-daily → forge-morning → sundial-sync
      → compass-plan) and a terminal status.

---

## Final go-live gate

- [ ] Gate 1 (baseline), Gate 2 (miss-review affordance), and Gate 3 (gateway ceilings) all satisfied.
- [ ] Only then: flip the chain live and (separately) set `filer.push_enabled=true`.
