---
description: Answer "what does the Atlas design say about X" from the canonical docs (SPEC-CANON is authoritative). Greps docs/ + .planning/ and quotes the source with path#section. Use to resolve any design question before coding.
argument-hint: [topic — e.g. "Steward idempotency" or "Filer scopes"]
allowed-tools: Read, Grep, Glob
model: inherit
---

Find what the Atlas design says about: **$ARGUMENTS**

Search in precedence order (SPEC-CANON wins on any conflict):
1. `docs/SPEC-CANON.md` — authoritative
2. `docs/13-build-plan.md` — the how-to-build, with pins
3. `docs/agents/<codename>.md`, `docs/0*-*.md`
4. `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/intel/decisions.md`

Quote the governing passage with its `path#section`, then give a 2–3 line answer. If sources
disagree, state which wins and why (SPEC-CANON > build-plan > topic docs).
