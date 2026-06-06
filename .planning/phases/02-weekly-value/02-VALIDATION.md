---
phase: 02
slug: weekly-value
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-06-05
validated: 2026-06-06
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `02-RESEARCH.md` → ## Validation Architecture. Per-task rows were
> seeded by requirement at planning time; task IDs (Plan/Wave) and test files were
> bound during the post-execution validation audit (2026-06-06).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.x + `@cloudflare/vitest-pool-workers` 0.16.13 (runs in real `workerd`, `TZ=UTC`) |
| **Config file** | Each app has `vitest.config.ts`; root `vitest.workspace.ts` aggregates |
| **Quick run command** | `pnpm --filter <app> test` (app-scoped, e.g. `pnpm --filter flagger test`) |
| **Full suite command** | `pnpm test` (all workspaces — **477 passing + 2 skipped**, must stay green) |
| **Estimated runtime** | ~quick <15s app-scoped; full suite ~60–120s |

> The 2 skips are Phase-0 live-OAuth round-trips in `apps/atlas` (require live Google
> credentials) — manual/go-live gated, not Phase-2 concerns.

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter <app> test` (app-scoped)
- **After every plan wave:** Run `pnpm test` (full suite — must stay green, no regression below 477)
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~15s app-scoped, ~120s full suite

---

## Per-Task Verification Map

> Bound to real Plan/Wave/test-file during the 2026-06-06 audit. Every row maps to a
> Definition-of-Done test (Wire-contract / replay / failure-path) per CLAUDE.md and is
> green in the full suite.

| Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Test File | Automated Command | Status |
|------|------|-------------|------------|-----------------|-----------|-----------|-------------------|--------|
| 02-01 / 02-02 | 1 / 2 | WEEKLY-02 | T-02-poison | malformed incident → `ack()`, no poison loop | unit | `packages/shared/test/flag.test.ts` (RawIncident schema reject) + `apps/flagger` malformed branch | `pnpm --filter @atlas/shared test` | ✅ green |
| 02-01 | 1 | WEEKLY-02 | — | `flag()` enqueues to `atlas-incidents`, NOT `atlas-wire` | unit | `packages/shared/test/flag.test.ts` | `pnpm --filter @atlas/shared test` | ✅ green |
| 02-02 | 2 | WEEKLY-02 | T-02-storm | dedupe same signature → one flag row | unit | `apps/flagger/test/dedup.test.ts` | `pnpm --filter flagger test -- dedup` | ✅ green |
| 02-02 | 2 | WEEKLY-02 | — | P1/P2 → push call; P3/P4 → no push (board batch) | unit | `apps/flagger/test/routing.test.ts` | `pnpm --filter flagger test -- routing` | ✅ green |
| 02-02 / 02-03 | 2 | WEEKLY-02 | — | FlaggerState DO alarm fires when heartbeat slot stale | unit | `apps/flagger/test/alarm.test.ts` | `pnpm --filter flagger test -- alarm` | ✅ green |
| 02-03 | 2 | WEEKLY-02 | — | self-watchdog kill test: Flagger stale → external self-P1 (GATING) | integration | `apps/flagger-watchdog/test/kill.test.ts` | `pnpm --filter flagger-watchdog test -- kill` | ✅ green |
| 02-02 | 2 | WEEKLY-02 | T-02-ack | ack endpoint: forged/absent token → 401, no state change | unit | `apps/flagger/test/ack-auth.test.ts` | `pnpm --filter flagger test -- ack-auth` | ✅ green |
| 02-01 | 1 | WEEKLY-02 | — | replay through Steward: same incident → `meta.changes === 0` | integration | `apps/steward/test/replay.test.ts` | `pnpm --filter steward test -- replay` | ✅ green |
| 02-05 | 2 | WEEKLY-01 | — | Headhunter re-scan idempotent: same window → same task, no counter inflation (GATING) | integration | `apps/headhunter/test/idempotent.test.ts` | `pnpm --filter headhunter test -- idempotent` | ✅ green |
| 02-05 | 2 | WEEKLY-01 | — | low-confidence window date → P3 flag, NOT a task | unit | `apps/headhunter/test/low-confidence.test.ts` | `pnpm --filter headhunter test -- low-confidence` | ✅ green |
| 02-05 | 2 | WEEKLY-01 | — | urgency (in lead-time / explicit deadline) bypasses fit-floor → still tasks | unit | `apps/headhunter/test/urgency.test.ts` | `pnpm --filter headhunter test -- urgency` | ✅ green |
| 02-04 | 2 | WEEKLY-01 | — | Scout re-run same Friday → same event list, no duplicate Steward events | integration | `apps/scout/test/idempotent.test.ts` | `pnpm --filter scout test -- idempotent` | ✅ green |
| 02-04 | 2 | WEEKLY-01 | T-02-link | Scout never follows links from email sources; never reads Type/Security | unit | `apps/scout/test/safety.test.ts` | `pnpm --filter scout test -- safety` | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

### Coverage beyond the seeded contract

Execution added tests that exceed the seeded validation contract (all green):

- `apps/flagger/test/recurrence.test.ts` — recurrence re-scoring + `${flag.id}:r${n}` idempotency (M6/M7)
- `apps/flagger/test/self-tick.test.ts` — self-tick cron writes `flagger:last_seen` (H4)
- `apps/flagger/test/security-redact.test.ts` — `redact()` on push title (M3) + malformed detail (M4)
- `apps/flagger/test/heartbeat.test.ts` — heartbeat→`recordHeartbeat` branch, no flag emitted (H1)
- `apps/dlq-sink/test/incidents-dlq.test.ts` — dual-DLQ: `atlas-incidents-dlq` → direct `atlas-wire` P1 (M1)
- `apps/headhunter/test/funnel.test.ts` — per-stage funnel counters (M5)
- `apps/headhunter/test/d1-fitfloor.test.ts` — fit-floor reads `deadline`/`fit_score` from D1 (H5)
- `apps/headhunter/test/seed-monotonic.test.ts` — `INSERT OR IGNORE` seed cannot regress status (M8)
- `apps/scout/test/redact.test.ts` — `redact()` on title/description/url before persist + emit (M2)
- `apps/steward/test/weekly-review.test.ts` — Fri 16:30 counter re-derive build
- `apps/herald/test/weekly.test.ts` — weekly guardrail trip → P2 incident (M11)
- Heartbeat-emit retrofit tests: `apps/{filer,herald,forge,sundial,compass,atlas}/test/heartbeat.test.ts` (M9).
  Scout/Headhunter heartbeat emission is asserted within their `idempotent`/`funnel` tests.

---

## Wave 0 Requirements

All Wave 0 dependencies satisfied during execution:

- [x] `packages/shared/test/flag.test.ts` — asserts `RawIncident` shape on `INCIDENTS` queue, not finished `FlagRecord` on `atlas-wire` (REQ: WEEKLY-02)
- [x] `apps/flagger/test/dedup.test.ts` — signature dedup → one flag (REQ: WEEKLY-02)
- [x] `apps/flagger/test/routing.test.ts` — P1/P2 push vs P3/P4 batch routing (REQ: WEEKLY-02)
- [x] `apps/flagger/test/alarm.test.ts` — DO alarm stale-heartbeat detection (REQ: WEEKLY-02)
- [x] `apps/flagger/test/ack-auth.test.ts` — token-gated ack endpoint, constant-time compare, fail-closed (REQ: WEEKLY-02)
- [x] `apps/flagger-watchdog/test/kill.test.ts` — self-watchdog kill test (GATING criterion)
- [x] `apps/headhunter/test/idempotent.test.ts` — re-scan idempotency (GATING criterion)
- [x] `apps/headhunter/test/low-confidence.test.ts` — low-confidence → flag not task (REQ: WEEKLY-01)
- [x] `apps/scout/test/idempotent.test.ts` — re-run idempotency (REQ: WEEKLY-01)
- [x] `apps/dlq-sink/test/dlq.test.ts` (+ `incidents-dlq.test.ts`) — new `RawIncident` shape, dual-DLQ
- [x] Per-agent heartbeat-emit tests for each Phase-0/1 agent retrofit (filer/herald/forge/sundial/compass/atlas).
      *Steward excluded by design — it is the consumer DO and emits no heartbeat.*

*Existing Steward replay infrastructure covers the `meta.changes === 0` pattern — extended, not rebuilt.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| ≥70% of flags actionable (non-muted) on the noise bar | WEEKLY-02 (gating) | Requires ~1 week of live incident volume to measure; no deterministic fixture | After go-live, review Flagger board: `actionable / (actionable + muted) ≥ 0.70` over a 7-day window |
| ntfy P1/P2 push actually reaches the iOS/Android app | WEEKLY-02 | Requires the seeded ntfy topic + a subscribed device (owner go-live gate) | Seed `NTFY_TOPIC`/token, flip `flagger.push_enabled=true`, trigger a synthetic P1, confirm push + ack button round-trips |
| Workers Free per-Worker cron cap accommodates 7 total crons | (infra) | Depends on current Cloudflare Free-plan limits (research A1, LOW confidence) | `checkpoint:human-verify` before expanding `apps/atlas` crons — confirm via `wrangler deploy --dry-run` / dashboard; upgrade to Paid only if capped |
| Live OAuth round-trips (2 skipped tests in `apps/atlas`) | (Phase 0 carry-over) | Require live Google credentials; skipped in CI | Owner completes OAuth consent at go-live; the 2 atlas skips activate once credentials are present |

---

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s (full suite)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-06-06 — 13/13 seeded per-task rows green, full suite 477 passing + 2 skipped (manual/go-live gated), 0 gaps.

---

## Validation Audit 2026-06-06

| Metric | Count |
|--------|-------|
| Seeded per-task rows | 13 |
| COVERED (green) | 13 |
| PARTIAL | 0 |
| MISSING | 0 |
| Gaps found | 0 |
| Resolved | 0 (none required) |
| Escalated to manual-only | 0 |
| Tests added beyond seed | 12+ (recurrence, self-tick, funnel, fit-floor, redact, heartbeat retrofit, …) |
| Full-suite result | 477 passed + 2 skipped (0 failed) |

**Method:** State A audit — reconciled the planning-time seeded contract against the
post-execution codebase. Every seeded requirement was cross-referenced to a real test
file by filename + behavior, then the full suite was run (`pnpm test`) to confirm green.
No `gsd-nyquist-auditor` spawn was needed — zero gaps. The seeded "steward heartbeat"
item was verified as a non-applicable over-specification (Steward is the consumer DO and
emits no heartbeat), not a coverage gap.
