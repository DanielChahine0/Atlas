# Sundial (calendar sync)

> **Purpose:** Take deadline-bearing tasks produced by [Forge](forge.md) and place each one as a deduplicated block on Google Calendar, then report the calendar state to [Steward](steward.md) — so deadlines live where they can't be ignored.

Roster **#4** ([01-agent-roster.md](../01-agent-roster.md)). Tier 1, the morning core loop: *"puts deadlines where they can't be ignored (calendar)."*

---

## At a glance

| | |
|---|---|
| **Codename** | **Sundial** |
| **Role** | Task → Google Calendar sync |
| **Runtime** | Cloud (Cloudflare Worker; per-agent Durable Object for run state) |
| **Trigger** | After [Forge](forge.md) — **08:20 daily**, mode `sync` (see [scheduling](../03-scheduling.md)) |
| **Inputs** | Tasks **with deadlines** from Forge (task store / D1); existing Google Calendar events |
| **Outputs** | Created/updated calendar events; a sync summary event on the [Wire](../02-architecture.md) for Steward |
| **Depends on** | **Forge** (tasks with deadlines) — strictly upstream in the morning chain |
| **Feeds** | **Google Calendar** (deadline blocks), **[Steward](steward.md)** (Vault counters/views), and indirectly **[Compass](compass.md)** which reads the settled calendar |
| **MCPs / tools** | **Google Calendar MCP**: `create_event`, `update_event`, `list_events`, `suggest_time` |
| **Writes to** | Google Calendar, Steward (via the Wire) |

---

## What it does

Sundial is the bridge between *what you have to do* (tasks) and *when it shows up* (calendar). It runs once per morning, **after Forge**, at **08:20**:

1. Pulls the set of Forge tasks that carry a **deadline** (`due` / `dueAt`). Tasks without a deadline are skipped — they belong to [Compass](compass.md)'s day plan, not the calendar.
2. For each deadline task, maps it to a **calendar block** (see [Task → calendar block mapping](#task--calendar-block-mapping)).
3. **Dedupes** against existing events so a re-run (or a task that already synced yesterday) never double-creates (see [Dedupe](#dedupe-dont-double-create)).
4. Creates new events, updates changed ones, and leaves unchanged ones alone — fully **idempotent**.
5. Sets **reminders** so the deadline surfaces before it's due.
6. Emits a sync summary to **Steward** for the Vault (Deadline board, upcoming-events counters, agent run-log).

It sits squarely in the strictly-sequential morning chain:

```
Filer ─▶ Herald ─▶ Forge ─▶  Sundial  ─▶ Compass
        (digest)  (tasks)   (calendar)  (day plan)
                              │
                              ▼  (sync summary on the Wire)
                           Steward ─▶ The Vault
```

Sundial **does not delete** calendar events on its own. Removing or cancelling a block is a [confirmation-gated](../11-security-privacy.md) action (Atlas design pillar #2: *suggest, don't destroy*). The Google Calendar MCP `delete_event` tool is deliberately **out of Sundial's toolset** for the autonomous path.

---

## How it works

```
                       ┌────────────────────────────────────────────┐
 08:20  Forge done  ──▶│ 1. fetch deadline tasks (due != null)      │
                       │ 2. list_events(window: now → max due)      │  ◀── Google Calendar MCP
                       │ 3. build index by atlasTaskId / dedupe key │
                       └───────────────┬────────────────────────────┘
                                       │  for each deadline task
                       ┌───────────────▼────────────────────────────┐
                       │ 4. map task + deadline → calendar block     │
                       │    (start, end, all-day?, reminders)        │
                       └───────────────┬────────────────────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          │ no matching event          │ matching event, drift       │ matching, identical
          ▼                            ▼                              ▼
   create_event(...)            update_event(eventId, ...)      (skip — already synced)
          │                            │                              │
          └────────────────────────────┴──────────────────────────────┘
                                       │
                       ┌───────────────▼────────────────────────────┐
                       │ 5. emit sync summary → the Wire → Steward   │
                       │ 6. on error → Flagger (severity + trust)    │
                       └─────────────────────────────────────────────┘
```

**Step detail:**

1. **Read deadline tasks.** Query the task store for tasks where `due` is set and `status` is open. Each task carries (at least) `atlasTaskId`, `title`, `due` (date or datetime), `priority`, `source` (e.g. `① Action Required`, `Headhunter`), and an optional `estimateMins`.
2. **List the existing window.** Call `list_events` once for the calendar over the window `[today, max(due) + 1d]`. This is the dedupe corpus — fetch it up front rather than per-task to stay inside Google API rate limits.
3. **Index for dedupe.** Build a lookup keyed on the `atlasTaskId` stamped into each Sundial-owned event (see [Dedupe](#dedupe-dont-double-create)).
4. **Map → block.** Turn `(task, due)` into start/end/all-day/reminders per the [mapping rules](#task--calendar-block-mapping). Use `suggest_time` only for the *focus-block* policy (find a free slot), not for the deadline marker itself.
5. **Reconcile.** Decide per task: **create**, **update**, or **skip** — never blind-create.
6. **Report.** Emit one summary event to the Wire for Steward; on any failure, raise a [Flagger](flagger.md) flag.

---

### Which Google Calendar MCP tools it uses

| Tool | When Sundial calls it | Why |
|------|----------------------|-----|
| `list_events` | Once per run, up front | Build the dedupe corpus over the deadline window; detect drift on already-synced tasks. |
| `create_event` | Per **new** deadline task with no matching event | Create the deadline block (with reminders + `atlasTaskId` in extended properties). |
| `update_event` | Per task whose deadline/title/priority **changed** vs. its existing event | Move the block, fix the title, refresh reminders — no duplicate. |
| `suggest_time` | Only when a task uses the **focus-block** policy (needs a worked slot, not just a marker) | Ask Calendar for a free slot of `estimateMins` before the deadline, around existing events. |

> `delete_event` is intentionally **not** used by Sundial's autonomous path. Cancelling a synced block goes through a human-confirmed flow (a task marked done/cancelled in Forge → Sundial *proposes* removal → owner confirms). This honors *suggest, don't destroy*.

---

## Task → calendar block mapping

Sundial maps each deadline task into one of three block shapes. The choice is driven by the deadline's precision and the task's `estimateMins`.

| Task shape | Calendar block | Tool | Reminders |
|------------|----------------|------|-----------|
| Date-only deadline, no time (e.g. *"Apply by Fri"*) | **All-day event** on the due date, titled `⏳ <task title>` | `create_event` (all-day) | 1 day before, 09:00 day-of |
| Datetime deadline (e.g. *"Submit OA by 18:00"*) | **Timed marker**, default 30 min ending **at** the deadline | `create_event` (timed) | 1 day before, 1 hour before |
| Has `estimateMins` and policy = **focus-block** | A **work block** of `estimateMins`, scheduled in a free slot **before** the deadline | `suggest_time` → `create_event` | 10 min before the block |

**Mapping rules**

- **Title:** prefix with `⏳ ` so deadline blocks are visually distinct from meetings/events placed by [Usher](usher.md). Keep the Forge task title verbatim after the prefix.
- **Anchor on the deadline.** A timed marker **ends at** `due` (the deadline is the hard edge); the block sits in the 30 min before it by default.
- **All-day for date-only.** If Forge gives a date with no time, never invent a time — use an all-day event so it spans the day on the calendar.
- **Focus-block via `suggest_time`.** When a task carries `estimateMins` and the focus-block policy is on, call `suggest_time` with the duration and a window of `[now, due]` to get a free slot that dodges existing events, then `create_event` for that slot. The deadline itself still gets a marker so the hard edge is never lost.
- **Priority → reminder strength.** Higher-priority tasks (and `From/VIP`-sourced or `Due/Today` tasks) get the earlier/extra reminder; `④ FYI`-grade deadlines get the minimal set.
- **Source carries through.** Stamp the task `source` (e.g. `Job/OA`, `School/Deadline`) into the event description so the Vault Deadline board and [Compass](compass.md) can group by origin.

**Identity stamp (required on every event Sundial creates):** the `atlasTaskId` and `agent: "sundial"` go into the event's **extended/private properties**. This is what makes dedupe and update reliable across runs.

```
event = {
  summary:     "⏳ " + task.title,
  start/end:   <from mapping rules>,
  description: "Atlas/Sundial · source=" + task.source + " · task=" + task.atlasTaskId,
  reminders:   <from table above>,
  extendedProperties.private: {
    atlasTaskId: task.atlasTaskId,   // dedupe key
    agent:       "sundial",
    syncedDue:   task.due,           // drift detection
    contentHash: hash(title,due,priority)
  }
}
```

---

## Reminders

Reminders are how a calendar block actually *nags*. Sundial sets them at create/update time via the event's reminder overrides (it does not rely on the calendar's default).

| Deadline class | Reminders set |
|----------------|---------------|
| All-day (date-only) | popup **1 day before**, popup **09:00 on the day** |
| Timed marker | popup **1 day before**, popup **1 hour before** |
| Focus work block | popup **10 min before** the block starts |
| `Due/Today` / high priority | add an extra popup **2 hours before** |

Rules:

- Reminders are **idempotent**: on `update_event`, Sundial re-asserts the full reminder set rather than appending, so re-runs can't stack duplicate alerts.
- Never silently drop a reminder the owner added manually — if `list_events` shows owner-added overrides on a Sundial event, Sundial **merges** (keeps owner overrides, ensures its own minimum) and notes the merge in the run-log.

---

## Dedupe (don't double-create)

The whole point: **a task must produce exactly one calendar block**, no matter how many times Sundial runs. The morning chain re-runs daily and the run is required to be idempotent (Atlas pillar #5).

**Dedupe key:** `extendedProperties.private.atlasTaskId`.

Reconciliation per deadline task:

```
match = listed_events.find(e => e.extendedProperties.private.atlasTaskId == task.atlasTaskId)

if  no match            ──▶  create_event(...)              # first time this task is seen
elif match && drift     ──▶  update_event(match.id, ...)    # due/title/priority changed
else                    ──▶  skip                            # identical → leave it alone
```

- **`atlasTaskId`**, not title or time, is the identity. Titles change and times move; the task id is stable, so renaming a task or pushing its deadline → `update_event`, never a second block.
- **Drift detection** compares the live event against `syncedDue` and `contentHash` stamped on it. No drift → skip (no API write at all, saving rate budget).
- **Fetch-then-decide.** Sundial pulls the window with `list_events` *before* writing anything. It never calls `create_event` without first confirming no event carries that `atlasTaskId`.
- **Orphans (task gone/completed).** If a Sundial-owned event has an `atlasTaskId` no longer present (or now `done`/`cancelled`) in the task set, Sundial does **not** delete it autonomously — it flags a *proposed removal* to the owner and lets Steward surface it. (`delete_event` stays human-gated.)
- **Don't touch foreign events.** Any calendar event without `agent: "sundial"` in its properties is the owner's (or Usher's) and is read-only to Sundial.

---

## Inputs / Outputs

**Inputs**

- **Deadline tasks** from [Forge](forge.md): `{ atlasTaskId, title, due, priority, source, estimateMins? }`, filtered to `due != null && status == open`.
- **Existing calendar events** for the window via `list_events`.

**Outputs**

- **Google Calendar:** created/updated `⏳ <task>` blocks with reminders and the Sundial identity stamp.
- **Steward (via the Wire):** a sync summary event so the Vault stays current. Shape per the [Steward write contract](steward.md) (`{ agent, type, entity, op, payload, idempotencyKey }`):

```
{
  agent: "sundial",
  type: "calendar.sync",
  entity: "deadlines",
  op: "upsert",
  payload: { created: N, updated: M, skipped: K, upcoming7d: [...] },
  idempotencyKey: "sundial-" + runDate          // replay-safe; won't double-count
}
```

This feeds the Vault **Deadline board** (jobs + events + tasks merged, sorted by date), the **Upcoming events (7 days)** view, and the **agent heartbeat / run log** (see [06-obsidian-vault.md](../06-obsidian-vault.md) §6.2).

---

## Dependencies

- **Upstream:** [Forge](forge.md) must finish first (08:15 → 08:20). Sundial consumes Forge's deadline tasks; if Forge produced nothing new, Sundial still runs to reconcile/skip but writes no new blocks.
- **Downstream:** [Compass](compass.md) (08:30) reads the **settled** calendar — Sundial must complete so Compass sees the deadline blocks alongside meetings/events. [Steward](steward.md) consumes the sync summary off the Wire.
- **Sibling writer to Calendar:** [Usher](usher.md) also writes Google Calendar (event registrations). They don't collide — Sundial only ever touches events stamped `agent: "sundial"`; Usher's events are foreign and read-only to Sundial.
- **Source of truth:** Sundial reads tasks; it does **not** read [The Codex](../07-source-of-truth-codex.md).

---

## Schedule / Triggers

| Time / trigger | Mode | Notes |
|----------------|------|-------|
| **08:20 daily** | `sync` | After Forge (08:15), before Compass (08:30). Strictly sequential — start-after-Forge-success. |
| on-demand | `sync` | When Forge extracts tasks ad hoc (e.g. a new `① Action Required` mail mid-day), Atlas may re-fire Sundial to sync the new deadline. Idempotent, so safe. |

Concurrency: Sundial is part of the **strictly sequential** morning chain (Filer → Herald → Forge → Sundial → Compass) — see [03-scheduling.md](../03-scheduling.md). It does not run in parallel with its neighbors.

---

## Failure modes & Flagger hooks

Every failure is reported to [Flagger](flagger.md) with a severity and trust score.

| Failure | Severity | Trust | Sundial behavior |
|---------|----------|-------|------------------|
| Google Calendar MCP auth/token expired | `P2 High` | high (caught error) | Abort run, flag; Compass still runs on last-known calendar. |
| Calendar API rate-limit / 429 | `P3 Medium` | high | Back off + retry with jitter; batch on next run. |
| `create_event` succeeded but `list_events` later shows a **duplicate** `atlasTaskId` | `P2 High` | high | Reconcile: keep earliest, propose removal of the dup (gated); flag the dedupe miss. |
| Task has a deadline Sundial can't parse into a time | `P3 Medium` | medium (heuristic) | Fall back to an all-day block on the date; flag `AI/Uncertain`-style low-confidence. |
| `suggest_time` returns no free slot before the deadline | `P3 Medium` | high | Drop to a plain timed marker at the deadline; note "no slot found" in run-log. |
| Forge produced no deadline tasks | — | — | Not a failure. Reconcile/skip, write a "0 created" run-log line. |
| Run did not fire at 08:20 (missed cron) | `P2 High` | high | Flagger's self-monitoring catches the stale heartbeat (see §8). |

---

## Config

| Key | Default | Meaning |
|-----|---------|---------|
| `calendarId` | `primary` | Target Google Calendar. |
| `runAt` | `08:20` | Cron trigger time (owner-local). |
| `window.aheadDays` | `60` | How far ahead `list_events` scans / Sundial will place blocks. |
| `defaultMarkerMins` | `30` | Length of a timed deadline marker. |
| `focusBlocks.enabled` | `true` | Whether to use `suggest_time` to place work blocks for tasks with `estimateMins`. |
| `reminders.allDay` | `[1d, 09:00-day-of]` | Reminder overrides for all-day blocks. |
| `reminders.timed` | `[1d, 1h]` | Reminder overrides for timed markers. |
| `titlePrefix` | `⏳ ` | Visual marker on Sundial-owned events. |
| `allowDelete` | `false` | Autonomous delete is **off**; removals are owner-confirmed. |

Secrets (Google OAuth token) live in Cloudflare Secrets Store with **least-privilege** Calendar scopes — read + create/update events, **no** delete scope on the autonomous path ([11-security-privacy.md](../11-security-privacy.md)).

---

## Example run

**08:20, Thursday.** Forge just finished and handed Sundial three deadline tasks:

| `atlasTaskId` | title | due | priority | estimateMins | source |
|---------------|-------|-----|----------|--------------|--------|
| `t-9001` | Submit Shopify OA | Thu 18:00 | high | 90 | `Job/OA` |
| `t-9002` | Pay hydro bill | Sat (date only) | med | — | `Finance/Bill` |
| `t-9003` | CS343 assignment | Fri 23:59 | high | — | `School/Deadline` |

1. **`list_events`** over `[Thu, Sat+1d]` returns yesterday's blocks, including one already stamped `atlasTaskId: t-9003` (the assignment synced yesterday) — and an owner-placed "Lunch w/ Sam 12:00".
2. **Reconcile:**
   - `t-9001` — no matching event → **create**.
     - `estimateMins=90` + focus-blocks on → **`suggest_time`** for a 90-min slot in `[now, Thu 18:00]`, dodging "Lunch w/ Sam" → returns **14:30–16:00**.
     - **`create_event`** work block `⏳ Submit Shopify OA` 14:30–16:00, reminder 10 min before; **plus** a timed marker `⏳ Submit Shopify OA (due)` ending 18:00 with reminders 1d / 1h before.
   - `t-9002` — date-only → **`create_event`** all-day `⏳ Pay hydro bill` on Sat, reminders 1 day before + 09:00 day-of.
   - `t-9003` — matching event found; `syncedDue` and `contentHash` **unchanged** → **skip** (no API write).
3. **`update_event`** — none this run (no drift).
4. **Emit to the Wire → Steward:** `{ created: 2, updated: 0, skipped: 1, upcoming7d: [...] }`. The Vault **Deadline board** now shows the OA, the bill, and the assignment merged and sorted by date; the run-log records `Sundial 08:20 ✓ +2 ~0 =1`.
5. **No flags** raised. [Compass](compass.md) fires at 08:30 and sees all three deadlines on a settled calendar when it builds today's plan.

**Re-run safety:** if Atlas re-fires Sundial at 08:22 (e.g. Forge extracted a mid-morning task), the OA, bill, and assignment events all match by `atlasTaskId` with no drift → all **skipped**, only the new task creates a block. No doubles.

---

## Open questions

- **Separate "Atlas Deadlines" calendar vs. `primary`?** A dedicated calendar makes Sundial's blocks easy to toggle/colour, but Compass + the owner's glance may prefer everything on `primary`. Default `primary` for now.
- **Focus-block aggressiveness.** Should Sundial auto-place work blocks for *every* task with an estimate, or only high-priority ones, to avoid cluttering the calendar? Currently policy-gated per task.
- **Timezone on travel.** When [Filer](filer.md)/`Type/Travel` implies the owner is in another timezone, should deadline markers shift? Out of scope v1 — anchor to the owner's home tz.
- **Marker length.** Is a 30-min timed marker the right default, or should it be a 0-min "point" event for pure deadlines? Owner preference TBD.
