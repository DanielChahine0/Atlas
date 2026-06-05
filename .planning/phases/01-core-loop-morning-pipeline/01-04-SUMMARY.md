---
phase: 01-core-loop-morning-pipeline
plan: 04
subsystem: api
tags: [herald, digest, gmail-draft, redaction, security, bucketing]

requires:
  - phase: 01-core-loop-morning-pipeline
    provides: "mcp-google Herald tools (Plan 01); @atlas/security redact/containsSecret; @atlas/wire send; @atlas/shared flag/localDate; @atlas/steward-core applyEvent"
provides:
  - "apps/herald Worker — Herald.daily WorkerEntrypoint (herald-daily step target) emitting herald:daily:<date>"
  - "bucket.ts five-section label→section map (fixed order) + ranking"
  - "guardrail.ts output-side containsSecret guardrail (block draft + P2) + pre-synthesis stripSnippet"
  - "digest.ts deterministic section-ordered renderer (snippets pre-stripped)"
affects: [forge, morning-chain, steward]

tech-stack:
  added: []
  patterns:
    - "Draft-only by construction (HeraldGmailTools has createDraft but NO send method)"
    - "Defense-in-depth redaction: pre-synthesis strip + output guardrail block+P2 + CI test"
    - "Deterministic bucketing (label-literal); model writes prose, never decides the bucket"

key-files:
  created:
    - apps/herald/src/index.ts
    - apps/herald/src/bucket.ts
    - apps/herald/src/digest.ts
    - apps/herald/src/guardrail.ts
    - apps/herald/wrangler.jsonc
    - apps/herald/wrangler.test.jsonc
    - apps/herald/vitest.config.ts
    - apps/herald/package.json
    - apps/herald/tsconfig.json
    - apps/herald/test/sections.test.ts
    - apps/herald/test/wire.test.ts
    - apps/herald/test/redaction.test.ts
    - apps/herald/test/apply-migrations.ts

key-decisions:
  - "Type/Newsletter → Other (reading queue), only Type/Promotion → Advertisement (the §5.8 distinction)."
  - "Daily every weekday, no Friday special-casing (D1-02) — the digest event is op:upsert keyed herald:daily:<date>."
  - "On a guardrail trip the draft is skipped, P2 raised, but the digest event is still emitted with draftId:null so the Vault glance stays observable (the leak is the flagged incident)."
  - "The redaction test was strengthened from the plan wording: the pre-strip catches a code-in-subject before the output guardrail, so the test now proves defense-in-depth (belt 1 keeps it out of the draft body; the guardrail belt is proven directly on a bypass body)."

patterns-established:
  - "Herald emits herald:daily:<date> (op:upsert) — WIRE producer only, no atlas-wire consumer"
  - "guardDigestOutput(env, body) is the single output-side guardrail; runDaily skips createDraft when blocked"

requirements-completed: [HERALD-01]

duration: 16 min
completed: 2026-06-05
---

# Phase 1 Plan 04: Herald (daily email digest) Summary

**Built the Herald Worker — a draft-only daily digest that buckets Filer's labels into the five fixed-order owner sections, strips every snippet pre-synthesis, runs an output-side containsSecret guardrail (block draft + P2 on a leak), creates a Gmail DRAFT to the owner (never sent — no send method exists), and emits a replay-safe herald:daily:<date> event.**

## Performance
- **Duration:** ~16 min
- **Tasks:** 3 (Task 3 TDD)
- **Files modified:** 13 created

## Accomplishments
- Five-section bucketing in fixed order with Newsletter/Promotion distinction + ranking.
- Defense-in-depth redaction: pre-synthesis strip + output guardrail (block+P2) + CI test.
- 12/12 DoD tests pass: section order, exact Wire-contract + replay no-op, redaction.

## Task Commits
1. **Task 1+2: Worker + bucket + guardrail + digest** - `(feat 01-04)`
2. **Task 3: sections/wire/redaction DoD tests** - `(test 01-04)`

## Verification
- `pnpm --filter @atlas/herald build && typecheck && test` — all green (12/12 tests, 3 files).
- No gmail_send/send_message call in src; `herald:daily:` structured key present.
- `queues.producers` only (no atlas-wire consumer).

## Deviations from Plan

**[Rule 1 - correctness] redaction test reframed to defense-in-depth** — Found during: Task 3 | The plan's wording assumed a code in a non-security subject would survive to the OUTPUT and trip the guardrail. In practice the pre-synthesis strip (belt 1, redact()) removes it first, so blocked:false is the CORRECT safe outcome. Reframed the test: belt 1 keeps the code out of the draft body (asserted on the created body); the output guardrail belt is proven directly on a bypass body (blocked:true + redacted text). | Files: apps/herald/test/redaction.test.ts | Verified: 12/12 pass | Commit: `(test 01-04)`.

**Total deviations:** 1 (test framing made stronger; production code unchanged). **Impact:** the invariant is proven more rigorously, not weakened.

## Self-Check: PASSED
- apps/herald/src/index.ts exports Herald (WorkerEntrypoint) + buildDigestEvent; guardrail.ts contains containsSecret (verified).
- `git log --grep="01-04"` returns 2 commits.

## Next
Ready — Forge (01-05) reuses Herald's Action Required refs; the chain (01-08) calls Herald.daily as step 2.
