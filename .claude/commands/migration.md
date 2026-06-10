---
description: Scaffold a numbered D1 migration against Atlas's canonical schema (idempotency ledger, counters, run_log, audit_log, vault_outbox) with the D1 rules baked in — positional ? params, absolute increment math, new_sqlite_classes for DOs. Use for any schema change; D1 is the system-of-record.
argument-hint: [migration name — e.g. "add_jobs_table"]
allowed-tools: Read, Grep, Glob, Write, Bash(npx wrangler d1:*)
model: inherit
---

Scaffold a D1 migration named **$ARGUMENTS** for `atlas-db`.

First read the canonical schema (`docs/13-build-plan.md §2 T1`, plus the existing migrations under
`migrations/` — `0001_init_core.sql` onward): `idempotency_keys`, `counters`, `run_log`, `audit`, `vault_outbox`.

Rules (D1 + Atlas pillars — see @CLAUDE.md):
- D1 supports **anonymous positional `?` params only** — no named params. Write SQL accordingly.
- Counter increments are **absolute math** (`value = value + ?`), guarded by the idempotency ledger so a
  replay is a no-op (`meta.changes === 0`). **D1 is the system-of-record; the Vault is a projection.**
- `audit_log` records `scope_used`, **never** the token/secret.
- For any new Durable Object, the migration tag uses **`new_sqlite_classes`** (not legacy `new_classes`);
  tags are unique/ordered/immutable once deployed (renames go in a new tag via `renamed_classes`).

Produce:
1. `migrations/NNNN_<name>.sql` — next number after the highest existing file; `CREATE TABLE IF NOT
   EXISTS`, plus an index for any dedupe key (e.g. `idx_tasks_dedupe`).
2. The exact commands:
   ```
   npx wrangler d1 migrations create atlas-db <name>
   npx wrangler d1 migrations apply atlas-db --local     # dev
   npx wrangler d1 migrations apply atlas-db --remote     # prod
   ```

Never hand-edit remote schema — always go through a migration.
