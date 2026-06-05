---
status: partial
phase: 00-spine
source: [00-VERIFICATION.md]
started: "2026-06-05T06:40:00Z"
updated: "2026-06-05T06:40:00Z"
---

## Current Test

[awaiting human testing — owner provisioning gates deferred by explicit decision]

> Phase 0 code deliverables are verified complete (5/5 must-haves, 185 tests passing, all
> invariants hold). The items below are **live activation** that require external owner action
> (Google/GitHub consoles, Cloudflare Secrets Store + Dashboard, the local Mac). Full per-gate
> commands live in `00-01-SUMMARY.md` (R2), `00-06-SUMMARY.md` (Gates A/B/C), `00-08-SUMMARY.md` (Gate D).

## Tests

### 1. Google OAuth offline-consent live round-trip (SPINE-04, Gate A/B)
expected: After creating the GCP project + confidential Web OAuth client (Gmail/Calendar/Pub/Sub APIs, published consent screen, `gmail-filer` topic + Publisher grant) and signing in at `/login`, the live `/authorize` round-trip returns a `refresh_token`; a `grant_type=refresh_token` exchange returns a fresh access token with NO re-consent. (Un-skip the `describe.skip("LIVE …")` Google block in `apps/atlas/test/oauth.test.ts`.)
result: [pending]

### 2. GitHub App installation-token live round-trip (SPINE-04, Gate B)
expected: A registered GitHub App (NOT a PAT; contents/metadata perms; PKCS8 RS256 key) mints an opaque `ghs_…` installation token via the RS256 JWT path. (Un-skip the LIVE GitHub block in `oauth.test.ts`.)
result: [pending]

### 3. Seed secrets into Cloudflare Secrets Store (SPINE-04, Gate C)
expected: `wrangler secrets-store store create atlas` → fill `<atlas-store-id>` into all wrangler.jsonc placeholders (atlas + mcp-obsidian-bridge); create the 6 secrets (`google-oauth-client-secret`, `google-refresh-token`, `github-app-private-key`, `owner-auth-token`, `session-signing-key`, `atlas-bridge-token`) + `wrangler secret put ANTHROPIC_API_KEY` / `CF_AIG_TOKEN`; fill `[vars]` (`GOOGLE_CLIENT_ID`, `GOOGLE_REDIRECT_URI`, `GH_APP_CLIENT_ID`, `CLIENT_REGISTRY`). `secrets-store secret list` shows the secrets; a tracked-file grep shows NO secret value committed.
result: [pending]

### 4. Obsidian bridge end-to-end drain + no-inbound-port proof + launchd (SPINE-05, Gate D)
expected: Obsidian Local REST API v3+ listening on `127.0.0.1:27124`; `ATLAS_BRIDGE_TOKEN` set on both sides; launchd plist installed + loaded. `lsof -i -nP | grep LISTEN` shows ONLY Obsidian's `127.0.0.1:27124` (no Atlas/daemon inbound port). E2E: seed one `increment` write-intent into `vault_outbox` → the daemon drains it (claim→write→ack) → the absolute counter lands in the Vault's `Counters/metrics.md` frontmatter; re-firing the same Wire message is a replay no-op (counter unchanged).
result: [pending]

### 5. Provision the atlas-blobs R2 bucket (SPINE-05 / 00-01 deviation)
expected: Enable R2 in the Cloudflare Dashboard (account `ed894b1ee21ec8e5960e959fe2d336ce`), then `wrangler r2 bucket create atlas-blobs` + `wrangler r2 bucket lifecycle add atlas-blobs --name expire-raw-audio --prefix "audio/raw/" --expire-days 7`. The `BLOBS` binding (already declared-and-ready in both wrangler configs) resolves against the live bucket. Non-blocking for Phase 0/1 — R2 is first needed by Echo/audio in Phase 3.
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps

(none — no code gaps; all items are deferred live owner-provisioning per the explicit "accept code-complete, defer activation" decision)
