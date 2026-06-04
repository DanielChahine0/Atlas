---
description: Audit current changes (or a path) against Atlas's 7 architectural invariants + the security model. Read-only — reports violations with file:line and the pillar each breaks, plus the minimal fix. Run before committing any agent code.
argument-hint: [optional path; defaults to the git diff]
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git status), Bash(rg:*)
context: fork
agent: pillar-auditor
model: inherit
---

Audit **$ARGUMENTS** against the Atlas invariants (the 5 pillars + security in @CLAUDE.md). If no path
was given, review the current `git diff`.

Report a short PASS/FAIL table across all 7 invariants, then each violation as
`file:line — pillar N — what's wrong — minimal fix`. Be specific and terse. Do not edit anything.
