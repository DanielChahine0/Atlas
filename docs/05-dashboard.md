# 05 — The Vault (Obsidian dashboard)

**Purpose:** The owner-facing dashboard. **The Vault** is an Obsidian vault rendered from Markdown notes; **Steward** is its *only* writer, fed events over **the Wire**. Every counter, view, and daily glance below is materialized by Steward from agent events — the owner never edits state by hand, only reads (and triages the quick-capture inbox).

## At a glance

| | |
|---|---|
| **Surface** | Obsidian vault on the local machine (synced); rendered via Dataview + Bases |
| **Sole writer** | **Steward** (agent #11) — see [Steward](agents/steward.md) |
| **Fed by** | Herald, Forge, Sundial, Compass, Scout, Headhunter, Usher, Envoy, Archivist, Flagger, Librarian (via the Wire) |
| **Inputs** | Wire events `{ agent, type, entity, op, payload, idempotencyKey }` (SPEC §6.4) |
| **Outputs** | Markdown notes + frontmatter; Dataview/Bases queries render counters, views, day plan |
| **Reads** | Steward reads nothing external; it is *fed* (SPEC §4 — "Steward fetches NOTHING") |
| **Writes** | The Vault only, serialized (single consumer / lock) |
| **MCP / tools** | Obsidian via a local MCP bridge (SPEC §7); D1 mirrors counts for cheap queries |
| **Key cadence** | Continuous (event-driven) + Fri 16:30 weekly-review build by Steward |

> **One writer per resource.** Nothing in this doc writes to the Vault except Steward. Other agents emit Wire events; Steward serializes and applies them. This is the design pillar that prevents Obsidian file conflicts and double-counted counters.

---

## 1. Folder & file structure (proposed)

The Vault is plain Markdown + frontmatter so Dataview/Bases can query it and git/sync can version it. **The Codex** (`codex.md`) lives in the Vault too but is *not* dashboard state — it is the source-of-truth profile (read-only to agents except via an explicit "update my profile" flow, SPEC §11).

```
Vault/
├── codex.md                      # The Codex — source of truth (read-only; see 07-source-of-truth-codex.md)
├── Dashboard/
│   ├── Home.md                   # Morning glance (§6.3) — the page the owner opens daily
│   ├── Today.md                  # Compass day plan (view 6.2 "Today")
│   ├── This Month.md             # Tasks calendar (view "This Month")
│   ├── Deadline Board.md         # Merged jobs + events + tasks by date
│   ├── Job Pipeline.md           # Kanban: applied → OA → interview → offer/reject
│   ├── Waiting On.md             # ③ Awaiting Reply
│   ├── Weekly Review.md          # Auto Friday (built Fri 16:30 by Steward)
│   ├── Reading Queue.md          # ④ FYI / Read Later + newsletters
│   ├── Finances.md               # Bills due, subscriptions
│   ├── People.md                 # CRM — who you met, follow-ups
│   ├── Goals.md                  # Quarterly OKRs + progress
│   ├── Flagger.md                # Incident feed (see 08-flagger.md)
│   ├── Prompt Library.md         # Title + deep link table (see 09-prompt-library.md)
│   └── Heartbeat.md              # Agent run log / heartbeat
├── Counters/
│   └── metrics.md                # Single frontmatter note holding all §6.1 counters
├── Tasks/
│   └── <yyyy-mm-dd>-<slug>.md    # one note per task; frontmatter: status, due, source, project
├── Jobs/
│   └── <company>-<role>.md       # one note per application; frontmatter: stage, applied, company
├── Events/
│   └── <yyyy-mm-dd>-<slug>.md    # frontmatter: status (registered/attended/upcoming), starts
├── Meetings/
│   └── <yyyy-mm-dd>-<slug>.md    # Archivist output; frontmatter: attendees, links
├── Prompts/
│   └── <slug>.md                 # Librarian — full prompt body; linked from Prompt Library.md
├── Flags/
│   └── <flag-id>.md              # one note per flag; frontmatter: severity, trust, status
└── Inbox/
    └── quick-capture.md          # unsorted owner captures (the only note the owner edits freely)
```

**Why one note per entity (Tasks/Jobs/Events/Flags):** Dataview/Bases query frontmatter across a folder, so each task/job/event being its own note with typed frontmatter is what makes the views in §3 cheap and live. Counters in §2 are a *projection* Steward maintains, not the truth — the per-entity notes are the truth, so a counter can always be rebuilt by re-scanning.

---

## 2. Counters / metrics (SPEC §6.1)

All counters live in `Counters/metrics.md` frontmatter and are mutated by Steward via the `increment`/`upsert` ops, each carrying an `idempotencyKey` so a replayed Wire event can't double-count (SPEC §6.4). Rates are derived, not stored.

| Group | Counter | Moved by (agent) | Op | Notes |
|---|---|---|---|---|
| **Jobs funnel** | `jobs_applied` | Headhunter, Forge | `increment` | feeds Job Pipeline kanban |
| | `jobs_oa` | Headhunter | `increment` | online assessment stage (`Job/OA`) |
| | `jobs_interview` | Headhunter | `increment` | `Job/Interview` |
| | `jobs_offer` | Headhunter | `increment` | `Job/Offer` |
| | `jobs_rejection` | Headhunter | `increment` | `Job/Rejection` |
| | `response_rate` | — (derived) | — | `(oa+interview+offer+rejection) / applied` |
| | `interview_rate` | — (derived) | — | `interview / applied` |
| **Events** | `events_registered` | Usher, Scout | `increment` | |
| | `events_attended` | Usher | `increment` | "events attended++" (SPEC §4) |
| | `events_upcoming` | Scout | `upsert` | count from Events/ folder, next 7–30d |
| **Email** | `email_unread` | Filer (via Herald) | `upsert` | snapshot at sweep time |
| | `email_action_required` | Filer / Herald | `upsert` | count of `① Action Required` |
| | `email_processed_today` | Filer | `increment` | threads carrying `AI/Reviewed` today |
| **Tasks** | `tasks_open` | Forge | `upsert` | `status: open` in Tasks/ |
| | `tasks_done_today` | Forge / Compass | `increment` | |
| | `tasks_overdue` | Compass | `upsert` | `due < today AND status: open` |
| | `tasks_due_this_week` | Compass | `upsert` | |
| | `task_completion_rate` | — (derived) | — | `done / (done + open)` |
| **Meetings** | `meetings_this_week` | Archivist | `increment` | |
| | `meeting_hours` | Archivist | `increment` | sum of meeting durations |
| **Brand** | `posts_shipped` | Envoy | `increment` | X + LinkedIn |
| | `projects_published` | Envoy | `increment` | |
| | `github_streak` | Envoy | `upsert` | days |
| **Habits** | `streaks.<name>` | (owner / Compass) | `increment` | habit/streak counters |

> Counters are an at-a-glance projection. The Job Pipeline kanban (§3) and Deadline Board read the per-entity notes directly, so they stay correct even if a counter drifts — and Steward can rebuild `metrics.md` by re-scanning `Tasks/`, `Jobs/`, `Events/` on the Fri 16:30 weekly build.

---

## 3. Views (SPEC §6.2)

Each view is a saved Dataview query or a Bases view over the folders in §1. **Dataview** is best for ad-hoc tables/lists driven by frontmatter; **Bases** (Obsidian's native database) is best for the kanban and the calendar-style boards where the owner wants to switch layouts (table ↔ board ↔ calendar) without rewriting a query.

| View | Source | Renderer | Backing data |
|---|---|---|---|
| **Today** | Compass day plan | Dataview | `Tasks/` due today + today's calendar events |
| **This Month** | tasks calendar | Bases (calendar) | `Tasks/` frontmatter `due` |
| **Upcoming events (7 days)** | Scout | Dataview | `Events/` `status: upcoming`, `starts` ≤ +7d |
| **Deadline board** | jobs + events + tasks merged | Dataview | union sorted by date |
| **Job pipeline kanban** | applied → OA → interview → offer/reject | Bases (board) | `Jobs/` frontmatter `stage` |
| **Waiting-on list** | `③ Awaiting Reply` | Dataview | threads/notes tagged awaiting-reply |
| **Weekly review** | auto Friday | Steward build | snapshot at Fri 16:30 |
| **Meeting-notes index** | recent, linked | Dataview | `Meetings/` sorted by date desc |
| **Flagger feed** | incidents, severity, trust | Bases (board) | `Flags/` — see [Flagger](08-flagger.md) and §5 |
| **Prompt library table** | title + deep link | Dataview | `Prompts/` — see [Prompt library](09-prompt-library.md) and §6 |
| **Reading queue** | `④ FYI / Read Later`, newsletters | Dataview | notes tagged read-later |
| **Finances snapshot** | bills due, subscriptions | Dataview | `Finance/Bill`, `Finance/Subscription` sourced |
| **People / CRM** | who you met, follow-ups | Bases (table) | `People/` |
| **Goals / OKRs** | quarterly, with progress | Dataview | `Goals.md` |
| **Agent heartbeat / run log** | which agents ran, when, status | Dataview | `Heartbeat.md` / D1-mirrored run-log |
| **Quick-capture inbox** | unsorted | raw note | `Inbox/quick-capture.md` |

> **Dataview vs Bases, the rule of thumb:** if the owner only ever *reads* it as a list/table, use Dataview (less ceremony). If they want to drag cards or flip between layouts (kanban, calendar), use a Base. The Job pipeline kanban and the Flagger feed are the two that most benefit from Bases' board layout.

### 3.1 Sample Dataview — Today's tasks by date

Drives the **Today** view (the owner's "what do I actually do today", synthesized by Compass). Lists open tasks due on or before today, overdue first, then sorted by due date.

````markdown
```dataview
TABLE WITHOUT ID
  file.link AS "Task",
  due AS "Due",
  source AS "From",
  priority AS "P"
FROM "Tasks"
WHERE status = "open" AND due <= date(today)
SORT due ASC, priority ASC
```
````

### 3.2 Sample Dataview — Job-pipeline kanban (by stage)

A Dataview rendering of the pipeline (Bases gives a draggable board; this is the query-driven fallback / read-only view). Groups job notes by `stage` across the funnel `applied → OA → interview → offer/reject`.

````markdown
```dataview
TABLE WITHOUT ID
  file.link AS "Application",
  company AS "Company",
  applied AS "Applied",
  next_action AS "Next"
FROM "Jobs"
WHERE stage != "rejected"
GROUP BY stage
SORT
  choice(stage = "applied", 1,
  choice(stage = "oa", 2,
  choice(stage = "interview", 3,
  choice(stage = "offer", 4, 5)))) ASC
```
````

> Both queries read frontmatter Steward maintains. Stage strings (`applied`, `oa`, `interview`, `offer`, `rejected`) mirror the email funnel labels `Job/Application`, `Job/OA`, `Job/Interview`, `Job/Offer`, `Job/Rejection` from SPEC §5.2, so Headhunter can set stage directly from the label it sees.

---

## 4. The morning glance — `Dashboard/Home.md` (SPEC §6.3)

The single page the owner opens each morning, after the morning pipeline (Filer → Herald → Forge → Sundial → Compass) has run and Steward has applied its events. Six panels, top to bottom:

```
┌──────────────────────────────────────────────────────────┐
│  ☀ MORNING GLANCE — {{date}}                              │
├──────────────────────────────────────────────────────────┤
│  1. TOP 3 PRIORITIES        ← Compass (the day plan)      │
│  2. ACTION-REQUIRED EMAIL   ← Herald / ① Action Required  │
│  3. DEADLINES — NEXT 7 DAYS ← Deadline board (jobs+events+│
│                               tasks merged, by date)      │
│  4. TODAY'S MEETINGS        ← Google Calendar / Sundial   │
│  5. OPEN FLAGS              ← Flagger (P1/P2 first)        │
│  6. WAITING-ON              ← ③ Awaiting Reply            │
└──────────────────────────────────────────────────────────┘
```

Each panel is a short Dataview block or an embed of the corresponding view from §3. The glance is read-only; it never asks the owner to *do* dashboard maintenance — only to act on their actual life. Open flags pull from `Flags/` (see [Flagger](08-flagger.md)); P1/P2 also fired a push notification before the owner ever opened the Vault.

---

## 5. Flagger feed in the Vault (SPEC §8)

`Dashboard/Flagger.md` is a board over `Flags/`, **sorted by severity then trust**, with one-line titles and a click-through to the per-flag note. Full agent spec in [08-flagger.md](08-flagger.md).

- **Severity:** `P1 Critical` · `P2 High` · `P3 Medium` · `P4 Low / Info`.
- **Trust score (0–100):** how confident Atlas is the flag is real & correctly diagnosed.
- **Flag note frontmatter** mirrors the flag shape: `{ id, ts, source_agent, severity, trust, title, detail, suggested_action, status }`.
- **Status lifecycle:** `open → ack → resolved → muted`.
- **Routing into the Vault:** P3/P4 are batched into this feed; P1/P2 push immediately *and* land here. Steward writes flag notes from Flagger's Wire events like any other counter/entity — Flagger never writes the Vault itself.
- **Self-monitoring:** Flagger flags itself / a stale heartbeat, so a missing heartbeat shows up here too (cross-check against `Dashboard/Heartbeat.md`).

---

## 6. Prompt library table in the Vault (SPEC §9)

`Dashboard/Prompt Library.md` is a Dataview table over `Prompts/`. Full agent spec in [09-prompt-library.md](09-prompt-library.md).

- **Columns:** Title (link) · Tags · Tool · Last used.
- **Title links** to the prompt note in `Prompts/` holding the full body (relative note link or `obsidian://` deep link).
- **Prompt note frontmatter** mirrors the record shape: `{ title (≤ 6 words), slug, tags[], tool (Claude/Canva/etc.), full_prompt, created, last_used, uses }`.
- Optional surfacing: most-used at top; dedupe near-identical prompts.

````markdown
```dataview
TABLE WITHOUT ID
  file.link AS "Title",
  tags AS "Tags",
  tool AS "Tool",
  last_used AS "Last used"
FROM "Prompts"
SORT uses DESC, last_used DESC
```
````

---

## 7. Steward write contract (SPEC §6.4)

This is the rule every feeding agent obeys. Steward is the **only** writer; everyone else emits a Wire event and Steward applies it.

```
agent ──(Wire event)──▶  Queue (the Wire)  ──▶  Steward (single consumer / lock)  ──▶  Vault note(s)
```

**Event shape (canonical):**

```json
{
  "agent": "Headhunter",
  "type": "job.stage_changed",
  "entity": "Jobs/shopify-backend-intern",
  "op": "upsert",
  "payload": { "stage": "interview", "company": "Shopify" },
  "idempotencyKey": "headhunter:shopify-backend-intern:interview:2026-05-29"
}
```

| Field | Meaning |
|---|---|
| `agent` | source codename (Herald, Forge, …) — used in the heartbeat/run log |
| `type` | semantic event name |
| `entity` | target note/path (or counter key) |
| `op` | `increment` \| `upsert` \| `append` |
| `payload` | the data to apply |
| `idempotencyKey` | dedupe key — Steward records applied keys so a replay is a no-op |

**Guarantees:**

- **Serialized writes.** Single consumer (or a lock) so concurrent agents can't corrupt an Obsidian file. The Fri 16:00 fan-in (Scout + weekly-Herald) and any overlapping Headhunter run all funnel through this one serialized point — see [scheduling](03-scheduling.md) §"Concurrency rules".
- **Idempotent counters.** Counters move via `increment` keyed by `idempotencyKey`; a re-delivered event does not double-count.
- **Steward fetches nothing.** It only applies what it is fed (owner's explicit requirement, SPEC §4). If a counter looks wrong, the fix is upstream (the emitting agent) or a rebuild from per-entity notes — never a manual Vault edit.

---

## 8. What else to track day-to-day (owner deliverable)

The owner already asked for today's tasks (by date), month tasks, this-week events, and the jobs/events counters. Beyond that list, these earn their place on a dashboard the owner actually opens every morning:

1. **Deadline board (merged).** The single most valuable view — jobs + events + tasks collapsed into one date-sorted list. A deadline you can't see is a deadline you miss; splitting them across three views is how they slip.
2. **Waiting-on list (`③ Awaiting Reply`).** The owner's *blocked* items — the highest-leverage thing to chase because someone else is the bottleneck. Cheap to maintain (Filer already labels it).
3. **Open flags (Flagger).** Trust the system only as far as you can see it failing. P1/P2 push; P3/P4 batch here. Without this, silent agent failures rot the rest of the dashboard.
4. **Agent heartbeat / run log.** "Did the morning pipeline actually run?" If Compass didn't fire, the Top-3 panel is stale and the owner needs to know *why the glance is empty*, not just *that* it is.
5. **People / CRM follow-ups.** Job hunting and events generate contacts; a follow-up you forget is a relationship you lose. Low volume, high value.
6. **Finances snapshot (bills due, subscriptions).** A missed bill is an expensive, fully-preventable flag. Sourced straight from `Finance/Bill` + `Finance/Subscription` labels.
7. **Reading queue (`④ FYI / Read Later` + newsletters).** Keeps low-priority content *out* of the action surface while still capturing it — the morning glance stays about action, not noise.
8. **Quick-capture inbox.** The one note the owner edits by hand. Anything that doesn't fit a structured note lands here for later triage, so the dashboard never blocks a thought.
9. **Goals / OKRs (quarterly).** Connects the daily grind to the quarter so the day plan can be sanity-checked against what actually matters.

---

## 9. Failure modes & Flagger hooks

| Failure | Detection | Flag |
|---|---|---|
| Obsidian file conflict (sync race) | Steward write fails / `.sync-conflict` file appears | `P2 High`, source `Steward` |
| Counter drift (projection ≠ per-entity rebuild) | Fri 16:30 weekly build re-scan mismatch | `P3 Medium`, suggested action: rebuild `metrics.md` |
| Duplicate event delivered | `idempotencyKey` already applied | no-op (by design); not flagged |
| Stale heartbeat (pipeline didn't run) | no Steward events from expected agent by deadline | `P2 High`, surfaces in morning glance panel 5 |
| Dataview/Bases plugin missing on render | view shows raw code block | `P4 Low / Info` |
| Wire backlog (Steward behind) | queue depth grows | `P3 Medium`, source `Atlas` |

All flags route through Flagger → Steward → `Flags/`; see [08-flagger.md](08-flagger.md).

---

## 10. Config

- **Vault path** (local; synced).
- **Plugins:** Dataview (queries), Bases (kanban/calendar boards). State both as required.
- **Obsidian MCP bridge** endpoint + auth (SPEC §7) — how Steward reaches the local Vault from the cloud.
- **D1 mirror** of counters/run-log for cheap queries and rebuild-on-drift.
- **Weekly-review build time:** Fri 16:30 (Steward) — see [scheduling](03-scheduling.md).
- **Counter rebuild trigger:** on weekly build, or manual.

---

## 11. Open questions

- **Cloud → local Vault write path.** Steward runs on Cloudflare but the Vault is local/synced — is the Obsidian MCP bridge always reachable, or does Steward queue writes until the machine is online? (Affects whether the morning glance is fresh on a laptop-asleep morning.)
- **Bases vs Dataview maturity.** If Bases is too new/unstable for the kanban, fall back to a Dataview board — both query the same `Jobs/` frontmatter, so the data model doesn't change.
- **Sync-conflict policy.** On a `.sync-conflict` file, does Steward auto-resolve (it's the only writer, so its version should win) or flag for the owner?
- **Counter authority.** Counters are a projection; is the weekly rebuild frequent enough, or should drift be detected on every write?
- **Quick-capture promotion.** Should an agent (Forge?) periodically triage `Inbox/quick-capture.md` into structured notes, or is that strictly manual?

---

### Cross-links

- [Steward](agents/steward.md) — the sole Vault writer and its event consumer
- [Flagger](08-flagger.md) — incident feed rendered in §5
- [Prompt library](09-prompt-library.md) — Librarian + the table rendered in §6
- [Scheduling](03-scheduling.md) — when the feeding agents fire; Steward serialization
