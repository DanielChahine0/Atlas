# Phase 2: Weekly Value - Context

**Gathered:** 2026-06-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Add **weekly-cadence value** and a **fleet-reliability layer** on top of the proven Phase-1 morning loop — reusing the same plumbing (the Wire, Steward, D1/KV, AI Gateway, OAuth, Filer's labels). Scope (fixed by ROADMAP.md → Phase 2 / build-plan §4):

```
Scout (Fri 16:00)  ─┐
weekly-Herald (Fri 16:00) ─┴─ Promise.all ─▶ Steward ─▶ 16:30 weekly-review build
Headhunter (Mon 09:00 full · daily-light 09:00) ─▶ Forge (apply-by tasks) + Steward (funnel)
Flagger (event-driven) ◀─ atlas-incidents queue ◀─ every agent's incidents + heartbeats
   └─▶ atlas-wire ─▶ Steward (Flagger board)  +  ntfy push (P1/P2)
Flagger watchdog (separate Cron Worker) ─▶ self-P1 if Flagger goes quiet
```

- **Scout (#6)** — weekly events digest (Fri 16:00); read-and-summarize, never registers. `upsert` per surfaced event to Steward; registration hand-off to Usher is **Phase 4** (out of scope here).
- **Headhunter (#8)** — hiring-window + deadline tracker. `full` (Mon 09:00) scans boards; `deadlines` (daily-light 09:00) promotes closing windows. **Emits `apply by <date>` tasks to Forge** (never writes them itself) + job-pipeline funnel counters to Steward. Per-company window model in D1 + `HeadhunterState` DO.
- **Flagger (#15)** — event-driven incident pipeline: derive dedupe signature → deterministic severity (P1–P4) + trust (0–100) → route (P1/P2 push, P3/P4 batch) → emit canonical `op:"upsert"`/`entity:"flag"` to Steward. `FlaggerState` DO holds live flag state + the open→ack→resolved→muted lifecycle. **Self-monitors** fleet + own heartbeat.
- **weekly-Herald** — Herald gains a **weekly mode** (deferred from Phase 1 by D1-02), drafting a Friday "week-in-review" email + a digest event for the 16:30 build.

**Cross-cutting retrofit (in-scope per build-plan §4):** every Phase 0/1 agent must start emitting **incident + heartbeat events**, and the existing `flag()` helper is **reworked** to enqueue a raw incident onto the new `atlas-incidents` queue instead of emitting a finished flag straight to `atlas-wire`.

**Locked requirements:** WEEKLY-01 (Scout + Headhunter), WEEKLY-02 (Flagger) — see `.planning/REQUIREMENTS.md`. The decisions below settle **how** to build, not **what** — scope is fixed by ROADMAP.md. **Nothing in this phase is destructive or outward-facing** — still read / track / observe.

**Gating criteria (must pass before Phase 3):** Flagger self-watchdog fires in a kill test (Flagger dead → external P1); replaying a Headhunter scan leaves pipeline counts unchanged (idempotency holds under new producers); **≥70% of flags actionable** (vs muted) on the noise bar.

</domain>

<decisions>
## Implementation Decisions

### Push & alert delivery (Flagger's output side)
- **D2-01: Push channel = ntfy.sh.** P1/P2 flags push via a single HTTPS POST from the Flagger Worker to a secret ntfy topic; the iOS/Android app subscribes. Cloudflare-native fit, no SDK, one secret to seed (topic + optional auth token; self-hostable later). Rejected: Pushover ($5, heavier), Telegram (chat app, no native priority/escalation).
- **D2-02: Ack via an ntfy action button → token-gated Flagger HTTP endpoint.** The Obsidian bridge is **outbound-only** (Steward → Vault), so a board edit cannot ack back to the cloud. The push carries an "Ack" action that POSTs to a small **authenticated inbound route on Flagger** (the only inbound surface), flipping the flag to `ack` in `FlaggerState` and stopping re-push. Un-ack'd P1 re-pushes every `escalation_window` (default 15m); deterministic recovery still auto-resolves; LLM-judgment flags always wait for an owner decision.
- **D2-03: Push is flag-gated; the Vault board is the fallback.** Push lives behind `CONFIG flagger.push_enabled` (default **false** until the ntfy topic + auth token are seeded). **Seeding ntfy creds + enabling the flag is a Phase-2 go-live gate** (mirrors `filer.push_enabled` / the AI-Gateway ceilings). If the ntfy POST fails, the flag still lands on the Vault board via Steward — **no second push channel** in Phase 2.

### Flagger internals & the flag() rework
- **D2-04: New `atlas-incidents` queue — Flagger is its sole consumer; it fans into `atlas-wire`.** Agents fire **raw incidents fire-and-forget** onto `atlas-incidents` (never block — the morning chain must never wait on its own monitor). Flagger scores/dedupes/routes/pushes and **emits the canonical `type:"flag"` upsert onto `atlas-wire`**, where **Steward (still the sole `atlas-wire` consumer)** writes the board. This preserves Pillar 1 (a second `atlas-wire` consumer is a hard CI failure) and the decoupling the spec requires. Rejected: Steward-invoked RPC enrichment (couples the sole writer + puts push I/O in Steward's serial loop); RPC-from-emitters (every agent would hard-depend on Flagger being up).
- **D2-05: Rework `flag()` to enqueue an incident, not a finished flag.** `packages/shared/src/flag.ts` currently builds the full `FlagRecord` (with `DEFAULT_TRUST`) and emits `op:"upsert"`/`entity:"flag"` directly to `atlas-wire`. It is reworked to enqueue a raw incident `{ source_agent, kind, severity_hint, title, detail, run_id }` onto `atlas-incidents`. **Every existing caller is migrated** — `dlq-sink`, `@atlas/model` APIError, Steward's malformed-event path, and the five morning agents. (`dlq-sink` is the Phase-0 stand-in for exactly this incident→flag flow.)
- **D2-06: Emitter hints severity + kind; Flagger owns final severity and ALL trust.** Call sites pass a `severity_hint` + a `kind` tag (minimal churn). Flagger applies KV `severity_overrides` for the final severity and is the **sole authority on trust**: evidence-based base bands (caught exception 90–100, stale heartbeat 100, counter check 75–90, LLM hunch 20–45) + recurrence bump + corroboration/degraded-source adjustments, **re-scored as a signature recurs**. Severity stays deterministic (never the LLM).
- **D2-07: Heartbeats ride `atlas-incidents`; `FlaggerState` DO alarms detect misses; grace = 10m.** Scheduled agents emit a `kind:"heartbeat"` incident tied to their schedule slot; Flagger updates last-seen in `FlaggerState` and **arms a DO alarm per expected slot + grace**. A miss → stale-heartbeat **P1, trust 100**. `heartbeat_grace` KV default **10m** (doc default; KV-overridable to 5m for critical slots). Resolves the open owner-judgment call (was "5 min").
- **D2-08: A separate Cron watchdog Worker catches Flagger's own death.** Distinct Worker (own `wrangler.jsonc`, single cron) reads Flagger's `last_seen` from KV; quiet past `selfwatch_threshold` (default 15m) → push a self-P1 + Steward self-flag. The one alert path that doesn't depend on the thing it alerts about.

### Scout + Friday weekly cadence
- **D2-09: Scout v1 = RSS/fetch + Gmail newsletters; browser scraping deferred.** Sources: RSS feeds, plain-HTML/JSON listings, and Gmail `Type/Newsletter` + `Type/Events`/`Events/Invite` threads (already labeled by Filer — reuses Phase-1 plumbing). **No Playwright / Browser Rendering in Phase 2.** JS-rendered listings (Luma/Eventbrite/Meetup that need a rendered DOM) are a deferred follow-up. Lowest ToS/flake risk; never follows links from email sources; never reads `Type/Security` / `⚠ Phishing-Suspect` (§5.8).
- **D2-10: weekly-Herald = a week-in-review retrospective.** Herald's new weekly mode drafts a Friday review over the 7-day window — action-required still open, waiting-on, VIP threads, items that slipped — **draft-only** (`gmail.compose`, no send; same redaction guardrails as daily) **+ a digest event feeding the 16:30 weekly-review Vault build**. Required by WEEKLY-01 success criterion 1 (a "weekly email review" must land). Rejected: a mere week-windowed daily digest (not a distinct artifact); skipping it (fails the criterion).
- **D2-11: Friday concurrency is build-plan-locked.** One cron at Fri 16:00 ET — **EDT `"0 20 * * 5"`** (active June 2026, UTC-4) / EST `"0 21 * * 5"` (build-plan §1.3 canonical, UTC-5) — runs Scout-weekly **and** weekly-Herald via **`Promise.allSettled`** (disjoint sources, both fan into Steward; `allSettled` so one branch's failure never discards the other's completed result — reconciled to RESEARCH Pitfall 7, supersedes the original `Promise.all` wording); the 16:30 build fires at **EDT `"30 20 * * 5"`** / EST `"30 21 * * 5"`. These are **standalone crons in Atlas's `scheduled()` switch — NOT the morning Workflow**, carried as dual EDT/EST cases in the switch (UTC/DST hand-edit per D1; `/cron-utc` to translate.)
- **D2-12: Interest/fit signal = Codex skills/projects + a KV keyword list.** Scout's relevance filter and Headhunter's fit ranking both score topic-match against the **Codex `skills` + `projects`** (read-only, already populated) plus a small owner-curated KV list (`scout/interests`, `headhunter/targets`); location from Codex `addresses`. **No Codex schema change** (the §11 sections have no "interests" field, and the Codex is otherwise frozen); tunable without redeploy; profile facts stay in the single-source-of-truth Codex.

### Headhunter watchlist & pipeline truth
- **D2-13: The funnel is driven by Filer's `Type/Job` threads, with Headhunter as the single emitter.** Headhunter reads Filer-labeled `Type/Job` threads (inbound email = ground truth), classifies the stage (application sent / OA / interview / offer / reject), and emits the funnel increment to Steward **deduped by `(thread, stage)`**. Single emitter = **no double-count** (resolves the spec's open question); the emitter is Headhunter (matches the roadmap attribution); evidence is real inbound mail, not a task the owner remembered to mark. Headhunter separately owns the **window model + apply-by tasks (via Forge) + the tracked-windows count**.
- **D2-14: Urgency bypasses the fit floor.** Any window inside lead-time (default 21d) or a posting with an explicit deadline **always surfaces + tasks even below `fit_floor` (0.4)** — nothing time-critical is hidden by a fit score; only the non-urgent shortlist stays fit-gated. Matches the core value ("zero missed deadlines"). **Low-confidence hiring-window DATES still route to a Flagger P3, never silently to a task** (build-plan §4) — so a bypass is not the same as trusting a shaky estimate.
- **D2-15: Watchlist/boards/cycle = KV config gate + a small starter seed.** The planner builds the hiring-window model + a small starter seed (a few well-known intern/new-grad programs + the `fall-2026` cycle label) so it runs out of the box; the **real list is owner-curated KV** (`headhunter/tracked_companies`, `/boards`, `/cycle`, `/rolling_companies`) **set before go-live — a Phase-2 config gate.** Tunable without redeploy.

### Claude's Discretion
Left to research/planning, constrained by canonical refs + `CLAUDE.md` pins:
- The exact `atlas-incidents` queue config (`max_batch_size`/`max_concurrency`/DLQ — likely its own DLQ or reuse `atlas-wire-dlq`), the incident event schema, and the `FlaggerState` DO shape (open-flags-by-signature, alarm scheduling).
- Cascade grouping (collapse a Sundial→Compass cascade into one parent flag via shared `run_id`) and auto-resolve scope (deterministic recoveries only; LLM-judgment flags always need an owner).
- Mute-rule / `severity_override` KV shapes; the `≥70%-actionable` instrumentation mechanism.
- Scout KV knobs (`min_relevance` 55, `dedupe_window_weeks` 4, `max_per_digest` 15, sparse-week "fill to N" relaxation, optional Calendar conflict pre-check), digest format, the `Event` D1 record.
- Headhunter window status state-machine (`upcoming→open→closing→closed`), `last_seen_open` advancement, `lead_time_days`/`push_threshold_days`, the seen-store fingerprint, model tiering (Headhunter-full → Sonnet, board-scan → Haiku).
- Whether the per-Worker cron cap / Free-plan limits need the optional Paid upgrade once Scout/Headhunter/Flagger crons are added (verify before deploy).
- GitHub MCP read-only `Type/Dev` repo signals for Headhunter/Forge ranking (build-plan lists it; optional, gated on the GitHub App owner-gate from Phase 0).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Authoritative design (wins all conflicts)
- `docs/SPEC-CANON.md` — §8 (Flagger: severity/trust/routing/lifecycle), §6.4 (Wire event contract), §4 (agent dependencies: Headhunter→Forge, single-writer), §10 (scheduling), §6.2/§6.3 (dashboard views, weekly-review build). If two docs disagree, this wins.

### How to build Phase 2 (primary build guide)
- `docs/13-build-plan.md` §4 — Phase 2 sequencing: the three agents' deliverables/files/acceptance, the standalone-cron + Friday-parallel model, the separate watchdog Worker, the **hard dependencies** (Forge must exist; Steward fan-in; retrofit incident+heartbeat emits into Phase 0/1 agents) and the **gating criteria** (self-watchdog kill test, idempotent re-scan, ≥70% actionable). **The primary reference.**
- `docs/13-build-plan.md` §1.3 (crons), §1 (AI-Gateway/GitHub-App prereqs) — the cron lines `0 14 * * *`, `0 14 * * 1`, `0 21 * * 5`, `30 21 * * 5` and the Friday `Promise.all` case.

### Per-agent specs (Phase 2)
- `docs/agents/scout.md` — event discovery; sources table; interest filter; digest format; **Usher hand-off is Phase 4**; failure modes; the open questions (newsletter precision, recurring-event dedupe, sparse-week relaxation).
- `docs/agents/headhunter.md` — hiring-window model (D1); `full`/`deadlines` modes; dedupe fingerprint; Codex fit ranking; **the applied-state open question resolved → D2-13**; the fit-floor open question resolved → D2-14; config knobs.
- `docs/agents/flagger.md` — flag lifecycle (derive→dedupe→route); severity (P1–P4) + trust (0–100) bands; the flag shape; routing; the Vault Flagger board; **self-monitoring + externalized watchdog**; config knobs.
- `docs/08-flagger.md` — chapter-level Flagger reference (keep consistent with the agent spec).
- `docs/agents/herald.md` — Herald's **weekly mode** (the "draft vs Vault-glance" + daily/weekly split; weekly resolved → D2-10).

### Substrate / cross-cutting
- `docs/03-scheduling.md` — the schedule table, **Friday parallel-concurrency model**, heartbeat expectations + grace, the EST/EDT cron-translation table (UTC-only, no DST), `step.sleepUntil`.
- `docs/05-dashboard.md` — the **Flagger feed** (sorted severity then trust desc), **Job pipeline kanban / Jobs funnel**, **Upcoming events (7-day)** view, the 16:30 weekly-review build that Steward compiles.
- `docs/07-source-of-truth-codex.md` — the §11 Codex sections (skills/projects/addresses for Scout relevance + Headhunter fit); read-only to agents (D2-12 avoids a schema change).
- `docs/04-email-taxonomy.md` — `Type/Newsletter`/`Type/Events`/`Events/Invite` (Scout sources), `Type/Job`/`Job/*` (Headhunter funnel evidence), §5.8 never-follow-links / no-security-mail.
- `docs/02-architecture.md` — the Wire, single-writer model (Steward stays the sole `atlas-wire` consumer; Flagger consumes a **new** `atlas-incidents` queue and produces onto `atlas-wire`).
- `docs/11-security-privacy.md` — Scout/Headhunter read-only scopes, Codex read-only, no link-following, secrets only via bindings (the ntfy token is a Secrets Store / `wrangler secret` value, never in `[vars]`/KV/Vault).
- `docs/06-hosting-cloudflare-mcp.md` — the separate-Worker pattern for the Flagger watchdog; Browser Rendering note (deferred per D2-09); Connect-a-new-MCP checklist (GitHub MCP read-only).

### Project state & conventions
- `.planning/REQUIREMENTS.md` — WEEKLY-01, WEEKLY-02 (locked requirements + acceptance). MUST read before planning.
- `.planning/phases/01-core-loop-morning-pipeline/01-CONTEXT.md` — Phase-1 decisions carried forward (D1-02 deferred weekly-Herald → now in scope; D1-05 Opus effort tiering; structured idempotency keys; the morning chain Flagger emits Phase 2 retrofits).
- `.planning/phases/00-spine/00-CONTEXT.md` — Phase-0 decisions (D-05 one-Worker-per-agent, D-06 UTC crons, D-11 service-binding RPC, the canonical `op:"upsert"`/`entity:"flag"`/`idempotencyKey===flag.id` Flagger event reconciliation).
- `CLAUDE.md` — pins (`agents ^0.14.x`, MCP SDK `1.29.0`), canonical binding names (`WIRE`/`DB`/`CONFIG`/`AI`), structured idempotency keys, the §6.4 Wire contract, model tiering (Scout→Sonnet, Headhunter-full→Sonnet, board-scan→Haiku), gotchas (TZ=UTC, D1 positional `?`, missed crons not auto-replayed).
- `packages/shared/src/flag.ts` — the **existing `flag()` helper being reworked** (D2-05); its current callers are the migration surface.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (Phase 0/1 — built, code-complete, 315 tests green)
- **`packages/wire`** — the single §6.4 `WireEvent` zod schema + `send()` producer. Scout/Headhunter/Flagger all import it; the new `atlas-incidents` events reuse the same producer pattern (likely a sibling `INCIDENTS` binding).
- **`packages/shared/src/flag.ts`** — `flag()` + `FlagRecord` + `localDate()` + the djb2 `contentHash` (stable structured ids). **Reworked this phase** (D2-05) from "emit finished flag to `atlas-wire`" → "enqueue raw incident to `atlas-incidents`"; `FlagRecord` becomes Flagger's output shape, not the emit shape.
- **`apps/dlq-sink`** — the Phase-0 minimal "dead Wire event → Flagger incident" sink; it's the prototype for the real incident→flag flow and a migration target (it currently calls `flag()` to emit a finished flag).
- **`apps/steward` + `packages/steward-core`** — sole `atlas-wire` consumer + sole Vault writer; consumes Flagger's `op:"upsert"`/`entity:"flag"` and Scout/Headhunter `upsert`/`increment` events **unchanged** (idempotent dedup + counter/upsert + `vault_outbox` already proven). No Steward changes needed for the queue topology (D2-04 keeps Steward on `atlas-wire` only).
- **`packages/model`** — `claudeFor(agent,env)`; Scout→Sonnet, Headhunter-full→Sonnet, board-scan→Haiku resolve here via KV tiering; a non-2xx APIError already calls `flag()` (a migration site).
- **`packages/codex`** — read-only Codex reader; Scout (interests) + Headhunter (fit) read `skills`/`projects`/`addresses` (D2-12).
- **`packages/tasks`** — Forge's D1 `tasks`/`subtasks` store with `idx_tasks_dedupe`; **Headhunter emits apply-by tasks through Forge's path** (not a new store) — the dedupe/merge + `locked_by_owner` short-circuit already exist.
- **`apps/filer`** — labels `Type/Newsletter`/`Type/Events` (Scout sources) and `Type/Job`/`Job/*` (Headhunter funnel evidence, D2-13). Phase-2 retrofit: Filer must emit incident + heartbeat events; confirm/extend the `Job/*` sub-states needed for stage classification.
- **`apps/atlas`** — the `scheduled()` cron dispatcher (switch on cron string). Phase 2 **adds the standalone cron cases** (`0 14 * * *`, `0 14 * * 1`, `0 21 * * 5`, `30 21 * * 5`) — NOT new Workflow steps.
- **`apps/herald`** — daily digest, draft-only with redaction guardrail + deterministic bucketing. Phase 2 **adds weekly mode** (D2-10) reusing the draft + redaction path.

### Established Patterns (must conform)
- **Pillar 1 — one `atlas-wire` consumer (Steward).** The new `atlas-incidents` queue + Flagger consumer is allowed (different resource); a second `atlas-wire` consumer is a hard CI failure (`.claude/hooks/guard-wire-consumer.js`).
- **Structured, stable idempotency keys** — `scout:evt_<id>`, `headhunter:role:<fingerprint>` / `headhunter:window:<company>:<cycle>`, the flag `id` (`flg:<date>:<agent>:<hash>`). NEVER `crypto.randomUUID()` for scheduled work; replay through Steward leaves counters unchanged (`meta.changes === 0`).
- **Owner-local date via `Intl`** (`America/Toronto`), never `new Date()` (workerd TZ=UTC). UTC-only crons, hand-edited at DST (D1).
- **Definition of Done per agent PR** (CLAUDE.md): a Wire-contract test (shape + structured key), a replay test through Steward (`meta.changes === 0`), and a failure-path test asserting the right Flagger severity.
- **Suggest-don't-destroy** — Scout never registers; Headhunter never applies; Flagger never auto-remediates. All Phase-2 agents are read/track/observe.

### Integration Points (NEW code this phase)
- **New apps**: `apps/scout`, `apps/headhunter` (+ `HeadhunterState` DO + D1 `windows`/`jobs` tables), `apps/flagger` (+ `FlaggerState` DO), `apps/flagger-watchdog` (separate Worker, own cron).
- **New queue**: `atlas-incidents` (Flagger sole consumer) + producer binding on every agent; `flag()` reworked to target it.
- **New inbound route**: the token-gated Flagger **ack endpoint** (D2-02) — the only inbound surface in Phase 2.
- **New secret**: the ntfy topic + auth token (Secrets Store / `wrangler secret`, never `[vars]`/KV).
- **Retrofit**: incident + heartbeat emits into every Phase 0/1 agent; migrate all `flag()` callers; Herald weekly mode; Filer `Job/*` stage signals for the funnel.

</code_context>

<specifics>
## Specific Ideas

- The **outbound-only bridge** is the reason ack needs its own inbound endpoint (D2-02) — a board edit physically cannot reach the cloud. Planning must not assume a Vault→cloud path exists.
- **Owner go-live config gates for Phase 2** (mirror the Phase-1 gate discipline; cannot be set from code): seed the **ntfy topic + auth token** and flip `flagger.push_enabled` (D2-03); seed the **Headhunter watchlist/boards/cycle KV** (D2-15); optionally seed `scout/sources` + `scout/interests` / `headhunter/targets`.
- **Headhunter's funnel evidence is inbound email, not task-completion** (D2-13) — the owner shouldn't have to mark tasks for the kanban to be right; reality (the OA invite landing in the inbox) drives it.
- **Nothing time-critical is ever hidden by a fit score** (D2-14) — the owner's hard constraint is missed deadlines, so urgency overrides taste, while shaky dates still surface as a P3 to glance at rather than a silent task.

</specifics>

<deferred>
## Deferred Ideas

- **JS-rendered event scraping** (Luma/Eventbrite/Meetup via Cloudflare Browser Rendering / Playwright MCP) — deferred from Scout v1 (D2-09); revisit if newsletters/RSS leave meaningful coverage gaps. Adds Browser Rendering infra + ToS/captcha handling.
- **Scout → Usher registration hand-off** — Usher is **Phase 4** (gated, irreversible). Scout only surfaces + suggests in Phase 2.
- **A second push fallback channel** for Flagger (backup ntfy topic / email) — Phase 2 uses the Vault board as the only fallback (D2-03).
- **A Codex "interests" section** + its write flow — using a KV keyword list instead this phase (D2-12); revisit if the KV list proves insufficient.
- **GitHub MCP read-only `Type/Dev` repo signals** for Headhunter/Forge ranking — listed in build-plan §4 but optional and gated on the Phase-0 GitHub-App owner-gate; can land later in the phase or after.
- **Optional Workers Paid upgrade** — only if the added Scout/Headhunter/Flagger crons exceed the Free per-Worker cron cap; verify at deploy.

None of the above block Phase 2. Discussion stayed within phase scope (Usher/Browser-Rendering redirects captured here, not acted on).

</deferred>

---

*Phase: 2-Weekly Value*
*Context gathered: 2026-06-05*
