# Compass (daily planner)

**Purpose:** Merge open tasks (from **Forge**) with today's calendar (from **Sundial**/**Usher**) into a single ordered, time-blocked **day plan** with a top-3 priorities banner, written to The Vault via **Steward**.

---

## At a glance

| | |
|---|---|
| **Codename / role** | Compass — daily planner (tasks + calendar → day plan) |
| **Roster #** | 5 ([01-agent-roster](../01-agent-roster.md)) |
| **Runtime** | Cloud (Cloudflare Worker; per-agent Durable Object for run state) |
| **Trigger** | cron **08:30 daily** (mode `plan`) · cron **21:00 daily** (mode `preview`) |
| **Inputs** | open tasks (Forge / D1 task store) · today's Google Calendar (Sundial + Usher events) · The Codex (working-hours / focus prefs) |
| **Outputs** | ordered, time-blocked day plan + top-3 priorities → an `upsert` event on the Wire |
| **Dependencies** | **Forge** (tasks w/ deadlines), **Sundial**/**Usher** (calendar), **Steward** (write), **Flagger** (incidents) |
| **MCPs / tools** | Google Calendar MCP (read) · D1 task store (read) · Workers AI / AI Gateway (Claude) |
| **Writes to** | The Vault — **only via Steward** (Compass writes nothing directly) |

Compass is **Tier 1 — the core loop** ([§3](../SPEC-CANON.md)): the "what do I actually do today" synthesizer. It is the last stage of the morning pipeline and the source of the **Today** view and the **morning glance** top-3.

---

## What it does

Compass does not discover work and does not own any external system. It **reads** two already-settled sources and **reduces** them to one decision: *here is your day, in order, in time blocks.*

1. **Read tasks** — every open task from the Forge / D1 task store (title, deadline, est. duration, source label such as `① Action Required` / `Needs/*` / `Due/Today`).
2. **Read calendar** — today's Google Calendar events. These are already on the calendar because **Sundial** synced deadline tasks (08:20) and **Usher** added registered events. Compass treats the calendar as **fixed commitments** — it never moves or deletes events (one-writer rule; Sundial/Usher own the calendar).
3. **Merge & prioritize** — score tasks by deadline urgency + label tier, then fit the top tasks into the **gaps between calendar events** during working hours.
4. **Detect overcommitment** — if required work exceeds available focus time, surface it instead of silently dropping tasks.
5. **Emit the plan** — an ordered, time-blocked list + a **top-3 priorities** banner, sent to Steward for the **Today** note.

Two modes, one prompt, one codebase:

| Mode | Cron | Output |
|------|------|--------|
| `plan` | **08:30 daily** | **Today's** plan — the live, time-blocked day. Runs *after* Sundial (08:20) so the calendar is settled. |
| `preview` | **21:00 daily** | **Next-day** preview / prep — tomorrow's plan so the owner can prep tonight; re-confirmed by the 08:30 `plan` run. |

---

## How it works

```
                 Forge / D1 task store            Google Calendar (Sundial + Usher)
                 (open tasks, deadlines)           (today's fixed commitments)
                          │                                   │
                          ▼                                   ▼
                 ┌─────────────────┐                 ┌─────────────────┐
                 │  1. score tasks │                 │  2. build the   │
                 │  (deadline +    │                 │  free/busy grid │
                 │   label tier)   │                 │  for work hours │
                 └────────┬────────┘                 └────────┬────────┘
                          │                                   │
                          └─────────────► 3. MERGE ◄──────────┘
                                            │  fit ranked tasks into calendar gaps
                                            ▼
                                  4. OVERCOMMIT CHECK
                                     demand_minutes > free_minutes ?
                                       ├─ no  → time-block everything that fits
                                       └─ yes → block top-N, push rest to "Couldn't fit",
                                                pick top-3, raise P3 flag
                                            │
                                            ▼
                                  5. render plan + top-3
                                            │
                                            ▼
              { agent:"Compass", type:"day_plan", entity:"Today",
                op:"upsert", payload:{…}, idempotencyKey:"compass:plan:2026-05-29" }
                                            │
                                            ▼
                                       the Wire ──► Steward ──► The Vault (Today view)
```

### Step detail

**1. Score tasks (urgency + tier).** Each open task gets a priority score. Inputs, highest weight first:

- **Deadline distance** — `Due/Expired` (overdue) ≫ `Due/Today` ≫ `Due/ThisWeek` ≫ undated. Overdue items are never silently buried.
- **Triage tier** carried from the originating email label: `① Action Required` > `② Action Recommended` > everything else. `From/VIP`-sourced tasks bump up.
- **Needs type** — `Needs/Sign`, `Needs/Pay`, `Needs/Register` (often hard external deadlines) rank above `Needs/Reply` / `Needs/Decide` when deadlines tie.
- **Estimated duration** — used for packing, and as a tie-breaker (shortest-first to clear count, unless a long task is deadline-critical).

**2. Build the free/busy grid.** Working hours come from The Codex (default 09:00–18:00 owner-local if unset). Calendar events are subtracted to leave **focus gaps**. A configurable buffer (default 10 min) pads each side of a meeting so a block never starts the instant a call ends. Gaps shorter than `min_block` (default 25 min) are not offered for deep work.

**3. Merge — fit ranked tasks into gaps.** Walk the ranked task list; place each task into the earliest gap large enough for its estimated duration. Deadline-critical tasks (`Due/Today`, `Due/Expired`) are placed **before** "nice to clear" tasks even if that leaves a small gap unfilled. The result is an ordered, time-stamped block list interleaved with the fixed calendar events.

**4. Overcommitment handling** — see below; this is the step that distinguishes a useful planner from a to-do list dump.

**5. Render + emit.** Compass renders the markdown plan (top-3 banner, timeline, "Couldn't fit" overflow) and sends a **single** `upsert` event to the Wire with a deterministic `idempotencyKey` so the 08:30 and any re-run for the same date replace — never duplicate — the Today note.

---

## Merge / prioritization logic (deadlines + calendar gaps)

The merge is the core algorithm: **rank by urgency, then bin-pack into the spaces the calendar leaves open.**

| Signal | Where it comes from | Effect on the plan |
|--------|--------------------|--------------------|
| `Due/Expired` | Forge (overdue task) | Top of ranking; pinned into the first viable block; flagged if still unfit |
| `Due/Today` | Forge | High rank; must be blocked today or surfaced as at-risk |
| `Due/ThisWeek` | Forge | Mid rank; blocked only if focus time remains |
| `① Action Required` | originating email label | Tier bump on top of deadline score |
| `From/VIP` | relationship label | Additional bump |
| calendar event | Sundial / Usher | **Fixed** — never moved; defines the gaps tasks fit into |
| estimated duration | Forge | Determines which gap a task fits in; tie-breaker |

**Ordering principle:** the plan is **chronological** (it has to be — it's a timeline), but **which** tasks earn a block, and in what order they're attempted, is driven by the priority score. A late-day gap can hold a lower-priority task; a high-priority task always claims the earliest gap it fits in.

---

## Overcommitment handling

When `demand_minutes` (sum of estimated durations of must-do tasks) exceeds `free_minutes` (focus time between meetings during working hours), Compass **must not** silently drop work. It does the following, in order:

1. **Pack by priority.** Fill the available focus time with the highest-scored tasks first.
2. **Overflow list.** Everything that doesn't fit goes into a visible **"⚠ Couldn't fit today"** section — never deleted, never hidden. Each carries its deadline so the owner sees what's slipping.
3. **At-risk callout.** Any `Due/Today` / `Due/Expired` task that lands in the overflow is marked **at-risk** at the top of the plan.
4. **Raise a flag.** Compass emits a **`P3 Medium`** incident to **Flagger** (`source_agent: "Compass"`, e.g. `"3 due-today tasks can't be blocked: 95 min over capacity"`) with `suggested_action` such as *reschedule a meeting* or *defer `Due/ThisWeek` items*. Trust is high (it's a deterministic capacity calculation, not an LLM guess).
5. **Suggest, don't reschedule.** Compass **does not** move calendar events to make room — that's Sundial/Usher's domain and would violate the one-writer rule. It only *recommends* in `suggested_action`.

This keeps the plan honest: a green plan means everything fits; a plan with a "Couldn't fit" section means a real choice has to be made, and the owner makes it.

---

## The morning glance (the top-3)

[SPEC-CANON §6.3](../SPEC-CANON.md) defines the daily "morning glance": **top-3 priorities (Compass)** · action-required emails · deadlines next 7 days · today's meetings · open flags · waiting-on. Compass owns the first item.

- The **top-3** are the three highest-scored tasks for the day, surfaced as a banner at the head of the **Today** note so they're the first thing seen.
- They are stable within a day: the 08:30 `plan` run sets them; ad-hoc re-runs replace via `idempotencyKey` rather than appending.
- The full time-blocked timeline lives below the banner; the top-3 is the "if you only do three things" distillation.

---

## Inputs / Outputs

**Inputs**

| Input | Source | Notes |
|-------|--------|-------|
| open tasks | Forge → D1 task store | title, deadline (`Due/*`), est. duration, origin label |
| today's calendar | Google Calendar (read) | events placed by Sundial (deadline tasks) and Usher (registered events) — treated as fixed |
| working-hours / focus prefs | The Codex | default 09:00–18:00, buffer, `min_block` if not overridden in config |

**Outputs** — one Wire event, consumed by Steward:

```json
{
  "agent": "Compass",
  "type": "day_plan",
  "entity": "Today",
  "op": "upsert",
  "payload": {
    "date": "2026-05-29",
    "mode": "plan",
    "top3": ["Submit Shopify OA", "Sign lease addendum", "Reply to Prof. Lee"],
    "blocks": [ /* {start,end,title,kind:"task"|"event",task_id?} */ ],
    "couldnt_fit": [ /* {title, deadline} */ ],
    "at_risk": [ /* {title, deadline} */ ]
  },
  "idempotencyKey": "compass:plan:2026-05-29"
}
```

Compass writes **nothing** directly — it is a fan-in producer to the Wire ([§4 event-bus diagram](../SPEC-CANON.md)); **Steward** is the sole Vault writer and applies the `upsert` to the **Today** view ([§6.2](../SPEC-CANON.md)).

---

## Dependencies

- **Forge** ([forge.md](forge.md)) — supplies open tasks with deadlines. No tasks ⇒ a calendar-only plan.
- **Sundial** ([sundial.md](sundial.md)) — must run first (08:20) so deadline tasks are on the calendar and the 08:30 calendar read is settled. Per [§4](../SPEC-CANON.md): *Compass depends on Forge (tasks) + Google Calendar (events from Sundial/Usher).*
- **Usher** ([usher.md](usher.md)) — adds registered events to the calendar; Compass reads them as fixed commitments.
- **Steward** ([steward.md](steward.md)) — applies the day-plan `upsert` to The Vault. Compass → Wire → Steward only.
- **Flagger** ([../08-flagger.md](../08-flagger.md)) — receives overcommitment and run-failure incidents.
- **The Codex** ([../07-source-of-truth-codex.md](../07-source-of-truth-codex.md)) — working hours / focus preferences (read-only).

---

## Schedule / Triggers

From [scheduling §10](../03-scheduling.md):

| Time / trigger | Mode | Ordering |
|----------------|------|----------|
| **08:30 daily** | `plan` | After **Sundial** (08:20); end of the strictly-sequential morning chain Filer→Herald→Forge→Sundial→**Compass** |
| **21:00 daily** | `preview` | Independent next-day prep run |

The 08:30 run is **start-after-success** of Sundial: if Sundial fails or hasn't finished, Compass should plan against the last-known calendar and flag the dependency rather than skip the day. The 21:00 `preview` has no upstream dependency in the chain — it reads whatever tasks/calendar exist for *tomorrow*.

---

## Failure modes & Flagger hooks

| Failure | Detection | Flagger action |
|---------|-----------|----------------|
| **Overcommitment** (work > focus time) | deterministic capacity calc | `P3 Medium`, high trust; lists at-risk tasks + `suggested_action` |
| **Calendar read fails** (Google API / OAuth) | exception | `P2 High`, high trust; plan built from last-known calendar, marked **stale** |
| **Sundial not finished / failed** at 08:30 | upstream status on the Wire | `P3 Medium`; proceed on last-known calendar, note the gap |
| **Empty task store** | zero open tasks | no flag — emit a calendar-only "light day" plan |
| **Steward write not acked** | no ack on the Wire | `P2 High`; rely on Steward's serialized retry / idempotency |
| **Duplicate plan note** | should be impossible | guarded by deterministic `idempotencyKey` (`compass:<mode>:<date>`) |

All flags carry `source_agent: "Compass"` and follow the `{ id, ts, source_agent, severity, trust, title, detail, suggested_action, status }` shape from [§8](../SPEC-CANON.md). Idempotency is the key safety property: re-running 08:30 must `upsert`, never append.

---

## Config

| Key | Default | Meaning |
|-----|---------|---------|
| `work_start` / `work_end` | `09:00` / `18:00` (owner-local) | bounds of plannable focus time (Codex can override) |
| `meeting_buffer_min` | `10` | padding added each side of a calendar event |
| `min_block_min` | `25` | smallest gap offered for a deep-work task |
| `top_n` | `3` | size of the morning-glance priorities banner |
| `max_blocks_per_day` | `8` | cap on time-blocked tasks before the rest overflow |
| `overcommit_severity` | `P3 Medium` | Flagger severity when demand > capacity |
| `preview_lookahead_days` | `1` | what `21:00 preview` plans for (tomorrow) |

---

## Example run — a full day plan (08:30 `plan`, 2026-05-29)

**Inputs that morning**

Open tasks from Forge:

| Task | Deadline | Est. | Origin label |
|------|----------|------|--------------|
| Submit Shopify OA | `Due/Today` | 90 min | `① Action Required`, `Job/OA`, `Needs/Upload` |
| Sign lease addendum | `Due/Today` | 20 min | `① Action Required`, `Needs/Sign` |
| Reply to Prof. Lee | `Due/Today` | 15 min | `① Action Required`, `From/VIP`, `Needs/Reply` |
| Pay hydro bill | `Due/ThisWeek` | 10 min | `② Action Recommended`, `Finance/Bill`, `Needs/Pay` |
| Draft 471 report intro | `Due/ThisWeek` | 60 min | `② Action Recommended` |
| Outline blog post | (undated) | 45 min | quick-capture |

Today's calendar (Sundial + Usher placed these — fixed):

- 10:00–10:30 — Standup
- 13:00–14:00 — Lunch w/ Sam
- 16:00–16:45 — Career-fair prep call (Usher-registered event)

**Capacity:** working hours 09:00–18:00 = 540 min. Meetings + buffers consume ~135 min. Free focus ≈ 405 min. Must-do (`Due/Today`) demand = 90+20+15 = 125 min → **fits**, with room for some `Due/ThisWeek`. No overcommit flag.

**Rendered Today note (what Steward writes):**

```
# Today — Fri 2026-05-29

## ⭐ Top 3
1. Submit Shopify OA            (Due/Today · Job/OA)
2. Sign lease addendum          (Due/Today · Needs/Sign)
3. Reply to Prof. Lee           (Due/Today · VIP)

## 🗓 Plan
09:00–09:15  ▸ Reply to Prof. Lee            (15m · VIP)
09:15–09:35  ▸ Sign lease addendum           (20m · Needs/Sign)
09:35–09:50  · buffer
10:00–10:30  ■ Standup                        (meeting)
10:40–12:10  ▸ Submit Shopify OA              (90m · Due/Today)  ← deep block
12:10–12:20  ▸ Pay hydro bill                 (10m · Finance/Bill)
13:00–14:00  ■ Lunch w/ Sam                   (meeting)
14:10–15:10  ▸ Draft 471 report intro         (60m · Due/ThisWeek)
16:00–16:45  ■ Career-fair prep call          (event · Usher)
16:55–17:40  ▸ Outline blog post              (45m · capture)

## ⚠ Couldn't fit today
(none)
```

**Overcommitted variant.** If two more `Due/Today` items arrived — *Finalize 471 report (120 min)* and *Upload tax docs (30 min)* — demand would jump to 275 min of must-do work against the same ~405 free minutes, but after the lower-priority `Due/ThisWeek` and capture tasks are already blocked, the late-day gaps run out. Compass would then:

```
## ⚠ Couldn't fit today
- Finalize 471 report      (Due/ThisWeek)
- Outline blog post        (no deadline)

## 🔻 At risk (due today, no block)
- Upload tax docs          (Due/Today · Needs/Upload)
```

and emit:

```json
{ "agent":"Compass", "source_agent":"Compass", "severity":"P3 Medium", "trust":95,
  "title":"Overcommitted: 1 due-today task can't be blocked",
  "detail":"Upload tax docs (30m) has no remaining focus gap; 50 min over capacity.",
  "suggested_action":"Defer 'Draft 471 report intro' (Due/ThisWeek) or shorten Lunch block.",
  "status":"open" }
```

→ Flagger routes the `P3` into the dashboard feed, and the **Couldn't fit** / **At risk** sections make the trade-off visible in the morning glance.

---

## Open questions

- **Duration estimates:** does Forge attach reliable `est_duration`, or should Compass infer defaults by task type (e.g. `Needs/Reply` ≈ 15m)?
- **Energy-aware ordering:** should deep-work blocks be biased toward the owner's stated peak hours from The Codex, beyond just "earliest viable gap"?
- **Carry-over:** when the 21:00 `preview` blocks tomorrow, should incomplete tasks from today auto-roll forward, or wait for Forge to re-surface them?
- **Re-plan on calendar change:** today the plan is rebuilt only at 08:30/21:00. Should a mid-day calendar change (new meeting from Usher) trigger an event-driven re-plan, or stay a manual on-demand re-run?
- **Buffer vs. back-to-back:** is the 10-min meeting buffer always wanted, or should it be suppressed on light days to reclaim focus time?
