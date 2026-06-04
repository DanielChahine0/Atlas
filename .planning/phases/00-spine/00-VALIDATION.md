---
phase: 0
slug: spine
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-04
---

# Phase 0 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Consolidated from `00-RESEARCH.md` "## Validation Architecture" + the per-task `<verify><automated>` blocks across `00-01-PLAN.md` … `00-08-PLAN.md` + the CLAUDE.md "Definition of Done" (Wire-contract · replay `meta.changes===0` · failure-path → Flagger) and the two CI invariants (one `atlas-wire` consumer; 2FA/reset-link redaction backstop).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.x + `@cloudflare/vitest-pool-workers` (runs in real `workerd`, `TZ=UTC`) — pinned `vitest@4.1.8` + `@cloudflare/vitest-pool-workers@0.16.13` |
| **Config file** | Root `vitest.workspace.ts` (created by 00-01 Task 1) globbing each per-app/per-package `vitest.config.ts` (each `defineWorkersConfig` with `wrangler.configPath`, `miniflare.compatibilityFlags: ["nodejs_compat"]`, `isolatedStorage: true`) |
| **Quick run command** | `pnpm test` (or `pnpm --filter <pkg> test` / `vitest run <file>` for a single suite) |
| **Full suite command** | `pnpm -r test && pnpm -r typecheck` (phase-gate adds `pnpm -r build`) |
| **Estimated runtime** | ~30–90 seconds *(estimate — greenfield, no measured baseline yet; `workerd`/Miniflare boot dominates)* |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test` (or the task's single suite, e.g. `vitest run packages/wire/test/contract.test.ts`) — quick, < 90s.
- **After every plan wave:** Run `pnpm -r test && pnpm -r typecheck` plus the one-`atlas-wire`-consumer grep gate and the redaction backstop test.
- **Before `/gsd:verify-work`:** Full suite must be green + the seven "Phase 0 done" checkboxes verified against the real deploy.
- **Max feedback latency:** 90 seconds.

---

## Per-Task Verification Map

> One row per task across all 8 plans. `File Exists` uses the wave the file is *created in* (W1/W2/W3/W4) — every file is greenfield, authored in-phase. `MANUAL` rows are owner-provisioning gates (`type="checkpoint:human-action"`, `autonomous:false`) with no CLI/API substitute.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 00-01 / Task 1 | 01 | 1 | SPINE-01/02/05 | T-00-04 / T-00-SC | npm-only installs (no PyPI `agents` confusion); strict TS | unit (build/typecheck) | `pnpm -r build && pnpm -r typecheck` | W1 | ⬜ pending |
| 00-01 / Task 2 | 01 | 1 | SPINE-02/05 | T-00-01 / T-00-02 / T-00-03 | `audit_log` records `scope_used` never the token; counters in D1 not KV; no secrets in `[vars]` | integration (D1 migrate) | `wrangler d1 migrations apply atlas-db --local && wrangler d1 execute atlas-db --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"` | W1 | ⬜ pending |
| 00-01 / Task 3 | 01 | 1 | SPINE-01 | T-00-06 | Free-plan doc reconciliation; no secret/cron drift introduced | unit (doc grep) | `grep -q "45 12" docs/03-scheduling.md && grep -q "45 11" docs/03-scheduling.md && ! grep -iE "paid.{0,40}(hard\|required\|prerequisite)" .planning/PROJECT.md && echo PASS` | W1 | ⬜ pending |
| 00-02 / Task 1 | 02 | 2 | SPINE-02 | T-00-21 / T-00-25 | Single §6.4 `WireEvent` schema; malformed event rejected at producer parse boundary | unit (Wire-contract) | `pnpm --filter @atlas/wire typecheck && pnpm test -- packages/wire` | W2 | ⬜ pending |
| 00-02 / Task 2 | 02 | 2 | SPINE-02 | T-00-23 / T-00-24 | `flag()` builds §6.4-valid Flagger event with structured idempotencyKey (never `randomUUID`); `run_log` positional-`?` only | unit (typecheck + grep) | `pnpm --filter @atlas/shared typecheck && pnpm test -- packages/shared 2>/dev/null; grep -c 'entity: *"flagger"' packages/shared/src/flag.ts` | W2 | ⬜ pending |
| 00-02 / Task 3 | 02 | 2 | SPINE-02 | T-00-22 / T-00-26 | 2FA code / reset link / login URL never survives `redact()`; benign text untouched (CI redaction backstop) | unit (redaction backstop) | `pnpm --filter @atlas/security typecheck && pnpm test -- packages/security` | W2 | ⬜ pending |
| 00-03 / Task 1 | 03 | 3 | SPINE-01 | T-00-33 / T-00-37 | `AtlasCoordinator` is producer-only (no `consumers`/`queue()`); 5-min heartbeat reschedules; `America/Toronto` local date | unit (typecheck + grep) | `pnpm --filter atlas typecheck && grep -q 'class AtlasCoordinator' apps/atlas/src/coordinator.ts && grep -Eq '5 ?[*] ?60' apps/atlas/src/coordinator.ts && grep -q 'America/Toronto' apps/atlas/src/coordinator.ts && [ "$(grep -cE 'consumers\|async queue' apps/atlas/src/coordinator.ts)" -eq 0 ]` | W3 | ⬜ pending |
| 00-03 / Task 2 | 03 | 3 | SPINE-01 | T-00-31 / T-00-32 / T-00-35 | No-op invoked over private service binding (no HTTP route); `switch(cron)` routes only known case; stable `atlas:noop:<date>` key | unit (typecheck + grep) | `pnpm --filter atlas typecheck && grep -q 'scheduled' apps/atlas/src/index.ts && grep -Eq 'WIRE\.send\|send\(' apps/atlas/src/index.ts && grep -q 'satisfies ExportedHandler<Env>' apps/atlas/src/index.ts && grep -q 'atlas:noop:' apps/atlas/src/index.ts && grep -q 'export { AtlasCoordinator }' apps/atlas/src/index.ts && [ "$(grep -cE 'consumers\|async queue' apps/atlas/src/index.ts)" -eq 0 ]` | W3 | ⬜ pending |
| 00-03 / Task 3 | 03 | 3 | SPINE-01 | T-00-34 | Wire-contract + single-instance DO + failure-path (heartbeat-stale → P1) tests in `workerd` | integration (DO + scheduled) | `pnpm --filter atlas test` | W3 | ⬜ pending |
| 00-04 / Task 1 | 04 | 3 | SPINE-02 | T-00-20 / T-00-25 / T-00-27 | Atomic `INSERT OR IGNORE` + conditional bump; `meta.changes === 0` replay-skip; no `DELETE`; positional-`?` only | unit (build + grep) | `pnpm --filter @atlas/steward-core build && pnpm -r typecheck && grep -q "INSERT OR IGNORE INTO idempotency_keys" packages/steward-core/src/apply.ts && grep -q "meta.changes === 0" packages/steward-core/src/apply.ts && ! grep -qiE "\"DELETE\"\|method.*DELETE\|'\?1'\|:name" packages/steward-core/src/op-mapping.ts && echo PASS` | W3 | ⬜ pending |
| 00-04 / Task 2 | 04 | 3 | SPINE-02/05 | T-00-21 / T-00-22 / T-00-24 | Single `getByName("vault")` writer; `dead_letter_queue` set; no `retry_delay_secs`; no `Promise.all`; exactly one `atlas-wire` consumer | unit (typecheck + CI grep gate) | `pnpm -r typecheck && grep -q 'getByName("vault")' apps/steward/src/steward-consumer.ts && grep -q "blockConcurrencyWhile" apps/steward/src/steward.ts && grep -q '"dead_letter_queue": "atlas-wire-dlq"' apps/steward/wrangler.jsonc && ! grep -q "retry_delay_secs" apps/steward/wrangler.jsonc && ! grep -q "Promise.all" apps/steward/src/steward-consumer.ts && node -e 'const fs=require("fs");let n=0;for(const d of fs.readdirSync("apps")){const p="apps/"+d+"/wrangler.jsonc";if(!fs.existsSync(p))continue;const s=fs.readFileSync(p,"utf8").replace(/\/\/.*$/gm,"").replace(/\/\*[\s\S]*?\*\//g,"").replace(/,(\s*[}\]])/g,"$1");const j=JSON.parse(s);const c=j.queues&&j.queues.consumers?j.queues.consumers:[];if(c.some(x=>x.queue==="atlas-wire"))n++;}if(n!==1)process.exit(1);' && echo PASS` | W3 | ⬜ pending |
| 00-04 / Task 3 | 04 | 3 | SPINE-02/05 | T-00-20 / T-00-21 / T-00-23 | replay (`meta.changes===0`, counter 1 not 2) + serialize (50 concurrent applies) + malformed (ack + P3, no write) | unit (the three mandatory tests) | `pnpm --filter steward exec vitest run test/replay.test.ts test/serialize.test.ts test/malformed.test.ts` | W3 | ⬜ pending |
| 00-05 / Task 1 | 05 | 3 | SPINE-05 | T-00-35 / T-00-36 | dlq-sink consumes `atlas-wire-dlq` ONLY (not a second `atlas-wire` consumer); no `retry_delay_secs`; no secrets in config | unit (config grep) | `grep -E '"queue": *"atlas-wire-dlq"' apps/dlq-sink/wrangler.jsonc && grep -cv '^[[:space:]]*//' apps/dlq-sink/wrangler.jsonc \| head -1 >/dev/null && ! grep -E '"queue": *"atlas-wire"[^-]' apps/dlq-sink/wrangler.jsonc \| grep -v producers && ! grep -q 'retry_delay_secs' apps/dlq-sink/wrangler.jsonc && grep -q 'nodejs_compat' apps/dlq-sink/wrangler.jsonc && echo PASS` | W3 | ⬜ pending |
| 00-05 / Task 2 | 05 | 3 | SPINE-05 | T-00-30 / T-00-31 / T-00-32 / T-00-33 / T-00-34 | Dead event → `audit_log` row + Flagger P2/P3, then `ack` (never silent loss, never retry-loop); stable `flagger:dlq:<date>:<hash>` key | unit (failure-path) | `pnpm --filter dlq-sink test && pnpm --filter dlq-sink typecheck` | W3 | ⬜ pending |
| 00-06 / Task 1 | 06 | 4 | SPINE-04 | T-00-21 / T-00-23 / T-00-24 / T-00-27 | Google `access_type=offline`+`prompt=consent`+S256; GitHub App RS256 JWT; creds via Secrets Store bindings only | unit (typecheck + grep) | `pnpm -r typecheck && grep -q "access_type" apps/atlas/src/oauth/google.ts && grep -q "prompt=consent\|'consent'\|\"consent\"" apps/atlas/src/oauth/google.ts && grep -q "S256" apps/atlas/src/oauth/google.ts && grep -q "GOOGLE_REFRESH_TOKEN" apps/atlas/src/oauth/google.ts && grep -q "appJwt" apps/atlas/src/oauth/github.ts && grep -q "GH_APP_PRIVATE_KEY" apps/atlas/src/oauth/github.ts && echo PASS` | W4 | ⬜ pending |
| 00-06 / Task 2 | 06 | 4 | SPINE-04 | T-00-22 / T-00-26 | Inbound OAuthProvider front door with least-privilege `scopesSupported`; composes with dispatcher; needs `OAUTH_KV` | unit (typecheck + grep) | `pnpm -r typecheck && grep -q "OAuthProvider" apps/atlas/src/index.ts && grep -q "scopesSupported" apps/atlas/src/index.ts && grep -q "scheduled" apps/atlas/src/index.ts && grep -q "AtlasCoordinator" apps/atlas/src/index.ts && grep -q "OAUTH_KV\|apiRoute" apps/atlas/src/index.ts && grep -q "completeAuthorization" apps/atlas/src/auth/consent.ts && echo PASS` | W4 | ⬜ pending |
| 00-06 / Task 3 | 06 | 4 | SPINE-04 | T-00-22 / T-00-23 / T-00-24 / T-00-25 | Authorize-URL flags asserted; refresh keeps original token; JWT claims valid; no-secret-leak (no token to KV/`audit_log`/consent render) | unit (OAuth round-trip, mocked) | `pnpm test -- apps/atlas/test/oauth.test.ts` | W4 | ⬜ pending |
| 00-06 / Task 4 | 06 | 4 | SPINE-04 | T-00-21 / T-00-22 | Owner provisions GCP project + published consent screen + Web OAuth client (least-privilege redirect URI) | manual | MANUAL | W4 | ⬜ pending |
| 00-06 / Task 5 | 06 | 4 | SPINE-04 | T-00-24 | Owner registers GitHub App (not a PAT) + generates PKCS8 RS256 private key + installs for an installation id | manual | MANUAL | W4 | ⬜ pending |
| 00-06 / Task 6 | 06 | 4 | SPINE-04 | T-00-21 / T-00-23 / T-00-25 / T-00-27 | Owner seeds Secrets Store + runs LIVE Google/GitHub round-trips (Success Criterion 4); proves no secret leaks | manual | MANUAL | W4 | ⬜ pending |
| 00-07 / Task 1 | 07 | 4 | SPINE-03 | T-00-71 / T-00-72 | Codex read-only (`drive.readonly`, no write/mutate export); holds facts, zero credentials | unit (read test + read-only grep) | `pnpm --filter @atlas/codex build && pnpm --filter @atlas/codex typecheck && pnpm vitest run packages/codex/test/read.test.ts` | W4 | ⬜ pending |
| 00-07 / Task 2 | 07 | 4 | SPINE-03 | T-00-73 / T-00-74 / T-00-75 / T-00-76 | `claudeFor` routes only via AI Gateway (no `api.anthropic.com`); dateless model ids only; `model_error` Wire emit on failure | unit (model factory) | `pnpm --filter @atlas/model build && pnpm --filter @atlas/model typecheck && pnpm vitest run packages/model` | W4 | ⬜ pending |
| 00-08 / Task 1 | 08 | 5 | SPINE-04 | T-00-30 / T-00-31 | mcp-google strips 2FA/reset bodies server-side regardless of scope; `gmail.modify` 403 floor; no delete tool registered | unit (redact + scope) | `pnpm --filter mcp-google build && pnpm --filter mcp-google typecheck && vitest run apps/mcp-google/test/redact.test.ts apps/mcp-google/test/scope.test.ts` | W5 | ⬜ pending |
| 00-08 / Task 2 | 08 | 5 | SPINE-04/05 | T-00-32 / T-00-33 / T-00-35 / T-00-37 | mcp-github opaque per-run token; bridge `/poll`+`/ack` token-gated; op→REST v3 never DELETE; still exactly one `atlas-wire` consumer | integration (bridge + CI parse gate) | `pnpm --filter mcp-github build && pnpm --filter mcp-github typecheck && pnpm --filter mcp-obsidian-bridge build && pnpm --filter mcp-obsidian-bridge typecheck && vitest run apps/mcp-obsidian-bridge/test/bridge.test.ts && node -e 'const fs=require("fs");let n=0;for(const d of fs.readdirSync("apps")){const p="apps/"+d+"/wrangler.jsonc";if(!fs.existsSync(p))continue;const s=fs.readFileSync(p,"utf8").replace(/\/\/.*$/gm,"").replace(/\/\*[\s\S]*?\*\//g,"").replace(/,(\s*[}\]])/g,"$1");const j=JSON.parse(s);const c=j.queues&&j.queues.consumers?j.queues.consumers:[];if(c.some(x=>x.queue==="atlas-wire"))n++;}if(n!==1)process.exit(1);'` | W5 | ⬜ pending |
| 00-08 / Task 3 | 08 | 5 | SPINE-05 | T-00-34 / T-00-35 / T-00-36 / T-00-38 | Daemon outbound-only (no listening socket / no `Sockets` plist key); `127.0.0.1:27124` self-signed only; no DELETE; no hard-coded secret | unit (typecheck + grep) | `npx tsc --noEmit -p daemon/tsconfig.json && grep -q "127.0.0.1:27124" daemon/src/drain.ts && grep -q "com.atlas.bridge" daemon/com.atlas.bridge.plist && ! grep -iE "Sockets\|Listeners\|inetdCompatibility" daemon/com.atlas.bridge.plist && ! grep -iE "method *: *[\"']?DELETE" daemon/src/drain.ts && echo PASS` | W5 | ⬜ pending |
| 00-08 / Task 4 | 08 | 5 | SPINE-05 | T-00-34 / T-00-37 | Owner installs Obsidian Local REST API v3.0+, mints `ATLAS_BRIDGE_TOKEN`, registers launchd, proves no inbound port + live increment + replay no-op | manual | MANUAL | W5 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Test framework (`vitest` + `@cloudflare/vitest-pool-workers`) is installed in **00-01 Task 1 (Wave 1)** alongside the monorepo scaffold; no separate Wave-0 bootstrap is needed. The root `vitest.workspace.ts` is created by 00-01 Task 1; each owning plan creates its own per-package/per-app `vitest.config.ts` (`defineWorkersConfig` with `nodejs_compat` + `isolatedStorage`). Because every file is greenfield (authored in-phase), there are no pre-existing test stubs to fill — the three mandatory test files plus the failure-path tests are authored by the plans that own the code they exercise:

- [ ] `packages/wire/test/contract.test.ts` — **Wire-contract test** (Definition of Done #1): every emitted event parses against the single §6.4 `WireEvent` zod schema + structured `idempotencyKey` regex (created in **00-02**).
- [ ] `apps/steward/test/replay.test.ts` — **Replay test** (Definition of Done #2): same `idempotencyKey` twice ⇒ counter is 1 not 2, `meta.changes === 0` (created in **00-04**).
- [ ] `apps/steward/test/serialize.test.ts` — single-writer serialization (50 concurrent `apply()`, no lost/double updates) (created in **00-04**).
- [ ] `apps/steward/test/malformed.test.ts` — **Failure-path test** (Definition of Done #3): malformed event ⇒ `ack()` + Flagger **P3**, no write (created in **00-04**).
- [ ] `packages/security/test/redact.test.ts` — **redaction CI backstop** (CI invariant #2): no 2FA code / reset link / login URL survives, benign text untouched (created in **00-02**; reused server-side by mcp-google's `apps/mcp-google/test/redact.test.ts` in **00-08**).
- [ ] `apps/dlq-sink/test/*` — **DLQ failure-path test** (SPINE-05): exhausted-retry dead event ⇒ `audit_log` row + Flagger P2/P3, then `ack` (never silent loss) (created in **00-05**).
- [ ] CI structural gate: exactly one `atlas-wire` consumer grep (asserted by **00-04 Task 2** and **00-08 Task 2**); a second consumer is a hard build failure (CI invariant #1).

---

## Manual-Only Verifications

> Owner-provisioning gates (`type="checkpoint:human-action"`, `autonomous:false`) and the live OAuth round-trips. These have no CLI/API substitute — they require GUI/account/OS actions on the owner's machine. The automated suites prove the contract *shapes* against stubs; these gates prove the *live* behavior with real credentials and the real laptop.

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| GCP OAuth client + published consent screen (00-06 Task 4) | SPINE-04 | Consent-screen publishing + browser authorize is human-only; no CLI fully scripts it | In Google Cloud Console: create/select a project; enable Gmail/Calendar/Pub-Sub APIs; create the `gmail-filer` topic + grant `gmail-api-push@system.gserviceaccount.com` Publisher; publish the OAuth consent screen; create a "Web application" OAuth client with the deployed Atlas `/authorize` redirect URI; download client id + secret. Resume signal: `google-oauth-ready`. |
| GitHub App registration + RS256 private key (00-06 Task 5) | SPINE-04 | Registering an App and generating its PKCS8 key is a GitHub-UI-only action (no scriptable CLI); a PAT is explicitly disallowed | At github.com/settings/apps → New GitHub App: register under the owner account with the narrowest permissions; generate the PKCS8 `.pem` private key; note the App client id; install the App to obtain an installation id. Resume signal: `github-app-ready`. |
| Secrets Store seeding + LIVE OAuth round-trips (00-06 Task 6) | SPINE-04 (Success Criterion 4) | Seeding the single per-account Secrets Store with live credentials and running the real authorize/refresh/JWT round-trips needs real provider credentials | `wrangler secrets-store store create atlas --remote`; seed `google-oauth-client-secret` / `google-refresh-token` (captured from the first live authorize) / `github-app-private-key`; set `ANTHROPIC_API_KEY` + `CF_AIG_TOKEN` via `wrangler secret put`; confirm matching `secrets_store_secrets` bindings; verify NO secret value in any `[vars]`/KV/Vault/Codex/`audit_log`. Prove: Google exchange returns a `refresh_token`; `grant_type=refresh_token` returns a fresh access token without re-consent; GitHub App JWT mints an opaque `ghs_` token (~1h). Un-skip the live `it.skip` test or run the documented curl. Resume signal: `secrets-store-ready`. |
| Obsidian bridge live end-to-end + no-inbound-port proof (00-08 Task 4) | SPINE-05 | Installing the Obsidian plugin, minting `ATLAS_BRIDGE_TOKEN`, registering launchd, and the `lsof` proof are GUI/OS actions on the owner's laptop | Install + enable Obsidian Local REST API plugin v3.0+ (listening `https://127.0.0.1:27124`); mint `ATLAS_BRIDGE_TOKEN` into Secrets Store / `wrangler secret put` AND the daemon's git-ignored local env; `launchctl load ~/Library/LaunchAgents/com.atlas.bridge.plist`; run `lsof -i -nP \| grep LISTEN` and confirm the ONLY listener is Obsidian's `127.0.0.1:27124` (no Atlas/daemon inbound port); seed one `increment` write-intent into `vault_outbox`, confirm it lands in `Counters/metrics.md` frontmatter (absolute value), and re-running the same Wire message leaves the counter unchanged (replay no-op). Resume signal: `approved` with the `lsof` line. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are explicit owner-provisioning gates (22 automated; 4 manual checkpoint gates — 00-06 Tasks 4/5/6, 00-08 Task 4)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (the only manual cluster is 00-06 Tasks 4–6 + 00-08 Task 4, each a deliberate blocking owner gate; every automated task carries a verify command)
- [x] Wave 0 covers all MISSING references (framework installed in 00-01 Task 1; the three mandatory test files + DLQ failure-path + redaction backstop are authored by their owning plans — none are missing/deferred)
- [x] No watch-mode flags (every command uses `vitest run` / `pnpm test` / `pnpm -r test` — no `--watch`)
- [x] Feedback latency < 90s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-06-04
