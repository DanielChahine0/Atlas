---
status: issues_found
phase: 00-spine
depth: deep
method: fan-out subsystem review (5 reviewers) — independent agents, code-grounded
files_reviewed: 35
findings:
  critical: 7
  warning: 12
  info: 11
  total: 30
---

# Phase 00 (Spine) — Code Review

Deep review of the substantive Phase-0 source (logic/security/schema; config boilerplate
already validated by typecheck/build/the Pillar-1 guard). Five independent subsystem reviewers.
The OAuth **consent/session** surface was reviewed separately (two adversarial rounds, all
findings fixed) and is excluded here except where a new issue surfaced.

**Headline:** the spine is structurally sound — the Steward atomic batch ordering is correct
(replay ⇒ `meta.changes===0`), Pillar 1 holds, the Wire contract is single-source, OAuth
token-exchange helpers are security-faithful, the redaction egress is unconditionally wired.
But the **happy-path tests masked real gaps**: the redaction *patterns* are too narrow, several
Steward failure/edge paths lose data or corrupt the counter, and the heartbeat supervisor is inert.

## Triage

**MUST-FIX (spine correctness + security — fix before Phase 0 is "done"):** C1–C7, W8, W9, W10, W11, W14, W15, W17, W18, W19, I20, I28, I30
**DEFER (cosmetic / Phase-2 / accepted-tradeoff — tracked follow-ups):** W12, W13, I21, I22, I23, I24, I25, I26, I27, I29

---

## Critical (7)

### C1 — Post-batch run_log/outbox throw → retry sees replay → Vault projection silently never enqueued
`packages/steward-core/src/apply.ts:62-91` · silent-failure · high
The atomic `db.batch()` (counter-bump + ledger-insert) commits, then the **separate** `.run()`
for `run_log` (73) or `vault_outbox` (85) throws transiently → the consumer retries → the now-committed
ledger key reads as a replay → the Vault-projection enqueue is **permanently skipped** (no re-derive in Phase 0).
**Fix:** fold the `run_log` insert + `vault_outbox` enqueue INTO the same atomic `db.batch()` (all four statements) — first-apply is all-or-nothing.

### C2 — Unvalidated `delta` (unknown) bound raw to D1 — non-numeric delta corrupts the INTEGER counter to TEXT
`packages/steward-core/src/apply.ts:42,56` · bug · high
`payload.delta` is `unknown`, bound to `value = value + ?` with no coercion. A non-numeric delta corrupts the column affinity.
**Fix:** `const delta = Number(e.payload.delta ?? 1); if (!Number.isInteger(delta)) throw new NonRetryableError(...)` (ack+P3).

### C3 — Redactor misses 7/8-digit, spaced, dashed 2FA codes (6-digit-only `\b\d{6}\b`)
`packages/security/src/redact.ts:21` · security · high
Probed: `4829137` (7), `48291370` (8), `482 913` (spaced) all pass through. The redactor is the **sole** control (CLAUDE.md says a prompt is insufficient).
**Fix:** broaden to 6–8 digit runs + common groupings; normalize full-width digits; pair digit-only branch with a proximity cue (code/otp/verification) to limit over-redaction (folds I24).

### C4 — URL redaction misses login/signin/magic-link/SSO URLs (only `reset|verify|confirm` in path)
`packages/security/src/redact.ts:24` · security · high
The invariant explicitly forbids surfacing **login URLs**, yet `…/login?token=`, `…/auth/magic?token=`, SSO links pass through. Verified empirically.
**Fix:** add `login|signin|sign-in|auth|sso|magic` path + `[?&](token|otp|code)=` query patterns.

### C5 — Heartbeat self-monitor never armed/fed by any runtime path — D-10 supervision is inert
`apps/atlas/src/coordinator.ts:42-54` ↔ `apps/atlas/src/index.ts:147-162` · silent-failure · high
`beat()`/`startHeartbeat()` are called ONLY by tests. Neither `fetch`→OAuthProvider nor `scheduled`→dispatcher arms or feeds it, so the supervision pillar does nothing in production.
**Fix:** arm + feed from the `scheduled()` dispatcher (and/or first fetch): `startHeartbeat()` once, `beat()` each tick.

### C6 — Cold-start fresh DO false-fires a spurious P1 'heartbeat stale' on first alarm
`apps/atlas/src/coordinator.ts:62-63` · bug · high
`lastBeat ?? 0` → a fresh DO is "∞ stale" → spurious P1.
**Fix:** seed `lastBeat` when arming, or treat a missing `lastBeat` as not-stale.

### C7 — flag() throw inside alarm() skips the final setAlarm — heartbeat permanently stops
`apps/atlas/src/coordinator.ts:73-81` · silent-failure · high
The "alarm() ALWAYS reschedules so the heartbeat can never stop" promise breaks if `flag()` (→ `WIRE.send`) throws before `setAlarm`.
**Fix:** wrap the `flag()` emit in try/catch; move `setAlarm(...)` into a `finally`.

## Warning (12)

- **W8** `apps/steward/src/steward-consumer.ts:47` — malformed gate omits `payload` → a payload-less event poison-loops to the DLQ instead of an immediate ack+P3. **Fix:** add `|| !e?.payload || typeof e.payload!=='object'`. *(MUST-FIX)*
- **W9** `packages/steward-core/src/apply.ts:52-54` — counter `INSERT…VALUES` no-conflict path bypasses the `WHERE NOT EXISTS` replay guard → double-applies a replay after any counter-row reset. **Fix:** guard BOTH branches (`INSERT…SELECT…WHERE NOT EXISTS`). *(MUST-FIX)*
- **W10** `packages/security/src/redact.ts:22-23` — misses `one-time passcode`/`OTP`/`security code` and double-spaced `reset  password`. **Fix:** broaden phrase patterns. *(MUST-FIX)*
- **W11** `packages/wire/src/send.ts:18-19` — 128KB Wire cap never enforced. **Fix:** measure encoded bytes post-parse, throw typed error >128KB. *(MUST-FIX)*
- **W12** `packages/shared/src/flag.ts:85` — `flag()` id embeds `localDate` → same recurring incident across midnight creates two board rows. **Fix:** drop date from recurrence-stable id. *(DEFER — low impact until Flagger/Phase 2)*
- **W13** `apps/atlas/src/oauth/{google,github}.ts` — runtime-dead duplicates of `apps/mcp-github` code (drift risk). **Fix:** extract to a shared package. *(DEFER — refactor; both copies currently correct)*
- **W14** `apps/mcp-obsidian-bridge/src/bridge/poll.ts:41-47` + `migrations/0001_init_core.sql:71-79` + `op-mapping.ts:84-93` — `vault_outbox` has only pending/done (no claim/lease) → overlapping polls re-deliver the same rows, and `append→POST` is not idempotent at Obsidian → duplicate feed lines. **Fix:** add a `sent`/in-flight claim state + atomic claim in poll. *(MUST-FIX — concurrency/idempotency)*
- **W15** `apps/mcp-github/src/index.ts:68,82` — `mintToken()` throw crashes the MCP request instead of a clean `isError` tool result. **Fix:** try/catch → structured error. *(MUST-FIX — cheap)*
- **W16** *(duplicate of C3/C4 — the redaction gap as seen from mcp-google's egress; closed by C3/C4)*
- **W17** `packages/codex/src/codex.ts:198` — YAML parser drops list-item fields when continuation indent ≠ 2 spaces → silent owner-fact loss. **Fix:** track actual continuation indent. *(MUST-FIX — silent data loss)*
- **W18** `packages/model/src/claude.ts:61-70` — `modelFor` returns KV/[vars] ids verbatim, no allowlist validation (docstring's "always valid 4.x" is false for misconfig). **Fix:** validate against the dateless-4.x allowlist, fall back to default. *(MUST-FIX — cheap)*
- **W19** `packages/model/src/claude.ts:181-205` — gateway connection/timeout errors (`status===undefined`) never flagged → degraded model access is silent. **Fix:** flag `APIConnectionError`/timeout as P3 too. *(MUST-FIX — cheap)*

## Info (11)

- **I20** `apply.ts:41` vs `op-mapping.ts:58` — D1 counter PK (raw) vs Vault Target (`String()`-coerced) can diverge. **Fix:** normalize once with `String()`. *(MUST-FIX — cheap, related to C2)*
- **I28** `apps/mcp-google/src/index.ts:96-118` — `safeToolOutput` omits `isError` on a secret-leak block → the documented P1-block is invisible to the client. **Fix:** return `isError:true` on `leaked`. *(MUST-FIX — cheap, observability)*
- **I30** `packages/model/src/claude.ts:129-131` — empty `AIG_ACCOUNT_ID`/`GATEWAY_ID` → malformed gateway URL with no startup error. **Fix:** fail-fast/flag on empty at `claudeFor` time. *(MUST-FIX — cheap)*
- **I21** run_log superset cols (rows_read/written/duration_ms) unpopulated by Steward — *(DEFER: document Phase-0-by-design; Flagger reads them in Phase 2)*
- **I22** `redact.ts` recompiles RegExp per call (hot path on every egress) — **Fix:** pre-build frozen pattern arrays. *(DEFER-ish — fold into the C3/C4 redaction rewrite if touching the file)*
- **I23** `flag.ts:9` `localDate(_env)` unused param — *(DEFER: cosmetic)*
- **I24** over-redaction of benign 6-digit content — *(folded into C3 via proximity cue)*
- **I25** `coordinator.ts:50` startHeartbeat check-then-act non-atomic — *(DEFER: benign under DO single-threading)*
- **I26** GitHub JWT `iss=client id` — *(DEFER: spec-faithful for github.com; revisit for GHES)*
- **I27** bridge poll returns body without server-side validation — *(DEFER: partially covered by W14 claim work)*
- **I29** `codex.ts:241` flow-list scalar splits on commas inside quotes — *(MUST-FIX if cheap alongside W17; else DEFER)*

## Subsystem health (one-liners)

- **steward-crux** — atomic batch + ordering correct; gaps are all OUTSIDE the batch (post-batch durability, delta validation, malformed-payload gate, counter no-conflict guard).
- **wire-shared-security** — Wire/observability sound; the redaction *patterns* are the weak link (the sole security control, too narrow).
- **atlas-runtime-oauth** — OAuth token-exchange helpers excellent; the heartbeat supervisor is inert + has two correctness defects.
- **mcp-bridge-daemon** — invariants hold by construction; the `vault_outbox` claim/idempotency gap is the one material concurrency hole.
- **model-codex** — gateway routing + read-only Codex solid; gaps are id-validation, the hand-rolled YAML parser, and silent timeout handling.
