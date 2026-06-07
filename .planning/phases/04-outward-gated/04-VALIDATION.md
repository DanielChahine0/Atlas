---
phase: 4
slug: outward-gated
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-06
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `04-RESEARCH.md` → Validation Architecture. Per-task map is filled after planning
> (needs task IDs); the test infrastructure, sampling rate, and Wave 0 gaps below are authoritative now.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest + `@cloudflare/vitest-pool-workers` (existing; runs in real `workerd`) |
| **Config file** | `vitest.workspace.ts` (existing — auto-discovers per-app configs) |
| **Quick run command** | `pnpm test --filter @atlas/gate && pnpm test --filter apps/usher && pnpm test --filter apps/envoy` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~60–120 seconds (full 515+ suite) |

*Migrations applied in test setup via `applyD1Migrations` (pattern from 0001–0006); `0007_gate.sql` joins this.*

---

## Sampling Rate

- **After every task commit:** Run the quick command (`@atlas/gate` + `apps/usher` + `apps/envoy`).
- **After every plan wave:** Run `pnpm test` (full suite) — must include Sundial regression (gate retrofit).
- **Before `/gsd:verify-work`:** Full suite green AND Sundial tests still pass (retrofit must not regress).
- **Max feedback latency:** ~120 seconds (full suite).

---

## Per-Task Verification Map

> **To be filled after planning** — task IDs (`04-NN-MM`) do not exist until PLAN.md files are written.
> Each row maps a task to the requirement + threat ref + test below. The requirement→test mapping is
> already locked (see next section); planning attaches task IDs.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _TBD post-planning_ | — | — | OUTWARD-01/02 | — | see Requirement→Test Map | unit | see Requirement→Test Map | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

### Requirement → Test Map (locked from research)

| Req | Behavior | Test Type | Automated Command |
|-----|----------|-----------|-------------------|
| OUTWARD-01 | Usher Wire event shape + key `usher:<event-id>:registered` | unit | `pnpm test --filter apps/usher` |
| OUTWARD-01 | Replay through Steward leaves `meta.changes===0` | unit | `pnpm test --filter apps/usher -- --grep replay` |
| OUTWARD-01 | Captcha hard-stop → P3 flag, zero side effects | unit | `pnpm test --filter apps/usher -- --grep captcha` |
| OUTWARD-01 | Payment hard-stop → P2 flag, zero side effects | unit | `pnpm test --filter apps/usher -- --grep payment` |
| OUTWARD-01 | Gate timeout → expired, no Calendar add | unit | `pnpm test --filter @atlas/gate -- --grep expire` |
| OUTWARD-01 | Gate error → deny (no fail-open) | unit | `pnpm test --filter @atlas/gate -- --grep fail-closed` |
| OUTWARD-01 | Submit-without-confirmation → P1 self-flag | unit | `pnpm test --filter apps/usher -- --grep p1-self-flag` |
| OUTWARD-01 | Already-registered short-circuit | unit | `pnpm test --filter apps/usher -- --grep already-registered` |
| OUTWARD-02 | Envoy Wire event shape + key `envoy:<project-slug>` | unit | `pnpm test --filter apps/envoy` |
| OUTWARD-02 | Replay through Steward leaves `meta.changes===0` | unit | `pnpm test --filter apps/envoy -- --grep replay` |
| OUTWARD-02 | Partial fan-out → P2, exact succeeded targets reported | unit | `pnpm test --filter apps/envoy -- --grep partial-fanout` |
| OUTWARD-02 | Browser block (LinkedIn/X) → abort target, keep draft, P2 | unit | `pnpm test --filter apps/envoy -- --grep dom-block` |
| OUTWARD-02 | Per-target approve/skip: approved subset only published | unit | `pnpm test --filter apps/envoy -- --grep per-target` |
| OUTWARD-01+02 | Dual audit_log rows per gated action (pending + terminal) | unit | `pnpm test --filter @atlas/gate -- --grep audit-log` |
| OUTWARD-01+02 | Gate sweep: approve-vs-expire mutual exclusion + idempotent re-sweep (no double-terminal-state, no spurious P3) | unit | `pnpm test --filter @atlas/gate -- --grep race` |
| OUTWARD-01+02 | `openGate()` dispatches ntfy push (best-effort; push-send failure is non-fatal, gate still opens) | unit | `pnpm test --filter @atlas/gate -- --grep push` |
| OUTWARD-01+02 | Sundial retrofit: propose-removal calls gate primitive | unit | `pnpm test --filter apps/sundial -- --grep gate-retrofit` |
| OUTWARD-01+02 | Pillar 1: no second `atlas-wire` consumer | integration | hook `guard-wire-consumer.js` (existing) |
| OUTWARD-01+02 | Security: no 2FA codes/reset links in confirm page or push body | unit | `pnpm test --filter @atlas/gate -- --grep security` |

---

## Wave 0 Requirements

- [ ] `migrations/0007_gate.sql` — `gate_pending` (+ `browser_action_outbox`) tables; applied via `applyD1Migrations` in test setup
- [ ] `packages/gate/src/index.test.ts` — schema, `openGate()`, `decideGate()`, `sweepExpired()`
- [ ] `packages/gate/src/auth.test.ts` — `timingSafeEqual` constant-time property (token gate, fail-closed)
- [ ] `packages/gate/src/render.test.ts` — `renderConfirmPage()` security headers + no-2FA-code invariant
- [ ] `apps/gate/src/index.test.ts` — `GET /confirm` renders; `POST /confirm` approve/reject; error→deny; expired→410
- [ ] `apps/usher/src/index.test.ts` — Wire contract, replay, failure paths (captcha/payment/sold-out/P1)
- [ ] `apps/envoy/src/index.test.ts` — Wire contract, replay, partial fan-out, per-target approve/skip
- [ ] `apps/sundial/src/reconcile.test.ts` — add gate-retrofit test (existing tests MUST still pass)

*Daemon browser-runner logic is exercised by Node.js unit tests against mock pages (no workerd needed for Playwright logic).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Gate adherence = 100% (no `decision='auto'` outward rows) | OUTWARD-01/02 | Cross-row D1 invariant over real runs | After live runs, assert every Usher/Envoy `audit_log` row has `gated=1` and `decision IN ('approved','rejected','expired')` |
| Every terminal gate has a matching audit row | OUTWARD-01/02 | Cross-row invariant | Assert each `gate_pending.status='done'` row has a matching `audit_log` terminal row |
| No orphan browser action | OUTWARD-01/02 | Cross-row invariant | Assert no `browser_action_outbox.status='done'` row whose `gate_pending.status != 'approved'` |
| Real LinkedIn/X/event-site registration in owner's logged-in session | OUTWARD-01/02 | Needs the physical macOS daemon + owner's real accounts; ToS-gray, brittle DOM | Owner go-live: drive the local browser against a real low-stakes event + a real launch post |
| GitHub App `pull_requests: write` permission grant | OUTWARD-02 | Owner re-installs the GitHub App | Owner go-live: confirm a real portfolio PR opens via mcp-github |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
