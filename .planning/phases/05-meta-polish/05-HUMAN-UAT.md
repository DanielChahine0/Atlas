---
status: partial
phase: 05-meta-polish
source: [05-VERIFICATION.md]
started: 2026-06-09T21:05:00Z
updated: 2026-06-09T21:05:00Z
---

## Current Test

[awaiting human testing — all four items require the owner go-live gates (Secrets Store seed, deployed Workers, live Obsidian bridge daemon); see `.planning/STATE.md` → Blockers]

## Tests

### 1. Vault write end-to-end (live provisioning)

expected: POST `/prompt/save` with `Authorization: Bearer <ATLAS_LIBRARIAN_TOKEN>` and body `{"full_prompt":"You are a code reviewer focused on security. Identify vulnerabilities in the provided code.","tool":"Claude"}` returns HTTP 200 `{"slug":"...","action":"new"}`. Within 5–10 s the Obsidian vault shows `Prompts/<slug>.md` with YAML frontmatter (title ≤6 words from Haiku, tool, tags, created/last_used `YYYY-MM-DD`, uses: 1) followed by the full prompt body.
result: [pending]

### 2. Same-day re-save bump (Vault note updates)

expected: Saving the same/similar prompt twice in one day → second call returns `action:bump`, D1 `uses` increments to 2, and the Vault note's `uses:` frontmatter matches D1 (not stale). Validates the CR-01 content-hash-extended bump key (`librarian:<slug>:save:<date>:<contentHash>`) end-to-end through a live Steward bridge write.
result: [pending]

### 3. /switchboard slash-command invocation

expected: `/switchboard register me for the PyCon 2026 conference using the link at https://pycon.org/registration` produces a well-formed JSON recommendation: `confirmation_gate: true`, `executing_agent: "Usher"`, `side_effect: "outward-irreversible"`, mcps listing Playwright + Google Calendar, `scope_status` noting calendar.events. No Write/Edit/Bash tool calls occur during execution.
result: [pending]

### 4. Vault prompt-library table rendering in Obsidian

expected: After 2–3 live saves, the Obsidian dashboard prompt-library table renders with Title link · Tags · Tool · Last used columns; Title deep-links to the correct `Prompts/<slug>.md` note; rows sorted by `uses` descending (most-used at top). Satisfies ROADMAP Phase-5 success criterion 1 literally.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
