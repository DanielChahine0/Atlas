# Phase 0: Spine - Pattern Map

**Mapped:** 2026-06-04
**Files analyzed:** 30 (new files across T0–T15; one modified doc)
**Analogs found:** 0 in-repo code / 30 — **GREENFIELD**. There is no existing source to copy. The "analog" for every file is the **canonical specification** it must conform to: the exact `CLAUDE.md` convention strings, the `docs/13-build-plan.md §2` T0–T15 task code, and the agent contracts in `docs/agents/{atlas,steward}.md`. Each assignment below cites the spec excerpt the planner copies *into* the plan — not a prior file.

> **Why no analogs:** verified scan — `apps/`, `packages/`, `migrations/`, `daemon/` are absent; `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `wrangler.jsonc` do not exist. Only `.mcp.json`, `CLAUDE.md`, `docs/`, and a stray `node_modules/`+`package.json`+`package-lock.json` (slopcheck side-effect — **delete before T0**) exist at root. Phase 0 *establishes* every convention; it does not follow an in-repo one.
>
> **How the planner should read this:** each file maps to (a) the **convention authority** (exact CLAUDE.md strings it must replicate verbatim), and (b) the **spec excerpt** (build-plan/agent-spec code block the plan action references by file + line). "Match Quality" is `spec-exact` when the build plan ships ready-to-copy code, `convention-only` when only the canonical strings constrain it (Claude's-Discretion shape), and `first-of-kind` when no pattern exists and the file *is* the new convention.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog (canonical authority) | Match Quality |
|-------------------|------|-----------|--------------------------------------|---------------|
| `pnpm-workspace.yaml` | config | n/a | CLAUDE.md "Repo layout" + build-plan §2 layout (`["apps/*","packages/*"]`) | spec-exact |
| `package.json` (root) | config | n/a | build-plan §3 (root scripts build/test/lint/typecheck) + Standard Stack pins | convention-only |
| `tsconfig.base.json` | config | n/a | build-plan §3 (`strict:true`, `satisfies ExportedHandler`) | convention-only |
| `vitest.workspace.ts` | config | n/a | RESEARCH §Validation + build-plan §5.1 `defineWorkersConfig` | spec-exact |
| `apps/atlas/wrangler.jsonc` | config | n/a | build-plan §3 Atlas skeleton (lines 125-188) + T0/T4/T10 config blocks | spec-exact |
| `apps/atlas/src/index.ts` | controller | request-response + event-driven | build-plan T0 + T10 (OAuthProvider default export) + SPINE-01 scheduled() | spec-exact |
| `apps/atlas/src/coordinator.ts` | provider (DO) | event-driven | build-plan T4 `AtlasCoordinator` (lines 466-479) + atlas.md | spec-exact |
| `apps/atlas/src/auth/consent.ts` | controller | request-response | build-plan T10 `defaultHandler: consentHandler` | convention-only |
| `apps/atlas/src/oauth/google.ts` | service | request-response | build-plan T11 (authorize+refresh, lines 627-635) | spec-exact |
| `apps/atlas/src/oauth/github.ts` | service | request-response | build-plan T12 (`jose` RS256 → installation token) | convention-only |
| `apps/atlas/vitest.config.ts` | test config | n/a | build-plan §5.1 pool config (lines 1168-1182) | spec-exact |
| `apps/steward/wrangler.jsonc` | config | n/a | build-plan §3 Steward skeleton (lines 192-214) — **sole consumer block** | spec-exact (drop `retry_delay_secs`) |
| `apps/steward/src/steward.ts` | provider (DO) | event-driven | build-plan T5 `StewardWriter.apply` (lines 492-515) + steward.md §How-it-works | spec-exact |
| `apps/steward/src/steward-consumer.ts` | controller (queue) | event-driven | build-plan T6 `queue()` (lines 532-547) — **THE single consumer** | spec-exact |
| `apps/steward/src/dlq-consumer.ts` | controller (queue) | event-driven | build-plan T7 + Failure-mode table | convention-only |
| `apps/steward/src/bridge/poll.ts` | controller | request-response (long-poll) | build-plan T15 (`/bridge/poll`, token-gated) | first-of-kind |
| `apps/steward/src/bridge/ack.ts` | controller | request-response | build-plan T15 (`/bridge/ack`) | first-of-kind |
| `apps/steward/{replay,serialize,malformed,dlq}.test.ts` | test | event-driven | build-plan §5.1 replay test (lines 1219-1228) + Test Map | spec-exact |
| `apps/mcp-google/wrangler.jsonc` | config | n/a | build-plan §3 + T13 (`gmail.modify` floor) | convention-only |
| `apps/mcp-google/src/mcp/google.ts` | service (MCP) | request-response | build-plan T13 + CLAUDE.md security invariant (2FA/reset strip) | convention-only |
| `apps/mcp-github/wrangler.jsonc` | config | n/a | build-plan §2 layout (stateful McpAgent + OAuthProvider) | convention-only |
| `apps/mcp-obsidian-bridge/*` | service (MCP) | request-response | build-plan T15 op→REST mapping (lines 675-682) | spec-exact (mapping table) |
| `migrations/0001_init_core.sql` | migration | n/a | build-plan T1 (lines 385-411) + §5.2 reconciled schema (lines 1242-1256) | spec-exact (reconcile, see note) |
| `packages/wire/contract.ts` | utility (schema) | transform | build-plan §5.1 `WireEvent` zod (lines 1198-1206) + SPEC §6.4 | spec-exact |
| `packages/wire/src/send.ts` | utility | event-driven | CLAUDE.md §6.4 contract + T3 producer binding | convention-only |
| `packages/model/src/claude.ts` | service | request-response | build-plan T14 `claudeFor`/`modelFor` + CLAUDE.md model tiering | convention-only |
| `packages/steward-core/*` | utility | transform | build-plan T5 critical-section + T15 op→REST mapping | spec-exact |
| `packages/codex/src/codex.ts` | service | file-I/O (read) | build-plan T8 + docs/07 §11 sections | convention-only |
| `packages/security/redact.ts` | utility | transform | RESEARCH §Validation CI invariant #2 (SECRET_PATTERNS) | first-of-kind |
| `packages/shared/*` (Env, flag emit, run-log) | utility | n/a | CLAUDE.md bindings table + build-plan §5.2 observability | convention-only |
| `docs/03-scheduling.md` (**MODIFIED**) | doc | n/a | build-plan §"Timezone decision" (D-06/D-07) — add EST/EDT table | convention-only |

---

## Pattern Assignments

> All line numbers below refer to files **already in this repo** (`docs/`, `CLAUDE.md`). The planner pastes these exact strings/excerpts into the relevant plan's action section.

### `apps/atlas/wrangler.jsonc` (config) — Atlas Worker, the most-bound Worker

**Canonical authority:** `CLAUDE.md` binding table + `docs/13-build-plan.md` lines 125-188 (full skeleton, copy verbatim).

**Exact strings to replicate (non-negotiable):**
- `"$schema": "./node_modules/wrangler/config-schema.json"`, `"name": "atlas"`, `"main": "src/index.ts"`
- `"compatibility_date": "2026-04-25"` (D-09; build-plan T0 shows `2026-04-07` floor — **use 2026-04-25 per CONTEXT D-09**), `"compatibility_flags": ["nodejs_compat"]` (REQUIRED by `agents` SDK — omitting = runtime failure)
- DO bindings: `{ "name": "ATLAS", "class_name": "AtlasCoordinator" }` and `{ "name": "MORNING_CHAIN_DO", "class_name": "AtlasCoordinator" }`
- Migration: `{ "tag": "v1", "new_sqlite_classes": ["AtlasCoordinator"] }` — **`new_sqlite_classes`, NOT `new_classes`**
- `"queues": { "producers": [ { "binding": "WIRE", "queue": "atlas-wire" } ] }` — Atlas is a **producer**, never a consumer
- `"d1_databases": [{ "binding": "DB", "database_name": "atlas-db", "migrations_dir": "migrations" }]`
- `"kv_namespaces": [{ "binding": "CONFIG", ... }, { "binding": "OAUTH_KV", ... }]`
- `"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "atlas-blobs" }]`
- `"ai": { "binding": "AI" }`
- `[vars]` holds plaintext only: `AIG_ACCOUNT_ID`, `AIG_GATEWAY_ID`, `MODEL_*` — **never secrets, never counters**
- `secrets_store_secrets` bindings: `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GH_APP_PRIVATE_KEY` (build-plan lines 276-282)
- **Staging override:** `env.staging.triggers.crons = []` (CLAUDE.md — staging fires NO crons)

**Note:** Atlas's `triggers.crons` are declared here (build-plan lines 136-145) but **first fire in Phase 1**. Phase 0 only needs the dispatcher `switch` to exist; cron *lines* are a Phase-1 concern (do NOT register the 5 morning stages as 5 crons — one cron kicks the Workflow).

---

### `apps/atlas/src/index.ts` (controller, request-response + event-driven) — dispatcher + OAuth front door

**Canonical authority:** build-plan T0 (scaffold) + T10 (OAuthProvider as default export) + RESEARCH Code Example "Cron dispatch" (lines 380-394) + SPINE-01.

**`scheduled()` dispatcher pattern** — RESEARCH lines 380-394 (copy):
```typescript
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    switch (controller.cron) {
      case "45 12 * * *": {  // EST form; re-derive "45 11 * * *" in EDT (D-06)
        await env.WIRE.send({
          agent: "Atlas", type: "noop.tick", entity: "spine", op: "append",
          payload: { note: "phase-0 smoke" },
          idempotencyKey: `atlas:noop:${localDate(env)}`,
        });
        break;
      }
    }
  },
} satisfies ExportedHandler<Env>;   // satisfies, NOT `: ExportedHandler<Env>`
```
**OAuth front door** — build-plan lines 602-615 / RESEARCH lines 419-432 (the default export is the `OAuthProvider`; the `scheduled()` handler attaches via the provider's handler composition — confirm exact wiring with `cloudflare-researcher` for `agents@0.14.1`, Open Question 1). Required: `apiRoute`, `apiHandler`, `defaultHandler`, `scopesSupported` allow-list (the 9 scopes, lines 609-613), `accessTokenTTL: 3600`. **Startup FAILS without a real `OAUTH_KV` KV namespace.**

**Idempotency-key rule:** structured + date-derived. `localDate(env)` MUST use `Intl` with `America/Toronto` (CLAUDE.md gotcha — `TZ=UTC` everywhere; `new Date()` is UTC): `new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto'}).format(new Date())`.

---

### `apps/atlas/src/coordinator.ts` (provider/DO, event-driven) — AtlasCoordinator + heartbeat

**Canonical authority:** build-plan T4 lines 466-479 (copy verbatim) + `docs/agents/atlas.md` (Atlas does no domain work — schedules/routes/supervises only) + D-10 (5-min staleness → P1).

**Core DO pattern** — build-plan lines 466-479:
```typescript
export class AtlasCoordinator extends DurableObject<Env> {
  async beat() { await this.ctx.storage.put("lastBeat", Date.now()); }
  async startHeartbeat() {
    if ((await this.ctx.storage.getAlarm()) == null)
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
  async alarm() {
    const last = (await this.ctx.storage.get<number>("lastBeat")) ?? 0;
    if (Date.now() - last > 5 * 60_000) {            // D-10: 5-min staleness → P1
      // emit P1 Critical to Flagger via the Wire (heartbeat stale)
    }
    await this.ctx.storage.setAlarm(Date.now() + 60_000);  // reschedule INSIDE alarm()
  }
}
```
**Address only as** `env.ATLAS.getByName("root")` (CLAUDE.md — one name = one instance). **Confirm `DurableObject<Env>` import/base-class surface for `agents@0.14.1` via `cloudflare-researcher`** before implementing (RESEARCH Open Question 1 — version confirmed, exact class API not pulled).

---

### `apps/steward/wrangler.jsonc` (config) — THE only Worker with a consumer block

**Canonical authority:** build-plan lines 192-214 (Steward skeleton) + CLAUDE.md Pillar 1 (a second `atlas-wire` consumer is a hard CI failure).

**Exact strings:**
- DO binding: `{ "name": "STEWARD_LOCK", "class_name": "StewardWriter" }` → addressed `env.STEWARD_LOCK.getByName("vault")`
- Migration: `{ "tag": "v1", "new_sqlite_classes": ["StewardWriter"] }`
- **The consumer block (lines 202-212)** — copy, but **DROP `retry_delay_secs`** (RESEARCH Pitfall 6 / Open Question 2: NOT a valid consumer-level key). Valid keys only: `queue`, `max_batch_size`, `max_batch_timeout`, `max_retries`, `dead_letter_queue`, `max_concurrency`:
```jsonc
"queues": { "consumers": [ {
  "queue": "atlas-wire",
  "max_concurrency": 1,                 // PIN to one → serialized writes (Pillar 1)
  "max_batch_size": 10,
  "max_batch_timeout": 10,
  "max_retries": 5,
  "dead_letter_queue": "atlas-wire-dlq" // REQUIRED — else exhausted msgs drop silently
} ] }
```
Retry delay is set **per-message** in the `queue()` handler (`msg.retry({ delaySeconds: 60 })`), not here.

---

### `apps/steward/src/steward.ts` (provider/DO, event-driven) — THE CRUX

**Canonical authority:** build-plan T5 lines 492-515 (copy verbatim) + `docs/agents/steward.md` (8-step per-event flow, lines 97-111) + CLAUDE.md "Steward critical section" gotcha.

**The atomic critical section** — build-plan lines 492-515 (this is SPINE-02, the single most important file in the phase):
```typescript
export class StewardWriter extends DurableObject<Env> {
  async apply(e: WireEvent): Promise<{ applied: boolean }> {
    return this.ctx.blockConcurrencyWhile(async () => {     // serialize this DO
      const ins = await this.env.DB.batch([                  // batch() = ONE atomic txn
        this.env.DB.prepare(
          "INSERT OR IGNORE INTO idempotency_keys(key,agent,type,op,entity,applied_at) VALUES (?,?,?,?,?,?)"
        ).bind(e.idempotencyKey, e.agent, e.type, e.op, e.entity, Date.now()),
        this.env.DB.prepare(                                  // increment math is ABSOLUTE
          `INSERT INTO counters(entity,value) VALUES(?, ?)
           ON CONFLICT(entity) DO UPDATE SET value = value + ?
           WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ?)`
        ).bind(e.payload.counter ?? e.entity, e.payload.delta ?? 1, e.payload.delta ?? 1, e.idempotencyKey),
      ]);
      if (ins[0].meta.changes === 0) return { applied: false }; // REPLAY → no double-count
      // upsert/append branches enqueue a vault_outbox intent HERE (still in lock)
      await this.env.DB.prepare(
        "INSERT INTO run_log(agent,type,entity,op,result,ts) VALUES(?,?,?,?, 'ok', ?)"
      ).bind(e.agent, e.type, e.entity, e.op, Date.now()).run();
      return { applied: true };
    });
    // The slow Obsidian write happens OUTSIDE blockConcurrencyWhile (drained from vault_outbox).
  }
}
```
**Hard rules (CLAUDE.md + RESEARCH Pitfalls 3/4):**
- dedup-check + counter-bump + ledger-insert = **ONE `DB.batch()`** inside `blockConcurrencyWhile`. A crash between them double-counts.
- **D1 positional `?` params ONLY** — no named (`?1`/`:name`). (Build-plan §5.3 had a `?1` variant; T5 positional version is correct.)
- **Increment math is ABSOLUTE in D1** — the Vault PATCH later writes the absolute value (frontmatter has no atomic +1).
- The **slow Obsidian write is OUTSIDE the lock** — enqueue a `vault_outbox` intent inside the lock; the daemon drains it. An unreachable bridge must never stall the Wire.
- The three ops: `increment` (counters), `upsert` (views/CRM — last-writer-wins, naturally idempotent), `append` (feeds/logs — dedup by key). See steward.md lines 72-78.

---

### `apps/steward/src/steward-consumer.ts` (controller/queue, event-driven) — the single Wire consumer

**Canonical authority:** build-plan T6 lines 532-547 (copy verbatim) + RESEARCH Pattern 2 (lines 262-277) + steward.md validation step.

**The consumer pattern** — build-plan lines 532-547:
```typescript
export default {
  async queue(batch: MessageBatch<WireEvent>, env: Env): Promise<void> {
    const steward = env.STEWARD_LOCK.getByName("vault");   // single global writer
    for (const msg of batch.messages) {                    // SERIAL, never Promise.all
      const e = msg.body;
      if (!e?.agent || !e?.op || !e?.entity || !e?.idempotencyKey) {
        await flag(env, "P3", "malformed wire event", e); msg.ack(); continue;  // ack, don't poison-loop
      }
      try { await steward.apply(e); msg.ack(); }           // replay & success both = ack
      catch (err) {
        if (msg.attempts >= 4) await flag(env, "P2", "steward write failing", { e, err });
        msg.retry({ delaySeconds: 60 });                   // redelivery is safe (ledger dedup)
      }
    }
  },
} satisfies ExportedHandler<Env>;
```
**Anti-patterns to refuse (RESEARCH lines 288-297):** `Promise.all` over a batch (breaks serialization — use `for…of`); a second `atlas-wire` consumer (hard CI failure); malformed → `ack()` + P3 (NOT retry — avoids poison-loop). Wire message cap = **128 KB**.

---

### `migrations/0001_init_core.sql` (migration) — D1 system-of-record

**Canonical authority:** build-plan T1 lines 385-411 **reconciled with** §5.2 observability schema lines 1242-1256 (RESEARCH §Code Examples note + Assumption A4: use the **richer** schema with `duration_ms`, `rows_read`, `rows_written`).

**Reconciled schema (planner picks one superset):** five tables — `idempotency_keys` (PK `key`), `counters` (PK `entity`, `value INTEGER DEFAULT 0`), `run_log` (with `rows_read`/`rows_written`/`duration_ms`/`result`), `audit_log` (ULID PK; `scope_used` — **never the token**; `gated`/`decision`/`outcome`/`trust`/`consent_flag`/`flag_id`), `vault_outbox` (PK `idem`; `path`/`method`/`headers`/`body`/`state DEFAULT 'pending'`/`ts`). Concrete columns in RESEARCH lines 438-453 + build-plan lines 1242-1256.

**Hard rules:** positional `?` binding only (no named params); `idempotency_keys` retained **forever** (D-08 — no TTL). KV is **never** used for counters or idempotency (CLAUDE.md gotcha). The schema lands in Phase 0 even though Flagger (its reader) is Phase 2 — otherwise Phases 0–1 run blind (build-plan §5.2 lines 1237).

---

### `packages/wire/contract.ts` (utility/schema, transform) — the single Wire-shape definition

**Canonical authority:** build-plan §5.1 lines 1198-1206 (copy verbatim) + SPEC §6.4 + CLAUDE.md Wire contract.

**The zod schema (single source of truth, imported by EVERY producer + Steward):**
```typescript
import { z } from "zod";
export const WireEvent = z.object({
  agent: z.string(),
  type: z.string(),
  entity: z.string(),
  op: z.enum(["increment", "upsert", "append"]),
  payload: z.record(z.unknown()),
  idempotencyKey: z.string().min(1),
});
export type WireEvent = z.infer<typeof WireEvent>;
```
**Field semantics (steward.md lines 63-70):** `agent` = roster codename (`"Forge"`, `"Filer"`, `"Atlas"`); `op` = `increment`(counters) | `upsert`(stable rows) | `append`(feeds); `idempotencyKey` mandatory + structured (`forge:task:<date>:<hash>`, `usher:evt:<slug>:registered`, `flagger:<id>`). The CI "single definition" gate (build-plan acceptance #6) greps that `packages/wire` is the only definition imported everywhere.

---

### `packages/security/redact.ts` (utility, transform) — FIRST-OF-KIND (no analog)

**Canonical authority:** RESEARCH §Validation CI invariant #2 (lines 574) + CLAUDE.md security hard invariant ("NEVER surface 2FA codes / reset links / login URLs … A prompt instruction alone is NOT sufficient").

**No pattern exists — this file establishes the convention.** It lands now (Phase 0) as a shared primitive so Herald inherits it in Phase 1 (the digest builder doesn't exist yet). Required: the `SECRET_PATTERNS` array `[/\b\d{6}\b/, /reset[-_ ]?(password|link)/i, /verification code/i, /https?:\/\/\S*\/(reset|verify|confirm)\S*/i]` and a unit test feeding known 2FA/reset fixtures asserting none survive. A caught exposure attempt = **P1 (block + flag)**. Belt-and-suspenders with the Google MCP server-side strip (T13).

---

### `apps/steward/src/bridge/{poll,ack}.ts` (controller, request-response) — FIRST-OF-KIND

**Canonical authority:** build-plan T15 lines 668-684 + RESEARCH op→REST mapping (lines 457-463).

**No in-repo analog (no other long-poll endpoint exists).** Cloud Worker endpoints gated by `ATLAS_BRIDGE_TOKEN`; the **outbound-only** macOS daemon long-polls `/bridge/poll`, drains `vault_outbox` intents, PATCHes Obsidian Local REST API v3 at `https://127.0.0.1:27124`, then acks `/bridge/ack`. **Zero inbound port on the laptop** (verified by `lsof -i -nP | grep LISTEN`). The op→REST mapping table (build-plan lines 675-682) is the contract:
- `increment` → `PATCH /vault/Counters/metrics.md` (`Operation: replace` · `Target-Type: frontmatter` · writes the **absolute** value)
- `upsert` → `PATCH /vault/<note>.md` (`Create-Target-If-Missing: true`)
- `upsert(view)` → `PUT /vault/Dashboard/Today.md` (`Target-Type: heading`)
- `append` → `POST /vault/Dashboard/Heartbeat.md` (`Target-Type: heading`)

**Steward NEVER calls `DELETE /vault/...`** (Pillar 2). The daemon trusts the self-signed cert ONLY for `127.0.0.1`, never on the outbound cloud connection. Adopt v3 PATCH API (v2 sunset at plugin 4.0).

---

### Test files: `apps/steward/{replay,serialize,malformed,dlq}.test.ts` (test, event-driven)

**Canonical authority:** build-plan §5.1 replay test (lines 1219-1228, copy verbatim) + Test Map (RESEARCH lines 553-561) + CLAUDE.md Definition of Done.

**The replay test (proves Pillar 5 — copy):**
```typescript
it("replaying a Wire event does not double-count", async () => {
  const steward = env.STEWARD_LOCK.getByName("vault");
  const evt = { agent: "Forge", type: "task.created", entity: "tasks", op: "increment",
                payload: { counter: "tasks_open", delta: 1 }, idempotencyKey: "forge:task:2026-05-31:abc" };
  expect(await steward.apply(evt)).toEqual({ applied: true });
  expect(await steward.apply(evt)).toEqual({ applied: false }); // replay → skipped
  const { value } = await steward.counter("tasks_open");
  expect(value).toBe(1);   // not 2
});
```
Use `import { env, createMessageBatch } from "cloudflare:test"`; `isolatedStorage: true` resets SQLite per test. The four required test behaviors: replay (`meta.changes===0`), serialize (50 concurrent `apply()` → no race; two `getByName("vault")` → one DO), malformed (`ack`+P3, no write), DLQ (exhausted retry → `atlas-wire-dlq` + P2 + audit row).

---

### `apps/atlas/src/oauth/google.ts` (service, request-response)

**Canonical authority:** build-plan T11 lines 627-635 + CLAUDE.md Google OAuth gotcha + RESEARCH Pitfall 7.

**Load-bearing flags (copy):** authorize URL MUST include `access_type=offline` AND `prompt=consent` AND S256 PKCE (`code_challenge_method: 'S256'`) or **no refresh token is returned**. Refresh responses **never** return a new refresh token — keep the original. Scope string uses full Google URIs (`https://www.googleapis.com/auth/gmail.modify` …). Refresh token → Secrets Store `google-refresh-token` (async `await env.GOOGLE_REFRESH_TOKEN.get()`; `--remote` not readable in `wrangler dev` — make non-remote dev copies).

---

## Shared Patterns

### The §6.4 Wire event contract (cross-cutting — every producer + Steward)
**Source:** `CLAUDE.md` Wire contract + `docs/agents/steward.md` lines 52-60 + `packages/wire/contract.ts` (above).
**Apply to:** every file that emits or consumes a Wire event (`atlas/src/index.ts`, `steward/src/*`, every Phase-1+ agent).
```json
{ "agent": "...", "type": "...", "entity": "...",
  "op": "increment | upsert | append", "payload": { }, "idempotencyKey": "..." }
```
Copy verbatim. `increment`→counters, `upsert`→stable rows, `append`→feeds. Steward dedups in the D1 ledger; replay is a no-op.

### Canonical binding names (cross-cutting — every `wrangler.jsonc`)
**Source:** `CLAUDE.md` "Canonical conventions" table + build-plan §4 lines 247-255.
**Apply to:** every Worker config.
`WIRE` (Queue producer; every agent except Steward) · `DB` (D1 `atlas-db` — all counters + idempotency keys) · `CONFIG` (KV — config/flags only, never secrets/counters) · `OAUTH_KV` (KV — real namespace required) · `BLOBS` (R2 `atlas-blobs`) · `AI` (Workers AI gateway) · `STEWARD_LOCK` (DO, `getByName("vault")`) · `ATLAS`/`MORNING_CHAIN_DO` (DO, `getByName("root")`) · `MORNING_CHAIN` (Workflow, Phase 1). DO classes are PascalCase: `AtlasCoordinator`, `StewardWriter`.

### Structured idempotency keys (cross-cutting)
**Source:** `CLAUDE.md` idempotency-key formats + RESEARCH §3 (lines 1281-1284).
**Apply to:** every emitted event + Workflow instance id.
Stable + structured, **never `crypto.randomUUID()` for scheduled work**: `filer:sweep:<date>`, `herald:daily:<date>`, `forge:task:<date>:<contentHash>`, `sundial-<date>`, `compass:plan:<date>`, `atlas:noop:<date>`, `morning-${date}` (Workflow id = the idempotency handle; re-creating an existing id throws). Dates derived via `Intl`/`America/Toronto` (TZ=UTC everywhere).

### Secrets handling (cross-cutting — security invariant)
**Source:** `CLAUDE.md` security invariants + build-plan §4 lines 257-282.
**Apply to:** every Worker touching credentials.
Secrets ONLY via bindings (Secrets Store `GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`/`GH_APP_PRIVATE_KEY`; `wrangler secret put` for `ANTHROPIC_API_KEY`/`CF_AIG_TOKEN`/`ATLAS_BRIDGE_TOKEN`). **Never** in `[vars]`, KV, the Vault, the Codex, `audit_log`, logs, or any tracked file. Reads are async (`await env.X.get()`). One Secrets Store per account (open beta). `audit_log` records `scope_used`, never the token.

### `satisfies ExportedHandler<Env>` (cross-cutting — TS convention)
**Source:** `CLAUDE.md` Tech-stack + build-plan §3 line 101.
**Apply to:** every Worker default export. Use `satisfies ExportedHandler<Env>`, NOT the older `: ExportedHandler<Env>` annotation. `strict: true`.

### CI invariants (structural gates — wire into the Steward/consumer plans)
**Source:** RESEARCH §Validation lines 568-574 + CLAUDE.md Definition of Done.
1. **Exactly one `atlas-wire` consumer** — grep gate (RESEARCH lines 570-573); a second consumer fails the build (Pillar 1).
2. **2FA/reset-link redaction backstop** — `packages/security/redact.ts` test (above).
Plus the **three mandatory tests per agent PR**: Wire-contract test, replay test (`meta.changes===0`), failure-path→Flagger-severity test.

---

## No Analog Found

This entire phase has **no in-repo code analog** (greenfield — verified). The table below isolates the files that are genuinely **first-of-kind** — no pattern exists anywhere (not even a strong spec code block); the planner notes that Phase 0 is *establishing* the convention, not following one. (Files that conform to a ready-to-copy build-plan/agent-spec code block are `spec-exact`/`convention-only` above and are NOT repeated here.)

| File | Role | Data Flow | Reason — establishing, not following |
|------|------|-----------|--------------------------------------|
| `packages/security/redact.ts` | utility | transform | First redaction primitive in the repo. Spec gives only the `SECRET_PATTERNS` regex array + the "P1 on catch" rule; the implementation shape is new. Herald inherits it Phase 1. |
| `apps/steward/src/bridge/poll.ts` | controller | request-response (long-poll) | First (and only) long-poll endpoint; the outbound-only-daemon ↔ cloud handshake is novel to Atlas. Spec gives the token gate + op→REST table, not endpoint code. |
| `apps/steward/src/bridge/ack.ts` | controller | request-response | Pairs with `poll.ts`; same novelty. |
| `daemon/` outbound-drain plumbing | utility (local) | event-driven | First local (non-Worker) process. Phase 0 stands up only its outbound-auth + outbox-drain skeleton (Echo/Quill are Phase 3). No Worker analog applies — it is intentionally outside `apps/`. |
| `apps/atlas/src/auth/consent.ts` | controller | request-response | First consent UI handler; build-plan names it (`defaultHandler: consentHandler`) but ships no body. Confirm `OAuthProvider` handler shape for `agents@0.14.1` via `cloudflare-researcher`. |
| `packages/codex/src/codex.ts` | service | file-I/O (read) | First Drive reader; spec gives the caching rule (`cache_control:{type:"ephemeral",ttl:"1h"}`) + §11 sections, not reader code. Read-only; no write path. |

---

## Planner Notes (carry into PLAN.md files)

1. **Pre-T0 cleanup:** delete the slopcheck side-effect (`rm -rf node_modules package.json package-lock.json` at repo root) before scaffolding the real pnpm monorepo (RESEARCH §Runtime State Inventory).
2. **Confirmed API drift — resolve in the plan:** drop `retry_delay_secs` from the Steward consumer config block AND the `wrangler queues consumer add` command (build-plan lines 209, 529 are stale). Set delay per-message: `msg.retry({ delaySeconds: 60 })`. (RESEARCH Pitfall 6 / Open Q 2.)
3. **`run_log` schema reconciliation:** the build plan shows two `run_log` shapes (T1 lines 395-400 vs §5.2 lines 1243-1247). Use the richer §5.2 superset (`duration_ms`+`rows_read`+`rows_written`) so Flagger reads it in Phase 2. (RESEARCH A4 / Open Q 3.)
4. **`agents@0.14.1` class API (LOW-MEDIUM confidence):** the exact `DurableObject<Env>` / `OAuthProvider` / `WorkflowEntrypoint` import + method surface was NOT pulled this session (MCP tools unavailable to the researcher). Before implementing T4/T5/T10, invoke the project `cloudflare-researcher` subagent or `/cf-docs durable objects` + `/cf-docs workflows`. Do NOT block planning — the build-plan snippets are the working hypothesis. (RESEARCH Open Q 1.)
5. **`compatibility_date` discrepancy:** build-plan T0 shows `2026-04-07` (floor); CONTEXT D-09 locks `2026-04-25`. Use **`2026-04-25`** in every `wrangler.jsonc`.
6. **`docs/03-scheduling.md` is the one modified file** — add the EST/EDT UTC translation table (D-07; build-plan §"Timezone decision"). This is a Phase-0 "setup-done" acceptance criterion. (Note: GSD owns `.planning/` state — this is a `docs/` edit, allowed.)

## Metadata

**Analog search scope:** repo root, `apps/`, `packages/`, `migrations/`, `daemon/` (all confirmed absent except a stray slopcheck `node_modules/`); `docs/` and `CLAUDE.md` read as the convention authority.
**Files scanned:** `docs/13-build-plan.md` (T0–T15 §2, layout §2-§4, cross-cutting §5.1-§5.3), `docs/agents/atlas.md`, `docs/agents/steward.md`, `CLAUDE.md`, both phase-0 CONTEXT.md + RESEARCH.md.
**Pattern extraction date:** 2026-06-04
