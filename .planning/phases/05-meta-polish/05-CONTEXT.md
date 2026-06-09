# Phase 5: Meta / Polish - Context

**Gathered:** 2026-06-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Ship the two off-critical-path force-multipliers — **Librarian** (prompt library) and **Switchboard** (design-time capability router) — that polish the system rather than power it. Both are convenience/meta: no morning-chain involvement, no new outward/destructive paths.

- **META-01 — Librarian:** a cloud Worker that captures a prompt on demand ("save this prompt"), derives `title (≤6 words)` / `slug` / `tags[]` / `tool`, tool-scoped-dedupes (bump `uses`+`last_used` on a near-match, never clone), and emits ONE `op:"upsert"` §6.4 Wire event to **Steward**, which renders a full-prompt note + a row in the Vault **Prompt library table** (4 cols: Title-link · Tags · Tool · Last used; default sort `last_used` desc, then `uses` desc; title deep-links to the note via the stable `slug`). Append-only, no gates, writes the Vault only via Steward.
- **META-02 — Switchboard:** per **D7, NOT a deployed Worker** — a documented design-time routing *process* that turns a goal into a minimal, least-privilege toolset (intent → capability → MCP shortlist → exact tools/resources → scope check → executing agent + confirmation-gate flag) and reports capability gaps / missing scopes / unhealthy MCPs to **Flagger**.

**NOT in this phase:** any change to the morning chain, any new outward/irreversible capability, deploying Switchboard as a runtime Worker, the live menubar hotkey binding (owner go-live setup), or new domain agents.
</domain>

<decisions>
## Implementation Decisions

### Librarian — capture trigger (D-01)
- **D-01:** The local capture surface (the Phase-3 daemon / menubar app, outbound-only, no inbound port) POSTs the captured prompt text + `tool` context **outbound** to a Librarian HTTP endpoint (`POST /prompt/save`), authenticated with a **Bearer token, validated constant-time and fail-closed** — the exact pattern of the Phase-3 Obsidian bridge / Phase-4 `/browser/*` endpoints. Librarian validates the Bearer → derives the record → dedupes → emits the Wire `upsert`. Reuse the existing `ATLAS_BRIDGE_TOKEN` Bearer (or a sibling secret) via the shared constant-time gate; never fail-open.
- The actual **menubar hotkey binding is deferred owner go-live setup** (consistent with Echo/Quill local-surface gates) — the Worker + endpoint + mock-POST tests run without it.

### Librarian — dedupe + derivation intelligence (D-02..D-05)
- **D-02 (dedupe = deterministic):** Near-duplicate detection is **deterministic, no model on the hot path** — normalize (trim, lowercase, collapse whitespace, strip volatile bits) then a token-set / trigram similarity **within the `tool` bucket first**, against a KV-configurable threshold. Replay-stable and cheap. Borderline band → keep separate + low-severity/low-trust Flagger pair flag (suggest-don't-destroy); never silently merge.
- **D-03 (derivation = Haiku):** `title (≤6 words)` + `tags[]` are derived by **Haiku via `claudeFor('Librarian', env)`** (AI Gateway, high-volume tier) — a natural LLM task — with the owner free to edit later. `slug` is derived **once** from the first title and is **stable** (never re-derived from a mutated title, so deep-links never break).
- **D-04 (versioning = overwrite):** On a re-save of an existing prompt, **overwrite `full_prompt` and bump `uses` / `last_used`** — no per-edit history note.
- **D-05 (retention = append-only):** The library is **append-only forever** — no age-out of stale `uses==1` one-offs in this phase.

### Switchboard — deliverable form (D-06)
- **D-06:** Ship **all three** (D7-compliant, no deployed Worker): (a) a canonical **process doc / runbook** (formalizing `docs/10-switchboard.md` — the 6-step algorithm + selection heuristics + worked example); (b) a **machine-readable MCP registry config** (KV/JSON: each server → capability tags → representative tools → owning agent → required OAuth scopes — the editable knob behind the REGISTRY table); (c) a **Claude Code slash-command / skill `/switchboard <goal>`** that runs the 6-step selection at **design time**, reading the registry and the Codex, and returns the ranked toolset recommendation JSON (server(s) → exact tools → resources → scopes → executing agent → confirmation-gate flag).

### Switchboard — gap → Flagger (D-07)
- **D-07:** When `/switchboard` finds a gap (no MCP for a required capability, a missing/un-granted OAuth scope, or a disconnected/unhealthy MCP), it emits a **§6.4 incident through the existing incidents pipeline** via a thin authed emit reusing the shared `flag()` helper — so gaps land in the **Flagger feed** like any other incident (the observability surface the success criterion implies), NOT just console output. Severity per `docs/10-switchboard.md` (no-MCP → P3; blocks in-flight goal → P2; missing scope → P3 consent; ungated outward toolset → P1). The emit path must NOT introduce a second `atlas-wire`/`atlas-incidents` consumer (Pillar 1) — it is a producer only.

### Carried forward (locked in prior phases — do NOT re-ask)
- **Pillar 1 — one writer:** Steward is the SOLE Vault writer; Librarian only emits §6.4 events. No new `atlas-wire` consumer in Librarian or any Switchboard emit path.
- **Wire contract:** `{ agent, type, entity, op, payload, idempotencyKey }`; `op:"upsert"` for the prompt note + table row; **structured, stable `idempotencyKey`** (e.g. `librarian:<slug>:save` / `:save:<date>` for a bump) so a replayed save can't double-count `uses` or clone a row — never `crypto.randomUUID()` for the keyed path.
- **Secrets only via bindings;** constant-time, fail-closed token gates on any inbound endpoint (mirror `packages/gate` auth + `mcp-obsidian-bridge`). TZ=UTC in workerd → owner-local time via `Intl` `America/Toronto`. D1 positional `?` params.
- **Model tiering** lives in `[vars]`/KV via `claudeFor`/`modelFor`, never hardcoded in code; all Claude via the AI Gateway.

### Claude's Discretion
- Exact similarity algorithm (token-set Jaccard vs trigram vs normalized-hash + cheap near-check) and the default threshold value — planner/researcher picks; keep it deterministic + replay-stable per D-02.
- Whether the `slug` namespace/note folder, default `tool`, table sort, and dedupe threshold are new CONFIG KV keys vs `[vars]` (Librarian Config table in `docs/09-prompt-library.md` lists them as KV).
- Where the thin Switchboard gap-emit endpoint physically lives (a tiny shared util path vs an existing Worker) — keep it producer-only and authed.
- Registry config storage shape (KV blob vs a tracked JSON read by the command).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Librarian (META-01)
- `docs/09-prompt-library.md` — full Librarian feature spec: capture flow, canonical record shape, the note format, the 4-column table layout, deep-linking via stable `slug`, dedupe (tool-scoped, bump-don't-replace), most-used surfacing, failure→Flagger table, Config knobs.
- `docs/agents/librarian.md` — agent-doc companion: the exact §6.4 `prompt.save` Wire event shape, the field table, the example run (new + dedupe-bump), schedule (on-demand only).
- `docs/SPEC-CANON.md` §9 — authoritative record shape + 4-column table contract (wins all conflicts).
- `docs/05-dashboard.md` (§6.2 Vault views) — where the Prompt library table view lives in the dashboard; Steward render target.

### Switchboard (META-02)
- `docs/10-switchboard.md` — the narrative reference: the 6-step selection algorithm, selection heuristics, the REGISTRY table (server → best-at → tools → owning agent → scopes), the capability→MCP quick map, the worked example + assembled-toolset JSON, failure→Flagger table, Config (registry in KV, side-effect policy, ranking weights, Opus model tier).
- `docs/agents/switchboard.md` — build-facing card: at-a-glance, algorithm, registry, report shape, example run.
- `docs/06-hosting-cloudflare-mcp.md` — the MCP registry source of truth (which servers are connected/healthy); the Connect-a-new-MCP checklist Switchboard's registry mirrors.
- `docs/07-source-of-truth-codex.md` — the Codex (read-only identity/account facts) used in Switchboard's scope/resource resolution.

### Shared
- `docs/08-flagger.md` §8 — severity + trust model for Librarian failure flags and Switchboard gap reports.
- `docs/03-scheduling.md` §10 — on-demand (non-cron) trigger model both agents use.
- `.planning/REQUIREMENTS.md` — META-01, META-02 acceptance.
- `.planning/ROADMAP.md` (Phase 5 detail) — goal + success criteria + D7.
- `CLAUDE.md` — the 5 pillars + security invariants, PINNED versions, canonical binding names, Definition-of-Done three tests.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`packages/gate/src/auth.ts` `timingSafeEqual` / the `mcp-obsidian-bridge` Bearer gate** — the constant-time, fail-closed token-validation pattern to reuse on Librarian's `POST /prompt/save` (D-01) and the Switchboard gap-emit endpoint (D-07).
- **`packages/wire` `send()` + the §6.4 `WireEvent` zod schema** — Librarian's single emit path (`op:"upsert"`); the only WireEvent definition (CI gate).
- **`@atlas/shared` `flag()` + `RawIncident` / the `atlas-incidents` producer** — Librarian failure flags + Switchboard gap→Flagger (D-07); reuse the single flag-id authority, producer-only.
- **`@atlas/model` `claudeFor` / `modelFor`** — Haiku title/tags derivation (D-03); tiering via KV/[vars], AI Gateway only.
- **`@atlas/shared` `localDate` + the `Intl`/`America/Toronto` helper** — owner-local `created`/`last_used` timestamps under workerd UTC.
- **The Phase-3 `daemon/`** (outbound-only, Bearer-authed drains) — the local capture surface that will POST to `/prompt/save`; the `drain.ts`/`browser-drain.ts` outbound-auth structure is the analog.

### Established Patterns
- **Steward is fed, never fetches:** Librarian emits a record; Steward (sole serialized consumer) renders the note + table row. A NEW Steward render path for the Prompt library table view + prompt notes (`prompts/<slug>.md`) is required — Steward-side, keyed on `slug`, idempotent upsert. (Planner: confirm whether Steward's existing op→render map covers an upsert to a new view or needs an addition.)
- **Idempotency:** structured stable keys; replay ⇒ `meta.changes === 0`; a dedupe bump is an upsert on the SAME `slug` (no new row).
- **No second bus consumer** anywhere in this phase (Pillar 1 hard CI gate).

### Integration Points
- Librarian `POST /prompt/save` (inbound, authed) ← local capture surface (outbound).
- Librarian → `WIRE` (`atlas-wire`) → Steward → Obsidian bridge → Vault (note + Prompt library table view).
- Librarian/Switchboard → `INCIDENTS` (`atlas-incidents`) → Flagger (failures / capability gaps).
- `/switchboard` command → MCP registry config (KV/JSON) + Codex (read-only) → ranked toolset JSON; gap → thin authed emit → incidents pipeline.
- CONFIG KV keys (per Librarian Config table): dedupe threshold, default `tool`, note folder/`slug` base, table sort, vault name (for `obsidian://` deep links).
</code_context>

<specifics>
## Specific Ideas

- Prefer the **relative note link** form (`[Title](prompts/<slug>.md)`) in the table; reserve the `obsidian://open?vault=…&file=…` form for links surfaced outside the Vault (push/menubar).
- Switchboard's recommendation must always carry the **confirmation-gate flag + executing agent** for any outward/irreversible intent (Pillar 2) and must never recommend a second writer for a resource an existing agent owns (Pillar 1) — these are hard rules in the selection algorithm, not options.
- Switchboard reuses **Context7 docs** (`resolve-library-id` / `query-docs`) for unknown libraries during design-time routing (per its doc), but calls no domain/write tools itself.
</specifics>

<deferred>
## Deferred Ideas

- **Cross-tool twins** — linking a Claude prompt and its Canva equivalent as variants of one idea. Stay strictly tool-scoped per the dedupe design; revisit later if needed.
- **Export / copy-back affordance** — a "copy full prompt" button from the table/note for fast paste-back. Nice-to-have, not this phase.
- **Prompt versioning history** — keeping a per-edit history instead of overwrite (D-04 chose overwrite). Future enhancement.
- **Retention / age-out** — aging out stale `uses==1` one-offs (D-05 chose append-only forever). Future.
- **Switchboard learning loop** — recording which recommendations the owner accepted/edited and tuning ranking weights over time. Future.
- **Switchboard auto-execute** — letting trivially-safe read-only toolsets run inline instead of always-handoff. Future; stay always-handoff for now.
- **Switchboard registry freshness/health cadence** — automated MCP health re-check; the design-time command reads a snapshot, planner decides staleness handling.

### Owner go-live (deferred, tracked — not phase-incomplete)
- Binding the real "save this prompt" hotkey in the menubar app + seeding Librarian's Bearer secret (same class as the Echo/Quill local-surface go-live gates).
</deferred>

---

*Phase: 5-Meta / Polish*
*Context gathered: 2026-06-09*
