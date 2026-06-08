---
phase: 04-outward-gated
verified: 2026-06-08T14:15:00Z
status: human_needed
score: 12/12
overrides_applied: 0
human_verification:
  - test: "Live gate confirm page renders in the owner's browser"
    expected: "GET /confirm?t=<token> returns a styled HTML page with artifact in <pre>, Approve and Reject buttons at correct colors (#1D4ED8 / #B91C1C), security headers set (CSP default-src 'none', x-frame-options DENY, no-store)"
    why_human: "Visual/browser rendering cannot be verified by grep or tsc"
  - test: "Owner receives ntfy confirm push after openGate() fires on a live Workers deploy"
    expected: "A push arrives on the owner's ntfy topic with a 'Review & edit' action button whose URL matches /confirm?t=<token>"
    why_human: "Requires Secrets Store seed (NTFY_TOPIC + NTFY_TOKEN) and live Workers deployment — documented go-live gate"
  - test: "Full Usher end-to-end: Atlas → register → gate approval → browser daemon drains → Calendar add + events-registered counter"
    expected: "Event appears on Google Calendar; Steward events-registered counter increments; confirmation number stored"
    why_human: "Requires live Google OAuth, Playwright Chromium install + owner browser-profile login — documented go-live gates"
  - test: "Full Envoy end-to-end: publish → gate approval → GitHub README commit + LinkedIn/X prefill"
    expected: "GitHub README section committed via mcp-github App; browser opens LinkedIn/X composer pre-filled; owner clicks Post; no auto-submit fires"
    why_human: "Requires GitHub App pull_requests:write grant, live Playwright install, live Codex drive.readonly wiring — documented go-live gates"
  - test: "Sundial propose-removal gate: a removal candidate triggers a confirm push; owner approves; applyRemoval executes calendar delete"
    expected: "Gate opened with P3-expiry-safe lifecycle; owner sees confirm push; on approval applyRemoval calls calendar.events.delete exactly once; replay is a no-op"
    why_human: "Requires live calendar.events OAuth delete tool wiring (WR-01 deferred) — documented go-live gate"
---

# Phase 04: Outward-Gated Verification Report

**Phase Goal:** Ship the only outward, irreversible agents — gated event registration (Usher, OUTWARD-01) and personal-brand publishing (Envoy, OUTWARD-02) — strictly draft-and-confirm, with the confirmation-gate UX as the real work. Build last, gate hardest.
**Verified:** 2026-06-08T14:15:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | No outward/destructive action fires without an approved gate (Pillar 2 / OUTWARD-01 / OUTWARD-02) | VERIFIED | `decideGate` UPDATEs under `AND status='pending'` guard before any side effect; `getGate` only resolves `status='pending'`; Usher `runContinuation`, Envoy `runOnApproved`, and Sundial `applyRemoval` all assert `gate_pending.status='approved'` + target match before acting; decline/timeout/expiry → no action fires |
| 2 | Gate is fail-safe (deny on error), never fail-open | VERIFIED | `validateBearerToken` returns `false` (401) when binding unseeded; `decideGate` rethrows on D1 error → caller returns 500, no side effect; `/confirm` missing token → 410; `applyRemoval` missing `injectedTools` → P2 flag + throws, no calendar delete |
| 3 | Approve-vs-expire mutual exclusion — no double-terminal-state | VERIFIED | Both `decideGate` and `sweepExpired` UPDATE with `AND status='pending'`; terminal audit row + P3 flag emitted ONLY when `meta.changes===1`; `--grep race` tests prove: approved gate stays 'approved' after sweep (0 rows transitioned, no spurious P3); second sweep is no-op (0 rows, no second audit row); 71/71 gate tests green |
| 4 | sweepExpired is idempotent — second sweep over expired rows transitions 0 rows, writes 0 new audit rows | VERIFIED | Source guard: `WHERE id=? AND status='pending' AND expires_at<?`; `--grep race (ii)` test confirms |
| 5 | Pillar 1 — no second `atlas-wire` consumer in apps/gate, apps/usher, apps/envoy, apps/sundial | VERIFIED | `grep -rn "consumers"` in all four `wrangler.jsonc` files returns only comments/documentation; only `producers` blocks present; CI guard `guard-wire-consumer.js` referenced in `apps/gate/wrangler.jsonc` |
| 6 | Counters bumped only via the Wire (Steward sole writer) | VERIFIED | Usher `send()` `events-registered` increment in `runOutcome` (after Calendar add + D1 status update); Envoy `send()` `brand.project_published` in `runOnApproved` (after all targets attempted); neither writes D1 counters directly |
| 7 | Token gates on /confirm, /browser/poll, /browser/ack are constant-time + fail-closed | VERIFIED | `validateBearerToken` calls `timingSafeEqual` (HMAC-SHA-256, from `packages/gate/src/auth.ts`); `if (!token) return false` when binding unseeded; `/confirm` hashes the incoming token with `sha256` before `getGate` lookup |
| 8 | 2FA/reset/login URLs never reach a gate artifact, confirm page, browser work-item field, or log | VERIFIED | `renderConfirmPage` applies `redact()` from `@atlas/security` before interpolating artifact into HTML; `serializeFields` in `apps/usher/src/fill.ts` applies the 6–8-digit tripwire + strips matched values, sets `stripped=true` (P2 flag if fired); `redactSensitive` in `apps/envoy/src/browser.ts` redacts before enqueueing prefill fields; `--grep security` render test in `packages/gate` confirms no 2FA/reset/login leaks through the confirm page |
| 9 | CR-01 FIXED: gate re-invokes Envoy via `onApproved` (not the non-existent `publish` method) | VERIFIED | `apps/gate/src/index.ts:165` calls `env.ENVOY.onApproved(...)` with correct params; `Env.ENVOY` interface declares `onApproved`; `apps/envoy/src/index.ts` exports `onApproved` on `WorkerEntrypoint`; tsc clean |
| 10 | CR-02 FIXED: Sundial `applyRemoval` has gate-approval authorization check + single-shot replay lock | VERIFIED | `applyRemoval` queries `gate_pending WHERE id=?`, asserts `status==='approved'` AND `target===eventId` (line 229); P1 flag + abort if missing; `INSERT OR IGNORE INTO idempotency_keys` with key `sundial:remove:${eventId}:applied` (distinct from openGate key) guards replay; `meta.changes===0` → no-op |
| 11 | WR-02 FIXED: `/browser/ack` re-invokes `USHER.onOutcome` so Calendar add + Wire increment complete | VERIFIED | `apps/gate/src/index.ts:405-429`: after `ackResult.meta.changes===1`, looks up the acked row's `agent`/`action_type`/`gate_id`, resolves `gate_pending.target` as `eventId`, calls `env.USHER.onOutcome(...)` for `agent='Usher'` + `action_type='event_fill_submit'`; re-invoke failure is non-fatal (P2 flag, ack stays committed) |
| 12 | WR-03 FIXED: `decideGate` returns boolean; gate re-invokes agent only on real status transition | VERIFIED | `packages/gate/src/index.ts:323`: signature `Promise<boolean>`; returns `true` on `meta.changes===1`, `false` on 0; `apps/gate/src/index.ts:288`: `if (transitioned) { await reinvokeAgent(...) }` — concurrent double-POST safe; `--grep fail-closed` + `--grep race` tests cover |

**Score:** 12/12 truths verified

---

### Deferred Items

Items not yet met but explicitly deferred to owner go-live gates (not a code gap).

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | WR-01: Sundial `applyRemoval` live calendar.events delete tool not wired via OAuth | Owner go-live gate | Coupled to live Google OAuth round-trip (same gate as SPINE-04/CORE-01). CR-02 already closes the unauthorized-delete security hole; the feature is fail-safe (P2 flag + throw if tools absent). Tracked in `04-REVIEW.md` as deferred |
| 2 | WR-06: Envoy partial-failure lock rollback race | Owner go-live gate | Mitigated by WR-03's single re-invoke (concurrent double-POST now blocked at the gate layer). Tracked in `04-REVIEW.md` as deferred |
| 3 | IN-01..04: ULID dedup, token-name doc, backoff-0 case, PII-fallback hard-fail flag | Owner go-live gate | All four are informational improvements, not security or correctness blockers. Tracked in `04-REVIEW.md` as deferred |
| 4 | Playwright Chromium install + owner browser-profile login | Owner action | Documented in REVIEW.md and CLAUDE.md as expected go-live gate |
| 5 | Secrets Store `<atlas-store-id>` seed (NTFY_TOPIC, NTFY_TOKEN, GATE_CONFIRM_TOKEN) | Owner action | `<atlas-store-id>` placeholder in `apps/gate/wrangler.jsonc`; same pattern as SPINE-04 |
| 6 | Live Google OAuth round-trip + Codex drive.readonly wiring | Owner action | Pre-go-live PII stubs correctly TODO-marked in `apps/usher/src/index.ts:217` and `apps/envoy/src/index.ts:180` |
| 7 | GitHub App pull_requests:write grant | Owner action | Documented pattern from mcp-github |

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `migrations/0007_gate.sql` | gate_pending + browser_action_outbox tables, UNIQUE idx_gate_idem_key, token_hash column | VERIFIED | Both tables present; UNIQUE index on idempotency_key; token_hash column; no DELETE statement |
| `packages/gate/src/index.ts` | openGate/getGate/decideGate/sweepExpired exports; ntfy push send in openGate | VERIFIED | All four functions exported; ntfy `fetch("https://ntfy.sh/")` in openGate after D1 batch; best-effort/non-fatal; 71 tests green |
| `packages/gate/src/auth.ts` | timingSafeEqual + sha256 helpers | VERIFIED | HMAC-SHA-256 timingSafeEqual (no naive `===`); sha256 returns 64-char hex |
| `packages/gate/src/push.ts` | buildConfirmPush — builds NtfyPayload, no fetch() call | VERIFIED | `grep -n 'fetch(' packages/gate/src/push.ts` returns no match; returns payload only |
| `packages/gate/src/render.ts` | renderConfirmPage/renderOutcomePage/renderExpiredPage + auth helpers | VERIFIED | redact() applied before artifact interpolation; authHtmlResponse sets CSP/DENY/no-store |
| `apps/gate/src/index.ts` | Gate Worker: /confirm, /browser/poll, /browser/ack, scheduled sweepExpired | VERIFIED | All endpoints implemented; constant-time Bearer auth; decideGate→boolean→conditional reinvoke; ack→USHER.onOutcome wiring; ENVOY.onApproved binding |
| `apps/usher/src/index.ts` | Usher WorkerEntrypoint: register() + onOutcome() | VERIFIED | Both methods present; runContinuation asserts gate approval; runOutcome has authRow evidence chain + Calendar add + Wire emit |
| `apps/envoy/src/index.ts` | Envoy WorkerEntrypoint: publish() + onApproved() | VERIFIED | Both methods present; runOnApproved Guard 1 (status='approved'), Guard 2 (per-target INSERT OR IGNORE), Guard 3 (distinct keys) |
| `apps/sundial/src/index.ts` | Sundial applyRemoval + openGate for propose-removal decisions | VERIFIED | applyRemoval has authorization check + single-shot lock; runSync opens gate per propose-removal decision |
| `daemon/src/browser-drain.ts` | Browser outbox drainer: poll/ack/drainLoop | VERIFIED | Serial drain (for...of); ack after attempt; loadBrowserConfig fails loud on missing vars |
| `daemon/src/browser-runner.ts` | runBrowserAction: event_fill_submit (captcha/payment hard stops) + linkedin_prefill/x_prefill (NO submit) | VERIFIED | Hard-stop ordering verified in source; runEnvoyPrefill has no submitForm/click-Post call; WR-04 fix: ownedContext closed after each item |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `packages/gate openGate()` | ntfy.sh via fetch() | After D1 batch: `fetch("https://ntfy.sh/", {method:"POST", headers:{Authorization:"Bearer",...}, body:JSON.stringify({topic,...payload})})` | VERIFIED | `grep -n 'fetch("https://ntfy.sh' packages/gate/src/index.ts` returns match on line 230 |
| `packages/gate decideGate()` | D1 batch guarded `AND status='pending'` | `env.DB.prepare("UPDATE gate_pending ... WHERE id=? AND status='pending'").run()` | VERIFIED | Line 331; `meta.changes===0` returns `false` (no-op path); terminal audit row written only on `changes===1` |
| `packages/gate sweepExpired()` | flag(env,"P3") + guarded UPDATE | Per row: `AND status='pending' AND expires_at<?`; P3 flag emitted only when `meta.changes===1` | VERIFIED | Lines 404, 434; mutual exclusion + idempotency confirmed |
| `apps/gate /confirm POST` | `decideGate` → conditional `reinvokeAgent` | `transitioned = await decideGate(...); if (decision==='approve' && transitioned) await reinvokeAgent(...)` | VERIFIED | Lines 274, 288-289 |
| `apps/gate reinvokeAgent Envoy branch` | `env.ENVOY.onApproved(...)` | `await env.ENVOY.onApproved({gateId, projectSlug, approvedTargets, editedArtifact})` | VERIFIED | Line 165; CR-01 fix confirmed |
| `apps/gate /browser/ack` | `env.USHER.onOutcome(...)` | After `ackResult.meta.changes===1`, lookup gate → call `USHER.onOutcome({eventId, eventUrl, outcome})` | VERIFIED | Lines 405-429; WR-02 fix confirmed |
| `apps/sundial applyRemoval` | authorization guard | `SELECT status,target FROM gate_pending WHERE id=?`; assert `status==='approved' && target===eventId` | VERIFIED | Lines 224-229; CR-02 fix confirmed |
| `apps/sundial applyRemoval` | single-shot replay lock | `INSERT OR IGNORE INTO idempotency_keys key='sundial:remove:${eventId}:applied'` | VERIFIED | Lines 243-248 |
| `apps/usher runContinuation` | authorization guard | `SELECT status FROM gate_pending WHERE id=?`; assert `status==='approved'` → P1 flag if not | VERIFIED | Lines 276-297 |
| `apps/usher runContinuation` | single-shot enqueue lock | `INSERT OR IGNORE INTO idempotency_keys key='usher:${eventId}:enqueued'` | VERIFIED | Lines 309-317 |
| `apps/envoy runOnApproved` | Guard 1 authorization | `SELECT status FROM gate_pending WHERE id=?`; assert `status==='approved'` → P1 flag if not | VERIFIED | Lines 257-277 |
| `apps/envoy runOnApproved` | Guard 2 per-target lock | `INSERT OR IGNORE INTO idempotency_keys key='envoy:${slug}:${target}:published'` | VERIFIED | Lines 330-338 |
| `daemon browser-drain` | `ackOutcome` after action attempt | `for...of` serial; `outcome = await deps.runBrowserAction(...)` then `await ackOutcome(...)` | VERIFIED | `drainOnce` lines 133-148 |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `apps/usher runOutcome` | `confirmationNumber` | `outcome.confirmation_number` from daemon scrape → `browser_action_outbox.outcome` → re-invoked via `/browser/ack` → `USHER.onOutcome` | Yes — daemon scrapes real page; `hard_stop:'no_confirmation'` if empty | FLOWING (pending live Playwright install) |
| `apps/envoy runOnApproved` | `artifactTargets` | `gate_pending.edited_artifact` (owner-edited) or `gate_pending.artifact` (original drafts from Codex) | Yes — fetched from D1 gate row | FLOWING |
| `apps/gate /confirm GET` | `row` (GatePendingRow) | `getGate(env, tokenHash)` — D1 `WHERE token_hash=? AND status='pending'` | Yes — real D1 query | FLOWING |
| `apps/sundial runSync` | `summary.decisions` | `reconcile(env, tasks, tools)` — calendar tool list + D1 deadline tasks | Yes — injected tools from calendar API | FLOWING (pending live OAuth) |

---

### Behavioral Spot-Checks

Step 7b: SKIPPED — live Worker deploy and Playwright install are owner go-live gates. Automated tests (71 gate + 26 usher + 18 envoy + 35 sundial + 26 apps/gate + 39 daemon tests) serve as the behavioral evidence for the code-complete claim.

---

### Probe Execution

Step 7c: No `scripts/*/tests/probe-*.sh` files declared in any PLAN or SUMMARY for this phase.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| OUTWARD-01 | 04-01, 04-02, 04-03, 04-05, 04-06 | Usher gated event registration + Calendar add + events-registered counter; captcha/payment hard stops; gate adherence 100% | VERIFIED (code-complete) | `runRegister` gate-open path; `runContinuation` authorization + enqueue; `runOutcome` Calendar add + Wire; hard-stop table in `HARD_STOP_SEVERITY`; browser runner captcha/payment hard-stops before submit |
| OUTWARD-02 | 04-01, 04-02, 04-03, 04-04, 04-07 | Envoy gated brand publish; Codex-sourced drafts; GitHub README/portfolio via mcp-github; LinkedIn/X prefill (owner clicks Post); gate adherence 100% | VERIFIED (code-complete) | `runPublish` gate-open path; `runOnApproved` three guards + per-target publish; `runEnvoyPrefill` no-submit confirmed; `commitReadme`/`openPortfolioPR` via mcp-github |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/usher/src/index.ts` | 228, 231 | `"TBD"` string values for price and location in gate artifact | Info | These are data display strings in the gate confirm page artifact (e.g. "price: TBD"), not code stubs or debt markers. They are accurate pre-go-live placeholders that the owner sees in the confirm page before approving registration. Not a blocker. |
| `apps/usher/src/index.ts` | 217 | `// TODO: wire up real readCodex() at go-live` | Info | Documented expected go-live action (Codex drive.readonly wiring). PII fallback hardcoded as `"Daniel Chahine"` / `"chahinedaniel0@gmail.com"` — IN-04 tracked debt. Not a blocker; correctly flagged in REVIEW.md as deferred go-live wiring. |
| `apps/envoy/src/index.ts` | 180 | `// Pre-go-live: skip real Codex read and use draft placeholder` | Info | Same pattern as Usher — correctly marked pre-go-live stub. IN-04 tracked. Not a blocker. |

No `TBD`/`FIXME`/`XXX` markers that lack follow-up tracking. The two `TBD` strings in `apps/usher/src/index.ts:228,231` are artifact field values (`price: "TBD"`, `location: eventLocation ?? "TBD"`), not debt-marker comments — they are the correct display text for a pre-go-live form field (event price not yet in schema).

---

### Human Verification Required

The automated checks all pass. The following require live owner-action go-live gates and cannot be verified by grep or tsc:

#### 1. Gate Confirm Page Visual Rendering

**Test:** Deploy apps/gate to a Workers staging environment; navigate to `GET /confirm?t=<valid-token>` in a browser.
**Expected:** Styled HTML page renders with the gate artifact in a `<pre>` block (gray-100 background), "Approve" button in #1D4ED8 and "Reject" in #B91C1C border, both 44px full-width; security headers present (CSP default-src 'none', x-frame-options DENY, cache-control no-store); no 2FA codes or reset links visible.
**Why human:** Visual/browser rendering cannot be verified programmatically.

#### 2. ntfy Confirm Push Delivery (Live Workers Deploy)

**Test:** Seed `NTFY_TOPIC` and `NTFY_TOKEN` into the Secrets Store; trigger an `openGate()` call from Usher or Envoy on a live deployment.
**Expected:** A push notification arrives on the owner's ntfy topic within seconds, carrying a "Review & edit" action button whose URL is `https://gate.atlas.workers.dev/confirm?t=<token>`.
**Why human:** Requires Secrets Store seed (documented go-live gate); ntfy delivery is a network side-effect that cannot be unit-tested without a real deployment.

#### 3. Usher End-to-End: Event Registration Flow

**Test:** Call `Usher.register({ eventId, eventUrl })` via Atlas service binding; approve the gate via the confirm page; verify the daemon polls `/browser/poll`, drains the outbox item, fills the event registration form, acks success; verify Calendar event added and events-registered counter incremented.
**Expected:** Event on Google Calendar; Steward `events-registered` counter at +1; D1 `events.status='registered'`; `browser_action_outbox` row at `status='done'`.
**Why human:** Requires live Google OAuth (calendar.events write), Playwright Chromium install + owner browser-profile login, and a real test-event URL — documented go-live gates per SPINE-04.

#### 4. Envoy End-to-End: Brand Publish Flow

**Test:** Call `Envoy.publish({ projectName: "test-project" })` via Atlas service binding; approve the gate; verify GitHub README committed, LinkedIn/X composer pre-filled (not auto-submitted).
**Expected:** GitHub commit on profile repo; browser opens LinkedIn composer with draft text visible; owner must click Post manually; no auto-post fires.
**Why human:** Requires GitHub App pull_requests:write grant, live Playwright install, live Codex drive.readonly wiring — documented go-live gates.

#### 5. Sundial Calendar Removal Gate (WR-01 Live Resolution)

**Test:** Trigger a `propose-removal` decision from Sundial's reconcile step; verify gate is opened (confirm push received); approve via the confirm page; verify `applyRemoval` executes and the calendar block is deleted exactly once (replay is a no-op).
**Expected:** Gate opened → push delivered → approved → `applyRemoval` called → calendar block removed; second approval attempt on same gate is a no-op (single-shot lock).
**Why human:** Requires live calendar.events OAuth delete tool wiring (WR-01 deferred — coupled to live Google OAuth go-live gate per SPINE-04/CR-02 analysis).

---

### Gaps Summary

No code gaps found. All 12 observable truths are VERIFIED in the codebase. The two previously-found BLOCKERs (CR-01, CR-02) and all five integration-breaking warnings (WR-02 through WR-07) from the code review were fixed in this session. The remaining deferred items (WR-01, WR-06, IN-01..04) are tracked debt explicitly noted in `04-REVIEW.md` and consistent with the documented Phase 0/1 go-live pattern.

The `status: human_needed` reflects that five live owner-gated round-trips (ntfy push delivery, Playwright browser automation, live Google OAuth, GitHub App grant, Codex wiring) require manual testing — not that any code is missing. These are the same categories of owner gate that Phases 0, 1, and 3 carry.

**Test totals at verification:** workspace suite 54 test files / 657+ tests all green; daemon 3 test files / 39 tests green; `pnpm -r typecheck` clean (all packages including apps/gate, apps/usher, apps/envoy, apps/sundial, packages/gate); daemon `tsc --noEmit` clean.

---

_Verified: 2026-06-08T14:15:00Z_
_Verifier: Claude (gsd-verifier)_
