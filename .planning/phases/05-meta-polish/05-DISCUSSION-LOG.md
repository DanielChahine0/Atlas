# Phase 5: Meta / Polish - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-09
**Phase:** 5-Meta / Polish
**Areas discussed:** Librarian capture trigger, Dedupe + derivation intelligence, Switchboard deliverable form, Switchboard gap→Flagger

---

## Librarian capture trigger

| Option | Description | Selected |
|--------|-------------|----------|
| Outbound authed POST | Local surface POSTs prompt+tool to Librarian `/prompt/save`, Bearer constant-time + fail-closed (Phase-3/4 outbound-auth pattern); hotkey binding deferred owner go-live | ✓ |
| Service-binding RPC only | No public endpoint; a cloud-side caller invokes `Librarian.save()` over a binding | |
| Extend an existing daemon channel | Reuse/overload the Obsidian or browser drain | |

**User's choice:** Outbound authed POST.
**Notes:** Matches the established no-inbound-port / outbound-Bearer model; the menubar hotkey binding is owner go-live setup, the Worker + endpoint + mock-POST tests run without it.

---

## Dedupe + derivation intelligence

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic dedupe + Haiku derivation | Normalized tool-scoped similarity (no model on hot path) + Haiku title/tags; overwrite-on-edit; append-only retention | ✓ |
| Fully deterministic (no model) | Both dedupe and title/tags rule-based — cheapest, weaker titles/tags | |
| Model-backed dedupe too | Embeddings / LLM judge for similarity — best matching, but a model call + non-determinism per save | |

**User's choice:** Deterministic dedupe + Haiku derivation.
**Notes:** Keeps the hot path cheap + replay-stable; reserves the LLM for the genuinely linguistic title/tags task. Versioning = overwrite+bump (no history); retention = append-only forever.

---

## Switchboard deliverable form

| Option | Description | Selected |
|--------|-------------|----------|
| Doc + registry + /switchboard command | Runbook + machine-readable MCP registry config + a design-time slash-command/skill that runs the 6-step selection | ✓ |
| Doc + registry config only | Runbook + registry; routing stays a manual habit | |
| Slash-command/skill only | Command with registry inline, no referenceable doc | |

**User's choice:** Doc + registry + /switchboard command.
**Notes:** Operational at design time without deploying a Worker (D7-compliant); the registry config is the editable knob behind the canonical REGISTRY table.

---

## Switchboard gap→Flagger

| Option | Description | Selected |
|--------|-------------|----------|
| Thin authed emit → incidents pipeline | `/switchboard` emits a §6.4 incident via a small authed path reusing `flag()`; gaps land in the Flagger feed | ✓ |
| Manual doc affordance only | Command prints the gap; owner files it; no automated row | |
| Fold emit through an existing Worker | Route the emit through an existing deployed Worker's endpoint | |

**User's choice:** Thin authed emit → incidents pipeline.
**Notes:** Satisfies "reports to Flagger" on the real observability surface; producer-only, no second bus consumer (Pillar 1). Physical location of the emit path is Claude's discretion.

---

## Claude's Discretion

- Exact deterministic similarity algorithm + default threshold (token-set Jaccard / trigram / normalized-hash + near-check).
- CONFIG KV vs `[vars]` for the Librarian knobs (threshold, default tool, note folder/slug base, table sort, vault name).
- Physical location of the Switchboard gap-emit endpoint (tiny shared util vs existing Worker) — producer-only, authed.
- Registry config storage shape (KV blob vs tracked JSON).

## Deferred Ideas

- Cross-tool twins (link Claude+Canva variants) — stay tool-scoped for now.
- Export / copy-back affordance from the table/note.
- Prompt versioning history (chose overwrite).
- Retention / age-out of stale one-offs (chose append-only forever).
- Switchboard learning loop (tune ranking weights from accepted/edited recs).
- Switchboard auto-execute for trivially-safe read-only toolsets (stay always-handoff).
- Switchboard registry freshness/health re-check cadence.
- Owner go-live: bind the real "save this prompt" hotkey + seed Librarian's Bearer secret.
