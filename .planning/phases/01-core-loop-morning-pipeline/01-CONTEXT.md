# Phase 1: Core Loop / Morning Pipeline - Context

**Gathered:** 2026-06-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver the flagship **morning pipeline** the owner sees every day — turning the Phase-0 spine into the thing that pays for itself every morning. Scope (fixed by ROADMAP.md):

```
Filer (07:45 sweep) ─▶ Herald (08:00) ─▶ Forge (08:15) ─▶ Sundial (08:20) ─▶ Compass (08:30)
   labels                draft digest       tasks            calendar          day plan
```

- **ONE cron at 07:45 kicks ONE Cloudflare Workflow (`MorningChain`)** with five `await`ed steps — NOT five racing crons. Cron is the *WHEN*; the Workflow is the durably-sequenced *HOW*. Per-agent clock times become `step.sleepUntil` budget gates, not separate triggers. `instance.id = morning-${date}` is the idempotency handle (re-fire = no-op).
- **Filer (#2)** — Gmail labeler, `gmail.modify` ONLY (labels, never delete). Sweep step + continuous push path + 06:00 watch-renewal cron. Emits `filer:sweep:<date>`.
- **Herald (#1)** — daily email digest, **read + draft only** (`gmail.readonly` + `gmail.compose`, no send, no modify). Emits `herald:daily:<date>`.
- **Forge (#3)** — task/subtask extractor → D1 rows (system-of-record, NOT KV). Emits per-task events keyed on task id.
- **Sundial (#4)** — task → Google Calendar deadline blocks (`calendar.events`, NO delete). Emits `sundial-<date>`.
- **Compass (#5)** — daily planner (last stage), `calendar.readonly` + D1 read; never writes the calendar. Emits `compass:plan:<date>`.

Each stage is a **stateless Worker pass** invoked as a Workflow step; it does its domain work, emits one Wire event to Steward, and returns its output as the next step's input. **Phase 1 adds NO new Vault writer** — Steward (Phase 0) stays the sole `atlas-wire` consumer and sole Vault writer.

**Locked requirements:** CORE-01, FILER-01, HERALD-01, FORGE-01, SUNDIAL-01, COMPASS-01 (see `.planning/REQUIREMENTS.md`). The decisions below settle **how** to build, not **what** — scope is fixed by ROADMAP.md.

**The crux to nail:** the Workflow's start-after-success + memoized resume + halt-downstream behavior. A forced Forge failure must leave Filer's labels + Herald's draft intact, halt before Sundial/Compass, emit one `chain.halted` P2 to Flagger, and a same-date re-fire must be a complete no-op (killing mid-`forge-morning` resumes at Forge; Filer/Herald are memoized, not re-run).

</domain>

<decisions>
## Implementation Decisions

### Herald output surface
- **D1-01:** **Keep the Gmail draft digest (build-plan v1).** Herald's 08:00 daily output is a Gmail draft to `chahinedaniel0@gmail.com` (never sent) **plus** the `digest` Wire event that feeds the Vault morning-glance. The inbox is where the owner already triages; the draft is harmless (no send scope). Do NOT go Vault-glance-only and do NOT build a second full Vault digest note beyond the glance.
- **D1-02:** **Daily digest runs every weekday (Mon–Fri) unconditionally.** No Friday special-casing. The 16:00 Friday weekly review is a separate **Phase-2** agent and is additive, not a replacement — Phase 1 ships before the weekly even exists, so a "suppress daily on Friday" branch would reference a non-existent output.

### Measurement commitments (make headline metrics falsifiable)
- **D1-03:** **One-week pre-launch baseline — committed.** The owner will log current inbox-triage + day-planning minutes for ~5 working days **before** flipping the morning chain live. This is the ground truth for the "time saved" headline metric. Planning should produce a lightweight capture mechanism / checklist artifact and treat "baseline captured" as a go-live gate (per build-plan §6.2 — required before M1 go-live).
- **D1-04:** **Daily ~1-min "did Atlas miss anything?" review — committed.** Each morning during the glance, the owner confirms Atlas caught the real action-required items and logs any miss. This is the ground truth for the **≥95% action-required-caught** metric and the early-warning signal for Filer/Herald misclassification. Planning should make logging a miss frictionless (a Vault affordance in the morning glance).

### Cost guardrails
- **D1-05:** **Compass Opus `effort` = `medium`, KV-overridable.** `claude-opus-4-8` defaults `effort` to `high`; for the once-daily, largely-deterministic plan synthesis (deadline scoring + free/busy bin-packing + overcommit detection) `medium` is the standing default. Surface as KV key `compass.effort` (re-tunable without redeploy, NOT hardcoded) so a hard/overcommitted day can be bumped up. Never ship `high` as the default daily pass.
- **D1-06:** **Conservative AI Gateway starter ceilings, set before Filer's continuous push goes live.** There is no per-agent hard-budget primitive — only per-gateway. Recommended starter ceilings to set in the Cloudflare dashboard (tunable after real volume is observed): **`atlas-reasoning` ≈ $20/mo**, **`atlas-highvolume` ≈ $10/mo**. This is a **go-live checklist item / owner action** (the dashboard caps cannot be set from code) — treat "gateway ceilings set" as a gate before Filer's push path is enabled. The continuous-push path (Filer task #2) must NOT go live until the caps exist.

### Success-metric window
- **D1-07:** **Morning-chain success-rate = rolling 30 days.** The ≥99% target is measured over the trailing 30 days (standard SRE-style window): reflects current reliability, ages out early-launch hiccups, stays sensitive to recent regressions. Not since-launch cumulative.

### Claude's Discretion
Per-agent technical implementation is left to research/planning, constrained by the canonical refs and `CLAUDE.md` pins:
- Exact retry/timeout per step (build-plan §3 gives a starting policy: Filer `limit:5`, others `limit:3`, all `timeout:10m`; all KV-overridable).
- `invokeAgent` step return shapes (transport already locked to service-binding RPC by Phase-0 **D-11**).
- D1 schema for `tasks`/`subtasks` (new migration this phase — `idx_tasks_dedupe` unique index on `sha256(thread+normalizedTitle+dueDate)`), Forge dedupe/merge logic, Sundial `extendedProperties.private` stamp shape, Compass scoring weights / free-busy grid params (`meeting_buffer_min`, `min_block_min`).
- Exact OAuth scope strings, label-taxonomy bootstrap diff logic, `step.sleepUntil` `localTime()` helper.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Authoritative design (wins all conflicts)
- `docs/SPEC-CANON.md` — the authoritative spec; §0 pillars, §6.3 morning-glance set, §6.4 Wire event contract, §5.8/§12 security redaction. If two docs disagree, this wins.

### How to build Phase 1 (task-level — primary build guide)
- `docs/13-build-plan.md` §3 — Phase 1 Core Loop task-level breakdown: per-agent ordered tasks + acceptance criteria for Filer / Herald / Forge / Sundial / Compass, the Morning Workflow wiring (cron → Workflow → 5 steps), the emit-to-Steward table, and the whole-chain Phase-1 acceptance. **The primary reference.**
- `docs/13-build-plan.md` §6.2 — success-metrics instrumentation (the headline three, the one-week pre-launch baseline gate — D1-03).
- `docs/13-build-plan.md` §7 (Phase 1 / §3 subsection) — the owner-judgment calls settled in this CONTEXT (D1-01…D1-07).

### Per-agent specs (Phase 1)
- `docs/agents/filer.md` — Gmail labeler contract; `gmail.modify`-only boundary; label-taxonomy bootstrap; idempotent `AI/Reviewed` cursor; phishing/2FA handling.
- `docs/agents/herald.md` — daily digest contract; five owner-requested sections; draft-only; security redaction; the "draft vs Vault-glance" open question (resolved → D1-01).
- `docs/agents/forge.md` — task/subtask extraction; deadline inference; D1 dedupe/merge; security skip.
- `docs/agents/sundial.md` — calendar deadline-marker sync; `calendar.events` no-delete; `atlasTaskId` reconcile; insert-race guard.
- `docs/agents/compass.md` — daily planner; `calendar.readonly`; overcommitment "Couldn't fit today"; Opus `effort` tuning (resolved → D1-05).

### Substrate / cross-cutting
- `docs/04-email-taxonomy.md` — the label taxonomy Filer applies and Herald/Forge consume (triage tiers, `Needs/*`, `Due/*`, `Type/Security`, `⚠ Phishing-Suspect`).
- `docs/05-dashboard.md` — Vault layout: Today view, morning-glance set, Deadline board, Upcoming-7d view that Steward renders from these agents' events.
- `docs/03-scheduling.md` — schedule, concurrency, failure modes; the EST/EDT cron translation table (written in Phase 0 per D-07); `step.sleepUntil` DST-safe budget gates.
- `docs/11-security-privacy.md` — OAuth least-privilege scopes per agent; the non-negotiable 2FA/reset-link/login-URL redaction (server-side at Google-MCP + Herald digest-builder guardrail + CI backstop).
- `docs/02-architecture.md` — data flow, the Wire, single-writer model (Steward stays sole consumer in Phase 1).

### Project state & conventions
- `.planning/REQUIREMENTS.md` — CORE-01, FILER-01, HERALD-01, FORGE-01, SUNDIAL-01, COMPASS-01 (locked requirements + acceptance). MUST read before planning.
- `.planning/phases/00-spine/00-CONTEXT.md` — Phase-0 decisions carried forward (D-05 one-Worker-per-agent, D-06 UTC crons, D-11 service-binding RPC transport, D-08 keep-idempotency-keys-forever).
- `CLAUDE.md` — pinned versions, canonical binding names (`WIRE`/`DB`/`CONFIG`/`AI`/`STEWARD_LOCK`), structured idempotency keys, the §6.4 Wire contract, gotchas (TZ=UTC, D1 positional `?`, `NonRetryableError` from `cloudflare:workflows`, `claude-opus-4-8` effort default).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (Phase 0 spine — all built, code-complete)
- **`packages/wire`** — the single §6.4 `WireEvent` zod schema (`contract.ts`) + `send.ts` producer helper. Every Phase-1 agent imports this to emit; do NOT redefine the schema.
- **`packages/model`** — `claudeFor(agent, env)` / `modelFor(agent, env)` route every Claude call through the AI Gateway (Anthropic endpoint) with per-codename KV→`[vars]`→CLAUDE.md tiering. Filer→Haiku, Herald/Forge→Sonnet, Compass→Opus resolve here. Compass `effort` (D1-05) plugs in via this path. A non-2xx APIError already emits a P3 flag.
- **`packages/steward-core`** — `op-mapping.ts` (the single op→Local-REST `SAFE_METHODS` map, PATCH/POST only, no DELETE) + `apply.ts`. Steward consumes Phase-1 events through this unchanged.
- **`packages/security`** — `redact()` (2FA codes / reset links / login URLs). Already wired into `mcp-google` `safeToolOutput()` on EVERY tool-output egress regardless of scope (SPINE-04). Herald's digest-builder guardrail (P2 block on output trip) reuses this.
- **`packages/codex`** — read-only Codex reader (`read`/`codexSystemBlock`) + `cache_control` ephemeral 1h system block. Herald (VIP/company ranking) and Compass (working-hours/focus prefs) read it.
- **`packages/shared`** — `flag.ts` (single flag-id authority, structured `flg:<date>:...` keys, no `crypto.randomUUID`), `runlog.ts`, `env.ts` Env types. Every Phase-1 agent emits flags/run-log rows through these.
- **`apps/atlas/src/index.ts`** — the `scheduled()` cron dispatcher (Phase 0 handles the no-op cron via a switch on the cron string). Phase 1 **adds the `case "45 11 * * 1-5"`** that creates the `MorningChain` instance with `id: morning-${date}`. The `MorningChain extends WorkflowEntrypoint` class lives here (or in `apps/atlas`), bound `MORNING_CHAIN`.
- **`apps/steward`** — the sole consumer/writer; consumes Filer/Herald/Forge/Sundial/Compass events with no changes (idempotent dedup + counter/upsert + `vault_outbox` enqueue already proven by SPINE-02 tests).
- **`apps/mcp-google`** — the Google MCP Worker; Phase 1 agents reach Gmail/Calendar tools through it. Per-agent scope floors enforced via `getMcpAuthContext().props.scopes` (403 fail-closed). NO delete/trash tool is registered (unreachable by construction, Pillar 2).

### Established Patterns (must conform)
- **Structured, stable idempotency keys** — `filer:sweep:<date>`, `herald:daily:<date>`, `<task id>` (Forge), `sundial-<date>`, `compass:plan:<date>`, `morning-${date}` (the Workflow instance id). NEVER `crypto.randomUUID()` for scheduled work.
- **Owner-local date via `Intl`**, never `new Date()` (workerd forces TZ=UTC): `Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto'}).format(new Date())`.
- **D1 positional `?` params only**; counters are absolute increment math inside Steward's atomic `batch()`; Forge's `tasks`/`subtasks` live in D1, never KV.
- **Definition of Done per agent PR** (CLAUDE.md): a Wire-contract test (shape + structured key), a replay test through Steward (`meta.changes === 0`), and a failure-path test asserting the right Flagger severity.

### Integration Points (NEW code this phase)
- **New apps**: `apps/filer`, `apps/herald`, `apps/forge`, `apps/sundial`, `apps/compass` (one Worker per agent, D-05) + `FilerCursor` and per-run DOs (`new_sqlite_classes`).
- **New migration**: `tasks` + `subtasks` tables with `idx_tasks_dedupe` unique index (Forge's system-of-record). Phase 0's `0001_init_core.sql` created the spine tables (ledger/counters/run_log/audit_log/vault_outbox); Forge adds the task store.
- **`MorningChain` Workflow** bound to the Atlas Worker (`MORNING_CHAIN`); the 07:45 cron is the only new trigger; halt → `chain.halted` P2 Flagger event.
- **Service-binding RPC** (`invokeAgent`, Phase-0 D-11) wires each step → its agent Worker; step return shapes fixed at build time.

</code_context>

<specifics>
## Specific Ideas

- The owner explicitly **commits to both measurement disciplines** (D1-03 one-week baseline + D1-04 daily ~1-min review) — these are real owner commitments, not aspirational. Planning should make both as frictionless as possible (a capture artifact for the baseline; a one-tap "missed" affordance in the morning glance).
- **Friday is deliberately un-special-cased** in Phase 1 (D1-02) — the owner prefers the simplest rule (daily every weekday); the weekly review is a clean Phase-2 addition.
- Starter gateway ceilings (`atlas-reasoning` ≈ $20/mo, `atlas-highvolume` ≈ $10/mo) are a **starting point to tune from real volume**, not a hard budget the owner is married to.

</specifics>

<deferred>
## Deferred Ideas

- **Herald weekly review (Fri 16:00) + the 16:30 weekly-review Steward build** — Phase 2 (WEEKLY). D1-02 keeps Phase 1 daily-only.
- **Filer continuous Gmail push + 06:00 watch-renewal cron** — in Phase-1 scope per build-plan §3, but gated on D1-06 (gateway ceilings set) before it goes live; the 07:45 sweep step is the chain-critical path and ships first.
- **AI Gateway ceiling exact tuning** — revisit after observing real morning-chain + push volume (D1-06 caps are starters).
- **Workflow-state retention >3 days** — only bites for confirm-gates waiting longer than Free's 3-day retention; a Phase-4 (Usher/Envoy) concern, not Phase 1.
- **Headhunter → Forge event-driven task creation** — Forge's event-driven path is Phase 2; Phase 1 Forge is the morning-chain step only.

None of the above block Phase 1. Discussion stayed within phase scope.

</deferred>

---

*Phase: 1-Core Loop / Morning Pipeline*
*Context gathered: 2026-06-05*
