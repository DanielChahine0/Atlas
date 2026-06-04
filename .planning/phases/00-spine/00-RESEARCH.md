# Phase 0: Spine - Research

**Researched:** 2026-06-04
**Domain:** Cloudflare Workers infrastructure (Durable Objects, Queues, Workflows, D1/KV/R2, OAuth) — the substrate for a 16-agent orchestrator
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Hosting / Cloudflare plan**
- **D-01:** Build & deploy Phase 0 on the Workers FREE plan. Queues (GA-on-Free 2026-02-04: 10k queues, 10k ops/day, 24h retention), Workflows (100 concurrent, 1,024 steps/instance, 3-day state retention), and SQLite-backed DOs all run on Free. Workers Paid ($5/mo) is an optional headroom upgrade, NOT a hard gate — adopt later only if a real ceiling is hit (notably a confirm-gate waiting >3 days, a Phase-4 concern).
- **D-02:** Reconcile the stale "Paid hard prerequisite" still asserted in `.planning/PROJECT.md` (lines ~43, ~58) and `.planning/intel/*` — Free is sufficient. (Canonical `docs/`, `CLAUDE.md`, `/prereqs` already corrected 2026-06-04.)
- **D-03:** The dominant recurring cost is the Claude/Anthropic API bill (via AI Gateway, no markup), independent of the Cloudflare plan. Budget for it, not for hosting.

**Monorepo & Worker granularity**
- **D-04:** Package manager = pnpm (corepack workspaces). Root `pnpm-workspace.yaml` → `["apps/*", "packages/*"]`.
- **D-05:** One Worker per agent (`apps/<codename>`). Steward (sole Wire consumer) and Filer (`gmail.modify` boundary) must always stay isolated.

**Scheduling & DST (project decision D1)**
- **D-06:** UTC crons + twice-yearly hand-edit at the EST↔EDT boundary (`45 12 * * *` EST / `45 11 * * *` EDT). In-Workflow waits use `step.sleepUntil` with a tz-correct `Intl` zone (`America/Toronto`), DST-safe.
- **D-07:** Writing the EST/EDT translation table into `docs/03-scheduling.md` is a Phase-0 "setup-done" criterion (build-plan §1 acceptance #4). Crons first fire in Phase 1, but the policy is locked now.

**Steward & infra knobs**
- **D-08:** Idempotency-ledger retention = keep keys forever. A replay at any age is a guaranteed no-op (`meta.changes === 0`). No TTL window to get wrong.
- **D-09:** `compatibility_date = 2026-04-25` (≥ 2026-04-07 enables `web_socket_auto_reply_to_close`, needed by Echo later). Pair with `compatibility_flags: ["nodejs_compat"]` (required by the Agents SDK).
- **D-10:** Atlas heartbeat staleness threshold = 5 min → Atlas self-flags P1 if no heartbeat within the window.
- **D-11:** invokeAgent transport = service-binding RPC (Worker-to-Worker; lowest latency, type-safe, no public HTTP surface). Relevant to SPINE-01.

### Claude's Discretion
D1 table schema specifics (column types, indexes), exact OAuth scope strings per agent, Codex section file layout, Secrets Store key naming, and the precise `wrangler.jsonc` shapes are left to research/planning — technical implementation details, constrained by the canonical refs and the `CLAUDE.md` pins.

### Deferred Ideas (OUT OF SCOPE)
- AI Gateway $/rate ceilings (Phase 1).
- Herald output surface — Gmail draft vs Vault-glance-only (Phase 1).
- Compass Opus `effort` level (Phase 1).
- The two manual measurement commitments — pre-launch baseline + ~1-min daily review (Phase 1).
- Morning-chain success-rate window (Phase 1).
- Workflow-state retention ceiling (>3 days) — Phase 4 (Usher/Envoy gates); trigger to adopt Workers Paid.

**None of the above are Phase-0 blockers.**
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **SPINE-01** | Atlas can schedule a no-op agent and route a message onto the Wire (Cloudflare Queue event bus). | `scheduled()` dispatcher routes a cron string → invokes a no-op agent via service-binding RPC (D-11) → `env.WIRE.send(canonicalEvent)`. `AtlasCoordinator` DO (`getByName("root")`) + 5-min `alarm()` heartbeat (build-plan T4). Verified: Queue producer `send()` API + cron `scheduled()` handler. |
| **SPINE-02** | Steward consumes one Wire event and applies it per the §6.4 contract, serialized single-consumer; `increment` idempotent on replay (same key twice → `meta.changes === 0`). | `StewardWriter` DO (`getByName("vault")`) + `max_concurrency=1` consumer; atomic critical section = `INSERT OR IGNORE` ledger + conditional counter bump in one `DB.batch()` inside `blockConcurrencyWhile`; slow Obsidian write OUTSIDE the lock (build-plan T5/T6, §5.3). Verified: D1 `batch()` atomicity, `meta.changes`, DO `blockConcurrencyWhile`. |
| **SPINE-03** | The Codex exists with the §11 sections, read-only to agents except the explicit "update my profile" flow. | `codex.md` in Google Drive; read via `drive.readonly`; cached as a `system` `TextBlockParam` with `cache_control:{type:"ephemeral",ttl:"1h"}`; no agent write path (build-plan T8). Contains zero credentials. |
| **SPINE-04** | Google (least-privilege) + GitHub (GitHub App) OAuth round-trips succeed; tokens in Secrets Store, never Vault/Codex. | Inbound: Workers OAuth Provider (`OAUTH_KV` required) (T10). Outbound Google: `access_type=offline&prompt=consent`+S256 PKCE → refresh token to Secrets Store (T11). GitHub: App RS256 JWT → installation token (T12). Scope enforcement server-side, two places (T13). Verified: OAuthProvider 0.7.2 API. |
| **SPINE-05** | DLQ (`atlas-wire-dlq`) exists; exhausted-retry message lands there + audit row + P2/P3 incident, never silent loss. Obsidian bridge writes outbound-only Steward→Vault. | DLQ consumer → Flagger sink (T7); `vault_outbox` D1 table drained by outbound-only macOS daemon long-polling `/bridge/poll` → Obsidian Local REST API v3 PATCH (T15). Verified: Queue DLQ config, message size cap, Obsidian v3 PATCH API. |
</phase_requirements>

## Summary

Phase 0 is **pure infrastructure** — it ships zero user-visible features and that is correct, not a gap. It scaffolds a greenfield pnpm monorepo (no `package.json`, `apps/`, `packages/`, or `migrations/` exist yet) and stands up seven substrate deliverables: Atlas (orchestrator DO), the Wire (Queue + DLQ), Steward (sole serialized Vault writer + the single Wire consumer), D1 (system-of-record), the Codex (read-only facts), Google + GitHub OAuth, and the outbound-only Obsidian bridge. Every later agent inherits these mechanisms; nothing here is retrofitted.

The crux is **Steward's atomic single-writer + idempotency, correct from day 0**. Cloudflare Queues are at-least-once with best-effort (non-FIFO) ordering — replays *will* happen (partial-batch failure, missed-cron catch-up, network blip after server-side success). The compensating design is mandatory: the dedup-check + counter-bump + ledger-insert must be ONE atomic D1 `batch()` transaction inside `blockConcurrencyWhile`, and the slow Obsidian write must happen *outside* the lock. Retrofitting idempotency after counters exist means reconciling double-counts. The replay test (`apply` the same `idempotencyKey` twice → counter unchanged, `meta.changes === 0`) is the single test that proves Pillar 5 end-to-end.

The design is exceptionally well-specified already: `docs/13-build-plan.md §2` gives a task-level breakdown (T0–T15) with per-task acceptance, exact `wrangler.jsonc` shapes, the D1 schema, and the Steward critical-section code. **All SDK pins in `CLAUDE.md` were re-verified against the npm registry today (2026-06-04) and are current** — the build plan's last verification date matches today, so there is no drift in versions. One genuine API drift was found: the build plan's Queue *consumer* config block lists `retry_delay_secs`, which is **not a valid consumer-level key** (Cloudflare docs confirm retry delay is per-message `msg.retry({delaySeconds})` or queue-level `--delivery-delay-secs`). Flag for the planner.

**Primary recommendation:** Follow `docs/13-build-plan.md §1–§2` task ordering T0→T15 verbatim; treat the pins as current (re-verified today); the planner's main job is sequencing T0–T15 into waves and attaching the three mandatory tests (Wire-contract, replay, failure-path) plus the two CI invariants (one `atlas-wire` consumer; 2FA/reset-link redaction) to the Steward/consumer tasks. Drop `retry_delay_secs` from the consumer config block.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Cron scheduling + dispatch | Atlas Worker `scheduled()` | `AtlasCoordinator` DO | Single place all crons register (atlas.md); DO holds coordination state + heartbeat. |
| Event routing (the Wire) | Cloudflare Queue `atlas-wire` | Atlas (producer of control msgs) | Queue is the bus; every agent except Steward is a producer. |
| Serialized Vault writes | `StewardWriter` DO (`getByName("vault")`) | Steward Worker `queue()` consumer | One named DO = one lock = Pillar 1. `max_concurrency=1` + DO lock = double-belt serialization. |
| Counters + idempotency ledger | D1 `atlas-db` | Steward DO SQLite (same guarantee) | KV is wrong (1 write/s/key, ≤60s lag). D1 is authoritative system-of-record (Pillar 4). |
| Idempotency dedup | D1 `idempotency_keys` table | — | `INSERT OR IGNORE` + `meta.changes===0` = replay detection, atomic with the bump. |
| Source-of-truth facts (Codex) | Google Drive (`drive.readonly`) | CONFIG KV (file id) + Anthropic prompt cache | Read-only to agents; cached `system` block at 0.1× read cost. |
| Inbound auth (front door) | Workers OAuth Provider on Atlas | `OAUTH_KV` (required backing store) | Owner authorizes once; clients present access tokens; `ctx.props` carries scopes. |
| Outbound provider creds | Cloudflare Secrets Store (one/account) | per-Worker async bindings | Never in `[vars]`/KV/Vault/Codex. |
| Vault delivery (outbound-only) | macOS launchd daemon (local) | `vault_outbox` D1 table + Obsidian Local REST API | No inbound port on the laptop; daemon long-polls + POSTs to `127.0.0.1:27124`. |
| Model access | AI Gateway (`claudeFor`/`modelFor`) | Workers AI binding `AI` | All Claude via Gateway; tiering in config not code. |

## Standard Stack

> **All versions re-verified against the npm registry on 2026-06-04** (the same day the build plan was last verified). The `CLAUDE.md` pins are current — no drift. `npm view <pkg> version` output is cited inline.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `agents` (Cloudflare Agents SDK) | **`0.14.1`** `[VERIFIED: npm registry, modified 2026-06-03]` | Agent/DO + remote MCP base classes | Cloudflare's official SDK. Ships ~weekly (0.13→0.14 in ~2 weeks). **Requires `compatibility_flags: ["nodejs_compat"]`** — omitting it is a runtime failure. Transitively pins MCP SDK `1.29.0`. `[CITED: CLAUDE.md, cloudflare-researcher.md]` |
| `@modelcontextprotocol/sdk` | **`1.29.0`** `[VERIFIED: npm registry]` | MCP servers (Google, GitHub, Obsidian bridge) | Pinned transitively by `agents@0.14.1`. **Prefer `registerTool()`** (v2-forward). Do NOT adopt v2 (alpha/unpublished). Don't bump independently above what `agents` pins. `[CITED: CLAUDE.md]` |
| `@cloudflare/workers-oauth-provider` | **`0.7.2`** `[VERIFIED: npm registry + GitHub, released 2026-06-04]` | Inbound OAuth front door | Official Cloudflare. **Requires a real `OAUTH_KV` KV namespace** or startup fails (not D1). API surface confirmed current (see Code Examples). `[CITED: github.com/cloudflare/workers-oauth-provider]` |
| `wrangler` | **`4.98.0`** `[VERIFIED: npm registry]` | Deploy + provisioning CLI | v4.x uses `kv namespace` (NOT deprecated `kv:namespace`); `secrets-store` open beta. `[CITED: CLAUDE.md]` |
| `zod` | **`4.4.3`** (range `^3.25 \|\| ^4.0`) `[VERIFIED: npm registry]` | Wire event + tool schemas | One zod schema is the single source of truth for the Wire shape, imported by every producer. `[CITED: build-plan §5.1]` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@cloudflare/vitest-pool-workers` | **`0.16.13`** `[VERIFIED: npm registry]` | Test runner inside real `workerd` | All Phase-0 tests. Runs DO storage, Queue producer/consumer, D1, `scheduled()`/`queue()`/Workflow entrypoints like production. **Forces `TZ=UTC`** — same as `wrangler dev`. |
| `vitest` | **`4.1.8`** `[VERIFIED: npm registry — see audit note]` | Test framework | Paired with the pool. slopcheck flagged `[SUS]` as a Levenshtein typosquat of `vite` — **false positive**; vitest is the legitimate, ubiquitous test framework. |
| `@anthropic-ai/sdk` | **`0.100.1`** `[VERIFIED: npm registry]` | Claude SDK (via AI Gateway) | `claudeFor(agent,env)` factory; never direct `api.anthropic.com`. |
| `jose` | **`6.2.3`** `[VERIFIED: npm registry]` | GitHub App RS256 JWT | `appJwt(env)` for the GitHub installation-token flow (T12). |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pnpm | npm/yarn | LOCKED to pnpm by D-04. Do not explore. |
| `wrangler.jsonc` | `wrangler.toml` | Fully equivalent; JSONC chosen for `$schema` editor autocomplete (build-plan §3). |
| Steward DO SQLite for ledger | D1 `atlas-db` | Both give the same atomicity guarantee; build plan uses D1 (`env.DB`) as the shared system-of-record so Flagger can read it later. |
| 5 independent crons for morning chain | 1 cron → Workflow | LOCKED (Phase 1 concern) — do NOT register 5 crons. Phase 0 only stands up `AtlasCoordinator`; the Workflow wires in Phase 1. |

**Installation (deferred to T0 — repo is greenfield):**
```bash
# T0: scaffold first Worker (C3 picks wrangler.jsonc + TS)
npm create cloudflare@latest apps/atlas -- --type=hello-world --ts
# root shared deps
pnpm add -D -w vitest @cloudflare/vitest-pool-workers wrangler typescript eslint prettier
pnpm add -w @anthropic-ai/sdk agents @modelcontextprotocol/sdk@1.29.0 \
  @cloudflare/workers-oauth-provider zod jose
```

## Package Legitimacy Audit

> slopcheck 0.6.1 was installed and run against the **correct npm ecosystem** (`--ecosystem npm`). An initial run defaulted to PyPI and produced misleading verdicts — see the cross-ecosystem warning below, which is itself a finding.

| Package | Registry | Age | Source Repo | slopcheck (npm) | Disposition |
|---------|----------|-----|-------------|-----------------|-------------|
| `agents` | npm | ~weekly releases; 0.14.1 mod 2026-06-03 | github.com/cloudflare/agents | [OK] | Approved |
| `@modelcontextprotocol/sdk` | npm | mature | github.com/modelcontextprotocol/typescript-sdk | [OK] | Approved |
| `@cloudflare/workers-oauth-provider` | npm | 0.7.2 released 2026-06-04, 22 releases | github.com/cloudflare/workers-oauth-provider | [OK] | Approved |
| `wrangler` | npm | 4.98.0, very mature | github.com/cloudflare/workers-sdk | [OK] | Approved |
| `zod` | npm | very mature | github.com/colinhacks/zod | [OK] | Approved |
| `@anthropic-ai/sdk` | npm | 0.100.1, mature | github.com/anthropics/anthropic-sdk-typescript | [OK] | Approved |
| `jose` | npm | 6.2.3, very mature | github.com/panva/jose | [OK] | Approved |
| `@cloudflare/vitest-pool-workers` | npm | 0.16.13 | github.com/cloudflare/workers-sdk | [OK] | Approved |
| `vitest` | npm | very mature, millions/wk | github.com/vitest-dev/vitest | [SUS] (typosquat-of-`vite` FP) | Approved — false positive |

**Packages removed due to slopcheck [SLOP] verdict:** none (on the npm ecosystem).
**Packages flagged as suspicious [SUS]:** `vitest` — flagged only because its name is Levenshtein-close to `vite`. It is the canonical Vitest test framework (github.com/vitest-dev/vitest, ubiquitous). No checkpoint needed.

**⚠ Cross-ecosystem confusion finding (planner should know):** When slopcheck auto-detected the ecosystem (no project files present in this greenfield repo), it defaulted to **PyPI** and reported:
- `@cloudflare/workers-oauth-provider` → `[SLOP]` ("does not exist on pypi") — a **false positive**; it exists on npm (`0.7.2`, confirmed).
- `agents` on PyPI is a **completely different, tensorflow-based package** (v1.4.0) — the exact cross-ecosystem hallucination vector (~9% rate) the protocol warns about. Installing `pip install agents` would pull the wrong package entirely.

**Implication for the planner:** every Phase-0 install command MUST target npm explicitly (`pnpm add`, `npm create cloudflare`), and any future automated legitimacy check MUST pass `--ecosystem npm`. A bare `slopcheck install agents` defaults to PyPI and is wrong for this repo.

**Side-effect to clean up:** `slopcheck install` ran `npm install` into the repo root, creating `/Users/danielchahine/Desktop/Programs/Atlas/node_modules/`, `package.json`, and `package-lock.json`. The sandbox blocked their removal during research. **These are NOT the intended Phase-0 scaffold** (T0 creates a pnpm monorepo from scratch). They should be deleted before T0 begins: `rm -rf node_modules package.json package-lock.json` from the repo root.

## Architecture Patterns

### System Architecture Diagram

```
                         ┌─────────────── CLOUDFLARE (cloud) ───────────────┐
  Cron Triggers (UTC) ──▶│  Atlas Worker                                     │
                         │   scheduled() dispatcher  ── switch(cron) ──┐     │
                         │   AtlasCoordinator DO (getByName "root")     │     │
                         │     · alarm() heartbeat (5-min, → P1 stale)  │     │
                         │   OAuthProvider (default export, OAUTH_KV)   │     │
                         └───────┬──────────────────────────────────────┘     │
                                 │ service-binding RPC (D-11) invoke no-op     │
                                 ▼                                             │
   producers (every     ┌─────────────────────┐                               │
   agent except         │  env.WIRE.send(evt)  │   evt = {agent,type,entity,   │
   Steward) ──────────▶ │  atlas-wire (Queue)  │         op,payload,idemKey}   │
                        └──────────┬───────────┘                               │
                                   │ at-least-once, best-effort order          │
                  max_concurrency=1│ (serial for…of)                           │
                                   ▼                                           │
                        ┌─────────────────────────────────────────┐           │
                        │ Steward Worker queue() — THE ONLY consumer│           │
                        │  validate shape → (malformed: ack + P3)   │           │
                        │  StewardWriter DO (getByName "vault")     │           │
                        │   blockConcurrencyWhile:                  │           │
                        │     DB.batch([ INSERT OR IGNORE ledger,   │           │
                        │                conditional counter bump ])│           │
                        │     if meta.changes===0 → REPLAY, skip    │           │
                        │     run_log + audit_log rows              │           │
                        │     enqueue vault_outbox intent (in lock) │           │
                        │   ── slow Obsidian write happens OUTSIDE ──│           │
                        └───────┬──────────────────────┬────────────┘           │
              retries exhausted │                      │ D1 atlas-db             │
                                ▼                      │ (counters, ledger,      │
                        ┌──────────────┐               │  run_log, audit_log,    │
                        │ atlas-wire-  │               │  vault_outbox)          │
                        │   dlq        │──▶ DLQ consumer │                       │
                        └──────────────┘    → Flagger    │                       │
                                            P2/P3 + audit │ vault_outbox(pending) │
                         └─────────────────────────────────┼─────────────────────┘
                                                            │ OUTBOUND long-poll
                                                            │ /bridge/poll (token)
                         ┌──────────── LOCAL macOS ─────────▼──────────────────┐
                         │ launchd daemon (outbound-only, NO inbound port)      │
                         │   drains vault_outbox → POST/PATCH                   │
                         │   https://127.0.0.1:27124 (Obsidian Local REST v3)   │
                         │   → The Vault (.md frontmatter)                      │
                         └──────────────────────────────────────────────────────┘

  Google Drive: codex.md  ──(drive.readonly)──▶ agents read (cached system block)
  Secrets Store (1/account): google-refresh-token, google-oauth-client-secret, gh-app-private-key
```

A reader can trace SPINE-01 (cron → dispatch → no-op invoke → `WIRE.send`), SPINE-02 (Queue → single consumer → DO lock → atomic batch → replay-skip), SPINE-05 (retries exhausted → DLQ → Flagger; `vault_outbox` → outbound daemon → Obsidian).

### Recommended Project Structure (greenfield — built in T0)
```
atlas/
├─ pnpm-workspace.yaml        # ["apps/*","packages/*"]  (D-04)
├─ tsconfig.base.json         # strict TS
├─ vitest.workspace.ts        # aggregates per-app vitest configs
├─ migrations/                # 0001_init_core.sql (shared D1 schema) — T1
├─ packages/
│  ├─ wire/                   # WireEvent zod schema + env.WIRE.send helper (single source of truth)
│  ├─ model/                  # claudeFor(agent,env) + modelFor — T14
│  ├─ steward-core/           # op→D1 + op→Local-REST mapping, idempotency ledger
│  ├─ codex/                  # Codex reader (drive.readonly) — T8
│  └─ shared/                 # Env types, Flagger emit, run-log helpers, zod schemas
├─ apps/
│  ├─ atlas/                  # T0,T4,T10: scheduled() + AtlasCoordinator DO + OAuthProvider
│  ├─ steward/                # T5,T6: StewardWriter DO + the ONLY atlas-wire consumer
│  ├─ mcp-google/             # T13: stateless createMcpHandler, gmail.modify scope floor
│  ├─ mcp-github/             # stateful McpAgent + OAuthProvider
│  └─ mcp-obsidian-bridge/    # T15: cloud side (/bridge/poll, /bridge/ack)
└─ daemon/                    # T15: LOCAL launchd daemon (outbound-only outbox drainer)
```
> `daemon/` is intentionally OUTSIDE `apps/` — it is not a Worker. In Phase 0 only its outbound-auth + outbox-drain plumbing is stood up (Echo/Quill themselves are Phase 3).

### Pattern 1: Atomic dedup + counter bump (the Steward critical section — THE crux)
**What:** The ledger insert and the counter bump are ONE D1 `batch()` transaction inside `blockConcurrencyWhile`. A crash between them would double-count.
**When to use:** Every `increment` op. This is SPINE-02.
```typescript
// Source: docs/13-build-plan.md T5 + §5.3; D1 batch() atomicity confirmed via Cloudflare docs
export class StewardWriter extends DurableObject<Env> {
  async apply(e: WireEvent): Promise<{ applied: boolean }> {
    return this.ctx.blockConcurrencyWhile(async () => {          // serialize this DO
      const ins = await this.env.DB.batch([                      // batch() = one atomic txn
        this.env.DB.prepare(
          "INSERT OR IGNORE INTO idempotency_keys(key,agent,type,op,entity,applied_at) VALUES (?,?,?,?,?,?)"
        ).bind(e.idempotencyKey, e.agent, e.type, e.op, e.entity, Date.now()),
        this.env.DB.prepare(                                      // increment math is ABSOLUTE in D1
          `INSERT INTO counters(entity,value) VALUES(?, ?)
           ON CONFLICT(entity) DO UPDATE SET value = value + ?
           WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ?)`
        ).bind(e.payload.counter ?? e.entity, e.payload.delta ?? 1, e.payload.delta ?? 1, e.idempotencyKey),
      ]);
      if (ins[0].meta.changes === 0) return { applied: false };  // REPLAY → no double-count
      // upsert/append branches enqueue a vault_outbox intent HERE (still in lock)
      await this.env.DB.prepare(
        "INSERT INTO run_log(agent,type,entity,op,result,ts) VALUES(?,?,?,?, 'ok', ?)"
      ).bind(e.agent, e.type, e.entity, e.op, Date.now()).run();
      return { applied: true };
    });
    // The slow Obsidian MCP write happens OUTSIDE blockConcurrencyWhile (drained from vault_outbox).
  }
}
```
**Note:** D1 supports **anonymous positional `?` params only** — no named params. The build-plan §5.3 snippet has a `?1` named-param variant; use only positional `?` (build-plan T5 version is correct).

### Pattern 2: The single Wire consumer — serial, never `Promise.all`
**What:** `max_concurrency=1` + processing each batch serially (`for…of`) so two events in one batch can't race the Vault either.
```typescript
// Source: docs/13-build-plan.md T6; Queue consumer API confirmed via Cloudflare docs
export default {
  async queue(batch: MessageBatch<WireEvent>, env: Env): Promise<void> {
    const steward = env.STEWARD_LOCK.getByName("vault");         // single global writer
    for (const msg of batch.messages) {                          // SERIAL, not Promise.all
      const e = msg.body;
      if (!e?.agent || !e?.op || !e?.entity || !e?.idempotencyKey) {
        await flag(env, "P3", "malformed wire event", e); msg.ack(); continue; // don't poison-loop
      }
      try { await steward.apply(e); msg.ack(); }                 // replay & success both = done
      catch (err) {
        if (msg.attempts >= 4) await flag(env, "P2", "steward write failing", { e, err });
        msg.retry({ delaySeconds: 60 });                         // redelivery is safe (ledger dedup)
      }
    }
  },
} satisfies ExportedHandler<Env>;   // use `satisfies`, NOT the `: ExportedHandler<Env>` annotation
```

### Pattern 3: Workflow instance id = trigger-level idempotency handle
**What:** Creating a Workflow instance with an id that already exists **throws** — so a re-fired or missed-then-recovered cron is a safe no-op. (Wired in Phase 1, but the pattern is locked now.)
```typescript
// Source: Cloudflare Workflows docs (confirmed: create() throws on duplicate id)
ctx.waitUntil(env.MORNING_CHAIN.create({ id: `morning-${date}`, params: { date, tz } }));
```
**Verified:** `env.BINDING.create({id,...})` throws if the id is already used by a non-retention-expired instance. `NonRetryableError` imports from `cloudflare:workflows` (a different module than `WorkflowEntrypoint`/`WorkflowStep`/`WorkflowEvent` which import from `cloudflare:workers`).

### Anti-Patterns to Avoid
- **`Promise.all` over a Wire batch** — breaks serialization; use `for…of`.
- **`crypto.randomUUID()` for a scheduled-work `idempotencyKey`** — makes replay non-idempotent. Use structured keys (`filer:sweep:<date>`, `compass:plan:<date>`).
- **Counters or idempotency keys in KV** — KV is 1 write/s/key + ≤60s lag. D1 only.
- **Named D1 params (`?1`, `:name`)** — D1 supports anonymous positional `?` only.
- **A second `atlas-wire` consumer** — HARD CI failure (Pillar 1). Only Steward.
- **Slow Obsidian write inside `blockConcurrencyWhile`** — an unreachable bridge would stall the whole Wire. Lock holds only dedup+ledger+counter+outbox-enqueue.
- **`legacy new_classes` DO migration** — all Atlas DOs use `new_sqlite_classes`.
- **Dropping `nodejs_compat`** — `agents` SDK runtime failure.
- **`retry_delay_secs` in the consumer config block** — NOT a valid key (see Open Questions / Pitfall 6).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| At-least-once dedup | Custom seen-set in KV/memory | D1 `INSERT OR IGNORE` + `meta.changes` | Atomic with the bump; survives Worker restarts; KV lags. |
| Write serialization | Mutex/lock files | Durable Object `getByName("vault")` + `blockConcurrencyWhile` | DO single-threaded-per-id is the platform's serialization primitive. |
| Durable retry/resume sequencing | Custom state machine in D1 | Cloudflare Workflows (Phase 1) | `step.do` memoization gives resume-on-failure + start-after-success free. |
| Inbound OAuth + PKCE + token store | Custom OAuth server | `@cloudflare/workers-oauth-provider` 0.7.2 | Handles RFC-7591 registration, S256 PKCE, grant store, `listUserGrants`/`revokeGrant`. |
| GitHub App JWT (RS256) | Manual crypto | `jose` | Correct RS256 signing; `iat` backdating; opaque token handling. |
| DLQ / dead-letter handling | Manual failure table | Queue `dead_letter_queue` + a DLQ consumer | Without it, exhausted msgs drop silently. |
| Secret storage | `[vars]` / KV / files | Cloudflare Secrets Store (async `await env.X.get()`) | Encrypted, bound per-Worker, never tracked. |
| Test runtime | Node mocks of `workerd` | `@cloudflare/vitest-pool-workers` | Real DO storage/Queues/D1/`scheduled()`/`queue()` — Node mocks miss real behavior. |
| Obsidian frontmatter PATCH | String-splice `.md` files | Local REST API v3 PATCH (`Operation`/`Target-Type:frontmatter`/`Target`) | v3 does intelligent JSON merge into frontmatter; hand-editing corrupts YAML. |

**Key insight:** Phase 0 is almost entirely "wire the platform primitives together correctly." The temptation to hand-roll dedup/serialization "to see something work" is exactly the trap the build plan warns against — that work *is* the spine.

## Runtime State Inventory

> This is a **greenfield** phase — no prior code, no prior runtime state, no rename/refactor. The Inventory is included for completeness because Phase 0 *establishes* state that later phases must respect.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None pre-existing. Phase 0 *creates*: D1 `atlas-db` (counters, idempotency_keys, run_log, audit_log, vault_outbox); KV `CONFIG`, `OAUTH_KV`; R2 `atlas-blobs`. | Provision via `wrangler` (T1/T2). No migration of existing data. |
| Live service config | None pre-existing. Phase 0 *creates*: GCP project (Gmail/Calendar/Pub/Sub APIs + `gmail-filer` topic), GitHub App, two AI Gateways (`atlas-reasoning`, `atlas-highvolume`), Obsidian Local REST API plugin config. These live in provider UIs/dashboards, **not in git** — document their existence as prerequisites. | Owner provisions per build-plan §1; Phase 0 verifies round-trips. |
| OS-registered state | None pre-existing. Phase 0 *creates*: macOS launchd plist `~/Library/LaunchAgents/com.atlas.bridge.plist` (T15, outbound daemon). | Register the launchd job; verify `lsof` shows no inbound port. |
| Secrets/env vars | None pre-existing. Phase 0 *creates*: Secrets Store keys `google-refresh-token`, `google-oauth-client-secret`, `github-app-private-key`; `wrangler secret put` for `ANTHROPIC_API_KEY`, `CF_AIG_TOKEN`, `ATLAS_BRIDGE_TOKEN`. One Secrets Store per account (open beta). `--remote` secrets NOT readable in `wrangler dev` — create non-remote dev copies. | Provision once; bind per-Worker; async read. |
| Build artifacts | **slopcheck side-effect:** `node_modules/`, `package.json`, `package-lock.json` were created in the repo root during research (sandbox blocked cleanup). These are NOT the intended pnpm-monorepo scaffold. | **Delete before T0** (`rm -rf node_modules package.json package-lock.json`). T0 creates the real pnpm monorepo. |

## Common Pitfalls

### Pitfall 1: `TZ=UTC` everywhere in the runtime
**What goes wrong:** `new Date()` returns UTC in `workerd`, `wrangler dev`, AND vitest — even on the owner's laptop. "Today" computed naively is the wrong date for an owner in `America/Toronto` after ~20:00 local.
**Why it happens:** Cloudflare forces `TZ=UTC` to match production; cron triggers are UTC-only with no DST.
**How to avoid:** Derive owner-local time explicitly: `new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto'}).format(new Date())` → `YYYY-MM-DD`. Internal Workflow waits use `step.sleepUntil` with a tz-correct `Date` (DST-safe). Only the trigger cron needs the twice-yearly EST/EDT hand-edit (D-06).
**Warning signs:** Date-keyed idempotency keys (`compass:plan:<date>`) off by a day; a "today" view rendering tomorrow.

### Pitfall 2: KV used for counters or idempotency
**What goes wrong:** Lost increments / double-counts under concurrency.
**Why it happens:** KV looks convenient. But it caps at 1 write/s/key with ≤60s global propagation lag.
**How to avoid:** All counters and idempotency keys in D1 (`env.DB`) — or the Steward DO's SQLite, same guarantee. `CONFIG` KV is read-mostly config only; never counters, never secrets.
**Warning signs:** `env.CONFIG.put` anywhere near a counter; a counter that "sometimes" doesn't move.

### Pitfall 3: The non-atomic critical section (the double-count bug)
**What goes wrong:** A crash between the ledger insert and the counter bump double-counts on redelivery.
**Why it happens:** Treating dedup-check and bump as two separate statements.
**How to avoid:** ONE `DB.batch([...])` (all-or-nothing) inside `blockConcurrencyWhile`. The conditional `WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ?)` makes the bump itself replay-safe. `meta.changes === 0` ⇒ replay ⇒ skip.
**Warning signs:** A counter test that passes once but fails on replay; ledger and counter in separate `await`s.

### Pitfall 4: Splitting the single-writer DO
**What goes wrong:** Two DO instances = two writers = file races on Obsidian `.md` + double-counts.
**Why it happens:** Calling `getByName` with anything other than the canonical `"vault"` (Steward) / `"root"` (Atlas).
**How to avoid:** Exactly `env.STEWARD_LOCK.getByName("vault")` and `env.ATLAS.getByName("root")`. A unit test asserts two `getByName("vault")` calls resolve to one DO.
**Warning signs:** A dynamic/per-request DO name; `.sync-conflict-*.md` files appearing in the Vault.

### Pitfall 5: Missing the DLQ → silent message loss
**What goes wrong:** Events that exhaust `max_retries` are dropped silently with no DLQ — counters silently go stale.
**Why it happens:** `dead_letter_queue` is optional in config.
**How to avoid:** Create `atlas-wire-dlq` (T3) AND give it a consumer that turns a dead event into a Flagger P2/P3 incident + audit row (T7). This is SPINE-05.
**Warning signs:** No `atlas-wire-dlq` in `wrangler.jsonc`; a DLQ with no consumer.

### Pitfall 6: `retry_delay_secs` in the consumer config block (CONFIRMED API DRIFT)
**What goes wrong:** Invalid/ignored config key; the intended 30s retry delay isn't applied at the consumer level.
**Why it happens:** The build-plan T6 `wrangler.jsonc` consumer block and the `wrangler queues consumer add` example both reference `retry_delay_secs`/`--retry-delay-secs`. **Cloudflare's current docs confirm the consumer-level keys are: `queue`, `max_batch_size`, `max_batch_timeout`, `max_retries`, `dead_letter_queue`, `max_concurrency` — `retry_delay_secs` is NOT among them.** Retry delay is set per-message (`msg.retry({delaySeconds})`) or queue-level (`--delivery-delay-secs`).
**How to avoid:** Drop `retry_delay_secs` from the consumer config. Set the delay per-message in the `queue()` handler (`msg.retry({ delaySeconds: 60 })`, as Pattern 2 already does) — that is the correct, current mechanism.
**Warning signs:** `wrangler deploy` warning about an unknown consumer key; a deploy that silently ignores the setting.

### Pitfall 7: Google OAuth missing `access_type=offline` / `prompt=consent`
**What goes wrong:** No refresh token returned → re-consent required on every token expiry → the whole outbound automation breaks.
**Why it happens:** Both flags are required, and refresh responses never return a *new* refresh token (you must keep the original).
**How to avoid:** Authorize URL MUST include `access_type=offline` AND `prompt=consent` AND S256 PKCE (T11). Persist the original refresh token to Secrets Store; never expect a new one on refresh.
**Warning signs:** Token exchange response without a `refresh_token`; periodic re-auth prompts.

### Pitfall 8: `--remote` Secrets Store secrets unreadable in `wrangler dev`
**What goes wrong:** `await env.GOOGLE_REFRESH_TOKEN.get()` returns nothing locally; forgetting `await` returns the binding object, not the string.
**How to avoid:** Create non-remote dev copies for `wrangler dev`; always `await` the async `.get()`. One Secrets Store per account (open beta) — plan binding names, not multiple stores.

## Code Examples

### Cron dispatch → no-op invoke → Wire send (SPINE-01)
```typescript
// Source: docs/13-build-plan.md (Atlas dispatcher) + Cloudflare scheduled() handler API
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    switch (controller.cron) {
      case "45 12 * * *": {  // (EST form; re-derive to "45 11 * * *" in EDT — D-06)
        // SPINE-01: route a message onto the Wire (no-op agent in Phase 0)
        await env.WIRE.send({
          agent: "Atlas", type: "noop.tick", entity: "spine", op: "append",
          payload: { note: "phase-0 smoke" },
          idempotencyKey: `atlas:noop:${localDate(env)}`,
        });
        break;
      }
    }
  },
} satisfies ExportedHandler<Env>;
```

### Atlas heartbeat self-monitor (D-10, P1 on stale)
```typescript
// Source: docs/13-build-plan.md T4 — one alarm per DO (setting a new time overwrites)
export class AtlasCoordinator extends DurableObject<Env> {
  async beat() { await this.ctx.storage.put("lastBeat", Date.now()); }
  async startHeartbeat() {
    if ((await this.ctx.storage.getAlarm()) == null)
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
  async alarm() {
    const last = (await this.ctx.storage.get<number>("lastBeat")) ?? 0;
    if (Date.now() - last > 5 * 60_000) {          // D-10: 5-min staleness → P1
      // emit P1 Critical to Flagger via the Wire: orchestrator heartbeat stale
    }
    await this.ctx.storage.setAlarm(Date.now() + 60_000);  // reschedule inside alarm()
  }
}
```

### Workers OAuth Provider front door (SPINE-04 inbound, T10)
```typescript
// Source: github.com/cloudflare/workers-oauth-provider v0.7.2 (API confirmed current 2026-06-04)
export default new OAuthProvider({
  apiRoute: ['/mcp/', '/api/'],
  apiHandler: AtlasMcpApi,            // WorkerEntrypoint; reads ctx.props {ownerId, agent, scopes}
  defaultHandler: consentHandler,     // renders consent, calls completeAuthorization()
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',   // RFC-7591
  scopesSupported: ['gmail.modify','calendar.events','calendar.readonly',
                    'drive.file','drive.readonly','spreadsheets',
                    'github.read','github.write','vault.write'],
  accessTokenTTL: 3600,
});
// REQUIRES a real KV namespace bound as OAUTH_KV (not D1) or startup fails.
// listUserGrants() / revokeGrant() back an owner-facing "what can Atlas do / revoke" surface.
```

### D1 init migration (T1 — system-of-record)
```sql
-- migrations/0001_init_core.sql  (positional ? params only; absolute increment math)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY, agent TEXT NOT NULL, type TEXT, entity TEXT, op TEXT,
  applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS counters (
  entity TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, type TEXT, entity TEXT, op TEXT,
  rows_read INTEGER, rows_written INTEGER, duration_ms INTEGER, result TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (        -- security forensic record (never the token)
  id TEXT PRIMARY KEY, ts INTEGER, agent TEXT, action TEXT, target TEXT,
  scope_used TEXT, gated INTEGER, decision TEXT, outcome TEXT,
  trust INTEGER, consent_flag INTEGER, flag_id TEXT);
CREATE TABLE IF NOT EXISTS vault_outbox (     -- drained by the outbound local bridge
  idem TEXT PRIMARY KEY, path TEXT NOT NULL, method TEXT NOT NULL,
  headers TEXT NOT NULL, body TEXT, state TEXT NOT NULL DEFAULT 'pending', ts INTEGER NOT NULL);
```
> The build plan shows `run_log` in two slightly different shapes (T1 vs §5.2 observability). The §5.2 version (with `duration_ms`) is the richer one — planner should use a single reconciled schema with `rows_read`/`rows_written`/`duration_ms` so Flagger (Phase 2) can read it. `[ASSUMED — A4]`

### op → Obsidian Local REST v3 mapping (T15)
```
increment → PATCH /vault/Counters/metrics.md   Operation:replace Target-Type:frontmatter Target:<counter>  (writes ABSOLUTE value from D1)
upsert    → PATCH /vault/<note>.md              Operation:replace Target-Type:frontmatter Target:<field> Create-Target-If-Missing:true
upsert(view) → PUT /vault/Dashboard/Today.md    Target-Type:heading Target:Today
append    → POST /vault/Dashboard/Heartbeat.md  Target-Type:heading Target:Run Log
```
> Steward NEVER calls `DELETE /vault/...` (Pillar 2). The daemon trusts the plugin's self-signed cert ONLY for `127.0.0.1` (`rejectUnauthorized:false`), never on the outbound cloud connection. v3 PATCH headers confirmed current (`[CITED: coddingtonbear.github.io/obsidian-local-rest-api]`); v2 PATCH format sunset at plugin 4.0 — adopt v3.0+.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Queues require Workers Paid | Queues GA on Free (10k queues, 10k ops/day, 24h retention) | 2026-02-04 | D-01: the entire spine builds on Free. Reconcile the stale "Paid required" claim (D-02). |
| `: ExportedHandler<Env>` annotation | `satisfies ExportedHandler<Env>` | — | Use `satisfies` on every default export. |
| `kv:namespace` wrangler subcommand | `kv namespace` (space) | wrangler v3.60+ | Build plan uses the correct space form. |
| DO `new_classes` migration | `new_sqlite_classes` | SQLite-backed DOs | All Atlas DOs use `new_sqlite_classes` (Free-tier eligible). |
| Obsidian Local REST API v2 PATCH (`Heading`/`Content-Insertion-Position`) | v3 PATCH (`Operation`/`Target-Type`/`Target`) | v3.0; v2 removed at v4.0 | Steward's increment/upsert/append map onto v3. Adopt v3.0+. |
| GitHub PAT | GitHub App installation tokens (RS256 JWT → opaque `ghs_…`, ~1h) | — | Scoped, revocable, minted per-run, never persisted. |

**Deprecated/outdated:**
- `claude-*-4-20250514` model IDs (retire 2026-06-15) — never pin. Use `claude-opus-4-8` / `claude-sonnet-4-6` / `claude-haiku-4-5`.
- `@modelcontextprotocol/sdk` v2 (alpha/unpublished) — do not adopt.
- "Workers Paid is a hard prerequisite" — stale; Free is sufficient (D-01/D-02).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The build-plan `wrangler.jsonc`, D1 schema, and Steward critical-section code are accurate as-written (other than the `retry_delay_secs` drift). | Code Examples / Patterns | LOW — re-verified the load-bearing platform APIs (Queues, Workflows, OAuthProvider, D1) against Cloudflare docs today; all match. |
| A2 | Cloudflare model IDs `claude-opus-4-8`/`claude-sonnet-4-6`/`claude-haiku-4-5` are current and valid via AI Gateway. | Standard Stack / State of the Art | MEDIUM — taken from CLAUDE.md (project-authoritative). Not independently re-verified against the Anthropic model list this session. Phase 0 doesn't call models, so low Phase-0 impact; confirm before Phase 1. |
| A3 | The `agents` SDK Agent/DO/Workflow entrypoint base-class patterns are unchanged at 0.14.1 vs the build-plan snippets. | Patterns | LOW-MEDIUM — version confirmed on npm (0.14.1, mod 2026-06-03); the specific class API surface was NOT pulled via Context7 (MCP tools unavailable to this agent — see Open Questions). Use the `cloudflare-researcher` subagent to confirm exact `WorkflowEntrypoint`/`DurableObject` syntax before implementing T4/T5. |
| A4 | A single reconciled `run_log` schema (with `duration_ms`) is what Flagger will read in Phase 2. | Code Examples | LOW — both build-plan variants are compatible supersets; planner just picks the richer one. |
| A5 | Exact OAuth scope strings per agent (e.g. `gmail.modify`, `calendar.events`) and Secrets Store key names are the final values. | SPINE-04 | LOW — these are Claude's Discretion (CONTEXT.md) and match CLAUDE.md; confirm during planning. |

## Open Questions

1. **`agents` SDK exact class API at 0.14.1 (DO/Workflow base classes).**
   - What we know: version is 0.14.1 (npm, mod 2026-06-03); requires `nodejs_compat`; pins MCP SDK 1.29.0.
   - What's unclear: the precise current `DurableObject<Env>` / `WorkflowEntrypoint` import + method surface was not pulled via Context7 this session — the MCP tools (`mcp__context7__*`, `mcp__cloudflare-docs__*`) were not exposed to this researcher agent (known upstream bug for tool-restricted agents), and the `ctx7` CLI fallback is not installed. I verified the platform APIs (Queues/Workflows/OAuthProvider/D1) directly via official docs instead.
   - Recommendation: before implementing T4/T5, invoke the project's **`cloudflare-researcher`** subagent (it has the MCP tools) or run `/cf-docs durable objects` + `/cf-docs workflows` to confirm the exact class syntax. Do not block planning on this — the build-plan snippets are the working hypothesis.

2. **`retry_delay_secs` consumer key (CONFIRMED drift — resolve in the plan).**
   - What we know: not a valid consumer-level config key (Cloudflare docs).
   - Recommendation: drop it from the T6 config; set per-message `msg.retry({delaySeconds:60})` (already in Pattern 2). Update `docs/13-build-plan.md` T6 to remove the stale key when convenient.

3. **`run_log` schema reconciliation (T1 vs §5.2).**
   - Recommendation: use one schema with `rows_read`/`rows_written`/`duration_ms`/`result`; T1 and §5.2 are compatible.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Build/deploy toolchain | ✓ (owner-verified 2026-06-04) | v22.22.3 (LTS) | — |
| pnpm (corepack) | Monorepo (D-04) | ✓ (owner-verified) | 11.5.1 | — |
| wrangler (logged in) | Provision + deploy | ✓ (owner-verified) | 4.98.0 (latest) | — |
| Cloudflare account (Free) | Queues/Workflows/DOs/D1/KV/R2 | ✓ Free is sufficient (D-01) | Free; token carries `queues (write)` | — |
| `wrangler queues list` | Confirms Queues on Free | ✓ (owner-verified — succeeds on Free) | — | — |
| Google Cloud project + OAuth | SPINE-04 (Gmail/Calendar/Pub/Sub) | ⚠ owner provisions in T9-T11 | — | None — blocks SPINE-04 if absent |
| GitHub App | SPINE-04 (installation tokens) | ⚠ owner provisions in T12 | — | None — blocks GitHub leg of SPINE-04 |
| Anthropic API key + AI Gateways (×2) | T14 (`claudeFor`) | ⚠ owner provisions | — | Phase 0 stands up the factory; models not called until Phase 1 |
| Obsidian + Local REST API plugin v3.0+ | SPINE-05 (the bridge) | ⚠ owner provisions; Obsidian must be RUNNING for writes | plugin v3.0+ (v2 PATCH removed at 4.0) | None — bridge can't land writes if absent |
| Secrets Store (one/account, open beta) | T9 (provider creds) | ⚠ owner provisions | open beta | `wrangler secret put` for higher-churn values |
| slopcheck (legitimacy gate) | research only | ✓ installed this session | 0.6.1 | mark packages ASSUMED if absent |

**Missing dependencies with no fallback (planner must sequence as owner-provisioning prerequisites before the dependent task):**
- GCP project/OAuth (before T11), GitHub App (before T12), Obsidian + Local REST API plugin running (before T15 end-to-end test), Secrets Store provisioned (before T9). These are documented in build-plan §1 as pre-Phase-0 owner setup; the planner should make them explicit gate tasks.

**Missing dependencies with fallback:** AI Gateway/Anthropic key — Phase 0 only builds the `claudeFor` factory (T14); no model is actually invoked until Phase 1, so a not-yet-provisioned gateway doesn't block Phase-0 completion (only the T14 live-call acceptance check).

## Validation Architecture

> nyquist_validation is enabled (not set to false in config.json). Section included.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest `4.1.8` + `@cloudflare/vitest-pool-workers` `0.16.13` (real `workerd`/Miniflare; `TZ=UTC`) |
| Config file | `vitest.config.ts` per app + root `vitest.workspace.ts` — **none exist yet (Wave 0 creates them)** |
| Quick run command | `pnpm test` (or `vitest run <file>` for a single suite) |
| Full suite command | `pnpm -r test` then `pnpm -r build && pnpm -r typecheck` |

```jsonc
// vitest.config.ts — the pool config every spine Worker uses
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
  test: { poolOptions: { workers: {
    wrangler: { configPath: "./wrangler.jsonc" },     // real bindings: WIRE, DB, STEWARD_LOCK
    miniflare: { compatibilityFlags: ["nodejs_compat"] },
    isolatedStorage: true,                            // fresh DO/D1/KV/R2 per test
  }}},
});
```

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SPINE-01 | Cron string routes → no-op invoke → `WIRE.send` reaches consumer | integration (scheduled + queue) | `wrangler dev --test-scheduled` + `curl ".../__scheduled?cron=45+12+*+*+*"`; vitest `worker.queue(batch,env,ctx)` | ❌ Wave 0 |
| SPINE-02 | Replay same `idempotencyKey` twice → counter unchanged (`meta.changes===0`) | unit (DO RPC) | `vitest run apps/steward/replay.test.ts` | ❌ Wave 0 |
| SPINE-02 | Two `getByName("vault")` → one DO; `blockConcurrencyWhile` serializes 50 concurrent `apply()` | unit (DO) | `vitest run apps/steward/serialize.test.ts` | ❌ Wave 0 |
| SPINE-02 | Malformed event (missing op/entity/idemKey) → `ack()` + P3, no write (no poison-loop) | unit (consumer) | `vitest run apps/steward/malformed.test.ts` | ❌ Wave 0 |
| SPINE-03 | Codex read via `drive.readonly` returns all 7 §11 sections; no write path (403) | integration | `vitest run packages/codex/read.test.ts` | ❌ Wave 0 |
| SPINE-04 | Google authorize → refresh token; `grant_type=refresh_token` → fresh access token w/o re-consent; GitHub App → `ghs_` token | integration (live, manual once) | manual round-trip + `vitest run apps/atlas/oauth.test.ts` (mocked) | ❌ Wave 0 |
| SPINE-04 | Token lacking `gmail.modify` → 403; no reachable delete path; 2FA/reset stripped server-side | unit (scope + redaction) | `vitest run apps/mcp-google/scope.test.ts`, `.../redact.test.ts` | ❌ Wave 0 |
| SPINE-05 | Exhausted-retry msg → `atlas-wire-dlq` → Flagger P2/P3 + audit row, never silent | integration (queue + DLQ) | `vitest run apps/steward/dlq.test.ts` | ❌ Wave 0 |
| SPINE-05 | `increment`/`upsert`/`append` each land in Vault via `vault_outbox`; replay → counter unchanged; no inbound port | integration + manual `lsof` | `vitest run apps/mcp-obsidian-bridge/*.test.ts` + `lsof -i -nP \| grep LISTEN` | ❌ Wave 0 |

### The three mandatory tests per agent PR (CLAUDE.md Definition of Done)
1. **Wire-contract test** — one shared zod `WireEvent` schema (`packages/wire`); every producer's emitted event parses + has a structured `idempotencyKey` (regex-matched, e.g. `/^forge:task:\d{4}-\d{2}-\d{2}:/`).
2. **Replay test** — `apply()` the same `idempotencyKey` twice → first `{applied:true}`, second `{applied:false}`; counter value is 1, not 2 (`meta.changes===0`).
3. **Failure-path test** — asserts the right Flagger severity: malformed → P3; Steward retry-exhaustion → P2; DLQ landing → P2/P3; heartbeat stale → P1.

### The two CI invariants (structural gates)
1. **Exactly one `atlas-wire` consumer** — grep gate; a second consumer fails the build:
   ```bash
   test "$(grep -rl 'queue *= *"atlas-wire"' --include=wrangler.* | xargs grep -l 'queues.consumers' | wc -l | tr -d ' ')" = "1" \
     || { echo "FAIL: more than one consumer on atlas-wire"; exit 1; }
   ```
2. **2FA/reset-link redaction backstop** — a unit test feeds known 2FA/reset fixtures through the digest/output builder and asserts none survive (`SECRET_PATTERNS = [/\b\d{6}\b/, /reset[-_ ]?(password|link)/i, /verification code/i, /https?:\/\/\S*\/(reset|verify|confirm)\S*/i]`). Belt-and-suspenders with server-side stripping in the Google MCP. A caught attempt to expose a code = P1 (block + flag). *(In Phase 0 the digest builder doesn't exist yet — the redaction utility + its test land here as a shared `packages/security` primitive so Herald inherits it in Phase 1.)*

### Sampling Rate
- **Per task commit:** `vitest run <the task's test file>` (quick, < 30s).
- **Per wave merge:** `pnpm -r test` + the one-writer grep + the redaction test.
- **Phase gate:** full suite green + the seven "Phase 0 done" checkboxes (build-plan §2) verified against the real deploy, then `/gsd:verify-work`.

### Wave 0 Gaps
- [ ] `vitest.workspace.ts` + per-app `vitest.config.ts` (pool config) — no test infra exists (greenfield).
- [ ] `packages/wire/contract.ts` + `contract.test.ts` — the canonical `WireEvent` zod schema + contract test.
- [ ] `apps/steward/replay.test.ts`, `serialize.test.ts`, `malformed.test.ts`, `dlq.test.ts` — SPINE-02/05.
- [ ] `packages/security/redact.ts` + `redact.test.ts` — the 2FA/reset CI backstop (shared primitive).
- [ ] CI script: the one-`atlas-wire`-consumer grep gate (GitHub Actions).
- [ ] Framework install: `pnpm add -D -w vitest @cloudflare/vitest-pool-workers` (T0/Wave 0).

## Security Domain

> `security_enforcement` is not set to false → enabled. This phase is security-critical: it establishes OAuth, secrets handling, scope enforcement, and the 2FA/reset-link redaction backstop that every later agent inherits.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V1 Architecture | yes | One-writer-per-resource (Pillar 1); single serialized consumer; least-privilege per Worker (one Worker = one binding set). |
| V2 Authentication | yes | Workers OAuth Provider (inbound); Google offline refresh + S256 PKCE; GitHub App RS256 JWT → short-lived installation token. |
| V3 Session Management | yes | OAuth access tokens TTL 3600s; refresh tokens 30d (provider default); grant store in `OAUTH_KV`; `listUserGrants`/`revokeGrant` for owner revocation. |
| V4 Access Control | yes | Per-agent scope floor enforced **server-side in two places**: inbound `scopesSupported` allow-list + MCP tool-handler 403. Granted scope ≠ silent execution (gates). |
| V5 Input Validation | yes | zod `WireEvent` schema validates every Wire event; malformed → ack + P3, no write. D1 positional `?` params (no SQL injection surface via named interpolation). |
| V6 Cryptography | yes | `jose` for RS256 (never hand-roll); Cloudflare Secrets Store for key material; never `[vars]`/KV/Vault/Codex. |
| V7 Error/Logging | yes | `run_log` (every pass) + `audit_log` (every action, records `scope_used` **never the token**); DLQ → Flagger; secrets never logged. |
| V8 Data Protection | yes | 2FA codes / reset links / login URLs stripped server-side in the Google MCP regardless of scope; never reach label/digest/export/Vault/Codex. R2 `audio/raw/` 7-day expiry (privacy boundary, declared in T2). |
| V9 Communications | yes | Outbound-only daemon (no inbound port on laptop); self-signed cert trusted ONLY for `127.0.0.1`; cloud connections fully validated. |

### Known Threat Patterns for the Atlas stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| At-least-once double-count | Tampering | Atomic D1 `batch()` dedup+bump in `blockConcurrencyWhile`; `meta.changes===0` replay skip. |
| Concurrent Vault file races | Tampering | Single named DO (`getByName("vault")`) + `max_concurrency=1` + serial `for…of`. |
| 2FA/reset-link leakage into a digest/Vault | Information Disclosure | 3-layer: server-side MCP strip + output-redaction pass + CI unit test. P1 + block on a caught attempt. |
| Over-broad OAuth scope / silent destructive action | Elevation / Tampering | Least-privilege scope floor; no delete code path (Filer `gmail.modify` can't delete); gates (Pillar 2). |
| Token theft from config/logs | Information Disclosure | Secrets Store only; `audit_log` records `scope_used`, never the token; never in `[vars]`/KV/Vault/Codex. |
| Silent message loss on exhausted retries | Repudiation / DoS | Mandatory `atlas-wire-dlq` + a DLQ consumer → Flagger incident + audit row. |
| Inbound attack surface on the laptop | Spoofing / Tampering | Outbound-only daemon; `lsof` proves no inbound listening port (only Obsidian's `127.0.0.1:27124`). |
| Cross-ecosystem dependency confusion (npm vs PyPI `agents`) | Tampering (supply chain) | Install only via npm/pnpm explicitly; verify on the correct registry (`--ecosystem npm`). See Package Legitimacy Audit. |
| Stale orchestrator (silent failure) | DoS | `AtlasCoordinator` `alarm()` heartbeat; 5-min staleness → P1 (D-10). |

## Project Constraints (from CLAUDE.md)

The planner MUST honor these (treat with same authority as locked CONTEXT.md decisions):
- **5 pillars + security** are non-negotiable: one-writer-per-resource (a second `atlas-wire` consumer is a hard CI fail); suggest-don't-destroy (no autonomous delete anywhere; gates fail-safe not fail-open); cloud-by-default; D1 is system-of-record (Vault is a projection); idempotent + observable (structured `idempotencyKey`, `run_log`+`audit_log`).
- **Security hard invariants:** NEVER surface 2FA codes / reset links / login URLs anywhere; secrets only via bindings (never `[vars]`/KV/Vault/Codex/`audit_log`/logs/tracked files); least-privilege OAuth per agent.
- **Canonical strings (exact):** bindings `WIRE`/`DB`/`CONFIG`/`OAUTH_KV`/`BLOBS`/`AI`/`STEWARD_LOCK`/`ATLAS`/`MORNING_CHAIN`; DO classes PascalCase (`AtlasCoordinator`, `StewardWriter`); `new_sqlite_classes`; Wire `agent` field = codename; structured idempotency keys (never `crypto.randomUUID()` for scheduled work); Wire contract `{agent,type,entity,op,payload,idempotencyKey}` copied verbatim.
- **Pins:** `agents@^0.14.x` (+`nodejs_compat`), `@modelcontextprotocol/sdk@1.29.0` (prefer `registerTool()`, no v2), `@cloudflare/workers-oauth-provider@^0.7.x`, `wrangler` v4, `zod ^3.25||^4.0`, `compatibility_date=2026-04-25`. Model IDs `claude-opus-4-8`/`claude-sonnet-4-6`/`claude-haiku-4-5` (never the retired `-20250514`).
- **Gotchas:** `TZ=UTC` everywhere (derive owner-local via `Intl`); cron UTC-only no DST; KV not for counters/idempotency; D1 positional `?` only + absolute increment math; Steward critical section atomic in `blockConcurrencyWhile`; consumer serial `for…of`; DLQ mandatory; malformed event → ack + P3; `NonRetryableError` from `cloudflare:workflows`; Google OAuth `access_type=offline`+`prompt=consent`+S256; Secrets Store one/account + async read + `--remote` not in dev; staging fires NO crons (`env.staging.triggers.crons=[]`).
- **Definition of Done (every agent PR):** Wire-contract test + replay test (`meta.changes===0`) + failure-path→Flagger-severity test.
- **GSD discipline:** don't hand-edit `.planning/` state or counters.
- **Use the project subagents:** `cloudflare-researcher` (live SDK syntax — use it to close Open Question 1), `pillar-auditor` (the 7 invariants, read-only — run before committing agent code), `spec-keeper` (design Q&A). Slash commands: `/cf-docs`, `/wire-event`, `/new-agent`, `/pillar-check`, `/prereqs`, `/cron-utc`.

## Sources

### Primary (HIGH confidence)
- `docs/SPEC-CANON.md` — §0 pillars, §6.4 Wire contract, §11 Codex sections (authoritative).
- `docs/13-build-plan.md` — §1 prereqs/setup acceptance, §2 Phase 0 T0–T15 with per-task acceptance, §5 cross-cutting practices (testing/CI/security invariants).
- `docs/agents/atlas.md`, `docs/agents/steward.md` — orchestrator + sole-writer contracts.
- `CLAUDE.md` — pins, canonical strings, gotchas (project-authoritative).
- `.planning/phases/00-spine/00-CONTEXT.md` — locked decisions D-01…D-11.
- `.planning/REQUIREMENTS.md` — SPINE-01…05.
- npm registry (`npm view`, 2026-06-04) — all version pins re-verified current.
- Cloudflare docs (developers.cloudflare.com) — Queues consumer API + config keys + 128KB cap; Workflows API + `create()` duplicate-id-throws + `NonRetryableError` module; verified current.
- github.com/cloudflare/workers-oauth-provider — OAuthProvider 0.7.2 API surface + `OAUTH_KV` requirement (released 2026-06-04).

### Secondary (MEDIUM confidence)
- Obsidian Local REST API plugin docs (coddingtonbear.github.io / GitHub) — v3 PATCH frontmatter API; v2 sunset at 4.0.
- slopcheck 0.6.1 — package legitimacy (run against `--ecosystem npm`).

### Tertiary (LOW confidence)
- None relied upon for any prescriptive claim.

## Metadata

**Confidence breakdown:**
- Standard stack: **HIGH** — every pin re-verified against npm today (2026-06-04); matches CLAUDE.md and the build plan's own verification date.
- Architecture: **HIGH** — the design is fully specified in SPEC-CANON + build-plan T0–T15 with code; load-bearing platform APIs (Queues/Workflows/OAuthProvider/D1) re-verified against official docs.
- Pitfalls: **HIGH** — drawn from the build plan's own "be careful about" sections + one confirmed API drift (`retry_delay_secs`) caught via official docs.
- `agents` SDK class syntax: **LOW-MEDIUM** — version confirmed but exact class API not pulled via Context7 (MCP tools unavailable to this agent); delegated to `cloudflare-researcher` before T4/T5 (Open Question 1).

**Research date:** 2026-06-04
**Valid until:** 2026-06-18 (14 days — `agents` SDK ships ~weekly; re-verify pins before T0 install). Stable infra facts (Queues-on-Free, D1 atomicity, OAuth flow) valid 30 days.
