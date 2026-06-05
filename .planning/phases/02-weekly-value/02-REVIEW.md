---
status: issues
phase: 02-weekly-value
review_type: adversarial-multi-agent
reviewed: 2026-06-05
baseline_commit: 6f54ff3
dimensions: 8
confirmed: 28
dismissed: 1
severity_counts:
  high: 5
  medium: 13
  low: 7
  info: 3
---

# Phase 02 — Weekly Value · Code Review

Adversarial multi-agent review of the Phase-2 diff (`6f54ff3..HEAD`, ~7k LOC across 80 files)
against Atlas's 7 non-negotiables (5 pillars + security + Definition-of-Done). Each finding was
produced by a dimension reviewer and then **independently refuted by a skeptical verifier** before
being confirmed; the verifier cites the exact code that confirms or refutes each one and adjusted
several severities. Full machine output: workflow `wf_6d02ea04-022`.

**All 427 unit tests pass.** Every defect below survives the green suite because the tests exercise
each component in isolation — nothing tests the seams between plans (e.g. heartbeat producers vs the
Flagger consumer). This is the canonical "Generator self-evaluation blind spot."

## Verdict

**Gaps found — phase NOT complete.** Pillar 1 (single-writer) and Pillar 2 (suggest-don't-destroy)
are fully upheld; secrets are correctly bound; idempotency keys are structured. But the **heartbeat→
watchdog self-monitoring subsystem is non-functional**, Headhunter has a silent data-loss bug and a
dead fit-floor, and several security defense-in-depth backstops are missing. None has *live* impact
yet (Phase-2 agents aren't deployed), but all must be fixed before go-live — the project's D2
principle is "build it right now, don't retrofit after counters/state exist."

---

## HIGH (5)

### H1 — Heartbeat incidents never seed the watchdog; stale-detection dead + board polluted
`apps/flagger/src/index.ts` (queue handler) · dimension: pillar5 / atlas-watchdog
Scout/Headhunter/Herald/Filer/Forge/Sundial/Compass all enqueue `{kind:"heartbeat", severity_hint:"P4"}`
incidents to `atlas-incidents`, but Flagger's `queue()` has **no `kind==="heartbeat"` branch** — every
incident runs `score()` + `upsertFlag()`. Two consequences: (1) `FlaggerState.recordHeartbeat()` (the
only writer of the `hb:<agent>` slots the alarm reads) is never called → `refreshAlarm()` finds nothing
→ the P1 heartbeat-stale alarm can **never fire** (an agent can silently die and Flagger stays quiet);
(2) each heartbeat becomes an open P4 flag whose signature embeds the date → a **new never-resolving
flag every run/day** (unbounded board pollution). `alarm.test.ts` seeds slots directly so the seam is untested.
**Fix:** branch on `kind==="heartbeat"` → `recordHeartbeat(source_agent, …)` + ack, no flag/no wire emit. Add an end-to-end test.

### H2 — Headhunter apply-by task idempotencyKey omits `role_class` → silent deadline loss
`apps/headhunter/src/windows.ts:241-243` · dimension: scout-headhunter / pillar5
Key is `headhunter:window:${coKey}:${cycleKey}` — `role_class` is dropped. The shipped seed tracks both
`google:fall-2026:new-grad` and `google:fall-2026:intern` (distinct rows, distinct deadlines) which
produce the **identical** key. Forge dedups → the second role's apply-by task is silently dropped → the
owner misses a deadline. Reproduces out-of-the-box for Google and Meta. **Fix:** append
`:${roleKey}` (role_class) to the key; add a two-window test.

### H3 — Stale-heartbeat alarm re-fires in a tight loop (incident storm)
`apps/flagger/src/state.ts:278-296` · dimension: flagger
`runAlarm()` emits the `heartbeat_stale` incident but never advances/marks the slot; the `finally`
`refreshAlarm()` computes `earliest = expected_by + grace` (a past time for a stale slot) → `setAlarm(now+1)`
→ re-fires ~1ms later, still stale → re-emits forever until the next heartbeat resets the slot (up to ~24h
for a daily agent). Blows the Free-tier Queues 10k-ops/day budget in seconds + ntfy spam. (Becomes
reachable once H1 is fixed.) **Fix:** advance the slot / write a fired marker and re-arm for the NEXT window.

### H4 — Watchdog false-fires self-P1 every 5 min on a healthy-but-idle Flagger
`apps/flagger-watchdog/src/index.ts` + `apps/flagger/src/index.ts:90` · dimension: atlas-watchdog
The watchdog's only liveness signal is `flagger:last_seen`, written **only** when Flagger processes an
incident. The only incident producers are failure paths + the morning chain (~07:45-09:00 ET), so on a
healthy quiet day zero incidents arrive, the key goes stale within the 15m threshold, and the watchdog
fires the self-P1 every 5 min (~22h/day) — with an un-deduped urgent ntfy push each time. Idle ≠ dead.
(Board self-dedups on a per-day key, but the push channel storms.) **Fix:** give Flagger a liveness signal
independent of incident volume (own cron self-tick / DO alarm, or watchdog probes Flagger directly).

### H5 — Fit-floor + explicit-deadline urgency are structurally unreachable in production (D2-14 defeated)
`apps/headhunter/src/windows.ts:229-234`, `index.ts:170,265`, `migrations/0004` · dimension: scout-headhunter
`decideWindow` reads `window.deadline` and `window.fit_score`, but the `windows` table has **neither column**
(only `jobs` does) and both production SELECTs omit them → both are always `undefined`. So the fit-floor
guard never fires (every non-urgent window emits an apply-by task regardless of fit) and the explicit-deadline
urgency override never fires from D1. Unit tests inject these fields directly, masking dead production logic.
**Fix:** add `deadline`+`fit_score` to `windows` (or join from `jobs`), select them, and add a test through the real D1 read path.

---

## MEDIUM (13)

- **M1 — `atlas-incidents-dlq` declared but has no consumer (silent drop).** `apps/flagger/wrangler.jsonc:37`. Incidents that exhaust Flagger's 3 retries land on an orphan DLQ and drop after retention — the exact gap `dlq-sink`/`atlas-wire-dlq` exists to prevent, now one layer up on the highest-consequence substrate. **Fix:** add a consumer (extend dlq-sink) that writes an audit row + direct ntfy P1; or drop the `dead_letter_queue` line until a sink exists.
- **M2 — Scout writes untrusted feed titles/URLs into D1 + Vault with no `redact()` backstop.** `apps/scout/src/index.ts`. No `@atlas/security` dependency anywhere in Scout; a code/login-URL-shaped token in a `Type/Newsletter` subject reaches the Vault unredacted. **Fix:** `redact()` title/description/url before persist + emit; add a masking test.
- **M3 — Flagger pushes incident title to external ntfy.sh with no redaction.** `apps/flagger/src/push.ts:33-64`. A third-party network egress with no `redact()` backstop. **Fix:** redact `flag.title` before the POST + push-path test.
- **M4 — Flagger malformed-incident embeds raw body into Vault detail without redaction.** `apps/flagger/src/index.ts:60-74`. `detail: JSON.stringify(body).slice(0,500)` of arbitrary unvalidated content → Vault/D1 audit. **Fix:** `redact()` before slice + routing test.
- **M5 — Jobs funnel increments collapse onto a single `pipeline` counter.** `apps/headhunter/src/windows.ts` (`buildFunnelEvent`). No `counter` field → Steward falls back to `entity:"pipeline"` for all 5 stages → per-stage funnel metric is unreconstructable from D1 (kanban survives via frontmatter). **Fix:** `payload.counter = funnel:${stage}` + per-stage Wire-contract test.
- **M6 — Recurrence re-scoring hard-codes `kind:"unknown"` → recurring P1 trust DROPS 100→55.** `apps/flagger/src/state.ts:73-82`. `OpenFlag` doesn't store `kind`; re-score uses `baseTrust("unknown")=50`. Severity routing is preserved (uses the real incident), so triage still fires — but the trust band inverts. **Fix:** persist `kind` on `OpenFlag` + D1 row; re-score off it. (Two findings — pillar5 + flagger — same root.)
- **M7 — Recurrence bumps never reach the Vault (stable `flag.id` dedups every recurrence at Steward).** `apps/flagger/src/index.ts:138`. `idempotencyKey: flag.id` is frozen at first occurrence; Steward's `INSERT OR IGNORE` no-ops occurrences 2..N → board projection frozen while D1 (authoritative) updates. **Fix:** `idempotencyKey = ${flag.id}:r${recurrence}` (keep `flag.id` as the board-row entity). (Two findings — same root.)
- **M8 — Monotonic window state machine (`HeadhunterState` DO) is dead code; seed reload regresses status every `full()`.** `apps/headhunter/src/state.ts`, `seed.ts`. `advanceWindow`/`canAdvance` never invoked; promotion is a raw D1 write; `loadSeedIfEmpty` does `INSERT OR REPLACE` of `status:"upcoming"` seed rows every Monday, clobbering any `closing` promotion. **Fix:** route promotion through the DO, or `INSERT OR IGNORE` the seed + guard the promotion write.
- **M9 — Success-only heartbeat sends are unguarded → a queue hiccup becomes a false chain failure.** filer/forge/sundial/compass. `await env.INCIDENTS?.send({…heartbeat})` with no `.catch()` after the real work + Wire event already landed; a transient reject throws out of `sweep()/morning()/sync()/plan()` → MorningChain halts + P2 (and Filer re-runs live label sweeps). Atlas's own heartbeat is correctly wrapped. **Fix:** `.catch(()=>{})` or `ctx.waitUntil`.
- **M10 — Heartbeats never recorded into Flagger's alarm scheduler.** (atlas-watchdog dimension restatement of H1's consumer half — same fix as H1.)
- **M11 — Herald-weekly failure path never asserts the P2 incident is emitted (DoD #3 unmet for weekly mode).** `apps/herald/test/weekly.test.ts`. Tests prove the secret is blocked/redacted but never capture INCIDENTS to assert `severity_hint==="P2"`/`kind==="security_leak_blocked"`. A regression dropping the `flag(…,"P2",…)` call would still pass. **Fix:** add an INCIDENTS spy + P2 assertion.

## LOW (7)

- **L1** — `apps/dlq-sink/src/index.ts:12` header comment still describes the pre-D2-05 `flag()` behavior (FlagRecord→atlas-wire); file self-contradicts. Fix the comment.
- **L2** — Flagger `/ack` throws an unhandled 500 on a malformed/empty JSON body (auth runs first, so no bypass). Wrap parse in try/catch → 400; validate `id`.
- **L3** — `resolveFlag`/`muteFlag` don't mirror status to the D1 `flags` table (currently dead code — no callers; latent Pillar-4 drift the moment a `/resolve` route is wired).
- **L4** — ntfy Ack-button URL hardcoded `https://flagger.workers.dev/ack` placeholder → ack-from-phone POSTs to the wrong host on any real domain. Derive from config/origin.
- **L5** — Scout suppresses per-event re-emission on replay (its own dup-check, not Steward dedup) → a lost Vault projection row won't self-heal on replay. Consider always emitting with the stable key.
- **L6** — Headhunter failure-path test (`funnel.test.ts:217-241`) is mislabeled: it exercises the per-task catch, not the claimed fatal `runFull throws` path (both are P2, so severity assert is still valid). Add a real fatal-path test.

## INFO (3)

- **I1** — `flagger:last_seen` written to a hot KV key every batch (KV is 1 write/s/key). Negligible vs the 15m threshold; consider DO storage. (Downgraded low→info.)
- **I2** — `apps/headhunter/src/index.ts:284` does an in-loop `await import("./windows.js")` for `isUrgent` (already a static sibling export). Move to the top-level import.
- **I3** — `flagger/test/routing.test.ts` asserts flag-event shape but not the structured `idempotencyKey` (covered by sibling tests; DoD #1 satisfied across the suite). Add the assertion for completeness.

## DISMISSED (1, false positive)

- **`upsertFlag` recurrence RMW not in `blockConcurrencyWhile`** — refuted: the `storage.get → synchronous score() → storage.put` window contains no non-storage I/O await, so the DO **input gate** serializes it; no lost update. Adding `blockConcurrencyWhile` would be defensive consistency only, not a bug fix.

---

## Recommended remediation grouping (for gap closure)

1. **Heartbeat/watchdog subsystem** (H1, H3, H4, M9, M10) — the largest cluster; fix coherently: Flagger consumes heartbeats into the scheduler (no flag), the stale-alarm re-arms for the next window, Flagger gets an incident-independent liveness signal, and the producer sends are best-effort. *Design choice needed: watchdog liveness mechanism.*
2. **Headhunter correctness** (H2, H5, M5, M8) — role_class in the dedup key (data loss), `windows` schema columns for the fit-floor (D2-14), per-stage funnel counters, seed-reload/state-machine. *Schema change in `0004`/a new migration.*
3. **Security defense-in-depth** (M2, M3, M4) — add `@atlas/security` `redact()` backstops to Scout persist/emit, the ntfy egress, and the malformed-incident detail.
4. **Flagger recurrence→projection** (M6, M7) — persist `kind`; vary the wire key by recurrence so the board reflects escalation. *Design choice: idempotency-key-per-recurrence.*
5. **DLQ + tests + polish** (M1, M11, L1-L6, I1-I3).
