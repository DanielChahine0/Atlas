---
description: Generate or validate a canonical Atlas Wire event (the SPEC §6.4 contract) for a given agent + op, with a correctly-structured idempotencyKey. Use when wiring any agent → Steward → Vault write.
argument-hint: [agent] [increment|upsert|append] [entity]
allowed-tools: Read, Grep
model: inherit
---

Produce a valid Wire event for `agent=$1`, `op=$2`, `entity=$3`, following @CLAUDE.md.

Contract (copy exactly):
```json
{ "agent": "...", "type": "...", "entity": "...", "op": "increment | upsert | append", "payload": {}, "idempotencyKey": "..." }
```

Rules:
- `increment` → counters/metrics · `upsert` → stable-row views (kanban, CRM, prompt library) · `append` → feeds (Flagger feed, run-log, quick-capture).
- The `idempotencyKey` MUST be **stable and structured** (e.g. `forge:task:<date>:<contentHash>`,
  `compass:plan:<date>`, `filer:sweep:<date>`) — **never** `crypto.randomUUID()` for scheduled work,
  so a replay leaves counters unchanged (`meta.changes === 0`).
- `agent` is the codename (`"Forge"`, `"Filer"`, …).

Output: the event JSON, the exact `env.WIRE.send(...)` call, and a one-line rationale for the
`idempotencyKey` shape. If `$1` would write a resource another agent owns, STOP — that breaks
one-writer-per-resource (route Vault writes through Steward).
