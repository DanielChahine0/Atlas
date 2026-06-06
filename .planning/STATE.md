---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: planning
stopped_at: Phase 3 context gathered
last_updated: "2026-06-06T13:38:46.824Z"
last_activity: "2026-06-06 - Completed quick task 260606-c24 (closed milestone v1.0 integration gaps: Forge.createTask + 5× database_id)"
progress:
  total_phases: 6
  completed_phases: 3
  total_plans: 23
  completed_plans: 23
  percent: 50
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-01)

**Core value:** Every morning the owner sees a trustworthy digest, deadline-safe tasks/calendar, and a day plan — automatically, with zero missed deadlines and zero 2FA codes/reset links ever surfaced.
**Current focus:** Phase 3 — capture (local)

## Current Position

Phase: 3
Plan: Not started
Status: Ready to plan
Last activity: 2026-06-06 - Completed quick task 260606-c24 (closed milestone v1.0 integration gaps: Forge.createTask + 5× database_id)
Next action: Phase 3 (capture/local) — `/gsd-discuss-phase 3`. Milestone v1.0 audited 2026-06-06 (`.planning/v1.0-MILESTONE-AUDIT.md`): 3/6 phases built; the two code-level integration gaps it found are now closed. Separately, clear the four Phase-1 go-live gates (see Blockers) before flipping the morning chain live + setting `filer.push_enabled=true`. Hand-edit Atlas's wrangler crons to the EST forms at the Nov 2026 DST boundary (the scheduled() switch already routes both forms).

Milestone progress (phases): [█████░░░░░] 50% — 3 of 6 phases complete (Phase 0 Spine ✅ · Phase 1 Morning Pipeline ✅ · Phase 2 Weekly Value ✅)

## Performance Metrics

**Velocity:**

- Total plans completed: 30 (Phase 0: 8 · Phase 1: 8 · Phase 2: 7)
- Average duration: not instrumented
- Total execution time: not instrumented

**By Phase:**

| Phase | Plans | Status |
|-------|-------|--------|
| 00 — Spine | 8/8 | Complete (2026-06-05) |
| 01 — Core Loop / Morning Pipeline | 8/8 | Complete (2026-06-05) |
| 02 — Weekly Value | 7/7 | Complete (2026-06-05) |

**Recent Trend:**

- Last 5 plans: 02-03 → 02-04 → 02-05 → 02-06 → 02-07 (all complete)
- Trend: Phase 2 (Weekly Value) closed out — Scout/Headhunter/Flagger + Herald-weekly + Atlas cadence integration all landed

*Per-plan detail — Tasks counted from each PLAN's `Task N` headings; Files = unique files touched across that plan's commits (git). The `Δ` column is the Phase-0 execution deviation log as originally recorded; Phase-1 plans were not separately deviation-instrumented (`-`).*

| Plan | Δ | Tasks | Files |
|------|---|-------|-------|
| Phase 00 P01 | 14 | 3 tasks | 21 files |
| Phase 00 P02 | 7 | 3 tasks | 21 files |
| Phase 00 P03 | 20 | 4 tasks | 6 files |
| Phase 00 P04 | 30 | 3 tasks | 13 files |
| Phase 00 P05 | 6 | 2 tasks | 8 files |
| Phase 00 P06 | - | 6 tasks | 17 files |
| Phase 00 P07 | 7 | 2 tasks | 12 files |
| Phase 00 P08 | 16 | 3 tasks | 25 files |
| Phase 01 P01 | - | 3 tasks | 4 files |
| Phase 01 P02 | - | 3 tasks | 14 files |
| Phase 01 P03 | - | 3 tasks | 15 files |
| Phase 01 P04 | - | 3 tasks | 15 files |
| Phase 01 P05 | - | 3 tasks | 15 files |
| Phase 01 P06 | - | 3 tasks | 14 files |
| Phase 01 P07 | - | 3 tasks | 15 files |
| Phase 01 P08 | - | 5 tasks | 10 files |
| Phase 02-weekly-value P02 | ~1 hour | 3 tasks | 14 files |
| Phase 02-weekly-value P03 | 45 minutes | 2 tasks | 15 files |
| Phase 02-weekly-value P04 | ~90 minutes | 2 tasks | 11 files |
| Phase 02 P05 | 10 minutes | 2 tasks | 14 files |
| Phase 02-weekly-value P06 | 10 minutes | 2 tasks | 4 files |
| Phase 02 P07 | ~12 minutes | 3 tasks | 8 files |

## Accumulated Context

### Decisions

Full log in PROJECT.md Key Decisions table. Recorded D1–D7 (status: decided, not locked) + the 5 SPEC-CANON §0 pillars (global constraints). Most relevant to Phase 0:

- D1: UTC crons + EST/EDT translation table (Cron Triggers are UTC-only, no DST).
- D2: D1 is system-of-record; the Vault is a rendered view (build Steward serialization + idempotency right NOW — retrofitting after counters exist means reconciling double-counts).
- D5: Claude via AI Gateway, per-codename KV model tiering, two cost-domain gateways.
- Pillar 1 (one writer) + Pillar 5 (idempotent + observable) are the whole point of Phase 0.
- [Phase 0]: 00-01: Spine resources provisioned on Free (D1 atlas-db migrated 5 tables, atlas-wire+DLQ, CONFIG+OAUTH_KV); R2 atlas-blobs deferred — account not R2-enabled (err 10042).
- [Phase 0]: 00-01: vitest-pool-workers v4 plugin API (cloudflareTest); defineWorkersConfig/isolatedStorage removed in pool 0.16.
- [Phase 0]: 00-02: Single §6.4 WireEvent zod schema lives in packages/wire (the only definition); every producer + Steward import it (build-plan acceptance #6 CI gate).
- [Phase 0]: 00-02: zod-4 record API — used z.record(z.string(), z.unknown()); the build-plan single-arg z.record(z.unknown()) is a strict-TS error under the resolved zod 4.4.3.
- [Phase 0]: 00-02: Canonical Flagger event is op:'upsert'/entity:'flag'/idempotencyKey===flag.id (a stable row); reconciled the build-plan entity:'flagger'/op:'increment' stub in docs/13-build-plan.md.
- [Phase 0]: 00-03: Confirmed agents@0.14.1 DurableObject<Env> + WorkerEntrypoint<Env> export from cloudflare:workers (protected field is ctx, not state) — Open Question 1 closed.
- [Phase 0]: 00-03: D-11 no-op invoke = a SELF service-binding RPC (NOOP -> service atlas, entrypoint NoopAgent); env.NOOP.tick() over private Worker-to-Worker RPC, no public HTTP.
- [Phase 0]: 00-03: SPINE-01 proven — scheduled() routes only the known cron, invokes the no-op agent, then sends a canonical §6.4 atlas:noop:<date> event; 8/8 workerd tests; Atlas producer-only.
- [Phase 0]: 00-04: THE CRUX live — StewardWriter DO runs atomic dedup+counter-bump+ledger-insert as ONE db.batch() inside blockConcurrencyWhile; the SINGLE atlas-wire consumer (getByName vault, serial for-of, malformed->ack+P3, transient->retry+P2->DLQ); apps/steward is the SOLE consumer (Pillar 1).
- [Phase 0]: 00-04: [Rule 1 bug] fixed a double-count in the build-plan T5 snippet — within one db.batch() the ledger-insert-then-counter-bump order self-defeats WHERE NOT EXISTS (the just-inserted key is visible); reordered to [counter-bump, ledger-insert]. serialize.test.ts proves 50 concurrent distinct applies sum to 50 (was 1).
- [Phase 0]: 00-04: vault_outbox intent enqueued INSIDE the lock; the slow Obsidian PATCH is deferred to the outbound daemon (00-08, which imports toOutboxIntent — the SINGLE op->Local-REST map, GLOBAL DECISION 5). consumer->atlas-wire-dlq wiring in place (SPINE-05); the DLQ sink itself is 00-05.
- [Phase 0]: 00-04: three SPINE-02 tests green in workerd — replay (meta.changes===0, counter 1 not 2), serialize (single DO + 50 concurrent exact sum), malformed (ack+P3, no write). vitest-pool-workers v4 cloudflareTest + per-test applyD1Migrations via provide/inject (pool does not auto-apply).
- [Phase 0]: 00-05: SPINE-05 back half live — apps/dlq-sink consumes atlas-wire-dlq (NOT atlas-wire; Pillar 1 holds, Steward stays sole bus reader) and turns every exhausted-retry dead message into a durable audit_log row (outcome='dlq', scope_used='' never a token) + a deterministic P2/P3 Flagger incident via shared flag(); always ack() (try/finally), never retry — no poison-loop, no silent loss.
- [Phase 0]: 00-05: reused @atlas/shared flag() as the single flag-id authority (flg:<date>:dlq-sink:<hash>) with title/detail as pure functions of (severity, original key) so a redelivered DLQ message dedupes to ONE upserted flag — no crypto.randomUUID; audit_log flag_id computed identically to tie the forensic row to the incident.
- [Phase 0]: 00-05: [Rule 3] tightened .claude/hooks/guard-wire-consumer.js — the Pillar-1 check now inspects the CONSUMER queue region only, so a legitimate atlas-wire PRODUCER reference no longer false-positive-denies; still denies a real second atlas-wire consumer.
- [Phase 0]: 00-07: @atlas/codex read-only by ABSENCE (exports only read/codexSystemBlock/parseCodex + types; no write/update/patch/put/post/delete/mutate export — T-00-71); read() takes an injected drive.readonly token + fetch, CONFIG KV holds only the Drive file id.
- [Phase 0]: 00-07: @atlas/model claudeFor/modelFor route every Claude call through the AI Gateway Anthropic endpoint (gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic) — the direct host never appears in src; tiering reads KV model:<codename> -> [vars] MODEL_<CODENAME> -> CLAUDE.md map (re-tunable without redeploy, only dateless 4.x ids); a non-2xx APIError calls flag(env,P3,...) emitting the canonical op:upsert/entity:flag event with a structured idempotencyKey (the flag id, no crypto.randomUUID).
- [Phase 0]: 00-07: codexSystemBlock() returns the SDK TextBlockParam with cache_control {type:ephemeral, ttl:1h} (Anthropic prompt caching at 0.1x read); SPINE-03 complete (the Codex exists, read-only, with the seven §11 sections).
- [Phase 0]: 00-08: confirmed agents@0.14.1 MCP surface by reading the installed .d.ts (createMcpHandler stateless; McpAgent<Env,State,Props> abstract server+init+static serve({binding}); getMcpAuthContext().props.scopes; MCP SDK 1.29.0 registerTool) BEFORE writing the classes — reading resolved declarations is the equivalent when Context7/cf-docs MCP is unreachable (00-03/04/06 method).
- [Phase 0]: 00-08: mcp-google safeToolOutput() runs @atlas/security redact() on EVERY tool-output egress with NO scope parameter — a 2FA code/reset link/login URL is stripped server-side regardless of scope; gmail.modify floor via getMcpAuthContext().props.scopes (403, fail-closed); NO message/thread removal tool registered (unreachable by construction, Pillar 2). redact+scope tests green (SPINE-04 backstop).
- [Phase 0]: 00-08: mcp-obsidian-bridge exposes ONLY /bridge/poll+/bridge/ack (else 404), both ATLAS_BRIDGE_TOKEN-gated (constant-time, fail-closed), draining vault_outbox; idempotent ack via UPDATE ... AND state!='done' (so meta.changes is the true no-op signal); op->REST is the single steward-core SAFE_METHODS (PATCH/POST, NO DELETE; now exported). daemon outbound-only: poll->PATCH 127.0.0.1:27124->ack, ack only after write (pending never lost), self-signed cert trusted for the localhost agent only, no inbound socket, plist no listener key. SPINE-05 transport built.
- [Phase 1]: 01-01: mcp-google expanded with per-agent least-privilege scope floors — Herald gmail.readonly+gmail.compose (draft-only, NO send method registered), Forge gmail.readonly, Sundial calendar.events (NO delete), Compass calendar.readonly; outward/destructive paths absent by construction (Pillar 2); redaction egress on every tool output.
- [Phase 1]: 01-02: D1 tasks/subtasks store (migration 0003) with structural dedupe via UNIQUE idx_tasks_dedupe on sha256(thread+normalizedTitle+dueDate); merge-on-collision (union subtasks / earliest due / strongest priority) is replay-safe; locked_by_owner short-circuit so an owner edit is never clobbered.
- [Phase 1]: 01-03: Filer sweep idempotent via newer_than:2d -label:AI/Reviewed (AI/Reviewed appended LAST); FilerCursor SQLite DO holds historyId+watchExpiration; GmailTools interface has NO delete/trash/archive (Pillar-2 by construction); continuous-push flag-gated off (CONFIG filer.push_enabled, D1-06) until gateway ceilings set.
- [Phase 1]: 01-04: Herald daily digest is draft-only (HeraldGmailTools has createDraft but NO send); defense-in-depth redaction (pre-synthesis strip + output containsSecret guardrail that BLOCKS the draft + P2 + CI test); deterministic label→section bucketing (model writes prose, never decides the bucket).
- [Phase 1]: 01-05: Forge extraction writes D1 tasks inside the ForgeLock DO (blockConcurrencyWhile) serializing overlapping runs; per-task Wire event keyed on task id (insert→increment / merge→upsert / noop→nothing); security-skip + sanitizeExtracted so no 2FA code / reset URL reaches a task field; deadline inference (explicit / Due / ThisWeek→Fri17:00 / Job-OA→+5d / EOD→23:59 owner-local).
- [Phase 1]: 01-06: Sundial reconcile keyed on atlasTaskId with contentHash drift detection (create/patch/skip, NO delete; dup→gated removal proposal + P2); CalendarTools interface has NO delete method (autonomous-delete unreachable, Pillar 2); deterministic task→block mapping, own-events-only via privateExtendedProperty agent=sundial.
- [Phase 1]: 01-07: Compass overcommitment surfaces a visible Couldn't-fit list (never silently drops) + at-risk + P3; Opus effort resolved from CONFIG compass.effort, default medium, NEVER high hardcoded (D1-05 cost discipline); day_plan op:upsert REPLACES the Today note (compass:plan:<date>), never appends.
- [Phase 1]: 01-08: ONE 07:45 cron → ONE MorningChain Workflow (atlas-morning-chain) with five await-ed start-after-success steps + step.sleepUntil DST-safe budget gates (NOT five racing crons); instance id morning-<date> is the idempotency handle (re-fire = no-op); a step's terminal failure rethrows → halt-downstream (Sundial/Compass never run on stale data) + ONE chain.halted P2; invokeAgent service-binding RPC transport (D-11).
- [Phase 1]: 01-REVIEW: two-pass adversarial code review across forge/tasks, compass, sundial, mcp-google+security, atlas — 20 fixes applied (verified), 3 deferred; 315 tests green at HEAD 09518da.
- [Phase 2]: 02-04: Scout Worker (apps/scout) built — injectable ScoutSources (RSS/HTML/Gmail), buildGmailQueries() structurally excludes Type/Security/Phishing-Suspect (D2-09), pure relevance() scorer (0-100), INSERT OR REPLACE into D1 events with scout:evt_<date>_<hash> keys, digest summary scout:digest:<date> Wire event. WorkerEntrypoint invoked by Atlas via service binding (no own cron). Codex skills/projects integration deferred to 02-07. 17 tests green; 373 total suite tests pass.
- [Phase 2]: 02-05: Headhunter Worker built — HeadhunterState DO (blockConcurrencyWhile capture-inside/re-throw-after), upsertWindow/upsertJob (D1 positional ?), decideWindow (low-confidence historical → P3 flag; urgency bypasses fit_floor), classifyFunnelStages (D2-13 single-emitter), full()/deadlines() WorkerEntrypoint, FORGE.createTask service binding path (never writes tasks table directly — T-02-hh3). 24 tests green; 397 total suite tests pass.
- [Phase ?]: Herald.weekly() entrypoint + heartbeat on daily+weekly success + herald:weekly digest event for 16:30 Vault build
- [Phase ?]: 02-07: triggers.crons lists only the active EDT form per ET slot; the scheduled() switch carries dual EDT/EST cases so the Nov DST hand-edit only touches wrangler crons (listing both forms would double-fire)
- [Phase ?]: 02-07: Steward default export is now a WorkerEntrypoint hosting the queue() consumer (delegated verbatim) + weeklyReviewBuild() RPC — Steward remains the sole atlas-wire consumer (Pillar 1)

### Pending Todos

- Plan Phase 2 (Weekly Value: Scout, Headhunter, Flagger) — `/gsd-plan-phase 2`.
- Clear the four Phase-1 go-live gates (Blockers) to flip the morning chain live + set `filer.push_enabled=true`.
- Close the Phase-0 owner gates (Google OAuth live round-trip, GitHub App, seed 6 secrets into Secrets Store, Obsidian bridge end-to-end + no-inbound-port proof, R2 enablement) — these keep SPINE-04 Pending.

### Blockers/Concerns

**Phase-0 owner gates (keep SPINE-04 Pending; code + mocked contracts proven):**

- **00-06 Google OAuth live round-trip:** owner creates a real GCP OAuth client + completes browser consent; the 2 `describe.skip` LIVE tests pass only once real credentials exist (37 OAuth/consent tests pass against mocks).
- **00-06 GitHub App live round-trip:** register + install a real GitHub App (not a PAT), generate the PKCS8 RS256 key, verify a per-run opaque `ghs_` installation token mints.
- **00-06 Seed 6 secrets into Cloudflare Secrets Store:** `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GH_APP_PRIVATE_KEY`, `OWNER_AUTH_TOKEN`, `SESSION_SIGNING_KEY`, `ATLAS_BRIDGE_TOKEN`; then replace the `<atlas-store-id>` placeholder in atlas / mcp-google / mcp-github / mcp-obsidian-bridge wrangler.jsonc.
- **00-08 Obsidian bridge end-to-end:** install Obsidian Local REST API v3 (127.0.0.1:27124), seed `ATLAS_BRIDGE_TOKEN`, register `daemon/com.atlas.bridge.plist` via launchd, prove a vault_outbox intent drains into the Vault AND `lsof` shows no inbound Atlas port. Cloud bridge + outbound-only daemon are code-complete (17 tests pass). Resume: 'approved'.
- **R2 not enabled on the account:** `wrangler r2 bucket create atlas-blobs` fails with CF API err 10042. Owner enables R2 in the Dashboard, then creates the bucket + the `audio/raw/` 7-day lifecycle rule (mandatory per D-03). BLOBS binding is declared-and-ready; non-blocking for Phases 0–1 (first needed by Echo in Phase 3).

**Phase-1 go-live gates (CORE-01; OWNER actions — cannot be set from code; see `01/GO-LIVE-CHECKLIST.md` + `01-HUMAN-UAT.md`). `filer.push_enabled` MUST stay `false` and the chain stays in suggest-mode until all are satisfied:**

- **Gate 1 / D1-03 — one-week pre-launch baseline:** log inbox-triage + day-planning minutes for ≥5 working days BEFORE flipping live (the "time saved" ground truth). Capture table empty; both checkboxes unchecked.
- **Gate 2 / D1-04 — daily ~1-min miss-review:** add the `## Misses (owner log)` affordance in `Dashboard/Home.md` + establish the habit (the ≥95% action-required-caught ground truth). Both checkboxes unchecked.
- **Gate 3 / D1-06 — AI-Gateway monthly spend ceilings:** set `atlas-reasoning` ≈ $20/mo and `atlas-highvolume` ≈ $10/mo in the Cloudflare dashboard (no API primitive). Required before Filer's push goes live.
- **HV-01-01 — live end-to-end morning-chain smoke:** run the six Workers in dev + live Google OAuth + bridge creds, fire `__scheduled`, confirm `wrangler workflows instances describe atlas-morning-chain latest` shows five ordered steps terminating complete. Cannot run in CI. (0/4 UAT passed.)

**Owner-judgment calls** deliberately left open (not conflicts) — surface at the relevant phase: heartbeat staleness threshold (5 min), DST operational burden, morning-chain success-rate window (D1-07: rolling 30 days), the two manual measurement commitments (pre-launch baseline + ~1-min daily review).

**Infra note:** no GitHub-Actions CI yet — the single-`atlas-wire`-consumer Pillar-1 guard is currently only a Claude Code PreToolUse hook (`.claude/hooks/guard-wire-consumer.js`), not a CI gate. Consider wiring it into CI before the fleet grows.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260606-c24 | Close milestone v1.0 integration gaps: `Forge.createTask` (fix WEEKLY-01 Headhunter→Forge runtime break) + shared `database_id` on 5 Phase-1 wranglers | 2026-06-06 | b9883dd | [260606-c24-close-milestone-v1-0-integration-gaps-im](./quick/260606-c24-close-milestone-v1-0-integration-gaps-im/) |

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Code review | 3 low-priority findings deferred (see `01-REVIEW.md`) | Deferred | Phase 1 |

## Session Continuity

Last session: 2026-06-06T13:38:46.811Z
Stopped at: Phase 3 context gathered
Resume file: .planning/phases/03-capture-local/03-CONTEXT.md
