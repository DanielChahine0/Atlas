---
status: partial
phase: 01-core-loop-morning-pipeline
source: [01-VERIFICATION.md]
started: 2026-06-05T00:00:00Z
updated: 2026-06-05T00:00:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Live end-to-end morning-chain smoke (HV-01-01)
expected: with filer/herald/forge/sundial/compass running in parallel dev, fire `__scheduled?cron=45+11+*+*+1-5` and `wrangler workflows instances describe atlas-morning-chain latest` shows five ordered steps (filer-sweep→herald-daily→forge-morning→sundial-sync→compass-plan) + a terminal `complete`. Needs live Google OAuth + Obsidian bridge creds + all six Workers connected.
result: [pending]

### 2. D1-06 — AI-Gateway dollar ceilings (HV-01-02)
expected: atlas-reasoning ≈ $20/mo + atlas-highvolume ≈ $10/mo set in Cloudflare dashboard → AI Gateway → Settings; `filer.push_enabled` stays false until both are set. Cannot be set from code (no API primitive).
result: [pending]

### 3. D1-03 — one-week pre-launch baseline (HV-01-03)
expected: ≥5 working days of current inbox-triage + day-planning minutes logged in GO-LIVE-CHECKLIST.md before flipping the chain live (the "time saved" ground truth).
result: [pending]

### 4. D1-04 — daily ~1-min miss-review + Dashboard/Home.md Misses affordance (HV-01-04)
expected: the Misses affordance present in Dashboard/Home.md; the owner runs the ~1-min "did Atlas miss anything?" review each morning (the ≥95% action-required-caught ground truth).
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
