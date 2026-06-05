---
phase: 02
slug: weekly-value
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-05
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `02-RESEARCH.md` → ## Validation Architecture. Per-task rows are
> seeded by requirement; concrete task IDs are bound during planning/execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.x + `@cloudflare/vitest-pool-workers` 0.16.13 (runs in real `workerd`, `TZ=UTC`) |
| **Config file** | Each app has `vitest.config.ts`; root `vitest.workspace.ts` aggregates |
| **Quick run command** | `pnpm --filter <app> test` (app-scoped, e.g. `pnpm --filter flagger test`) |
| **Full suite command** | `pnpm test` (all workspaces — currently 315 tests, must stay green) |
| **Estimated runtime** | ~quick <15s app-scoped; full suite ~60–120s |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter <app> test` (app-scoped)
- **After every plan wave:** Run `pnpm test` (full suite — must stay green, no regression below 315)
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~15s app-scoped, ~120s full suite

---

## Per-Task Verification Map

> Seeded per requirement from research. The planner/executor binds Task ID, Plan,
> and Wave columns once plans exist. Every row maps to a Definition-of-Done test
> (Wire-contract / replay / failure-path) per CLAUDE.md.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | — | — | WEEKLY-02 | T-02-poison | malformed incident → `ack()`, no poison loop | unit | `pnpm --filter @atlas/shared test` | ❌ W0 (update flag.test.ts) | ⬜ pending |
| TBD | — | — | WEEKLY-02 | — | `flag()` enqueues to `atlas-incidents`, NOT `atlas-wire` | unit | `pnpm --filter @atlas/shared test` | ❌ W0 | ⬜ pending |
| TBD | — | — | WEEKLY-02 | T-02-storm | dedupe same signature → one flag row | unit | `pnpm --filter flagger test -- dedup` | ❌ W0 | ⬜ pending |
| TBD | — | — | WEEKLY-02 | — | P1/P2 → push call; P3/P4 → no push (batch) | unit | `pnpm --filter flagger test -- routing` | ❌ W0 | ⬜ pending |
| TBD | — | — | WEEKLY-02 | — | FlaggerState DO alarm fires when heartbeat slot stale | unit | `pnpm --filter flagger test -- alarm` | ❌ W0 | ⬜ pending |
| TBD | — | — | WEEKLY-02 | — | self-watchdog kill test: Flagger stale → external self-P1 (GATING) | integration | `pnpm --filter flagger-watchdog test -- kill` | ❌ W0 | ⬜ pending |
| TBD | — | — | WEEKLY-02 | T-02-ack | ack endpoint: forged/absent token → 401, no state change | unit | `pnpm --filter flagger test -- ack-auth` | ❌ W0 | ⬜ pending |
| TBD | — | — | WEEKLY-02 | — | replay through Steward: same incident → `meta.changes === 0` | integration | `pnpm --filter steward test -- replay` | ✅ (extend existing) | ⬜ pending |
| TBD | — | — | WEEKLY-01 | — | Headhunter re-scan idempotent: same window → same task, no counter inflation (GATING) | integration | `pnpm --filter headhunter test -- idempotent` | ❌ W0 | ⬜ pending |
| TBD | — | — | WEEKLY-01 | — | low-confidence window date → P3 flag, NOT a task | unit | `pnpm --filter headhunter test -- low-confidence` | ❌ W0 | ⬜ pending |
| TBD | — | — | WEEKLY-01 | — | urgency (in lead-time / explicit deadline) bypasses fit-floor → still tasks | unit | `pnpm --filter headhunter test -- urgency` | ❌ W0 | ⬜ pending |
| TBD | — | — | WEEKLY-01 | — | Scout re-run same Friday → same event list, no duplicate Steward events | integration | `pnpm --filter scout test -- idempotent` | ❌ W0 | ⬜ pending |
| TBD | — | — | WEEKLY-01 | T-02-link | Scout never follows links from email sources; never reads Type/Security | unit | `pnpm --filter scout test -- safety` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/shared/test/flag.test.ts` — update to assert `RawIncident` shape on `INCIDENTS` queue, not finished `FlagRecord` on `atlas-wire` (REQ: WEEKLY-02)
- [ ] `apps/flagger/test/dedup.test.ts` — signature dedup → one flag (REQ: WEEKLY-02)
- [ ] `apps/flagger/test/routing.test.ts` — P1/P2 push vs P3/P4 batch routing (REQ: WEEKLY-02)
- [ ] `apps/flagger/test/alarm.test.ts` — DO alarm stale-heartbeat detection (REQ: WEEKLY-02)
- [ ] `apps/flagger/test/ack-auth.test.ts` — token-gated ack endpoint, constant-time compare, fail-closed (REQ: WEEKLY-02)
- [ ] `apps/flagger-watchdog/test/kill.test.ts` — self-watchdog kill test (GATING criterion)
- [ ] `apps/headhunter/test/idempotent.test.ts` — re-scan idempotency (GATING criterion)
- [ ] `apps/headhunter/test/low-confidence.test.ts` — low-confidence → flag not task (REQ: WEEKLY-01)
- [ ] `apps/scout/test/idempotent.test.ts` — re-run idempotency (REQ: WEEKLY-01)
- [ ] `apps/dlq-sink/test/dlq.test.ts` — update to new `RawIncident` shape (flag() migration)
- [ ] Per-agent heartbeat-emit tests for each Phase-0/1 agent retrofit (filer/herald/forge/sundial/compass/steward/atlas)

*Existing Steward replay infrastructure covers the `meta.changes === 0` pattern — extend, do not rebuild.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| ≥70% of flags actionable (non-muted) on the noise bar | WEEKLY-02 (gating) | Requires ~1 week of live incident volume to measure; no deterministic fixture | After go-live, review Flagger board: `actionable / (actionable + muted) ≥ 0.70` over a 7-day window |
| ntfy P1/P2 push actually reaches the iOS/Android app | WEEKLY-02 | Requires the seeded ntfy topic + a subscribed device (owner go-live gate) | Seed `NTFY_TOPIC`/token, flip `flagger.push_enabled=true`, trigger a synthetic P1, confirm push + ack button round-trips |
| Workers Free per-Worker cron cap accommodates 7 total crons | (infra) | Depends on current Cloudflare Free-plan limits (research A1, LOW confidence) | `checkpoint:human-verify` before expanding `apps/atlas` crons — confirm via `wrangler deploy --dry-run` / dashboard; upgrade to Paid only if capped |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s (full suite)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
