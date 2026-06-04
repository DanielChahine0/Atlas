# 03 — Scheduling

**Purpose:** The complete time map of Atlas — which agents fire when, which run before others, which run at the same time, and why. This is the single answer to "what's the schedule and what's the concurrency model?"

## At a glance

| | |
|---|---|
| **Scheduler** | Cloudflare **Cron Triggers** (one entry per scheduled run); multi-step durable runs use **Cloudflare Workflows** |
| **Trigger types** | `cron` (clock), `event` (Gmail push / Wire message / device-active), `on-demand` (owner-initiated) |
| **Timezone** | All times are **owner-local** |
| **Sequencing terms** | **Sequential** = start-after-success (downstream waits for upstream to succeed); **Parallel** = concurrent, independent sources |
| **Serialization point** | [Steward](agents/steward.md) — single serialized consumer of the [Wire](02-architecture.md); it is *fed*, never self-scheduled |
| **Always-parallel** | [Echo](agents/echo.md) (local, real-time) and continuous [Filer](agents/filer.md) (Gmail push) |
| **Owns this** | [Atlas](agents/atlas.md) — registers crons, sequences the chain, supervises runs |

Related: [02-architecture.md](02-architecture.md) · [04-email-taxonomy.md](04-email-taxonomy.md) · [08-flagger.md](08-flagger.md)

---

## 1. The complete schedule (SPEC §10)

`Sequential` = start-after-success. `Parallel` = concurrent. Times are owner-local.

| Time / trigger | Agent | Mode | Trigger type | Notes / ordering |
|----------------|-------|------|--------------|------------------|
| continuous | **Filer** | event | `event` (Gmail push) | Labels mail in near-real-time as it arrives |
| **07:45 daily** | **Filer** | sweep | `cron` | Pre-Herald sweep so the digest reads fresh labels |
| **08:00 daily** | **Herald** | daily | `cron` | Depends on the Filer sweep |
| **08:15 daily** | **Forge** | morning | `cron` (after Herald) | Extracts tasks from the morning's `① Action Required` |
| **08:20 daily** | **Sundial** | sync | `cron` (after Forge) | Deadline tasks → Google Calendar |
| **08:30 daily** | **Compass** | plan | `cron` (after Sundial) | Needs tasks + a settled calendar |
| **09:00 daily (light)** | **Headhunter** | deadlines | `cron` | Cheap daily check for imminent job deadlines |
| **21:00 daily** | **Compass** | preview | `cron` | Next-day preview / prep |
| **Mon 09:00** | **Headhunter** | full | `cron` | Full board scan + hiring-window update |
| **Fri 16:00** | **Scout** | weekly | `cron` | Upcoming events next week/month |
| **Fri 16:00** | **Herald** | weekly | `cron` | Weekly email review (**parallel** with Scout) |
| **Fri 16:30** | weekly-review build | — | `cron` | **Steward** compiles the weekly dashboard summary |
| event: meeting starts | **Echo** | live | `event` (calendar-aware / audio-device-active) | Local daemon, real-time |
| event: meeting ends | **Archivist** | — | `event` (transcript ready) | After Echo's transcript lands |
| on-demand | **Usher**, **Quill**, **Envoy**, **Librarian**, **Switchboard** | — | `on-demand` | User-initiated |
| event-driven | **Steward**, **Flagger** | — | `event` (Wire) | Fed by other agents; never self-scheduled |

> Note: **Herald** is one agent with two modes — `daily` (08:00) and `weekly` (Fri 16:00) — on two cron triggers. Same prompt, same codebase. See [herald.md](agents/herald.md).

---

## 2. Daily timeline

The weekday clock. The block from **07:45 → 08:30** is the **morning chain** — a strictly sequential pipeline where each agent consumes the prior agent's output. Everything fans into [Steward](agents/steward.md), which writes [The Vault](06-hosting-cloudflare-mcp.md) serially.

```
 TIME    AGENT        MODE        WHAT HAPPENS
 ──────  ───────────  ──────────  ────────────────────────────────────────────────
 07:45   Filer        sweep       Pre-Herald label sweep — every overnight thread
                                  gets ① ② ③ ④ ⑤ + Type/Needs/Due labels. AI/Reviewed
                                  set so the run is idempotent.
            │  (must finish & succeed)
            ▼
 08:00   Herald       daily       Reads fresh labels, builds the morning digest,
                                  drafts it to the owner. Pushes counts to Steward.
            │  (sequential)
            ▼
 08:15   Forge        morning     Extracts tasks/subtasks from ① Action Required
                                  + Needs/* threads, with deadlines. → task store.
            │  (sequential — Sundial needs the tasks)
            ▼
 08:20   Sundial      sync        Deadline tasks → Google Calendar events.
            │  (sequential — Compass needs a settled calendar)
            ▼
 08:30   Compass      plan        Tasks + settled calendar → today's day plan
                                  (top-3 priorities, schedule). → Steward → Vault.

 ── morning chain complete ──────────────────────────────────────────────────────

 09:00   Headhunter   deadlines   Cheap daily check for imminent job deadlines.
                                  Creates "apply by X" tasks via Forge if needed.
                                  (Independent of the morning chain.)

 ...

 21:00   Compass      preview     Next-day preview / prep. Builds tomorrow's draft
                                  plan so the morning starts warm. → Steward → Vault.

 CONTINUOUS (all day, parallel):
   Filer  ── Gmail push, label as mail arrives
   Echo   ── local daemon; activates when a meeting/audio device goes live
   Steward, Flagger ── event-driven, fed by the Wire whenever an agent emits
```

**Reading the chain:** 08:00 → 08:30 are *target start times*, not guaranteed wall-clock starts. Each downstream agent starts **after the upstream succeeds**. The 15-/5-/10-minute gaps are budget headroom; if Herald is slow, Forge waits. If an upstream step fails, [Atlas](agents/atlas.md) halts the chain and the failure is reported to [Flagger](08-flagger.md) rather than letting Compass plan against stale data.

---

## 3. Weekly timeline

Weekday mornings repeat the daily chain. The distinctly *weekly* events cluster on **Monday morning** and **Friday afternoon**.

```
 MON 09:00   Headhunter   full       Full job-board scan + hiring-window update.
                                     Heavier than the daily-light 09:00 check.
                                     Feeds Forge (tasks) + Steward (pipeline counts).

 ── ... weekday mornings run the daily chain (§2) ... ──

 FRI 16:00   ┌─ Scout    weekly  ──┐   Event discovery for next week/month.
             │                     │
             │   (PARALLEL —       │   Independent data sources, no shared state.
             │    independent)     │
             │                     │
             └─ Herald   weekly  ──┘   Weekly email review digest.
                       │                    │
                       └────────┬───────────┘
                                ▼  (both fan in)
                             Steward  (serialized writes)

 FRI 16:30   weekly-review build         Steward compiles the weekly dashboard
                                         summary (the auto-Friday "Weekly review"
                                         Vault view) once Scout + weekly-Herald
                                         have landed their events.
```

**Why Scout and weekly-Herald are parallel:** they read entirely different sources (event listings vs. the owner's mailbox) and write disjoint Vault sections. There is no dependency edge between them, so serializing them would only add latency. They run concurrently and both emit Wire events into Steward.

**Why Fri 16:30 is sequential after 16:00:** the weekly-review build *summarizes* what Scout and weekly-Herald produced. It must wait for both to land — it's a fan-in barrier, not just a clock offset.

**Monday-full vs. Friday digests:** Headhunter's Monday full scan and the Friday digests can overlap in principle, but they never collide — they touch different state (job pipeline vs. events/email). Steward still serializes their writes regardless.

---

## 4. Concurrency rules

### 4.1 The morning chain is strictly sequential — and why

`Filer(sweep) → Herald → Forge → Sundial → Compass` is a **data pipeline**: each stage consumes the previous stage's output. Running them concurrently would produce wrong results, not just a race:

- **Herald must run after Filer's sweep.** Herald's digest is built *from labels*. If Herald reads before the 07:45 sweep finishes, it digests stale or unlabeled mail. Label first, then digest. (See [filer.md](agents/filer.md) and [04-email-taxonomy.md](04-email-taxonomy.md).)
- **Forge must run after Herald.** Forge extracts tasks from the morning's `① Action Required` / `Needs/*` threads — the same set Herald surfaces. It needs those threads classified and digested first.
- **Sundial must run after Forge.** Sundial syncs *deadline tasks* to the calendar. No tasks → nothing to sync. It consumes Forge's output directly.
- **Compass must run last.** Compass plans the day from **tasks + a settled calendar**. If it runs before Sundial, the calendar is missing today's deadline events and the plan is wrong. Compass is the synthesizer; it must see the finished state of everything upstream.

Because it's start-after-success, a failure anywhere **stops the chain** (no planning against partial data) and raises a flag to [Flagger](08-flagger.md). Every step is idempotent (e.g. Filer skips `AI/Reviewed` threads), so a halted chain is safe to retry.

### 4.2 Steward serializes all writes — and why

[Steward](agents/steward.md) is the **single writer** to [The Vault](06-hosting-cloudflare-mcp.md) (Obsidian). It is fed by the [Wire](02-architecture.md) (Cloudflare Queue) and is a **single serialized consumer**:

- **One writer per resource** is a core design pillar. The Vault is plain Markdown files on disk/sync; two writers at once would corrupt files or interleave edits.
- **No double-counting.** Counters move via `increment` with an `idempotencyKey`, so a replayed Wire message can't inflate a count. Serial application keeps counters consistent.
- **Steward fetches nothing.** Every other agent *sends it an event*; Steward never pulls. This is the owner's explicit requirement and means a write storm (many agents firing at once) just queues up and drains in order — no contention.

Event shape (from SPEC §6.4):

```json
{ "agent": "...", "type": "...", "entity": "...",
  "op": "increment | upsert | append", "payload": { }, "idempotencyKey": "..." }
```

So even when Mon-full Headhunter, both Friday digests, and a live Echo→Archivist write all complete near the same moment, their Vault writes execute one at a time, in queue order.

### 4.3 What runs in parallel

| Concurrent group | Why it's safe |
|---|---|
| **Echo** + everything else | Local, real-time, writes only to the transcript store — no shared Vault state until Archivist runs |
| **Filer (continuous)** + the day | Gmail-push labeling touches only Gmail labels, idempotent via `AI/Reviewed` |
| **Scout** ∥ **weekly-Herald** (Fri 16:00) | Disjoint sources (events vs. mailbox), disjoint Vault sections |
| **Headhunter full** (Mon) overlapping Friday digests | Different state (job pipeline vs. events/email) |
| **Daily 09:00 Headhunter-light** alongside the morning chain | Independent; only touches the job pipeline + Forge |

The universal safety net: anything that writes the Vault does so **through Steward**, which serializes regardless of how many agents fired at once.

### 4.4 Trigger types — cron vs. event-driven vs. on-demand

| Type | Fires on | Agents | Characteristics |
|---|---|---|---|
| **`cron`** | The clock (Cloudflare Cron Triggers) | Filer (sweep), Herald, Forge, Sundial, Compass, Headhunter, Scout, weekly-review | Deterministic schedule; the morning chain and weekly events. Atlas owns these registrations. |
| **`event`** | An external event — Gmail push, a Wire message, audio device active, transcript ready | Filer (continuous), Echo, Archivist, Steward, Flagger | React to reality, not the clock. Steward/Flagger are *fed* and never self-schedule. |
| **`on-demand`** | The owner initiates (hotkey, command, prompt) | Usher, Quill, Envoy, Librarian, Switchboard | No schedule. These are the gated/outward-facing or interactive agents. |

Some agents are mixed: **Filer** is both `event` (continuous Gmail push) *and* `cron` (the 07:45 sweep). **Headhunter** is `cron` in two modes (daily-light + Monday-full). **Herald** is `cron` in two modes (daily + weekly).

---

## 5. Cron timezone policy — UTC translation (D-06 / D-07)

**Cloudflare Cron Triggers are UTC-only and do NOT observe DST.** The §1/§2 schedule is written in owner-local time (`America/Toronto`); each cron line must be hand-translated to UTC. Because Toronto switches between EST (UTC−5) and EDT (UTC−4) twice a year, **every owner-local target maps to two different UTC cron expressions** — one for EST, one for EDT.

**Policy (D-06):** keep the UTC crons explicit and **hand-edit them at the two DST boundaries** (the second Sunday in March → EDT; the first Sunday in November → EST). There is no DST-aware cron on Cloudflare, so this twice-yearly edit is the correct, intentional operational burden. Writing this table is a Phase-0 "setup-done" criterion (D-07); the crons themselves first *fire* in Phase 1.

> **In-Workflow waits are DST-safe and need NO hand-edit.** Only the trigger cron is UTC-pinned. Durable budgets inside a Workflow use `step.sleepUntil(...)` computed from a timezone-correct `Date` derived via `Intl` with `America/Toronto` — e.g. `new Intl.DateTimeFormat('en-CA',{ timeZone:'America/Toronto' }).format(new Date())`. `step.sleepUntil` resolves against absolute time, so it stays correct across a DST change mid-wait.

### EST/EDT → UTC cron translation table

| Owner-local (ET) | Agent / run | UTC cron — **EST** (UTC−5, Nov→Mar) | UTC cron — **EDT** (UTC−4, Mar→Nov) |
|---|---|---|---|
| 07:45 | Filer sweep | `45 12 * * *` | `45 11 * * *` |
| 08:00 | Herald (daily) | `0 13 * * *` | `0 12 * * *` |
| 08:15 | Forge (morning) | `15 13 * * *` | `15 12 * * *` |
| 08:20 | Sundial (sync) | `20 13 * * *` | `20 12 * * *` |
| 08:30 | Compass (plan) | `30 13 * * *` | `30 12 * * *` |
| 09:00 | Headhunter (daily-light) | `0 14 * * *` | `0 13 * * *` |
| 21:00 | Compass (preview) | `0 2 * * *` | `0 1 * * *` |
| Mon 09:00 | Headhunter (full) | `0 14 * * 1` | `0 13 * * 1` |
| Fri 16:00 | Scout (weekly) ∥ Herald (weekly) | `0 21 * * 5` | `0 20 * * 5` |
| Fri 16:30 | weekly-review build | `30 21 * * 5` | `30 20 * * 5` |

> The 21:00 ET preview crosses midnight UTC, so its UTC hour is the *next* calendar day (`0 2`/`0 1`). Day-of-week crons (Mon-full, Fri digests) are unaffected by the date rollover at these hours, but re-check the day field if a future run is scheduled near a UTC midnight boundary.
>
> **Morning chain caveat:** the five morning-chain times (07:45→08:30) are *targets*; in Phase 1 they are NOT five independent crons. ONE cron (the 07:45 Filer sweep) kicks the `MorningChain` Workflow, which sequences the rest with start-after-success `step` budgets. Only that single kickoff cron needs a UTC line here.

---

## 6. Failure modes & Flagger hooks

- **Upstream step fails in the morning chain** → Atlas halts the chain at that point; downstream agents do **not** run on stale data. Flagged `P2 High` (the owner's morning glance is degraded). See [08-flagger.md](08-flagger.md).
- **Filer sweep overruns past 08:00** → Herald waits (start-after-success), absorbing the delay rather than digesting unlabeled mail. Persistent overrun → flag.
- **Fri 16:00 fan-in incomplete** (Scout or weekly-Herald fails) → the 16:30 weekly-review build runs with a partial summary and Flagger notes the gap; it is not blocked indefinitely.
- **Steward queue backs up** → writes drain in order; no data loss (the Wire persists messages), but a stale heartbeat is itself flagged. Flagger self-monitors the heartbeat (SPEC §8).
- **Missed cron** (Worker cold/cron skipped) → next run is idempotent and catches up; a missed scheduled run is logged to the **Agent heartbeat / run log** Vault view (SPEC §6.2).

---

## 7. Open questions

- **DST:** resolved by **D-06** (§5) — UTC crons with a twice-yearly hand-edit at the EST↔EDT boundary; in-Workflow waits use `step.sleepUntil` and are DST-safe. _Travel_ remains open: should the schedule follow the owner's current timezone when traveling, or stay pinned to home (`America/Toronto`) time?
- **Holiday/weekend morning chain:** does the 07:45→08:30 chain run on weekends, or only Mon–Fri?
- **Backpressure policy:** if Steward's queue depth crosses a threshold during a write storm, do we shed low-priority `increment`s or just let latency grow?
- **Echo trigger source of truth:** calendar-aware start vs. audio-device-active — which wins when they disagree (a meeting that starts late, or audio with no calendar event)?
