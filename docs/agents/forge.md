# Forge (task & subtask extractor)

**Purpose:** Turn parsed information — `① Action Required` emails surfaced by [Herald](herald.md) and "apply by X" findings from [Headhunter](headhunter.md) — into structured tasks with deadlines and subtasks, then feed them to [Sundial](sundial.md) (calendar) and [Steward](steward.md) (dashboard counts).

## At a glance

| Field | Value |
|-------|-------|
| **Codename** | Forge |
| **Role** | Task & subtask extractor (with deadlines) |
| **Roster #** | 3 (Tier 1 — core loop; "turns information into action") |
| **Runtime** | Cloud — Cloudflare Worker + a Durable Object per run for the dedupe/idempotency lock |
| **Trigger** | `08:15 daily` (morning mode, after [Herald](herald.md)) + on-demand + Headhunter findings |
| **Inputs** | Herald digest items, threads labelled `① Action Required` / `Needs/*` / `Due/*`, Headhunter job findings, manual capture |
| **Outputs** | Task records (`title`, `subtasks[]`, `due`, `source`, `priority`) into the **task store** |
| **Writes to** | Task store (**D1** `tasks` / `subtasks`), and an event to [Steward](steward.md) via the **Wire** |
| **Reads** | D1 task store (for dedupe), Gmail labels (via [Filer](filer.md)'s taxonomy), Headhunter task payloads |
| **MCPs / tools** | Gmail MCP (read labels/threads), D1 binding, Claude via AI Gateway (Sonnet for extraction), the Wire (Queue producer) |
| **Depends on** | Parsed input — [Herald](herald.md), [Headhunter](headhunter.md), or manual. See [architecture](../02-architecture.md). |
| **Feeds** | [Sundial](sundial.md) (deadline tasks → Google Calendar), [Steward](steward.md) (open/overdue/due-this-week counts) |

---

## What it does

Forge is the **information → action** step of the [morning pipeline](../03-scheduling.md). It reads
the morning's actionable email (the threads [Filer](filer.md) tagged `① Action Required`, plus their
`Needs/*` and `Due/*` labels) and the digest [Herald](herald.md) just produced, and emits **one task
per actionable item**, each broken into concrete **subtasks** with an inferred **deadline**.

It does three hard things:

1. **Extraction** — read messy prose (an email, a recruiter note, a Headhunter finding) and produce a
   clean `{ title, subtasks[], due, source, priority }` record.
2. **Dedupe** — never create a second task for an email it already turned into a task, even across
   re-runs or when the same deadline arrives via two channels (e.g. Herald *and* Headhunter).
3. **Deadline inference** — find the real due date when it's stated, and infer a sensible one when
   it isn't, so [Sundial](sundial.md) has something to put on the calendar.

Forge is **suggest, don't destroy** (design pillar 2): it creates tasks and subtasks, but it does not
touch Gmail, does not register/pay, and does not write the Vault directly — it hands an event to
[Steward](steward.md). Forge is also **idempotent** (pillar 5): re-running the 08:15 job produces no
duplicate tasks.

What Forge does **not** do:

- It does not label email — that's [Filer](filer.md).
- It does not put anything on the calendar — that's [Sundial](sundial.md), which reads Forge's `due`.
- It does not write the dashboard — it sends counts to [Steward](steward.md).
- It does not decide the day's order — that's [Compass](compass.md), which reads the task store.

---

## The task schema

The canonical record Forge produces (stored in **D1**, consumed by Sundial + Steward):

```jsonc
// task
{
  "id":        "tsk_01H...",        // ULID, stable, the dedupe + idempotency anchor
  "title":     "Submit Shopify OA",  // short imperative phrase
  "subtasks":  [                     // ordered, each independently checkable
    { "id": "sub_1", "text": "Open the HackerRank link from the email", "done": false },
    { "id": "sub_2", "text": "Complete 2 coding questions (90 min)",     "done": false },
    { "id": "sub_3", "text": "Submit before the deadline + screenshot",  "done": false }
  ],
  "due":       "2026-06-02T23:59:00-04:00", // ISO-8601, owner-local; null only if truly undatable
  "due_kind":  "explicit",           // explicit | inferred | none  (see Deadline inference)
  "source": {
    "agent":     "Herald",           // Herald | Headhunter | manual
    "channel":   "email",            // email | job-finding | manual
    "ref":       "gmail:thread/198e...", // Gmail thread id / Headhunter finding id
    "label_hint":"Needs/Upload",     // the Filer Needs/* label that drove it, if any
    "excerpt":   "…complete the OA by EOD June 2…"
  },
  "priority":  "P1",                 // P1 | P2 | P3 | P4  (see Priority)
  "status":    "open",               // open | done | dropped
  "dedupe_key":"sha256(thread+normalizedTitle+dueDate)",
  "created":   "2026-05-29T08:15:11-04:00",
  "updated":   "2026-05-29T08:15:11-04:00"
}
```

> Field names are load-bearing: [Sundial](sundial.md) reads `due`, `title`, `id`; [Steward](steward.md)
> counts by `status` + `due`; [Compass](compass.md) reads the whole record for the day plan.

---

## How it works

```
                       ┌─────────────────────────── Forge run (Worker) ───────────────────────────┐
 08:15 cron  ─────────▶│ 1. GATHER    pull morning ① Action Required threads (Filer labels)        │
 Headhunter  ─────────▶│              + Herald digest items + Headhunter "apply by X" findings      │
 on-demand   ─────────▶│ 2. FILTER    keep only items with a Needs/* intent or a Due/* hint         │
                       │ 3. EXTRACT   per item → LLM (Sonnet): title, subtasks[], priority          │
                       │ 4. DEADLINE  parse explicit date → else infer (Due/Today, Needs/*, type)   │
                       │ 5. DEDUPE    compute dedupe_key, check D1; skip/merge if already present    │
                       │ 6. WRITE     upsert task + subtasks into D1 (inside the DO lock)            │
                       │ 7. EMIT      one Wire event per new/changed task → Steward (counts)         │
                       └──────────────────────────────────────┬───────────────────────────────────┘
                                                               ▼
                          Sundial (reads new tasks where due != null)  ·  Steward (increments counts)
```

### Step detail

1. **Gather.** In morning mode, query the task store's watermark, then pull Gmail threads carrying
   `① Action Required` updated since the last successful run. Also drain any Headhunter task payloads
   queued since last run, and read Herald's digest items (Herald and Forge share the same morning
   batch, so Forge never re-fetches what Herald already summarized — it reuses the thread refs).
2. **Filter.** An `① Action Required` thread becomes a candidate only if it carries a `Needs/*` label
   (`Needs/Reply`, `Needs/Pay`, `Needs/Register`, `Needs/Schedule`, `Needs/Upload`, `Needs/Sign`,
   `Needs/Decide`) **or** a `Due/*` label (`Due/Today`, `Due/ThisWeek`, `Due/Expired`). `④ FYI / Read
   Later` and `⑤ No Action` are dropped here. `AI/Uncertain` items are still extracted but get a low
   `priority` floor and a Flagger note (below).
3. **Extract.** For each candidate, one LLM call (Sonnet via AI Gateway — cheap, high-volume) returns:
   - `title` — short imperative ("Submit Shopify OA", not "RE: your online assessment").
   - `subtasks[]` — the concrete steps to actually finish it (open link → do work → submit → confirm).
   - a *proposed* `priority`, refined by the rules below.
   The prompt is grounded with the `Needs/*` label so the model knows the action type. Security mail
   is special-cased: never copy 2FA codes / reset links into a title or subtask (per taxonomy §5.8);
   if the only actionable content is a code/link, Forge skips it and lets Filer's `Type/Security`
   handling stand.
4. **Deadline inference** — see the dedicated section.
5. **Dedupe** — see the dedicated section.
6. **Write.** Upsert the task + its subtasks into D1 inside the Durable Object lock so two triggers
   (e.g. the 08:15 cron and a Headhunter finding arriving the same minute) can't double-write.
7. **Emit.** Send one Wire event per *new or materially changed* task so [Steward](steward.md) moves
   the **Tasks** counters (open / due-this-week / overdue). The event uses the task `id` as its
   `idempotencyKey` so a queue replay can't double-count (Vault write contract §6.4).

---

## Deadline inference

[Sundial](sundial.md) can only schedule what has a `due`. Forge sets `due` and records *how* it got
it via `due_kind`:

| `due_kind` | When | How `due` is set |
|------------|------|------------------|
| `explicit` | The text states a date/time ("by June 2", "deadline 5pm Friday", "within 48 hours") | Parse to ISO-8601, owner-local. "EOD" → `23:59` local; "by Friday" → that Friday `17:00`. Relative ("within 48h") anchored to the email's `Date` header. |
| `inferred` | No explicit date, but labels/type imply urgency | `Due/Today` → today `23:59`. `Due/ThisWeek` → coming Friday `17:00`. `Needs/Pay` (bill) → use any stated bill due date, else +7d. `Job/OA` → default OA window +5d. `Job/Interview` scheduling → next business day. |
| `none` | Genuinely undatable ("read when you can", FYI that slipped through) | `due = null`, `due_kind = "none"`. Sundial skips it; it still shows in the task store + Steward's *open* count. |

Rules:

- **Explicit always wins** over inferred; a `Due/*` label only *raises confidence*, it doesn't override
  a date written in the body.
- **Expired guard:** if a parsed/inferred `due` is already in the past, set it anyway, mark
  `priority` to at least `P2`, and raise a `P3 Medium` Flagger note ("deadline already passed?") so the
  owner can judge — Forge never silently drops a late deadline. This pairs with Filer's `Due/Expired`.
- **Ambiguity:** if two plausible dates exist, pick the **earliest** actionable one and put the other
  in `source.excerpt`. Low-confidence parses set `due_kind = "inferred"` and add an `AI/Uncertain`-style
  Flagger note.

---

## Dedupe against existing tasks

The hazard: the same obligation arrives twice — a re-run of the 08:15 job, a forwarded copy of an
email, or a deadline that comes via **both** Herald (the email) **and** Headhunter (the job finding).
Forge must produce **one** task.

**`dedupe_key` = `sha256(normalized_source_ref + normalized_title + due_date)`** where:

- `normalized_source_ref` collapses to the Gmail **thread** id (not message id — a thread is one
  obligation) or the Headhunter finding's stable job id.
- `normalized_title` is lowercased, stop-words/`RE:`/`FWD:` stripped, whitespace-collapsed.
- `due_date` is the date portion only (so a 5pm vs 11:59pm tweak doesn't fork the task).

On extract, before write:

1. Look up `dedupe_key` in D1 (`tasks` has a unique index on it).
2. **Hit, same source** → no-op (idempotent re-run). Do **not** re-emit to Steward.
3. **Hit, different channel** (Headhunter finding matches an existing Herald-sourced task, or vice
   versa) → **merge**: keep the existing task, union the `subtasks[]`, append the new `source` to a
   `sources[]` trail, keep the **earlier** `due`, raise `priority` to the higher of the two. Emit an
   `upsert` (not a fresh `increment`) so counts don't move.
4. **Miss** → insert a new task, emit an `increment` to Steward.
5. **Manual override:** if the owner edited or marked a task `done`/`dropped`, Forge respects it — a
   re-extraction of the same thread will **not** resurrect or rewrite an owner-touched task (a
   `locked_by_owner` flag short-circuits the upsert).

```
        extract item ──▶ compute dedupe_key
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
        no match         same source       other channel
            │                 │                 │
         INSERT            NO-OP             MERGE (union subtasks,
       + increment      (idempotent)         earliest due, max priority,
                                             upsert — no count move)
```

---

## The task store (D1)

Tasks live in **D1** (Cloudflare's SQLite) — the canonical home for `tasks` alongside `jobs`,
`events`, and the `run-log` (hosting §7). Forge is the writer for `tasks`/`subtasks`; Sundial,
Compass, and Steward are readers.

```sql
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,           -- ULID
  title        TEXT NOT NULL,
  due          TEXT,                        -- ISO-8601 owner-local, NULL if undatable
  due_kind     TEXT NOT NULL DEFAULT 'none',-- explicit | inferred | none
  priority     TEXT NOT NULL DEFAULT 'P3',  -- P1..P4
  status       TEXT NOT NULL DEFAULT 'open',-- open | done | dropped
  source_agent TEXT NOT NULL,               -- Herald | Headhunter | manual
  source_ref   TEXT NOT NULL,               -- gmail:thread/… | hh:finding/…
  dedupe_key   TEXT NOT NULL,
  locked_by_owner INTEGER NOT NULL DEFAULT 0,
  created      TEXT NOT NULL,
  updated      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_tasks_dedupe ON tasks(dedupe_key);
CREATE INDEX        idx_tasks_due    ON tasks(due);      -- Sundial + Steward range scans
CREATE INDEX        idx_tasks_status ON tasks(status);

CREATE TABLE subtasks (
  id       TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,                -- display order
  text     TEXT NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_subtasks_task ON subtasks(task_id);
```

- **Idempotency** is enforced at the DB layer by `idx_tasks_dedupe` (unique) — even if the app-side
  check races, the insert fails and Forge falls into the merge path.
- **Serialization:** writes happen inside a per-run **Durable Object** lock, so concurrent triggers
  (cron + Headhunter) serialize, matching the project's "one writer per resource" pillar for the
  task store.
- **Readers never block writers:** Sundial reads `WHERE due IS NOT NULL AND status='open'`; Steward's
  counts come from the Wire events Forge emits, not by polling D1.

---

## Inputs / Outputs

**Inputs**

- Gmail threads labelled `① Action Required` carrying `Needs/*` and/or `Due/*` (from [Filer](filer.md)).
- [Herald](herald.md) digest items (shared morning batch; thread refs reused, not re-fetched).
- [Headhunter](headhunter.md) job findings — "apply by X" / OA / interview-prep payloads on the Wire.
- Manual capture (on-demand): a thread id or a free-text "make a task: …".

**Outputs**

- `tasks` + `subtasks` rows in **D1** (the schema above).
- One **Wire** event per new/changed task → [Steward](steward.md), shape
  `{ agent:"Forge", type:"task", entity:<id>, op:"increment"|"upsert", payload, idempotencyKey:<id> }`
  (Vault write contract §6.4).
- A signal that new dated tasks exist → [Sundial](sundial.md) (consumed at `08:20`).

---

## Dependencies

| Forge needs… | From | Why |
|--------------|------|-----|
| Labelled, actionable email | [Filer](filer.md) (`07:45` sweep) → [Herald](herald.md) (`08:00`) | Forge extracts from `① Action Required` / `Needs/*` / `Due/*` |
| Job findings | [Headhunter](headhunter.md) | "apply by X" tasks (creates tasks per §4 dependency rules) |
| Task store | **D1** | dedupe + persistence |
| Count fan-in | [Steward](steward.md) via the **Wire** | dashboard Tasks counters |

| …and Forge feeds | Downstream | Consumed |
|------------------|-----------|----------|
| Dated tasks | [Sundial](sundial.md) | `08:20` — deadline tasks → Google Calendar |
| Open/overdue/due-this-week counts | [Steward](steward.md) | dashboard, weekly review |
| Full task records | [Compass](compass.md) | `08:30` day plan synthesis |

See [architecture](../02-architecture.md) for the full dependency graph and the morning pipeline.

---

## Schedule / Triggers

| Time / trigger | Mode | Notes |
|----------------|------|-------|
| **08:15 daily** | `morning` | Extracts tasks from the morning's `① Action Required`. Runs **after** [Herald](herald.md) `08:00`, **before** [Sundial](sundial.md) `08:20`. Strictly sequential in the morning chain. |
| Headhunter finding | event | A "apply by X" payload on the Wire → Forge creates/merges a task (`Mon 09:00` full scan + `09:00` daily-light). |
| on-demand | `manual` | Owner-initiated capture of a thread or free text. |

The morning chain (Filer → Herald → **Forge** → Sundial → Compass) is **strictly sequential**
(start-after-success). See [scheduling](../03-scheduling.md).

---

## Failure modes & Flagger hooks

| Failure | Severity | Trust | Forge behavior |
|---------|----------|-------|----------------|
| LLM extraction returns no parseable date but text clearly implies one | `P3 Medium` | medium | Store with `due_kind:"inferred"`, flag for a glance |
| Inferred/parsed `due` already in the past | `P3 Medium` | high | Keep the task, bump `priority ≥ P2`, flag "deadline already passed?" |
| Source thread carries `AI/Uncertain` | `P4 Low` | low | Extract but floor priority low; surface for owner review |
| `⚠ Phishing-Suspect` thread | `P2 High` | high | **Do not extract.** No task, no links followed; flag immediately (push) |
| Security mail where the only "action" is a 2FA code / reset link | — | — | Skip silently (never reproduce codes/links per §5.8) |
| D1 unique-index collision after app-side dedupe miss (race) | `P4 Low` | high | Fall into merge path; log to run-log; no flag unless repeated |
| D1 write fails / Worker times out | `P2 High` | high | Run is idempotent — retry next tick; flag if it fails twice |
| Upstream (Herald/Filer) didn't run | `P2 High` | high | Forge has no input; emit a heartbeat-gap flag rather than a silent no-op |

All flags follow the [Flagger](../08-flagger.md) shape
`{ id, ts, source_agent:"Forge", severity, trust, title, detail, suggested_action, status }`; P1/P2
push immediately, P3/P4 batch into the dashboard feed.

---

## Config

| Key (KV) | Default | Meaning |
|----------|---------|---------|
| `forge.model` | `sonnet` | Extraction model via AI Gateway (cheap, high-volume). Opus only for ambiguous batches. |
| `forge.inferred_window.oa_days` | `5` | Default OA deadline window when none stated. |
| `forge.inferred_window.bill_days` | `7` | Default bill due window when none stated. |
| `forge.thisweek_anchor` | `Fri 17:00` | What `Due/ThisWeek` resolves to. |
| `forge.eod_time` | `23:59` | What "EOD" resolves to (owner-local). |
| `forge.max_subtasks` | `6` | Cap on generated subtasks per task. |
| `forge.uncertain_priority_floor` | `P4` | Priority ceiling for `AI/Uncertain` sources. |

Priority rules (refine the LLM's proposal): `From/VIP` bumps one tier · `Due/Today` ⇒ ≥ `P2` ·
`Due/Expired` ⇒ ≥ `P2` · `Job/OA` / `Job/Interview` ⇒ ≥ `P2` · `④ FYI`-adjacent ⇒ `P4`.

---

## Example run

**Input — one email**, swept by [Filer](filer.md) at 07:45 and surfaced in [Herald](herald.md)'s 08:00
digest. Filer labelled the thread:
`① Action Required`, `Type/Job` → `Job/OA`, `Needs/Upload`, `Due/ThisWeek`, `From/Company/Shopify`.

```
From:    talent@shopify.com
Date:    Thu, 29 May 2026 06:50 -0400
Subject: Next step: your Shopify Online Assessment
Body:    Hi Daniel — congrats on advancing. Please complete your HackerRank
         online assessment (2 problems, 90 minutes) by EOD Monday, June 2.
         Link: https://hackerrank.com/x/shopify-oa-… — one attempt only.
```

**Forge at 08:15:**

1. **Gather/Filter** — `① Action Required` + `Needs/Upload` + `Due/ThisWeek` ⇒ candidate.
2. **Extract** (Sonnet) — title + 3 subtasks.
3. **Deadline** — explicit "EOD Monday, June 2" ⇒ `2026-06-02T23:59:00-04:00`, `due_kind:"explicit"`.
4. **Priority** — `Job/OA` ⇒ ≥ `P2`; `From/Company/Shopify` not VIP; deadline 4 days out ⇒ **P1** (one
   attempt, near term).
5. **Dedupe** — `dedupe_key` over `gmail:thread/198e… + "submit shopify oa" + 2026-06-02` — no hit ⇒
   **insert** + `increment` to Steward.

**Output — 1 task + 3 subtasks:**

```jsonc
{
  "id": "tsk_01HY9SHOPIFYOA",
  "title": "Submit Shopify OA",
  "subtasks": [
    { "id": "sub_1", "text": "Open the HackerRank OA link from the Shopify email", "done": false },
    { "id": "sub_2", "text": "Solve 2 problems in one 90-minute attempt",          "done": false },
    { "id": "sub_3", "text": "Confirm submission + screenshot the completion page", "done": false }
  ],
  "due": "2026-06-02T23:59:00-04:00",
  "due_kind": "explicit",
  "source": {
    "agent": "Herald", "channel": "email",
    "ref": "gmail:thread/198e…", "label_hint": "Needs/Upload",
    "excerpt": "…complete your HackerRank online assessment … by EOD Monday, June 2…"
  },
  "priority": "P1",
  "status": "open",
  "dedupe_key": "sha256(198e…|submit shopify oa|2026-06-02)",
  "created": "2026-05-29T08:15:11-04:00",
  "updated": "2026-05-29T08:15:11-04:00"
}
```

**Downstream, same morning:**

- **08:20 — [Sundial](sundial.md):** sees a new task with `due != null` ⇒ creates a Google Calendar
  block for the OA before 2026-06-02 23:59.
- **[Steward](steward.md):** Wire event `{agent:"Forge", type:"task", op:"increment",
  payload:{open:+1, due_this_week:+1}, idempotencyKey:"tsk_01HY9SHOPIFYOA"}` ⇒ Tasks counters move
  (and it lands on the **Deadline board**, §6.2).
- **08:30 — [Compass](compass.md):** reads the task store; "Submit Shopify OA" is a top-3 priority for
  the day plan.

**Now the dedupe payoff:** at Mon 09:00, [Headhunter](headhunter.md)'s full scan independently finds
the same Shopify OA window and emits a finding. Forge computes the **same `dedupe_key`** (same thread
isn't there, but the Headhunter job id normalizes to the same Shopify-OA obligation + same `2026-06-02`
date) → **merge**: it unions any new subtasks, appends the Headhunter `source`, keeps the earlier
`due`, and emits an `upsert` — **no second task, no double count.**

---

## Open questions

- **Subtask granularity:** fixed 3–6 steps, or let the LLM size to the task? Current cap is
  `forge.max_subtasks = 6`; revisit once real OA/interview emails are in.
- **Cross-channel match confidence:** how aggressively should a Headhunter finding merge into a
  Herald-sourced task when the title wording differs? A too-loose match merges distinct jobs at the
  same company; too-tight forks one obligation into two. Consider an embedding similarity gate above
  the `dedupe_key`.
- **Recurring obligations** (monthly bills via `Needs/Pay`): one task that resets, or a fresh task per
  cycle? Leaning fresh-per-cycle so Steward's completion-rate stays honest.
- **Owner edits round-trip:** if the owner edits a subtask in the Vault, does that flow back to D1, or
  is D1 authoritative and the Vault a projection? (Affects `locked_by_owner` semantics.)
- **Manual capture surface:** hotkey vs a Quick-capture inbox (§6.2) that Forge drains on the next run.
