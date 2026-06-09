# Switchboard — Capability Router

**Purpose:** Given a prompt or goal, **Switchboard** picks the best MCP server plus the exact tools and resources (and scopes) needed to achieve it, then hands a ready-to-use toolset to the executing agent. It is a **design-time** advisor — it recommends, it does not run in the morning loop and it does not act.

## At a glance

| | |
|---|---|
| **Codename** | **Switchboard** (capability router) |
| **Roster #** | 14 (SPEC §2) |
| **Importance** | Tier 4 — meta/force-multiplier, **not on the critical path** (SPEC §3 #16) |
| **Runtime** | Design-time only — `/switchboard` Claude Code slash-command; **NOT a deployed Worker** (D-07) |
| **Trigger** | **on-demand (design time)** — user-initiated (SPEC §10) |
| **Inputs** | A natural-language prompt/goal; optional constraints (which accounts are connected, scope budget) |
| **Outputs** | A ranked **toolset recommendation**: MCP server(s) + exact tool list + required resources + required OAuth scopes + executing agent |
| **Dependencies** | The MCP **registry** (which servers are connected and healthy — see [hosting](06-hosting-cloudflare-mcp.md)); **The Codex** for identity/account facts |
| **MCPs/tools** | Reads the registry of remote MCP servers; calls **no** domain tools itself |
| **Writes to** | **Recommendations only** (SPEC §2). It never mutates an external system. Recommendations may be logged to the Vault via [Steward](agents/steward.md) |

> **Design-time, not run-time.** Per SPEC §4: *"Switchboard is consulted at design time when a new capability is needed; it doesn't run in the loop."* When you (or Atlas) hit a goal with no obvious agent, you ask Switchboard *"what do I need to do this?"* — it answers with a toolset; the chosen agent then executes behind the usual confirmation gates (SPEC §12).

> **How to invoke:** Use the `/switchboard <goal>` Claude Code slash-command (`.claude/commands/switchboard.md`). It reads the machine-readable MCP registry at `.claude/registry/mcp-registry.json`, runs the 6-step algorithm below, and returns a ranked toolset recommendation JSON. The command is read-only (allowed-tools: Read, Glob, context7, WebSearch) — it never writes, edits, or runs shell commands. Switchboard is **NOT a deployed Worker** (D-07).

---

## What it does

Atlas has ~12 connected MCP servers, each exposing dozens of tools. For any given goal, only a handful of tools across one or two servers are relevant. Switchboard solves the **selection problem**:

1. Read the **intent** behind a prompt ("register me for this event", "publish my new project", "summarize this PR").
2. Map intent → the **capabilities** required (browser automation, calendar write, code read).
3. Shortlist the **MCP server(s)** that provide those capabilities, using the registry below.
4. Resolve the **exact tools** and **resources** needed — no more (least privilege) and no fewer (no missing step).
5. Determine the **required OAuth scopes** and confirm they are already granted; flag if a new scope/consent is needed.
6. **Assemble** the toolset and name the **executing agent** that should run it.

It is the difference between handing an agent "all of Gmail + all of Calendar + a browser" versus "`browser_navigate`, `browser_fill_form`, `browser_click` + `create_event` + the event URL." Narrower toolsets are faster, cheaper, and safer.

---

## How it works — the selection algorithm

```
                          ┌──────────────────────────────┐
   prompt / goal  ───────▶│ 1. INTENT EXTRACTION         │
                          │    verb + object + outcome   │
                          └───────────────┬──────────────┘
                                          ▼
                          ┌──────────────────────────────┐
                          │ 2. CAPABILITY MAP            │
                          │    intent → required caps    │
                          │    (read / write / browse /  │
                          │     transcribe / publish …)  │
                          └───────────────┬──────────────┘
                                          ▼
                          ┌──────────────────────────────┐     ┌─────────────────┐
                          │ 3. MCP SHORTLIST             │◀────│  REGISTRY        │
                          │    cap → best server(s)      │     │  (connected +    │
                          │    rank by fit & health      │     │   healthy MCPs)  │
                          └───────────────┬──────────────┘     └─────────────────┘
                                          ▼
                          ┌──────────────────────────────┐
                          │ 4. TOOL + RESOURCE RESOLVE   │
                          │    pick exact tools; bind    │
                          │    resources (URLs, IDs)     │
                          └───────────────┬──────────────┘
                                          ▼
                          ┌──────────────────────────────┐
                          │ 5. SCOPE CHECK               │
                          │    required OAuth scopes      │
                          │    granted? else flag consent │
                          └───────────────┬──────────────┘
                                          ▼
                          ┌──────────────────────────────┐
                          │ 6. ASSEMBLE TOOLSET          │
                          │    → executing agent          │
                          └──────────────────────────────┘
```

### Step detail

| # | Step | What happens | Example |
|---|------|--------------|---------|
| 1 | **Intent extraction** | Reduce the prompt to `verb` + `object` + `outcome`. Detect side-effects (read-only vs. outward/irreversible). | "register me for **this event**" → verb=`register`, object=event page, outcome=confirmed + on calendar; **outward/irreversible** |
| 2 | **Capability map** | Translate intent into abstract capabilities, not products. | needs `web-automation` (fill a registration form) + `calendar-write` (add the event) |
| 3 | **MCP shortlist** | For each capability, pick the best-fit server(s) from the **registry**. Drop any server that is disconnected or unhealthy (registry health from [hosting](06-hosting-cloudflare-mcp.md)). | `web-automation` → **Playwright**; `calendar-write` → **Google Calendar** |
| 4 | **Tool + resource resolve** | Choose the *minimal* tool set per server; bind concrete resources (the event URL, a file ID, a calendar ID). | `browser_navigate`, `browser_snapshot`, `browser_fill_form`, `browser_click` + `create_event`; resource = event URL, Codex identity fields |
| 5 | **Scope check** | List the OAuth scopes each tool requires; confirm they are already granted to that agent (least-privilege, SPEC §12). If a new scope is needed, **flag for consent** rather than proceeding. | Calendar write needs `calendar.events`; if only read is granted, raise a consent flag |
| 6 | **Assemble toolset** | Output the bundle and name the **executing agent** that owns this work. | Hand to **Usher** (event registration) + note the **Codex** confirmation gate before the final submit |

### Selection heuristics (how step 3 ranks)

- **Specificity beats generality.** A first-party server (Google Calendar) beats driving the same site through a browser, when both can do the job. Reserve **Playwright** for sites with no MCP.
- **Read before write.** If the goal can be met read-only, never shortlist write tools.
- **One writer per resource (SPEC pillar 1) — HARD RULE.** Switchboard NEVER recommends a second writer for a resource an existing agent owns. Check the `owning_agents` field in the registry for every server shortlisted. Route any Vault write through [Steward](agents/steward.md); any outward publishing through [Envoy](agents/envoy.md); any calendar write through [Sundial](agents/sundial.md)/[Usher](agents/usher.md). A writer collision is a blocker — re-route, never override.
- **Gate the irreversible (SPEC pillar 2 / §12) — HARD RULE.** If the intent's verb appears in the registry `side_effect_verbs` list (post, register, pay, delete, submit, send, publish, …), the recommendation **MUST** include `confirmation_gate: true` and name the executing agent ([Usher](agents/usher.md)/[Envoy](agents/envoy.md)). An ungated outward toolset is a **P1 Critical** gap — emit a gap incident immediately; never silently deliver an ungated recommendation (SPEC §12, D-07).
- **Health-aware.** A disconnected (`health: "absent"`) MCP is excluded from the shortlist entirely; a degraded MCP is penalized. A gap resulting from a disconnected MCP that blocks the in-flight goal is a P2 flag (see Failure modes below).

---

## REGISTRY — known MCP servers

> **Machine-readable source:** The registry table below is mirrored as a tracked JSON file at **`.claude/registry/mcp-registry.json`** — the editable knob the `/switchboard` slash-command reads at design time (no runtime KV required). Update both when adding a new MCP server.

This is the lookup table behind step 3. "Best at" is what Switchboard optimizes for; "Owning agent(s)" lists the **writers** for that server (the Pillar-1 hard-rule input — never route a write to anyone else); read-only users are noted inline.

| MCP server | Best at | Representative tools | Owning agent(s) | Typical scopes |
|------------|---------|----------------------|-----------------|----------------|
| **Gmail** | Email triage, labeling, drafting (never delete) | `list_labels`, `search_threads`, `get_thread`, `label_thread`, `create_draft` | [Filer](agents/filer.md) (labels), [Herald](agents/herald.md) (drafts) | `gmail.modify` (Filer labels) / `gmail.readonly` + `gmail.compose` (Herald drafts), **not** delete (SPEC §12) |
| **Google Calendar** | Reading & writing events, finding free time | `list_events`, `get_event`, `create_event`, `update_event`, `suggest_time`, `respond_to_event` | [Sundial](agents/sundial.md), [Usher](agents/usher.md) — [Compass](agents/compass.md) reads only | `calendar.events` (write) / `calendar.readonly` (Compass) |
| **Google Drive** | Cloud docs/files: read content, search, store exports | `search_files`, `read_file_content`, `get_file_metadata`, `create_file`, `copy_file` | [Steward](agents/steward.md), Codex sync | `drive.file` / `drive.readonly` |
| **Google Sheets** | Tabular/structured data: trackers, funnels, logs | (Sheets read/write) | Headhunter, Steward | `spreadsheets` |
| **GitHub** | Code, PRs, issues, releases, repo metadata | `get_file_contents`, `search_code`, `list_pull_requests`, `pull_request_read`, `issue_read`, `create_pull_request` | [Envoy](agents/envoy.md) (portfolio/projects), Dev triage | GitHub App, least-privilege repo scopes |
| **Obsidian** | The **Vault** — notes, dashboard, tags (local bridge) | `read-note`, `search-vault`, `create-note`, `edit-note`, `add-tags` | **[Steward](agents/steward.md) only** (sole Vault writer) | local MCP bridge (SPEC §7) |
| **Playwright / browser** | Driving any site with no first-party MCP: forms, clicks, captcha-adjacent flows | `browser_navigate`, `browser_snapshot`, `browser_fill_form`, `browser_click`, `browser_type`, `browser_take_screenshot` | [Usher](agents/usher.md), [Envoy](agents/envoy.md) | none (browser session); gated by SPEC §12 |
| **Canva** | Design generation/export for brand assets | `generate-design`, `create-design-from-brand-template`, `export-design`, `get-design-thumbnail` | [Envoy](agents/envoy.md) ([Librarian](09-prompt-library.md) only stores `tool:"Canva"` prompts — not an owner) | Canva OAuth |
| **Notion** | External structured docs/databases (when used) | `notion-search`, `notion-fetch`, `notion-create-pages`, `notion-update-page` | (optional) | Notion OAuth |
| **Slack** | Team/channel messaging, search, scheduled sends | `slack_search_public`, `slack_read_channel`, `slack_send_message`, `slack_schedule_message` | (optional) | Slack OAuth |
| **Context7 docs** | Current library/framework/SDK/API documentation | `resolve-library-id`, `query-docs` | Switchboard itself, Dev work | none |

> **Registry source of truth:** which of these are actually connected, authenticated, and healthy is owned by the hosting layer — see **[hosting & Cloudflare MCP](06-hosting-cloudflare-mcp.md)** (remote MCP servers on Workers, Cloudflare Agents SDK, OAuth Provider). Switchboard reads that state; it does not manage connections.

### Capability → MCP quick map

| Capability | First choice | Fallback |
|------------|--------------|----------|
| Read/label/draft email | **Gmail** | — |
| Read/write calendar events | **Google Calendar** | Playwright (if the source has no API) |
| Read cloud docs/files | **Google Drive** | — |
| Tabular trackers/funnels | **Google Sheets** | Drive |
| Code / PR / repo facts | **GitHub** | Playwright (web UI only) |
| Vault notes / dashboard | **Obsidian** (via [Steward](agents/steward.md)) | — |
| Drive an arbitrary website | **Playwright / browser** | — |
| Design / brand visuals | **Canva** | — |
| External structured docs | **Notion** | Drive |
| Team chat | **Slack** | — |
| Up-to-date library docs | **Context7 docs** | web search |

---

## Worked example — "register me for this event"

**Prompt:** *"Register me for this event"* + a link to an event registration page.

```
1. INTENT
   verb = register, object = <event page URL>, outcome = registered + on my calendar
   side-effect class = OUTWARD / IRREVERSIBLE  →  confirmation gate required (§12)

2. CAPABILITY MAP
   - web-automation   : the event site has no first-party MCP → must drive the page
   - identity-fill    : name/email/phone come from The Codex
   - calendar-write   : add the confirmed event to Google Calendar

3. MCP SHORTLIST
   - web-automation → Playwright / browser   (no Eventbrite/etc. MCP in registry)
   - calendar-write → Google Calendar
   (Codex is data, not an MCP — read directly)

4. TOOL + RESOURCE RESOLVE
   Playwright : browser_navigate, browser_snapshot, browser_fill_form,
                browser_click, browser_take_screenshot   (evidence before submit)
   Calendar   : create_event
   Resources  : event URL ; Codex identity fields (first name→Daniel,
                last name→Chahine, email→…) ; primary calendar ID

5. SCOPE CHECK
   - browser session : no OAuth scope (session only)
   - calendar.events : write scope — confirm granted to Usher, else flag consent

6. ASSEMBLE → EXECUTING AGENT
   Toolset above → Usher (event registration + calendar add)
   Codex provides the autofill values (cf. Quill's field-map approach)
   GATE: Usher fills the form, screenshots the review screen, and STOPS for
         explicit owner confirmation before the final "Submit/Pay" (SPEC §12).
   On success: create_event, then Usher → the Wire → Steward (events attended++).
```

**Assembled toolset returned by Switchboard:**

```json
{
  "goal": "register me for this event",
  "executing_agent": "Usher",
  "side_effect": "outward-irreversible",
  "confirmation_gate": true,
  "mcps": [
    {
      "server": "Playwright / browser",
      "tools": ["browser_navigate", "browser_snapshot", "browser_fill_form",
                "browser_click", "browser_take_screenshot"],
      "scopes": []
    },
    {
      "server": "Google Calendar",
      "tools": ["create_event"],
      "scopes": ["calendar.events"]
    }
  ],
  "resources": ["<event URL>", "Codex: identity fields", "primary calendar ID"],
  "downstream": ["Wire event → Steward: events attended ++"]
}
```

> The prompt header mentions **Codex** as a third element ("Playwright + Calendar + Codex"): the **Codex** is not an MCP server — it is the read-only source of identity facts (SPEC §11) that supply the autofill values for the registration form, exactly as [Quill](agents/quill.md) maps form-field labels → Codex fields.

---

## Inputs / Outputs

**Inputs**
- A natural-language **prompt/goal**.
- Optional **constraints:** scope budget (read-only vs. allow-write), which accounts are connected, deadline.
- The **registry** snapshot (connected + healthy MCPs) from [hosting](06-hosting-cloudflare-mcp.md).
- **The Codex** (read-only) for account/identity context.

**Outputs**
- A ranked **toolset recommendation** (the JSON bundle above): MCP server(s) → exact tools → resources → scopes → executing agent → confirmation-gate flag.
- A **gap report** when no connected MCP covers a required capability (routed to [Flagger](08-flagger.md)).
- Optional: a log entry of the recommendation, written to the Vault **via [Steward](agents/steward.md)** (Switchboard never writes the Vault directly).

---

## Dependencies

- **Registry / hosting** — [06-hosting-cloudflare-mcp.md](06-hosting-cloudflare-mcp.md): which MCP servers exist on Workers, their auth state and health.
- **The Codex** ([07-source-of-truth-codex.md](07-source-of-truth-codex.md)) — account & identity context (read-only).
- **Executing agents** — Switchboard hands work to the agent that owns the chosen capability: [Usher](agents/usher.md), [Envoy](agents/envoy.md), [Sundial](agents/sundial.md), [Filer](agents/filer.md), etc. It never executes itself.
- **[Steward](agents/steward.md)** — the only path for any Vault write (recommendation logs).
- **[Flagger](08-flagger.md)** — receives capability gaps and unhealthy-MCP signals.

---

## Schedule / Triggers

- **on-demand (design time)** — user-initiated (SPEC §10, §2).
- **Not scheduled, not in the loop.** Switchboard does **not** appear in the morning pipeline or any cron. It is consulted only when a new capability is needed (SPEC §4). Per SPEC §3 it is a force-multiplier, **not on the critical path**.

---

## Failure modes & Flagger hooks

| Failure mode | Detection | Flagger response |
|--------------|-----------|------------------|
| **No MCP covers a required capability** | Step 3 shortlist is empty for a capability | `P3 Medium` flag, gap report: "no connected server for `<capability>`" |
| **Required MCP is disconnected/unhealthy** | Registry health check in step 3 | `P2 High` if it blocks an in-flight goal; suggested action = reconnect/re-auth |
| **Missing OAuth scope** | Step 5 scope check fails | Flag for **consent** (do not proceed); `P3` with `suggested_action` = grant scope |
| **Over-broad recommendation** | Self-audit: tools recommended ⟩ tools used | low **trust score**; tighten the recommendation, note for next run |
| **Wrong agent / writer collision** | Recommendation would create a second writer | Block — re-route through the owning agent (one-writer rule, SPEC pillar 1) |
| **Routes an irreversible action with no gate** | Step 1 marks outward but step 6 omits the gate | `P1 Critical` — never emit an ungated outward toolset (SPEC §12) |

Flags carry a **trust/confidence score (0–100)** per SPEC §8 — high for a deterministic registry/scope mismatch, lower for an LLM "best fit" judgment.

---

## D-07 — Actionable gap→Flagger emit

When Switchboard detects a gap, it does NOT just print a note. It outputs a **severity-annotated §6.4 RawIncident** plus a documented **one-command producer-only emit path** the operator can copy-paste to land the incident in the Flagger feed.

### D-07 severity map

| Gap type | `severity_hint` | `kind` | When |
|----------|-----------------|--------|------|
| No connected MCP for required capability | `P3` | `capability_gap` | Step 3 shortlist empty |
| Required MCP disconnected/unhealthy, blocks in-flight goal | `P2` | `unhealthy_mcp` | Step 3 health check |
| Missing or un-granted OAuth scope | `P3` | `missing_scope` | Step 5 scope check |
| Outward toolset assembled WITHOUT confirmation gate | `P1` | `ungated_outward` | Step 6 self-audit |

### §6.4 RawIncident shape (the exact payload `flag()` enqueues)

```json
{
  "source_agent": "Switchboard",
  "severity_hint": "P3",
  "kind": "capability_gap",
  "title": "No connected MCP for capability: <capability-name>",
  "detail": "Goal: <goal>. Required capability: <capability>. No server with health=connected covers this.",
  "suggested_action": "Connect the <server-name> MCP — see docs/06-hosting-cloudflare-mcp.md §11."
}
```

### One-command producer-only emit path

The incident above is the exact payload for `flag()` from `@atlas/shared`. To emit it into the Flagger feed from any Worker with the `INCIDENTS` binding:

```typescript
import { flag } from "@atlas/shared";

await flag(
  env,                          // env must have INCIDENTS: Queue<RawIncident>
  "P3",                         // severity from D-07 map
  "No connected MCP for capability: <capability>",
  "Goal: <goal>. Required: <capability>. No connected server found.",
  {
    sourceAgent: "Switchboard",
    kind: "capability_gap",
    suggestedAction: "Connect the <server> MCP — see docs/06-hosting-cloudflare-mcp.md §11."
  }
);
```

**Important constraints (D-07, Pillar 1):**
- This emit path is **producer-only**: it sends to `atlas-incidents`, which Flagger already consumes.
- Switchboard adds **NO new `atlas-wire` or `atlas-incidents` consumer** — Switchboard is not a deployed Worker.
- The operator copies this snippet into the relevant context (a build step, a manual run) to surface the gap.
- Flagger scores, deduplicates, and routes the incident to the Vault via Steward (the sole Vault writer).

---

## Config

- **Registry config** — the machine-readable list of MCP servers, capability tags, owning agents, and required scopes. Lives at **`.claude/registry/mcp-registry.json`** (tracked JSON, version-controlled — chosen over CONFIG KV because the design-time `/switchboard` command reads it via the Read tool with zero runtime dependencies; KV is unreachable at design time). Update both the JSON and the REGISTRY table above when adding a new MCP server.
- **Side-effect policy** — which verbs are classed outward/irreversible (`post`, `register`, `pay`, `delete`, `submit`, `send`, `publish`, …) and therefore force a confirmation gate. Defined in the registry `side_effect_verbs` array.
- **Ranking weights** — specificity-over-generality, read-before-write, health penalty, Pillar-1/Pillar-2 hard rules. Defined in the registry `ranking_weights` object.
- **Default model** — reasoning task; Opus per SPEC §7 (orchestration/reasoning tier), called via AI Gateway. (Applicable when Switchboard is run as an AI agent; the `/switchboard` slash-command inherits the model from the calling context.)

---

## Deferred items (out of Phase 5 scope)

The following items are intentionally deferred and are NOT part of this phase:

- **Registry freshness / health cadence** — no automated re-check of MCP health; health is updated manually in `.claude/registry/mcp-registry.json`.
- **Auto-execute vs. always-handoff** — Switchboard only recommends; trivially safe read-only inline execution is deferred.
- **Learning loop** — no recording of accepted/edited recommendations or weight tuning.
- **New-server onboarding flow** — when a new MCP is added, manually update both `.claude/registry/mcp-registry.json` and the REGISTRY table in this doc.
- **Menubar hotkey** — no OS-level hotkey binding for invoking `/switchboard`.

---

## Open questions

- **Auto-execute vs. always-handoff?** Today Switchboard only *recommends* and hands to an executing agent. Should trivially safe, read-only toolsets be allowed to run inline (still no Vault/external writes)?
- **Registry freshness.** How often is MCP health re-checked, and should a stale registry block recommendations or just lower trust?
- **Learning loop.** Should Switchboard record which recommendations were accepted/edited by the owner and tune its ranking weights over time?
- **New-server onboarding.** When a brand-new MCP is added in [hosting](06-hosting-cloudflare-mcp.md), what's the flow to register its capability tags so Switchboard can shortlist it?

---

**Related:** [agents/switchboard.md](agents/switchboard.md) · [hosting & Cloudflare MCP](06-hosting-cloudflare-mcp.md) · [The Codex](07-source-of-truth-codex.md) · [Steward](agents/steward.md) · [Usher](agents/usher.md) · [Envoy](agents/envoy.md) · [Flagger](08-flagger.md)
