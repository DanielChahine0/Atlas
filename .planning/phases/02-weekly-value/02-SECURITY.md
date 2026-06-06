---
phase: 02-weekly-value
slug: weekly-value
status: verified
threats_open: 0
asvs_level: 2
created: 2026-06-05
---

# Phase 02 — Weekly Value Security Audit

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Auditor stance: every mitigation assumed ABSENT until a grep/read match proves it exists in
> the cited file at the right location covering all entry points.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| ntfy action button → Flagger /ack (inbound HTTP) | Only inbound surface in Phase 2; untrusted internet can POST | ACK token (secret), flag id (low sensitivity) |
| Flagger → ntfy.sh (outbound HTTP) | Carries flag titles to a third-party push service | Flag title (redacted via `redact()` in push.ts:44), severity, agent name |
| atlas-incidents queue → Flagger queue() | Internal fleet incidents; can be malformed | RawIncident shape (validated at runtime by zod) |
| RSS/HTML source → Scout | Untrusted third-party content | Feed titles, dates, URLs — parsed statically, never executed |
| Gmail email bodies → Scout | Email content untrusted | Subject/date metadata ONLY — links never followed (D2-09) |
| watchdog → atlas-wire (direct) | Watchdog bypasses atlas-incidents because Flagger may be dead | P1 self-flag WireEvent — no secrets |
| Headhunter → Forge (service RPC) | Internal Worker-to-Worker RPC | Task descriptor — no credentials |
| cron trigger → Atlas scheduled() | Cloudflare-internal trigger | No external input |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-02-01 | Tampering | RawIncident (malformed caller) | mitigate | `RawIncidentSchema` (zod) in `packages/shared/src/incident.ts:20-27` | closed |
| T-02-02 | Repudiation | flag() silent loss | accept | Accepted: `flag()` awaits `env.INCIDENTS.send` (flag.ts:111); queue durability + `atlas-incidents-dlq` backstop; low spoofing value | closed |
| T-02-03 | DoS | 2nd atlas-wire consumer via flag() rework | mitigate | PRODUCERS only in 02-01; no atlas-incidents consumer added; guard-wire-consumer.js backstops at write time | closed |
| T-02-SC(01) | Tampering | npm installs (02-01) | mitigate | No new package installs in plan 02-01 (rss-parser/cheerio land in 02-04) | closed |
| T-02-ack | Spoofing | /ack endpoint flips flag status | mitigate | HMAC-SHA-256 constant-time compare `auth.ts:18-33`; `ACK_TOKEN` via Secrets Store `async get()` `index.ts:184`; fail-closed 401 on missing token `index.ts:185` | closed |
| T-02-storm | DoS | push storm (many agents, same root cause) | mitigate | Signature dedupe in `FlaggerState.upsertFlag()` `state.ts:57-148` — ONE flag row; recurrence bump, not re-push | closed |
| T-02-poison | Tampering | malformed incident blocks consumer | mitigate | `RawIncidentSchema.safeParse` at `index.ts:107`; malformed → `msg.ack()` at `index.ts:112`; P3 direct to atlas-wire; own `atlas-incidents-dlq` in `wrangler.jsonc:37` | closed |
| T-02-topic | Information Disclosure | ntfy topic/token disclosure | mitigate | `NTFY_TOPIC`/`NTFY_TOKEN`/`ACK_TOKEN` read via `async env.X?.get()` at `push.ts:24-25`, `index.ts:184`; Secrets Store bindings in `wrangler.jsonc:63-67`; no `[vars]` block in either wrangler file | closed |
| T-02-wire | Spoofing/Tampering | 2nd atlas-wire consumer (Flagger) | mitigate | `flagger/wrangler.jsonc` consumers block targets `atlas-incidents` only (line 32); `atlas-wire` absent from consumers; guard-wire-consumer.js enforces at write time | closed |
| T-02-SC(02) | Tampering | npm installs (02-02) | accept | Accepted: no new package installs — workspace deps only | closed |
| T-02-wd1 | Spoofing | watchdog as atlas-wire CONSUMER | mitigate | `flagger-watchdog/wrangler.jsonc` has NO `"consumers"` key (grep count = 0); producers block only (line 18-21); guard hook backstops | closed |
| T-02-wd2 | Repudiation | Flagger dies silently | mitigate | Externalized watchdog (`apps/flagger-watchdog`) — separate Worker, own `*/5 * * * *` cron, reads `flagger:last_seen` from KV; absent `last_seen` → `lastSeen=0` → always stale → P1 emitted (`index.ts:114-115`) | closed |
| T-02-hb | DoS | heartbeat storm floods atlas-incidents | accept | Accepted: one heartbeat per scheduled run (low cardinality); P4 severity_hint; dedupe by signature in FlaggerState | closed |
| T-02-topic(03) | Information Disclosure | ntfy creds in watchdog | mitigate | `NTFY_TOPIC`/`NTFY_TOKEN` via Secrets Store async `get()` at `watchdog/index.ts:67-69`; Secrets Store bindings in `watchdog/wrangler.jsonc:33-36`; no `[vars]` key in watchdog wrangler | closed |
| T-02-SC(03) | Tampering | npm installs (02-03) | accept | Accepted: no new package installs — workspace deps only | closed |
| T-02-link | Elevation of Privilege | Scout follows email body links | mitigate | `buildGmailQueries()` (sources.ts:76-81) returns only `Type/Newsletter`/`Type/Events` queries structurally; `fetchGmailEventsLive` uses subject/date ONLY — url intentionally not set `sources.ts:175-183`; safety test asserts at runtime | closed |
| T-02-html | Tampering | malicious RSS/HTML payload | mitigate | cheerio static parse (no JS execution) `sources.ts:121-153`; rss-parser XML parse `sources.ts:103-114`; `relevance()` pure text match, no eval | closed |
| T-02-pii | Information Disclosure | Codex read leaks profile facts | accept | Accepted: Codex read-only; Scout reads skills/projects/addresses only (v1 defers Codex integration — empty arrays used); no Codex write; no schema change | closed |
| T-02-SC(04) | Tampering | rss-parser + cheerio installs | mitigate | `apps/scout/package.json` pins `rss-parser@3.13.0` and `cheerio@1.2.0`; RESEARCH Package Legitimacy Audit (both Approved/[OK]); `apps/headhunter/package.json` includes `rss-parser@3.13.0` (1 occurrence confirmed) | closed |
| T-02-hh1 | Tampering | double-counted funnel | mitigate | Single emitter: Headhunter only; `buildFunnelEvent()` uses `idempotencyKey: headhunter:funnel:<thread>:<stage>`; Steward replay no-op (meta.changes===0) | closed |
| T-02-hh2 | Repudiation | shaky window date silently becomes a task | mitigate | `shouldFlagLowConfidence()` at `windows.ts:199-203` (`confidence < 0.4 AND source === "historical"`); `decideWindow()` returns null at `windows.ts:228` → caller flags P3, no task created | closed |
| T-02-cred | Information Disclosure | scraping credentials leak | mitigate | Read-only OAuth scopes; no board credentials in KV/Vault/`[vars]`; `headhunter/wrangler.jsonc` has no plaintext secret keys in vars | closed |
| T-02-hh3 | Spoofing/Tampering | Headhunter writes tasks table directly | mitigate | `env.FORGE.createTask` at `headhunter/index.ts:204,306` (grep returns 3 occurrences ≥ 1); `grep "INTO tasks" apps/headhunter/src/` returns 0 | closed |
| T-02-SC(05) | Tampering | npm installs (02-05) | mitigate | Only `rss-parser@3.13.0` (Approved); no `[SUS]` deps; verified in `headhunter/package.json` | closed |
| T-02-leak | Information Disclosure | 2FA code/reset link in weekly draft | mitigate | `guardDigestOutput(env, body)` called at `weekly.ts:163` BEFORE `createDraft` at `weekly.ts:168`; leak BLOCKS draft + raises P2; weekly is NOT exempt | closed |
| T-02-send | Elevation of Privilege | weekly mode gains send capability | mitigate | `grep "sendEmail\|sendDraft\|messages.send" apps/herald/src/` returns empty; `HeraldGmailTools.createDraft` only | closed |
| T-02-SC(06) | Tampering | npm installs (02-06) | accept | Accepted: no new package installs — weekly reuses existing Herald deps | closed |
| T-02-cron1 | DoS | wrong DST cron form | mitigate | EDT forms active in `atlas/wrangler.jsonc:120-127`; dual EDT/EST cases in `atlas/src/index.ts` switch (lines 190-262 confirm `"0 14 * * *"`, `"0 21 * * 5"`, `"30 21 * * 5"` dual cases); EST annotated for Nov hand-edit | closed |
| T-02-cron2 | DoS | Friday Scout failure discards Herald's work | mitigate | `Promise.allSettled` used at `atlas/src/index.ts` (grep count = 2 ≥ 1); each leg wrapped in `catch→flag(P2)→return null`; 16:30 build runs on partial summary | closed |
| T-02-cron3 | DoS | Free per-Worker cron cap silently fails deploy | accept | Accepted (process gate): blocking human-verify checkpoint owner-approved before cron expansion; per-Worker 3-cron cap confirmed removed Oct 2023; `wrangler deploy --dry-run` exit 0 with 5-cron list (documented in 02-07-SUMMARY.md) | closed |
| T-02-wr | Spoofing/Tampering | weekly-review build 2nd Vault writer/atlas-wire consumer | mitigate | Build writes via ONE `op:upsert` Wire event (`weekly-review.ts:174`); `send(env, ...)` producer path; Steward's own consumer applies it; `grep "queues.consumers" apps/steward/wrangler.jsonc` → only atlas-wire at Steward; guard hook exit 0 | closed |
| T-02-SC(07) | Tampering | npm installs (02-07) | accept | Accepted: no new package installs in this plan | closed |

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-02-01 | T-02-02 | `flag()` awaits `env.INCIDENTS.send` before returning; queue durability provides the backstop; atlas-incidents-dlq captures exhausted messages; spoofing a lost flag has low value (observability only, no auth/data exposure) | owner | 2026-06-05 |
| AR-02-02 | T-02-SC(02) | No new npm packages in plan 02-02; all deps are existing workspace packages | owner | 2026-06-05 |
| AR-02-03 | T-02-hb | One heartbeat per scheduled run (5 agents × ~1/day); P4 severity_hint; FlaggerState DO dedupes by signature; no capacity risk under current volume | owner | 2026-06-05 |
| AR-02-04 | T-02-SC(03) | No new npm packages in plan 02-03; all deps are existing workspace packages | owner | 2026-06-05 |
| AR-02-05 | T-02-pii | Codex reader is read-only; Scout v1 defers Codex integration (empty skills/projects arrays); no Codex write path; no schema change; personal facts do not leave the Codex reader boundary | owner | 2026-06-05 |
| AR-02-06 | T-02-SC(06) | No new npm packages in plan 02-06; weekly mode reuses existing Herald deps | owner | 2026-06-05 |
| AR-02-07 | T-02-cron3 | Cron-cap process gate: blocking human-verify checkpoint owner-approved before cron expansion; per-Worker 3-cron cap confirmed removed (Cloudflare changelog Oct 2023); dry-run exit 0 evidenced in 02-07-SUMMARY.md Task 1. Deploy-time operator risk transferred to owner. | owner | 2026-06-05 |
| AR-02-08 | T-02-SC(07) | No new npm packages in plan 02-07 | owner | 2026-06-05 |

---

## Unregistered Flags

The following threat surfaces appeared in SUMMARY.md files with no corresponding registered threat ID. These are informational warnings, not blockers.

| Flag | Source | Description | Assessment |
|------|--------|-------------|------------|
| UF-01 | 02-02-SUMMARY `Known Stubs` | `store_id` placeholder `<atlas-store-id>` in `wrangler.jsonc` `secrets_store_secrets` for Flagger, watchdog, and other workers | Deploy-time configuration gap, not a code vulnerability. The same pattern used across all Phase-0/1 workers. Real store ID must be substituted before production deployment. Owner-operator risk; consistent with project go-live gate posture. |
| UF-02 | 02-02-SUMMARY `Deviations` | `payload` cast as `flag as unknown as Record<string, unknown>` at the Wire emit boundary in Flagger `index.ts:65` | Deliberate type boundary cast at §6.4 WireEvent contract; FlagRecord type is unchanged; Steward consumer validates shape. No security impact. |
| UF-03 | 02-07-SUMMARY `Known Stubs` | `weeklyReviewBuild` v1 reads an empty week (live D1/digest/funnel/flags reads deferred) | Not a security gap. The op:upsert Wire event path, idempotency key, and Steward RPC wiring are complete and tested. Live reads deferred to OAuth go-live gate. |
| UF-04 | 02-04-SUMMARY `Known Stubs` | Codex skills/projects integration deferred in Scout v1 (uses empty arrays) | Not a security gap. Noted as AR-02-05. KV keywords still scored. |

---

## CI Invariants (CLAUDE.md DoD)

| Invariant | Evidence |
|-----------|----------|
| Exactly ONE `atlas-wire` consumer (Steward) | `grep -rn '"consumers"' apps/*/wrangler.jsonc` → only `apps/steward` and `apps/flagger` (flagger consumes `atlas-incidents`, not atlas-wire); `apps/dlq-sink` consumes `atlas-wire-dlq` (a different queue). Confirmed. |
| Exactly ONE `atlas-incidents` consumer (Flagger) | `apps/flagger/wrangler.jsonc` consumers block: `"queue": "atlas-incidents"` (line 32). No other worker has a consumers block on atlas-incidents. |
| guard-wire-consumer.js hook backstops both constraints | Hook verified present at `.claude/hooks/guard-wire-consumer.js`; denies writes that add atlas-wire consumer to non-Steward workers, and atlas-incidents consumer to non-Flagger workers. |
| digest-builder guardrail (2FA/reset-link/login-URL never reach output) | `guardDigestOutput()` called in `weekly.ts:163` BEFORE `createDraft`; also called in daily path. Weekly is NOT exempt. P2 raised on leak. |
| Replay test (op:upsert/entity:flag) | `apps/steward/test/replay.test.ts` extended with `op:"upsert"`/`entity:"flag"` case: second apply returns `{applied:false}`, `meta.changes===0` (per 02-07-SUMMARY Task 3). |

---

## Security Audit Trail

| Audit Date | Phase | Threats Total | Closed | Open | Run By |
|------------|-------|---------------|--------|------|--------|
| 2026-06-05 | 02-weekly-value | 32 | 32 | 0 | gsd-security-auditor (claude-sonnet-4-6) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-06-05
