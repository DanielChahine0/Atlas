# Requirements (synthesized intel)

> Source corpus contains **no PRDs**. There are no user stories or product-style acceptance
> criteria in the classified set. The "requirements" below are derived capability + acceptance
> statements distilled from the canonical roadmap (`docs/12-roadmap.md`), the success metrics, and
> the task-level acceptance criteria in the build plan (`docs/13-build-plan.md`). They are recorded
> as REQ entries so the roadmapper has scoped, testable units, but they are derived intel, not
> authored PRD requirements. No competing acceptance variants were found (single-owner design,
> single authoritative spec).

Provenance: SPEC-CANON.md (authoritative), 12-roadmap.md (phases, MVP, metrics), 13-build-plan.md
(milestones M0–M8, per-agent acceptance).

---

## MVP scope (canonical)
The MVP = Phase 0 (Spine) + Phase 1 (Core loop), i.e. milestones **M0 + M1**.
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/12-roadmap.md (Recommended MVP)
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md (§6.1 M0+M1)

---

## REQ-spine-orchestration (Phase 0 / M0)
- source: docs/12-roadmap.md (Phase 0), docs/13-build-plan.md (§2, M0)
- scope: Atlas orchestrator + the Wire + Steward + The Vault + The Codex + Cloudflare project + Google/GitHub OAuth
- description: Stand up the infrastructure spine on which every agent runs.
- acceptance:
  - Atlas can schedule a no-op agent and route a message onto the Wire.
  - Steward consumes one Wire event and applies it to the Vault per the §6.4 contract
    `{ agent, type, entity, op, payload, idempotencyKey }`, serialized single-consumer, `increment`
    idempotent on replay (apply same idempotencyKey twice -> counter unchanged, `meta.changes === 0`).
  - The Codex exists with the §11 sections (identity, education, work, skills, projects, bios,
    socials), read-only to agents except the explicit "update my profile" flow.
  - Google (least-privilege scopes) and GitHub (GitHub App) OAuth round-trips succeed; tokens live in
    Cloudflare Secrets Store, never in the Vault or Codex.
  - DLQ (`atlas-wire-dlq`) exists; an exhausted-retry message lands there, produces an audit row + a
    P2/P3 incident, never silently buffers.

## REQ-core-loop-morning-pipeline (Phase 1 / M1 — the flagship)
- source: docs/12-roadmap.md (Phase 1), docs/13-build-plan.md (§3, M1), docs/SPEC-CANON.md §4/§10
- scope: Filer -> Herald -> Forge -> Sundial -> Compass, all feeding Steward -> the Vault
- description: The strictly-sequential morning pipeline ("start-after-success"); the daily thing the
  owner sees. Realized by the §10 schedule: Filer sweep 07:45 -> Herald 08:00 -> Forge 08:15 ->
  Sundial 08:20 -> Compass 08:30, plus Compass 21:00 preview.
- acceptance:
  - A real 08:00 digest lands as a draft to the owner.
  - `① Action Required` threads become Forge tasks with deadlines.
  - Deadline tasks appear on Google Calendar (`agent=sundial` extendedProperty).
  - The Vault Today view shows Compass's top-3 + the §6.3 morning-glance set (action-required emails,
    deadlines next 7 days, today's meetings, open flags, waiting-on).
  - A forced Forge failure leaves Filer's labels + Herald's draft intact, halts before Sundial/Compass,
    emits one `chain.halted` P2 to Flagger.
  - Re-firing the same date is a complete no-op (`instance.id = morning-${date}`, idempotent Steward
    writes); killing mid-`forge-morning` resumes at Forge (Filer/Herald memoized, not re-run).

## REQ-filer-email-labeling
- source: docs/agents/filer.md, docs/04-email-taxonomy.md, docs/SPEC-CANON.md §5
- scope: Gmail labeling via the canonical taxonomy
- description: Filer applies the literal Gmail label taxonomy in near-real-time (Gmail push) and on a
  pre-Herald 07:45 sweep. Labels only — never archives or deletes.
- acceptance: see constraints.md CON-filer-labels-only and CON-email-taxonomy; idempotency via
  `AI/Reviewed`; `gmail.modify` scope only (no delete path reachable); security-mail bodies stripped.

## REQ-herald-digest
- source: docs/agents/herald.md, docs/SPEC-CANON.md §2/§10
- scope: daily + weekly email digests
- description: Herald reads Filer's labels and produces a daily (08:00) and weekly (Fri 16:00) digest
  as an owner draft, plus a digest event to Steward. Read + draft only — no send, no label scope.
- acceptance: a draft digest lands to the owner; zero 2FA codes / reset links ever surfaced
  (security invariant); weekly mode runs in parallel with Scout on Friday.
- open (owner decision, not a conflict): keep the Gmail draft for v1 even though it overlaps the Vault
  morning glance (build plan §3 / herald.md open question).

## REQ-forge-task-extraction
- source: docs/agents/forge.md, docs/SPEC-CANON.md §4
- scope: structured task + subtask extraction with deadlines
- description: Forge extracts tasks/subtasks with deadlines from email (Herald's `① Action Required`)
  and job findings, stores them in D1, emits Wire events. Uses a `dedupe_key` algorithm + DO lock.
- acceptance: `① Action Required` set yields >=1 D1 task with a deadline; dedupe prevents duplicate
  tasks on re-run.

## REQ-sundial-calendar-sync
- source: docs/agents/sundial.md, docs/SPEC-CANON.md §4/§10
- scope: task -> Google Calendar sync
- description: Sundial idempotently syncs Forge deadline tasks to Google Calendar blocks via the
  Calendar MCP, deduped by `atlasTaskId` extended properties; reports `calendar.sync` to Steward.
- acceptance: deadline tasks appear as calendar blocks (`⏳`); a re-run does not create duplicate events.

## REQ-compass-day-plan
- source: docs/agents/compass.md, docs/SPEC-CANON.md §4/§6.3
- scope: daily planner (last morning stage)
- description: Compass merges Forge tasks with the calendar (free/busy) into a time-blocked day plan
  and a top-3, emits a `day_plan` event to Steward. Handles overcommitment.
- acceptance: the Vault Today view renders the top-3 and the morning-glance set.

## REQ-weekly-value (Phase 2 / M2-M3)
- source: docs/12-roadmap.md (Phase 2), docs/13-build-plan.md (§4 Phase 2)
- scope: Scout (events, Fri 16:00), Headhunter (jobs, Mon 09:00 full + daily-light 09:00), Flagger
  (incident flagging, event-driven)
- description: Weekly-cadence value + fleet reliability, reusing Phase 1 plumbing.
- acceptance: Friday events digest + weekly email review land; Headhunter creates "apply by X" tasks
  and updates the job-pipeline kanban; Flagger routes P1/P2 to push immediately and batches P3/P4 to
  the dashboard feed (board sorted by severity then trust); Flagger self-monitors its own staleness.

## REQ-capture-local (Phase 3 / M4-M5)
- source: docs/12-roadmap.md (Phase 3), docs/13-build-plan.md (§4 Phase 3)
- scope: Echo (audio capture, local) -> Archivist (meeting notes, cloud); Quill (screen autofill, local)
- description: First local macOS daemon runtime. Echo captures audio -> diarized transcript ->
  Archivist structures notes -> Steward -> Vault. Quill autofills on-screen forms from the Codex.
- acceptance: meeting capture + notes index produced; Echo/Quill outputs never leave the device except
  as owner-approved derived artifacts; per-session consent captured before Echo records; Quill is
  hotkey-triggered, never autonomous, never writes the Codex back.

## REQ-outward-gated (Phase 4 / M6)
- source: docs/12-roadmap.md (Phase 4), docs/13-build-plan.md (§4 Phase 4)
- scope: Usher (event registration), Envoy (personal-brand sync)
- description: The only outward/irreversible agents. Both on-demand, strictly draft-and-confirm.
- acceptance: no outward action ever fires without explicit owner confirm (gate adherence = 100%);
  captcha/payment are hard stops that hand back to the human; a public post / payment is never silent.

## REQ-meta-polish (Phase 5 / M7-M8)
- source: docs/12-roadmap.md (Phase 5), docs/13-build-plan.md (§4 Phase 5)
- scope: Switchboard (design-time capability router), Librarian (prompt library), dashboard refinement
- description: Force-multipliers and convenience, off the critical path. Per D7, Switchboard is a
  design-time habit (doc/process milestone), not a deployed Worker. Librarian writes the Vault
  prompt-library table (Title link · Tags · Tool · Last used).
- acceptance: Librarian captures a prompt and surfaces it deduped in the table; Switchboard exists as
  a documented routing process, not a runtime Worker.

---

## Success metrics (acceptance for the system as a whole)
- source: docs/12-roadmap.md (Success metrics), docs/13-build-plan.md (§6.2 instrumentation)
- Headline three: Minutes saved/day >= 20 (vs a pre-launch one-week manual baseline); % action-required
  emails caught >= 95%; deadlines missed = 0 (a hard zero; any miss is a P-level Flagger incident).
- Supporting: digest accuracy >= 95%; false-positive `① Action Required` <= 10%; tasks needing manual
  correction <= 1/day; counter freshness 100% (any drift = a flag); morning-chain success >= 99%;
  Flagger actionable >= 70%; security invariant: ZERO 2FA codes / reset links ever in a digest.
- Gating metrics (do not promote Echo/Usher/Envoy past draft mode until): confirmation-gate adherence
  = 100%; Echo consent capture = 100% before any session records.
