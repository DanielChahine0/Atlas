# 13 — Build Plan

**Purpose:** How to actually *build* Atlas from the completed design — the one-time prerequisites, a **task-level** breakdown of **Phase 0 (Spine)** and **Phase 1 (Core Loop / the MVP)** with acceptance criteria, build-sequencing for **Phases 2–5**, the cross-cutting engineering disciplines every agent inherits, and an execution sequence + success-metric instrumentation + a decision log that closes the open questions across the rest of the docs. The *what* and the *architecture* already live in the other docs; this is the *how*.

> **Grounding:** every Cloudflare / MCP / Google API claim below was checked against current (2026) official docs (Workers, Durable Objects, Queues, Workflows, D1/KV/R2, the Agents SDK + remote MCP, the Workers OAuth Provider, AI Gateway, Gmail/Calendar, and the Obsidian Local REST API). SDK versions, config keys, and flags are pinned where they matter — verify the pins against the live docs at build time, since these move.

## At a glance

| | |
|---|---|
| **Reads from** | [SPEC-CANON](SPEC-CANON.md) (authoritative), [roadmap](12-roadmap.md) (phase order + verdict), [architecture](02-architecture.md), [scheduling](03-scheduling.md), [hosting](06-hosting-cloudflare-mcp.md), [security](11-security-privacy.md) |
| **MVP** | **M0 + M1** — Phase 0 Spine **plus** Phase 1 morning chain (**Filer → Herald → Forge → Sundial → Compass**) + the **Steward** dashboard |
| **Stack** | TypeScript · Cloudflare Workers/Durable Objects/Queues/Workflows/Cron · D1/KV/R2 · Agents SDK remote MCP · Workers OAuth Provider · Claude via AI Gateway · local macOS daemon (Echo/Quill + Obsidian bridge) |
| **Build order** | Phase 0 Spine → Phase 1 Core loop (MVP) → Phase 2 Weekly value → Phase 3 Capture (local) → Phase 4 Outward (gated) → Phase 5 Meta/polish |
| **Hard prerequisite** | **Cloudflare Workers _Paid_ plan** — Queues (the Wire), Workflows, and KV-backed DOs require it |
| **Non-negotiables carried from day 0** | one writer per resource · suggest-don't-destroy (draft + ask) · idempotent + observable · secrets in Secrets Store (never Vault/Codex) · never surface 2FA codes / reset links |
| **Sections** | §1 Prerequisites · §2 Phase 0 (task-level) · §3 Phase 1 / MVP (task-level) · §4 Phases 2–5 (sequencing) · §5 Cross-cutting practices · §6 Execution sequence, metrics & decision log · §7 Owner inputs still needed |

> **Doc hygiene (resolved 2026-06-04):** repointed the dashboard links in `docs/01-agent-roster.md`, `docs/07-source-of-truth-codex.md`, and `docs/agents/steward.md` — they referenced non-existent `06-vault-dashboard.md` / `05-dashboard-vault.md`; the dashboard spec lives in `docs/05-dashboard.md`.

---

## 1. Prerequisites & Project Setup

> Everything in this section happens **before Phase 0 SPINE writes a line of agent logic.** It is the one-time foundation: accounts the owner must hold, the repo shape, the tooling baseline, and the conventions every Worker inherits. Get the conventions (one writer, secrets in Secrets Store, never-in-Vault/Codex) right here and the 16 agents inherit them for free.

### 1. Accounts & prerequisites — verify BEFORE Phase 0

This is a hard gate. Each item below is **required** for the spine; Atlas's spine uses Queues + Durable Objects + Workflows, all of which decide whether you can even deploy. Tick every box, then start Phase 0.

| # | Prerequisite | Why Atlas needs it | Verify with |
|---|---|---|---|
| 1 | **Cloudflare account on the PAID Workers plan** | **Queues (the Wire) require Paid — full stop.** Workflows (the durable morning chain) and KV-backed Durable Objects are Paid features; SQLite-backed DOs now run on Free but the moment the Wire exists you are Paid anyway. Per-Worker cron cap is also higher on Paid (Atlas has ~10 schedule lines). Treat Workers Paid as a Phase-0 line item. | Dashboard → Workers & Pages → Plans shows **Workers Paid**. |
| 2 | **Google Cloud project + OAuth consent screen + OAuth client** | Outbound OAuth2 to Gmail/Calendar/Drive/Sheets. **Also enable Gmail API, Calendar API, and Pub/Sub API**, create the `gmail-filer` Pub/Sub topic, and grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub **Publisher** role (Filer's continuous push needs this — easy to miss). OAuth client type = **Web application** (confidential client; PKCE does NOT remove the need for a `client_secret`). | `gcloud projects describe`; consent screen published; client ID + secret downloaded. |
| 3 | **GitHub account that can create a GitHub App** | GitHub MCP (Phase 2/4) uses a **GitHub App, not a PAT** — scoped, revocable, per-repo installation tokens. Need rights to register an App under the owner account or org. | github.com/settings/apps → **New GitHub App** is available. |
| 4 | **Obsidian vault + Local REST API plugin (the bridge)** | The Vault is the only local dependency in Phase 0. Install **Local REST API** (coddingtonbear) — it serves self-signed HTTPS on `127.0.0.1:27124` with a bearer key. **Adopt plugin v3.0+** (the v3 PATCH API is what Steward's increment/upsert/append map onto; v2 PATCH is deprecated, removed at v4.0). Obsidian must be **running** for any write to land — it is an in-app HTTP server, not a headless service. | Settings → Community plugins → Local REST API shows an API key; `curl -k https://127.0.0.1:27124/` returns 200. |
| 5 | **Anthropic API key** | Claude via **AI Gateway** is the model spine. Every agent call routes through the dedicated Anthropic Gateway endpoint; no agent talks to `api.anthropic.com` directly. | Key issued at console.anthropic.com; a test `messages.create` succeeds. |
| 6 | **Cloudflare AI Gateway(s) + Authenticated-Gateway token** | Spend caps, caching, and observability are **per-gateway dashboard config**, not `wrangler.toml`. Provision two gateways up front: `atlas-reasoning` (Opus agents) and `atlas-highvolume` (Filer/Headhunter Haiku). Enable **Authenticated Gateway** and mint a `CF_AIG_TOKEN` so a leaked Anthropic key alone can't bill you. | AI → AI Gateway → both gateways exist; Settings → Authenticated Gateway token minted. |
| 7 | **Node LTS + package manager + Wrangler CLI (logged in)** | Build/deploy toolchain. Wrangler is the deploy + provisioning CLI for every primitive below. | `node -v` (LTS), `pnpm -v`, `npx wrangler whoami` shows the account. |

```bash
# One-time: confirm the toolchain and log in to Cloudflare
node -v                       # expect an LTS (e.g. v22.x)
corepack enable && corepack prepare pnpm@latest --activate
npm i -g wrangler@latest      # or use npx wrangler everywhere
npx wrangler login            # OAuth into the PAID account
npx wrangler whoami           # prints the account id you'll paste into AIG_ACCOUNT_ID
```

> **Decision the owner makes here:** the **cron timezone policy.** Cloudflare Cron Triggers run in **UTC only — no per-Worker timezone, no DST.** Atlas's §10 times are owner-local (America/Toronto). Pick **UTC-translation-with-DST-edits** (re-derive cron expressions at each EST↔EDT boundary) or **pin a fixed offset** and accept ≤1h drift. This resolves the open question flagged in `docs/03-scheduling.md §6` and `docs/06 §12`. Document the chosen policy and the EST/EDT translation table next to the cron config.

---

### 2. Repo & code layout — monorepo of Workers with shared packages

**Decision: a single pnpm monorepo**, one Worker per agent (or small grouping), with shared `packages/`. Each Worker is independently deployable, but the spine primitives (Wire event shape, the `claudeFor`/`modelFor` factory, the D1 schema, the Steward write-intent encoder) live in shared packages so all 16 agents consume one canonical implementation.

**Why monorepo, one Worker per agent:**

- **Isolation matches the pillars.** One Worker = one deploy = one set of bindings. Filer's Worker physically holds only `gmail.modify` scope; Steward's Worker is the *only* one with a `[[queues.consumers]]` block on `atlas-wire`. Least-privilege is enforced by which `wrangler` config a Worker ships with, not by prose.
- **Cron-cap headroom.** Splitting agents across Workers keeps each under the per-Worker cron limit; the morning chain collapses to ONE cron on the Atlas Worker that triggers a Workflow, so this isn't strictly forced — but per-agent Workers keep options open.
- **Shared code stays DRY and canonical.** The Wire event shape, idempotency ledger SQL, and the model factory are written once in `packages/` and imported everywhere — no agent re-implements the contract.

```
atlas/
├─ pnpm-workspace.yaml              # workspaces: ["apps/*", "packages/*"]
├─ package.json                     # root scripts: build, test, lint, typecheck
├─ tsconfig.base.json               # strict TS, shared compilerOptions
├─ vitest.workspace.ts              # aggregates every app/package vitest config
├─ docs/                            # the design + this build plan (13-build-plan.md)
├─ migrations/                      # D1 migrations (0001_init_core.sql, ...) — shared DB
├─ packages/
│  ├─ wire/                         # WireEvent type + producer helper (env.WIRE.send)
│  ├─ model/                        # claudeFor(agent,env) + modelFor(agent,env) factory
│  ├─ steward-core/                 # op→D1 + op→Local-REST-API mapping, idempotency ledger
│  ├─ codex/                        # Codex reader (read-only; drive.readonly)
│  └─ shared/                       # Env types, Flagger emit, run-log helpers, zod schemas
├─ apps/
│  ├─ atlas/                        # #0 orchestrator: scheduled() dispatcher + MorningChain Workflow + OAuthProvider front door + AtlasCoordinator DO
│  ├─ steward/                      # #11 sole Wire consumer + StewardWriter DO (Vault write lock)
│  ├─ filer/                        # #2 gmail.modify ONLY; watch renewal + sweep crons
│  ├─ herald/  forge/  sundial/  compass/      # Phase 1 morning-chain agents
│  ├─ scout/   headhunter/  flagger/           # Phase 2
│  ├─ echo/    archivist/                      # Phase 3 (Echo = EchoSession DO half)
│  ├─ usher/   envoy/                          # Phase 4 (gated)
│  ├─ switchboard/  librarian/                 # Phase 5
│  ├─ mcp-google/                   # remote MCP server (createMcpHandler, stateless)
│  ├─ mcp-github/                   # remote MCP server (McpAgent + OAuthProvider, stateful)
│  └─ mcp-obsidian-bridge/          # write-intent outbox shape (cloud side of the local bridge)
└─ daemon/                          # LOCAL macOS launchd daemon: Echo + Quill + Obsidian bridge drainer (outbound-only)
```

> `daemon/` is intentionally **outside** `apps/` — it is not a Worker. It is the macOS launchd process that authenticates **outbound** to the cloud and pulls work (no inbound port to the laptop). It is built in Phase 3, but its outbound-auth + outbox-drain plumbing is stood up in Phase 0 alongside Steward so the Obsidian bridge works from day one.

---

### 3. Tooling baseline

| Concern | Choice | Notes |
|---|---|---|
| **Language** | TypeScript, `strict: true` | All Workers + the daemon. Use `satisfies ExportedHandler<Env>` (modern) on every default export, not the older `: ExportedHandler<Env>` annotation. |
| **Package manager** | **pnpm** workspaces | Fast, content-addressed, first-class monorepo support. `corepack` pins the version. |
| **Test framework** | **Vitest + `@cloudflare/vitest-pool-workers`** | Runs tests inside the real `workerd`/Miniflare runtime so DO storage, Queues, and `scheduled()` behave like production. **Note `workerd` forces `TZ=UTC`** — same as `wrangler dev` — so `new Date()` is UTC in tests; derive owner-local time explicitly via `Intl` with a fixed IANA zone. |
| **Linting / format** | ESLint (typescript-eslint) + Prettier | One root config; `pnpm lint` / `pnpm format` at the root run across all workspaces. |
| **Wrangler config** | **`wrangler.jsonc`** (the C3 scaffold default) | JSONC is what `npm create cloudflare@latest` writes today; `.toml` is fully equivalent. Pick JSONC for editor autocomplete via `$schema`. One `wrangler.jsonc` **per app** (per Worker). |
| **Type generation** | `wrangler types` | Generates the `Env` interface from each Worker's bindings; commit the output or generate in CI. |

Install the shared dev toolchain at the root:

```bash
# scaffold the first Worker (C3 picks wrangler.jsonc + TS by default)
npm create cloudflare@latest apps/atlas -- --type=hello-world --ts

# shared deps (root): test + lint + the SDKs Phase 0 needs
pnpm add -D -w vitest @cloudflare/vitest-pool-workers wrangler typescript \
  eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser prettier
pnpm add -w @anthropic-ai/sdk agents @modelcontextprotocol/sdk@1.29.0 \
  @cloudflare/workers-oauth-provider zod jose
```

> **SDK version pins (verify before copying any tutorial):** `agents@0.14.x` (verified current 2026-06-04, bumped from 0.13.x — it ships ~weekly; `0.14.x` transitively pins the MCP SDK at `1.29.0`), `@modelcontextprotocol/sdk@1.29.0` (NOT the v2 alpha — `server.tool()` and `registerTool()` both work in 1.29.0; v2 split packages are not released), `@cloudflare/workers-oauth-provider@0.7.x`, `zod` in range `^3.25 || ^4.0`. The `agents` package **requires `compatibility_flags: ["nodejs_compat"]`** — omitting it is a runtime failure.

A minimal `wrangler.jsonc` skeleton every spine Worker starts from (Atlas shown — it carries the most bindings):

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "atlas",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-25",          // >= 2026-04-07 enables web_socket_auto_reply_to_close (Echo)
  "compatibility_flags": ["nodejs_compat"],    // REQUIRED by the agents SDK
  "observability": { "enabled": true },

  // ALL crons are UTC. Owner-local (America/Toronto) shown for EST (UTC-5);
  // re-derive (subtract 4) when EDT is in effect — Cron Triggers have NO DST.
  "triggers": {
    "crons": [
      "45 12 * * *",   // 07:45 local  Filer sweep -> kicks the MorningChain Workflow
      "0  14 * * *",   // 09:00 local  Headhunter daily-light
      "0  14 * * 1",   // Mon 09:00    Headhunter full
      "0  21 * * 5",   // Fri 16:00    Scout weekly + Herald weekly (Promise.all in one case)
      "30 21 * * 5",   // Fri 16:30    weekly-review build (Steward compiles)
      "0  2  * * *"    // 21:00 local  Compass preview (next UTC day)
    ]
  },

  "ai": { "binding": "AI" },                   // Workers AI + env.AI.gateway() routing

  "durable_objects": { "bindings": [
    { "name": "ATLAS",        "class_name": "AtlasCoordinator" },
    { "name": "MORNING_CHAIN_DO", "class_name": "AtlasCoordinator" }
  ]},
  "workflows": [
    { "name": "atlas-morning-chain", "binding": "MORNING_CHAIN", "class_name": "MorningChain" }
  ],
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AtlasCoordinator"] }  // SQLite backend, NOT new_classes
  ],

  "queues": { "producers": [ { "binding": "WIRE", "queue": "atlas-wire" } ] },

  "d1_databases": [
    { "binding": "DB", "database_name": "atlas-db", "database_id": "<from wrangler d1 create>",
      "migrations_dir": "migrations" }
  ],
  "kv_namespaces": [
    { "binding": "CONFIG",    "id": "<from wrangler kv namespace create CONFIG>" },
    { "binding": "OAUTH_KV",  "id": "<required by workers-oauth-provider>" }
  ],
  "r2_buckets": [
    { "binding": "BLOBS", "bucket_name": "atlas-blobs" }
  ],

  // Per-agent model tiering lives in config, not code (overridable from KV at runtime)
  "vars": {
    "AIG_ACCOUNT_ID":  "<account-id>",
    "AIG_GATEWAY_ID":  "atlas-reasoning",
    "MODEL_ATLAS":     "claude-opus-4-8",
    "MODEL_COMPASS":   "claude-opus-4-8",
    "MODEL_ARCHIVIST": "claude-opus-4-8",
    "MODEL_FORGE":     "claude-sonnet-4-6",
    "MODEL_HERALD":    "claude-sonnet-4-6",
    "MODEL_SCOUT":     "claude-sonnet-4-6",
    "MODEL_FILER":     "claude-haiku-4-5",
    "MODEL_HEADHUNTER":"claude-haiku-4-5"
  }
}
```

The Steward Worker is the only one that carries a **consumer** block (it must be its own Worker for that reason):

```jsonc
{
  "name": "atlas-steward",
  "main": "src/steward.ts",
  "compatibility_date": "2026-04-25",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [
    { "name": "STEWARD_LOCK", "class_name": "StewardWriter" }   // env.STEWARD_LOCK.getByName("vault") — the single Vault write lock
  ]},
  "migrations": [ { "tag": "v1", "new_sqlite_classes": ["StewardWriter"] } ],
  "queues": {
    "consumers": [ {
      "queue": "atlas-wire",
      "max_concurrency": 1,                 // PIN to one invocation -> serialized writes (Pillar 1)
      "max_batch_size": 10,
      "max_batch_timeout": 10,              // coalesce the Fri 16:00 Scout+Herald burst
      "max_retries": 5,
      "retry_delay_secs": 30,
      "dead_letter_queue": "atlas-wire-dlq" // REQUIRED — else exhausted msgs drop silently
    } ]
  }
}
```

Provision the spine resources once (these IDs get pasted into the configs above):

```bash
# The Wire + its mandatory DLQ
npx wrangler queues create atlas-wire
npx wrangler queues create atlas-wire-dlq

# D1 (system-of-record) + KV (config + OAuth provider store) + R2 (blobs)
npx wrangler d1 create atlas-db
npx wrangler kv namespace create CONFIG
npx wrangler kv namespace create OAUTH_KV          # required by @cloudflare/workers-oauth-provider
npx wrangler r2 bucket create atlas-blobs

# Migrations (note: wrangler v3.60+ uses 'kv namespace', NOT the deprecated 'kv:namespace')
npx wrangler d1 migrations create atlas-db init_core
npx wrangler d1 migrations apply atlas-db --local      # dev
npx wrangler d1 migrations apply atlas-db --remote     # prod

# Local dev with cron simulation; in another shell fire one trigger (spaces -> +):
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=45+12+*+*+*"   # Filer sweep -> MorningChain
```

---

### 4. Conventions (binding names, secrets, never-in-Vault/Codex)

These are non-negotiable and are inherited by every agent. They are the Phase-0 expression of the 5 pillars.

**Canonical binding names** (use these exact strings across all Workers):

| Binding | Primitive | Holds | Rule |
|---|---|---|---|
| `WIRE` | Queue producer | `atlas-wire` events | Every agent except Steward is a producer. Steward is the **only** consumer. |
| `DB` | D1 | tasks/jobs/events/run-log/audit/**idempotency keys + counters** | **All counters and idempotency keys live in D1, never KV** (KV is 1-write/s/key + ≤60s propagation — wrong for counters). |
| `CONFIG` | KV | model tier overrides, feature flags, gate toggles, Filer label→color map | Read-mostly config only. **Never secrets, never counters.** |
| `BLOBS` | R2 | Echo audio (`audio/raw/`), transcripts (`transcripts/`), exports (`exports/`) | Prefix-split + per-prefix lifecycle: `audio/raw/` expires in **7 days**; transcripts/exports persist. |
| `AI` | Workers AI | gateway routing | All Claude calls go through `claudeFor(agent,env)` → AI Gateway. No direct `api.anthropic.com`. |
| `STEWARD_LOCK` | Durable Object | the single Vault write lock | Addressed as `env.STEWARD_LOCK.getByName("vault")` — **one name = one instance = the lock**. Any other name splits the writer and breaks Pillar 1. |
| `OAUTH_KV` | KV | OAuth grants/tokens/clients | Required backing store for the inbound Workers OAuth Provider. |

**Secrets — via Secrets Store, never `[vars]`, never the Vault/Codex:**

- Long-lived provider credentials (`google-oauth-client-secret`, `google-refresh-token`, `github-app-private-key`, `ANTHROPIC_API_KEY`, `CF_AIG_TOKEN`, the Obsidian + bridge tokens) live in **Cloudflare Secrets Store**, bound per-Worker and read **async** (`await env.X.get()`).
- Open-beta limit: **one Secrets Store per account** — plan binding names, not multiple stores. Production (`--remote`) secrets are **not** readable in local dev; create non-remote copies for `wrangler dev`.
- `[vars]` is **plaintext, visible in the dashboard** — model tiers and gateway IDs go there; **tokens never do.**

```bash
# Provision the single account store, then the spine secrets
npx wrangler secrets-store store create atlas --remote        # prints <atlas-store-id>; reuse everywhere
npx wrangler secrets-store secret create <atlas-store-id> --name google-refresh-token       --scopes workers --remote
npx wrangler secrets-store secret create <atlas-store-id> --name google-oauth-client-secret --scopes workers --remote
npx wrangler secrets-store secret create <atlas-store-id> --name github-app-private-key      --scopes workers --remote
# Higher-churn / per-Worker values may use wrangler secret put (encrypted, NOT in wrangler.jsonc):
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CF_AIG_TOKEN
```

Bound in config like:

```jsonc
"secrets_store_secrets": [
  { "binding": "GOOGLE_CLIENT_SECRET",  "store_id": "<atlas-store-id>", "secret_name": "google-oauth-client-secret" },
  { "binding": "GOOGLE_REFRESH_TOKEN",  "store_id": "<atlas-store-id>", "secret_name": "google-refresh-token" },
  { "binding": "GH_APP_PRIVATE_KEY",    "store_id": "<atlas-store-id>", "secret_name": "github-app-private-key" }
]
```

**The never-in-Vault / never-in-Codex rule (Pillars 4 & 5):**

- **The Codex** (`codex.md`) holds personal *facts* for autofill (name, education, work, skills) — it is **read-only to agents** and contains **zero credentials**.
- **The Vault** is Steward-written dashboard state — **no secrets, no raw tokens, no 2FA codes, no reset links** ever land there. The Filer/Google-MCP security invariant (strip 2FA codes & reset-link bodies server-side) means they can't reach a digest, let alone the Vault.
- Every Wire event carries the exact canonical shape — copy verbatim:

  ```json
  { "agent": "...", "type": "...", "entity": "...",
    "op": "increment | upsert | append",
    "payload": { },
    "idempotencyKey": "..." }
  ```

  Counters move via `op:"increment"` keyed by `idempotencyKey`; Steward dedups in the D1 ledger (`INSERT OR IGNORE` → `changes()===0` means replay → skip) so at-least-once Queue redelivery can't double-count.

**Naming conventions:** Worker/app dir = lowercase agent codename (`filer`, `sundial`); DO class = PascalCase role (`AtlasCoordinator`, `StewardWriter`, `EchoSession`); cron expressions carry an inline owner-local comment; the Wire `agent` field uses the **codename** (`"Forge"`, `"Filer"`); idempotency keys are stable and structured (`forge:task:2026-05-31:abc123`), never `crypto.randomUUID()` for scheduled work.

---

### Acceptance criteria — "setup is done" when

1. `npx wrangler whoami` shows a **Workers Paid** account, and `npx wrangler queues list` succeeds (proves Queues entitlement).
2. The monorepo builds: `pnpm -r build` and `pnpm -r typecheck` pass; `pnpm test` runs Vitest inside `workerd` with `TZ=UTC`.
3. `wrangler dev --test-scheduled` + `curl ".../__scheduled?cron=45+12+*+*+*"` reaches the Atlas dispatcher branch for the Filer sweep.
4. The chosen **cron timezone policy** is written into `docs/03-scheduling.md` with the EST/EDT UTC translation table.
5. `npx wrangler secrets-store secret list <atlas-store-id>` shows the three provider secrets; **none** appear in any `wrangler.jsonc` `[vars]` block or in the Vault/Codex.
6. A grep of the repo for the canonical Wire shape confirms `packages/wire` is the single definition imported by every agent app.

---

## 2. Phase 0 — Spine (task-level)

Phase 0 ships **zero user-visible features**. It stands up the substrate every later agent reuses: **Atlas** (orchestrator DO), the **Wire** (Cloudflare Queue), **Steward** (sole Vault writer DO + the single Wire consumer) implementing the §6.4 write contract, the idempotency-key store + run-log/audit (D1), **The Codex** (read-only facts), Google + GitHub OAuth round-trips (Workers OAuth Provider inbound; provider tokens in Secrets Store), and the Obsidian bridge (Steward → Vault, outbound-only). The discipline to nail here is Steward's **serialization + idempotency** — retrofitting it after counters exist means reconciling double-counts.

> Resist the urge to skip the idempotency/serialization work to "see something." That work *is* the spine.

### Account / plan prerequisites

| Need | Why | Status to confirm before T1 |
|---|---|---|
| **Workers Paid plan** | Queues (the Wire) and Workflows require paid; KV-backed DOs require paid | Required for Phase 0 |
| **SQLite-backed DOs on Free** | `new_sqlite_classes` DOs (Atlas/Steward) run on Free; gives SQL + KV + alarms in one backend | OK on Free for dev |
| **GCP project** | Gmail + Calendar + Pub/Sub APIs enabled; OAuth consent screen | Phase 0 setup |
| **GitHub App** | installation tokens (NOT a PAT), RS256 private key | Phase 0 setup |
| **Secrets Store (one per account, open beta)** | long-lived provider creds (Google refresh token, GitHub App key) | Provision once, reuse `store_id` |

### Canonical names used below

| Logical thing | Concrete primitive | Binding / id |
|---|---|---|
| Atlas orchestrator | Durable Object (SQLite) | `env.ATLAS.getByName("root")`, class `AtlasCoordinator` |
| Steward write lock | Durable Object (SQLite) | `env.STEWARD_LOCK.getByName("vault")`, class `StewardWriter` |
| The Wire | Cloudflare Queue | `atlas-wire` (producer binding `WIRE`) + DLQ `atlas-wire-dlq` |
| System-of-record | D1 | `env.DB` → `atlas-db` |
| Config / flags | KV | `env.CONFIG` |
| OAuth grant store | KV | `env.OAUTH_KV` (required by the OAuth Provider) |
| Blobs / exports | R2 | `env.BLOBS` → `atlas-blobs` |
| Vault outbox | D1 table | `vault_outbox` (drained by the local bridge) |

---

### Ordered task list

#### T0 — Cloudflare project + Env scaffold

- **Deliverable:** the `atlas` Worker scaffolded (C3, TypeScript), deployable, with the full `Env` interface stubbed and `compatibility_date >= 2026-04-07` (enables `web_socket_auto_reply_to_close` for later Echo; also sets `nodejs_compat`).
- **Files / primitives:** `wrangler.jsonc`, `src/index.ts`, `package.json`.
- **Dependencies:** none (greenfield).
- **Commands:**
  ```bash
  npm create cloudflare@latest atlas -- --type=hello-world --ts
  npm i wrangler@latest
  ```
  ```jsonc
  // wrangler.jsonc
  {
    "$schema": "./node_modules/wrangler/config-schema.json",
    "name": "atlas",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"]
  }
  ```
- **Acceptance:** `npx wrangler deploy` succeeds and the Worker responds; `npx wrangler dev` runs locally with `TZ=UTC` (verify `new Date()` reads UTC — do NOT assume laptop-local time).

---

#### T1 — D1 system-of-record + migration `0001_init_core`

- **Deliverable:** `atlas-db` provisioned with the idempotency ledger, counters, run-log, and audit tables. D1 is the **authoritative** store for all counters/keys (KV is never used for counters or idempotency — 1 write/s/key + 60s lag rule out KV).
- **Files / primitives:** `wrangler.jsonc` (`d1_databases` binding `DB`, `migrations_dir = "migrations"`), `migrations/0001_init_core.sql`.
- **Dependencies:** T0.
- **Commands:**
  ```bash
  npx wrangler d1 create atlas-db
  npx wrangler d1 migrations create atlas-db init_core
  npx wrangler d1 migrations apply atlas-db --local      # dev
  npx wrangler d1 migrations apply atlas-db --remote     # prod
  ```
  ```sql
  -- migrations/0001_init_core.sql
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key        TEXT PRIMARY KEY,            -- Wire event idempotencyKey
    agent      TEXT NOT NULL,
    type       TEXT, entity TEXT, op TEXT,
    applied_at INTEGER NOT NULL             -- epoch ms
  );
  CREATE TABLE IF NOT EXISTS counters (
    entity TEXT PRIMARY KEY,                -- e.g. 'events-attended','jobs-applied'
    value  INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS run_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT, type TEXT, entity TEXT, op TEXT,
    rows_read INTEGER, rows_written INTEGER, result TEXT,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT, action TEXT, detail TEXT, ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vault_outbox (
    idem    TEXT PRIMARY KEY,               -- one intent per idempotencyKey
    path    TEXT NOT NULL, method TEXT NOT NULL,
    headers TEXT NOT NULL, body TEXT,
    state   TEXT NOT NULL DEFAULT 'pending',-- pending|done|failed
    ts      INTEGER NOT NULL
  );
  ```
- **Acceptance:** `wrangler d1 migrations apply --remote` records the migration in the auto-managed `d1_migrations` table; `SELECT * FROM counters` returns empty; positional `?` binding works (D1 supports anonymous `?` only — no named params).

---

#### T2 — KV (config/flags) + R2 (blobs) bindings

- **Deliverable:** `CONFIG` KV namespace (model-tier map, feature flags, label→color map, counter/view registry) and `atlas-blobs` R2 bucket with its prefix-scoped lifecycle rules pre-declared (audio retention is exercised in Phase 3, but the bucket + rules belong to the spine).
- **Files / primitives:** `wrangler.jsonc` (`kv_namespaces` binding `CONFIG`; `r2_buckets` binding `BLOBS`).
- **Dependencies:** T0.
- **Commands:**
  ```bash
  npx wrangler kv namespace create CONFIG          # space form, not the deprecated kv:namespace
  npx wrangler r2 bucket create atlas-blobs
  npx wrangler r2 bucket lifecycle add atlas-blobs --name expire-raw-audio --prefix "audio/raw/" --expire-days 7
  npx wrangler r2 bucket lifecycle add atlas-blobs --name abort-stuck-uploads --abort-multipart-days 1
  ```
- **Acceptance:** `CONFIG.get("flags",{type:"json"})` round-trips a written object; `wrangler r2 bucket lifecycle list atlas-blobs` shows the `audio/raw/` expiry (the §12 privacy boundary made mechanical — `transcripts/` and `exports/` prefixes carry no expiry).

---

#### T3 — The Wire (Queue) + DLQ + producer binding

- **Deliverable:** `atlas-wire` queue and `atlas-wire-dlq` dead-letter queue created; the producer binding `WIRE` available to every feeder Worker. **No consumer is attached yet** — Steward (T5) is the sole consumer.
- **Files / primitives:** `wrangler.jsonc` (`queues.producers` binding `WIRE`, queue `atlas-wire`).
- **Dependencies:** T0 (and Workers Paid).
- **Commands:**
  ```bash
  npx wrangler queues create atlas-wire
  npx wrangler queues create atlas-wire-dlq        # REQUIRED: else exhausted msgs drop silently
  ```
  ```jsonc
  "queues": { "producers": [{ "binding": "WIRE", "queue": "atlas-wire" }] }
  ```
- **Wire event shape (copy exactly):**
  ```jsonc
  { "agent": "...", "type": "...", "entity": "...",
    "op": "increment | upsert | append", "payload": {}, "idempotencyKey": "..." }
  ```
- **Acceptance:** a test Worker calls `env.WIRE.send({...})` with the canonical shape (json is the default contentType) and the message appears in the queue dashboard; sending a malformed/oversized (>128 KB) message is rejected/visible.

---

#### T4 — Atlas orchestrator DO (`AtlasCoordinator`) + heartbeat self-monitor

- **Deliverable:** the `AtlasCoordinator` SQLite-backed DO addressed as a single named singleton, holding per-agent coordination state and a recurring `alarm()` heartbeat. Atlas does **no domain work** — it schedules, routes, sequences, supervises. The morning chain's cron lines and the Workflow are wired in **Phase 1**, not here; this task only stands up the coordinator + heartbeat.
- **Files / primitives:** `src/coordinator.ts` (class `AtlasCoordinator extends DurableObject<Env>`), `wrangler.jsonc` (`durable_objects.bindings` → `ATLAS`, migration `new_sqlite_classes`).
- **Dependencies:** T0, T1.
- **Config:**
  ```jsonc
  "durable_objects": { "bindings": [{ "name": "ATLAS", "class_name": "AtlasCoordinator" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["AtlasCoordinator", "StewardWriter"] }]
  ```
  ```typescript
  export class AtlasCoordinator extends DurableObject<Env> {
    async beat() { await this.ctx.storage.put("lastBeat", Date.now()); }
    async startHeartbeat() {
      if ((await this.ctx.storage.getAlarm()) == null)
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
    async alarm() {
      const last = (await this.ctx.storage.get<number>("lastBeat")) ?? 0;
      if (Date.now() - last > 5 * 60_000) {
        // emit P1 Critical to Flagger via the Wire: orchestrator heartbeat stale (atlas.md)
      }
      await this.ctx.storage.setAlarm(Date.now() + 60_000);  // reschedule inside alarm()
    }
  }
  ```
- **Acceptance:** `env.ATLAS.getByName("root")` returns a stable instance; `startHeartbeat()` sets exactly one alarm; if `lastBeat` is older than 5 min the `alarm()` path emits the P1-stale Wire event (verified by a forced-stale unit test). One alarm per DO (setting a new time overwrites) — confirmed by inspection, not assumed.

---

#### T5 — Steward DO (`StewardWriter`): serialized single writer + idempotency ledger

- **Deliverable:** `StewardWriter` SQLite DO addressed **only** as `env.STEWARD_LOCK.getByName("vault")` (one logical singleton = the lock that enforces Pillar 1). Implements the §6.4 per-event flow: validate → acquire lock → dedup → apply op → run-log → ack. The dedup-check + counter-bump + ledger-insert is one atomic critical section.
- **Files / primitives:** `src/steward.ts` (`StewardWriter`), reuses migration `v1` from T4.
- **Dependencies:** T1 (D1 schema), T4 (shared migration tag).
- **Critical-section + lock:**
  ```typescript
  export class StewardWriter extends DurableObject<Env> {
    async apply(e: WireEvent): Promise<{ applied: boolean }> {
      return this.ctx.blockConcurrencyWhile(async () => {     // serialize this DO
        const ins = await this.env.DB.batch([                  // batch() = one atomic txn
          this.env.DB.prepare(
            "INSERT OR IGNORE INTO idempotency_keys(key,agent,type,op,entity,applied_at) VALUES (?,?,?,?,?,?)"
          ).bind(e.idempotencyKey, e.agent, e.type, e.op, e.entity, Date.now()),
          // increment math is ABSOLUTE in D1; the Vault PATCH later writes that absolute value
          this.env.DB.prepare(
            `INSERT INTO counters(entity,value) VALUES(?, ?)
             ON CONFLICT(entity) DO UPDATE SET value = value + ?
             WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ?)`
          ).bind(e.payload.counter ?? e.entity, e.payload.delta ?? 1, e.payload.delta ?? 1, e.idempotencyKey),
        ]);
        if (ins[0].meta.changes === 0) return { applied: false }; // REPLAY → no double-count
        // ... upsert/append branches enqueue a vault_outbox intent here ...
        await this.env.DB.prepare(
          "INSERT INTO run_log(agent,type,entity,op,result,ts) VALUES(?,?,?,?, 'ok', ?)"
        ).bind(e.agent, e.type, e.entity, e.op, Date.now()).run();
        return { applied: true };
      });
    }
  }
  ```
- **Acceptance:** the canonical Steward example run holds — `apply()` an `events-attended` increment twice with the SAME `idempotencyKey` leaves the counter at the same value (`meta.changes === 0` on replay); a malformed event (missing `op`/`entity`/`idempotencyKey`) is rejected with no write and surfaces a Flagger P3 path. Two `getByName("vault")` calls resolve to one DO (never split the singleton).

---

#### T6 — The single Wire consumer (Steward) — `max_concurrency=1`, explicit ack/retry

- **Deliverable:** the `queue()` handler that is Steward's **only** entry point (event-driven, never cron'd), pinned to one concurrent invocation and processing each batch **serially** so two events in the same batch can't race the Vault either. Maps ack/retry to Steward's failure table.
- **Files / primitives:** `src/steward-consumer.ts` (`export default { queue }`), `wrangler.jsonc` (`queues.consumers`).
- **Dependencies:** T3 (Wire + DLQ), T5 (the DO).
- **Commands / config:**
  ```bash
  npx wrangler queues consumer add atlas-wire atlas-steward \
    --max-concurrency=1 --dead-letter-queue=atlas-wire-dlq \
    --message-retries=5 --retry-delay-secs=30 --batch-size=10 --batch-timeout=10
  ```
  ```typescript
  export default {
    async queue(batch: MessageBatch<WireEvent>, env: Env): Promise<void> {
      const steward = env.STEWARD_LOCK.getByName("vault");   // single global writer
      for (const msg of batch.messages) {                    // SERIAL, not Promise.all
        const e = msg.body;
        if (!e?.agent || !e?.op || !e?.entity || !e?.idempotencyKey) {
          await flag(env, "P3", "malformed wire event", e); msg.ack(); continue;  // don't poison-loop
        }
        try { await steward.apply(e); msg.ack(); }           // replay & success both = done
        catch (err) {
          if (msg.attempts >= 4) await flag(env, "P2", "steward write failing", { e, err });
          msg.retry({ delaySeconds: 60 });                   // redelivery is safe (ledger dedup)
        }
      }
    },
  } satisfies ExportedHandler<Env>;
  ```
- **Acceptance:** replaying the same Wire message twice leaves the counter unchanged; a malformed event acks + raises P3 (no infinite redelivery); a forced `apply()` throw retries with backoff and, after exhausting `--message-retries`, lands in `atlas-wire-dlq`. 50 concurrent Wire events (Fri-16:00 fan-in simulation) produce zero races and final counters equal D1 authoritative totals.

---

#### T7 — DLQ consumer → Flagger

- **Deliverable:** a tiny consumer on `atlas-wire-dlq` that turns a dead Wire event into a Flagger incident instead of silent loss (Pillar 5: every notable failure → Flagger). Flagger's full agent ships in Phase 2; in Phase 0 this is a minimal "dead-letter → P2/P3 incident" sink.
- **Files / primitives:** `src/dlq-consumer.ts`, `wrangler.jsonc` (`queues.consumers` for `atlas-wire-dlq`).
- **Dependencies:** T3, T6.
- **Acceptance:** a message that exhausts retries on `atlas-wire` arrives on `atlas-wire-dlq` and produces an audit row + a P2/P3 incident record; the DLQ never silently buffers unconsumed.

---

#### T8 — The Codex (`codex.md`) + read-only read flow

- **Deliverable:** `codex.md` exists with the §11 sections (identity, education, work, skills, projects, bios, socials) and is **read-only to agents** except the explicit "update my profile" flow. Codex lives in Google Drive; agents read it via `drive.readonly`. It is a source of FACTS, never credentials.
- **Files / primitives:** `codex.md` (in Drive), `src/codex.ts` (read helper that fetches + caches the Codex text), CONFIG entry for the Drive file id.
- **Dependencies:** T2 (CONFIG), T9/T10 (Google `drive.readonly` scope).
- **Read flow + caching:** the Codex is stable across calls — agents pass it as a `system` `TextBlockParam` with `cache_control: { type: "ephemeral", ttl: "1h" }` (Anthropic prompt caching at 0.1x read) so reuse is cheap.
- **Acceptance:** a Worker reads the Codex via `drive.readonly` and gets all seven §11 sections; no agent has a write path to it (writes are 403 except the explicit update flow); the Codex contains no tokens/secrets (those live in Secrets Store).

---

#### T9 — Secrets Store provisioning (Google + GitHub creds)

- **Deliverable:** the single per-account Secrets Store created and seeded with `google-oauth-client-secret`, `google-refresh-token`, `github-app-private-key`; bound into the Worker as async-read bindings. **Never** in KV, the Vault, or the Codex.
- **Files / primitives:** `wrangler.jsonc` (`secrets_store_secrets` bindings).
- **Dependencies:** T0.
- **Commands / config:**
  ```bash
  npx wrangler secrets-store store create atlas --remote        # -> <atlas-store-id> (one per account, open beta)
  npx wrangler secrets-store secret create <atlas-store-id> --name google-oauth-client-secret --scopes workers --remote
  npx wrangler secrets-store secret create <atlas-store-id> --name google-refresh-token        --scopes workers --remote
  npx wrangler secrets-store secret create <atlas-store-id> --name github-app-private-key       --scopes workers --remote
  ```
  ```jsonc
  "secrets_store_secrets": [
    { "binding": "GOOGLE_CLIENT_SECRET",  "store_id": "<atlas-store-id>", "secret_name": "google-oauth-client-secret" },
    { "binding": "GOOGLE_REFRESH_TOKEN",  "store_id": "<atlas-store-id>", "secret_name": "google-refresh-token" },
    { "binding": "GH_APP_PRIVATE_KEY",    "store_id": "<atlas-store-id>", "secret_name": "github-app-private-key" }
  ]
  ```
- **Acceptance:** `await env.GOOGLE_CLIENT_SECRET.get()` returns the value in a deployed Worker (note: access is **async** — forgetting `await` yields the binding object, not the string; `--remote` secrets are not readable in `wrangler dev`, so create non-remote copies for local).

---

#### T10 — Inbound OAuth: Workers OAuth Provider (the front door)

- **Deliverable:** Atlas hosts `new OAuthProvider({...})` as its default export. The owner authorizes **once**; the local daemon (Echo/Quill, Phase 3) and each MCP client register as OAuth clients and present access tokens; `ctx.props` carries `{ ownerId, agent, scopes }` and each handler enforces least-privilege at the door.
- **Files / primitives:** `src/index.ts` (default export = `OAuthProvider`), `src/auth/consent.ts` (defaultHandler), `wrangler.jsonc` (`OAUTH_KV` binding — **required**).
- **Dependencies:** T0, T2.
- **Config sketch:**
  ```typescript
  export default new OAuthProvider({
    apiRoute: ['/mcp/', '/api/'],
    apiHandler: AtlasMcpApi,                 // WorkerEntrypoint; reads ctx.props
    defaultHandler: consentHandler,          // renders consent, calls completeAuthorization
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: [
      'gmail.modify', 'calendar.events', 'calendar.readonly',
      'drive.file', 'drive.readonly', 'spreadsheets',
      'github.read', 'github.write', 'vault.write',
    ],
    accessTokenTTL: 3600,
  });
  ```
- **Acceptance:** hitting `/authorize` renders consent listing the requested per-agent scopes; `completeAuthorization` issues a code; `/oauth/token` returns an access token (PKCE S256 enforced); a protected `/mcp/` call sees `ctx.props.scopes`; `listUserGrants`/`revokeGrant` back an owner-facing "what can Atlas do / revoke" surface. Startup **fails** without `OAUTH_KV` (a real KV namespace, not D1).

---

#### T11 — Outbound Google OAuth (owner-once offline refresh)

- **Deliverable:** an owner-once authorize flow that captures a Google **refresh token** into Secrets Store, plus a `googleAccessToken(env)` helper that mints short access tokens per call. GCP project has Gmail + Calendar + Pub/Sub APIs enabled and OAuth consent configured.
- **Files / primitives:** `src/oauth/google.ts` (authorize URL + code exchange w/ PKCE + refresh).
- **Dependencies:** T9 (Secrets Store), T10 (inbound provider hosts the callback route).
- **The load-bearing flags:** the authorize request MUST include `access_type=offline` AND `prompt=consent` or no refresh token is returned. Refresh responses never return a new refresh token — keep the original.
  ```typescript
  // authorize (run once in the owner's browser)
  new URLSearchParams({
    client_id, redirect_uri, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events ...',
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
    code_challenge, code_challenge_method: 'S256', state,
  });
  ```
- **Acceptance:** the token exchange response contains a `refresh_token`; it is written to Secrets Store `google-refresh-token`; a subsequent `grant_type=refresh_token` call returns a fresh `access_token` **without re-consent**.

---

#### T12 — Outbound GitHub App OAuth (installation tokens, down-scoped)

- **Deliverable:** GitHub App created; `appJwt(env)` (RS256, `iss` = App client ID, `iat` backdated 60s, `exp` ≤ 10 min) and `installationToken(env, id)` (down-scoped via `repositories` + `permissions`). The token is **opaque** — never parse it (2026 `ghs_<APPID>_<JWT>` format).
- **Files / primitives:** `src/oauth/github.ts` (uses `jose`).
- **Dependencies:** T9.
- **Acceptance:** the POST returns a `ghs_` token with exactly the requested repos/permissions and `expires_at ~1h`; an over-broad request is rejected by GitHub; minting per-run (never persisting the 1h token) verified.

---

#### T13 — Per-agent scope enforcement (Filer invariant proof)

- **Deliverable:** server-side scope enforcement so the Filer mail path can only ever hold `gmail.modify` and has **no code path** to delete/archive; the Google MCP must strip 2FA codes / reset links from tool output regardless of scope. Enforced in BOTH places: the inbound provider `scopesSupported` allow-list + the apiHandler 403.
- **Files / primitives:** `src/mcp/google.ts` apiHandler (the Google MCP server façade, stateless `createMcpHandler`).
- **Dependencies:** T10, T11.
- **Acceptance:** a token whose scopes lack `gmail.modify` cannot call Filer label tools (403); there is no reachable `messages.delete`/`threads.delete` (that requires the full `https://mail.google.com/` scope, which is never granted); a tool-output test confirms security mail bodies (2FA/reset) are stripped — a prompt instruction alone is NOT sufficient.

---

#### T14 — AI Gateway model-access spine (`claudeFor` / `modelFor`)

- **Deliverable:** the shared Claude-via-AI-Gateway factory every Phase-1 agent consumes from day one. Every Claude call goes through the dedicated Anthropic endpoint (`.../{account}/{gateway}/anthropic`); per-agent model tiering is read from config (KV override → `[vars]` default), not hardcoded.
- **Files / primitives:** `src/lib/claude.ts` (`claudeFor`, `modelFor`), `wrangler.jsonc` (`[ai]` binding, `MODEL_*` vars), secrets `ANTHROPIC_API_KEY` + `CF_AIG_TOKEN`.
- **Dependencies:** T0, T2.
- **Tiering (config, not code):** Opus `claude-opus-4-8` (Atlas, Compass, Archivist); Sonnet `claude-sonnet-4-6` (Forge, Herald, Scout, Headhunter-full); Haiku `claude-haiku-4-5` (Filer high-volume, Headhunter board-scan).
- **Acceptance:** `claudeFor("filer", env).messages.create(...)` succeeds through the Gateway; `cf-aig-metadata {agent}` appears in Gateway logs for cost attribution; flipping `model:filer` in KV re-tiers Filer without redeploy; a non-2xx Gateway response emits a `model_error` Wire event toward Flagger.

---

#### T15 — Obsidian bridge: local REST API + outbound-only daemon + outbox drain

- **Deliverable:** Steward → Vault writes land via the **outbound-only** bridge. Steward writes **write-intents** into `vault_outbox` (D1); the local macOS launchd daemon authenticates OUTBOUND, long-polls `/bridge/poll`, drains intents, POSTs them to the Obsidian Local REST API at `https://127.0.0.1:27124`, then acks OUTBOUND. **Zero inbound port on the laptop.** All Bases-rendered data is written to YAML **frontmatter** (Bases ignores note body + Dataview inline fields).
- **Files / primitives:** `src/bridge/poll.ts` + `src/bridge/ack.ts` (cloud Worker endpoints, gated by `ATLAS_BRIDGE_TOKEN`), `~/Atlas/bridge/index.ts` (daemon), `~/Library/LaunchAgents/com.atlas.bridge.plist`, Obsidian Local REST API plugin (v3+ PATCH API).
- **Dependencies:** T1 (`vault_outbox`), T5/T6 (Steward enqueues intents), T10 (daemon registers as a confidential OAuth client).
- **Op → REST mapping:**

  | Wire `op` | Vault target | REST call | Headers |
  |---|---|---|---|
  | `increment` | counter in `Counters/metrics.md` frontmatter | `PATCH /vault/Counters/metrics.md` | `Operation: replace` · `Target-Type: frontmatter` · `Target: <counter>` · `Content-Type: application/json` (writes the **absolute** value computed in D1 — frontmatter has no atomic +1) |
  | `upsert` | per-entity note frontmatter (`Jobs/…`, `Tasks/…`, `Flags/…`) | `PATCH /vault/<note>.md` | `Operation: replace` · `Target-Type: frontmatter` · `Target: <field>` · `Create-Target-If-Missing: true` |
  | `upsert` (rebuild view block) | `Dashboard/Today.md` heading | `PUT /vault/Dashboard/Today.md` | `Target-Type: heading` · `Target: Today` |
  | `append` | `Dashboard/Heartbeat.md` run log | `POST /vault/Dashboard/Heartbeat.md` | `Target-Type: heading` · `Target: Run Log` |

  > Steward NEVER calls `DELETE /vault/...` (Pillar 2; sole writer, no destructive ops). The daemon trusts the plugin's self-signed cert **only** for `127.0.0.1` (`rejectUnauthorized:false`), never on the outbound cloud connection.
- **Acceptance:** `lsof -i -nP | grep LISTEN` on the laptop shows only Obsidian's `27124` bound to `127.0.0.1` (no inbound Atlas port); a queued `increment` lands in the vault after an outbound poll and is visible in a Base board; replaying the same Wire message leaves the counter unchanged; bridge-unreachable holds the outbox and raises Flagger **P2 High**; a `.sync-conflict-*.md` file raises **P2 High**.

---

### Failure-mode wiring established in Phase 0

| Failure | Origin | Flag |
|---|---|---|
| Malformed Wire event | T6 consumer / T5 validate | `P3 Medium`, high trust; ack (no poison-loop), no write |
| Redelivered message | T5/T6 dedup | none — expected and handled |
| Steward write failing (retries exhausting) | T6 | `P2 High` at attempt ≥4; then DLQ → T7 |
| Obsidian bridge / Obsidian unreachable | T15 | hold outbox, retry; exhausted → `P2 High` |
| `.sync-conflict-*` file detected | T15 | `P2 High` |
| Counter ↔ ledger drift | T5 / Fri-16:30 rebuild | `P3 Medium`, surface (never silently "fix") |
| Orchestrator heartbeat stale | T4 `alarm()` | `P1 Critical`, high trust |

### Timezone decision (resolve now)

Cron Triggers are **UTC-only with no DST** (the morning-chain crons land in Phase 1, but the policy is a Phase-0 decision). Atlas adopts **UTC-translation-with-DST-edits**: every owner-local schedule line is hand-translated to a UTC cron and re-derived at the EST/EDT boundary; internal step budgets use `step.sleepUntil` with a tz-correct `Date`. This closes the open question flagged in `docs/03-scheduling.md §6` and `docs/06 §12` — update both to state UTC crons explicitly with the EST/EDT translation table.

---

### Phase 0 done =

- [ ] Atlas can **schedule a no-op agent and route a message onto the Wire** (`atlas-wire` send → consumer receives).
- [ ] Steward consumes **one** Wire event and applies it to the Vault per the §6.4 write contract `{ agent, type, entity, op, payload, idempotencyKey }` — **serialized single-consumer** (`max_concurrency=1` + DO lock), **`increment` idempotent on replay** (same key twice = one bump; `meta.changes===0` on replay).
- [ ] The **Wire DLQ** (`atlas-wire-dlq`) exists and dead events become Flagger incidents, never silent loss.
- [ ] The **Codex** (`codex.md`) exists with the §11 sections (identity, education, work, skills, projects, bios, socials) and is **read-only to agents** except the explicit "update my profile" flow.
- [ ] **OAuth round-trips succeed** for Google (least-privilege scopes; `access_type=offline&prompt=consent` yields a refresh token) and GitHub (GitHub App installation token, down-scoped); **tokens live in Cloudflare Secrets Store — never in the Vault or Codex.**
- [ ] **Filer scope invariant proven:** the Google MCP path holds `gmail.modify` only, has no delete/archive code path, and strips 2FA codes / reset links from tool output.
- [ ] The **Obsidian bridge** is outbound-only: the laptop has **no inbound listening port**; Steward's `increment`/`upsert`/`append` ops each land in the Vault end-to-end through the `vault_outbox`, and a 50-event fan-in produces zero `.sync-conflict` files with counters equal to D1 authoritative totals.
- [ ] **Zero user-visible features shipped** — and that is correct for Phase 0.

---

## 3. Phase 1 — Core Loop / MVP (task-level)

Phase 0 (the SPINE) gave us the Atlas Worker, the Wire (`atlas-wire` Queue) + DLQ, the `StewardWriter` Durable Object (sole serialized Vault writer over the local Obsidian bridge), the Codex, the Google + GitHub OAuth front door, the two AI Gateways, and the `claudeFor`/`modelFor` shared lib. Phase 1 turns that spine into the thing the owner actually sees every morning: the **strictly-sequential morning chain**

```
Filer (07:45 sweep) ─▶ Herald (08:00) ─▶ Forge (08:15) ─▶ Sundial (08:20) ─▶ Compass (08:30)
   labels                digest             tasks            calendar          day plan
```

The single biggest architecture decision of this phase, confirmed by the research digest, is: **do NOT register the five stages as five independent crons racing 15-minute windows.** A 5-cron model has no durable resume and no downstream-halt — a Herald failure wouldn't stop Forge, and Compass could plan on stale data. Instead, **one cron at 07:45 kicks a Cloudflare Workflow (`MorningChain`)** whose five steps run start-after-success with per-step retry and memoized resume. Cron is the *WHEN*; the Workflow is the *durably-sequenced HOW*. The per-agent clock times (08:00/08:15/08:20/08:30) become `step.sleepUntil` budget gates inside the Workflow, not separate triggers.

Each stage is a **stateless Worker pass** invoked as a Workflow step; it does its domain work, emits one Wire event to Steward, and returns its output as the next step's input. Steward (Phase 0) is the only consumer of the Wire and the only Vault writer — Phase 1 adds no new writer.

> **Timezone (resolves docs/03-scheduling.md §6 / docs/06 §12):** Cron Triggers are **UTC-only, no DST**. Owner zone is `America/Toronto`. The UTC crons below are written for **EDT (UTC−4)**, which is in effect on the 2026-05-31 build date. At the DST boundary every chain/independent cron must be re-derived. Internal budget gates use `step.sleepUntil` with a tz-correct `Date`, which is DST-safe; only the *trigger* cron needs the twice-a-year edit.

| Owner-local | EDT cron (UTC−4) | EST cron (UTC−5) | What fires |
|---|---|---|---|
| **07:45 Mon–Fri** | `45 11 * * 1-5` | `45 12 * * 1-5` | `MorningChain` Workflow (Filer→…→Compass) |
| 21:00 daily | `0 1 * * *` | `0 2 * * *` | Compass `preview` (independent) |

---

### Filer (#2) — Gmail labeler, `gmail.modify` ONLY

| Field | Value |
|---|---|
| **Trigger / schedule** | (a) Workflow step `filer-sweep`, kicked by the 07:45 cron; (b) **continuous** Gmail push (separate `event` path, NOT cron); (c) **06:00 daily** `users.watch` renewal cron |
| **Runtime shape** | Stateless Worker pass + `FilerCursor` Durable Object (SQLite) holding the per-account Gmail `historyId` cursor |
| **Inputs** | New/changed Gmail threads; the label taxonomy (docs/04); `From/VIP` + `From/Company/*` hints from the Codex/config |
| **Outputs** | Gmail labels applied to threads; one Wire event `{agent:"Filer", type:"sweep.done", entity:"email", op:"increment", payload:{labeled,uncertain,phishing}, idempotencyKey:"filer:sweep:<date>"}` |
| **MCP server + scope** | Google MCP, `gmail.modify` ONLY (labels; cannot delete/archive — enforced server-side in the MCP binding, not by prompt). Tools: `list_labels`, `create_label`, `search_threads`, `label_thread`. No delete/trash tool exists in the toolset. |
| **Model tier** | **Haiku** (`claude-haiku-4-5`) — high-volume continuous + sweep labeling. Codex + taxonomy go in a `system` block with `cache_control:{type:"ephemeral",ttl:"1h"}` so the 07:45 sweep and push stream read the cached taxonomy at 0.1x. |

**Ordered tasks**

1. **Bootstrap taxonomy (once / on drift).** `list_labels` (cache per run) → diff vs docs/04 taxonomy → `create_label` only on a real diff, **parent before child** (`Type/Job` before `Job/OA`), with palette-valid `color` set at create time. *AC:* a fresh account ends with every taxonomy label present, nested correctly in the sidebar, and an out-of-palette color request is never sent (Gmail returns `400 Invalid color`).
2. **Continuous push path.** Wire up `users.watch` (topic `gmail-filer`, `labelIds:["INBOX"]`) → Pub/Sub push (envelope is just `{emailAddress, historyId}`) → `users.history.list(startHistoryId=cursor.historyId, historyTypes:[messageAdded,labelAdded])` → enqueue changed thread ids (debounced) → advance `historyId` in `FilerCursor`. *AC:* a new email is labeled within the debounce window; on `history.list` 404 (pruned cursor) Filer falls back to the sweep query and re-establishes the cursor.
3. **06:00 watch renewal cron.** `users.watch` re-run daily (watch expires in 7 days). *AC:* `data.expiration` is always > 6 days out after the cron; a lapsed watch raises `P3` (push channel stale).
4. **07:45 sweep step.** `search_threads("newer_than:2d -label:AI/Reviewed")` → for each thread: skip if `AI/Reviewed` present (idempotent) → classify (Haiku) → phishing/security guard → contradiction+confidence check → `label_thread(delta only)` → always append `AI/Reviewed` last (`AI/Uncertain` too if low-confidence). *AC:* re-running the sweep over the same window produces 0 new label writes and 0 duplicate labels.
5. **Emit Wire event** with `idempotencyKey:"filer:sweep:<date>"`, then return the labeled summary so the Workflow can hand it to Herald. *AC:* replaying the message leaves Steward counters unchanged (`meta.changes===0`).

**Be careful about (Filer-specific invariants)**

- **Labels-only, never destroy.** No `delete`/`archive`/`trash` tool is bound; `gmail.modify` *cannot* permanently delete (that needs the full `https://mail.google.com/` scope) — so pillar 2 is enforced at the scope boundary, belt-and-suspenders with the empty toolset. Never write the reserved system labels `INBOX/SENT/SPAM/TRASH` (API rejects anyway).
- **Idempotent skip on `AI/Reviewed`.** The sweep query is literally `-label:AI/Reviewed`; `AI/Reviewed` is always added *last* so a partial run resumes cleanly. `label_thread` is `idempotentHint:true` (re-adds are no-ops).
- **No contradictory labels.** Run the consistency pass before `label_thread` (reject e.g. `Suggest/Delete + ① Action Required`; >1 triage label; `Type/Promotion + Needs/*`; `⑤ No Action + Needs/*`/`Due/*`). On conflict keep the higher-trust label, drop the loser, add `AI/Uncertain` if it was genuine ambiguity. Triage is the **one** mutually-exclusive group Filer is allowed to *remove* a stale member from.
- **NEVER surface 2FA codes / reset links.** `Type/Security` and `⚠ Phishing-Suspect` are read-and-label only — never follow links, never reproduce codes/reset URLs anywhere (label, digest, export). A `⚠ Phishing-Suspect` thread gets **no** `Needs/*` and **no** `Suggest/*`.
- **Gmail batch + backoff.** Debounce push into small windows; page `search_threads` in chunks with a delay; prefer `messages.batchModify` (50 quota units flat) where many threads share an identical label set; exponential backoff **with jitter** on `429` AND `403 rateLimitExceeded` (a 403, not a 429). Partial progress is preserved via the `AI/Reviewed` cursor.

---

### Herald (#1) — email digest, daily mode (read + draft only)

| Field | Value |
|---|---|
| **Trigger / schedule** | Workflow step `herald-daily`, gated by `step.sleepUntil(08:00)`, runs only on `filer-sweep` success. (Weekly mode `0 21 * * 5` EDT is Phase 2; this subsection is the daily leg.) |
| **Runtime shape** | Stateless Worker pass + Durable Object for per-run state (previous-run ts → 24h window) |
| **Inputs** | Filer's thread labels (substrate — Herald never re-classifies), thread metadata, the Codex (VIP/company context for ranking) |
| **Outputs** | (1) a **Gmail draft to the owner** (`chahinedaniel0@gmail.com`), never sent; (2) a Wire event `{agent:"Herald", type:"digest", entity:"email", op:"upsert", payload:{mode:"daily",runDate,counts,topActionRequired,draftId}, idempotencyKey:"herald:daily:<date>"}` |
| **MCP server + scope** | Google MCP, **Gmail read + draft-create only** — NO `gmail.modify`, NO send, NO delete. Labeling is Filer's; Herald cannot mutate the inbox. |
| **Model tier** | **Sonnet** (`claude-sonnet-4-6`) for high-volume bucketing; the synthesis pass can use Sonnet (config key `model.synthesize` lets the owner bump to Opus). Codex VIP context in a cached `system` block. |

**Ordered tasks**

1. **Pull labeled threads** in the 24h window (DO state holds the last daily run ts). Threads still missing `AI/Reviewed` are noted as "Filer may be behind," not dropped. *AC:* window math derived via `Intl` with `America/Toronto`, not the Worker's UTC `Date`.
2. **Bucket into the five owner-requested sections, in order:** Important · Action Required · Action Recommended · Advertisement · Other. `Type/Newsletter` is opted-in → **Other** (reading queue), never Advertisement; only `Type/Promotion` is an ad. *AC:* section order matches config `[Important, Action Required, Action Recommended, Advertisement, Other]` exactly.
3. **Redact security mail** (see below), then **rank** within sections (`Due/Today` → `Due/ThisWeek` → `From/VIP` → rest).
4. **Synthesize** the digest body, **create a Gmail draft** to the owner (subject `Atlas Digest — <day> (daily)`). *AC:* a draft exists in the owner's mailbox; nothing is sent.
5. **Emit the `digest` Wire event** (idempotencyKey `herald:daily:<date>`) and return the digest/thread-refs so Forge reuses them without re-fetching. *AC:* a retried run does not double-count Steward's email counters.

**Be careful about (Herald-specific invariants)**

- **Draft-only digest.** Herald has no send scope and no label scope — it only reads and drafts. The draft is the morning glance; only the owner sends/forwards. (Open question in herald.md: the Gmail draft may be redundant with the Vault morning glance — keep the draft for v1.)
- **Security redaction (non-negotiable, SPEC §5.8/§12).** `Type/Security` threads are listed by **sender + subject only** with a flat "security-sensitive; open in Gmail" note — strip any code-looking token (`\b\d{4,8}\b` near "code"/"OTP"/"verification") and any reset/login URL *before* the model's synthesis output. `⚠ Phishing-Suspect` lands under **Other** with a visible warning and **no clickable link**, never under Important/Action. `Finance/*` and health mail are summarized as *existence + action* ("Bill due Fri — open in Gmail"), never balances/account numbers. If the redaction regex trips on the *output*, **block the draft** and raise `P2 High`.

---

### Forge (#3) — task & subtask extractor

| Field | Value |
|---|---|
| **Trigger / schedule** | Workflow step `forge-morning`, runs on `herald-daily` success. (Also event-driven from Headhunter findings in Phase 2; on-demand manual capture.) |
| **Runtime shape** | Stateless Worker pass + per-run Durable Object holding the D1 dedupe/idempotency lock |
| **Inputs** | Herald digest items + thread refs (reused, not re-fetched), threads labeled `① Action Required` carrying `Needs/*`/`Due/*` |
| **Outputs** | `tasks`/`subtasks` rows in **D1**; one Wire event per new/changed task `{agent:"Forge", type:"task", entity:<task id>, op:"increment"|"upsert", payload:{open,due_this_week,...}, idempotencyKey:<task id>}` |
| **MCP server + scope** | Google MCP (Gmail **read** of labels/threads only) + D1 binding (`tasks`/`subtasks`, system-of-record — NOT KV; counters/dedupe must live in D1). |
| **Model tier** | **Sonnet** (`claude-sonnet-4-6`) for extraction (config `forge.model`); Opus only for ambiguous batches. |

**Ordered tasks**

1. **Gather + filter.** Pull `① Action Required` threads updated since the watermark; keep only those with a `Needs/*` or `Due/*` label. Drop `④ FYI`/`⑤ No Action`. *AC:* a thread with no `Needs/*`/`Due/*` produces no task.
2. **Extract** per candidate (Sonnet): `{title, subtasks[], priority}`, grounded with the `Needs/*` label. *AC:* title is a short imperative ("Submit Shopify OA", not "RE: your online assessment").
3. **Deadline inference** → set `due` + `due_kind` (`explicit` | `inferred` | `none`). Explicit always wins; `Due/ThisWeek`→Fri 17:00, `Job/OA`→+5d default, "EOD"→23:59 owner-local. Past-due → keep, bump `priority≥P2`, raise `P3`. *AC:* a stated "by EOD Monday June 2" parses to `2026-06-02T23:59:00-04:00`.
4. **Dedupe** via `dedupe_key = sha256(thread + normalizedTitle + dueDate)` against D1 (unique index `idx_tasks_dedupe`). Hit/same-source → no-op (no re-emit); hit/other-channel → **merge** (union subtasks, earliest `due`, max priority, `upsert`); miss → insert + `increment`. Owner-touched tasks (`locked_by_owner`) short-circuit. *AC:* re-running 08:15 produces 0 duplicate tasks; a DB unique-collision after an app-side miss falls into the merge path, not an error.
5. **Write inside the DO lock**, then **emit** one Wire event per new/changed task with `idempotencyKey = task id`. *AC:* a Queue replay of the event leaves Steward's Tasks counters unchanged.

**Be careful about (Forge-specific invariants)**

- **Suggest, don't destroy.** Forge creates tasks only — it never touches Gmail, never registers/pays, never writes the Vault directly (events go through Steward).
- **Security skip.** Never copy 2FA codes / reset links into a title or subtask; if the only actionable content is a code/link, **skip the item** and let Filer's `Type/Security` handling stand. A `⚠ Phishing-Suspect` thread → **do not extract**, raise `P2 High` (push).
- **D1, not KV, for state.** Tasks, dedupe keys, and counters are D1 (system-of-record). KV is 1-write/s/key with 60s propagation — wrong for any of this.
- **Workflow-step discipline.** Do not mutate `event.payload` inside the step (reverts on replay); return state and pass it forward. The task `id` is the idempotency anchor end-to-end.

---

### Sundial (#4) — task → Google Calendar sync

| Field | Value |
|---|---|
| **Trigger / schedule** | Workflow step `sundial-sync`, runs on `forge-morning` success (target 08:20). On-demand re-fire is safe (idempotent). |
| **Runtime shape** | Stateless Worker pass + per-agent Durable Object for run state |
| **Inputs** | Forge tasks where `due != null && status == open` (from D1); existing Google Calendar events |
| **Outputs** | Created/updated `⏳ <task>` calendar blocks with reminders + identity stamp; one Wire event `{agent:"sundial", type:"calendar.sync", entity:"deadlines", op:"upsert", payload:{created,updated,skipped,upcoming7d}, idempotencyKey:"sundial-<date>"}` |
| **MCP server + scope** | Google MCP, **`calendar.events`** (per-event create/update/list — NOT broad `calendar`, NOT delete). Tools: `list_events`, `create_event`, `update_event`, `suggest_time`. `delete_event` is deliberately **out of the autonomous toolset**. |
| **Model tier** | None required for the deadline-marker path (deterministic mapping). `suggest_time` is a Calendar call, not a model call. |

**Ordered tasks**

1. **Read deadline tasks** from D1 (`due IS NOT NULL AND status='open'`). *AC:* tasks without a deadline are skipped (they belong to Compass's plan, not the calendar).
2. **List the window once** up front: `events.list(calendarId:"primary", timeMin=now, timeMax=now+aheadDays(60), singleEvents:true, privateExtendedProperty:["agent=sundial"])`. The server-side filter means Sundial reads **only its own** blocks — owner/Usher events never appear. *AC:* no foreign event is ever read or written.
3. **Map → block:** date-only → all-day (`start.date`/`end.date`, end **exclusive**); datetime → timed marker ending **at** `due`; `estimateMins` + focus-block → `suggest_time` then `create_event`. Stamp `extendedProperties.private = {atlasTaskId, agent:"sundial", syncedDue, contentHash}`. *AC:* an all-day deadline on 2026-06-06 has `end.date = 2026-06-07`.
4. **Reconcile per task** keyed on `atlasTaskId`: no match → `create_event`; `contentHash` drift → `events.patch` (re-assert the **full** reminder set, never append); identical → **skip** (no API write). *AC:* re-running at 08:22 after a mid-morning task creates only the new block; all prior blocks match and skip.
5. **Emit the sync summary** with `idempotencyKey:"sundial-<date>"`. *AC:* replay-safe; Vault Deadline board + Upcoming-7d view stay consistent.

**Be careful about (Sundial-specific invariants)**

- **No autonomous delete (`allowDelete:false`).** Orphan/cancelled-task blocks become a *proposed removal* surfaced via Steward — gated on owner confirmation (pillar 2). `delete_event` stays off the autonomous path.
- **Don't touch foreign events.** Anything without `agent:"sundial"` is read-only.
- **Idempotent reminders.** On update, re-assert the full `reminders.overrides` set (`useDefault:false`, ≤5 overrides, `minutes >= 0`). Note the all-day "09:00 day-of" caveat: minutes must be ≥0, so a 09:00-day-of nag on an all-day event (start = 00:00) can't be a negative offset — model it as a small positive value or accept the 00:00-relative reminder.
- **Insert race guard.** Because Calendar `create_event` can double-create on a network blip, the fetch-then-decide order (list by `privateExtendedProperty` *before* creating) is mandatory; a detected duplicate `atlasTaskId` → keep earliest, propose removal of the dup (gated), flag `P2`.

---

### Compass (#5) — daily planner (last stage)

| Field | Value |
|---|---|
| **Trigger / schedule** | Workflow step `compass-plan`, runs on `sundial-sync` success (target 08:30, end of chain). Independent `preview` cron `0 1 * * *` EDT (21:00 owner-local) for next-day prep. |
| **Runtime shape** | Stateless Worker pass + per-agent Durable Object for run state |
| **Inputs** | Open tasks (Forge/D1) · today's Google Calendar (Sundial + Usher events, read-only) · the Codex (working hours / focus prefs) |
| **Outputs** | One Wire event `{agent:"Compass", type:"day_plan", entity:"Today", op:"upsert", payload:{date,mode,top3,blocks,couldnt_fit,at_risk}, idempotencyKey:"compass:plan:<date>"}` |
| **MCP server + scope** | Google MCP, **`calendar.readonly`** (read-only — Compass never writes the calendar; one-writer rule, Sundial/Usher own it) + D1 read (task store). |
| **Model tier** | **Opus** (`claude-opus-4-8`) — reasoning/synthesis. Set `effort` explicitly below the `high` default to control cost on the daily pass. Codex prefs in a cached `system` block. |

**Ordered tasks**

1. **Read tasks + calendar.** Score tasks by deadline distance (`Due/Expired ≫ Due/Today ≫ Due/ThisWeek ≫ undated`) + triage tier + `From/VIP` bump + `Needs/*` type. *AC:* overdue items are never silently buried.
2. **Build the free/busy grid** from working hours (Codex default 09:00–18:00) minus events, with `meeting_buffer_min`(10) padding and `min_block_min`(25) floor.
3. **Merge:** bin-pack ranked tasks into the earliest gaps that fit; the plan is chronological but block-assignment is priority-driven.
4. **Overcommitment check:** if `demand_minutes > free_minutes`, pack by priority, push the rest to a visible **"⚠ Couldn't fit today"** section (never deleted/hidden), mark `Due/Today`/`Due/Expired` overflow **at-risk**, and raise `P3 Medium` (high trust — deterministic capacity calc) with a `suggested_action`. **Never** reschedule a calendar event. *AC:* a 95-min-over-capacity day yields a Couldn't-fit list + a `P3`, not a dropped task.
5. **Render + emit** the `upsert` with `idempotencyKey:"compass:plan:<date>"`. *AC:* the 08:30 run and any same-date re-run **replace** the Today note (never append/duplicate).

**Be careful about (Compass-specific invariants)**

- **Read-only on the calendar.** Compass *suggests*, it does not move events (one-writer rule).
- **Degrade, don't skip.** If Sundial failed/unfinished at 08:30, plan against the last-known calendar and flag the dependency (`P3`), marking the plan **stale** — never skip the day.
- **Deterministic idempotency.** `compass:<mode>:<date>` guarantees the Today note upserts, not appends, even on retry.

---

### Morning Workflow wiring (cron 07:45 → 08:30)

**One cron, one Workflow, five steps.** The `MorningChain` Workflow (bound `MORNING_CHAIN`, class `MorningChain extends WorkflowEntrypoint`) is the durable substrate; the 07:45 cron only triggers it.

`wrangler.jsonc` (additions to the Phase-0 Atlas Worker):

```jsonc
{
  "workflows": [
    { "name": "atlas-morning-chain", "binding": "MORNING_CHAIN", "class_name": "MorningChain" }
  ],
  "triggers": {
    // ALL UTC. 07:45 America/Toronto == 11:45 UTC during EDT (UTC-4); 12:45 UTC during EST.
    "crons": ["45 11 * * 1-5"]   // re-derive at the DST boundary
  }
}
```

Trigger from the Atlas `scheduled()` dispatcher — the **instance id is the idempotency handle**, so a re-fired or missed-then-recovered cron is a safe no-op:

```typescript
// src/index.ts (Atlas #0 dispatcher) — Phase 0 handler, Phase 1 adds this case
case "45 11 * * 1-5": {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" })
    .format(new Date());                       // owner-local YYYY-MM-DD, not the Worker's UTC date
  ctx.waitUntil(env.MORNING_CHAIN.create({
    id: `morning-${date}`,                     // re-fire = no-op (id already exists)
    params: { date, tz: "America/Toronto" },
  }));
  break;
}
```

The Workflow itself — `await`ed steps give **start-after-success** for free; memoization gives **resume-on-failure**:

```typescript
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";   // NOTE: different module

export class MorningChain extends WorkflowEntrypoint<Env, { date: string; tz: string }> {
  async run(event: WorkflowEvent<{ date: string; tz: string }>, step: WorkflowStep) {
    const { date, tz } = event.payload;

    // Filer rides Gmail 429s on the default+ retry budget; longer timeout for the sweep.
    const filer = await step.do("filer-sweep",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
      () => invokeAgent(this.env, "filer", { mode: "sweep", date }));

    // budget gate to 08:00 owner-local (DST-safe via tz-correct Date), then Herald.
    await step.sleepUntil("budget-herald", localTime(date, "08:00", tz));
    const herald = await step.do("herald-daily",
      { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" },
      () => invokeAgent(this.env, "herald", { mode: "daily", date, labels: filer }));

    await step.sleepUntil("budget-forge", localTime(date, "08:15", tz));
    const forge = await step.do("forge-morning",
      { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" },
      () => invokeAgent(this.env, "forge", { mode: "morning", date, digest: herald }));

    await step.sleepUntil("budget-sundial", localTime(date, "08:20", tz));
    const sundial = await step.do("sundial-sync",
      { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" },
      () => invokeAgent(this.env, "sundial", { mode: "sync", date, tasks: forge }));

    await step.sleepUntil("budget-compass", localTime(date, "08:30", tz));
    const compass = await step.do("compass-plan",
      { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" },
      () => invokeAgent(this.env, "compass", { mode: "plan", date, tasks: forge, calendar: sundial }));

    return { filer, herald, forge, sundial, compass };
  }
}
```

**Behaviors this buys (per the digest):**

| Property | Mechanism | Effect on the chain |
|---|---|---|
| **start-after-success** | each `step.do` is `await`ed sequentially | Herald only runs because `filer-sweep` returned; etc. |
| **resume-on-failure** | completed step results are memoized; replay returns cached results | a `forge-morning` crash resumes **at Forge** — Filer/Herald are not re-run |
| **halt-downstream** | a step that exhausts retries → instance `errored` | Sundial/Compass never execute if Forge fails — no planning on stale data |
| **retry/timeout policy** | per-step `retries`/`timeout` config (KV-overridable at runtime) | Filer gets `limit:5` to ride Gmail `429`s; all steps get a `10m` timeout for the Opus/MCP calls |
| **fail-fast on terminal errors** | `throw new NonRetryableError(...)` | a malformed event / hard validation failure fails immediately instead of retrying for the full budget |
| **DST-safe internal clock** | `step.sleepUntil(localTime(date, "HH:MM", tz))` | budget gates track owner-local time without the cron's DST problem |

**Halt → Flagger.** Wrap the chain trigger (or use a terminal status check) so an `errored`/halted instance emits a Flagger incident onto the Wire — `{agent:"Atlas", type:"chain.halted", entity:"morning-chain", op:"increment", payload:{step, attempt, error}, idempotencyKey:"morning-halt:<date>:<step>"}` at **P2 High, high trust**. A missed cron (Worker cold) is **not** auto-replayed by Cloudflare — the next day's run catches up because every pass is idempotent; log the miss to the run-log Vault view (SPEC §6.2).

**How each agent emits to Steward.** Every step's side-effect produces a Wire event in the canonical shape and `env.WIRE.send(...)`-s it; the Workflow **does not** write the Vault. Steward (Phase 0) is the single `max_concurrency=1` consumer that dedups on `idempotencyKey`, applies `increment`/`upsert`/`append` in D1 atomically, and enqueues the write-intent the local Obsidian bridge drains.

| Agent | `type` | `op` | `idempotencyKey` | Steward effect |
|---|---|---|---|---|
| Filer | `sweep.done` | `increment` | `filer:sweep:<date>` | email counters (labeled/uncertain/phishing) |
| Herald | `digest` | `upsert` | `herald:daily:<date>` | Email counters + summary note; links the draft |
| Forge | `task` | `increment`/`upsert` | `<task id>` | Tasks counters (open / due-this-week / overdue) |
| Sundial | `calendar.sync` | `upsert` | `sundial-<date>` | Deadline board + Upcoming-7d view |
| Compass | `day_plan` | `upsert` | `compass:plan:<date>` | Today view + morning-glance top-3 |

Because ordering on the Wire is best-effort (not FIFO) and delivery is at-least-once, **causal correctness comes from the Workflow sequencing, never from Wire order** — Steward tolerates out-of-order arrival and idempotent replay by design.

**Local test loop** (TZ is forced to UTC in `wrangler dev`, so derive owner-local time via `Intl`, never `new Date()`):

```bash
npx wrangler dev --test-scheduled
# fire the 07:45 EDT cron (spaces -> +) to kick the Workflow:
curl "http://localhost:8787/__scheduled?cron=45+11+*+*+1-5"
# or trigger the Workflow directly:
npx wrangler workflows trigger atlas-morning-chain '{"date":"2026-05-31","tz":"America/Toronto"}'
npx wrangler workflows instances describe atlas-morning-chain latest   # inspect steps/retries/errors
```

**Phase-1 acceptance (whole chain):** a single `__scheduled` fire produces, in order, fresh Gmail labels → a Gmail draft digest → ≥1 D1 task → ≥1 `⏳` calendar block → a Today note with a top-3; injecting a forced Forge failure leaves Filer's labels + Herald's draft intact, halts before Sundial/Compass, and lands one `chain.halted` P2 in the Flagger feed; re-firing the same date is a complete no-op (instance id collision, idempotent Steward writes).


---

## 4. Phases 2–5 — Build Sequencing (roadmap-level)

Phases 0–1 are the spine + MVP (detailed elsewhere). Phases 2–5 are lighter passes: each one reuses the Phase-0 plumbing (the Wire, Steward, D1/KV/R2, AI Gateway, OAuth) and adds either a new agent, a new runtime, or a new gate. The rule that orders them is the canon's: **cloud read-only first, local capture next, irreversible/outward last, meta/polish at the end.** No agent that takes a destructive or outward action leaves draft mode until its phase-specific GATING criteria below pass.

Every phase here ships with the same per-agent acceptance shape used in Phase 1: a **deliverable**, the **primitives/files touched**, and a **crisp acceptance criterion**. New tech introduced per phase is called out explicitly because that is where the build risk lives.

### Phase 2 — Weekly value (Scout · Headhunter · Flagger)

**Goal:** add the weekly cadence (Scout, weekly-Herald) and the reliability layer (Flagger) on top of the proven morning loop. Nothing here is destructive — it is still read / track / observe.

**New tech introduced**

| Primitive | Why it arrives now |
|---|---|
| Standalone Cron lines (`0 14 * * *`, `0 14 * * 1`, `0 21 * * 5`) | Headhunter daily-light + Monday-full and the Friday 16:00 parallel case are independent crons routed in Atlas's `scheduled()` switch — NOT the morning Workflow. |
| Friday parallel case | The single cron `"0 21 * * 5"` runs Scout-weekly and Herald-weekly via `Promise.all` (disjoint sources, both fan into Steward); 16:30 (`"30 21 * * 5"`) kicks the weekly-review build. |
| Flagger Durable Object + KV knobs | Live flag state (dedupe signatures, status lifecycle) in a per-Flagger DO; `push_severities`, `heartbeat_grace`, `selfwatch_threshold` in KV. |
| **Separate Cron watchdog Worker** | A second Worker, distinct from the Flagger Worker, so Flagger's own death is caught from outside (the one alert path that doesn't depend on the thing it alerts about). |
| GitHub MCP (read-only first) | Headhunter/Forge read `Type/Dev` repo signals; full GitHub write surface waits for Phase 4 (Envoy). |

**Key tasks**

1. **Scout (events digest).** Cloud Worker on the Friday parallel cron; scrapes event sources, ranks, emits a digest draft and a Steward `upsert`. *Files:* `src/scout.ts`, `[[queues.producers]] WIRE`. *AC:* Friday 16:00 produces an events digest with zero items written directly to the Vault (all via Steward).
2. **Headhunter → feeds Forge.** Cloud Worker + Durable Object holding the per-company hiring-window model in D1. `full` mode (Mon 09:00) scans boards, dedupes, recomputes window status; `deadlines` mode (daily-light 09:00) promotes `closing` windows. Imminent windows/deadlines become **`apply by <date>` tasks emitted to Forge** (NOT written by Headhunter), and pipeline counts go to Steward. *Files:* `src/headhunter.ts`, D1 `windows`/`jobs` tables, DO `HeadhunterState`. *AC:* a window inside the lead-time threshold (default 21 days) produces exactly one Forge task; a re-scan the same day produces no duplicate (dedupe + idempotencyKey). **Low-confidence hiring-window dates route to a Flagger `P3`, never silently to a task** — wrong dates here mean missed deadlines.
3. **Flagger (event-driven incident pipeline).** Consumes incident + heartbeat events off the Wire; derives a dedupe signature, assigns deterministic `severity` (P1–P4) and a `trust` score (0–100), applies KV mute-rules, routes (`P1`/`P2` push now, `P3`/`P4` batch), then emits a Steward `op:"upsert"` keyed by the flag `id`. *Files:* `src/flagger.ts`, DO `FlaggerState`, D1 `audit` table. *AC:* the same incident replayed updates one board row (no duplicate flag); a `P1` re-pushes after `escalation_window` (default 15m) until `ack`.
4. **Self-monitoring / heartbeat.** Every scheduled agent emits a heartbeat tied to its schedule slot; Flagger holds the expected-run table and raises a **stale-heartbeat `P1` (trust 100)** when a run is missing past `heartbeat_grace` (default 10m). Flagger writes its own `last_seen` to KV; the **separate Cron watchdog Worker** pushes a self-`P1` if Flagger goes quiet past `selfwatch_threshold` (default 15m). *Files:* `src/flagger-watchdog.ts` (own `wrangler.jsonc`, single cron). *AC:* killing the Flagger Worker triggers a self-`P1` push from the watchdog within `selfwatch_threshold`; a missed Compass 08:30 run surfaces a stale-heartbeat `P1` by 08:40.

**Hard dependencies on earlier phases**

- Phase 1 **Forge** must exist (Headhunter emits tasks into it).
- Phase 0/1 **Steward fan-in** and the **Friday parallel-concurrency model** must be working (Scout + weekly-Herald both serialize behind the single Steward consumer).
- Flagger depends on **every agent already emitting incident + heartbeat events** — retrofit those emits into Phase 0/1 agents as part of this phase.

**Gating criteria (must pass before Phase 3)**

- Flagger's **self-watchdog fires** in a kill test (Flagger dead → external `P1`).
- Counters reconcile: replaying a Headhunter scan leaves pipeline counts unchanged (idempotency invariant holds under the new producers).
- Flagger noise is acceptable on the success-metric bar (**≥ 70% of flags actionable** vs muted) before the fleet grows further.

### Phase 3 — Capture / local (Echo → Archivist · Quill)

**Goal:** the first time Atlas leaves Cloudflare. Echo (audio) and Quill (screen) need the physical machine, so they live in a **local macOS daemon** (menubar app backed by `launchd`) that authenticates **outbound** to the cloud — the same outbound-pull pattern the Phase-0 Obsidian bridge already uses (reuse that auth/outbox plumbing; do not invent a second one). Build the **privacy boundary first, features second.**

**New tech introduced**

| Primitive | Where |
|---|---|
| macOS `launchd` daemon + menubar app | Hosts both Echo and Quill; `~/Library/LaunchAgents/com.atlas.daemon.plist`, `KeepAlive`/`RunAtLoad`. |
| OS permission grants | Echo: **Microphone** + **system-audio loopback** (virtual device or ScreenCaptureKit audio). Quill: **Accessibility** (AX read + value injection) + **Screen Recording** (vision fallback). All owner-granted OS prompts. |
| Echo `EchoSession` Durable Object + **WebSocket (Hibernation API)** | One DO per meeting, `env.ECHO_SESSION.getByName(\`echo-<timestamp>\`)`. `ctx.acceptWebSocket()` so a long meeting doesn't pin the DO in memory; `setWebSocketAutoResponse("ping","pong")` keeps the socket alive without waking/billing; `serializeAttachment` carries `sessionId` across hibernation. |
| R2 + lifecycle rules | Diarized segments stream to the DO; raw audio (when approved) lands under `audio/raw/` with a **7-day expire lifecycle rule**; derived transcripts under `transcripts/` with **no expiry**. The prefix split + per-prefix lifecycle IS the privacy boundary made mechanical. |
| Archivist Workflow | Cloud `WorkflowEntrypoint`, triggered `event: meeting ends`. Opus pass (1M context) structures the transcript → notes; action items → Forge; note + meeting counters → Steward. |

**Key tasks**

1. **The local daemon shell.** `launchd` packaging, menubar app, outbound auth (`ATLAS_DAEMON_TOKEN` in macOS Keychain), long-poll/drain of the cloud outbox. *AC:* `lsof -i -nP | grep LISTEN` shows **no inbound listening port** for the daemon (only Obsidian's `127.0.0.1:27124` if the bridge runs on the same box); the daemon initiates every connection.
2. **Echo capture pipeline.** Tap all active input devices + loopback of all output devices, on-device STT + diarization (mic channel anchors `Owner`), stream `{speaker,text,start_ts,end_ts,confidence}` segments over the WebSocket to the session DO. **Consent gate + visible non-dismissable recording indicator before any capture is retained**; support a `consent: "discarded"` outcome that persists nothing. *AC:* a meeting produces a finalized diarized transcript in the transcript store; declining consent persists nothing but logs that a meeting occurred (P3 note).
3. **Echo R2 disposition.** Default `audio.retain = local-only` (transcript kept, audio NOT uploaded); per-session owner approval is required to upload an audio blob to R2 (`audio_disposition: "r2-approved"`); never `auto-upload`. *AC:* with no approval, no bytes hit R2; the `audio/raw/` expire-days-7 rule never touches `transcripts/`.
4. **Archivist handoff.** Echo emits `transcript ready` with a stable `session_id`; Archivist Workflow structures it (template + prior-meeting threading + Codex work context), emits one Steward `upsert` + per-owner-action-item Forge events. *AC:* re-emitting `transcript ready` for the same `session_id` does NOT create a second meeting note or double-count meeting hours (Archivist/Steward dedupe on the id).
5. **Quill screen autofill from Codex.** Hotkey-triggered, AX-first read (vision OCR fallback), normalize each field label → Codex field, fill, then **stop at a review panel** with per-field confidence; never clicks Submit/Apply/Send; never writes the Vault/Wire/Codex. Refuses to autofill secrets (password/SSN/payment). *AC:* screen content, screenshots, and OCR text never leave the device; a fill produces zero Wire events; an EEO field stays blank unless `autofill_eeo` is explicitly on.

**The local privacy boundary (enforced, not promised)**

Per SPEC §12: *Echo audio and Quill screen never leave the device except as derived artifacts the owner approves.* Mechanically:
- Echo STT/diarization run **on-device**; only the transcript (a derived artifact) goes up; raw audio stays local unless the owner approves an R2 upload that session.
- Quill's read/map/fill loop is **entirely local** — no cloud LLM ever sees the screen; the only artifact that leaves Quill's hands is the value the owner sees and confirms, and even that goes only into the local form.
- The daemon has **no inbound port**; it authenticates outbound. Flag events to Flagger may name the form + field labels but **never the screen content or filled values**.

**Hard dependencies on earlier phases**

- Phase 0 **Codex** (Quill + Archivist read it) and **Steward** (Archivist writes through it).
- Phase 1 **Forge** (Archivist action items become tasks).
- A **proven cloud system to authenticate the daemon into** — this is the explicit reason capture waits until cloud is solid.

**Gating criteria (must pass before risky agents are trusted)**

- **Consent capture = 100%** — no Echo session retains a transcript without an explicit per-session consent (a hard success-metric gate from the roadmap).
- Visible recording indicator is **non-dismissable while live** and proven on a real meeting.
- Daemon has **no inbound listening port** (verified). Raw audio/screen demonstrably never leave the device except as the approved derived artifact.
- Echo `WebSocket/DO drops mid-session` reconnects to the **same** `getByName` session DO and finalizes from the local buffer without losing the transcript.

### Phase 4 — Outward / gated (Usher · Envoy)

**Goal:** the only agents that take **irreversible, outward** actions — registering, paying, posting publicly. Build last, gate hardest. The real engineering here is **the confirmation-gate UX**, not the browser automation. Both are on-demand; neither is cron-scheduled or in any pipeline.

**New tech introduced**

| Primitive | Where |
|---|---|
| Headless browser automation (**Playwright**) on Workers + browser | Usher: find/fill/submit a registration form. Envoy: LinkedIn + X (no friendly write API). |
| Cloudflare Workflow **`step.waitForEvent` confirmation gate** | The GA primitive for Pillar-2 human confirmation: the Workflow builds the draft in a prior step, then **parks at `waitForEvent("owner.confirm", { timeout })`** until the owner confirms via `instance.sendEvent(...)`. A decline throws `NonRetryableError`; an unanswered gate's timeout is **caught** and treated as "expired," not a silent error. A draft built but unconfirmed = the default `draft + ask`. |
| GitHub MCP **write** (gated) | Envoy: profile README commit + portfolio PR via GitHub App, scoped to the profile/portfolio repos only; write tools gated on `this.props.permissions` (a granted scope does NOT authorize silent execution). |
| Usher Durable Object (session hold) | Holds browser/session state across the confirmation pause if a multi-step run needs it. |

**Key tasks**

1. **The confirmation-gate UX (the real work).** A reusable gate: draft → present → per-target/per-action approve / edit / skip / cancel → publish approved only → emit Steward increment with `idempotencyKey`. *AC:* **confirmation-gate adherence = 100%** — no outward action ever fires without an explicit owner confirm; an unanswered gate **expires** (re-prompt / abort) rather than acting or erroring the instance.
2. **Usher (registration with hard-stops).** FIND (Playwright resolve + disambiguate — never guess) → CONFIRM GATE (price disclosed here, before any form touch) → FILL from Codex (no submit yet) → **hard stops: captcha and payment** (stop cold, screenshot, hand back; never solve a captcha, never enter card details) → SUBMIT → CALENDAR ADD (Usher's one direct Calendar write) → Steward `events-registered++`. *Files:* `src/usher.ts`, Playwright runtime, Calendar MCP. *AC:* a paid event halts at the gate with a `P2 High` flag and zero side effects (no submission, no calendar event, no increment); no-confirmation = zero writes; an already-registered event-id short-circuits to "already done."
3. **Envoy (public posts, fan-out).** Read Codex (identity/bios/voice/project record) + resolve the GitHub repo → **draft all four targets** (LinkedIn entry, GitHub profile README, X post, portfolio PR) → confirmation gate with **independent per-target approve/edit/skip** → publish approved targets only (PR, never a direct push to the portfolio default branch) → one Steward Wire event per outcome. *Files:* `src/envoy.ts`, GitHub MCP (write, gated), browser (LinkedIn/X). *AC:* a re-run with the same `idempotencyKey` (`envoy:<project>:<date>`) does not double-count; a **partial fan-out** reports exactly which targets succeeded and offers to re-run only the failed ones — never silently retries an outward post.

**Hard dependencies on earlier phases**

- Phase 0 **Codex** (both read it; Envoy for copy, Usher for form-fill — same field mapping Quill uses) and **GitHub OAuth / GitHub App** (Envoy writes).
- Phase 1 **Calendar + Steward** (Usher writes Calendar, both increment counters).
- **A mature confirmation-gate UX proven on lower-stakes actions** — the explicit reason these are last: the owner must already trust a gate when it asks.

**Gating criteria (must pass before Usher/Envoy leave draft mode)**

- **No silent writes — ever.** Captcha and payment are **hard stops** that hand back to the human (Usher); every public post is `draft + ask` and **non-overridable** (Envoy).
- Confirmation-gate adherence = 100% under test, including the **re-confirm-on-material-change** path (price/date changed after the gate → stop and re-ask, never proceed on stale consent).
- A `Usher: registration attempted w/o confirmation` self-flag is a `P1` — i.e. the gate is wired such that this is provably impossible, not just discouraged.

### Phase 5 — Meta / polish (Switchboard · Librarian)

**Goal:** force-multipliers and convenience, off the critical path. Neither blocks anything; both are on-demand. Risk is low — recommendations and a notes table, nothing destructive.

**New tech introduced**

- Nothing materially new at runtime. **Switchboard is design-time only** — it does NOT run in the loop; it is consulted ad hoc when a new capability is needed to pick the right MCP/tools for a prompt. Librarian is a thin Vault-writing convenience.

**Key tasks**

1. **Switchboard (capability router, design-time).** Given a prompt/capability need, recommend the right MCP server + tools. Consulted by the owner/builder, not invoked by other agents in the loop. *AC:* produces a tool/MCP recommendation for a sample capability with no runtime coupling to the morning chain (it has no cron, no Wire consumer).
2. **Librarian (prompt library).** Save a prompt → title + deep link; emit a Steward `upsert`/`append` that maintains the Vault prompt-library table (Title link · Tags · Tool · Last used). *Files:* `src/librarian.ts`, Steward write contract. *AC:* saving the same prompt twice (same `idempotencyKey`) updates one row, does not duplicate; the table renders from frontmatter Steward maintains.

**Hard dependencies on earlier phases**

- A **working fleet to route for** (Switchboard) and **prompts to capture** (Librarian). Both presume Phases 0–4 exist; neither is a dependency of anything.

**Gating criteria**

- Low bar — these are additive and non-destructive. The only invariant: Librarian writes the Vault **only via Steward** (Pillar 1), and Switchboard writes nothing at runtime (design-time advisory only). Revisit whether Switchboard should be a coded agent at all vs. a design-time habit once the fleet is large enough to feel the routing pain.

### Phase 2–5 sequencing summary

```
Phase 2  WEEKLY VALUE   Scout · Headhunter(↳Forge) · Flagger(↤all) + watchdog Worker
   │                    new: standalone crons, Friday parallel case, Flagger DO/KV, GitHub MCP (read)
   ▼
Phase 3  CAPTURE/LOCAL  Echo→Archivist · Quill   [needs cloud proven first]
   │                    new: macOS launchd daemon, OS audio+screen perms, Echo DO+WebSocket→R2,
   │                         R2 lifecycle prefixes, Archivist Workflow. Privacy boundary FIRST.
   ▼
Phase 4  OUTWARD/GATED  Usher(captcha/payment hard-stops) · Envoy(public posts)
   │                    new: Playwright, step.waitForEvent gate, GitHub MCP (write, gated)
   │                    the gate UX is the real work; no silent writes ever
   ▼
Phase 5  META/POLISH    Switchboard(design-time) · Librarian(prompt library)
                        no new runtime; off the critical path
```

Hard edges (cannot reorder): **Headhunter into Forge** (P2); **Echo before Archivist** (P3); **gate-UX maturity before Usher/Envoy** (P4). Soft edge: cloud (P2) before local (P3); outward (P4) after every read-only agent is trustworthy.

---

## 5. Cross-Cutting Engineering Practices

These seven disciplines are **not a phase** — they thread through Phases 0–5. Each agent PR is held to them. The shared rule: the spine (Phase 0) ships the *mechanisms* (event schema, idempotency ledger, run-log, secrets plumbing, the MCP-connect gate, CI), and every later agent merely *uses* them. Nothing here is retrofitted in a later phase.

| Practice | Lands in | Enforced by | One-line invariant |
|---|---|---|---|
| Testing strategy | Phase 0, every PR | `vitest` + `@cloudflare/vitest-pool-workers` | No agent merges without a Wire contract test + an idempotency replay test |
| Observability + Flagger-from-day-0 | Phase 0 (schema), Phase 2 (Flagger Worker) | `run_log` + `audit_log` D1 tables, AI Gateway logs | Every notable event/failure is reconstructable before Flagger exists to read it |
| Idempotency + replay | Phase 0 | D1 `idempotency_keys` ledger + Steward DO lock | A replayed Wire event changes no counter (`meta.changes === 0`) |
| Secrets + least-privilege | Phase 0 | Secrets Store + per-MCP scope mount + the 10-step gate | Every new external connection passes the "Connect a new MCP" checklist |
| Local dev + deploy | Phase 0 | `wrangler dev`, staging/prod envs, GH Actions, D1 migrations | `staging` env has empty crons; prod migrations are never hand-edited |
| Cost control | Phase 0 (lib), tuned per agent | AI Gateway caching + per-cost-domain gateways + model tiering | Filer's continuous run is capped at the `atlas-highvolume` gateway |
| Security invariants as checks | Phase 0 (lint/test), per gated agent | unit tests + scope allow-list + CI grep | 2FA/reset content is mechanically unable to reach a digest |

---

### 1. Testing strategy

**Stack:** `vitest` + `@cloudflare/vitest-pool-workers` (Miniflare-backed `workerd` pool). This runs tests *inside the same runtime as production* — real DO storage, real Queue producer/consumer wiring, real D1, real `scheduled()`/`queue()`/Workflow entrypoints — not a Node mock. `wrangler dev --test-scheduled` and the local queue simulator cover the manual loop; vitest-pool-workers covers CI.

```jsonc
// vitest.config.ts (pool config)
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },   // real bindings: WIRE, DB, STEWARD_LOCK
        miniflare: { compatibilityFlags: ["nodejs_compat"] },
        isolatedStorage: true,   // each test gets a fresh DO/D1/KV/R2 — no cross-test bleed
      },
    },
  },
});
```

**What each primitive needs a test for:**

| Primitive | How to test locally | Acceptance |
|---|---|---|
| **Queue consumer** (Steward) | `import { env, createMessageBatch } from "cloudflare:test"`; build a `MessageBatch<WireEvent>`, call `worker.queue(batch, env, ctx)`, assert `ack()`/`retry()` per message and the resulting D1 counter | Malformed event → `ack()` + P3 flag (no poison loop); transient throw → `retry({delaySeconds})`; replay → `ack()`, counter unchanged |
| **DO state** (Steward ledger, Atlas heartbeat) | `env.STEWARD_LOCK.getByName("vault")`; call the RPC method directly (`stub.apply(evt)`); `isolatedStorage` resets SQLite between tests | `apply()` of the same `idempotencyKey` twice returns `{applied:false}` the second time; `blockConcurrencyWhile` serializes two concurrent `apply()` calls |
| **Workflow steps** (MorningChain) | `env.MORNING_CHAIN.create({id, params})`, poll `instance.status()`; stub `invokeAgent` to throw on a chosen step | Forge step exhausts retries → instance `errored`; Sundial/Compass steps never executed; completed `filer`/`herald` results memoized (not re-run) on a forced restart |
| **Cron dispatch** (Atlas) | `wrangler dev --test-scheduled` then `curl "http://localhost:8787/__scheduled?cron=45+12+*+*+*"` | The `switch (controller.cron)` routes the exact string to the right agent; `cron` param must string-match `triggers.crons` |

**Contract test for the Wire event shape (mandatory, shared across all 11 producers).** One zod schema is the single source of truth; every producer imports it, and a contract test asserts each agent's emitted events parse:

```typescript
// src/wire/contract.ts — the canonical Wire shape, imported by EVERY producer + Steward
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

// src/wire/contract.test.ts — runs in CI for every agent PR
it("Forge emits a contract-valid increment", () => {
  const evt = buildForgeTaskEvent(sampleTask);
  expect(() => WireEvent.parse(evt)).not.toThrow();
  expect(evt.op).toBe("increment");
  expect(evt.idempotencyKey).toMatch(/^forge:task:\d{4}-\d{2}-\d{2}:/); // stable, replay-safe
});
```

**Idempotency / replay test (mandatory per agent).** The single test that proves Pillar 5 end-to-end:

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

> **Definition of done for any agent PR:** (a) a Wire contract test for its emitted events, (b) a replay test through Steward, (c) a failure-path test asserting the right Flagger severity. No agent merges without all three.

---

### 2. Observability & Flagger-from-day-0

**Flagger (#15) is a Phase 2 *Worker*, but its data substrate is Phase 0.** The argument: Flagger raises flags by *reading* `run_log` + `audit_log` and by reconciling counters against the D1 ledger. If those tables only appear when Flagger ships, then Phases 0–1 (the spine and the entire morning chain) run blind, and there is no historical signal for Flagger to score on day one. So the schema lands in Phase 0 migration `0001`; Flagger in Phase 2 is purely a *reader + router* over data that already exists.

**Three observability planes, all provisioned in Phase 0:**

```sql
-- migrations/0001_init_core.sql  (Phase 0) — exists BEFORE Flagger
CREATE TABLE run_log (             -- every agent pass: who ran, when, cost of the query
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT, type TEXT, entity TEXT, op TEXT,
  rows_read INTEGER, rows_written INTEGER, duration_ms INTEGER,
  ts INTEGER NOT NULL);
CREATE TABLE audit_log (           -- security forensic record (docs/11 §8)
  id TEXT PRIMARY KEY,             -- ulid
  ts INTEGER, agent TEXT, action TEXT, target TEXT,
  scope_used TEXT,                 -- proves least-privilege at runtime (NOT the token)
  gated INTEGER, decision TEXT,    -- auto|approved|rejected|expired
  outcome TEXT, trust INTEGER, consent_flag INTEGER, flag_id TEXT);
CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, agent TEXT, applied_at INTEGER);
CREATE TABLE counters (entity TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
```

Every agent pass writes a `run_log` row (use `D1Result.meta.rows_read/rows_written/duration` from the pass's own queries — these are the billing-relevant counters). Every *action* (suggest- or gated-class, success or failure) writes an `audit_log` row recording `scope_used`, never the token.

**Severity / trust routing (the contract Flagger reads).** Severity is **set deterministically by the source signal**, not by an LLM; trust is the confidence the flag is real. A caught exception in a critical-path agent maps to P1/P2 by rule; an LLM hunch maps to P3 because the *consequence* is "human glance."

| Signal (from day-0 data) | Severity | Trust band | Routing |
|---|---|---|---|
| Stale heartbeat (no Compass run by 08:30 + grace) | **P1** | 100 | push now |
| Workflow step errored after retries (Forge threw) | **P2** | 90–100 | push today |
| Counter ↔ D1 ledger drift (detected Fri 16:30 rebuild) | **P3** | mid | batched feed |
| Rate-limit backoff that self-recovered | **P4** | high | batched feed |

Wire the hooks in Phase 0/1 even though Flagger consumes them in Phase 2: a thrown `scheduled()`, a halted Workflow step, a Steward retry-exhaustion, and a DLQ landing each emit a Flagger Wire event `{agent, type, entity:"flagger", op:"increment", payload:{severity, trust, kind}, idempotencyKey}`. Until the Flagger Worker exists, those events are still recorded by Steward into `run_log`/`audit_log`, so the history is intact.

**AI Gateway logs are the model-observability mirror, not the source of truth.** Attach `cf-aig-metadata: {"agent":"<codename>","mode":"<sweep|push|full>"}` to *every* Claude call (set once in the `claudeFor` factory, §6) so Gateway Costs/Logs filter by agent and mode. Per Pillar 4, **D1 remains the system-of-record**; verify the free-tier log row limit before relying on Gateway logs for spend reconciliation.

> **Acceptance:** before any Flagger code exists, querying `run_log` shows one row per agent pass with non-null `rows_read`/`duration_ms`, and a forced agent exception leaves an `audit_log` row with `outcome="error"`.

---

### 3. Idempotency & replay discipline

Cloudflare Queues is **at-least-once with best-effort (not FIFO) ordering**. Replays *will* happen — on partial-batch failure, on missed-cron catch-up, on a network blip after a server-side success. The compensating design is mandatory, not optional.

**`idempotencyKey` generation rules:**
- **Deterministic, never random.** `forge:task:2026-05-31:<contentHash>`, `sundial-<runDate>`, `usher:gate:<draftId>`. Never `crypto.randomUUID()` for scheduled work — a stable key is what makes a re-fired cron a no-op.
- **One logical event = one key.** A counter bump for "tasks_open +1 for task t-9001 today" has exactly one key regardless of how many times it's delivered.
- **Workflow instance `id` is the trigger-level idempotency handle:** `morning-${date}` (≤100 chars). Re-creating an existing id errors rather than double-running, so a re-fired 07:45 cron is safe.

**The seen-keys store is D1, never KV.** KV caps at 1 write/s per key and lags ≤60s globally — wrong for both counters and idempotency keys. The ledger lives in D1 (or the Steward DO's SQLite, same guarantee).

**At-least-once handling — the atomic critical section.** The ledger insert and the counter bump must be *one* transaction, or a crash between them double-counts:

```typescript
// Steward: dedup-check + counter-bump in ONE atomic span. D1 batch() = all-or-nothing transaction.
const insertKey = env.DB.prepare(
  "INSERT OR IGNORE INTO idempotency_keys(key, agent, applied_at) VALUES (?,?,?)"
).bind(e.idempotencyKey, e.agent, Date.now());
const bump = env.DB.prepare(
  `INSERT INTO counters(entity, value) VALUES (?, ?)
   ON CONFLICT(entity) DO UPDATE SET value = value + ?
   WHERE EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ?1AND applied_at = ?)`
).bind(e.payload.counter, e.payload.delta ?? 1, e.payload.delta ?? 1);
const [keyRes] = await env.DB.batch([insertKey, bump]);   // atomic
if (keyRes.meta.changes === 0) return { applied: false };  // replay → mutation skipped
```

If running inside the Steward DO, wrap the same span in `ctx.blockConcurrencyWhile(...)` so the DO's single-threaded-per-id guarantee serializes even the Fri 16:00 Scout + weekly-Herald fan-in. Do the slow Obsidian MCP write **outside** the locked span (the lock holds only dedup + ledger + counter), so a slow/unreachable bridge doesn't stall the whole Wire.

**Three Atlas-specific replay realities to test:**
1. **Out-of-order arrival** — the morning chain emits events that may land out of order. Causal correctness comes from the Workflow sequencing, *not* from Wire order. Steward must tolerate any arrival order.
2. **Missed crons are not auto-replayed by Cloudflare** — each pass must be idempotent (Filer skips `AI/Reviewed`) so the next run catches up; log missed runs to the run-log.
3. **DLQ is mandatory** — without `dead_letter_queue`, events that exhaust `max_retries` are *dropped silently*. Create `atlas-wire-dlq` and give it a consumer (or have Flagger watch it) so dead events become incidents.

> **Acceptance:** the §1 replay test (`apply` twice → counter = 1), plus a "DLQ produces a P2/P3 flag, never silent loss" test.

---

### 4. Secrets & least-privilege

**Secrets Store, not `wrangler secret put`, for long-lived provider credentials.** Google refresh token, Google client secret, GitHub App private key, the Anthropic key, the AI-Gateway token, and the bridge token all live in the single account Secrets Store (open-beta limit: **one store per account** — plan binding names, not multiple stores). Access is **async**: `await env.GOOGLE_REFRESH_TOKEN.get()`. Reserve `wrangler secret put` for high-churn values. Secrets never appear in `[vars]`, KV, the Codex, the Vault, or `audit_log` (which records `scope_used`, not the token).

```toml
[[secrets_store_secrets]]
binding = "GOOGLE_REFRESH_TOKEN"
store_id = "<atlas-store-id>"        # reuse the one store_id everywhere
secret_name = "google-refresh-token"
```

**Per-MCP scope mounting (enforced server-side, in two places).** A prompt instruction telling an agent "don't delete" is *not* sufficient. Scope is enforced (a) at the inbound OAuth provider's `scopesSupported` allow-list, and (b) inside the MCP Worker's tool handler with a 403. Filer's Google MCP binding *physically holds only* `gmail.modify` and has **no code path** to a delete/trash endpoint — `gmail.modify` cannot delete (that needs the full `https://mail.google.com/` scope, which Atlas never grants). This is Pillar 2 enforced at the API boundary, not by prompt.

Scope floor per agent (the least-privilege table the connect-gate verifies):

| Agent(s) | Provider scope | Why it cannot do more |
|---|---|---|
| Filer, Herald | `gmail.modify` | cannot delete/archive — the scope itself forbids it |
| Sundial, Usher | `calendar.events` | no `events.delete` on the autonomous path (`allowDelete:false`) |
| Compass (read leg) | `calendar.readonly` | cannot write |
| Steward exports, Archivist | `drive.file` | only files Atlas created |
| Quill, Envoy, Archivist (read) | `drive.readonly` | Codex reads only |
| Envoy (brand write) | GitHub App, `contents:read` floor | write is **gated** — having the scope ≠ silent execution |

**The "Connect a new MCP" 10-step checklist — a reusable gate run on every new external connection (§11):**

1. **Define the scope floor** — the narrowest provider scope that works; add it to `scopesSupported`.
2. **Mint the secret into Secrets Store** (`secrets-store secret create`, `--scopes workers`), bind it; create a non-remote dev copy for `wrangler dev`.
3. **Deploy the MCP Worker** with `compatibility_flags: ["nodejs_compat"]` (required by the `agents` package) and a recent `compatibility_date`.
4. **Register the inbound OAuth client** (`createClient`) carrying *only* the agent's scopes; for Google, the authorize URL uses `access_type=offline&prompt=consent` (else the refresh token is silently lost).
5. **Enforce scope server-side** — 403 in the tool handler for any out-of-scope call; verify no code path reaches a destructive endpoint.
6. **Gate every destructive/outward tool** on `this.props.permissions` — return a draft, never execute silently.
7. **Require `idempotencyKey` on every mutating tool** (matches the Wire shape).
8. **Emit a Wire event on every mutation and on every tool error** (→ Flagger).
9. **Strip security content server-side** — the Google MCP never returns 2FA codes / reset-link bodies regardless of scope.
10. **Assert one-writer-per-resource** — exactly one agent connects to any given write tool (only Steward → Obsidian write; only Sundial → `calendar.events` write).

> **Acceptance for a new MCP:** a token lacking `gmail.modify` gets 403 from Filer's label tool; an over-broad GitHub installation-token request is rejected by GitHub; `lsof -i -nP | grep LISTEN` on the laptop shows only Obsidian's `127.0.0.1:27124` (the bridge opens *no* inbound port).

---

### 5. Local dev & deploy

**Local loop:** `wrangler dev` runs producers + consumers + DOs against the local `workerd` runtime (DOs persist to `.wrangler/state`; `--test-scheduled` exposes `/__scheduled`). **Critical gotcha:** `wrangler dev` forces `TZ=UTC` to match production, so `new Date()` is UTC even on the owner's laptop — never assume local time when computing "today" for Compass/Herald; derive owner-local time explicitly via `Intl` with a fixed IANA zone (`America/Toronto`).

**Environments — staging vs prod via per-environment cron overrides.** The single biggest deploy footgun is a staging deploy firing the real morning chain. Solved with `env.<name>.triggers.crons`:

```jsonc
{
  "name": "atlas",
  "triggers": { "crons": ["45 12 * * *", "0 13 * * *", /* ...full prod schedule (UTC) */ ] },
  "env": {
    "staging": { "triggers": { "crons": [] } }   // staging fires NO crons — manual /__scheduled only
  }
}
```

> **Timezone policy (resolves the open question in docs/03 §6 and docs/06 §12):** Cron Triggers are **UTC-only, no DST**. Atlas adopts **UTC-translation-with-DST-edits**: every owner-local §10 line is hand-translated to UTC (07:45 ET = `45 11 * * *` in EDT / `45 12 * * *` in EST) and the cron expressions are re-derived at each DST boundary. Internal step budgets use `step.sleepUntil` with a tz-correct `Date`; only the *trigger* cron needs the twice-yearly edit. Document the EST/EDT table next to `triggers.crons`.

**CI (GitHub Actions):** lint → typecheck → `vitest run` (vitest-pool-workers) → `wrangler deploy --dry-run` on PR; on merge to the default branch, `wrangler deploy --env staging`; on tag, `--env production`. The Wire contract test, the replay test, and the security-invariant tests (§7) are CI gates — a red one blocks merge.

**Migrations — the only path to schema change.** D1: `wrangler d1 migrations create`/`apply` (tracked in the auto-managed `d1_migrations` table; `--local` for dev, `--remote` for prod; **never hand-edit remote schema**). DO classes: migration tags are unique, applied in order, immutable once deployed — all Atlas DOs use `new_sqlite_classes` (not the legacy `new_classes`); renames go in a *new* tag via `renamed_classes`.

> **Acceptance:** `wrangler deploy --env staging` shows empty crons under Settings → Triggers; `wrangler d1 migrations apply --local` is a no-op on a clean DB after first run.

---

### 6. Cost control

**Model tiering in config, not code (Pillar: "pick the model per agent in config").** A shared `[vars]` map sets the default tier; a KV key `model:<codename>` overrides it at runtime so the owner can re-tier without redeploy (e.g. bump Filer to Sonnet during a noisy-inbox week). Use the **dateless 4.6+ pinned IDs** — they are reproducible snapshots, not evergreen aliases. Do **not** pin the deprecated `claude-*-4-20250514` (retire 2026-06-15).

| Tier | Model ID | Agents |
|---|---|---|
| Opus (reasoning) | `claude-opus-4-8` | Atlas, Compass, Archivist |
| Sonnet (balanced) | `claude-sonnet-4-6` | Forge, Herald, Scout, Headhunter-full |
| Haiku (high-volume) | `claude-haiku-4-5` | Filer (continuous + sweep), Headhunter board-scan |

**AI Gateway caching = the Codex pattern.** The Codex (read-only personal facts) and per-agent label taxonomies are stable across calls — put them in a `system` `TextBlockParam` with `cache_control:{type:"ephemeral",ttl:"1h"}`. This is what makes Filer's continuous labeling cheap: the taxonomy is cached at **0.1× read cost** across the entire 07:45 sweep and the Gmail-push stream. (Note: Anthropic prompt caching ≠ the Gateway's exact-match response cache — the latter almost never hits for Filer since each email batch differs. The savings come from `cache_control`.)

**Per-agent spend caps via one gateway per cost domain.** AI Gateway rate-limit/spend caps are configured **per gateway**, not per request and not in `wrangler.toml`. Atlas runs two gateways so a runaway agent is contained:
- `atlas-reasoning` (Opus agents) — modest rate limit.
- `atlas-highvolume` (Filer/Headhunter Haiku) — this is the lever the spec calls out: Filer's continuous run must "stay affordable," so cap *this* gateway's spend/rate.

`cf-aig-metadata:{agent}` gives per-agent cost attribution in the Costs view for soft caps; the hard cap is the gateway-level rate limit (set via dashboard or REST `PATCH .../ai-gateway/gateways/<id>`).

**Other levers:** `claude-opus-4-8` defaults `effort` to `high` — set it lower explicitly for the cheaper Compass/Archivist passes or pay for max reasoning every call. For bulk D1 reads (Headhunter/Forge scans) use `.raw()` and avoid `SELECT *` to cap `rows_read`. For R2, write one audio blob per Echo session (not per frame) to keep Class-A operations down.

> **Acceptance:** `msg.usage.cache_read_input_tokens > 0` on the second Filer call in a sweep (proves cache hit); the `atlas-highvolume` gateway has a configured rate limit visible in the dashboard.

---

### 7. Security invariants as automated checks

The three load-bearing invariants are mechanical checks, not review-time vigilance. Each is a CI gate.

**(a) Never emit 2FA codes / reset links in any digest or shared Vault view.** Enforced in three layers: (1) the Google MCP strips `Type/Security` bodies server-side before they ever reach an agent; (2) Herald/digest builders run output through a redaction pass; (3) a unit test feeds known 2FA/reset fixtures through the digest builder and asserts none survive. A caught attempt to expose a code is a **P1** (block + flag, per docs/11 §8.1).

```typescript
// src/security/redact.test.ts — CI gate
const SECRET_PATTERNS = [/\b\d{6}\b/, /reset[-_ ]?(password|link)/i, /verification code/i,
                          /https?:\/\/\S*\/(reset|verify|confirm)\S*/i];
it("digest output never contains a 2FA code or reset link", () => {
  const digest = buildHeraldDigest([securityMailFixture]);   // Type/Security fixture
  for (const p of SECRET_PATTERNS) expect(digest).not.toMatch(p);
});
```

**(b) Confirmation gates — default = draft + ask, never fail-open.** Every gated action (Envoy publish, Usher register/pay, *any* delete) writes a `pending` `audit_log` row, emits ≥P2, and parks the Workflow at `step.waitForEvent("owner.confirm", {timeout})`. A decline throws `NonRetryableError`; **a timeout expires to `expired` with no action taken** (fail-safe, never fail-open). Two `audit_log` rows per gated action (the `pending` decision + the terminal outcome) make the trail reconstructable.

```typescript
it("a gated action is never executed without explicit approval", async () => {
  const inst = await env.GATED_WF.create({ id: "usher-test", params: { draftId: "d1" } });
  await waitFor(() => inst.status().then(s => s.status === "waiting"));   // parked, not executed
  // timeout path → expired, NOT executed:
  expect(executedActions).toEqual([]);
});
it("decline throws NonRetryableError and does not execute", async () => { /* sendEvent approved:false */ });
```

**(c) One-writer-per-resource (Pillar 1).** Enforced by the runtime (a single named DO instance `env.STEWARD_LOCK.getByName("vault")` is the sole serialized Vault writer; Steward is the *only* `[[queues.consumers]]` on `atlas-wire`) **and** by a CI structural check that greps the codebase: exactly one Worker may declare a consumer on `atlas-wire`; only Steward's binding may reach the Obsidian write tool; only Sundial's binding may reach `calendar.events` write. A second consumer or a second writer fails CI.

```bash
# CI: assert exactly one Wire consumer (Steward). >1 = Pillar-1 violation, fail the build.
test "$(grep -rl 'queue *= *"atlas-wire"' --include=wrangler.* | \
        xargs grep -l 'queues.consumers' | wc -l | tr -d ' ')" = "1" \
  || { echo "FAIL: more than one consumer on atlas-wire"; exit 1; }
```

> **Acceptance:** the redaction test, the gate fail-safe test, and the one-writer grep all run in CI and block merge; the build is red if a second `atlas-wire` consumer is ever introduced.

---

## 6. Execution Sequence, Metrics & Decision Log

This section turns the phase plan into an ordered, gated build, defines exactly **how** each success metric is measured inside the system (which D1 table, run-log field, or Flagger event), and resolves the open questions from [docs/06 §12](06-hosting-cloudflare-mcp.md) and [docs/12 (open questions)](12-roadmap.md) with a recommended answer + rationale for each.

Effort is **relative, not calendar-dated** — single-owner velocity is unknown until the spine ships (docs/12). Re-baseline after M1.

---

### 1. Execution sequence — milestones M0..M8

Milestones map to the 6 build phases. Each milestone has a single, testable **exit criterion**; a milestone is not "done" until its criterion passes against the real deployment, not a mock.

```
M0 ─▶ M1 ════ MVP ════╗
                      ╠─▶ M2 ─▶ M3 ─▶ M4 ─▶ M5 ─▶ M6 ─▶ M7 ─▶ M8
  Phase 0   Phase 1   ║   P2     P2     P3     P3     P4     P5     P5
  SPINE     CORE LOOP ╝ Weekly  Flagger Echo→  Quill Outward Switch- Librarian
                                       Archiv.        (gated) board
```

> **The MVP = M0 + M1** — Phase 0 SPINE **plus** Phase 1 CORE LOOP: **Filer → Herald → Forge → Sundial → Compass** + the **Steward** dashboard. Ship this, live on it, then decide whether the local-capture (M4/M5) and outward (M6) milestones are worth their risk (docs/12 verdict).

| Milestone | Phase | Builds (codenames) | Primitives stood up | Exit criterion (acceptance) |
|---|---|---|---|---|
| **M0 — Spine** | 0 | **Atlas**, the **Wire**, **Steward**+**The Vault**, **The Codex** | CF project; `wrangler.jsonc` with `triggers.crons`; `atlas-wire` Queue + `atlas-wire-dlq`; `StewardWriter` DO (`new_sqlite_classes`); D1 `atlas-db` migration `0001` (idempotency_keys, counters, run_log, audit); KV `CONFIG`; R2 `atlas-blobs`; Workers OAuth Provider (`OAUTH_KV`); Secrets Store (Google refresh token, GitHub App key, `ANTHROPIC_API_KEY`, `CF_AIG_TOKEN`); two AI Gateways; Obsidian local-REST bridge + `vault_outbox` | **Idempotency proof:** replaying the same Wire event twice through `atlas-wire` leaves the counter unchanged (`meta.changes === 0` on the second `INSERT OR IGNORE`), and the resulting absolute value lands in `Counters/metrics.md` frontmatter via the outbound bridge. Google + GitHub OAuth round-trip; a refresh call returns a fresh access token without re-consent. `lsof -i -nP \| grep LISTEN` on the Mac shows **only** Obsidian's `127.0.0.1:27124` — no inbound port. |
| **M1 — Core loop (MVP)** | 1 | **Filer → Herald → Forge → Sundial → Compass** | One cron (`45 12 * * *` UTC = 07:45 ET) → one `MorningChain` **Workflow** (`MORNING_CHAIN`), 5 start-after-success steps; per-agent model tiering in KV; Filer Gmail push (`users.watch` + daily renewal cron `0 11 * * *`) | A real **08:00 digest** lands as a **draft** to the owner; `① Action Required` threads become Forge tasks with deadlines; deadline tasks appear on Google Calendar (`agent=sundial` extendedProperty); the Vault **Today** view shows Compass's top-3 + the morning-glance set. **Resume proof:** killing the instance mid-`forge-morning` resumes at Forge (Filer/Herald memoized, not re-run); exhausting Forge retries leaves Sundial/Compass unrun and emits a **P2 High** to Flagger. `instance.id = morning-${date}` makes a re-fired cron a no-op. |
| **M2 — Weekly value** | 2 | **Scout**, **Headhunter** | Independent crons: Headhunter daily-light `0 14 * * *`, full `0 14 * * 1`; Fri 16:00 `0 21 * * 5` runs Scout-weekly ∥ Herald-weekly via `Promise.all`; weekly-review build `30 21 * * 5` | Friday events digest + weekly email review land; Headhunter creates "apply by X" tasks and updates the job-pipeline counts; low-confidence hiring-window finds route to a **flag**, not silently to a task. |
| **M3 — Flagger online** | 2 | **Flagger** | Event-driven flag intake; deterministic severity map (P1–P4); trust score 0–100; P1/P2 push, P3/P4 batched feed; **separate Cron watchdog** Worker reading `last_seen` from KV | A caught exception in a critical-path agent deterministically produces P1/P2 + push; an LLM phishing hunch → P3; the watchdog pushes **"Flagger may be down" (P1)** if Flagger goes quiet past threshold. Flagger board sorted by severity then trust. |
| **M4 — Capture: Echo→Archivist** | 3 | **Echo** (local), **Archivist** (cloud) | Local macOS daemon (launchd); `EchoSession` DO (Hibernation API, `getByName(echo-<ts>)`); R2 `audio/raw/` (7-day lifecycle) + `transcripts/` (persist); presigned-URL upload | A meeting session streams diarized segments over the WebSocket; Archivist writes a structured note (via Steward); **raw audio never leaves the device except as the approved derived transcript**; daemon reconnect after a mid-session drop rehydrates the same session DO. |
| **M5 — Quill** | 3 | **Quill** (local) | Reuses the M4 outbound-auth daemon; `drive.readonly` Codex reads only | Hotkey-triggered screen autofill from the Codex; **never autonomous**, never writes the Codex back; screen pixels never leave the device. |
| **M6 — Outward (gated)** | 4 | **Usher**, **Envoy** | Gated Workflows using `step.waitForEvent('owner.confirm', { timeout: '24 hours' })` + `instance.sendEvent`; decline → `NonRetryableError` | **Confirmation-gate adherence = 100%:** no register/pay (Usher) or public post (Envoy) fires without an explicit owner confirm; captcha/payment is a hard stop handed to the human; an unanswered gate expires rather than silently erroring. |
| **M7 — Switchboard** | 5 | **Switchboard** | (design-time; see Decision D7) | Capability routing is consulted when a new tool is needed; **does not run in the loop**. |
| **M8 — Librarian + polish** | 5 | **Librarian** | Prompt-library table; dashboard refinement | Save prompt → Title link · Tags · Tool · Last used row in the Vault prompt-library table. |

**Hard edges (cannot reorder):** Filer **before** Herald · Forge **before** Sundial · Forge + Calendar **before** Compass · Echo **before** Archivist · Headhunter **into** Forge. **Soft edges:** M2/M3 before M4 (cloud-before-local); M6 last (gate maturity).

---

### 2. Success-metrics instrumentation

D1 is the **system-of-record** for every counter; `Counters/metrics.md` frontmatter is a **rendered projection** Steward keeps in sync (docs/05). Every metric below names the concrete D1 table / run-log field / Flagger event that produces it — no metric is computed by eyeballing the Vault.

#### Headline three

| Metric | Target | How it is measured in the system |
|---|---|---|
| **Minutes saved/day** | **≥ 20 min/day** | **Pre-launch one-week manual baseline (below)** minus post-launch time-on-task. The system side stores `digest_delivered` and `dayplan_ready` events in D1 `run_log` (`agent`, `type`, `ts`); the *saved* number is `baseline_minutes − owner_self_report`. There is no purely-automatic measurement — the baseline makes the metric falsifiable; without it the headline is unfalsifiable (docs/12 open question). Record the weekly owner self-report as a `metrics.minutes_saved_7d` frontmatter value upserted by Steward. |
| **% action-required caught** | **≥ 95%** | Denominator = threads the owner confirms genuinely needed action (logged via a Vault "missed?" review during the morning glance); numerator = threads that received `① Action Required` (Filer) **and** became a Forge task. Computed from D1: `tasks` rows joined to the Filer label-event `run_log` rows by thread id. A miss writes a **P3 Medium** Flagger flag (`kind: action_required_miss`) — misses are the metric that matters most, so they are individually visible, not just aggregated. |
| **Deadlines missed** | **= 0 (hard zero)** | Every Forge/Headhunter "due by X" is a `tasks` row with a `due` timestamp; Sundial stamps the matching Calendar event (`extendedProperties.private.atlasTaskId`). A nightly check (Compass 21:00 preview leg) finds any `due < now` task with no completed/calendar match and emits a **P2 High** Flagger incident (`kind: deadline_missed`). One miss = one incident; the count is `COUNT(*)` of open `deadline_missed` flags in D1 `audit`. |

#### Supporting metrics

| Metric | Target | Source field / table | Flagger hook |
|---|---|---|---|
| Digest accuracy | ≥ 95% items correct on spot-check | Owner spot-check logged to `run_log` (`type=digest.review`) | mis-prioritized item → P3 |
| False-positive `① Action Required` | ≤ 10% | Filer label events vs owner "not actually action" review, in `run_log` | — |
| Tasks needing manual correction | ≤ 1/day | `tasks` rows with an owner-edit audit entry in D1 `audit` | — |
| Pipeline freshness (counters = reality) | 100% | Fri 16:30 weekly build **re-scans** `Tasks/`/`Jobs/`/`Events/` and compares to `counters`; drift = `rebuild metrics.md` | **P3 Medium** `kind: counter_drift` |
| Morning-chain success rate | ≥ 99% of days | `MorningChain` `instance.status()` mirrored to D1 `run_log` per step boundary | halted step → **P2 High**; stale heartbeat (no run by 08:30+grace) → **P1 Critical, trust 100** |
| Flagger noise (actionable share) | ≥ 70% acted-on vs muted | flag `status` transitions (ack/resolve vs mute) in D1 | — |
| **Security invariant** | **Zero** 2FA codes / reset links surfaced | Enforced **server-side** in the Google MCP (strips secret bodies regardless of scope), not by prompt; any leak attempt logged to `audit` | leak attempt → **P1 Critical** |

#### Gating metrics (block M6 / Echo promotion past draft-mode)

| Gate | Target | Source |
|---|---|---|
| Confirmation-gate adherence | 100% | Every gated `step.waitForEvent` resolution logged to `audit` with the `owner.confirm` payload; an outward action with no preceding confirm event is impossible by construction and any attempt is a **P1**. |
| Consent capture (Echo) | 100% | Per-session consent stamp in the `EchoSession` DO before the first segment write; missing stamp blocks recording. |

#### The one-week pre-launch manual baseline (required before M1 go-live)

Before the morning chain is switched on, the owner manually times, for **one week**:

1. **Inbox triage** — minutes/day reading + sorting email that Filer/Herald will replace.
2. **Day planning** — minutes/day building the to-do/priority list that Compass will replace.

Record the daily figures; the 7-day mean is `baseline_minutes`. This single number is the denominator the **≥ 20 min/day** headline is judged against — it is the explicit answer to the docs/12 open question and **must** be captured before launch or the metric is unfalsifiable.

---

### 3. Decision log

Resolves every open question in [docs/06 §12](06-hosting-cloudflare-mcp.md) and [docs/12](12-roadmap.md). Each is **Decided** with a one-line rationale; update the source docs to match.

| # | Open question | Decision | Rationale (one line) |
|---|---|---|---|
| **D1** | **Cron timezone vs DST** (docs/03 §6, docs/06 §12) | **UTC crons + a documented EST/EDT translation table, hand-edited at the two DST boundaries.** Keep a comment block in `wrangler.jsonc` mapping each owner-local line to its UTC cron (`07:45 ET = 45 12 * * *` EST; subtract 1h for EDT). Internal budget gates use `step.sleepUntil` with a tz-correct `Intl` zone, so only the *trigger* crons need the twice-a-year edit. | Cloudflare Cron Triggers are UTC-only with no DST handling, so there is no "owner-local cron" to lean on — explicit translation is the only correct option. |
| **D2** | **D1 ↔ Vault reconciliation on manual edits** (docs/06 §12) | **D1 is authoritative; the Vault is a rendered view.** Manual Vault edits are **not** treated as truth for counters — the **Fri 16:30 weekly build re-derives** `Counters/metrics.md` from D1 (`Tasks/`/`Jobs/`/`Events/` re-scan) and overwrites drift, emitting a **P3 Medium** `counter_drift` flag. Per-entity *content* notes the owner edits by hand are left alone; only Steward-owned counter/status frontmatter is reconciled. | Pillar 4 (single source of truth) + pillar 1 (one writer): if a hand-edit could redefine a counter, replays and double-counts become unresolvable. |
| **D3** | **R2 audio retention window** (docs/06 §12) | **Raw Echo audio expires at 7 days** via an R2 lifecycle rule on the `audio/raw/` prefix **only**; derived `transcripts/` and `exports/` have **no expiry** (persist). Raw upload goes direct from the local daemon via presigned URL so bytes never proxy through a Worker. | Satisfies the SPEC §12 privacy boundary mechanically (raw is local-first, only approved derived artifacts persist) while the prefix split guarantees the expire rule can never touch a transcript. |
| **D4** | **Local-daemon transport (mTLS vs OAuth-bearer) + heartbeat→Flagger severity** (docs/06 §12) | **OAuth-bearer over an outbound-only pull/long-poll** (daemon registered as a confidential client via the Workers OAuth Provider, presents `ATLAS_BRIDGE_TOKEN`; **no inbound port, no published tunnel**). Heartbeat: daemon beats on each poll; **stale > grace → P1 Critical, trust 100** (it's a deterministic missed-run, same class as a stale agent heartbeat); a *single* failed write that retries successfully → P4. | OAuth-bearer reuses the same outbound auth Echo/Quill already need, avoids cert lifecycle on the laptop, and keeps the "no inbound port to the laptop" invariant; a dead daemon means a stale dashboard, which is fleet-critical. |
| **D5** | **Workers AI vs Anthropic-direct per agent + per-agent cost ceiling** (docs/06 §12) | **All reasoning/synthesis agents call Claude via AI Gateway** (Opus `claude-opus-4-8`: Atlas, Compass, Archivist · Sonnet `claude-sonnet-4-6`: Forge, Herald, Scout, Headhunter-full · Haiku `claude-haiku-4-5`: Filer, Headhunter-light). Tier is read from KV (`model:<codename>`) so it's re-tunable without redeploy. **Workers AI is used only as Filer's fallback backstop** (Universal Endpoint → Llama) during an Anthropic outage — reasoning agents do **not** fall back to a weaker model. **Cost ceiling: two gateways per cost domain** — `atlas-reasoning` (Opus) and `atlas-highvolume` (Filer/Headhunter Haiku) — each with its own dashboard rate-limit/budget; per-call `cf-aig-metadata:{agent}` gives per-agent cost attribution. | Per-gateway is the only place CF enforces a *hard* budget; isolating the continuous Filer path into `atlas-highvolume` is exactly the lever that keeps the always-on labeler affordable, and a degraded plan is worse than a failed-and-resumed Workflow step. |
| **D6** | **Quill phase placement** (docs/12) | **Keep Quill in Phase 3 (M5), immediately after the Echo daemon (M4) exists** but with **no Echo data dependency** — it ships once the local outbound-auth runtime is proven, before the outward phase. | Quill needs the same local macOS daemon + outbound-auth plumbing as Echo, so co-locating it amortizes that one-time runtime cost; it stays out of M6 because it's convenience, not outward-risk. |
| **D7** | **Switchboard: coded agent or design-time habit?** (docs/12) | **Design-time habit, not a runtime-coded agent (M7 is a doc/process milestone, not a deployed Worker).** Switchboard is consulted ad hoc when a new capability/MCP tool is needed; it **does not run in the loop**. Revisit coding it only if the fleet grows enough to feel routing pain. | The roster already marks Switchboard "design-time only" and "doesn't run in the loop" — building a Worker for a thing that never fires in production is pure overhead. |


---

## 7. Owner inputs still needed

The decision log (§6.3) resolves every *architectural* open question (D1–D7) with a recommended answer. What remains are **human-judgment calls and commitments** only the owner can make. Grouped by when they block you — none block *reading* the plan, but each blocks the work it's filed under.

### Decide before scaffolding (Phase 0 / §1)

- **Package manager** — drafted as **pnpm** (workspace support is the only hard requirement). Swap to npm/bun if you standardize on one elsewhere. *Confirm before `npm create cloudflare`.*
- **Worker granularity** — drafted as **one Worker per agent** (max least-privilege isolation). Grouping the low-risk Phase-1 agents is acceptable to cut deploy overhead **only if** Steward stays its own Worker (sole Wire consumer) and Filer stays its own (`gmail.modify`-only boundary).
- **Per-Worker cron count cap** — verify the *current* limit before committing to a single Atlas dispatcher Worker (~10 schedule lines by Phase 2). Workers Paid (already required) should lift it; otherwise split crons across Workers.
- **AI Gateway dollar/rate ceilings** — there is **no per-agent hard-budget primitive**, only per-gateway. The plan provisions two gateways (`atlas-reasoning`, `atlas-highvolume`); you must set the actual numbers in the dashboard before Filer's continuous push goes live.
- **`compatibility_date` pin** (`2026-04-25` drafted) and the **heartbeat staleness threshold** (`5 min` drafted for the Atlas self-P1) — confirm or adjust.
- **DST operational burden** — D1 commits to UTC-cron + twice-yearly hand-edits at the EST/EDT boundary. Accept the chore, *or* pin a fixed offset (≤1h drift half the year), *or* build a tiny self-check that flags when the configured cron no longer maps to owner-local 07:45.

### Decide before MVP go-live (Phase 1 / §3)

- **`invokeAgent` transport** — service-binding RPC (in-account, zero-HTTP — **recommended**) vs `fetch` to a Worker URL vs inlining each pass into the Workflow Worker. Pick one before building so step return shapes are fixed.
- **Herald output surface** — keep the **Gmail draft digest** (v1 plan) or go Vault-morning-glance-only, since both surface the same Action-Required set. And on Fridays: suppress the 08:00 daily digest or keep both daily + the 16:00 weekly review.
- **Compass Opus `effort`** — set an explicit level below the `high` default for the daily plan pass (cost), surfaced as a KV-overridable setting, not hardcoded.
- **The two manual measurement commitments** — without them the headline metrics are unfalsifiable: (a) the **one-week pre-launch baseline** of inbox-triage + day-planning minutes, captured *before* M1 go-live; (b) a daily **~1-minute "did Atlas miss anything?" review** during the morning glance, which is the ground truth for the ≥95% action-required-caught metric.
- **Morning-chain success-rate window** — rolling 30 days vs since-launch — pick one so the ≥99% metric is reproducible.

### Decide later (Phases 2–4)

- **Idempotency-ledger retention** — keep-forever (recommended at single-owner scale) vs TTL (risks a very-late replay double-counting).
- **DLQ consumer ownership** — a dedicated `atlas-wire-dlq` watcher Worker that re-emits dead events as Flagger Wire events (keeps Flagger's only input the Wire — recommended) vs Flagger consuming the DLQ directly.
- **Security redaction placement** — Google-MCP server-side stripping as the single enforcement point (recommended) + a digest-builder unit test as the backstop, vs duplicating the redaction in every digest builder (defense-in-depth, more surface).
- **Flagger calibration** — tune trust bands from real outcomes over the first weeks; decide whether an un-ack'd P1 escalates to a *second* channel (SMS/email) after a longer window or just re-pushes.
- **Echo (Phase 3)** — system-audio loopback path (virtual audio device vs ScreenCaptureKit audio — affects the OS-permission UX); two-party-consent posture (a standard "this call may be recorded" notice; whether `consent.require` flips by locale); owner-approved raw-audio retention beyond the 7-day `audio/raw/` expiry.
- **Envoy (Phase 4)** — LinkedIn degrades to "open the form pre-filled, owner saves" (no friendly write API; browser flow is brittle/ToS-sensitive) vs full automation; X via the paid API (cleaner) vs browser (free, fragile); lock the `idempotencyKey` granularity.
- **Usher (Phase 4)** — who flips `registered → attended` and when (post-event check / owner tap / calendar heuristic); whether a cancellation decrements the counter + removes the calendar event (itself a gated flow) or is a separate state.

---

## See also

- [SPEC-CANON](SPEC-CANON.md) — the authoritative design; this plan implements it.
- [12 — Roadmap](12-roadmap.md) — phase order, feasibility verdict, success metrics (this plan is its execution arm).
- [02 — Architecture](02-architecture.md) — the Wire, the single-writer Steward contract, the dependency graph.
- [03 — Scheduling](03-scheduling.md) — the cron clock + concurrency rules the Workflow realizes (update §6 with the chosen DST policy).
- [06 — Hosting: Cloudflare + MCP](06-hosting-cloudflare-mcp.md) — primitive map + the "Connect a new MCP" checklist (§5.4 here makes it a CI gate).
- [11 — Security & privacy](11-security-privacy.md) — gates, scopes, local-only capture (the §5.7 invariants are mechanical checks here).
- Per-agent specs in [docs/agents/](agents/) — the contract each task in §2–§4 implements.
