# Steward (dashboard manager)

> **Purpose:** Steward is the **sole writer** to **The Vault** (Obsidian). It is *fed* by other agents over the **Wire** and fetches nothing itself — it applies idempotent `increment`/`upsert`/`append` ops to dashboard counters, views, and indexes, serialized through a single consumer so Obsidian files never conflict.

## At a glance

| | |
|---|---|
| **Codename / #** | **Steward** — roster #11 |
| **Role** | Dashboard manager (Obsidian) — sole Vault writer |
| **Runtime** | Cloud (Cloudflare Worker + a per-agent Durable Object for the write lock) |
| **Trigger** | Event-driven only — *called by other agents over the Wire*; never self-schedules, never cron'd |
| **Inputs** | Wire events `{ agent, type, entity, op, payload, idempotencyKey }` |
| **Outputs** | Mutations to The Vault: counters, views, indexes |
| **Dependencies** | The **Wire** (Cloudflare Queue); writes nothing without an inbound event |
| **MCPs / tools** | Obsidian via the **local MCP bridge** (the Vault lives on the local/synced machine); D1 (counter ledger + dedup keys), KV (config) |
| **Writes to** | **The Vault** (and only Steward writes it) |
| **Fed by** | Usher, Headhunter, Scout, Envoy, Forge, Compass, Flagger, Herald, Sundial, Archivist — i.e. *everyone* |
| **Fetches** | **Nothing.** (Owner's explicit requirement — see §4 / §6.4.) |

Related: [Atlas](atlas.md) (orchestrator) · [scheduling](../03-scheduling.md) · [architecture](../02-architecture.md) · the dashboard spec ([Vault dashboard](../05-dashboard.md)) · feeders [Usher](usher.md), [Headhunter](headhunter.md), [Scout](scout.md), [Envoy](envoy.md), [Forge](forge.md), [Compass](compass.md), [Flagger](flagger.md).

---

## What it does

Steward owns **one job**: turn an inbound **Wire event** into a safe, idempotent mutation of **The Vault**. Other agents do the domain work (search, label, plan, transcribe); when they have a fact worth showing on the dashboard, they hand Steward an event and move on. Steward never reasons about *why* — it applies the `op` and guarantees:

1. **Single writer per resource.** Design pillar #1: exactly one agent mutates any given external system. For the Vault, that agent is Steward. No other agent ever touches an Obsidian file. This is what prevents races and **double-counting**.
2. **Fed, never fetching.** Steward has no readers, no crawlers, no schedules. If nothing arrives on the Wire, Steward does nothing. This was an explicit owner requirement (§4: *"Steward is fed by everyone and fetches nothing"*).
3. **Serialized, single-consumer writes.** All writes pass through one consumer holding a lock, so two agents firing at the same instant (very common on **Fri 16:00** when Scout + weekly-Herald both fan in) can't corrupt the same `.md` file.
4. **Idempotent on replay.** Every event carries an `idempotencyKey`. A counter `increment` is applied **once** per key; a redelivered queue message (Cloudflare Queues are at-least-once) is detected and dropped, so a replay can't bump `events-attended` twice.

### Dashboard artifacts Steward maintains

Steward is the hand that updates everything in [the Vault dashboard](../05-dashboard.md). Three artifact classes:

| Artifact class | Examples (from §6) | Touched by op |
|---|---|---|
| **Counters / metrics** | Jobs funnel (applied → OA → interview → offer/rejection), Events (registered / attended / upcoming), Email (unread / action-required / processed-today), Tasks (open / done-today / overdue / completion rate), Meetings (count / hours), Brand (posts shipped, projects published, GitHub streak), Habits/streaks | `increment` |
| **Views** (Dataview / Bases) | Today (Compass), This Month, Upcoming events (7 days), Deadline board, Job pipeline kanban, Waiting-on list, Weekly review, Flagger feed, Prompt library table, Agent heartbeat / run log | `upsert` (refresh/rebuild the view block) |
| **Indexes / logs** | Meeting-notes index, People/CRM, Quick-capture inbox, run log, audit trail | `append` |

> Steward does **not** decide which counters exist or how views are laid out — the dashboard schema lives in §6 / [Vault dashboard](../05-dashboard.md). Steward is the *applier*, not the designer.

---

## The event shape

Every feeder sends exactly this object onto the Wire (§6.4):

```jsonc
{
  "agent":          "Usher",            // codename of the sender (from §2 roster)
  "type":           "event.registered", // domain event name — what happened, for routing/audit
  "entity":         "events",           // which dashboard artifact family this targets
  "op":             "increment",        // "increment" | "upsert" | "append"
  "payload":        { /* op-specific */ },
  "idempotencyKey": "usher:evt:hackathon-2026-05:registered"
}
```

| Field | Meaning | Notes |
|---|---|---|
| `agent` | Sender's **codename** | Must be a roster codename (§2). Stamped into the run log / audit trail. |
| `type` | Domain event name | e.g. `event.registered`, `task.created`, `job.applied`, `flag.raised`. Used for routing + observability, not for the math. |
| `entity` | Target artifact family | e.g. `events`, `jobs`, `tasks`, `meetings`, `brand`, `flags`. Selects *which* counter/view/index. |
| `op` | The operation | One of the three ops below. |
| `payload` | Op-specific data | For `increment`: which counter + delta. For `upsert`: the row/key + fields. For `append`: the line/note to add. |
| `idempotencyKey` | Dedup key | **Mandatory.** Stable per logical event. Same key = same effect applied once, no matter how many times the message is delivered. |

### The three ops

| `op` | Semantics | Used for | Idempotency rule |
|---|---|---|---|
| **`increment`** | Add `payload.delta` (default `+1`) to a named counter | Counters: `events-attended`, `jobs-applied`, `rejections`, `interviews`, … | Apply **only if** `idempotencyKey` is unseen. Record the key in the D1 ledger atomically with the bump. Replays are no-ops. |
| **`upsert`** | Insert-or-replace a keyed row / rebuild a view block | Views, job-pipeline rows, people/CRM entries, the "Today" plan | Naturally idempotent — same key + same fields converge to the same state. Last-writer-wins on the keyed row. |
| **`append`** | Add a line/note to an index or log | Meeting-notes index, run log, quick-capture inbox, audit trail | Dedup by `idempotencyKey` so the same line isn't appended twice on redelivery. |

---

## How it works

```
                 the Wire (Cloudflare Queue)
   Usher ─┐
Headhunter ┤
   Scout ─┤
   Envoy ─┤──▶  [ Queue ] ──▶  Steward consumer  ──▶  The Vault (Obsidian)
   Forge ─┤                    (single, serialized)        via local MCP bridge
 Compass ─┤                          │
 Flagger ─┘                          ▼
                              D1 idempotency ledger
                              (seen idempotencyKeys)
```

Per-event flow inside the single consumer:

1. **Pull one event** from the Wire. The consumer is single-concurrency — exactly one event is in flight at a time. Everyone else queues. This *is* the serialization guarantee (§10: *"Steward writes are serialized regardless of how many agents fire at once"*).
2. **Validate shape.** Reject anything missing `agent`, `op`, `entity`, or `idempotencyKey`. A malformed event → raise a flag to [Flagger](flagger.md), do not write.
3. **Acquire the Vault write lock** (held by Steward's Durable Object) so no two writes touch Obsidian files concurrently — even across Worker invocations.
4. **Dedup check.** Look up `idempotencyKey` in the D1 ledger.
   - **Already present** → this is a replay. **Skip the mutation entirely** and ack the message. (No double-count.)
   - **Absent** → proceed.
5. **Apply the `op`:**
   - `increment` → bump the named counter by `payload.delta` (or `+1`) **and** insert `idempotencyKey` into the ledger in the *same* transaction. The atomic pairing is what makes the increment exactly-once.
   - `upsert` → write/replace the keyed row or rebuild the view block.
   - `append` → add the line/note (skip if key already appended).
6. **Refresh dependent views.** A counter or row change may invalidate a Dataview/Bases block (e.g. the calendar/Upcoming-events view). Steward re-renders the affected view artifact.
7. **Append to the run log** (the §6.2 *Agent heartbeat / run log* view): which `agent`, `type`, `op`, `entity`, key, and result.
8. **Release the lock** and **ack** the Wire message. On failure before ack, the message is redelivered — and step 4 makes the retry safe.

### Why single-writer matters (concretely)

- **No file races.** Obsidian notes are plain `.md` files synced to disk. Two concurrent writers = lost edits / merge garbage / corrupted frontmatter. One serialized consumer = impossible.
- **No double-counting.** If Usher and a manual retry both report the same registration, the shared `idempotencyKey` collapses them to one `+1`. Counters stay truthful — the whole point of the dashboard.
- **One audit surface.** Every Vault change has exactly one author (Steward) and one log entry, so the *Agent heartbeat / run log* is a complete, trustworthy history.
- **Backpressure is free.** A flood of events just queues behind the single consumer; nothing is dropped, nothing collides. Friday's Scout + weekly-Herald + Steward weekly-review compile all serialize cleanly.

---

## Inputs / Outputs

**Inputs** — Wire events only:

```jsonc
{ "agent": "Forge",   "type": "task.created",    "entity": "tasks",  "op": "increment", "payload": { "counter": "tasks-open", "delta": 1 }, "idempotencyKey": "forge:task:2026-05-29:abc123" }
{ "agent": "Compass", "type": "dayplan.ready",   "entity": "views",  "op": "upsert",    "payload": { "view": "Today", "date": "2026-05-29", "blocks": [ /* ... */ ] }, "idempotencyKey": "compass:today:2026-05-29" }
{ "agent": "Flagger", "type": "flag.raised",     "entity": "flags",  "op": "append",    "payload": { "id": "flg-91", "severity": "P3 Medium", "title": "Heartbeat stale" }, "idempotencyKey": "flagger:flg-91" }
```

**Outputs** — mutations in The Vault: bumped counters, refreshed views (Today, This Month, Upcoming events, Deadline board, Job pipeline kanban, …), appended indexes/logs. Plus a run-log entry per event. **No outbound calls, no fetches.**

---

## Dependencies

- **The Wire** (Cloudflare Queue) — Steward's *only* input. No Wire event ⇒ no write.
- **Obsidian local MCP bridge** — the Vault lives on the local/synced machine (§7); Steward reaches it through the bridge.
- **D1** — the idempotency ledger (seen keys) + counter values; **KV** — dashboard config (counter/view definitions).
- **Durable Object** — holds the single Vault write lock for serialization.
- Steward depends on **no other agent's runtime** — feeders enqueue and forget. The coupling is the event contract, nothing more.

---

## Schedule / Triggers

**Event-driven only.** Steward is never cron-scheduled and never self-schedules (§10: *"fed by other agents; never self-scheduled"*). It wakes when a message lands on the Wire. Notable bursts:

| When | Who feeds Steward | Concurrency |
|---|---|---|
| Morning chain (Filer→Herald→Forge→Sundial→Compass) | Forge, Sundial, Compass | Events arrive in sequence; Steward serializes regardless |
| **Fri 16:00** | Scout (events digest) + weekly-Herald run in parallel, then both fan into Steward | Steward serializes the two streams behind one consumer |
| **Fri 16:30** | weekly-review build — Steward compiles the weekly dashboard summary | Reads accumulated state, writes the summary view |
| On-demand | Usher (registration), Envoy (brand sync), Headhunter (pipeline counts) | Whenever they fire |
| Event-driven | Flagger incidents | P3/P4 batched into the dashboard feed (§8) |

---

## Failure modes & Flagger hooks

| Failure | Steward's behavior | Flag |
|---|---|---|
| **Malformed event** (missing `op`/`entity`/`idempotencyKey`) | Reject, do not write, ack-or-deadletter | → [Flagger](flagger.md) `P3 Medium`, high trust (caught at boundary) |
| **Redelivered message** (Queues at-least-once) | Dedup via D1 ledger → skip mutation, ack | No flag — expected and handled |
| **Obsidian bridge unreachable** | Hold the message (don't ack), retry with backoff | If retries exhaust → `P2 High` (dashboard going stale) |
| **Counter ↔ ledger mismatch** (a counter looks wrong vs. source-of-truth counts in D1) | Don't silently "fix" — surface it | → Flagger `P3 Medium`, *dashboard inconsistency* (§8) |
| **Lock not acquired / DO unavailable** | Refuse to write (never write without the lock) | `P2 High` |
| **Heartbeat stale** (no run-log entry in expected window) | — | Flagger self-monitors the heartbeat (§8) |

Steward never *originates* domain flags (it's not doing domain work); it flags **its own** write-path problems and dashboard inconsistencies, all `status: open → ack → resolved → muted` per §8.

---

## Config

- **Counter & view registry** (KV): the canonical list of counters and view blocks Steward may touch — mirrors §6.1 / §6.2. Steward applies only `entity`/`counter` names that exist here.
- **Idempotency ledger TTL** (D1): how long seen `idempotencyKey`s are retained (long enough to outlive any redelivery window).
- **Vault path / bridge endpoint**: where the Obsidian MCP bridge points.
- **Lock lease / retry-backoff** parameters for the write lock and bridge calls.

---

## Open questions

- **Ledger retention vs. cost:** keep `idempotencyKey`s forever, or TTL them once redelivery is impossible? TTL risks a very-late replay double-counting.
- **View rebuild scope:** on each `increment`, fully re-render dependent views, or batch view refreshes (e.g. debounce on the Friday burst)?
- **Counter reconciliation:** should Steward periodically reconcile dashboard counters against authoritative counts in D1 — and is that a *read*, which violates the "fetches nothing" rule, or an internal consistency check that's allowed?
- **Conflict policy for `upsert`:** strict last-writer-wins, or per-field merge when two agents upsert overlapping keys?

---

## Example run

**Scenario:** [Usher](usher.md) finishes registering the owner for an event and reports it. The dashboard should show one more event attended and a refreshed calendar/upcoming-events view — **once**, even if the Wire redelivers the message.

**1 — Usher enqueues an event on the Wire** (Usher fetches/registers; it does **not** write the Vault):

```jsonc
{
  "agent":          "Usher",
  "type":           "event.registered",
  "entity":         "events",
  "op":             "increment",
  "payload":        { "counter": "events-attended", "delta": 1, "view": "Upcoming events" },
  "idempotencyKey": "usher:evt:devto-meetup-2026-06-03:registered"
}
```

**2 — Steward (single consumer) processes it:**

```
pull ─▶ validate OK ─▶ acquire Vault lock ─▶ dedup check
   │
   ├─ key "usher:evt:devto-meetup-2026-06-03:registered" NOT in ledger ─▶ proceed
   │     • increment counter events-attended: 11 → 12   (atomic with ledger insert)
   │     • record idempotencyKey in D1 ledger
   │     • refresh the "Upcoming events" (7-day) view block — the new event now shows
   │     • append run-log: [Usher · event.registered · increment · events]
   │
   └─ release lock ─▶ ack message
```

**Result in The Vault:** `events-attended` reads **12**; the calendar / Upcoming-events view re-renders with the meetup. One log line in the *Agent heartbeat / run log*.

**3 — Queue redelivers the same message** (at-least-once delivery):

```
pull ─▶ validate OK ─▶ acquire lock ─▶ dedup check
   │
   └─ key ALREADY in ledger ─▶ REPLAY ─▶ skip mutation ─▶ release lock ─▶ ack
```

**Result:** `events-attended` stays **12** — **no double-count**. The idempotent `increment` did its job. This is exactly why every event carries an `idempotencyKey` and why Steward is the single serialized writer.
