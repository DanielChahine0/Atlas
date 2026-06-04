# Phase 0: Spine - Context

**Gathered:** 2026-06-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Stand up the **infrastructure substrate** every later agent reuses — and nothing else. Phase 0 ships **zero user-visible features** (that is correct, not a gap). It delivers:

- **Atlas** — the orchestrator Durable Object (`AtlasCoordinator`, `getByName("root")`); schedules, routes, owns the Wire. No domain work.
- **The Wire** — the `atlas-wire` Cloudflare Queue (producer binding `WIRE`) + the mandatory `atlas-wire-dlq` dead-letter queue.
- **Steward** — the **sole** Vault writer DO (`StewardWriter`, `getByName("vault")`) and the **single** `atlas-wire` consumer, implementing the §6.4 write contract with **serialization + idempotency correct from day 0**.
- **D1** (`atlas-db`) — the authoritative system-of-record: idempotency-key ledger, counters, `run_log`, `audit_log`, `vault_outbox`.
- **The Codex** — read-only personal facts (the §11 sections), no agent write path.
- **OAuth** — Google (least-privilege scopes) + GitHub (GitHub App) round-trips; tokens in Cloudflare Secrets Store, never in the Vault/Codex.
- **The Obsidian bridge** — outbound-only drain from Steward → the local Vault (no inbound port to the laptop).

**Locked requirements:** SPINE-01…SPINE-05 (see `.planning/REQUIREMENTS.md`). The discussion below decides **how** to build, not **what** — scope is fixed by ROADMAP.md.

**The crux to nail:** Steward's atomic critical section (dedup-check + counter-bump + ledger-insert as ONE D1 `batch()` inside `blockConcurrencyWhile`; the slow Obsidian write happens outside the lock). Retrofitting idempotency after counters exist means reconciling double-counts.

</domain>

<decisions>
## Implementation Decisions

### Hosting / Cloudflare plan
- **D-01:** **Build & deploy Phase 0 on the Workers FREE plan.** As of 2026-02-04 Cloudflare Queues run on Free (10k queues, 10k ops/day, 24h retention); Workflows run on Free (100 concurrent, 1,024 steps/instance, 3-day state retention); Atlas uses only SQLite-backed DOs (Free). **Workers Paid ($5/mo) is an optional headroom upgrade, NOT a hard gate** — adopt it later only if a real ceiling is hit (notably: a confirm-gate that must wait **>3 days** exceeds Free's 3-day workflow-state retention — a Phase-4 concern; also Queues 14-day retention, KV-backed-DO option, higher cron cap).
- **D-02:** **Reconcile the stale "Paid hard prerequisite"** still asserted in `.planning/PROJECT.md` (lines ~43, ~58) and `.planning/intel/*` — Free is sufficient. (The canonical `docs/` + `CLAUDE.md` + `/prereqs` were already corrected on 2026-06-04 with authoritative Cloudflare citations.)
- **D-03:** The dominant recurring cost is the **Claude/Anthropic API bill** (via AI Gateway, no markup, no free allocation) — independent of the Cloudflare plan and larger than $5/mo at fleet volume. Budget for it, not for hosting.

### Monorepo & Worker granularity
- **D-04:** **Package manager = pnpm** (corepack workspaces), as drafted throughout the spec. Root `pnpm-workspace.yaml` → `["apps/*", "packages/*"]`.
- **D-05:** **One Worker per agent** (max least-privilege isolation; `apps/<codename>`). Steward (sole Wire consumer) and Filer (`gmail.modify` boundary) **must always stay isolated** even if low-risk agents are ever grouped later.

### Scheduling & DST (= project decision D1)
- **D-06:** **UTC crons + twice-yearly hand-edit** at the EST↔EDT boundary (`45 12 * * *` EST / `45 11 * * *` EDT). In-Workflow waits use `step.sleepUntil` with a tz-correct `Intl` zone (`America/Toronto`), which is DST-safe.
- **D-07:** Writing the **EST/EDT translation table into `docs/03-scheduling.md`** is a Phase-0 "setup-done" criterion (build-plan §1 acceptance #4). (Crons themselves first fire in Phase 1, but the policy is locked now.)

### Steward & infra knobs
- **D-08:** **Idempotency-ledger retention = keep keys forever.** A replay at any age is a guaranteed no-op (`meta.changes === 0`); single-owner storage is trivial vs D1's 5GB free tier. No TTL window to get wrong.
- **D-09:** **`compatibility_date = 2026-04-25`** (≥ 2026-04-07 enables `web_socket_auto_reply_to_close`, needed by Echo later). Pair with `compatibility_flags: ["nodejs_compat"]` (required by the Agents SDK).
- **D-10:** **Atlas heartbeat staleness threshold = 5 min** → Atlas self-flags **P1** if no heartbeat within the window.
- **D-11:** **invokeAgent transport = service-binding RPC** (Worker-to-Worker; lowest latency, type-safe, no public HTTP surface). Relevant to SPINE-01 (Atlas routes a message onto the Wire).

### Claude's Discretion
- D1 table schema specifics (column types, indexes), exact OAuth scope strings per agent, Codex section file layout, Secrets Store key naming, and the precise `wrangler.jsonc` shapes are **left to research/planning** — they are technical implementation details, constrained by the canonical refs below and the pins in `CLAUDE.md`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Authoritative design (wins all conflicts)
- `docs/SPEC-CANON.md` — the authoritative spec; §0 pillars, §6.4 Wire event contract, §11 Codex sections. If two docs disagree, this wins.

### How to build Phase 0 (task-level)
- `docs/13-build-plan.md` §1 — prerequisites & project setup, acceptance criteria for "setup is done".
- `docs/13-build-plan.md` §2 — Phase 0 Spine task-level breakdown (**T0–T15**) with pins and per-task acceptance.

### Per-agent specs (Phase 0)
- `docs/agents/atlas.md` — orchestrator DO contract (scheduling, heartbeat, Wire ownership). SPINE-01.
- `docs/agents/steward.md` — sole Vault writer + single consumer; the §6.4 write contract; critical-section design. SPINE-02/05.

### Data flow, scheduling, hosting, source-of-truth, security
- `docs/02-architecture.md` — data flow, the Wire, single-writer model. SPINE-01/02.
- `docs/03-scheduling.md` — schedule, concurrency, failure modes; **EST/EDT table to be written here** (D-07).
- `docs/06-hosting-cloudflare-mcp.md` — hosting + the Connect-a-new-MCP checklist; Obsidian bridge. SPINE-04/05.
- `docs/07-source-of-truth-codex.md` — the Codex (read-only). SPINE-03.
- `docs/11-security-privacy.md` — OAuth scopes, secrets handling, audit log, 2FA/reset-link redaction. SPINE-04.

### Project state
- `.planning/REQUIREMENTS.md` — SPINE-01…05 (locked requirements + acceptance). MUST read before planning.
- `CLAUDE.md` — pinned versions, canonical binding names/conventions, gotchas (TZ=UTC, D1 positional `?`, `new_sqlite_classes`, etc.).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **None — greenfield.** No `package.json`, `pnpm-workspace.yaml`, `wrangler.jsonc`, `apps/`, `packages/`, or `migrations/` exist yet. Phase 0 scaffolds the monorepo from scratch.

### Established Patterns
- The **canonical conventions are already specified** (not yet coded) in `CLAUDE.md`: exact binding names (`WIRE`/`DB`/`CONFIG`/`OAUTH_KV`/`BLOBS`/`AI`/`STEWARD_LOCK`/`ATLAS`), DO class PascalCase roles, structured idempotency keys, the §6.4 Wire contract, `new_sqlite_classes` migrations. New code must conform to these strings exactly.

### Integration Points
- **The Obsidian bridge** is the only local dependency in Phase 0 (Local REST API plugin v3.0+ on `127.0.0.1:27124`, outbound-only drain via `vault_outbox`).
- **MCP servers** (`mcp-google`, `mcp-github`, `mcp-obsidian-bridge`) are wired via `.mcp.json` (already present) and stood up as Workers in this phase.

</code_context>

<specifics>
## Specific Ideas

- The owner verified the prereqs gate live on **2026-06-04**: Node v22.22.3, pnpm 11.5.1, logged into Cloudflare as `chahinedaniel0@gmail.com` (token carries `queues (write)`), `wrangler queues list` succeeds on the **free** account — confirming the Free-tier path (D-01) end-to-end.
- The "Queues/Workflows are free" finding was confirmed against authoritative Cloudflare sources (changelog 2026-02-04 + the Queues/Workflows/DO pricing & limits pages) before locking D-01/D-02.

</specifics>

<deferred>
## Deferred Ideas

Owner-judgment calls intentionally NOT decided in Phase 0 — surface at the relevant later phase (per `.planning/PROJECT.md` Context):

- **AI Gateway $/rate ceilings** — per-gateway dashboard config; lock before Filer's continuous push goes live (Phase 1).
- **Herald output surface** — keep Gmail draft vs Vault-glance-only (Phase 1).
- **Compass Opus `effort` level** — cheap daily pass tuning (Phase 1).
- **The two manual measurement commitments** — pre-launch baseline + ~1-min daily review (Phase 1).
- **Morning-chain success-rate window** — the metric window definition (Phase 1).
- **Workflow-state retention ceiling (>3 days)** — only bites if a confirm-gate must wait longer than Free's 3-day retention; revisit at Phase 4 (Usher/Envoy gates) — would be the trigger to adopt Workers Paid.

None of the above are Phase-0 blockers. Discussion stayed within phase scope.

</deferred>

---

*Phase: 0-Spine*
*Context gathered: 2026-06-04*
