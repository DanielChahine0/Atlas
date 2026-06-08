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

- [x] **Phase 0: Spine** - Infrastructure substrate (Atlas, the Wire, Steward + the Vault, the Codex, Cloudflare project, Google + GitHub OAuth); zero user-visible features. _[MVP]_ (code-complete 2026-06-05; owner go-live gates pending — see `.planning/STATE.md` → Blockers)
- [x] **Phase 1: Core Loop / Morning Pipeline** - Strictly-sequential Filer → Herald → Forge → Sundial → Compass on one 07:45 cron via a Workflow, all feeding Steward → the Vault. _[MVP — the flagship]_ (code-complete + review-remediated 2026-06-05; owner go-live gates pending)
- [x] **Phase 2: Weekly Value** - Scout (events), Headhunter (jobs, feeds Forge), Flagger (incident pipeline + self-watchdog). (completed 2026-06-05)
- [x] **Phase 3: Capture (Local)** - Echo (audio, local daemon) → Archivist; Quill (screen autofill). First non-cloud runtime; privacy boundary first. (completed 2026-06-06)
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
- [x] 01-01-PLAN.md — Expand mcp-google with Herald/Forge/Sundial/Compass scope-floored tools (gmail.compose/readonly, calendar.events/readonly) + redaction egress
- [x] 01-02-PLAN.md — D1 `tasks`/`subtasks` migration (`idx_tasks_dedupe`) + `@atlas/tasks` data-access (dedupe/merge)

**Wave 2** *(the five agents — parallel, each owns its own apps/ dir; blocked on Wave 1)*
- [x] 01-03-PLAN.md — Filer: Gmail labeler (sweep + FilerCursor DO + push/renewal), labels-only, idempotent on AI/Reviewed, never surfaces 2FA/phishing
- [x] 01-04-PLAN.md — Herald: daily draft digest (five sections, no Friday case), output-side redaction guardrail (leak → block draft + P2)
- [x] 01-05-PLAN.md — Forge: task/subtask extractor → D1 (dedupe/merge in DO lock), security-skip, per-task replay-safe events
- [x] 01-06-PLAN.md — Sundial: task → calendar deadline blocks (reconcile by atlasTaskId, no delete, no dup on re-run)
- [x] 01-07-PLAN.md — Compass: daily planner (free/busy bin-pack, overcommit→Couldn't-fit+P3), Opus effort=medium KV-overridable, calendar read-only

**Wave 3** *(integration — blocked on Wave 2 completion)*
- [x] 01-08-PLAN.md — MorningChain Workflow + 07:45 dispatcher + invokeAgent transport + halt→Flagger P2 + go-live checklist (D1-03/D1-04/D1-06)

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
**Plans**: 7 plans

**Wave 1** *(foundation — the incident-bus hard edge; runs alone, touches every wrangler)*
- [x] 02-01-PLAN.md — `atlas-incidents` queue topology (D2-04) + `RawIncident` schema + `flag()` rework (D2-05) + ALL ~15 caller migrations + `0004` D1 migration (events/windows/jobs/flags); 315 tests stay green

**Wave 2** *(the agents + retrofit — parallel, each owns its own dir; blocked on 02-01)*
- [x] 02-02-PLAN.md — Flagger: `atlas-incidents` sole consumer → score/dedupe/route → `op:upsert` flag to `atlas-wire`; FlaggerState DO single-alarm heartbeat scheduler; ntfy push (P1/P2); token-gated `/ack` route
- [x] 02-03-PLAN.md — flagger-watchdog (separate cron Worker, self-P1 on Flagger silence — GATING kill test) + heartbeat retrofit into Filer/Forge/Sundial/Compass
- [x] 02-04-PLAN.md — Scout: Friday events digest (RSS/HTML/Gmail, no Browser Rendering) + Codex/KV relevance + D1 `events` + idempotent Steward upserts; never follows email links
- [x] 02-05-PLAN.md — Headhunter: hiring-window state machine (D1 + HeadhunterState DO) + apply-by tasks via Forge (urgency bypasses fit floor; low-confidence → P3) + single-emitter funnel (GATING re-scan idempotency)
- [x] 02-06-PLAN.md — weekly-Herald mode (D2-10): Friday week-in-review draft (redaction-guarded, no send) + `herald:weekly` digest event + Herald heartbeat

**Wave 3** *(integration — blocked on 02-04/05/06)*
- [x] 02-07-PLAN.md — Atlas cron wiring (4 standalone dual-EDT/EST cases, Friday `Promise.allSettled`) + Scout/Headhunter/Steward service bindings + `Steward.weeklyReviewBuild` (16:30) + cron-cap human-verify checkpoint

**Cross-cutting constraints** (truths appearing in 2+ plans):
- Steward stays the SOLE `atlas-wire` consumer (Pillar 1); Flagger consumes the NEW `atlas-incidents` queue and PRODUCES onto `atlas-wire`; the watchdog produces directly onto `atlas-wire` (producer, never consumer).
- Every emitted Wire event uses a stable structured `idempotencyKey`; a replay through Steward leaves counters unchanged (`meta.changes === 0`).
- Nothing this phase is destructive or outward-facing — Scout never registers, Headhunter never applies, Flagger never auto-remediates (Pillar 2). ntfy push is flag-gated behind `flagger.push_enabled` (default false).
- The ntfy topic/token + ack token live in Secrets Store only; the `/ack` route uses constant-time token comparison.

**Owner go-live config gates** (cannot be set from code; mirror the Phase-1 gate discipline): seed the ntfy topic + token and flip `flagger.push_enabled` (D2-03); seed the Headhunter watchlist/boards/cycle KV (D2-15); optionally seed `scout/sources`+`scout/interests`/`headhunter/targets`; verify the Workers Free per-Worker cron cap before deploying the expanded Atlas crons (RESEARCH A1).

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
**Plans**: 6 plans

**Wave 1** *(cloud substrate — runs alone; closes all 03-VALIDATION Wave-0 Gaps)*
- [x] 03-01-PLAN.md — `migrations/0006_meetings.sql` (D1 transcript index) + `apps/echo` & `apps/archivist` package/wrangler/test shells + the named Wave-0 test stubs (CAPTURE-01-a..-j)

**Wave 2** *(cloud Echo + Archivist — parallel, no file overlap; blocked on 03-01)*
- [x] 03-02-PLAN.md — Echo cloud: EchoSession DO (WebSocket Hibernation, reconnect-finalize) + OAuth-scope-gated R2 presign endpoint (prefix-locked) + `transcript.ready` Wire producer
- [x] 03-03-PLAN.md — Archivist Workflow (durable steps, one explicit-effort Opus pass, Steward upsert + counters, owner action items via `Forge.createTask`, idempotent on session_id) + Steward `transcript.ready`→`ARCHIVIST_WF.create` trigger + Atlas service bindings

**Wave 3** *(native daemon shell + privacy boundary — blocked on 03-02; autonomous:false / owner-UAT)*
- [x] 03-04-PLAN.md — Swift capture-app shell (menubar, launchd, ZERO inbound port) + Keychain OAuth + outbound poll/drain/ack channel + value-stripped IncidentRelay + local Codex cache (XCTest + lsof gating proof)

**Wave 4** *(native capture features — parallel, no file overlap; blocked on 03-04; autonomous:false / owner-UAT)*
- [x] 03-05-PLAN.md — Echo capture pipeline: Core Audio process tap (two channels + silent-zeros watchdog) + WhisperKit STT + FluidAudio loopback diarization + consent gate / non-dismissable indicator + EventKit auto-arm + outbound EchoSession WS client (reconnect-finalize, presigned audio upload on approval, transcript.ready emit)
- [x] 03-06-PLAN.md — Quill: hotkey-triggered AX-first read + on-device OCR fallback + local Codex field map (secret refusal P2, EEO blank, voice snippet) + locked review panel (confirm-before-submit, never submits, never writes Codex/Vault/Wire)

**Cross-cutting constraints** (truths appearing in 2+ plans):
- No new `atlas-wire` consumer — Steward stays the SOLE consumer + sole Vault writer (Pillar 1). Echo + Archivist are Wire PRODUCERS only; the Archivist trigger fires from WITHIN Steward's existing consumer.
- Archivist writes the Vault ONLY via Steward `upsert`; owner action items go through `Forge.createTask` RPC (NOT a direct D1 tasks write) — the same path Headhunter uses.
- Structured idempotency keys (`echo:<sid>:ready`, `archivist:<sid>:note`, `archivist:<series>:<date>:ai-NN`); replay through Steward leaves counters unchanged (`meta.changes === 0`); NEVER `crypto.randomUUID()`.
- The privacy boundary is mechanical, not promised: outbound-only daemon with NO inbound port (`lsof` proof), on-device STT/OCR, R2 prefix-split (`audio/raw/` 7d, `transcripts/` persist), consent before any capture (100%), screen/audio never leave the device except as an owner-approved derived artifact.
- The capture OAuth token lives in macOS Keychain (daemon) / Secrets Store (cloud) — never `[vars]`/KV/Vault/Codex; incident flags carry form + field labels only, never screen content/values.

**Owner go-live gates** (cannot be set from code; mirror the Phase-1/2 gate discipline): enable R2 on the account (`wrangler r2 bucket create atlas-blobs` currently fails CF err 10042) + create the `audio/raw/` 7-day lifecycle rule; an Apple Developer account ($99/yr) for Developer-ID signing + notarization; the Xcode/Swift toolchain; the OS permission grants (Microphone, audio-capture, Accessibility, Screen Recording); seed the capture app's OAuth client + token into Keychain + Secrets Store; sign off the Manual-Only UAT checklist (consent gate 100%, non-dismissable indicator, no-inbound-port `lsof`, TCC persistence, reconnect-finalize, long-session watchdog, real-meeting capture, Quill on a real form, presigned-upload staging integration).

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
**Plans**: 7 plans

**Wave 1** *(foundation — parallel, no file overlap)*
- [x] 04-01-PLAN.md — `packages/gate` shared confirmation-gate primitive (D4-04) + `migrations/0007_gate.sql` (gate_pending + browser_action_outbox) + dual audit rows + constant-time token + all Wave-0 test stubs
- [x] 04-02-PLAN.md — mcp-github `github_create_branch` + `github_open_pr` tools (pull_requests:write) for Envoy's portfolio PR (+ owner App-permission checkpoint)

**Wave 2** *(consumers of the gate — parallel, each owns its own dir; blocked on 04-01)*
- [x] 04-03-PLAN.md — `apps/gate` Worker: token-gated confirm page (GET/POST /confirm, fail-closed, expired→410), expiry-sweep `scheduled()`, daemon browser poll/ack endpoints, approve→re-invoke
- [x] 04-04-PLAN.md — daemon browser-action runner: outbound poll/drain/ack + Playwright `launchPersistentContext` (owner's logged-in profile), captcha/payment hard stops, Usher auto-submit / Envoy prefill-no-submit
- [ ] 04-05-PLAN.md — Sundial retrofit: route the existing propose-removal proposal through `packages/gate` (D4-04 gate-UX maturity proof); reconcile.ts unchanged

**Wave 3** *(the outward agents — parallel, each owns its own dir; blocked on the gate Worker + daemon + mcp-github)*
- [ ] 04-06-PLAN.md — `apps/usher` (OUTWARD-01): on-demand gated registration, price disclosed, ~24h gate, auto-submit free path, captcha/payment hard stops, Calendar add + events-registered++ only on a scraped confirmation #
- [ ] 04-07-PLAN.md — `apps/envoy` (OUTWARD-02): fan one intent into 4 Codex-sourced drafts, ~7d gate per-target approve/edit/skip, GitHub README+PR (agent), LinkedIn/X prefill (owner clicks Post), Brand counters once per slug

**Cross-cutting constraints** (truths appearing in 2+ plans):
- Steward stays the SOLE `atlas-wire` consumer (Pillar 1); the gate Worker, Usher, and Envoy are Wire PRODUCERS only and write Calendar/GitHub DIRECTLY — no new `atlas-wire` consumer (a second is a hard CI failure).
- Every outward action gates; gate fail-safe = deny on error; timeout = expired with NO action; payment is NEVER automatic (no override knob, D4-11); captcha is NEVER solved; a submit without an approved gate row = P1 self-flag.
- The confirm page renders the LITERAL artifact (exact post text / form values + price), is served with the hardened AUTH_SECURITY_HEADERS, and never surfaces a 2FA code / reset link / login URL.
- Structured idempotency keys (`usher:<event-id>:registered`, `envoy:<project-slug>`); replay through Steward leaves counters unchanged (`meta.changes === 0`); never `crypto.randomUUID()`.
- No platform credential ever leaves the owner's machine — the browser action runs locally in the owner's already-logged-in session (D4-00/D4-05), outbound-only, no inbound port. Phase 4 stays on Workers Free (D4-06).

**Owner go-live gates** (cannot be set from code; mirror the Phase-1/2/3 gate discipline): add the GitHub App `pull_requests:write` permission + re-install (04-02 checkpoint); install Playwright + Chromium in the daemon and log into LinkedIn/X/Meetup/Eventbrite once in the persistent profile at `ATLAS_BROWSER_PROFILE` (04-04); seed the CONFIG knobs (`gate.confirm_base_url`, `gates.timeout_usher_ms`=86400000, `gates.timeout_envoy_ms`=604800000, `envoy.portfolio_repo`/`portfolio_path`/`profile_repo`); seed the `GATE_CONFIRM_TOKEN` secret into Secrets Store.

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
| 1. Core Loop / Morning Pipeline | 8/8 | Complete   | 2026-06-05 |
| 2. Weekly Value | 7/7 | Complete   | 2026-06-05 |
| 3. Capture (Local) | 6/6 | Complete   | 2026-06-06 |
| 4. Outward (Gated) | 4/7 | In Progress|  |
| 5. Meta / Polish | 0/TBD | Not started | - |
