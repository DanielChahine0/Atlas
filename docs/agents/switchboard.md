# Switchboard (capability router)

**Purpose:** Given a prompt or goal, **Switchboard** selects the best MCP server plus the exact tools and resources (and OAuth scopes) needed to achieve it, then hands a ready-to-use toolset to the executing agent — it **recommends, it never acts**.

> Agent-doc companion to the chapter [../10-switchboard.md](../10-switchboard.md). That file is the narrative reference; this one is the build-facing card: at-a-glance, the algorithm, the registry, the report shape, and a full **Example run**. Where they overlap, both are written from [SPEC-CANON](../SPEC-CANON.md) and must agree.

## At a glance

| | |
|---|---|
| **Codename** | **Switchboard** (capability router) |
| **Roster #** | 14 (SPEC §2) |
| **Importance** | Tier 4 — meta / force-multiplier, **not on the critical path** (SPEC §3 #16) |
| **Runtime** | **Design-time only** — `/switchboard` Claude Code slash-command + `.claude/registry/mcp-registry.json`; **NOT a deployed Worker** (D-07) |
| **Trigger** | **on-demand (design time)** — user-initiated (SPEC §10) |
| **Inputs** | A natural-language prompt/goal; optional constraints (scope budget, connected accounts, deadline); the **registry** snapshot; **The Codex** (read-only) |
| **Outputs** | A ranked **toolset recommendation**: MCP server(s) + exact tool list + bound resources + required OAuth scopes + executing agent + confirmation-gate flag; a **gap report** when no server covers a capability |
| **Dependencies** | The MCP **registry** (connected + healthy servers — see [hosting](../06-hosting-cloudflare-mcp.md)); [The Codex](../07-source-of-truth-codex.md) for identity/account facts |
| **MCPs/tools** | Reads the **registry**; uses **Context7 docs** (`resolve-library-id`, `query-docs`) for unknown libraries; calls **no** domain/write tools itself |
| **Writes to** | **Recommendations only** (SPEC §2). Never mutates an external system. Recommendation logs go to the Vault **via [Steward](steward.md)** |

> **Design-time, not run-time.** Per SPEC §4: *"Switchboard is consulted at design time when a new capability is needed; it doesn't run in the loop."* When [Atlas](atlas.md) (or you) hit a goal with no obvious owning agent, you ask Switchboard *"what do I need to do this?"* It answers with a toolset; the named agent then executes behind the usual confirmation gates (SPEC §12).

---

## What it does

Atlas connects ~12 remote MCP servers, each exposing dozens of tools. For any one goal, only a handful of tools across one or two servers are relevant. Switchboard solves the **selection problem** — it turns a fuzzy prompt into a precise, least-privilege toolset:

1. Read the **intent** behind a prompt ("register me for this event", "publish my new project", "summarize this PR").
2. Map intent → the **capabilities** required (browser automation, calendar write, code read).
3. Shortlist the **MCP server(s)** that provide those capabilities, using the registry below.
4. Resolve the **exact tools** and **resources** — no more (least privilege), no fewer (no missing step).
5. Determine the **required OAuth scopes** and confirm they are already granted; flag if new consent is needed.
6. **Assemble** the toolset and name the **executing agent** that should run it.

The payoff: handing an agent `browser_navigate` + `browser_fill_form` + `browser_click` + `create_event` + the event URL — instead of "all of Gmail + all of Calendar + a browser." Narrower toolsets are faster, cheaper, and safer.

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
| 1 | **Intent extraction** | Reduce the prompt to `verb` + `object` + `outcome`. Classify the **side-effect** (read-only vs. outward/irreversible). | "register me for **this event**" → verb=`register`, object=event page, outcome=confirmed + on calendar; **outward/irreversible** |
| 2 | **Capability map** | Translate intent into abstract capabilities, not products. | needs `web-automation` (fill a registration form) + `calendar-write` (add the event) |
| 3 | **MCP shortlist** | For each capability, pick the best-fit server(s) from the **registry**. Drop any server that is disconnected or unhealthy (health from [hosting](../06-hosting-cloudflare-mcp.md)). | `web-automation` → **Playwright**; `calendar-write` → **Google Calendar** |
| 4 | **Tool + resource resolve** | Choose the *minimal* tool set per server; bind concrete resources (event URL, file ID, calendar ID). | `browser_navigate`, `browser_snapshot`, `browser_fill_form`, `browser_click` + `create_event`; resource = event URL, Codex identity fields |
| 5 | **Scope check** | List the OAuth scopes each tool requires; confirm they are already granted to that agent (least-privilege, SPEC §12). If a new scope is needed, **flag for consent** rather than proceeding. | Calendar write needs `calendar.events`; if only read is granted, raise a consent flag |
| 6 | **Assemble toolset** | Emit the bundle and name the **executing agent** that owns this work; attach the gate flag for outward actions. | Hand to [Usher](usher.md) (event registration) + Codex confirmation gate before final submit |

### Selection heuristics (how step 3 ranks)

- **Specificity beats generality.** A first-party server (Google Calendar) beats driving the same site through a browser when both can do the job. Reserve **Playwright** for sites with no MCP.
- **Read before write.** If the goal can be met read-only, never shortlist write tools.
- **One writer per resource (SPEC pillar 1).** Switchboard never recommends a second writer for something an existing agent owns — e.g. it routes any Vault write through [Steward](steward.md), never a direct Obsidian write.
- **Gate the irreversible (SPEC pillar 2 / §12).** If the intent is outward-facing (post, register, pay, delete), the recommendation **must** include the confirmation gate and the owning agent ([Usher](usher.md)/[Envoy](envoy.md)).
- **Health-aware.** A disconnected/unhealthy MCP is dropped from the shortlist and the gap is flagged to [Flagger](../08-flagger.md).

---

## REGISTRY — known MCP servers

The lookup table behind step 3. *Best at* is what Switchboard optimizes for; *Owning agent(s)* is who normally executes against that server in Atlas.

| MCP server | Best at | Representative tools | Owning agent(s) | Typical scopes |
|------------|---------|----------------------|-----------------|----------------|
| **Gmail** | Email triage, labeling, drafting (never delete) | `list_labels`, `search_threads`, `get_thread`, `label_thread`, `create_draft` | [Filer](filer.md), [Herald](herald.md) | `gmail.modify` (labels), **not** delete (SPEC §12) |
| **Google Calendar** | Reading & writing events, finding free time | `list_events`, `get_event`, `create_event`, `update_event`, `suggest_time`, `respond_to_event` | [Sundial](sundial.md), [Usher](usher.md), [Compass](compass.md) | `calendar.events` (write) / `calendar.readonly` |
| **Google Drive** | Cloud docs/files: read content, search, store exports | `search_files`, `read_file_content`, `get_file_metadata`, `create_file`, `copy_file` | [Steward](steward.md), Codex sync | `drive.file` / `drive.readonly` |
| **Google Sheets** | Tabular/structured data: trackers, funnels, logs | (Sheets read/write) | [Headhunter](headhunter.md), [Steward](steward.md) | `spreadsheets` |
| **GitHub** | Code, PRs, issues, releases, repo metadata | `get_file_contents`, `search_code`, `list_pull_requests`, `pull_request_read`, `issue_read`, `create_pull_request` | [Envoy](envoy.md) (portfolio/projects), Dev triage | GitHub App, least-privilege repo scopes |
| **Obsidian** | The **Vault** — notes, dashboard, tags (local bridge) | `read-note`, `search-vault`, `create-note`, `edit-note`, `add-tags` | **[Steward](steward.md) only** (sole Vault writer) | local MCP bridge (SPEC §7) |
| **Playwright / browser** | Driving any site with no first-party MCP: forms, clicks, captcha-adjacent flows | `browser_navigate`, `browser_snapshot`, `browser_fill_form`, `browser_click`, `browser_type`, `browser_take_screenshot` | [Usher](usher.md), [Envoy](envoy.md) | none (browser session); gated by SPEC §12 |
| **Canva** | Design generation/export for brand assets | `generate-design`, `create-design-from-brand-template`, `export-design`, `get-design-thumbnail` | [Envoy](envoy.md), Librarian (tool field) | Canva OAuth |
| **Notion** | External structured docs/databases (when used) | `notion-search`, `notion-fetch`, `notion-create-pages`, `notion-update-page` | (optional) | Notion OAuth |
| **Slack** | Team/channel messaging, search, scheduled sends | `slack_search_public`, `slack_read_channel`, `slack_send_message`, `slack_schedule_message` | (optional) | Slack OAuth |
| **Context7 docs** | Current library/framework/SDK/API documentation | `resolve-library-id`, `query-docs` | **Switchboard itself**, Dev work | none |

> **Registry source of truth:** which of these are actually connected, authenticated, and healthy is owned by the **hosting** layer — see **[hosting & Cloudflare MCP](../06-hosting-cloudflare-mcp.md)** (remote MCP servers on Workers, Cloudflare Agents SDK, OAuth Provider). Switchboard *reads* that state; it does not manage connections.

### Capability → MCP quick map

| Capability | First choice | Fallback |
|------------|--------------|----------|
| Read/label/draft email | **Gmail** | — |
| Read/write calendar events | **Google Calendar** | Playwright (if the source has no API) |
| Read cloud docs/files | **Google Drive** | — |
| Tabular trackers/funnels | **Google Sheets** | Drive |
| Code / PR / repo facts | **GitHub** | Playwright (web UI only) |
| Vault notes / dashboard | **Obsidian** (via [Steward](steward.md)) | — |
| Drive an arbitrary website | **Playwright / browser** | — |
| Design / brand visuals | **Canva** | — |
| External structured docs | **Notion** | Drive |
| Team chat | **Slack** | — |
| Up-to-date library docs | **Context7 docs** | web search |

---

## The recommendation — what Switchboard reports

Switchboard's output is a single **toolset recommendation** plus its **rationale**. The shape:

```json
{
  "goal": "<verbatim prompt>",
  "intent": { "verb": "register", "object": "<event URL>", "outcome": "registered + on calendar" },
  "side_effect": "read-only | outward-irreversible",
  "confirmation_gate": true,
  "executing_agent": "Usher",
  "mcps": [
    { "server": "Playwright / browser", "tools": ["browser_navigate", "..."], "scopes": [] },
    { "server": "Google Calendar",      "tools": ["create_event"],            "scopes": ["calendar.events"] }
  ],
  "resources": ["<event URL>", "Codex: identity fields", "primary calendar ID"],
  "scope_status": "all-granted | needs-consent: calendar.events",
  "rationale": "first-party Calendar beats browser for the add; site has no MCP so browser drives the form; outward action → gate before submit",
  "downstream": ["Wire event → Steward: events attended ++"],
  "trust": 88
}
```

What each part is *for*:

- **`executing_agent`** — Switchboard hands off; it never runs the toolset. The named agent owns the resource (one-writer rule).
- **`confirmation_gate` / `side_effect`** — outward/irreversible verbs (`post`, `register`, `pay`, `delete`) must carry a gate (SPEC §12). An ungated outward toolset is a `P1 Critical` defect (see below).
- **`scope_status`** — `needs-consent` means *do not proceed*; raise a consent flag instead of silently widening scopes.
- **`rationale`** — the human-readable "why this and not that," so the owner can sanity-check the route.
- **`trust`** — a **trust/confidence score (0–100)** per SPEC §8: high for a deterministic registry/scope match, lower for an LLM "best fit" judgment.
- **`downstream`** — the follow-on Wire event(s) the executing agent will emit (e.g. counter bumps to [Steward](steward.md)).

If a required capability has **no connected server**, Switchboard emits a **gap report** instead of a toolset and routes it to [Flagger](../08-flagger.md).

---

## Inputs / Outputs

**Inputs**

- A natural-language **prompt/goal**.
- Optional **constraints:** scope budget (read-only vs. allow-write), which accounts are connected, deadline.
- The **registry** snapshot (connected + healthy MCPs) from [hosting](../06-hosting-cloudflare-mcp.md).
- [The Codex](../07-source-of-truth-codex.md) (read-only) for account/identity context.

**Outputs**

- A ranked **toolset recommendation** (the JSON above): MCP server(s) → exact tools → resources → scopes → executing agent → confirmation-gate flag → rationale → trust.
- A **gap report** when no connected MCP covers a required capability (routed to [Flagger](../08-flagger.md)).
- Optional: a log entry of the recommendation, written to the Vault **via [Steward](steward.md)** (Switchboard never writes the Vault directly).

---

## Dependencies

- **Registry / hosting** — [../06-hosting-cloudflare-mcp.md](../06-hosting-cloudflare-mcp.md): which MCP servers exist on Workers, their auth state and health.
- **The Codex** — [../07-source-of-truth-codex.md](../07-source-of-truth-codex.md): account & identity context (read-only).
- **Executing agents** — Switchboard hands work to the agent that owns the chosen capability: [Usher](usher.md), [Envoy](envoy.md), [Sundial](sundial.md), [Filer](filer.md), [Headhunter](headhunter.md), etc. It never executes itself.
- **[Steward](steward.md)** — the only path for any Vault write (recommendation logs).
- **[Flagger](../08-flagger.md)** — receives capability gaps and unhealthy-MCP signals.

---

## Schedule / Triggers

- **on-demand (design time)** — user-initiated (SPEC §10, §2). Shares the on-demand row with [Usher](usher.md), Quill, [Envoy](envoy.md), and Librarian.
- **Not scheduled, not in the loop.** Switchboard does **not** appear in the morning pipeline (Filer→Herald→Forge→Sundial→Compass) or any cron — see [scheduling](../03-scheduling.md). It is consulted only when a new capability is needed (SPEC §4). Per SPEC §3 it is a force-multiplier, **not on the critical path**.

---

## Failure modes & Flagger hooks

| Failure mode | Detection | Flagger response |
|--------------|-----------|------------------|
| **No MCP covers a required capability** | Step 3 shortlist is empty for a capability | `P3 Medium` flag, gap report: "no connected server for `<capability>`" |
| **Required MCP is disconnected/unhealthy** | Registry health check in step 3 | `P2 High` if it blocks an in-flight goal; `suggested_action` = reconnect/re-auth |
| **Missing OAuth scope** | Step 5 scope check fails | Flag for **consent** (do not proceed); `P3` with `suggested_action` = grant scope |
| **Over-broad recommendation** | Self-audit: tools recommended ⟩ tools used | low **trust score**; tighten the recommendation, note for next run |
| **Wrong agent / writer collision** | Recommendation would create a second writer | **Block** — re-route through the owning agent (one-writer rule, SPEC pillar 1) |
| **Routes an irreversible action with no gate** | Step 1 marks outward but step 6 omits the gate | `P1 Critical` — never emit an ungated outward toolset (SPEC §12) |

Flags carry the **trust/confidence score (0–100)** per SPEC §8 — high for a deterministic registry/scope mismatch, lower for an LLM "best fit" judgment. The flag shape and `open → ack → resolved → muted` status come from [Flagger](../08-flagger.md).

---

## Config

- **Registry config** — the list of MCP servers, their capability tags, owning agent, and required scopes. Lives in **KV** (SPEC §7) and is the editable knob behind the REGISTRY table above.
- **Side-effect policy** — which verbs are classed outward/irreversible (`post`, `register`, `pay`, `delete`) and therefore force a confirmation gate.
- **Ranking weights** — specificity-over-generality, read-before-write, health penalty.
- **Default model** — reasoning task; **Opus** per SPEC §7 (orchestration/reasoning tier), called via AI Gateway.

---

## Example run

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
   Codex supplies the autofill values (cf. Quill's form-field → Codex-field map)
   GATE: Usher fills the form, screenshots the review screen, and STOPS for
         explicit owner confirmation before the final "Submit/Pay" (SPEC §12).
   On success: create_event, then Usher → the Wire → Steward (events attended ++).
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
  "downstream": ["Wire event → Steward: events attended ++"],
  "trust": 88
}
```

> The phrasing "Playwright + Calendar + Codex" can mislead: **The Codex** is *not* an MCP server. It is the read-only source of identity facts (SPEC §11) that supply the autofill values for the registration form, exactly as [Quill](../01-agent-roster.md) maps form-field labels → Codex fields.

**A second, contrasting route — "summarize this PR":**

```
1. INTENT   verb=summarize, object=<PR URL>, outcome=text summary   → READ-ONLY (no gate)
2. CAP MAP  code-read (PR diff, files, review comments)
3. SHORTLIST  GitHub  (first-party; never Playwright on the web UI when an MCP exists)
4. RESOLVE  pull_request_read, get_file_contents   (no write tools — read-before-write)
5. SCOPE    GitHub App, read-only repo scope — already granted
6. ASSEMBLE → Dev-triage path; no executing-agent handoff with side effects, no gate
```

This contrast is the whole point of Switchboard: a first-party read (`pull_request_read`) with no gate, versus a browser-driven outward write that **must** stop for confirmation.

---

## Open questions

- **Auto-execute vs. always-handoff?** Today Switchboard only *recommends* and hands to an executing agent. Should trivially safe, read-only toolsets be allowed to run inline (still no Vault/external writes)?
- **Registry freshness.** How often is MCP health re-checked, and should a stale registry block recommendations or just lower the trust score?
- **Learning loop.** Should Switchboard record which recommendations were accepted/edited by the owner and tune its ranking weights over time?
- **New-server onboarding.** When a brand-new MCP is added in [hosting](../06-hosting-cloudflare-mcp.md), what's the flow to register its capability tags so Switchboard can shortlist it?

---

**Related:** [chapter: 10-switchboard.md](../10-switchboard.md) · [hosting & Cloudflare MCP](../06-hosting-cloudflare-mcp.md) · [The Codex](../07-source-of-truth-codex.md) · [scheduling](../03-scheduling.md) · [Steward](steward.md) · [Usher](usher.md) · [Envoy](envoy.md) · [Flagger](../08-flagger.md) · [Atlas](atlas.md)
