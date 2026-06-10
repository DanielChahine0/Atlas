# Atlas — Claude Code Working Guide

> **Atlas** is a personal multi-agent orchestrator on Cloudflare that runs a fleet of 16
> specialized sub-agents to manage the owner's (Daniel Chahine's) digital life: email triage,
> tasks, calendar, events, job hunting, meeting capture, an Obsidian dashboard, screen autofill,
> and personal-brand publishing. Atlas itself does **no domain work** — it schedules, routes,
> sequences, supervises, and owns the shared event bus (the Wire) + state.
>
> **Status: milestone v1.0 code-complete (2026-06-09).** All 6 phases (Spine · Core Loop · Weekly
> Value · Capture/Local · Outward/Gated · Meta/Polish) are built, reviewed, and on `main` — 40/40
> plans, 716 workspace + 39 daemon tests green (+106 Swift capture tests; 2 live-OAuth tests
> intentionally skipped) — **awaiting owner go-live gates** (live OAuth round-trips, Secrets Store
> seed, Obsidian bridge, AI-Gateway ceilings, GitHub App `pull_requests:write` grant, Playwright
> browser profile; see `.planning/STATE.md` → Blockers). **Nothing is live in production yet.
> Current focus: owner go-live gates → next milestone.**
> **Built (`apps/` — the FULL fleet):** atlas · steward · filer · herald · forge · sundial · compass ·
> scout · headhunter · flagger · flagger-watchdog · echo · archivist · usher · envoy · librarian ·
> gate · dlq-sink · mcp-google · mcp-github · mcp-obsidian-bridge, plus the local `daemon/` and the
> Swift `capture/` app. Switchboard is **design-time only** per D7 (`.claude/registry/mcp-registry.json`
> + `/switchboard` + `docs/10-switchboard.md`) — intentionally NOT a Worker.
> *Do NOT re-scaffold an agent that already exists under `apps/`.*
> **Authoritative design:** `docs/SPEC-CANON.md` (if two docs disagree, it wins).
> **How to build it:** `docs/13-build-plan.md` (task-level Phase 0 & 1, with pins & acceptance).
> **Project state / current phase:** `.planning/STATE.md` (GSD — authoritative live status).

---

## ⚠️ Non-negotiables — the 5 pillars + security. Never violate these.

1. **One writer per resource.** Exactly one agent mutates any external system. **Steward** is the
   *sole* Vault writer and the *only* Worker with a `queues.consumers` block on `atlas-wire`. Only
   **Filer** writes Gmail labels; only **Sundial/Usher** write `calendar.events`; only **Envoy**
   writes external profiles. *A second `atlas-wire` consumer is a hard CI failure.*
2. **Suggest, don't destroy.** Label / draft / recommend by default. Every destructive or
   outward-facing action (delete, post, register, pay) parks at a confirmation gate
   (`step.waitForEvent('owner.confirm', {timeout})`): **decline → `NonRetryableError`; timeout →
   expired with NO action.** Fail-safe, never fail-open. **There is no autonomous delete anywhere.**
3. **Cloud by default, local only when the OS forces it.** Everything runs on Cloudflare except
   **Echo** (audio) and **Quill** (screen), which run in a local macOS launchd daemon that
   authenticates **outbound** (no inbound port to the laptop). Raw audio/screen never leave the
   device except as an owner-approved derived artifact.
4. **Single source of truth.** Personal facts live in **The Codex** (read-only to agents). **D1 is
   the authoritative system-of-record**; the Vault is a *rendered projection*. Never hand-edit a
   counter — the Fri 16:30 build re-derives counters from D1 and overwrites drift.
5. **Idempotent + observable.** Every run is safe to repeat: counter writes use `op:"increment"`
   with a **structured** `idempotencyKey`, so a replay leaves counters unchanged
   (`meta.changes === 0`). Every pass writes a `run_log` row; every action writes an `audit_log`
   row (records `scope_used`, **never the token**). Every notable failure → **Flagger**.

**Security (hard invariants):**
- **NEVER surface 2FA codes / password-reset links / login URLs** anywhere — label, digest, export,
  Vault, Codex, or a Herald draft. Defense-in-depth: the Google MCP strips `Type/Security` bodies
  server-side **regardless of scope**, a Herald digest-builder guardrail catches a leak (P1, block),
  and a CI unit test backstops it. **A prompt instruction alone is NOT sufficient.**
- **Secrets only via bindings** (Cloudflare Secrets Store / `wrangler secret` / a git-ignored
  `.dev.vars`). **Never** in `[vars]`, KV, the Vault, the Codex, `audit_log`, logs, or any tracked
  file.
- **Least-privilege OAuth per agent.** Filer = `gmail.modify` **only** (labels; can't delete/archive
  — that needs full `https://mail.google.com/`, never granted). Herald = `gmail.readonly` +
  `gmail.compose` (draft only, **no send**). Sundial/Usher = `calendar.events` (no delete). Compass =
  `calendar.readonly`. A granted scope does **not** authorize silent execution — gate it.

---

## Tech stack & PINNED versions

> Verified 2026-06-04. **These move fast — re-verify before copying any tutorial** (use the
> `cloudflare-researcher` subagent or `/cf-docs`). The build-plan's own warning applies.

- **Language:** TypeScript, `strict: true`. Use `satisfies ExportedHandler<Env>` (not the older
  `: ExportedHandler<Env>` annotation) on every default export.
- **Platform:** Cloudflare **Workers** + **Durable Objects** + **Queues** (the Wire) + **Workflows** +
  **Cron Triggers**; **D1** (system-of-record) + **KV** (config/flags + OAuth store) + **R2**
  (audio/exports); remote **MCP servers** via the Agents SDK; **Workers OAuth Provider** (inbound);
  **Claude via AI Gateway**. Two agents (Echo, Quill) run in a **local macOS launchd daemon**.
- **Plan:** the **Workers Free plan is sufficient to build & deploy the spine.** **Queues went
  GA-on-Free 2026-02-04** (10k queues, 10k ops/day, 24h retention), **Workflows run on Free** (100
  concurrent, 1,024 steps/instance, 3-day state retention), and Atlas uses only **SQLite-backed DOs**
  (`new_sqlite_classes`, Free). **Workers Paid ($5/mo) is an optional headroom upgrade, NOT a hard
  gate** — take it for higher Workflow step/retention limits (a confirm-gate that waits **>3 days**
  exceeds Free's 3-day state retention), Queues throughput/retention, the KV-backed-DO option (unused
  by Atlas), and a higher per-Worker cron cap. The dominant recurring cost is the **Claude API bill**,
  not hosting. Verify the account with `wrangler whoami` + `wrangler queues list` (run `/prereqs`).
- **Package manager:** **pnpm** (via corepack) workspaces. **Tests:** Vitest +
  `@cloudflare/vitest-pool-workers` (runs in real `workerd`).
- **Wrangler config:** `wrangler.jsonc`, **one per app/Worker**, with
  `"$schema": "./node_modules/wrangler/config-schema.json"`.

| Dependency | Pin | Notes |
|---|---|---|
| `agents` (Cloudflare Agents SDK) | **`^0.14.x`** | `docs/13-build-plan.md` still pins `0.13.x`; **verified current is `0.14.x`** (npm, 2026-06-04) — re-verify before install, it ships ~weekly. **Requires `compatibility_flags: ["nodejs_compat"]`** (omitting it is a runtime failure). `0.14.1` transitively pins MCP SDK `1.29.0`, so don't bump the MCP SDK independently. |
| `@modelcontextprotocol/sdk` | **`1.29.0`** | Both `registerTool()` and `server.tool()` work in 1.29.0 — **prefer `registerTool()`** (the v2-forward path). **Do NOT adopt v2** — it's alpha/unpublished. |
| `@cloudflare/workers-oauth-provider` | **`^0.7.x`** | Inbound OAuth. Needs a real KV namespace (`OAUTH_KV`) or startup fails. |
| `wrangler` | **latest (v4.x)** | `kv namespace` (NOT deprecated `kv:namespace`). `secrets-store` still "open beta". |
| `zod` | `^3.25 \|\| ^4.0` | Schemas for Wire events / tools. |
| `@anthropic-ai/sdk`, `jose` | latest | Claude SDK; `jose` for GitHub App RS256 JWT. |
| `compatibility_date` | `2026-04-25` (≥ `2026-04-07`) | ≥ 2026-04-07 enables `web_socket_auto_reply_to_close` (Echo). Bumping to the current date is fine; old dates supported forever. |
| **Model IDs** | Opus `claude-opus-4-8` · Sonnet `claude-sonnet-4-6` · Haiku `claude-haiku-4-5` | Per-agent tiering in `[vars]`/KV, **not in code**. Never pin retired `claude-*-4-20250514`. |

**Model tiering:** Opus → Atlas, Compass, Archivist. Sonnet → Forge, Herald, Scout, Headhunter-full.
Haiku → Filer (continuous + sweep), Headhunter board-scan. All calls route through `claudeFor(agent, env)`
→ AI Gateway (two gateways: `atlas-reasoning` for Opus, `atlas-highvolume` for Haiku). **No direct
`api.anthropic.com`.** Workers AI is *only* Filer's outage fallback.

---

## Repo layout (single pnpm monorepo)

```
atlas/
├─ pnpm-workspace.yaml            # workspaces: ["apps/*", "packages/*"]
├─ tsconfig.base.json             # strict TS
├─ migrations/                    # D1 migrations (0001_init_core.sql, …) — shared DB
├─ packages/
│  ├─ wire/                       # WireEvent type + producer helper (env.WIRE.send)
│  ├─ model/                      # claudeFor(agent,env) + modelFor(agent,env) factory
│  ├─ steward-core/               # op→D1 + op→Local-REST mapping, idempotency ledger
│  ├─ codex/                      # Codex reader (read-only; drive.readonly)
│  ├─ shared/                     # Env types, Flagger emit, run-log helpers, zod schemas
│  ├─ security/                   # redact() — 2FA-code / reset-link / login-URL stripping
│  ├─ tasks/                      # D1 tasks/subtasks data access (dedupe/merge)
│  └─ gate/                       # confirmation-gate primitive (openGate/decideGate/sweepExpired)
├─ apps/                          # one Worker per agent (codename = lowercase dir) — ALL BUILT
│  ├─ atlas/  steward/  filer/  dlq-sink/        # spine + Filer
│  ├─ herald/ forge/ sundial/ compass/           # Phase 1 (morning chain)
│  ├─ scout/ headhunter/ flagger/ flagger-watchdog/   # Phase 2
│  ├─ echo/ archivist/                           # Phase 3 (Echo = EchoSession DO half)
│  ├─ gate/ usher/ envoy/                        # Phase 4 (confirm surface + gated agents)
│  ├─ librarian/                                 # Phase 5 (Switchboard = design-time, NOT an app)
│  ├─ mcp-google/                 # remote MCP (stateless, createMcpHandler)
│  ├─ mcp-github/                 # remote MCP (stateful McpAgent + OAuthProvider)
│  └─ mcp-obsidian-bridge/        # cloud side of the local Vault bridge
├─ capture/                       # LOCAL Swift menubar app (Echo native capture pipeline + Quill; SwiftPM)
└─ daemon/                        # LOCAL macOS launchd daemon (vault/gate outbox drainers + browser-action runner)
```
> `daemon/` and `capture/` are intentionally **outside** `apps/` — they are **not** Workers. They
> authenticate outbound and pull work; the laptop has **no inbound port**.

---

## Canonical conventions — use these EXACT strings

**Binding names (canonical strings — not all are on every Worker: `WIRE`/`DB`/`CONFIG`/`AI` are
common; `STEWARD_LOCK` is Steward-only; `OAUTH_KV`/`ATLAS`/`MORNING_CHAIN` are Atlas-only):**

| Binding | Primitive | Holds / rule |
|---|---|---|
| `WIRE` | Queue producer | `atlas-wire`. Every agent **except Steward** is a producer. |
| `DB` | D1 | `atlas-db` — **all counters + idempotency keys** (never KV). Positional `?` params only (no named). |
| `CONFIG` | KV | model-tier overrides, flags, label→color map. **Never secrets, never counters.** |
| `OAUTH_KV` | KV | OAuth grants/tokens for the inbound provider (must be real KV). |
| `BLOBS` | R2 | `atlas-blobs`. Prefix split: `audio/raw/` expires 7d; `transcripts/`/`exports/` persist. |
| `AI` | Workers AI | gateway routing — all Claude via `claudeFor(agent,env)`. |
| `STEWARD_LOCK` | DO | `env.STEWARD_LOCK.getByName("vault")` — **one name = one instance = the single Vault write lock.** |
| `ATLAS` / `MORNING_CHAIN_DO` | DO | `AtlasCoordinator`, `env.ATLAS.getByName("root")`. |
| `MORNING_CHAIN` | Workflow | `MorningChain` (name `atlas-morning-chain`). |

- **DO class = PascalCase role:** `AtlasCoordinator`, `StewardWriter`, `EchoSession`, `FilerCursor`,
  `HeadhunterState`, `FlaggerState`. Migrations use **`new_sqlite_classes`** (not legacy `new_classes`).
- **Wire `agent` field = the codename** (`"Forge"`, `"Filer"`, `"Herald"`, …).
- **Idempotency keys are STABLE & structured — never `crypto.randomUUID()` for scheduled work:**
  `filer:sweep:<date>`, `herald:daily:<date>`, `forge:task:<date>:<contentHash>`, `sundial-<date>`,
  `compass:plan:<date>`, `morning-${date}` (the Workflow instance id is itself the idempotency handle).
- **Secret bindings:** `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GH_APP_PRIVATE_KEY` (Secrets
  Store); `ANTHROPIC_API_KEY`, `CF_AIG_TOKEN`, `ATLAS_BRIDGE_TOKEN` (`wrangler secret put`). `[vars]`
  holds **plaintext non-secrets only**: `AIG_ACCOUNT_ID`, `AIG_GATEWAY_ID`, `MODEL_*`.
- **Staging fires NO crons:** `env.staging.triggers.crons = []`.

**The Wire event contract (SPEC §6.4) — copy exactly:**
```json
{ "agent": "...", "type": "...", "entity": "...",
  "op": "increment | upsert | append", "payload": { }, "idempotencyKey": "..." }
```
`increment` → counters/metrics · `upsert` → stable-row views (kanban, CRM) · `append` → feeds
(Flagger feed, run-log, quick-capture). Steward dedups in the D1 ledger; replay is a no-op.

---

## Build phases — **ALL 6 COMPLETE** (milestone v1.0, 2026-06-09). MVP = Phase 0 + Phase 1.

| Phase | Name | Ships |
|---|---|---|
| **0** | **Spine** | Atlas (orchestrator DO) · the Wire (Queue + DLQ) · Steward (sole writer DO + consumer) · D1 (idempotency ledger, counters, run_log, audit) · the Codex (read-only) · Google+GitHub OAuth · Obsidian bridge. **Zero user-visible features — that's correct.** Nail Steward serialization + idempotency. |
| **1** | **Core loop (MVP)** | Morning chain **Filer → Herald → Forge → Sundial → Compass** as ONE 07:45 cron kicking a Workflow; all feeding Steward → the Vault. |
| **2** | **Weekly value** | Scout · Headhunter (feeds Forge) · Flagger (+ watchdog Worker). |
| **3** | **Capture (local)** | Echo (audio daemon) → Archivist · Quill (screen autofill). |
| **4** | **Outward (gated)** | Usher (registration) · Envoy (public posts) — behind mature confirm gates. |
| **5** | **Meta/polish** | Switchboard (design-time only, NOT deployed) · Librarian. |

---

## Agent roster (Atlas + 16 sub-agents)

| # | Codename | Role | Shape | Scope / gate |
|---|---|---|---|---|
| 0 | **Atlas** | Orchestrator (no domain work) | Cloud DO, always-on | none — owns Wire + schedules |
| 1 | **Herald** | Email digest (daily 08:00 + weekly Fri) — **one agent, two modes** | Cloud | `gmail.readonly`+`gmail.compose` (draft, no send) |
| 2 | **Filer** | Email labeler (never deletes) | Cloud | `gmail.modify` **only** |
| 3 | **Forge** | Task extractor (deadlines) | Cloud | D1 only; no Gmail/Vault writes |
| 4 | **Sundial** | Task → Google Calendar | Cloud | `calendar.events` (no delete) |
| 5 | **Compass** | Daily planner | Cloud | `calendar.readonly` + D1 read |
| 6 | **Scout** | Event discovery (weekly) | Cloud | web / optional `calendar.readonly` |
| 7 | **Usher** | Event registration | Cloud + browser | **gated** (captcha/payment hard-stop) |
| 8 | **Headhunter** | Job deadlines/hiring | Cloud | public boards; writes via Forge + Steward |
| 9 | **Echo** | Audio capture → transcripts | **Local daemon** | local only; consent-gated |
| 10 | **Archivist** | Meeting-notes organizer | Cloud | `drive.readonly` (Codex) |
| 11 | **Steward** | Dashboard manager — **sole Vault writer** | Cloud DO | local Vault via bridge; consumes the Wire |
| 12 | **Quill** | Screen autofill from Codex | **Local daemon** | local only; never clicks Submit/Send |
| 13 | **Envoy** | Personal-brand sync | Cloud + browser | **gated** (posts irreversible); GitHub App |
| 14 | **Switchboard** | Capability router | **Design-time only** | recommendations only — not a live Worker |
| 15 | **Flagger** | Incident flagging (severity + trust) | Cloud | event-driven; writes Vault via Steward |
| 16 | **Librarian** | Prompt library | Cloud | writes Vault via Steward |

**Morning chain (strictly sequential, start-after-success):** Filer(07:45) → Herald(08:00) →
Forge(08:15) → Sundial(08:20) → Compass(08:30). A failed step **halts** the chain (no planning on
stale data) and flags P2. Times are *targets*, not guaranteed wall-clock. **Do NOT register the five
stages as five crons** — it's ONE cron kicking the `MorningChain` Workflow. **Steward serializes all
Vault writes** and fetches nothing.

---

## Key commands

```bash
# Prereqs (run /prereqs)
node -v                                   # expect LTS v22.x
corepack enable && corepack prepare pnpm@latest --activate
npx wrangler login && npx wrangler whoami # any Workers account — Paid NOT required (Free builds the spine)
npx wrangler queues list                  # Queues runs on Free (GA-on-Free 2026-02-04); confirms CLI auth

# Build / test / typecheck (workerd forces TZ=UTC)
pnpm -r build && pnpm -r typecheck && pnpm test

# Provision the spine (Phase 0)
npx wrangler queues create atlas-wire && npx wrangler queues create atlas-wire-dlq
npx wrangler d1 create atlas-db
npx wrangler kv namespace create CONFIG && npx wrangler kv namespace create OAUTH_KV
npx wrangler r2 bucket create atlas-blobs
npx wrangler r2 bucket lifecycle add atlas-blobs --name expire-raw-audio --prefix "audio/raw/" --expire-days 7

# Local dev + fire a cron (spaces → +)
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=45+12+*+*+*"   # 07:45 ET Filer sweep → MorningChain
```

---

## Gotchas that bite (read before writing code)

- **`workerd` / `wrangler dev` / vitest force `TZ=UTC`.** `new Date()` is UTC even on the laptop.
  Derive owner-local time explicitly:
  `Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto'}).format(new Date())` → `YYYY-MM-DD`.
- **Cron Triggers are UTC-only, NO DST** (decision D1). 07:45 ET = `45 12 * * *` (EST) / `45 11 * * *`
  (EDT). Hand-edit at each DST boundary; in-Workflow waits use `step.sleepUntil` (DST-safe). Use
  `/cron-utc` to translate.
- **KV is NOT for counters or idempotency** (1 write/s/key + ≤60s lag). Use D1 (or Steward DO SQLite).
- **D1 supports anonymous positional `?` params only** — no named params. Increment math is **absolute**.
- **Steward critical section:** dedup-check + counter-bump + ledger-insert must be ONE atomic D1
  `batch()` inside `ctx.blockConcurrencyWhile`. Do the slow Obsidian write **outside** the lock.
- **Queue consumer processes each batch SERIALLY** (`for…of`, never `Promise.all`); `max_concurrency=1`
  + the DO lock enforce serialization. **DLQ `atlas-wire-dlq` is mandatory** (else exhausted msgs drop
  silently → must become Flagger incidents). Wire message cap is **128 KB**.
- **Malformed Wire event → `ack()` it** (don't poison-loop) + Flagger P3. Transient throw → `retry`.
- **`NonRetryableError` imports from `cloudflare:workflows`** (a different module than
  `WorkflowEntrypoint`/`WorkflowStep` from `cloudflare:workers`). Don't mutate `event.payload` inside a
  step (reverts on replay) — return state and pass it forward.
- **Google OAuth:** the authorize request MUST include `access_type=offline` + `prompt=consent` or no
  refresh token; refresh responses never return a new refresh token (keep the original); `S256` PKCE.
- **Secrets Store: ONE store per account** (open beta). `--remote` secrets aren't readable in
  `wrangler dev` — make non-remote dev copies. Reads are **async** (`await env.X.get()`).
- **GitHub App** (not a PAT): RS256 JWT (`iss`=App client id, `iat` backdated 60s, `exp` ≤ 10 min);
  installation token is opaque (`ghs_…`), ~1h, minted per-run, never persisted.
- **`claude-opus-4-8` defaults `effort` to `high`** — set it lower explicitly for cheap daily passes.
- **Missed crons are NOT auto-replayed** — every pass must be idempotent so the next run catches up.

---

## Definition of Done — every agent PR ships all three tests

1. A **Wire-contract test** for the events it emits (shape + structured `idempotencyKey`).
2. A **replay test** through Steward (replay ⇒ `meta.changes === 0`, counter unchanged).
3. A **failure-path test** asserting the right Flagger severity.

CI invariants: exactly one `atlas-wire` consumer (a second fails the build); a digest-builder unit
test proving 2FA codes/reset links never reach output.

---

## Project workflow (GSD)

This repo runs on the **GSD** `.planning/` workflow — it's the operating system, not just notes:
- `.planning/STATE.md` = current position (the SessionStart hook surfaces it) · `.planning/ROADMAP.md`
  = phase gates · `.planning/PROJECT.md` + `REQUIREMENTS.md` = scope, constraints, decisions.
- **Advance the workflow with the `gsd-*` skills:** `/gsd-plan-phase <n>` to plan a phase,
  `/gsd-progress` to check/advance, `/gsd-execute-phase` to build. The next action lives in `STATE.md`.
- **Don't hand-edit `.planning/` state or counters** — GSD owns them (same discipline as never
  hand-editing a Vault counter; D1 stays authoritative).

---

## Tooling & MCP — use these for productivity (don't guess from memory)

The SDKs here move weekly. **Before writing or reviewing Cloudflare/Wrangler/Agents/MCP code, pull
current docs** — `.mcp.json` wires up three servers (run `/mcp` to verify they're connected):

- **`context7`** — `resolve-library-id` then `query-docs` for any library/SDK (Cloudflare `agents`,
  `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `zod`, `jose`, …). Prefer it over training data.
- **`cloudflare-docs`** — official Cloudflare docs (Workers, DOs, Queues, Workflows, D1/KV/R2, AI
  Gateway, Wrangler). No auth.
- **`github`** — repos/issues/PRs (needs `GITHUB_PAT`; optional until you're on GitHub).

**Slash commands** (`.claude/commands/`): `/cf-docs <topic>` · `/new-agent <codename> <phase>` ·
`/pillar-check [path]` · `/wire-event <agent> <op> <entity>` · `/spec <topic>` · `/prereqs` ·
`/cron-utc <time>`.

**Subagents** (`.claude/agents/`): `cloudflare-researcher` (live SDK syntax + pin drift),
`pillar-auditor` (the 7 invariants + security, read-only), `spec-keeper` (design Q&A, faithful to
SPEC-CANON). Delegate to them proactively.

---

## Where to look (read on demand — don't bloat context)

| Need | File |
|---|---|
| The authoritative design | `docs/SPEC-CANON.md` (wins all conflicts) |
| How to build it (pins, tasks, acceptance) | `docs/13-build-plan.md` |
| A specific agent's contract | `docs/agents/<codename>.md` |
| Data flow / the Wire / single-writer | `docs/02-architecture.md` |
| Schedule, concurrency, failure modes | `docs/03-scheduling.md` |
| Hosting + the Connect-a-new-MCP checklist | `docs/06-hosting-cloudflare-mcp.md` |
| Email labels (Filer's substrate) | `docs/04-email-taxonomy.md` |
| Dashboard layout, counters, views | `docs/05-dashboard.md` |
| The Codex (source of truth) | `docs/07-source-of-truth-codex.md` |
| Security, gates, scopes, audit log | `docs/11-security-privacy.md` |
| Flagger severity + trust model | `docs/08-flagger.md` |
| Roadmap + feasibility verdict | `docs/12-roadmap.md` |
| Live project state / current phase | `.planning/STATE.md`, `.planning/PROJECT.md` |
