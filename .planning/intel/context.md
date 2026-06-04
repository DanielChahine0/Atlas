# Context (synthesized intel)

> Running notes keyed by topic, distilled from the 9 DOC-typed sources (overview, agent roster,
> architecture, roadmap, build plan, and the agent-doc companions archivist/envoy/librarian/quill/
> usher). Verbatim-faithful summaries with source attribution. No contracts here — those live in
> constraints.md; decisions in decisions.md; capability/acceptance in requirements.md.

---

## Topic: What Atlas is
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/00-overview.md; docs/SPEC-CANON.md §0
- Atlas is a personal orchestrator for the owner (Daniel Chahine) that runs a fleet of specialized
  sub-agents to manage his digital life: email triage, task creation, calendar, events, job hunting,
  meeting capture, a personal Obsidian dashboard, screen autofill, and cross-platform personal-brand
  publishing. Atlas itself does almost no domain work — it schedules, routes, sequences, and
  supervises, and owns the shared event bus (the Wire) and state.
- Naming: System = Atlas; source-of-truth profile = The Codex (`codex.md`); dashboard = The Vault
  (Obsidian); event bus = the Wire (Cloudflare Queue). Each sub-agent has a codename + plain-English
  role; codenames are used in headers/cross-links.

## Topic: Agent roster (canonical, 16 sub-agents + Atlas)
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/01-agent-roster.md; docs/SPEC-CANON.md §2
- Roster `#0`–`#16`: #0 Atlas (orchestrator/supervisor), #1 Herald (email digest daily+weekly),
  #2 Filer (email labeler, never archives/deletes), #3 Forge (task & subtask extractor), #4 Sundial
  (task -> Google Calendar), #5 Compass (daily planner), #6 Scout (event discovery + weekly digest),
  #7 Usher (event search + registration + calendar add), #8 Headhunter (job-board & hiring-window
  tracker), #9 Echo (audio capture -> transcripts, LOCAL), #10 Archivist (meeting-notes organizer),
  #11 Steward (sole Vault writer), #12 Quill (screen-aware autofill, LOCAL), #13 Envoy (personal-brand
  sync), #14 Switchboard (capability router, design-time), #15 Flagger (incident flagging), #16
  Librarian (prompt library).
- Note on terminology: docs/00-overview.md describes "16 specialized sub-agents"; docs/01-agent-roster
  states "Total agents: 17 (Atlas + 16 sub-agents)". These reconcile to the same canonical roster —
  00-overview counts sub-agents only, 01-roster counts the orchestrator too. See INGEST-CONFLICTS.md
  (INFO). Herald is ONE agent with two run modes (daily/weekly) — DRY, not two agents.
- Two orderings matter: value ranking (impact if it works) and build order (dependencies + difficulty).
  Foundational infra (Atlas, Steward, The Codex) sits above the value ranking.

## Topic: Importance tiers
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/SPEC-CANON.md §3; docs/01-agent-roster.md
- Foundational (build first): Atlas, Steward, The Codex.
- Tier 1 (core loop, highest daily value): Herald, Filer, Forge, Compass, Sundial, Steward.
- Tier 2 (high value, weekly): Scout, Headhunter, Flagger.
- Tier 3 (high value, harder — local capture/screen): Echo, Archivist, Quill.
- Tier 4 (outward/irreversible/convenience — build last, gate hardest): Usher, Envoy, Librarian,
  Switchboard.

## Topic: Architecture & pipelines
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/02-architecture.md; docs/SPEC-CANON.md §4
- Morning pipeline (sequential): Gmail push -> Filer (label) -> Herald (digest) -> Forge (tasks) ->
  Sundial (calendar) -> Compass (day plan), all feeding Steward -> The Vault.
- Event-bus fan-in: Usher/Headhunter/Scout/Envoy/Forge/Compass/Flagger -> the Wire -> Steward
  (single serialized writer) -> The Vault. Steward fetches nothing; it is fed.
- Meetings pipeline (local -> cloud): Echo (local, real-time) -> transcript -> Archivist (cloud) ->
  Steward -> Vault, with The Codex feeding work context.
- Hard dependency edges (cannot reorder): Filer before Herald; Forge before Sundial; Forge + Calendar
  before Compass; Echo before Archivist; Headhunter into Forge. Switchboard is consulted at design
  time and does not run in the loop.

## Topic: Roadmap, phases & MVP
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/12-roadmap.md; docs/SPEC-CANON.md §13
- Canonical 6-phase build order: Phase 0 Spine (Atlas, Wire, Steward+Vault, Codex, CF + OAuth) ->
  Phase 1 Core loop / MVP (Filer->Herald->Forge->Sundial->Compass + Steward dashboard) -> Phase 2
  Weekly value (Scout, Headhunter, Flagger) -> Phase 3 Capture/local (Echo->Archivist, Quill) ->
  Phase 4 Outward/gated (Usher, Envoy) -> Phase 5 Meta/polish (Switchboard, Librarian, dashboard
  refinement).
- MVP = Phase 0 + Phase 1 (the morning pipeline + Steward dashboard). Highest-value, lowest-risk slice;
  exercises the full spine so nothing is throwaway.
- Ordering rationale: infrastructure before features; daily loop is where ~80% of value lives; weekly
  agents reuse the loop's plumbing; local capture needs a new runtime so it waits; outward/irreversible
  actions are gated and come last; meta/convenience polish last.
- Feasibility verdict: "Yes — as a read-only, suggest-don't-destroy system." Risk lives entirely in the
  four write-the-outside-world agents (Echo, Quill, Usher, Envoy); the build order quarantines them to
  the end.
- Soft edges (sequencing choice, not data): Phase 2 before Phase 3 (cloud-before-local); Phase 4 last
  (gate maturity).

## Topic: Build plan & execution milestones
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md
- The build plan is the "how": one-time prerequisites, task-level breakdowns of Phase 0 and Phase 1
  with acceptance criteria, sequencing for Phases 2-5, cross-cutting engineering disciplines, and a
  decision log (D1-D7) that closes the cross-doc open questions (see decisions.md). It reads from
  SPEC-CANON as authoritative rather than defining its own contracts.
- Milestones M0..M8; MVP = M0 + M1. Hard prerequisite: Cloudflare Workers Paid plan.
- Repo: monorepo of Workers with shared packages; drafted package manager pnpm; drafted one Worker
  per agent (Steward + Filer must stay isolated Workers if grouping low-risk Phase-1 agents).
- Cross-cutting practices: testing strategy per primitive; observability + Flagger-from-day-0;
  idempotency/replay discipline; secrets & least-privilege; local dev & deploy (empty crons in
  staging); cost control (prompt caching, per-gateway budgets); security invariants as automated CI
  checks (redaction test, gate fail-safe test, one-Wire-consumer grep).

## Topic: Owner inputs still needed (human-judgment calls, NOT conflicts)
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md §7
- These are open owner decisions the docs deliberately leave to the human; they are not cross-doc
  contradictions and are NOT raised as conflicts. Logged here so the roadmapper can flag them as
  decision points:
  - Before scaffolding: package manager (pnpm drafted); Worker granularity; per-Worker cron cap;
    AI Gateway dollar/rate ceilings; `compatibility_date` pin (`2026-04-25`) + heartbeat staleness
    threshold (5 min); DST operational burden (accept twice-yearly edit vs fixed offset vs self-check).
  - Before MVP go-live: `invokeAgent` transport (service-binding RPC recommended); Herald output
    surface (keep Gmail draft vs Vault-glance-only; Friday daily+weekly vs weekly-only); Compass Opus
    `effort` level; the two manual measurement commitments (pre-launch baseline + daily ~1-min review);
    morning-chain success-rate window (rolling 30d vs since-launch).
  - Phases 2-4: idempotency-ledger retention; DLQ consumer ownership; security redaction placement;
    Flagger calibration; Echo audio path + consent posture + raw retention; Envoy LinkedIn/X automation
    posture + idempotencyKey granularity; Usher registered->attended transition + cancellation handling.

## Topic: Per-agent companion docs (DOC type)
- source: docs/agents/archivist.md, docs/agents/envoy.md, docs/agents/librarian.md,
  docs/agents/quill.md, docs/agents/usher.md
- Archivist (DOC): structures Echo's transcripts into context-aware meeting notes (action-item
  extraction, cross-meeting threading) and hands them to Steward + Forge; uses Cloudflare Workflows.
- Envoy (DOC): fans one owner intent out to LinkedIn / GitHub README / X / portfolio, drafts each, ships
  only on confirmation; reads The Codex; GitHub via GitHub MCP.
- Librarian (DOC): agent-doc companion to the canonical 09-prompt-library SPEC; defers schema to it.
- Quill (DOC): local macOS agent reading on-screen forms (Accessibility API + OCR vision fallback),
  autofills from the Codex, confirms before submit; never writes the Codex back.
- Usher (DOC): on-demand event search, gated registration via Playwright browser automation, Google
  Calendar add, Steward `events-registered` counter; captcha/payment are hard stops.
