# Phase 0: Spine — Plan Outline (remaining plans after 00-01)

**Generated:** 2026-06-04
**Mode:** outline-only (chunked resume). Plan **00-01 is FINAL** (Wave 1) and is **not** listed below.

> Decomposes the rest of Phase 0 into authoring-ready plans. File ownership is **disjoint across all
> plans authored in the same wave** (siblings are written in parallel). Cross-wave handoffs on a single
> file are allowed only because the later wave runs strictly after the earlier one (the implicit
> files_modified-overlap rule already forces the later plan into a later wave), so there is never a
> parallel write race. Two such handoffs exist and are called out explicitly:
> - `apps/atlas/src/index.ts` — 00-01 creates a minimal hello-world fetch handler (Wave 1); **00-03**
>   (Wave 3) replaces it with the `scheduled()` dispatcher; **00-06** (Wave 4) composes the
>   `OAuthProvider` default export with that dispatcher (preserving it + the `AtlasCoordinator` export).
> - `apps/steward/wrangler.jsonc` — 00-01 writes the skeleton **without** a `queues.consumers` block
>   (Wave 1); **00-04** (Wave 3) adds the consumers block. **00-04 is the ONLY plan that may touch this
>   file**; no sibling lists it.
> - `apps/atlas/wrangler.jsonc` — 00-01 writes the base config (Wave 1); **00-03** (Wave 3) adds the
>   `services` NOOP binding; **00-06** (Wave 4) adds the `secrets_store_secrets` block. Strictly
>   increasing waves ⇒ race-free; each binding is declared in the same wave as the code/secret that uses it.

## Wave-1 recap (00-01 — FINAL, do not re-plan)

Owns: `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, `vitest.workspace.ts`,
`.gitignore`, `apps/atlas/wrangler.jsonc`, `apps/atlas/src/index.ts` (minimal), `apps/atlas/vitest.config.ts`,
`apps/steward/wrangler.jsonc` (skeleton, NO consumer block), `migrations/0001_init_core.sql`,
`docs/03-scheduling.md`, `.planning/PROJECT.md`. Provisions D1/Queues+DLQ/KV(CONFIG+OAUTH_KV)/R2.
Covers (partial): SPINE-01, SPINE-02, SPINE-05.

## Remaining plans

| Plan ID | Objective | Wave | Depends On | Requirements | Files Owned (no overlap with 00-01 or siblings) |
|---------|-----------|------|------------|--------------|--------------------------------------------------|
| 00-02 | **Shared packages — the Wire contract + foundation utilities.** `packages/wire` (the single §6.4 `WireEvent` zod schema + producer `send` helper, imported by every producer + Steward), `packages/shared` (Env type, `flag()` Flagger-emit helper, run-log helpers, shared zod), and `packages/security` (the `redact.ts` 2FA/reset-link SECRET_PATTERNS primitive + its CI-backstop test). These are imported by Atlas, Steward, and every MCP, so they MUST land before the DOs that consume them. | 2 | 00-01 | SPINE-02 | `packages/wire/package.json`, `packages/wire/tsconfig.json`, `packages/wire/src/contract.ts`, `packages/wire/src/send.ts`, `packages/wire/src/index.ts`, `packages/wire/test/contract.test.ts`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/env.ts`, `packages/shared/src/flag.ts`, `packages/shared/src/runlog.ts`, `packages/shared/src/index.ts`, `packages/security/package.json`, `packages/security/tsconfig.json`, `packages/security/src/redact.ts`, `packages/security/src/index.ts`, `packages/security/test/redact.test.ts` |
| 00-03 | **Atlas orchestrator DO — schedule + route onto the Wire (SPINE-01).** `AtlasCoordinator` DO (`getByName("root")`: `scheduled()` dispatcher routing a cron → invoke a no-op agent via service-binding RPC per D-11 → `env.WIRE.send(canonicalEvent)`; 5-min `alarm()` heartbeat → self-flag P1 per D-10). **Replaces** the Wave-1 minimal `apps/atlas/src/index.ts` with the dispatcher; adds the coordinator DO + the no-op-agent service-binding target + integration test. (NOTE: the OAuthProvider default-export composition lands in 00-06, which also owns index.ts thereafter — see 00-06 note.) | 3 | 00-02 | SPINE-01 | `apps/atlas/src/index.ts`, `apps/atlas/src/coordinator.ts`, `apps/atlas/src/noop-agent.ts`, `apps/atlas/test/scheduled.test.ts`, `apps/atlas/test/heartbeat.test.ts` |
| 00-04 | **Steward writer DO + the single Wire consumer (THE CRUX — SPINE-02 + SPINE-05).** `StewardWriter` DO (`getByName("vault")`): atomic dedup + counter-bump + ledger-insert in ONE `DB.batch()` inside `blockConcurrencyWhile`, replay ⇒ `meta.changes===0`; slow Obsidian write OUTSIDE the lock (enqueue `vault_outbox` intent inside). The single `atlas-wire` consumer (`max_concurrency=1`, serial `for…of`; malformed → `ack`+P3; transient → `msg.retry({delaySeconds})`, NOT the invalid `retry_delay_secs` key). **Adds the `queues.consumers` block to `apps/steward/wrangler.jsonc`** (the ONLY plan that touches it). `steward-core` package holds the op→D1 + op→Local-REST mapping + ledger logic. Ships the three mandatory tests (replay, serialize, malformed). | 3 | 00-02 | SPINE-02, SPINE-05 | `apps/steward/wrangler.jsonc`, `apps/steward/src/steward.ts`, `apps/steward/src/steward-consumer.ts`, `apps/steward/src/index.ts`, `apps/steward/test/replay.test.ts`, `apps/steward/test/serialize.test.ts`, `apps/steward/test/malformed.test.ts`, `packages/steward-core/package.json`, `packages/steward-core/tsconfig.json`, `packages/steward-core/src/apply.ts`, `packages/steward-core/src/op-mapping.ts`, `packages/steward-core/src/index.ts` |
| 00-05 | **DLQ consumer + Flagger incident sink (SPINE-05).** A separate Worker (its own `wrangler.jsonc`) consuming `atlas-wire-dlq`: an exhausted-retry message → `audit_log` row + a P2/P3 Flagger incident, never silently buffered. Single-concern, files disjoint from Steward so it can be authored in parallel with 00-04. | 3 | 00-02 | SPINE-05 | `apps/dlq-sink/wrangler.jsonc`, `apps/dlq-sink/vitest.config.ts`, `apps/dlq-sink/src/index.ts`, `apps/dlq-sink/test/dlq.test.ts` |
| 00-06 | **OAuth — Google + GitHub App round-trips + the inbound front door (SPINE-04).** Google outbound (authorize MUST set `access_type=offline` + `prompt=consent` + S256 PKCE; keep the original refresh token; full Google scope URIs at the least-privilege floor) and GitHub App (RS256 JWT via `jose`: `iss`=client id, `iat` backdated 60s, `exp`≤10min → opaque ~1h installation token, minted per-run, never persisted). Wires the inbound Workers `OAuthProvider` as the Atlas default export (composed with the Wave-3 `scheduled()` dispatcher) backed by the real `OAUTH_KV`; tokens to Cloudflare Secrets Store, never Vault/Codex/audit_log. **Includes `autonomous:false` owner-provisioning gate tasks:** GCP OAuth consent screen + client, GitHub App registration, and the Secrets Store entries (`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GH_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `CF_AIG_TOKEN`). **Owns `apps/atlas/src/index.ts` after 00-03** (composes the OAuthProvider with the dispatcher) — depends on 00-03 to avoid a same-wave conflict. | 4 | 00-03 | SPINE-04 | `apps/atlas/src/index.ts`, `apps/atlas/src/oauth/google.ts`, `apps/atlas/src/oauth/github.ts`, `apps/atlas/src/auth/consent.ts`, `apps/atlas/test/oauth.test.ts` |
| 00-07 | **The Codex + the model factory (SPINE-03).** `packages/codex` read-only reader of the §11 sections (identity, education, work, skills, projects, bios, socials) via `drive.readonly`, cached as an ephemeral system block; **no agent write path** (read 403 on write). `packages/model` `claudeFor(agent,env)` / `modelFor(agent,env)` factory → AI Gateway, per-codename KV tiering (Opus/Sonnet/Haiku, no direct `api.anthropic.com`). Independent of 00-06's OAuth files, so can run in the same wave. | 4 | 00-02 | SPINE-03 | `packages/codex/package.json`, `packages/codex/tsconfig.json`, `packages/codex/src/codex.ts`, `packages/codex/src/index.ts`, `packages/codex/test/read.test.ts`, `packages/model/package.json`, `packages/model/tsconfig.json`, `packages/model/src/claude.ts`, `packages/model/src/index.ts` |
| 00-08 | **MCP Workers + the outbound-only Obsidian bridge drain (SPINE-04 redaction backstop + SPINE-05 bridge).** `mcp-google` (stateless `createMcpHandler` WITH the server-side `Type/Security` body strip for 2FA/reset-links regardless of scope; `gmail.modify` floor + scope-403 test), `mcp-github` (stateful `McpAgent` + `OAuthProvider`), and `mcp-obsidian-bridge` cloud side: `/bridge/poll` + `/bridge/ack` (token-gated by `ATLAS_BRIDGE_TOKEN`) draining `vault_outbox` → the local daemon → Obsidian Local REST API v3 PATCH on `127.0.0.1:27124` (no inbound port; op→REST mapping; never `DELETE`). The `daemon/` outbound-drain skeleton. **Includes `autonomous:false` owner-provisioning gate tasks:** Obsidian Local REST API plugin install + `ATLAS_BRIDGE_TOKEN` Secrets Store/secret entry + launchd plist registration (verify `lsof` shows no inbound LISTEN port). | 5 | 00-02, 00-04, 00-06 | SPINE-04, SPINE-05 | `apps/mcp-google/wrangler.jsonc`, `apps/mcp-google/vitest.config.ts`, `apps/mcp-google/src/index.ts`, `apps/mcp-google/test/scope.test.ts`, `apps/mcp-google/test/redact.test.ts`, `apps/mcp-github/wrangler.jsonc`, `apps/mcp-github/vitest.config.ts`, `apps/mcp-github/src/index.ts`, `apps/mcp-obsidian-bridge/wrangler.jsonc`, `apps/mcp-obsidian-bridge/vitest.config.ts`, `apps/mcp-obsidian-bridge/src/index.ts`, `apps/mcp-obsidian-bridge/src/bridge/poll.ts`, `apps/mcp-obsidian-bridge/src/bridge/ack.ts`, `apps/mcp-obsidian-bridge/test/bridge.test.ts`, `daemon/package.json`, `daemon/src/drain.ts`, `daemon/com.atlas.bridge.plist` |

## Coverage check (SPINE-01..05 — collectively complete)

| Requirement | Covered by |
|-------------|------------|
| SPINE-01 (Atlas schedules + routes onto the Wire) | 00-01 (partial: provisioning), **00-03** (dispatcher → no-op invoke → `WIRE.send`) |
| SPINE-02 (Steward single serialized consumer, §6.4 contract, replay ⇒ meta.changes===0) | 00-01 (partial: D1 schema, Wire), 00-02 (the §6.4 zod contract), **00-04** (the crux) |
| SPINE-03 (Codex exists, §11 sections, read-only) | **00-07** |
| SPINE-04 (Google + GitHub OAuth round-trips; Secrets Store; 2FA/reset redaction) | **00-06** (OAuth round-trips + Secrets Store), **00-08** (server-side redaction backstop in mcp-google) |
| SPINE-05 (DLQ → audit + P2/P3, never silent; outbound-only Obsidian bridge drain) | 00-01 (partial: DLQ provisioned), 00-02 (`flag()` helper), **00-04** (consumer→DLQ wiring), **00-05** (DLQ sink), **00-08** (bridge drain) |

Every SPINE-0X id appears in ≥1 remaining plan's Requirements. No Phase-1 scope (no morning-chain crons,
no Filer/Herald/Forge/Sundial/Compass, no `MorningChain` Workflow) is planned here.

## Wave structure

| Wave | Plans | Parallel? | Rationale |
|------|-------|-----------|-----------|
| 1 | 00-01 (FINAL) | — | Scaffold + provisioning; everything imports these resources/bindings. |
| 2 | 00-02 | solo | Shared packages (`wire` contract, `shared`, `security`) are imported by every DO/MCP; must precede them. |
| 3 | 00-03, 00-04, 00-05 | yes (disjoint files) | Atlas DO, Steward crux + consumer, and the DLQ sink all consume Wave-2 packages and own disjoint files. |
| 4 | 00-06, 00-07 | yes (disjoint files) | 00-06 (OAuth, adds the secrets_store_secrets block to Atlas wrangler/index.ts after 00-03) ∥ 00-07 (Codex + model factory, independent). |
| 5 | 00-08 | solo | MCP Workers + Obsidian bridge — depends on Steward `vault_outbox` (00-04) AND the OAuth front door + GitHub-App helpers (00-06, Wave 4), so it runs strictly after Wave 4. |

## OUTLINE COMPLETE — 7 remaining plans (00-02 … 00-08)
