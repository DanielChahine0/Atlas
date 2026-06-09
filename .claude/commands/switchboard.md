---
description: "Given a goal, run the 6-step Switchboard selection algorithm to produce a minimal, least-privilege toolset recommendation. Applies Pillar-1 (no second writer) and Pillar-2 (gate outward intents) hard rules. On a gap, outputs a severity-annotated §6.4 RawIncident JSON and the one-command producer-only emit path. Use at design time when you need to know which MCP server + tools + agent to use for a new goal."
argument-hint: <natural-language goal>
allowed-tools: Read, Glob, mcp__context7__resolve-library-id, mcp__context7__query-docs, WebSearch
model: inherit
---

Run the Switchboard 6-step selection algorithm for goal: `$ARGUMENTS`

Switchboard is design-time only — it recommends, it NEVER acts. No Write, Edit, or Bash.

---

## Step 0 — Load source of truth (read-only)

Read these files before proceeding:

1. `.claude/registry/mcp-registry.json` — the machine-readable server list (health, owning_agents, scopes, side_effect_verbs, ranking_weights)
2. `docs/10-switchboard.md` — the full 6-step runbook, selection heuristics, worked example, gap severity table
3. `docs/agents/switchboard.md` — the canonical recommendation JSON shape
4. `CLAUDE.md` lines 1–80 — the 5 pillars and security invariants (especially Pillar 1 + Pillar 2)

---

## Step 1 — Intent extraction

Parse `$ARGUMENTS`:

- Extract: `verb`, `object`, `outcome`
- Classify the side-effect: **read-only** OR **outward-irreversible**
  - A verb is outward-irreversible if it appears in the registry `side_effect_verbs` array (post, register, pay, delete, submit, send, publish, etc.)

---

## Step 2 — Capability map

Translate the intent into abstract capabilities (NOT product names):

- Examples: `email-read`, `email-draft`, `calendar-write`, `web-automation`, `code-read`, `vault-write`, `file-read`, `design-generation`, `library-docs`
- List ALL capabilities required to complete the goal end-to-end (do not skip a step)

---

## Step 3 — MCP shortlist

For each capability, select the best server from the registry:

**HARD RULE — PILLAR 1 (no second writer):** Check the `owning_agents` field for each server. If a resource already has a registered owning agent, you MUST route through that agent — NEVER recommend a different agent to write that resource. Examples:
- Vault writes → Steward only (Obsidian server, owning_agents: ["Steward"])
- Calendar writes → Sundial or Usher (Google Calendar, owning_agents: ["Sundial","Usher","Compass"])
- GitHub portfolio writes → Envoy (GitHub, owning_agents: ["Envoy"])
- Email labeling → Filer only (Gmail, owning_agents: ["Filer","Herald"])

**Ranking rules** (from `ranking_weights`):
1. Specificity: first-party MCP (e.g. Google Calendar) beats Playwright for the same capability
2. Read before write: prefer read-only tools if the goal can be met without mutation
3. Health: drop servers with `health: "absent"` entirely; penalize `health: "degraded"` (-0.4 weight)

**GAP:** If no connected server covers a required capability → see the Gap Protocol below (do NOT silently skip the capability).

---

## Step 4 — Tool + resource resolve

For each shortlisted server, pick the **minimal** tool set:

- Only tools actually needed to complete the goal (no "all of Gmail")
- Bind concrete resources: the event URL, a file ID, the primary calendar ID, Codex identity fields, etc.
- Read resources from the Codex (read-only personal facts) when available — the Codex is NOT an MCP server; it is a read-only data source

---

## Step 5 — Scope check

For each tool, list the required OAuth scope from the registry `scopes` field:

- If the scope is already in the registry as the server's standard scope → mark `scope_status: "all-granted"`
- If a scope is NOT in the registry or requires a new consent → mark `scope_status: "needs-consent: <scope>"` and emit a Gap incident (see Gap Protocol, P3 severity)
- Do NOT proceed with a write action if consent is missing — flag for consent instead

---

## Step 6 — Assemble toolset

**HARD RULE — PILLAR 2 (gate outward intents):** If the intent's verb is in `side_effect_verbs` OR the side-effect is `outward-irreversible`:
- Set `confirmation_gate: true` in the output
- Name the executing agent that owns the confirmation gate (Usher for registrations, Envoy for publishing)
- An outward toolset with `confirmation_gate: false` or missing is a P1 gap — output the Gap incident immediately (see Gap Protocol)

Output the assembled toolset JSON (the canonical shape from `docs/agents/switchboard.md`):

```json
{
  "goal": "<verbatim goal>",
  "intent": { "verb": "...", "object": "...", "outcome": "..." },
  "side_effect": "read-only | outward-irreversible",
  "confirmation_gate": true,
  "executing_agent": "...",
  "mcps": [
    { "server": "...", "tools": ["..."], "scopes": ["..."] }
  ],
  "resources": ["..."],
  "scope_status": "all-granted | needs-consent: <scope>",
  "rationale": "...",
  "downstream": ["Wire event → Steward: <counter> ++"],
  "trust": 88
}
```

---

## Gap Protocol — D-07 severity-annotated §6.4 RawIncident

When a gap is detected (no server for a capability, unhealthy MCP blocks goal, missing scope, or ungated outward toolset), output a **severity-annotated §6.4 RawIncident** using the D-07 severity map from the registry `gap_severity_map`:

| Gap type | `severity_hint` | `kind` |
|----------|-----------------|--------|
| No connected MCP for a required capability | `P3` | `capability_gap` |
| Required MCP is disconnected/unhealthy AND blocks the current goal | `P2` | `unhealthy_mcp` |
| Missing or un-granted OAuth scope (requires owner consent) | `P3` | `missing_scope` |
| Outward/irreversible toolset assembled WITHOUT a confirmation gate | `P1` | `ungated_outward` |

**Output the RawIncident JSON** (the exact shape that `flag()` in `@atlas/shared` enqueues onto `atlas-incidents`):

```json
{
  "source_agent": "Switchboard",
  "severity_hint": "P3",
  "kind": "capability_gap",
  "title": "No connected MCP for capability: <capability-name>",
  "detail": "Goal: <goal>. Required capability: <capability>. No server with health=connected covers this. Suggested action: connect the <server-name> MCP or implement a new MCP server.",
  "suggested_action": "Connect the <server-name> MCP server — see docs/06-hosting-cloudflare-mcp.md §11 for the checklist."
}
```

**Documented one-command producer-only emit path** (copy-paste to land the gap in the Flagger feed):

The gap RawIncident above is the exact payload for `flag()` from `@atlas/shared`. To emit it from any Worker that has the `INCIDENTS` binding (e.g. during a build step or a manual trigger):

```typescript
// ONE-COMMAND EMIT — producer only, no new consumer
// Uses the existing flag() helper from @atlas/shared (packages/shared/src/flag.ts)
// INCIDENTS binding → atlas-incidents Queue → Flagger (sole consumer)
import { flag } from "@atlas/shared";

await flag(
  env,                                    // env must have INCIDENTS: Queue<RawIncident>
  "P3",                                   // severity from gap_severity_map
  "No connected MCP for capability: <capability>",   // title
  "Goal: <goal>. Required: <capability>. No connected server found.",  // detail
  {
    sourceAgent: "Switchboard",
    kind: "capability_gap",               // from gap_severity_map
    suggestedAction: "Connect the <server> MCP — see docs/06-hosting-cloudflare-mcp.md §11."
  }
);
```

This emit path is **producer-only**: it reuses the existing `atlas-incidents` Queue producer. Flagger is the sole `atlas-incidents` consumer. Switchboard adds NO new Queue consumer (Pillar 1, D-07). Switchboard itself is NOT a deployed Worker — the operator copies this snippet into the relevant context (a build step, a local script with the `INCIDENTS` binding) to surface the gap.

---

## Output format

Always return:

1. The assembled toolset JSON (Step 6), OR
2. A Gap RawIncident JSON + the documented emit path (Gap Protocol), OR
3. Both (if some capabilities are covered and some have gaps)

End with a one-paragraph `rationale` explaining why this server/agent combination was chosen over alternatives.
