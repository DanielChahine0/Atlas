# Atlas — Claude Code productivity setup

This directory (plus `CLAUDE.md`, `.mcp.json`, `.gitignore` at the repo root) configures Claude Code
to be maximally productive and safe on the Atlas codebase. Here's what each piece does and how to
turn it on.

## What's here

| File | Purpose |
|---|---|
| `../CLAUDE.md` | **The brain.** Loaded into every session: the 5 pillars + security, pinned versions, conventions, repo layout, build phases, agent roster, key commands, gotchas, and a doc map. Start here. |
| `../.mcp.json` | **MCP servers.** `context7` + `cloudflare-docs` (current docs for fast-moving SDKs) + `github`. |
| `settings.json` | **Permissions + hooks + MCP gating.** Auto-approves safe build/test/git/wrangler-read; asks before deploy/delete/secrets/push; denies reading secret files. |
| `commands/*.md` | **Slash commands** — Atlas-specific workflows (below). |
| `agents/*.md` | **Subagents** — `cloudflare-researcher`, `pillar-auditor`, `spec-keeper`. |
| `hooks/*.js` | **Hooks** — block secrets from being written; confirm SPEC-CANON edits; inject GSD phase at session start. |

## One-time setup

1. **Verify the MCP servers connect.** In a Claude Code session run `/mcp`. `context7` and
   `cloudflare-docs` need no auth. `github` is optional and needs a token:
   ```bash
   export GITHUB_PAT="github_pat_…"   # fine-grained PAT; add to your shell profile, NOT to git
   ```
   (Until you set `GITHUB_PAT`, the `github` server simply won't connect — harmless.)
2. **Optional:** a Context7 API key raises rate limits — `export CONTEXT7_API_KEY=…` and add an
   `Authorization: Bearer ${CONTEXT7_API_KEY}` header to the `context7` entry in `.mcp.json`.
3. `settings.json` sets `enableAllProjectMcpServers: true`, so the servers load without a prompt.
4. Hooks run via `node` — already a project prerequisite, no extra install.

## Slash commands

| Command | Does |
|---|---|
| `/cf-docs <topic>` | Pulls **current** Cloudflare/Workers/Agents-SDK/MCP-SDK docs via context7 + cloudflare-docs, checks them against Atlas's pins. Run before writing Workers/MCP code. |
| `/new-agent <codename> <phase>` | Scaffolds a roster agent with all conventions (bindings, Wire event, idempotency key, least-privilege scope, gates, 3-test DoD). |
| `/pillar-check [path]` | Audits the diff (or a path) against the 7 invariants + security via the `pillar-auditor` subagent. Run before committing. |
| `/wire-event <agent> <op> <entity>` | Generates/validates a canonical SPEC §6.4 Wire event with a correct structured `idempotencyKey`. |
| `/migration <name>` | Scaffolds a numbered D1 migration against the canonical schema with the D1 rules baked in (positional `?`, absolute increment, `new_sqlite_classes`). Phase 0 is D1-centric. |
| `/spec <topic>` | Answers a design question from the canonical docs (SPEC-CANON wins), quoting `path#section`. |
| `/prereqs` | Checks the Phase-0 prerequisites (Cloudflare account + wrangler login, Node LTS, pnpm, Queues reachable). Workers Free suffices; Paid is optional headroom. |
| `/cron-utc <time>` | Translates an owner-local time to a UTC cron (with the EST↔EDT/DST caveat). |

## Subagents (delegate proactively)

- **`cloudflare-researcher`** — live Cloudflare/MCP SDK syntax + version-pin drift (context7 + cloudflare-docs).
- **`pillar-auditor`** — read-only check against the 7 invariants + security model.
- **`spec-keeper`** — design Q&A faithful to SPEC-CANON; flags drift from intent.

## Hooks

- **`guard-secrets.js`** (PreToolUse on Write/Edit/MultiEdit) — **denies** writing a plaintext
  credential (Anthropic key, private key, GitHub/Google token) into any file (Pillar: secrets only via
  bindings); **asks** before editing the authoritative `docs/SPEC-CANON.md`.
- **`guard-wire-consumer.js`** (PreToolUse on Write/Edit/MultiEdit) — enforces Pillar 1 at write time:
  **denies** a `queues.consumers` block on `atlas-wire` in any Worker other than Steward (a second
  Vault writer is a hard CI fail). The DLQ (`atlas-wire-dlq`) is exempt.
- **`session-context.js`** (SessionStart) — injects the current GSD phase / focus / next-action from
  `.planning/STATE.md` so each session opens already oriented.

## Conventions for editing this setup

- Keep `CLAUDE.md` lean and scannable — link to `docs/` for depth rather than duplicating it.
- Personal, machine-local overrides go in `CLAUDE.local.md` or `.claude/settings.local.json`
  (both git-ignored). Never put secrets in `settings.json` or `.mcp.json` (they're committed) — use
  `${ENV_VAR}` expansion and your shell profile.
- These pins move fast — when `/cf-docs` or `cloudflare-researcher` reports newer versions, update the
  table in `CLAUDE.md`.
