# Switchboard — Capability Router

**Purpose:** Given a prompt or goal, **Switchboard** picks the best MCP server plus the exact tools and resources (and scopes) needed to achieve it, then hands a ready-to-use toolset to the executing agent. It is a **design-time** advisor — it recommends, it does not run in the morning loop and it does not act.

## At a glance

| | |
|---|---|
| **Codename** | **Switchboard** (capability router) |
| **Roster #** | 14 (SPEC §2) |
| **Importance** | Tier 4 — meta/force-multiplier, **not on the critical path** (SPEC §3 #16) |
| **Runtime** | Cloud (Cloudflare Worker + Durable Object) |
| **Trigger** | **on-demand (design time)** — user-initiated (SPEC §10) |
| **Inputs** | A natural-language prompt/goal; optional constraints (which accounts are connected, scope budget) |
| **Outputs** | A ranked **toolset recommendation**: MCP server(s) + exact tool list + required resources + required OAuth scopes + executing agent |
| **Dependencies** | The MCP **registry** (which servers are connected and healthy — see [hosting](06-hosting-cloudflare-mcp.md)); **The Codex** for identity/account facts |
| **MCPs/tools** | Reads the registry of remote MCP servers; calls **no** domain tools itself |
| **Writes to** | **Recommendations only** (SPEC §2). It never mutates an external system. Recommendations may be logged to the Vault via [Steward](agents/steward.md) |

> **Design-time, not run-time.** Per SPEC §4: *"Switchboard is consulted at design time when a new capability is needed; it doesn't run in the loop."* When you (or Atlas) hit a goal with no obvious agent, you ask Switchboard *"what do I need to do this?"* — it answers with a toolset; the chosen agent then executes behind the usual confirmation gates (SPEC §12).

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
- **One writer per resource (SPEC pillar 1).** Switchboard never recommends a second writer for something an existing agent owns — e.g. it routes any Vault write through [Steward](agents/steward.md), never a direct Obsidian write.
- **Gate the irreversible (SPEC pillar 2 / §12).** If the intent is outward-facing (post, register, pay, delete), the recommendation **must** include the confirmation gate and the owning agent ([Usher](agents/usher.md)/[Envoy](agents/envoy.md)).
- **Health-aware.** A disconnected/unhealthy MCP is dropped from the shortlist and Switchboard flags the gap to [Flagger](08-flagger.md).

---

## REGISTRY — known MCP servers

This is the lookup table behind step 3. "Best at" is what Switchboard optimizes for; "Owning agent(s)" is who normally executes against that server in Atlas.

| MCP server | Best at | Representative tools | Owning agent(s) | Typical scopes |
|------------|---------|----------------------|-----------------|----------------|
| **Gmail** | Email triage, labeling, drafting (never delete) | `list_labels`, `search_threads`, `get_thread`, `label_thread`, `create_draft` | [Filer](agents/filer.md), [Herald](agents/herald.md) | `gmail.modify` (labels), **not** delete (SPEC §12) |
| **Google Calendar** | Reading & writing events, finding free time | `list_events`, `get_event`, `create_event`, `update_event`, `suggest_time`, `respond_to_event` | [Sundial](agents/sundial.md), [Usher](agents/usher.md), [Compass](agents/compass.md) | `calendar.events` (write) / `calendar.readonly` |
| **Google Drive** | Cloud docs/files: read content, search, store exports | `search_files`, `read_file_content`, `get_file_metadata`, `create_file`, `copy_file` | [Steward](agents/steward.md), Codex sync | `drive.file` / `drive.readonly` |
| **Google Sheets** | Tabular/structured data: trackers, funnels, logs | (Sheets read/write) | Headhunter, Steward | `spreadsheets` |
| **GitHub** | Code, PRs, issues, releases, repo metadata | `get_file_contents`, `search_code`, `list_pull_requests`, `pull_request_read`, `issue_read`, `create_pull_request` | [Envoy](agents/envoy.md) (portfolio/projects), Dev triage | GitHub App, least-privilege repo scopes |
| **Obsidian** | The **Vault** — notes, dashboard, tags (local bridge) | `read-note`, `search-vault`, `create-note`, `edit-note`, `add-tags` | **[Steward](agents/steward.md) only** (sole Vault writer) | local MCP bridge (SPEC §7) |
| **Playwright / browser** | Driving any site with no first-party MCP: forms, clicks, captcha-adjacent flows | `browser_navigate`, `browser_snapshot`, `browser_fill_form`, `browser_click`, `browser_type`, `browser_take_screenshot` | [Usher](agents/usher.md), [Envoy](agents/envoy.md) | none (browser session); gated by SPEC §12 |
| **Canva** | Design generation/export for brand assets | `generate-design`, `create-design-from-brand-template`, `export-design`, `get-design-thumbnail` | [Envoy](agents/envoy.md), [Librarian](09-prompt-library.md) (tool field) | Canva OAuth |
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

## Config

- **Registry config** — the list of MCP servers, their capability tags, owning agent, and required scopes. Lives in KV (per SPEC §7) and is the editable knob behind the REGISTRY table above.
- **Side-effect policy** — which verbs are classed outward/irreversible (`post`, `register`, `pay`, `delete`) and therefore force a confirmation gate.
- **Ranking weights** — specificity-over-generality, read-before-write, health penalty.
- **Default model** — reasoning task; Opus per SPEC §7 (orchestration/reasoning tier).

---

## Open questions

- **Auto-execute vs. always-handoff?** Today Switchboard only *recommends* and hands to an executing agent. Should trivially safe, read-only toolsets be allowed to run inline (still no Vault/external writes)?
- **Registry freshness.** How often is MCP health re-checked, and should a stale registry block recommendations or just lower trust?
- **Learning loop.** Should Switchboard record which recommendations were accepted/edited by the owner and tune its ranking weights over time?
- **New-server onboarding.** When a brand-new MCP is added in [hosting](06-hosting-cloudflare-mcp.md), what's the flow to register its capability tags so Switchboard can shortlist it?

---

**Related:** [agents/switchboard.md](agents/switchboard.md) · [hosting & Cloudflare MCP](06-hosting-cloudflare-mcp.md) · [The Codex](07-source-of-truth-codex.md) · [Steward](agents/steward.md) · [Usher](agents/usher.md) · [Envoy](agents/envoy.md) · [Flagger](08-flagger.md)
