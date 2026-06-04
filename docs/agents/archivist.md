# Archivist (meeting-notes organizer)

> **Purpose:** Turn **Echo**'s raw meeting transcript into *structured*, context-aware meeting
> notes — attendees, agenda, decisions, action items, follow-ups — and hand them to **Steward** to
> write into the Vault, threading context across prior meetings and the owner's work experience from
> the Codex.

Roster **#10** · Tier 3 (high value, technically harder — local capture / screen). Archivist is the
cloud half of the meetings pipeline; **Echo** (#9) is the local half. Echo captures and transcribes
in real time on the machine; Archivist runs *after the meeting ends* and does the structuring.

---

## At a glance

| Field | Value |
|-------|-------|
| **Codename** | **Archivist** |
| **Role** | Meeting-notes organizer (structured, context-aware) |
| **Runtime** | **Cloud** (Cloudflare Worker; multi-step run via Cloudflare Workflows) |
| **Trigger** | `event: meeting ends` — fires after **Echo**'s transcript is ready (see [scheduling](../03-scheduling.md)) |
| **Inputs** | Echo transcript (from the transcript store) · prior meeting notes (Vault) · the **Codex** (work experience / project context) · the notes **template** |
| **Outputs** | One structured meeting-notes record → **Steward** event on the Wire; action items → **Forge**; meeting indexed in the **Meeting-notes index** view |
| **Dependencies** | **Echo** (transcript) + **The Codex** (context). Feeds **Forge** (action items → tasks) and **Steward** (notes + meeting counters). |
| **MCPs / tools** | Obsidian MCP (read prior notes, via Steward for writes) · Codex read (Google Doc / Vault `codex.md`) · the Wire (Cloudflare Queue) · Claude via AI Gateway (Opus for reasoning) |
| **Writes to** | **Vault (via Steward only)** — Archivist never writes the Vault directly |

---

## What it does

Echo produces a transcript: a wall of speaker-attributed text with timestamps. That is raw material,
not notes. Archivist reads that transcript and produces a **structured record** that a human can scan
in 20 seconds and that downstream agents can act on:

1. **Attendees** — who was in the meeting (resolved against the Codex / past meetings where possible).
2. **Agenda / topics** — what was discussed, in order.
3. **Decisions** — what was actually decided (distinct from things merely discussed).
4. **Action items** — concrete commitments with an owner and, where stated, a deadline. These are
   **handed to Forge** to become tasks.
5. **Follow-ups** — open threads, parked items, "circle back next week" — not yet tasks.

It does this with three context sources beyond the transcript itself:

- **A fixed notes template** — every meeting comes out in the same shape, so the Vault index is
  uniform and Dataview/Bases queries work.
- **Prior meetings** — Archivist threads context across meetings in the same series (recurring
  standup, 1:1, project sync) so "the thing we discussed last time" resolves to a real note.
- **The Codex** — the owner's work experience, projects (name, repo, blurb), and titles, so Archivist
  recognises project names, internal acronyms, and people the owner works with.

It then sends the finished record to **Steward** (Vault write) and the extracted action items to
**Forge** (task creation). Archivist itself **writes nothing** to the Vault directly — one-writer-per-
resource is a system pillar.

---

## How it works

```
                 Echo transcript (transcript store)
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │  ARCHIVIST  (Cloudflare Workflow, after meeting ends)     │
   │                                                           │
   │  1. Load transcript        ◀── Echo (R2 / transcript store)│
   │  2. Load notes TEMPLATE    ◀── fixed template (KV)         │
   │  3. Load PRIOR meetings    ◀── Vault (Meeting-notes index) │
   │  4. Load CODEX context     ◀── Codex (work exp / projects) │
   │  5. Structure → template   ── Opus via AI Gateway          │
   │  6. Extract ACTION ITEMS   ── owner + deadline per item    │
   │  7. Emit events ───────────┐                              │
   └────────────────────────────┼──────────────────────────────┘
                                │
              ┌─────────────────┼──────────────────┐
              ▼                                     ▼
   action items ──▶ FORGE                 structured notes ──▶ STEWARD
   (become tasks)                          on the Wire ──▶ The Vault
                                           (note + meeting counters)
```

Step by step:

1. **Receive the trigger.** Atlas fires Archivist on `meeting ends` once Echo signals the transcript
   is finalised (not mid-stream — Echo runs in parallel, real-time; Archivist runs once, after).
2. **Load the transcript** from the transcript store (R2 blob / D1 pointer that Echo wrote).
3. **Load the template** (below) — the canonical output shape.
4. **Thread prior context.** Match this meeting to a series and pull the last N notes for it from the
   **Meeting-notes index** (see §6.2). This is how "as discussed last week" and "did we ship that?"
   resolve. See [Threading context across meetings](#threading-context-across-meetings).
5. **Load Codex context.** Read the owner's **work experience**, **projects**, and identity from
   [the Codex](../07-source-of-truth-codex.md) so project names, internal acronyms, and colleague
   names are recognised rather than transcribed as noise. The Codex is **read-only** to Archivist.
6. **Structure.** One Opus pass (via AI Gateway) maps the transcript into the template: attendees,
   agenda, decisions, action items, follow-ups.
7. **Extract action items.** See [Action-item extraction](#action-item-extraction) — each item gets an
   owner and (if stated) a deadline; only items owned by *the owner* are emitted to Forge.
8. **Emit events on the Wire:**
   - one `upsert` event to **Steward** carrying the structured note + meeting counters
     (`meetings this week`, `hours in meetings` — §6.1);
   - one event per owner-action-item to **Forge** so it can create tasks.
9. **Index.** Steward files the note into the **Meeting-notes index** view, which becomes prior
   context for the *next* meeting in the series — closing the loop.

Every run is **idempotent**: re-running on the same transcript carries the same `idempotencyKey`, so
Steward won't double-count meeting hours and Forge won't create duplicate tasks.

---

## The notes template

A **fixed** template means every meeting comes out identically shaped, so the Vault index, Dataview
queries, and cross-meeting threading all stay reliable. Archivist fills this — it doesn't invent
sections per meeting.

```markdown
---
type: meeting-note
title: "{Meeting title}"
date: {YYYY-MM-DD}
time: "{HH:MM}–{HH:MM}"
series: "{recurring series id, e.g. weekly-1on1-manager}"   # null for one-offs
attendees: [Daniel Chahine, ...]
project: "{Codex project name, if any}"
duration_min: {int}
source: echo-transcript
status: draft            # draft until owner glances; never auto-final
---

# {Meeting title} — {date}

## Attendees
- Daniel Chahine (owner)
- {Name} — {role/company, resolved via Codex / prior notes}

## Agenda / Topics
1. {topic}
2. {topic}

## Decisions
- {decision actually made — not just discussed}

## Action items
| Owner | Action | Due | → Forge? |
|-------|--------|-----|----------|
| Daniel | {action} | {YYYY-MM-DD / —} | yes |
| {Name} | {action} | {—} | no (not owner) |

## Follow-ups
- {open thread / parked item / "revisit next week"}

## Context links
- Prior: [[{previous note in series}]]
- Related project: [[{Codex project}]]
```

Field notes:

- **`series`** is what enables [cross-meeting threading](#threading-context-across-meetings). A
  recurring standup or 1:1 gets a stable `series` id so its notes chain together.
- **`status: draft`** — per the **Suggest, don't destroy** pillar, notes land as drafts. Archivist
  never marks a note authoritative on its own; the owner glances and confirms.
- The **Action items table** is the contract with **Forge**: the `→ Forge?` column marks which rows
  are emitted as task events (only the owner's, see below).
- **Context links** are real Obsidian wiki-links (`[[…]]`) so the note is navigable in the Vault.

---

## Threading context across meetings

This is the part that makes Archivist more than a one-shot summariser. A meeting almost never stands
alone — it's the 7th weekly sync, the 3rd 1:1, the follow-up to last Tuesday. Archivist threads that
history so notes reference each other and decisions can be tracked over time.

```
Meeting #6 note ──▶ Meeting #7 note ──▶ Meeting #8 note   (series: weekly-1on1-manager)
   decisions          "did we ship X?"      "X shipped; new ask Y"
   action items   ───▶ check off / carry ─▶ carry forward
```

**How a meeting is matched to a series:**

1. **Calendar / title match** — recurring calendar events (the same invite the meeting came from)
   share a series; the title + recurrence id seed the `series` field.
2. **Attendee overlap** — same people + similar cadence ⇒ likely the same series, resolved against
   the Vault's **People/CRM** view (§6.2) and the Codex.
3. **Project anchor** — meetings tied to the same Codex **project** are linked even across series.

**What threading buys you:**

- **Reference resolution** — "the migration we talked about" links to the note where it was decided,
  instead of being an orphan phrase.
- **Open-loop tracking** — last meeting's action items / follow-ups are pulled in; Archivist notes
  which were closed and **carries forward** the ones still open.
- **Consistent naming** — people and projects keep the same canonical name across the whole series
  (sourced from prior notes + Codex), so Dataview rollups don't fragment.

Archivist reads prior notes through the Obsidian MCP (read-only); it still **writes nothing** itself —
the updated/linked note goes out as a Steward event.

---

## Action-item extraction

The highest-value, highest-risk part. A decision is informational; an **action item** becomes a task
in the owner's life, so precision matters.

**For each candidate action item Archivist resolves three things:**

| Field | How it's resolved | Why it matters |
|-------|-------------------|----------------|
| **Owner** | Who committed — speaker attribution from Echo + Codex name resolution | Only the *owner's* items go to Forge; others stay informational in the note |
| **Action** | The concrete verb phrase ("send the deck", "review PR #42") | Forge needs an actionable task, not "we should think about X" |
| **Due** | Explicit date if stated ("by Friday"), else left `—` | Drives Forge's deadline + Sundial's calendar sync downstream |

**Rules:**

- **Decision ≠ action item.** "We decided to use Postgres" is a *decision*; "Daniel will set up the
  Postgres instance by Thu" is an *action item*. Decisions go in the Decisions section only.
- **Only the owner's items reach Forge.** Items owned by *other* attendees are recorded in the note
  (so the owner can chase them) but are **not** emitted as tasks — Atlas only manages the owner's
  digital life.
- **Stated deadlines only.** Archivist does not invent due dates. "By next week" → resolved to a
  concrete date relative to the meeting date; no date stated → `—`, and Forge files it without a
  deadline (so Sundial won't put it on the calendar).
- **Low confidence ⇒ flag, don't drop.** If Archivist isn't sure an utterance is a real commitment, it
  keeps the row but marks it uncertain, and raises a low-trust flag (below) rather than silently
  guessing. Mirrors Filer's `AI/Uncertain` philosophy.
- **Idempotent emission.** Each action item carries a stable `idempotencyKey` (meeting id + item
  index), so re-running Archivist on the same transcript never creates duplicate Forge tasks.

**Hand-off to Forge** — Archivist emits one Wire event per owner-action-item:

```jsonc
{
  "agent": "Archivist",
  "type": "action-item",
  "entity": "task",
  "op": "upsert",
  "payload": {
    "title": "Send the architecture deck to the team",
    "due": "2026-06-05",            // or null if no date stated
    "source": "meeting",
    "meeting": "weekly-1on1-manager/2026-05-29",
    "owner": "Daniel Chahine"
  },
  "idempotencyKey": "archivist:weekly-1on1-manager:2026-05-29:ai-03"
}
```

[Forge](forge.md) then creates the task (with its deadline), and [Sundial](sundial.md) syncs deadline
tasks to Google Calendar — so a meeting commitment ends up on the calendar without manual entry.

---

## Inputs / Outputs

**Inputs**

- **Echo transcript** — speaker-attributed, timestamped text from the transcript store (R2/D1).
- **Notes template** — the fixed shape above (KV).
- **Prior meeting notes** — last N notes in the same `series` (Vault, read via Obsidian MCP).
- **The Codex** — work experience, projects, identity (read-only).

**Outputs**

- **Structured meeting note** → Steward event (`upsert`) → Vault, filed in the **Meeting-notes index**.
- **Action items** → Forge events (one per owner-item) → tasks.
- **Meeting counters** → Steward (`increment`: meetings this week, hours in meetings — §6.1).
- **Flags** → Flagger on low-confidence extraction, missing transcript, or template/parse failure.

---

## Dependencies

| Depends on | For |
|------------|-----|
| **Echo** (#9) | The transcript — Archivist has no input without it |
| **The Codex** | Work context: project names, people, acronyms, owner identity |
| **Steward** (#11) | All Vault writes (note + counters); Archivist never writes the Vault |
| **Forge** (#3) | Turning owner action items into tasks |

| Feeds | What |
|-------|------|
| **Forge** | Owner action items → tasks (then Sundial → calendar) |
| **Steward** | The note + `meetings this week` / `hours in meetings` counters |
| **Flagger** | Incidents (see below) |

Per [§4](../02-architecture.md): *Archivist depends on Echo (transcript) + the Codex (context).* It
sits in the **meetings pipeline** (`Echo → Archivist → Steward → Vault`), separate from the morning
chain.

---

## Schedule / Triggers

| Trigger | Mode | Notes |
|---------|------|-------|
| `event: meeting ends` | — | After Echo's transcript is ready. **Not** scheduled by cron. |

- Archivist is **event-driven**, fired by Atlas when Echo finalises a transcript.
- **Echo runs in parallel with everything** (real-time, local); Archivist runs **once, after** the
  meeting — never mid-stream.
- Long transcripts run as a **Cloudflare Workflow** (durable multi-step) so a model timeout or a
  Steward back-pressure pause can resume without re-doing the whole structuring pass.

See [scheduling](../03-scheduling.md) for the full table and concurrency rules.

---

## Failure modes & Flagger hooks

| Failure | Detection | Flag (severity · trust) | Handling |
|---------|-----------|-------------------------|----------|
| Transcript never arrives / empty | Echo signalled end but no/empty blob | **P2 High** · high trust | Don't fabricate notes; flag and wait for Echo retry |
| Transcript truncated / garbled | Heuristic + low model confidence | **P3 Medium** · medium trust | Produce partial note marked incomplete; flag |
| Action item ambiguous (real commitment?) | Model confidence below bar | **P4 Low/Info** · low trust | Keep row, mark uncertain, flag — never silently drop |
| Attendee / project can't be resolved | No Codex / prior-note match | **P4 Low/Info** · low trust | Record raw name; flag for owner to canonicalise |
| Steward write rejected (conflict) | Wire NACK | **P3 Medium** · high trust | Idempotent retry; the `idempotencyKey` prevents double-write |
| Duplicate run on same meeting | Same `idempotencyKey` seen | — | No-op by design (idempotent); no duplicate tasks/counters |

Flag shape and routing follow [Flagger](../08-flagger.md): `{ id, ts, source_agent, severity, trust,
title, detail, suggested_action, status }`, P1/P2 → push, P3/P4 → batched into the dashboard feed.
Low-trust extraction flags exist precisely so the owner knows *how much to believe* an auto-generated
action item.

---

## Config

| Key | Default | Purpose |
|-----|---------|---------|
| `prior_notes_window` | `3` | How many prior notes in a series to thread in for context |
| `codex_sections` | `work_experience, projects, identity` | Which Codex sections to load |
| `template_id` | `meeting-note/v1` | Which notes template (KV) to fill |
| `action_item_confidence` | `0.6` | Below this, mark item uncertain + flag (don't emit to Forge silently) |
| `emit_others_actions` | `false` | If true, emit *all* attendees' actions to Forge (default: owner only) |
| `model` | `opus` (via AI Gateway) | Structuring/extraction model; reasoning-heavy ⇒ Opus |
| `note_status` | `draft` | Notes land as drafts until the owner glances (Suggest, don't destroy) |

---

## Example run

**Input — Echo transcript (excerpt):**

```
[00:00] Daniel: Quick sync on the Atlas dashboard. Priya, you joined — welcome.
[00:31] Priya: Thanks. So where are we on the Vault write path?
[00:48] Daniel: Steward's serialized now. I want to move the meeting counters in this week.
[01:10] Priya: We agreed last sync we'd use D1 for the run-log, right?
[01:18] Daniel: Yeah, that's decided. I'll wire the run-log into D1 by Thursday.
[02:02] Priya: I'll draft the counters schema and send it over.
[02:30] Daniel: Cool. Let's revisit the Obsidian MCP bridge next week — parked for now.
```

**Context threaded in:**

- **Series** `weekly-atlas-sync` → prior note (#5) where "use D1 for the run-log" was decided →
  "we agreed last sync" resolves to that note (open loop now closing).
- **Codex** → `Atlas` recognised as a **project**; *Daniel Chahine* = owner; counters/Vault
  terminology recognised, not transcribed as noise.

**Output — structured note (handed to Steward):**

```markdown
---
type: meeting-note
title: "Atlas dashboard sync"
date: 2026-05-29
time: "14:00–14:33"
series: "weekly-atlas-sync"
attendees: [Daniel Chahine, Priya]
project: "Atlas"
duration_min: 33
source: echo-transcript
status: draft
---

# Atlas dashboard sync — 2026-05-29

## Attendees
- Daniel Chahine (owner)
- Priya — collaborator (resolved via prior notes)

## Agenda / Topics
1. Vault write path / Steward serialization
2. Run-log storage (D1) — confirming prior decision
3. Meeting counters
4. Obsidian MCP bridge (parked)

## Decisions
- Use **D1** for the run-log. (Confirmed from [[2026-05-22 Atlas dashboard sync]].)
- Steward writes are now serialized.

## Action items
| Owner | Action | Due | → Forge? |
|-------|--------|-----|----------|
| Daniel | Wire the run-log into D1 | 2026-06-04 (Thu) | yes |
| Priya | Draft the counters schema and send it over | — | no (not owner) |

## Follow-ups
- Revisit the Obsidian MCP bridge next week (parked).

## Context links
- Prior: [[2026-05-22 Atlas dashboard sync]]
- Related project: [[Atlas]]
```

**Events emitted on the Wire:**

1. To **Steward** — `upsert` the note above + `increment` `meetings this week` (+1) and `hours in
   meetings` (+0.55h), all under one `idempotencyKey`.
2. To **Forge** — one `action-item` event for *Daniel's* item only:

   ```jsonc
   {
     "agent": "Archivist", "type": "action-item", "entity": "task", "op": "upsert",
     "payload": {
       "title": "Wire the run-log into D1",
       "due": "2026-06-04", "source": "meeting",
       "meeting": "weekly-atlas-sync/2026-05-29", "owner": "Daniel Chahine"
     },
     "idempotencyKey": "archivist:weekly-atlas-sync:2026-05-29:ai-01"
   }
   ```

   Priya's "draft the counters schema" is **recorded in the note but not sent to Forge** (not the
   owner's task). The parked MCP-bridge item is a **follow-up**, not an action item — no task.

**Downstream:** [Forge](forge.md) creates the "Wire the run-log into D1" task with its Thursday
deadline; [Sundial](sundial.md) syncs it to Google Calendar; [Steward](steward.md) files the note into
the **Meeting-notes index**, where it becomes prior context for next week's `weekly-atlas-sync`.

---

## Open questions

- **Series matching reliability** — when calendar recurrence ids are missing (ad-hoc meetings), how
  aggressively should attendee-overlap heuristics link a meeting into an existing series before it
  risks mis-threading? Current default leans conservative (new series over wrong series).
- **Mid-meeting drafts** — should Archivist ever produce a *provisional* note from a partial transcript
  while Echo is still streaming, or strictly wait for `meeting ends`? Spec says after; revisit if the
  owner wants live notes.
- **Other attendees' commitments** — `emit_others_actions` is off by default. Is a lightweight
  "things others owe me" view in the Vault worth more than Forge tasks the owner can't complete?
- **Decision provenance** — should each decision link to the *exact* transcript timestamp for audit,
  or is a note-level link enough?

---

*Related: [Echo](echo.md) · [Forge](forge.md) · [Sundial](sundial.md) · [Steward](steward.md) ·
[Flagger](../08-flagger.md) · [the Codex](../07-source-of-truth-codex.md) ·
[scheduling](../03-scheduling.md) · [architecture](../02-architecture.md)*
