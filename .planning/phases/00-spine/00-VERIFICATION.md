---
phase: 00-spine
verified: 2026-06-05T06:37:42Z
status: human_needed
score: 5/5 must-haves verified (code deliverables); 3 live owner-gates pending
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
  note: initial verification
human_verification:
  - test: "Google OAuth offline-consent live round-trip (00-06 Gate A/B)"
    expected: "authorize URL with access_type=offline + prompt=consent + S256 PKCE → real GCP code exchange returns a refresh_token; a subsequent grant_type=refresh_token call returns a fresh access_token without re-consent. The 2 describe.skip('LIVE OAuth round-trip') tests in apps/atlas/test/oauth.test.ts pass once credentials exist."
    why_human: "Requires the owner to create a real Google Cloud OAuth client + complete the consent flow in a browser; no credential can be fabricated. Code + mocked-exchange contract is fully proven (37 active OAuth/consent tests pass)."
  - test: "GitHub App live round-trip (00-06 Gate B)"
    expected: "a jose-signed RS256 App JWT (iss=App client id, iat backdated 60s, exp ≤10min) mints an opaque ghs_ installation token (~1h) against the real GitHub App; token used per-run, never persisted, never returned to the MCP client."
    why_human: "Requires the owner to register a real GitHub App and install it; the private key cannot be fabricated. Helper code + JWT-claim tests pass against mocked exchanges."
  - test: "Seed 6 secrets into Cloudflare Secrets Store (00-06 Gate C)"
    expected: "wrangler secrets-store store create atlas --remote (one store/account), then seed GOOGLE_CLIENT_SECRET (google-oauth-client-secret), GOOGLE_REFRESH_TOKEN (google-refresh-token), GH_APP_PRIVATE_KEY (github-app-private-key), OWNER_AUTH_TOKEN, SESSION_SIGNING_KEY, ATLAS_BRIDGE_TOKEN; replace the <atlas-store-id> placeholder in apps/atlas|mcp-google|mcp-github|mcp-obsidian-bridge wrangler.jsonc with the real store id. Exact commands in 00-06-SUMMARY 'User Setup Required'."
    why_human: "Secrets Store provisioning is a manual owner action (open beta, one store per account); bindings are declared-and-ready with the placeholder. No secret was fabricated."
  - test: "Obsidian bridge end-to-end drain + no-inbound-port proof + launchd registration (00-08 Gate D)"
    expected: "Install the Obsidian Local REST API v3 plugin (loopback 127.0.0.1:27124), seed ATLAS_BRIDGE_TOKEN, register daemon/com.atlas.bridge.plist via launchd, then prove a Steward vault_outbox intent drains into the Vault end-to-end AND `lsof -iTCP -sTCP:LISTEN` shows ONLY Obsidian's 27124 bound to 127.0.0.1 (no inbound Atlas port). Exact commands in 00-08-SUMMARY 'User Setup Required'."
    why_human: "Requires a local macOS daemon install + Obsidian plugin + a running laptop; cannot be exercised in CI. Cloud bridge (poll/ack token-gated, 404 elsewhere) + outbound-only daemon skeleton are code-complete and unit-proven (17 bridge + daemon tests pass); the daemon opens no listening socket by construction."
  - test: "Provision the atlas-blobs R2 bucket (00-01 deviation)"
    expected: "Owner enables R2 in the Cloudflare Dashboard (account ed894b1ee21ec8e5960e959fe2d336ce), then `wrangler r2 bucket create atlas-blobs` + `wrangler r2 bucket lifecycle add atlas-blobs --name expire-raw-audio --prefix 'audio/raw/' --expire-days 7`. The BLOBS binding already references atlas-blobs."
    why_human: "R2 is not enabled on the account (Cloudflare API error 10042) — enabling R2 is a one-time Dashboard action that cannot be automated via wrangler/CLI. BLOBS binding is declared-and-ready; no Phase-0 code path uses R2 yet (raw Echo audio is a Phase-3 concern)."
deferred: []
---

# Phase 0: Spine Verification Report

**Phase Goal:** Stand up the infrastructure spine on which every agent runs — orchestration, the event bus, the single Vault writer, the source of truth, and OAuth — with Steward's serialization + idempotency correct from day 0. Ships zero user-visible features.
**Verified:** 2026-06-05T06:37:42Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

The CODE deliverables and all hard invariants are verified true in the codebase. Per the owner's explicit "accept code-complete, defer activation" decision, the LIVE round-trips that require external owner provisioning (Google/GitHub OAuth, Secrets Store seeding, the Obsidian-bridge end-to-end drain, R2 enablement) are reported as `human_verification` items with exact owner commands — they are deferred by design, not gaps. Status is therefore `human_needed`: the code passed; live owner-verification is pending.

### Observable Truths

| # | Truth (Success Criterion) | Status | Evidence |
|---|---------------------------|--------|----------|
| 1 | SPINE-01 — Atlas can schedule a no-op agent and route a message onto the Wire | ✓ VERIFIED | `apps/atlas/src/index.ts:97-114` dispatcher: cron `45 12 * * *` → `env.NOOP.tick({...})` (D-11 service-binding RPC to `apps/atlas/src/noop-agent.ts` `NoopAgent.tick()`) → `send(env,{agent:"Atlas",…,op:"append",idempotencyKey:"atlas:noop:${localDate(env)}"})` (stable structured key, never UUID). `apps/atlas/test/scheduled.test.ts` drives it; 37 atlas tests pass. |
| 2 | SPINE-02 — Steward consumes one §6.4 event serialized single-consumer; replay leaves counter unchanged (meta.changes===0) | ✓ VERIFIED | `packages/steward-core/src/apply.ts` runs ONE atomic `db.batch([counter-bump, run_log, vault_outbox, ledger-insert])` inside `blockConcurrencyWhile` (`apps/steward/src/steward.ts:43`); both counter branches replay-guarded by `WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key=?)` (W9 fix); delta coerced via `Number()` + NonRetryableError (C2 fix); C1 fix folds run_log/outbox INTO the batch (no post-batch `.run()`). `apps/steward/test/replay.test.ts` + `apply-crux.test.ts` + `serialize.test.ts` prove `applied:false` on replay / 50-concurrent sum exact. 19 steward tests pass. |
| 3 | SPINE-03 — The Codex exists with the §11 sections, read-only to agents | ✓ VERIFIED | `packages/codex/src/codex.ts` reads via `drive.readonly`, returns the 7 §11 sections, cached as an ephemeral `cache_control {type:'ephemeral'}` system block. `packages/codex/src/index.ts` barrel exports ONLY `read`/`codexSystemBlock`/`parseCodex` + types — NO write/PATCH/PUT/DELETE/POST export. W17/I29 YAML-parser silent-loss fixes applied. 11 codex tests pass. |
| 4 | SPINE-04 — Google (least-priv) + GitHub (App) OAuth round-trips succeed; tokens in Secrets Store, never in Vault/Codex | ✓ VERIFIED (code) / ⏳ live deferred | `apps/atlas/src/oauth/google.ts` (access_type=offline+prompt=consent+S256 PKCE+refresh helper), `oauth/github.ts` (jose RS256 appJwt → opaque ghs_ per-run installation token), `auth/consent.ts` (scope-floor enforced 400, CSRF, single-use consent record, owner-session gate — 2 adversarial security rounds remediated). All 6 secrets declared ONLY as `secrets_store_secrets` bindings (no `[vars]`/KV leak). 37 active OAuth/consent tests pass; the 2 LIVE round-trip tests are `describe.skip` pending owner credentials (human_verification #1–#3). |
| 5 | SPINE-05 — DLQ exists; exhausted msg → audit row + P2/P3 incident, never silent; outbound-only bridge drains Steward writes | ✓ VERIFIED (code) / ⏳ live drain deferred | `apps/steward/wrangler.jsonc` consumer sets `dead_letter_queue:"atlas-wire-dlq"` + `max_concurrency:1`; `apps/dlq-sink/src/index.ts` consumes ONLY atlas-wire-dlq → writes `audit_log` row (outcome='dlq', scope_used, never token) + emits Flagger P2/P3 via `flag()`. `apps/mcp-obsidian-bridge` exposes ONLY token-gated `/bridge/poll`+`/bridge/ack` (404 elsewhere); op→REST map is DELETE-free (`SAFE_METHODS=["PATCH","POST"]`); W14 claim/lease (migration `0002` + atomic `UPDATE…RETURNING` + stale-claim reclaim). `daemon/src/drain.ts` is outbound-only (no `.listen()`/server). 4 dlq-sink + 17 bridge/daemon tests pass. The live end-to-end drain + lsof no-inbound-port proof is human_verification #4. |

**Score:** 5/5 truths verified at the code/invariant level. SPINE-04 + SPINE-05 each carry a live owner-gate that is deferred by explicit decision (reported as human_verification, not gaps).

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `apps/atlas/src/{index,coordinator,noop-agent}.ts` | ✓ VERIFIED | Dispatcher + heartbeat (C5 armed/fed each tick, C6 cold-start seed, C7 setAlarm in finally) + no-op RPC target. |
| `apps/steward/src/{steward,steward-consumer}.ts` + `packages/steward-core/src/{apply,op-mapping}.ts` | ✓ VERIFIED | Atomic batch crux; sole atlas-wire consumer; W8 malformed-payload gate; DELETE-free map. |
| `apps/dlq-sink/src/index.ts` | ✓ VERIFIED | Sole atlas-wire-dlq consumer; audit_log + Flagger P2/P3. |
| `packages/wire/src/{contract,send}.ts` | ✓ VERIFIED | Single §6.4 WireEvent zod schema; `WireEvent.parse` at producer boundary; W11 128KB cap. |
| `packages/security/src/redact.ts` | ✓ VERIFIED | C3/C4/W10 + full-width-CJK hardening; covers 6–8 digit/formatted/full-width codes, login/signin/auth/sso/magic URLs, token/otp/code query markers, OTP/passcode phrases. 39 security tests pass. |
| `packages/codex/src/codex.ts` (+ barrel) | ✓ VERIFIED | Read-only; no mutating export. |
| `packages/model/src/claude.ts` | ✓ VERIFIED | AI-Gateway routing (never api.anthropic.com); W18 model-id allowlist; W19/I30 connection/empty-config flag. |
| `apps/atlas/src/oauth/{google,github}.ts` + `auth/{consent,session,scopes,clients}.ts` | ✓ VERIFIED | OAuth helpers + hardened consent front door. |
| `apps/mcp-google/src/index.ts` (+ scope/redact tests) | ✓ VERIFIED | Server-side strip + gmail.modify 403 floor; I28 isError on leak. 20 tests pass. |
| `apps/mcp-github/src/index.ts` | ✓ VERIFIED | Stateful McpAgent + OAuthProvider; W15 clean-error; passWithNoTests (live DO round-trip is owner-gated). 3 tests pass. |
| `apps/mcp-obsidian-bridge/src/{index,bridge/poll,bridge/ack}.ts` | ✓ VERIFIED | Token-gated poll/ack; 404 elsewhere; W14 claim. 17 tests pass. |
| `daemon/src/drain.ts` + `daemon/com.atlas.bridge.plist` | ✓ VERIFIED (code) | Outbound-only drain; plist has no listener key. Live install is human_verification #4. |
| `migrations/0001_init_core.sql` + `0002_vault_outbox_claim.sql` | ✓ VERIFIED | 5 system-of-record tables; vault_outbox claim/lease. |
| `apps/atlas/wrangler.jsonc` BLOBS/atlas-blobs R2 | ⚠️ DECLARED-NOT-PROVISIONED | Binding declared-and-ready; bucket creation deferred (R2 not enabled on account — human_verification #5). |

### Key Link Verification

All key links verified by manual code inspection. NOTE: the `gsd-sdk verify.key-links` tool reported several false-negative NOT_WIRED results caused by regex-escaping artifacts (`flag\\(`, `DB\\.batch\\(`, `SECRET_PATTERNS|redact\\(`) and by the code routing through helpers (`send(env,…)` not literal `WIRE.send`; `INSERT OR REPLACE INTO audit_log` not `INSERT INTO audit_log`; `@atlas/security`/`@atlas/steward-core` imports). Each was confirmed WIRED against the actual source.

| From | To | Via | Status |
|------|----|----|--------|
| atlas/index.ts | atlas-wire | `send(env,{…})` parse-then-send in scheduled() (line 106) | ✓ WIRED |
| atlas/index.ts | no-op agent | `env.NOOP.tick()` service-binding RPC (line 101) | ✓ WIRED |
| atlas/coordinator.ts | Flagger | `flag(env,"P1",…)` in alarm() (line 91) | ✓ WIRED |
| wire/send.ts | wire/contract.ts | `WireEvent.parse(event)` (line 51) | ✓ WIRED |
| shared/flag.ts | @atlas/wire | imports `{WireEvent,send}`, `await send(env,event)` (line 108) | ✓ WIRED |
| steward-consumer.ts | StewardWriter DO | `env.STEWARD_LOCK.getByName("vault")` (line 51) | ✓ WIRED |
| steward.ts | D1 idempotency/counters | `db.batch([...])` in blockConcurrencyWhile | ✓ WIRED |
| steward.wrangler | atlas-wire-dlq | `dead_letter_queue:"atlas-wire-dlq"` | ✓ WIRED |
| steward-consumer.ts | Flagger | `flag(env,"P3"/"P2",…)` (lines 67,84,94) | ✓ WIRED |
| dlq-sink/index.ts | audit_log | `INSERT OR REPLACE INTO audit_log(...)` (line 126) | ✓ WIRED |
| dlq-sink/index.ts | atlas-wire (Flagger) | `await flag(env,severity,…)` (line 148) | ✓ WIRED |
| mcp-google/index.ts | @atlas/security | `import {redact,containsSecret}` (line 31); `redact(body)` (line 111) | ✓ WIRED |
| mcp-obsidian-bridge/index.ts | @atlas/steward-core | `import {SAFE_METHODS}` (line 23) | ✓ WIRED |
| daemon/drain.ts | /bridge/poll + /bridge/ack | outbound fetch w/ Bearer (lines 86, 13) | ✓ WIRED |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Workspace typecheck (strict TS) | `pnpm -r typecheck` | all packages "Done", exit 0 | ✓ PASS |
| Full test suite in workerd | `pnpm test` | exit 0; 185 passing / 2 skipped (the 2 skips = LIVE OAuth round-trips, `describe.skip`) | ✓ PASS |
| Pillar 1 — exactly one atlas-wire consumer | node-parse structural gate over `apps/*/wrangler.jsonc` | "PASS: exactly 1 atlas-wire consumer" (Steward) | ✓ PASS |
| No direct api.anthropic.com | `grep -rn api.anthropic.com apps/ packages/ daemon/` | only a test asserting baseURL does NOT contain it | ✓ PASS |
| No Vault DELETE path | inspect `SAFE_METHODS` + op-mapping | `["PATCH","POST"]`; runtime belt throws on non-safe verb | ✓ PASS |
| Secrets only via bindings | parse `vars` blocks for secret names | no LEAK; all 6 secrets in `secrets_store_secrets` only | ✓ PASS |
| Daemon opens no inbound socket | `grep .listen/createServer/serve daemon/src` | none found (outbound-only) | ✓ PASS |

### Probe Execution

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| (none declared) | — | No `scripts/*/tests/probe-*.sh` and no probes declared in PLAN/SUMMARY | SKIPPED |

The phase's verification harness is the Vitest suite (185 pass / 2 deferred-skip) + the runnable Pillar-1 structural gate (`.claude/hooks/guard-wire-consumer.js`, PASS) — both executed above.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SPINE-01 | 00-01, 00-03 | Schedule no-op + route onto Wire | ✓ SATISFIED | Truth #1 — dispatcher + tests pass |
| SPINE-02 | 00-01, 00-02, 00-04 | Steward §6.4 serialized + replay-idempotent | ✓ SATISFIED | Truth #2 — atomic batch + replay test |
| SPINE-03 | 00-07 | Codex §11 sections read-only | ✓ SATISFIED | Truth #3 — read-only barrel + 11 tests |
| SPINE-04 | 00-06, 00-08 | OAuth (least-priv Google + GitHub App), tokens in Secrets Store | ✓ CODE SATISFIED / live owner-gated | Truth #4 — code+mocked tests pass; live round-trip + secret seeding = human_verification #1–#3. REQUIREMENTS.md marks it Pending (correct). |
| SPINE-05 | 00-01, 00-04, 00-05, 00-08 | DLQ → audit+incident never silent; outbound-only bridge | ✓ CODE SATISFIED / live drain owner-gated | Truth #5 — DLQ sink + bridge + daemon code/tests pass; live end-to-end drain + lsof = human_verification #4. |

No orphaned requirements — all five SPINE IDs are claimed by plans and accounted for.

### Code Review Remediation Spot-Check (00-REVIEW.md)

Spot-checked the claimed remediations against actual code (not the SUMMARY): C1 (run_log/outbox folded into the atomic batch — confirmed in apply.ts, no post-batch `.run()`), C2 (`Number()` + NonRetryableError on non-integer delta — runtime-confirmed: the suite logged the thrown `NonRetryableError: non-integer counter delta` as an exercised path), C3/C4/W10 (redaction patterns now cover multi-digit/formatted/full-width/login-URL — confirmed in redact.ts), C5/C6/C7 (heartbeat armed+fed in scheduled(), cold-start seed, setAlarm in finally — confirmed in index.ts/coordinator.ts), W9 (both counter branches replay-guarded — confirmed), W14 (vault_outbox claim/lease — confirmed in migration 0002 + poll.ts). The 7 deferred cosmetic/Phase-2 items (W12, W13, I21, I23, I25, I26, I27) are tracked and non-blocking.

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| (none) | TBD/FIXME/XXX scan of phase files | — | No unreferenced debt markers found in modified source. The `<atlas-store-id>` placeholder in wrangler.jsonc is a documented owner-provisioning handoff (00-06 Gate C), not a code stub. |

The grep matches for "not yet implemented"/"will be here" in comments are documentation of the deferred owner gates (placeholders intentionally pending provisioning), not stubbed behavior — all data paths are populated by real D1 queries / fetches / parse logic, confirmed via the test suite.

### Human Verification Required

Five items require owner action (all deferred by the explicit "accept code-complete, defer activation" decision; none are code gaps). Exact commands live in the 00-01 / 00-06 / 00-08 SUMMARYs' "User Setup Required" sections:

1. **Google OAuth offline-consent live round-trip** (00-06 Gate A/B) — create the GCP OAuth client + complete consent; the 2 `describe.skip` LIVE tests pass once credentials exist.
2. **GitHub App live round-trip** (00-06 Gate B) — register + install the GitHub App; verify per-run `ghs_` token mint.
3. **Seed 6 secrets into Cloudflare Secrets Store** (00-06 Gate C) — `wrangler secrets-store store create atlas --remote` + seed GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN/GH_APP_PRIVATE_KEY/OWNER_AUTH_TOKEN/SESSION_SIGNING_KEY/ATLAS_BRIDGE_TOKEN; replace `<atlas-store-id>` placeholders.
4. **Obsidian bridge end-to-end drain + no-inbound-port proof + launchd** (00-08 Gate D) — install Obsidian Local REST v3 plugin, register `com.atlas.bridge.plist`, prove a vault_outbox intent reaches the Vault AND `lsof` shows no inbound Atlas port.
5. **Provision atlas-blobs R2 bucket** (00-01 deviation) — enable R2 in the Dashboard, then `wrangler r2 bucket create atlas-blobs` + the `audio/raw/` 7-day lifecycle.

### Gaps Summary

No code gaps. Every Phase-0 code deliverable exists, is substantive, is wired, and is exercised by the 185-passing test suite running in real workerd. All hard invariants hold in the actual codebase: Pillar 1 (Steward is the sole atlas-wire consumer — structural gate PASS), the redaction backstop (multi-digit/login-URL/full-width-CJK coverage), no direct api.anthropic.com, no Vault DELETE path (SAFE_METHODS=PATCH/POST only), secrets only via Secrets Store bindings. The 7 critical + must-fix code-review findings are remediated with proving tests (spot-checked against source). The only outstanding work is the live owner-provisioning that the owner explicitly deferred — surfaced above as human_verification with exact commands.

---

_Verified: 2026-06-05T06:37:42Z_
_Verifier: Claude (gsd-verifier)_
