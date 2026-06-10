# Synthesis Summary — Atlas doc ingest

> Single entry point for downstream consumers (gsd-roadmapper). This summarizes what was
> synthesized from the classified document set. Detail lives in the per-type intel files and the
> conflicts report linked below.

> ⚠️ **Superseded snapshot (2026-06-01 doc-ingest bootstrap).** Pre-execution synthesis of the design
> corpus — kept for provenance only. For CURRENT project state use `.planning/STATE.md`,
> `.planning/ROADMAP.md`, and `.planning/REQUIREMENTS.md` (milestone v1.0 — all 6 phases — completed
> 2026-06-09; the finalized requirement set is the 19 IDs in REQUIREMENTS.md, not the count derived here).

Mode: new (net-new bootstrap — no existing .planning/ context)
Precedence: ADR > SPEC > PRD > DOC. Authoritative source: docs/SPEC-CANON.md.
Project: Atlas — a personal multi-agent orchestrator on Cloudflare running a fleet of 16
specialized sub-agents (+ the Atlas orchestrator). The repo is a completed design spec.

## Doc counts by type (32 total)
- SPEC: 23  — SPEC-CANON, 02-architecture*, 03-scheduling, 04-email-taxonomy, 05-dashboard,
  06-hosting-cloudflare-mcp, 07-source-of-truth-codex, 08-flagger, 09-prompt-library, 10-switchboard,
  11-security-privacy, and per-agent specs: atlas*, compass, echo, filer, flagger, forge, headhunter,
  herald, scout, steward, sundial, switchboard.
  (*02-architecture is DOC-typed; corrected count below. See note.)
- DOC: 9   — 00-overview, 01-agent-roster, 02-architecture, 12-roadmap, 13-build-plan,
  agents/archivist, agents/envoy, agents/librarian, agents/quill, agents/usher.
- ADR: 0
- PRD: 0
- UNKNOWN: 0
  Note: by classification JSON, the exact split is SPEC=23, DOC=9. (02-architecture is SPEC; the
  9 DOCs are 00-overview, 01-agent-roster, 12-roadmap, 13-build-plan, archivist, envoy, librarian,
  quill, usher.) Two SPECs were medium-confidence (06-hosting, agents/atlas) — confidently SPEC,
  medium only because they mix prose/rationale with their contracts.

## Decisions locked
- 0 locked. There are no ADRs in the corpus and nothing is marked locked.
- 7 settled cross-doc positions recorded (decision log D1–D7 from docs/13-build-plan.md), status
  "decided, not locked": DEC-cron-timezone, DEC-d1-authoritative, DEC-r2-audio-retention,
  DEC-local-daemon-transport, DEC-model-routing-cost, DEC-quill-phase-placement,
  DEC-switchboard-design-time. Plus the 5 SPEC-CANON §0 design pillars.
- File: .planning/intel/decisions.md

## Requirements extracted
- 11 derived REQ units (no PRDs exist; these are distilled from the canonical roadmap + build-plan
  acceptance criteria): REQ-spine-orchestration, REQ-core-loop-morning-pipeline, REQ-filer-email-
  labeling, REQ-herald-digest, REQ-forge-task-extraction, REQ-sundial-calendar-sync,
  REQ-compass-day-plan, REQ-weekly-value, REQ-capture-local, REQ-outward-gated, REQ-meta-polish.
- MVP scope (canonical): Phase 0 Spine + Phase 1 Core loop (= milestones M0 + M1).
- File: .planning/intel/requirements.md

## Constraints extracted
- 18 constraints across the 23 SPECs. Type breakdown:
  - schema (7): CON-wire-event-contract, CON-email-taxonomy, CON-flag-schema, CON-codex-schema,
    CON-prompt-library-record, CON-task-store-schema, CON-audit-log-schema.
  - protocol (7): CON-steward-single-writer, CON-idempotency-ledger, CON-filer-labels-only,
    CON-scheduling-clock, CON-timezone-policy, CON-cloudflare-primitive-map, CON-oauth-least-privilege,
    CON-confirmation-gates. (8 listed — protocol-heavy set.)
  - nfr (3): CON-d1-system-of-record, CON-security-mail-redaction, CON-local-capture-boundary.
  - api-contract (1): CON-mcp-connectivity.
- File: .planning/intel/constraints.md

## Context topics
- 8 topics distilled from the 9 DOCs: What Atlas is; Agent roster; Importance tiers; Architecture &
  pipelines; Roadmap/phases & MVP; Build plan & milestones; Owner inputs still needed; Per-agent
  companion docs.
- File: .planning/intel/context.md

## Conflicts
- 0 blockers
- 0 competing-variants (no PRDs -> no competing acceptance criteria)
- 3 auto-resolved (INFO): agent-count phrasing reconciled to canon; SPEC open questions settled by the
  build-plan decision log D1–D7; librarian.md (DOC) schema deferred to 09-prompt-library.md (SPEC).
- Report: .planning/INGEST-CONFLICTS.md

## Pointers
- Decisions:    .planning/intel/decisions.md
- Requirements: .planning/intel/requirements.md
- Constraints:  .planning/intel/constraints.md
- Context:      .planning/intel/context.md
- Conflicts:    .planning/INGEST-CONFLICTS.md
