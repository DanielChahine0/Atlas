# 🗺️ Atlas

> A personal **orchestrator** that runs a fleet of specialized agents to manage your digital life —
> email triage, tasks, calendar, events, job hunting, meeting capture, an Obsidian dashboard,
> screen autofill, and cross-platform personal-brand publishing.
>
> Atlas itself does almost no work. It **schedules, routes, sequences, and supervises** ~16 sub-agents,
> owns the shared event bus, and keeps a single source of truth. Think of it as the conductor — the
> Greek Titan holding up your whole world.

---

## The one-paragraph version

Every morning at 8:00, Atlas labels your inbox (**Filer**), hands you a digest split into
*Important / Action Required / Action Recommended / Advertisement / Other* (**Herald**), turns the
important mail into tasks with deadlines (**Forge**), drops those deadlines on your calendar
(**Sundial**), and writes you a time-blocked day plan (**Compass**). Through the week it scouts
events (**Scout**), tracks job deadlines and hiring windows (**Headhunter**), captures and structures
your meetings (**Echo** → **Archivist**), autofills forms from one profile (**Quill**), and pushes
new projects/experience to LinkedIn + X + GitHub + your portfolio at once (**Envoy**). Everything
funnels into one Obsidian dashboard managed by a single writer (**Steward**), with reliability
watched by **Flagger**, capability routing by **Switchboard**, and your best prompts saved by
**Librarian**.

---

## Design pillars

1. **One writer per resource.** Exactly one agent may mutate any external system. The dashboard has a
   single writer (**Steward**) — no races, no double-counting.
2. **Suggest, don't destroy.** Agents label, draft, and recommend. Anything destructive or
   outward-facing (delete, post, register, pay) is gated behind explicit confirmation.
3. **Cloud by default, local when it must be.** Most agents run on Cloudflare; two (**Echo** audio,
   **Quill** screen) need the physical machine and run as a local daemon.
4. **Single source of truth.** Personal facts live in **The Codex**; dashboard state lives in **The
   Vault** (Obsidian). Agents read the Codex; only Steward writes the Vault.
5. **Idempotent + observable.** Every run is safe to repeat; every notable event/failure hits **Flagger**.

---

## System map

```
                                  ┌─────────────────────────────────────────┐
                                  │                ATLAS                     │
                                  │   orchestrator · scheduler · supervisor  │
                                  └───────────────┬─────────────────────────┘
                                                  │ schedules + routes
        ┌───────────────┬───────────────┬─────────┴────────┬───────────────┬───────────────┐
        ▼               ▼               ▼                  ▼               ▼               ▼
   ┌─────────┐    ┌──────────┐    ┌──────────┐       ┌──────────┐   ┌──────────┐    ┌──────────┐
   │ Filer   │    │ Herald   │    │ Forge    │  ...  │ Scout    │   │ Echo     │    │ Quill    │
   │ (label) │───▶│ (digest) │───▶│ (tasks)  │       │(events)  │   │ (audio)  │    │(autofill)│
   └─────────┘    └──────────┘    └────┬─────┘       └────┬─────┘   └────┬─────┘    └──────────┘
                                       ▼                  │              ▼
                                  ┌──────────┐            │         ┌──────────┐
                                  │ Sundial  │            │         │Archivist │
                                  │(calendar)│            │         │ (notes)  │
                                  └────┬─────┘            │         └────┬─────┘
                                       ▼                  │              │
                                  ┌──────────┐            │              │
                                  │ Compass  │            │              │
                                  │(day plan)│            │              │
                                  └────┬─────┘            │              │
                                       └──────────────────┴──────┬───────┘
                                                                 ▼
                                            ┌─────────────────────────────────────┐
                                            │   the WIRE (event bus / queue)       │
                                            └────────────────────┬────────────────┘
                                                                 ▼  (serialized, single writer)
                                            ┌─────────────────────────────────────┐
                                            │   STEWARD ──▶ The VAULT (Obsidian)   │
                                            └─────────────────────────────────────┘
   reads ▲                                       ▲ watched by                 ▲ routed by
   ┌──────────┐                            ┌──────────┐                 ┌──────────────┐
   │The Codex │ (source of truth)          │ Flagger  │ (reliability)   │ Switchboard  │ (MCP routing)
   └──────────┘                            └──────────┘                 └──────────────┘
```

---

## Your three questions, answered

You asked for these **in this order** — before any "is this a good idea" intuition. Here's where each
lives:

### (1) What to expand on — to fully cover what you're looking for
- **Email tags & groups** (every label + the ones to be careful about): **[docs/04-email-taxonomy.md](docs/04-email-taxonomy.md)**
- **Dashboard — what else to track day-to-day** (counters, views, the morning glance): **[docs/05-dashboard.md](docs/05-dashboard.md)**
- Plus three things your list implied but didn't name: a **single source of truth** (**[The Codex](docs/07-source-of-truth-codex.md)**), a **security/privacy model** (**[docs/11-security-privacy.md](docs/11-security-privacy.md)**), and a **capability router** (**[Switchboard](docs/10-switchboard.md)**).

### (2) All the agents, numbered by importance + how the system works
- **[docs/01-agent-roster.md](docs/01-agent-roster.md)** — the full roster, ranked by **value** and by **build order**, with which agents are sub-agents, which depend on which, and the foundational-vs-feature split.
- **[docs/02-architecture.md](docs/02-architecture.md)** — the orchestrator model, the dependency graph, the three pipelines, and the single-writer rule.

### (3) The schedule — what runs when, in what order, in parallel
- **[docs/03-scheduling.md](docs/03-scheduling.md)** — daily timeline (07:45 → 21:00), weekly timeline (Mon/Fri), concurrency rules, and the cron / event-driven / on-demand split. (Daily email 08:00, weekly email Friday, etc.)

### And then — "is this a good idea + how to build it"
- **[docs/12-roadmap.md](docs/12-roadmap.md)** — the 6-phase build order, the honest verdict, the recommended MVP, and success metrics.

---

## The fleet (ranked by importance)

| # | Agent | Role | Doc |
|---|-------|------|-----|
| 0 | **Atlas** | Orchestrator / supervisor | [atlas](docs/agents/atlas.md) |
| 1 | **Herald** | Email digest (daily + weekly) | [herald](docs/agents/herald.md) |
| 2 | **Filer** | Email labeler (never archives/deletes) | [filer](docs/agents/filer.md) |
| 3 | **Forge** | Task & subtask extractor (deadlines) | [forge](docs/agents/forge.md) |
| 4 | **Sundial** | Task → Google Calendar | [sundial](docs/agents/sundial.md) |
| 5 | **Compass** | Daily planner | [compass](docs/agents/compass.md) |
| 6 | **Scout** | Event discovery (weekly digest) | [scout](docs/agents/scout.md) |
| 7 | **Usher** | Event registration + calendar | [usher](docs/agents/usher.md) |
| 8 | **Headhunter** | Job deadlines & hiring windows | [headhunter](docs/agents/headhunter.md) |
| 9 | **Echo** | Audio capture → transcripts *(local)* | [echo](docs/agents/echo.md) |
| 10 | **Archivist** | Meeting-notes organizer | [archivist](docs/agents/archivist.md) |
| 11 | **Steward** | Dashboard manager (sole Vault writer) | [steward](docs/agents/steward.md) |
| 12 | **Quill** | Screen-aware autofill *(local)* | [quill](docs/agents/quill.md) |
| 13 | **Envoy** | Personal-brand sync (LinkedIn/X/GitHub/portfolio) | [envoy](docs/agents/envoy.md) |
| 14 | **Switchboard** | Capability router (picks the right MCP/tools) | [switchboard](docs/agents/switchboard.md) |
| 15 | **Flagger** | Incident flagging (severity + trust) | [flagger](docs/agents/flagger.md) |
| 16 | **Librarian** | Prompt library | [librarian](docs/agents/librarian.md) |

---

## Repository map

```
Atlas/
├── README.md                          ← you are here
└── docs/
    ├── SPEC-CANON.md                  ← canonical design spec (the source of truth for all docs)
    ├── 00-overview.md                 ← system philosophy & map
    ├── 01-agent-roster.md             ← every agent, ranked (answers Q2)
    ├── 02-architecture.md             ← orchestration, dependencies, pipelines
    ├── 03-scheduling.md               ← cron, sequencing, concurrency (answers Q3)
    ├── 04-email-taxonomy.md           ← labels, groups, cautions (answers Q1a)
    ├── 05-dashboard.md                ← Obsidian dashboard spec (answers Q1b)
    ├── 06-hosting-cloudflare-mcp.md   ← Cloudflare + MCP wiring
    ├── 07-source-of-truth-codex.md    ← The Codex (single source of truth)
    ├── 08-flagger.md                  ← Flagger design
    ├── 09-prompt-library.md           ← Librarian / prompt table
    ├── 10-switchboard.md              ← capability router
    ├── 11-security-privacy.md         ← security & privacy model
    ├── 12-roadmap.md                  ← build order + "is this a good idea?"
    └── agents/                        ← one README per agent (17 files)
```

---

## Hosting at a glance

Cloudflare **Workers** + **Durable Objects** for the agents, **Cron Triggers** for the schedule,
**Queues** for the Wire, **D1/KV/R2** for state, **Workers AI / AI Gateway** for models, and
**remote MCP servers** to connect Gmail, Google Calendar, Drive, Sheets, and GitHub. **Echo** and
**Quill** run in a local macOS daemon. Full details: **[docs/06-hosting-cloudflare-mcp.md](docs/06-hosting-cloudflare-mcp.md)**.

---

## Status

📐 **Design phase.** This repo is the design spec — a set of READMEs describing the system before
a line of agent code is written. Start at **[docs/00-overview.md](docs/00-overview.md)**, then
**[docs/12-roadmap.md](docs/12-roadmap.md)** for the build order.
