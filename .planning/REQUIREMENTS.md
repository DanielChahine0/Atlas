# Requirements: Atlas

**Defined:** 2026-06-01
**Core Value:** Every morning the owner sees a trustworthy digest, a deadline-safe task/calendar set, and a day plan — built automatically, with zero missed deadlines and zero 2FA codes/reset links ever surfaced.

> No PRDs exist in the source corpus. These requirements are derived capability + acceptance units distilled from the canonical roadmap (`docs/12-roadmap.md`), the success metrics, and the task-level acceptance criteria in the build plan (`docs/13-build-plan.md`). `docs/SPEC-CANON.md` is authoritative. Each requirement cross-references its per-agent spec under `docs/agents/<codename>.md`.

## v1 Requirements

Requirements for the v1 build. Each maps to exactly one roadmap phase. **MVP = SPINE + CORE (Phase 0 + Phase 1).**

> **Status legend:** `[x]` done · `[~]` **code-complete, owner go-live gate pending** — the implementation + automated/mocked contracts are built and tested, but a live activation step only the owner can perform (OAuth consent, Secrets Store seed, AI-Gateway ceilings, live smoke) is outstanding · `[ ]` not started. As of 2026-06-09, all 6 phases are code-complete (milestone v1.0, 40/40 plans, 716 workspace + 39 daemon tests green); every remaining `[~]` item is gated on owner actions, not code.

### Spine (Phase 0 — Infrastructure)

- [x] **SPINE-01**: Atlas can schedule a no-op agent and route a message onto the Wire (the Cloudflare Queue event bus). _(docs/agents/atlas.md, 02-architecture.md)_
- [x] **SPINE-02**: Steward consumes one Wire event and applies it to the Vault per the §6.4 contract `{ agent, type, entity, op, payload, idempotencyKey }`, serialized single-consumer; `increment` is idempotent on replay (same idempotencyKey twice → counter unchanged, `meta.changes === 0`). _(docs/agents/steward.md, SPEC-CANON §6.4, 13-build-plan §2 T5/T6)_
- [x] **SPINE-03**: The Codex exists with the §11 sections (identity, education, work, skills, projects, bios, socials), read-only to agents except the explicit "update my profile" flow. _(07-source-of-truth-codex.md, SPEC-CANON §11)_
- [~] **SPINE-04**: Google (least-privilege scopes) and GitHub (GitHub App) OAuth round-trips succeed; tokens live in Cloudflare Secrets Store, never in the Vault or Codex. _(11-security-privacy.md, 06-hosting-cloudflare-mcp.md)_ — *OAuth/MCP code + 37 mocked tests complete; live round-trip + 6-secret Secrets Store seed = owner gate (2 `describe.skip` live tests).*
- [x] **SPINE-05**: The DLQ (`atlas-wire-dlq`) exists; an exhausted-retry message lands there, produces an audit row + a P2/P3 incident, and never silently buffers. The Obsidian bridge writes outbound-only from Steward to the Vault. _(13-build-plan §2 T7, 06-hosting-cloudflare-mcp.md)_

### Core Loop (Phase 1 — the MVP morning pipeline)

- [~] **CORE-01**: The strictly-sequential morning chain Filer → Herald → Forge → Sundial → Compass runs as one Cloudflare Workflow off a single 07:45 cron (start-after-success); a forced Forge failure leaves Filer's labels + Herald's draft intact, halts before Sundial/Compass, and emits one `chain.halted` P2 to Flagger. Re-firing the same date is a complete no-op (`instance.id = morning-${date}`); killing mid-`forge-morning` resumes at Forge (Filer/Herald memoized). _(02-architecture.md, 03-scheduling.md §10, 13-build-plan §3)_
- [~] **FILER-01**: Filer applies the literal Gmail label taxonomy (Triage/Type/Needs/Deadline/Relationship/Suggestion/Agent-state) in near-real-time (Gmail push) and on a 07:45 sweep; labels only — never archives or deletes (`gmail.modify` scope, no delete path reachable); idempotent via `AI/Reviewed`; security-mail bodies stripped. _(docs/agents/filer.md, 04-email-taxonomy.md, SPEC-CANON §5)_
- [~] **HERALD-01**: Herald reads Filer's labels and produces a real 08:00 daily digest as an owner draft (and a Fri 16:00 weekly digest), plus a digest event to Steward; read + draft only — no send; ZERO 2FA codes / reset links ever surfaced. _(docs/agents/herald.md, SPEC-CANON §2/§10)_
- [~] **FORGE-01**: Forge extracts tasks/subtasks with deadlines from Herald's `① Action Required` set, stores them in D1 under a `dedupe_key` + DO lock, and emits Wire events; the action-required set yields ≥1 D1 task with a deadline and dedupe prevents duplicate tasks on re-run. _(docs/agents/forge.md, SPEC-CANON §4)_
- [~] **SUNDIAL-01**: Sundial idempotently syncs Forge deadline tasks to Google Calendar blocks (`⏳`, deduped by `atlasTaskId` extended properties) and reports `calendar.sync` to Steward; a re-run creates no duplicate events. _(docs/agents/sundial.md, SPEC-CANON §4/§10)_
- [~] **COMPASS-01**: Compass merges Forge tasks with calendar free/busy into a time-blocked day plan + a top-3 (handling overcommitment), emits a `day_plan` event to Steward, and runs an 08:30 plan + 21:00 preview; the Vault Today view renders the top-3 and the §6.3 morning-glance set (action-required emails, deadlines next 7 days, today's meetings, open flags, waiting-on). _(docs/agents/compass.md, SPEC-CANON §4/§6.3)_

### Weekly Value (Phase 2)

- [~] **WEEKLY-01**: Scout produces a Friday 16:00 events digest and Headhunter (Mon 09:00 full + daily-light 09:00) creates "apply by X" tasks via Forge and updates the job-pipeline kanban counts (applied → OA → interview → offer/reject); low-confidence hiring-window finds route to a flag, not silently to a task. _(docs/agents/scout.md, docs/agents/headhunter.md, 13-build-plan §4)_ — *code-complete + verified; owner gate = seed the Headhunter watchlist/boards/cycle KV (D2-15).*
- [~] **WEEKLY-02**: Flagger receives error/incident events from every agent, routes P1/P2 to push immediately and batches P3/P4 into the dashboard feed (Vault Flagger board sorted by severity then trust), and self-monitors its own heartbeat staleness. _(08-flagger.md, docs/agents/flagger.md, SPEC-CANON §8)_ — *code-complete + verified; owner gate = seed the ntfy topic/token + flip `flagger.push_enabled` (D2-03).*

### Capture — Local (Phase 3)

- [~] **CAPTURE-01**: Echo captures audio in a local macOS daemon (DO + WebSocket live stream) → diarized transcript → Archivist structures context-aware meeting notes (action items, cross-meeting threading) → Steward → Vault; per-session consent is captured before Echo records, two-party-consent jurisdictions are honored, and raw audio uploads via presigned URL direct from the daemon (expires at 7 days, `audio/raw/` only). _(docs/agents/echo.md, docs/agents/archivist.md, SPEC-CANON §4/§12)_ — *code-complete + verified; owner gates = R2 enablement + `audio/raw/` 7-day lifecycle, Developer-ID signing/notarization, OS permission grants, Manual-Only UAT sign-off.*
- [~] **CAPTURE-02**: Quill autofills on-screen forms from the Codex (Accessibility API + OCR fallback), hotkey-triggered and never autonomous, confirming before submit and never writing the Codex back; outputs never leave the device except as owner-approved derived artifacts. _(docs/agents/quill.md, SPEC-CANON §12)_ — *code-complete + verified; owner gates = Accessibility/Screen Recording grants + Manual-Only UAT.*

### Outward — Gated (Phase 4)

- [~] **OUTWARD-01**: Usher does on-demand event search + gated registration (browser automation) + Google Calendar add and bumps the Steward `events-registered` counter; no outward action fires without explicit owner confirm (gate adherence = 100%); captcha/payment are hard stops handed back to the human. _(docs/agents/usher.md, SPEC-CANON §12, 11-security-privacy.md)_ — *code-complete + verified; owner gates = Playwright/Chromium + logged-in `ATLAS_BROWSER_PROFILE`, CONFIG gate knobs, `GATE_CONFIRM_TOKEN` seed.*
- [~] **OUTWARD-02**: Envoy fans one owner intent out to LinkedIn / GitHub README / X / portfolio, drafts each (reading the Codex, GitHub via GitHub MCP), and ships only on confirmation; a public post / payment is never silent and a post can't be un-posted. _(docs/agents/envoy.md, SPEC-CANON §4/§12)_ — *code-complete + verified; owner gates = OUTWARD-01's plus the GitHub App `pull_requests:write` grant (04-02 checkpoint).*

### Meta / Polish (Phase 5)

- [~] **META-01**: Librarian captures a prompt and surfaces it deduped in the Vault prompt-library table (Title link · Tags · Tool · Last used), with the title deep-linking to the full-prompt note and most-used surfaced at top. _(09-prompt-library.md, docs/agents/librarian.md, SPEC-CANON §9)_ — *code-complete + verified; owner gate = 4 human-UAT items (live save→Vault round-trip, bump-key e2e, `/switchboard` live, table rendering).*
- [x] **META-02**: Switchboard exists as a documented design-time routing process (selects the minimal MCP server + tools + OAuth scopes for a goal, reports capability gaps to Flagger), NOT a deployed Worker (per D7). _(10-switchboard.md, docs/agents/switchboard.md)_

## v2 Requirements

Deferred to a future release. Tracked but not in the current roadmap.

(None defined — the design corpus scopes everything above into v1 across Phases 0–5. New scope discovered during build lands here.)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Multi-user / teams / multi-tenant | Atlas serves exactly one owner; no auth-for-others, sharing, or RBAC. |
| Switchboard as a deployed runtime Worker | Per D7 it is a design-time habit consulted ad hoc; a Worker that never fires in production is pure overhead. |
| Autonomous outward actions (Echo/Quill/Usher/Envoy acting without confirm) | Suggest-don't-destroy pillar; captcha/payment are hard stops; a post can't be un-posted, a payment can't be un-paid. |
| Filer auto-archive / auto-delete | Owner requirement: labels only; delete path unreachable by scope (`gmail.modify`, never `mail.google.com/`). |
| Reasoning-agent fallback to a weaker model | Per D5, only Filer falls back (to Workers AI/Llama) during an Anthropic outage; reasoning agents do not degrade. |
| Calendar-date / time estimates in the roadmap | Single-owner velocity unknown until the spine ships; effort is relative (High/Medium/Low). |

## Traceability

Which phases cover which requirements. Each requirement maps to exactly one phase.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SPINE-01 | Phase 0 | Complete |
| SPINE-02 | Phase 0 | Complete |
| SPINE-03 | Phase 0 | Complete |
| SPINE-04 | Phase 0 | Code-complete (owner-gated) |
| SPINE-05 | Phase 0 | Complete |
| CORE-01 | Phase 1 | Code-complete (owner-gated) |
| FILER-01 | Phase 1 | Code-complete (owner-gated) |
| HERALD-01 | Phase 1 | Code-complete (owner-gated) |
| FORGE-01 | Phase 1 | Code-complete (owner-gated) |
| SUNDIAL-01 | Phase 1 | Code-complete (owner-gated) |
| COMPASS-01 | Phase 1 | Code-complete (owner-gated) |
| WEEKLY-01 | Phase 2 | Code-complete (owner-gated) |
| WEEKLY-02 | Phase 2 | Code-complete (owner-gated) |
| CAPTURE-01 | Phase 3 | Code-complete (owner-gated) |
| CAPTURE-02 | Phase 3 | Code-complete (owner-gated) |
| OUTWARD-01 | Phase 4 | Code-complete (owner-gated) |
| OUTWARD-02 | Phase 4 | Code-complete (owner-gated) |
| META-01 | Phase 5 | Code-complete (owner-gated) |
| META-02 | Phase 5 | Complete |

**Coverage:**
- v1 requirements: 19 total
- Mapped to phases: 19
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-01*
*Last updated: 2026-06-09 — milestone v1.0 code-complete: all 19 v1 requirements built across all 6 phases. SPINE-01/02/03/05 + META-02 are `[x]` done; the other 14 are `[~]` code-complete pending owner go-live gates (live OAuth, Secrets Store seed, AI-Gateway ceilings, live smoke, config seeds, UAT — tracked in `.planning/STATE.md` → Blockers). Scope unchanged. (Prior reconciliation: 2026-06-05.)*
