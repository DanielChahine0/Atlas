# Roadmap: Atlas

## Overview

Atlas is built in the canonical 6-phase order from `docs/12-roadmap.md` (milestone map in `docs/13-build-plan.md` §6.1): stand up the **Spine** (Phase 0) so every agent has an orchestrator, an event bus, a single Vault writer, a source of truth, and OAuth; deliver the flagship **Core loop** morning pipeline (Phase 1) where ~80% of the daily value lives — together Phase 0 + Phase 1 are **the MVP**; add **Weekly value** agents that reuse the loop's plumbing and harden the fleet (Phase 2); cross into the first **local** runtime for audio/screen **Capture** behind a privacy boundary (Phase 3); ship the only **Outward**, irreversible agents last, behind a mature confirmation-gate UX (Phase 4); and finish with off-critical-path **Meta/polish** (Phase 5). The build order quarantines all blast-radius (Echo, Quill, Usher, Envoy) to the end; everything before it is read-only / suggest-don't-destroy.

> **Phase numbering.** GSD numbers phases as integers; this roadmap maps them 1:1 onto the canonical Atlas build phases — **GSD Phase N == Atlas Build Phase N == Milestone M(N)** for N=0..5 (Phase 2 spans M2–M3, Phase 3 spans M4–M5, Phase 4 = M6, Phase 5 spans M7–M8). The MVP spans Phase 0 + Phase 1.
>
> **Cross-references.** Phase 0 and Phase 1 have a task-level breakdown with acceptance criteria already written in `docs/13-build-plan.md` (§2 Spine, §3 Core loop). Per-agent specs live in `docs/agents/<codename>.md`. `docs/SPEC-CANON.md` is authoritative.
>
> **Hard ordering edges (cannot reorder):** Filer before Herald · Forge before Sundial · Forge + Calendar before Compass · Echo before Archivist · Headhunter feeds Forge · gate-UX maturity before Usher/Envoy.
> **Soft edges (sequencing choice, not data):** cloud (Phase 2) before local (Phase 3); outward (Phase 4) last.

## Phases

- [x] **Phase 0: Spine** - Infrastructure substrate (Atlas, the Wire, Steward + the Vault, the Codex, Cloudflare project, Google + GitHub OAuth); zero user-visible features. _[MVP]_ (completed 2026-06-05)
- [ ] **Phase 1: Core Loop / Morning Pipeline** - Strictly-sequential Filer → Herald → Forge → Sundial → Compass on one 07:45 cron via a Workflow, all feeding Steward → the Vault. _[MVP — the flagship]_
- [ ] **Phase 2: Weekly Value** - Scout (events), Headhunter (jobs, feeds Forge), Flagger (incident pipeline + self-watchdog).
- [ ] **Phase 3: Capture (Local)** - Echo (audio, local daemon) → Archivist; Quill (screen autofill). First non-cloud runtime; privacy boundary first.
- [ ] **Phase 4: Outward (Gated)** - Usher (gated registration), Envoy (gated public posts); confirmation-gate UX is the real work, gate hardest.
- [ ] **Phase 5: Meta / Polish** - Switchboard (design-time capability router), Librarian (prompt library).

## Phase Details

### Phase 0: Spine
**Maps to**: Atlas Build Phase 0 (Spine) · Milestone M0 · task-level breakdown in `docs/13-build-plan.md §2` (T0–T8) · per-agent specs `docs/agents/atlas.md`, `docs/agents/steward.md`
**Goal**: Stand up the infrastructure spine on which every agent runs — orchestration, the event bus, the single Vault writer, the source of truth, and OAuth — with Steward's serialization + idempotency correct from day 0. Ships zero user-visible features.
**Depends on**: Nothing (greenfield). The spine builds & deploys on the Workers **Free** plan (Queues GA-on-Free 2026-02-04, Workflows on Free, SQLite-backed DOs on Free) per D-01/D-02; Workers Paid is optional headroom only (e.g. a confirm-gate that must wait >3 days — a Phase-4 concern), not a hard prerequisite.
**Requirements**: SPINE-01, SPINE-02, SPINE-03, SPINE-04, SPINE-05
**Success Criteria** (what must be TRUE — "done =" from 12-roadmap Phase 0 / 13-build-plan §2):
  1. Atlas can schedule a no-op agent and route a message onto the Wire.
  2. Steward consumes one Wire event and applies it to the Vault per the §6.4 contract `{ agent, type, entity, op, payload, idempotencyKey }`, serialized single-consumer; applying the same `idempotencyKey` twice leaves the counter unchanged (`meta.changes === 0` on replay).
  3. The Codex exists with the §11 sections (identity, education, work, skills, projects, bios, socials), read-only to agents except the explicit "update my profile" flow.
  4. Google (least-privilege scopes) and GitHub (GitHub App) OAuth round-trips succeed; tokens live in Cloudflare Secrets Store, never in the Vault or Codex.
  5. The DLQ (`atlas-wire-dlq`) exists; an exhausted-retry message lands there, produces an audit row + a P2/P3 incident, and never silently buffers; the outbound-only Obsidian bridge drains Steward writes to the Vault.
**Plans**: TBD

### Phase 1: Core Loop / Morning Pipeline
**Maps to**: Atlas Build Phase 1 (Core loop / MVP) · Milestone M1 · task-level breakdown in `docs/13-build-plan.md §3` · per-agent specs `docs/agents/filer.md`, `herald.md`, `forge.md`, `sundial.md`, `compass.md`
**Goal**: Deliver the flagship morning pipeline the owner sees every day — a trustworthy digest, deadline-safe tasks on the calendar, and a day plan — as one strictly-sequential, resume-on-failure Workflow. Together with Phase 0 this is the MVP that pays for itself every morning.
**Depends on**: Phase 0 (all of it). Internal hard order (forced by data dependencies): Filer → Herald → Forge → Sundial → Compass.
**Requirements**: CORE-01, FILER-01, HERALD-01, FORGE-01, SUNDIAL-01, COMPASS-01
**Success Criteria** (what must be TRUE — "done =" from 12-roadmap Phase 1 / 13-build-plan §3):
  1. A real 08:00 digest lands as a draft to the owner — with ZERO 2FA codes / reset links ever surfaced (security invariant, server-side redaction + CI backstop).
  2. `① Action Required` threads become Forge tasks with deadlines (≥1 D1 task with a deadline; dedupe prevents duplicates on re-run).
  3. Deadline tasks appear as Google Calendar blocks (`agent=sundial` / `atlasTaskId` extendedProperty); a re-run creates no duplicate events.
  4. The Vault Today view renders Compass's top-3 plus the §6.3 morning-glance set (action-required emails, deadlines next 7 days, today's meetings, open flags, waiting-on).
  5. A forced Forge failure leaves Filer's labels + Herald's draft intact, halts before Sundial/Compass, and emits one `chain.halted` P2 to Flagger; re-firing the same date is a complete no-op (`instance.id = morning-${date}`); killing mid-`forge-morning` resumes at Forge (Filer/Herald memoized, not re-run).
**Plans**: 8 plans

**Wave 1** *(foundation — parallel, no file overlap)*
- [ ] 01-01-PLAN.md — Expand mcp-google with Herald/Forge/Sundial/Compass scope-floored tools (gmail.compose/readonly, calendar.events/readonly) + redaction egress
- [ ] 01-02-PLAN.md — D1 `tasks`/`subtasks` migration (`idx_tasks_dedupe`) + `@atlas/tasks` data-access (dedupe/merge)

**Wave 2** *(the five agents — parallel, each owns its own apps/ dir; blocked on Wave 1)*
- [ ] 01-03-PLAN.md — Filer: Gmail labeler (sweep + FilerCursor DO + push/renewal), labels-only, idempotent on AI/Reviewed, never surfaces 2FA/phishing
- [ ] 01-04-PLAN.md — Herald: daily draft digest (five sections, no Friday case), output-side redaction guardrail (leak → block draft + P2)
- [ ] 01-05-PLAN.md — Forge: task/subtask extractor → D1 (dedupe/merge in DO lock), security-skip, per-task replay-safe events
- [ ] 01-06-PLAN.md — Sundial: task → calendar deadline blocks (reconcile by atlasTaskId, no delete, no dup on re-run)
- [ ] 01-07-PLAN.md — Compass: daily planner (free/busy bin-pack, overcommit→Couldn't-fit+P3), Opus effort=medium KV-overridable, calendar read-only

**Wave 3** *(integration — blocked on Wave 2 completion)*
- [ ] 01-08-PLAN.md — MorningChain Workflow + 07:45 dispatcher + invokeAgent transport + halt→Flagger P2 + go-live checklist (D1-03/D1-04/D1-06)

**Cross-cutting constraints** (truths appearing in 2+ plans):
- No agent declares an `atlas-wire` consumer — Steward stays the sole consumer + sole Vault writer (Pillar 1).
- Every emitted Wire event uses the canonical §6.4 shape with a stable structured `idempotencyKey`; a replay through Steward leaves counters unchanged (`meta.changes === 0`).
- 2FA codes / reset links / login URLs are never surfaced (server-side redaction + per-agent guardrails + CI backstop).

**UI hint**: yes — but **frontend-free** (the only "UI" is Obsidian markdown rendered by Steward per `docs/05-dashboard.md`; no web UI / no UI-SPEC).

### Phase 2: Weekly Value
**Maps to**: Atlas Build Phase 2 (Weekly value) · Milestones M2–M3 · sequencing in `docs/13-build-plan.md §4` · per-agent specs `docs/agents/scout.md`, `headhunter.md`, `flagger.md`, `08-flagger.md`
**Goal**: Add weekly-cadence value and fleet reliability by reusing Phase 1's plumbing — event discovery, job-window tracking that feeds Forge, and an incident pipeline that hardens everything that follows.
**Depends on**: Phase 1 (Forge for Headhunter's "apply by X" tasks; Steward fan-in; the parallel-Friday concurrency model). Hard edge: Headhunter feeds Forge. Soft edge: cloud (this phase) before local (Phase 3).
**Requirements**: WEEKLY-01, WEEKLY-02
**Success Criteria** (what must be TRUE):
  1. A Friday 16:00 events digest + weekly email review land (Scout and weekly-Herald run in parallel, then fan into Steward; Steward compiles the 16:30 weekly-review build).
  2. Headhunter creates "apply by X" tasks via Forge and updates the job-pipeline kanban counts (applied → OA → interview → offer/reject); low-confidence hiring-window finds route to a flag, not silently to a task.
  3. Flagger routes P1/P2 to push immediately and batches P3/P4 into the dashboard feed; the Vault Flagger board is sorted by severity then trust.
  4. Flagger self-monitors — it flags its own heartbeat staleness.
**Plans**: TBD
**UI hint**: yes

### Phase 3: Capture (Local)
**Maps to**: Atlas Build Phase 3 (Capture/local) · Milestones M4 (Echo→Archivist) + M5 (Quill) · sequencing in `docs/13-build-plan.md §4` · per-agent specs `docs/agents/echo.md`, `archivist.md`, `quill.md`
**Goal**: Cross into the first local macOS daemon runtime for audio and screen capture, building the privacy boundary and outbound-auth transport before any feature — meeting capture + notes, and on-screen autofill.
**Depends on**: Phase 0 (Codex, Steward) + a proven cloud system to authenticate the daemon into. Hard edge: Echo before Archivist. Per D6, Quill ships here with NO Echo data dependency (co-located for the shared local runtime). Soft edge: this phase follows the cloud phase.
**Requirements**: CAPTURE-01, CAPTURE-02
**Success Criteria** (what must be TRUE):
  1. Echo captures a meeting (local daemon, DO + WebSocket live stream) → diarized transcript → Archivist produces context-aware meeting notes (action items, cross-meeting threading) → Steward → Vault notes index.
  2. Per-session consent is captured before Echo records, and two-party-consent jurisdictions are honored; no session records without consent (consent capture = 100%).
  3. Raw audio uploads via presigned URL direct from the daemon (never proxied through a Worker) and expires at 7 days (`audio/raw/` prefix only; transcripts/exports persist); Echo/Quill outputs never leave the device except as owner-approved derived artifacts.
  4. Quill autofills an on-screen form from the Codex (hotkey-triggered, never autonomous), confirms before submit, and never writes the Codex back.
**Plans**: TBD
**UI hint**: yes

### Phase 4: Outward (Gated)
**Maps to**: Atlas Build Phase 4 (Outward/gated) · Milestone M6 · sequencing in `docs/13-build-plan.md §4` · per-agent specs `docs/agents/usher.md`, `envoy.md`, `11-security-privacy.md`
**Goal**: Ship the only outward, irreversible agents — gated event registration and personal-brand publishing — strictly draft-and-confirm, with the confirmation-gate UX as the real work. Build last, gate hardest.
**Depends on**: Phase 0 (Codex for Envoy), Phase 1 (Calendar/Steward), and a mature confirmation-gate UX proven on lower-stakes actions. Hard edge: gate-UX maturity before Usher/Envoy.
**Requirements**: OUTWARD-01, OUTWARD-02
**Success Criteria** (what must be TRUE):
  1. No outward action ever fires without an explicit owner confirm (confirmation-gate adherence = 100%; gate fail-safe = deny on error); a public post / payment is never silent.
  2. Usher does on-demand event search + gated registration + Google Calendar add and bumps the Steward `events-registered` counter; captcha and payment are hard stops that hand back to the human.
  3. Envoy fans one owner intent into per-channel drafts (LinkedIn / GitHub README / X / portfolio) reading the Codex, and ships a channel only on confirmation — a post can't be un-posted, so nothing posts silently.
**Plans**: TBD
**UI hint**: yes

### Phase 5: Meta / Polish
**Maps to**: Atlas Build Phase 5 (Meta/polish) · Milestones M7 (Switchboard, doc/process) + M8 (Librarian + dashboard refinement) · per-agent specs `docs/agents/librarian.md`, `switchboard.md`, `09-prompt-library.md`, `10-switchboard.md`
**Goal**: Add off-critical-path force-multipliers and convenience — a documented design-time capability router and a reusable prompt library — that polish the system rather than power it.
**Depends on**: A working fleet to route for / capture prompts from. Per D7, Switchboard is a design-time habit (doc/process milestone), not a deployed Worker.
**Requirements**: META-01, META-02
**Success Criteria** (what must be TRUE):
  1. Librarian captures a prompt and surfaces it deduped in the Vault prompt-library table (Title link · Tags · Tool · Last used); the title deep-links to the full-prompt note and most-used surfaces at top.
  2. Switchboard exists as a documented design-time routing process (selects the minimal MCP server + tools + OAuth scopes for a goal, reports capability gaps to Flagger), NOT a deployed Worker.
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 0 → 1 → 2 → 3 → 4 → 5. MVP = Phase 0 + Phase 1.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0. Spine | 8/8 | Complete   | 2026-06-05 |
| 1. Core Loop / Morning Pipeline | 0/TBD | Not started | - |
| 2. Weekly Value | 0/TBD | Not started | - |
| 3. Capture (Local) | 0/TBD | Not started | - |
| 4. Outward (Gated) | 0/TBD | Not started | - |
| 5. Meta / Polish | 0/TBD | Not started | - |
