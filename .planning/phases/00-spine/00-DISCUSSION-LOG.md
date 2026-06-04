# Phase 0: Spine - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-04
**Phase:** 0-Spine
**Areas discussed:** Hosting plan posture, Monorepo & Worker granularity, Scheduling & DST policy, Steward & infra knobs

---

## Hosting plan posture

| Option | Description | Selected |
|--------|-------------|----------|
| Free-to-start | Build & deploy the whole spine on Workers Free (Queues/Workflows/SQLite-DOs free now); upgrade to Paid only if a real ceiling is hit; reconcile PROJECT.md. | ✓ |
| Provision Paid now ($5/mo) | Subscribe up front for headroom (14-day queue retention, 30-day workflow state, KV-backed DO option, higher cron cap). | |

**User's choice:** Free-to-start (Recommended)
**Notes:** Confirmed live on 2026-06-04 — `wrangler queues list` succeeds on the free account (`chahinedaniel0@gmail.com`). The "Queues/Workflows free" finding was verified against authoritative Cloudflare sources (changelog 2026-02-04 + pricing/limits pages) before locking. Dominant cost is the Claude API bill, not hosting.

---

## Monorepo & Worker granularity

| Option | Description | Selected |
|--------|-------------|----------|
| pnpm | Drafted throughout the spec; corepack workspaces. | ✓ |
| npm | Ships with Node; slower/heavier; would require adjusting spec commands. | |
| bun | Fastest, but less battle-tested with wrangler + vitest-pool-workers. | |
| One Worker per agent | Max least-privilege isolation; matches repo layout (`apps/<codename>`). | ✓ |
| Group low-risk agents | Fewer deploys, but Steward + Filer must stay isolated. | |

**User's choice:** pnpm + One Worker per agent (both Recommended)
**Notes:** Steward (sole Wire consumer) and Filer (`gmail.modify` boundary) stay isolated regardless.

---

## Scheduling & DST policy

| Option | Description | Selected |
|--------|-------------|----------|
| UTC cron + twice-yearly hand-edit (= D1) | Hand-edit cron at EST↔EDT boundary; in-Workflow waits use `step.sleepUntil`; write EST/EDT table into `docs/03-scheduling.md`. | ✓ |
| Fixed UTC offset | Never touch cron; tolerate ≤1h drift half the year. | |
| Self-check drift flag | Flagger incident when cron no longer maps to owner-local 07:45. | |

**User's choice:** UTC cron + twice-yearly hand-edit (Recommended, = project decision D1)
**Notes:** Writing the EST/EDT table into `docs/03-scheduling.md` is a Phase-0 "setup-done" criterion. The self-check flag remains available as a future safety net (noted, not adopted now).

---

## Steward & infra knobs

| Option | Description | Selected |
|--------|-------------|----------|
| Ledger: keep keys forever | Replay = no-op at any age; trivial storage at single-owner volume. | ✓ |
| Ledger: TTL (e.g. 90 days) | Bounds storage but risks a late replay double-counting. | |
| compat_date 2026-04-25 | ≥ 2026-04-07 enables `web_socket_auto_reply_to_close` (Echo later). | ✓ |
| compat_date today (2026-06-04) | Latest behavior; no concrete Phase-0 benefit. | |
| Heartbeat 5 min | Balanced detection vs false positives. | ✓ |
| Heartbeat 1–2 min | Faster, more false positives. | |
| Heartbeat 10–15 min | Fewer alarms, slower to notice a dead daemon. | |
| Transport: service-binding RPC | Lowest latency, type-safe, no public surface. | ✓ |
| Transport: HTTP fetch | Simpler, more overhead, larger attack surface. | |
| Transport: defer to research | Let planner pick. | |

**User's choice:** Keep keys forever · compat_date 2026-04-25 · Heartbeat 5 min · service-binding RPC (all Recommended)
**Notes:** All four on the drafted/recommended defaults; pairs with `compatibility_flags: ["nodejs_compat"]` (Agents SDK requirement).

## Claude's Discretion

- D1 schema specifics (columns, indexes), exact per-agent OAuth scope strings, Codex section file layout, Secrets Store key naming, and `wrangler.jsonc` shapes — deferred to research/planning, constrained by the canonical refs and `CLAUDE.md` pins.

## Deferred Ideas

- AI Gateway $/rate ceilings; Herald output surface; Compass `effort` level; the two manual measurement commitments; morning-chain success-rate window — all Phase-1 (surface when Filer's continuous push goes live).
- Workflow-state retention ceiling (>3 days) — the future trigger to adopt Workers Paid (Phase 4 confirm-gates).
