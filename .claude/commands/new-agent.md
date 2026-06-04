---
description: Scaffold a new Atlas agent (Worker) that inherits every project convention — binding names, the Wire event contract, structured idempotency keys, least-privilege scope, gate rules, and the 3-test Definition of Done. Use when building an agent from the roster.
argument-hint: [codename] [phase] — e.g. "scout 2"
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(npx wrangler:*), Bash(pnpm:*)
model: inherit
---

Scaffold the **$1** agent (build phase **$2**). Follow Atlas conventions in @CLAUDE.md exactly.

First read the source of truth:
- `docs/agents/$1.md` — this agent's contract (scope, trigger, writes-to, model tier, gates)
- `docs/13-build-plan.md` — the relevant phase's task list + acceptance criteria
- `packages/wire`, `packages/model`, `packages/shared` — reuse these; do NOT re-implement the contract

Then produce:
1. **`apps/$1/wrangler.jsonc`** — `name: "$1"`, `compatibility_flags: ["nodejs_compat"]`, the
   `$schema` line, and ONLY the bindings this agent needs (least privilege — e.g. Filer gets
   `gmail.modify` and nothing else). Any cron lines in **UTC** with an inline owner-local comment
   (use `/cron-utc`). Only Steward carries a `queues.consumers` block.
2. **`apps/$1/src/index.ts`** — `satisfies ExportedHandler<Env>`; model calls via
   `claudeFor("$1", env)`; emits Wire events with `env.WIRE.send({...})` using the canonical SPEC §6.4
   shape and a **structured** `idempotencyKey` (never `crypto.randomUUID()` for scheduled work).
3. **Tests — all three (Definition of Done):** (a) Wire-contract test for emitted events,
   (b) replay test through Steward (replay ⇒ `meta.changes === 0`), (c) failure-path test asserting
   the correct Flagger severity.

Honor the pillars: one writer per resource · suggest-don't-destroy · secrets only via bindings ·
never surface 2FA codes/reset links. If **$1** is outward-facing (Usher/Envoy) or deletes anything,
gate it with `step.waitForEvent('owner.confirm', {timeout})` (decline → `NonRetryableError`).

When done, run `/pillar-check apps/$1` to verify before committing.
