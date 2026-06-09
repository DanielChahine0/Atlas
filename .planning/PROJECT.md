# Atlas

## What This Is

Atlas is a personal multi-agent orchestrator on Cloudflare that runs a fleet of 16 specialized sub-agents to manage the owner's (Daniel Chahine's) digital life: email triage, task creation, calendar sync, event discovery, job hunting, meeting capture, an Obsidian dashboard, screen autofill, and cross-platform personal-brand publishing. Atlas itself does no domain work — it schedules, routes, sequences, supervises, and owns the shared event bus (the Wire) and state. It is built for one owner, by one implementer, as a read-only / suggest-don't-destroy system whose only irreversible actions sit behind explicit confirmation gates.

## Core Value

Every morning the owner sees a trustworthy digest, a deadline-safe task/calendar set, and a day plan — built automatically, with **zero missed deadlines** and **zero 2FA codes or reset links ever surfaced**. If everything else fails, the morning chain (Filer → Herald → Forge → Sundial → Compass) must run clean.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(None yet — ship to validate)

### Active

<!-- Current scope. Building toward these. See REQUIREMENTS.md for full IDs + acceptance. -->

- [~] **SPINE** — Atlas orchestrator, the Wire, Steward + the Vault, the Codex, Cloudflare project, Google + GitHub OAuth (Phase 0) — *code-complete 2026-06-05; owner go-live gates pending (OAuth round-trips, Secrets Store seed, Obsidian bridge, R2)*
- [~] **CORE** — strictly-sequential morning chain Filer → Herald → Forge → Sundial → Compass on one 07:45 cron via a Workflow, all feeding Steward → the Vault (Phase 1, with the MVP) — *code-complete + review-remediated 2026-06-05; owner go-live gates pending (baseline, miss-review, AI-Gateway ceilings, live smoke)*
- [x] **WEEKLY** — Scout, Headhunter (feeds Forge), Flagger (event-driven incidents + self-watchdog) (Phase 2) — *code-complete + review-remediated 2026-06-06; verified passed (9/9 must-haves, 477 tests). 28 adversarial-review findings (5 high) fixed in gap closure. Owner go-live gates shared with CORE.*
- [x] **CAPTURE** — Echo (audio, local daemon) → Archivist; Quill (screen autofill, local) (Phase 3) — *code-complete + verified 2026-06-06; owner UAT/go-live pending*
- [x] **OUTWARD** — Usher (gated registration), Envoy (gated public posts), behind a mature confirmation-gate UX (Phase 4) — *code-complete + verified 2026-06-08 (12/12 must-haves); code review found + fixed 2 blockers (gate→Envoy wiring, Sundial removal authorization) + 5 warnings; 5 live owner go-live round-trips pending (Secrets Store seed, Playwright install, Google OAuth, GitHub App grant)*
- [x] **META** — Switchboard (design-time capability router), Librarian (prompt library) (Phase 5) — *code-complete + verified 2026-06-09 (13/13 must-haves); code review found + fixed 1 critical (date-granular bump key suppressing same-day Vault updates) + 12 warnings before sign-off; 4 human-UAT items pending behind the shared owner go-live gates (live save→Vault round-trip, bump-key end-to-end, /switchboard live invocation, prompt-library table rendering)*

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- **Multi-user / teams / multi-tenant** — Atlas serves exactly one owner; no auth-for-others, sharing, or RBAC.
- **Switchboard as a deployed Worker** — per D7 it is a design-time habit consulted ad hoc; building a Worker that never fires in production is pure overhead. Revisit only if the fleet grows enough to feel routing pain.
- **Autonomous outward actions** — Echo/Quill/Usher/Envoy never act without explicit owner confirm; captcha and payment are hard stops handed back to the human. A post can't be un-posted; a payment can't be un-paid.
- **Filer archive/delete** — Filer labels only; the delete path is unreachable by scope (`gmail.modify`, never `mail.google.com/`).
- **Calendar-date / time estimates in the roadmap** — single-owner velocity is unknown until the spine ships; effort is relative (High/Medium/Low), re-baselined after Phase 0.

## Context

- **Stack:** TypeScript on Cloudflare — Workers + Durable Objects + Queues (the Wire) + Workflows + Cron Triggers; D1 (system-of-record), KV (config/flags + OAuth store), R2 (audio/exports) for state; remote MCP servers via the Cloudflare Agents SDK (Google/GitHub/Obsidian); Workers OAuth Provider for inbound auth; Claude via AI Gateway (Opus/Sonnet/Haiku tiered per agent). Echo (audio) and Quill (screen) run in a LOCAL macOS launchd daemon that authenticates outbound to the cloud.
- **Hosting:** the Workers **Free** plan builds & runs the spine — Queues (GA-on-Free 2026-02-04), Workflows, and SQLite-backed DOs are all on Free. Workers **Paid** ($5/mo) is an optional headroom upgrade, **not a hard gate** (only the unused KV-backed DOs need Paid). _Phase-0 decision D-01 (`.planning/phases/00-spine/00-CONTEXT.md`)._
- **Source corpus:** a completed design spec (32 docs). `docs/SPEC-CANON.md` is authoritative ("if two docs disagree, this file wins"). `docs/13-build-plan.md` carries the task-level breakdown of Phase 0 and Phase 1 with acceptance criteria; `docs/agents/<codename>.md` carries per-agent specs. Cross-reference both during planning/execution.
- **No ADRs, nothing locked.** The 5 SPEC-CANON §0 design pillars and the 7 build-plan decisions (D1–D7) are recorded below as "decided, not locked" — a future roadmapper may revisit them.
- **Owner-judgment calls deliberately left open** (NOT conflicts): package manager (pnpm drafted), Worker granularity, per-Worker cron cap, AI Gateway $/rate ceilings, `compatibility_date` pin (`2026-04-25`) + heartbeat staleness threshold (5 min), DST operational burden, `invokeAgent` transport (service-binding RPC recommended), Herald output surface (keep Gmail draft vs Vault-glance-only), Compass Opus `effort` level, the two manual measurement commitments (pre-launch baseline + ~1-min daily review), morning-chain success-rate window. Surface these at the relevant phase, do not silently decide them.

## Constraints

<!-- The 5 SPEC-CANON §0 pillars are global invariants; carry them into every phase. -->

- **Pillar 1 — One writer per resource**: exactly one agent mutates any external system; the Vault has a single writer (Steward). CI invariant: exactly one `atlas-wire` consumer; a second consumer fails the build. — prevents races and double-counting.
- **Pillar 2 — Suggest, don't destroy**: agents label, draft, recommend; anything destructive or outward-facing (delete, post, register, pay) is gated behind explicit human confirmation; gate fail-safe = deny on error. — single owner accepts a draft only if a gate is trustworthy.
- **Pillar 3 — Cloud by default, local when it must be**: most agents run on Cloudflare; Echo (audio) and Quill (screen) run as a local macOS daemon over outbound-only OAuth-bearer transport (no inbound port to the laptop). — only the OS-bound capture work justifies leaving the cloud.
- **Pillar 4 — Single source of truth**: personal facts live in the Codex (read-only to agents); dashboard state lives in the Vault (Steward-written); D1 is the authoritative system-of-record, the Vault is a rendered view. — a hand-edited counter would make replays unresolvable.
- **Pillar 5 — Idempotent + observable**: every run is safe to repeat (idempotency-keyed Wire events; replay leaves counters unchanged, `meta.changes === 0`); every notable event/failure → Flagger; observability + run/audit log wired from day 0. — at-least-once delivery cannot double-count, nothing fails silently.
- **Security**: NEVER reproduce 2FA codes / reset links in any digest; redaction enforced server-side at the Google-MCP strip point (a prompt instruction is NOT sufficient) with a CI digest-builder unit test backstop. Per-agent least-privilege OAuth scopes; secrets in Cloudflare Secrets Store, never the Vault/Codex.
- **Tech stack / hosting**: Cloudflare Workers (**Free plan is sufficient**; Paid optional headroom — Phase-0 D-01); the Cloudflare primitive map (Workers / DOs / Queues+DLQ / Workflows / Cron / D1 / KV / R2) and the MCP connectivity contract (Google OAuth2 least-privilege, GitHub App, local Obsidian bridge) are fixed by SPEC §7 / docs/06.
- **Scheduling**: Cron Triggers are UTC-only with no DST; owner-local §10 times are hand-translated to UTC and re-derived at each EST/EDT boundary (D1). The morning chain is strictly sequential (start-after-success); Steward writes are serialized regardless of concurrent firings.

## Key Decisions

<!-- Recorded as "decided, not locked" (no ADRs in corpus). Source: docs/13-build-plan.md §6.3 decision log D1-D7. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| **D1 — UTC crons + EST/EDT translation table** (hand-edited at the two DST boundaries; internal budgets use `step.sleepUntil` with a tz-correct `Intl` zone) | Cloudflare Cron Triggers are UTC-only with no DST; explicit translation is the only correct option | — Decided |
| **D2 — D1 is system-of-record; the Vault is a rendered view** (Fri 16:30 build re-derives counters from D1, overwrites drift, emits a P3 `counter_drift` flag; owner content notes left alone) | Pillars 4 + 1: a hand-edited counter makes replays/double-counts unresolvable | — Decided |
| **D3 — Raw Echo audio expires at 7 days** (R2 lifecycle on `audio/raw/` prefix only; `transcripts/`/`exports/` persist; raw uploaded via presigned URL direct from the daemon, never proxied through a Worker) | Satisfies the §12 privacy boundary mechanically; the prefix split guarantees the expire rule can't touch a transcript | — Decided |
| **D4 — OAuth-bearer outbound-only local-daemon transport** (confidential client via Workers OAuth Provider; no inbound port; heartbeat per poll, stale > grace → P1 Critical trust 100) | Reuses outbound auth Echo/Quill already need, avoids laptop cert lifecycle, keeps "no inbound port" invariant; a dead daemon = a stale fleet-critical dashboard | — Decided |
| **D5 — Claude via AI Gateway, per-codename KV model tiering, two cost-domain gateways** (Opus: Atlas/Compass/Archivist; Sonnet: Forge/Herald/Scout/Headhunter-full; Haiku: Filer/Headhunter-light; `atlas-reasoning` + `atlas-highvolume` gateways; Workers AI only as Filer's outage fallback) | Per-gateway is the only place CF enforces a hard budget; isolating the always-on Filer path keeps it affordable; a degraded plan is worse than a failed-and-resumed step | — Decided |
| **D6 — Quill stays in Phase 3 (M5) with NO Echo dependency** (ships once the local outbound-auth runtime is proven, before the outward phase) | Quill needs the same local macOS daemon + outbound-auth plumbing as Echo, so co-locating amortizes the one-time runtime cost; it's convenience, not outward-risk | — Decided |
| **D7 — Switchboard is a design-time habit, not a deployed Worker** (M7 is a doc/process milestone, consulted ad hoc; does not run in the loop) | The roster already marks it "design-time only"; building a Worker for a thing that never fires in production is pure overhead | — Decided |

---
*Last updated: 2026-06-09 — META (Phase 5) verified complete (13/13 must-haves): Librarian (the 16th and final fleet agent, prompt library → Vault `Prompts/` via Steward) + Switchboard (design-time registry + `/switchboard` command + runbook, NOT a Worker). Code review caught + fixed 1 critical (date-granular bump key) + 12 warnings before sign-off. **All 6 phases of milestone v1.0 are now code-complete.** Remaining work is entirely owner go-live gates (OAuth round-trips, Secrets Store seed, Obsidian bridge, AI-Gateway ceilings, GitHub App grant) + accumulated human-UAT items. Scope/decisions unchanged. Original bootstrap: 2026-06-01 (new-project-from-ingest).*
