# Atlas — Architecture

> **Purpose:** How the whole system fits together — the orchestrator model, the **Wire** event bus, the single-writer **Steward** contract, the cloud-vs-local split, the dependency graph + rules, the three core pipelines, and the data stores each agent uses.

## At a glance

| Aspect | Decision |
|---|---|
| **Orchestrator** | **Atlas** schedules, routes, sequences, and supervises. It does *no* domain work. |
| **Event bus** | the **Wire** — a Cloudflare **Queue**. Agents emit events; Steward consumes. |
| **Single writer** | **Steward** is the *only* writer to **The Vault**. It fetches nothing; it is fed (SPEC §6.4). |
| **Source of truth** | **The Codex** (personal facts, read-only to agents). Dashboard state lives in **The Vault** (Obsidian). |
| **Hosting** | Cloudflare **Workers** + **Durable Objects** by default. Two agents are **Local** (Echo, Quill). |
| **State stores** | **D1** (relational), **KV** (config/flags), **R2** (blobs), **Durable Objects** (per-agent live state). |
| **Core invariant** | One writer per resource. Suggest, don't destroy. Idempotent + observable. |
| **Related docs** | [agent roster](01-agent-roster.md) · [scheduling](03-scheduling.md) · [Steward](agents/steward.md) · [Flagger](08-flagger.md) · [hosting](06-hosting-cloudflare-mcp.md) · [the Codex](07-source-of-truth-codex.md) |

---

## 1. The orchestrator model — Atlas supervises, it does not do domain work

**Atlas** (root orchestrator / supervisor, agent #0) is always-on Cloud compute. Its job is to **schedule, route, sequence, and supervise** the fleet — and *nothing else*. It owns the shared event bus (the **Wire**) and the schedules; every piece of domain work (labeling email, drafting digests, extracting tasks, capturing audio, writing the dashboard) belongs to a specialized sub-agent.

What this buys you:

- **No domain logic lives in the orchestrator.** When Herald's digest format changes, you touch Herald, not Atlas. Atlas never grows a "just handle this one email case" branch.
- **Sequencing is explicit and centralized.** The strictly-sequential morning chain (§4) is enforced by Atlas + Cloudflare Cron/Workflows, not by agents calling each other ad hoc.
- **Supervision is uniform.** Every notable event or failure flows to **Flagger** (#15) with a severity and trust score, so observability is a system property rather than per-agent bolt-on.

```
                          ┌───────────────────────────────────────────┐
                          │                  ATLAS                     │
                          │   schedules · routes · sequences · supervises │
                          │      owns: the Wire + cron schedules        │
                          └───────────────────────────────────────────┘
            schedules / sequences │                       │ supervises (incidents → Flagger)
              ┌───────────────────┘                       └───────────────────┐
              ▼                                                                ▼
   ┌──────────────────────────────┐                          ┌──────────────────────────────┐
   │  Domain agents (1–16)        │  emit events on the Wire │   Flagger (#15)              │
   │  Filer, Herald, Forge,       │ ───────────────────────▶ │   severity + trust score     │
   │  Sundial, Compass, Scout, …  │                          │   P1/P2 push, P3/P4 batched  │
   └──────────────────────────────┘                          └──────────────────────────────┘
```

Atlas writes only to **the Wire** and to **schedules** — never to the Vault, Gmail, Calendar, or external profiles. Those belong to the agents that own them.

---

## 2. The Wire — the event bus

The **Wire** is a Cloudflare **Queue**. It is the decoupling layer between *producers* (every agent that has something to record) and the *single consumer* (**Steward**).

- **Producers** never touch the Vault directly. When an agent has dashboard-relevant news — a task created, an event registered, a counter to bump, an incident — it **emits an event on the Wire**.
- **The Wire serializes delivery to Steward.** Because Steward is a single consumer (single-writer, §3), writes to the Vault are applied one at a time, in order, with no concurrent file access.
- **Events carry an `idempotencyKey`** so a re-delivery or a replay cannot double-apply (e.g., a counter increment runs once even if the message is delivered twice).

This is the mechanism that makes the design pillar **"one writer per resource"** real: many agents can fire at once, but only Steward mutates the Vault, and only one event at a time reaches it.

> Flagger also rides the Wire (or its own event path) for incidents, but its *dashboard* writes — the Flagger feed — still go through Steward like everyone else. Flagger never writes the Vault directly.

---

## 3. The single-writer Steward contract (SPEC §6.4)

**Steward** (#11, dashboard manager) is the **sole writer** of **The Vault** (the Obsidian dashboard). This is non-negotiable and is the owner's explicit requirement: *Steward fetches nothing; it is fed.*

The contract, verbatim from SPEC §6.4:

- **Steward is the only writer.** Other agents send it an **event** on the Wire; Steward applies it.
- **Writes are serialized** (single consumer / lock) to avoid Obsidian file conflicts.
- **Event shape:**
  ```json
  { "agent": "...", "type": "...", "entity": "...",
    "op": "increment | upsert | append",
    "payload": { },
    "idempotencyKey": "..." }
  ```
- **Counters move via `increment` with an `idempotencyKey`** so a replay can't double-count.

Why a single writer matters:

| Problem if multiple writers | How the single-writer contract prevents it |
|---|---|
| Two agents edit the same Obsidian note → file conflict / lost write | All writes funnel through one serialized consumer. |
| Same event counted twice (retry, replay) | `idempotencyKey` makes `increment` idempotent. |
| Races on "jobs applied++" from Headhunter + Forge | Events are ordered and applied one at a time. |
| Dashboard drifts from agent intent | One code path owns Vault mutation; easy to audit. |

The `op` values map cleanly to dashboard surfaces: `increment` for counters/metrics (§6.1 of the spec — jobs funnel, events, email, tasks, meetings, brand), `upsert` for views with stable rows (job pipeline kanban, people/CRM, prompt library), `append` for feeds (Flagger feed, agent heartbeat / run log, quick-capture inbox).

---

## 4. Dependency graph + dependency rules (SPEC §4)

Agents are coupled through **data**, not through direct calls. The graph below shows what produces what; the rules below are the canonical constraints from SPEC §4 that must hold.

```
   Gmail push
       │
       ▼
   Filer ──(labels)──▶ Herald ──(digest)──▶ Forge ──(tasks)──▶ Sundial ──(cal events)──▶ Compass
                          │                    │                                            ▲
   Headhunter ───(apply-by tasks)─────────────▶┘                                            │
                                                                Google Calendar ────────────┘
   Usher ──(events + cal add)──▶ Google Calendar
   Echo ──(transcript)──▶ Archivist ◀──(context)── The Codex
   Envoy ◀──(reads)── The Codex
                          │
   everyone ──(events)──▶ the Wire ──▶ Steward ──▶ The Vault
   every agent ──(incidents)──▶ Flagger ──▶ (via Steward) The Vault
```

### Dependency rules (canonical — SPEC §4)

- **Forge** depends on parsed input (**Herald**, **Headhunter**, or manual).
- **Sundial** depends on **Forge** (tasks with deadlines).
- **Compass** depends on **Forge** (tasks) + **Google Calendar** (events from Sundial / Usher).
- **Archivist** depends on **Echo** (transcript) + **The Codex** (context).
- **Headhunter** feeds **Forge** (creates "apply by X" tasks) and **Steward** (pipeline counts).
- **Usher** feeds **Google Calendar** and **Steward** (events attended++).
- **Envoy** feeds **Steward** (projects/experience counts) and reads **The Codex**.
- **Filer** runs **before** Herald (label first, then digest reads labels).
- **Steward** is fed by everyone and fetches nothing (owner's explicit requirement).
- **Flagger** receives error/incident events from every agent.
- **Switchboard** is consulted at design time when a new capability is needed; **it doesn't run in the loop**.

> **Reading the graph:** the only place that mutates the Vault is the arrow into **Steward**. The only places that reach external systems (Gmail labels, Google Calendar, external profiles) are the agents that own those resources. Atlas appears nowhere in this graph because it owns sequencing and the bus, not data.

See [scheduling](03-scheduling.md) for *when* each edge fires and which segments are sequential vs parallel. See [agent roster](01-agent-roster.md) for the per-agent runtime / trigger / writes-to table.

---

## 5. The three core pipelines

These reproduce SPEC §4 exactly. They are the canonical wiring diagrams for the system.

### 5.1 Morning pipeline (strictly sequential — each consumes the prior's output)

Each stage starts **after** the previous one succeeds. Timings: Filer sweep **07:45**, Herald **08:00**, Forge **08:15**, Sundial **08:20**, Compass **08:30** (see [scheduling](03-scheduling.md)).

```
Gmail push ─▶ Filer (label) ─▶ Herald (digest) ─▶ Forge (tasks) ─▶ Sundial (calendar) ─▶ Compass (day plan)
                                   │                    │                  │                    │
                                   └────────────────────┴──────────────────┴────────────────────┘
                                                        ▼
                                                     Steward  ──▶  The Vault (Obsidian)
```

Filer labels first because Herald's digest *reads* labels. Forge extracts tasks from the morning's `① Action Required` mail. Sundial puts deadline tasks onto Google Calendar. Compass synthesizes tasks + the now-settled calendar into the day plan. Every stage that has dashboard-relevant output emits to the Wire → Steward → Vault.

### 5.2 Event-bus / fan-in to Steward (Steward fetches NOTHING; it is fed)

Many independent agents converge on the Wire; the Wire serializes them into Steward; Steward applies them one at a time to the Vault.

```
Usher ─┐
Headhunter ─┤
Scout ─┤
Envoy ─┤──▶  the Wire (queue) ──▶  Steward (single serialized writer) ──▶ The Vault
Forge ─┤
Compass ─┤
Flagger ─┘
```

This is the picture of the single-writer contract (§3) in action: the fan-in is wide, the writer is one, and `idempotencyKey` guards every `increment`.

### 5.3 Meetings pipeline (local → cloud)

Audio capture is **local** (Echo runs on the macOS daemon, real-time); structuring is **cloud** (Archivist runs after the meeting). Archivist pulls work context from the Codex to make notes context-aware, then hands off to Steward.

```
Echo (local daemon, real-time) ─▶ transcript ─▶ Archivist (cloud, after meeting) ─▶ Steward ─▶ Vault
                                                       ▲
                                                  The Codex (work context, past meetings)
```

---

## 6. Cloud-vs-local split

> **Cloud by default, local when it must be.** Most agents run on Cloudflare. Two agents need the physical machine and run as a **local macOS daemon** that authenticates to the cloud and pushes results up.

| Where | Agents | Why |
|---|---|---|
| **Cloud (Cloudflare)** | Atlas, Herald, Filer, Forge, Sundial, Compass, Scout, Usher*, Headhunter, Archivist, Steward, Envoy*, Flagger, Librarian | Stateless or coordinated work, scheduling, API/MCP calls, dashboard writes. |
| **Local (macOS daemon)** | **Echo** (#9, audio capture — all I/O devices), **Quill** (#12, screen-aware form autofill) | Need direct OS access to audio devices / the screen. Cannot run on Cloudflare. |

\* **Usher** and **Envoy** are Cloud **+ browser** (they need a headless/automation browser for registration and brand sync).
**Switchboard** (#14) appears in neither row — it is **design-time only**: a `/switchboard` slash-command + MCP registry (`.claude/registry/mcp-registry.json`), **not a deployed Worker** (D-07; invariant 7 below).

The local daemon (menubar app / launchd):

- **Echo** captures audio in real time and streams it up; the cloud side uses a **Durable Object + WebSocket** to receive the live stream. The resulting **transcript** is what Archivist consumes.
- **Quill** reads the active document/screen, maps form-field labels → Codex fields, and writes back into the **active document (local)** — never to the cloud.
- **Privacy boundary:** raw audio (Echo) and raw screen (Quill) **never leave the device** except as derived artifacts the owner approves. This is enforced at the daemon, not in the cloud.

Everything else runs on Workers / Durable Objects; the daemon's only jobs are capture and autofill.

---

## 7. Data stores — what they are and who uses which

Cloudflare provides four storage primitives. Each maps to a distinct kind of state. (See [hosting](06-hosting-cloudflare-mcp.md) for provisioning details.)

| Store | What it is | What lives there | Primary users |
|---|---|---|---|
| **D1** | SQLite (relational) | Tasks, jobs, events, the **run-log** / audit log | **Forge** (tasks), **Headhunter** (jobs), **Scout**/**Usher** (events), **Atlas** (run-log), **Flagger** (audit) |
| **KV** | Key-value, edge-cached | Config, feature flags, lightweight per-agent settings | **Atlas** (schedule/flags), all agents read config |
| **R2** | Object/blob storage | Audio blobs, exports | **Echo** (audio), **Steward**/**Herald** (exports) |
| **Durable Objects** | Single-instance stateful actor + coordination | Per-agent live state; one DO instance per agent | Every long-lived agent; **Echo** uses a DO **+ WebSocket** for the live stream; **Steward** uses single-consumer serialization |

How the stores relate to the rest of the architecture:

- **The Vault is not a Cloudflare store.** It's the Obsidian dashboard on the local machine (synced), reached via a **local MCP bridge**. Only **Steward** writes it.
- **The Codex is not a Cloudflare store either.** It's the source-of-truth profile doc (`codex.md` in the Vault, or a Google Doc), **read-only to agents** except via an explicit "update my profile" flow. Read by **Quill**, **Envoy**, **Archivist**.
- **D1 holds the structured "facts" agents compute** (tasks, jobs, events) and the **audit log of every agent action** (surfaced via Flagger). The Vault holds the *human-facing* rendering of that state; D1 holds the *machine* state.
- **Durable Objects coordinate**, including Steward's serialized writes and Echo's live audio session. KV is for config that should be cheap to read at the edge. R2 is for anything binary or large (audio, exports).

```
         ┌──────────── Cloudflare ────────────┐          ┌──────── Local (synced) ────────┐
         │  D1        KV       R2     Durable  │          │   The Vault (Obsidian)         │
         │  tasks/    config/  audio/  Objects │          │   ← Steward writes (only)      │
         │  jobs/     flags    exports per-    │  MCP     │                                │
         │  events/                    agent   │  bridge  │   The Codex (codex.md)         │
         │  run-log            (Echo:  state   │ ───────▶ │   ← read-only to agents        │
         │                      +WS)           │          │     (Quill/Envoy/Archivist)    │
         └─────────────────────────────────────┘          └────────────────────────────────┘
```

---

## 8. How a single fact moves through the system (worked trace)

To tie it together — a recruiter emails an online-assessment deadline:

1. **Gmail push** → **Filer** labels the thread `① Action Required`, `Type/Job` → `Job/OA`, `Needs/Schedule`, `Due/ThisWeek`, marks `AI/Reviewed`. (Cloud; Gmail labels only — never archives/deletes.)
2. **Herald** (08:00) reads the fresh labels and includes the OA in the daily digest.
3. **Forge** (08:15) extracts an "apply/complete OA by X" task into **D1**, and emits a Wire event (`agent: Forge, op: upsert, entity: task`).
4. **Sundial** (08:20) syncs the deadline task to **Google Calendar**, emits a counter event.
5. **Compass** (08:30) folds the task + calendar block into the day plan, emits the **Today** view event.
6. **Headhunter** (separately) bumps the **jobs funnel** counter via an `increment` event with an `idempotencyKey`.
7. Every event lands on **the Wire** → **Steward** applies them one at a time → **The Vault** shows the task, the day plan, and the updated jobs-funnel counter.
8. If any step throws (e.g., Gmail rate-limit, calendar API error), the failing agent emits an incident to **Flagger** with a **severity** (`P1`–`P4`) and **trust score** (0–100); P1/P2 push immediately, P3/P4 batch into the Flagger feed in the Vault.

No two agents ever wrote the same resource: Filer owned the Gmail labels, Sundial owned the calendar, D1 held the task, and **only Steward** touched the Vault.

---

## 9. Architectural invariants (the rules that must always hold)

1. **One writer per resource.** Steward is the sole Vault writer; Filer is the sole Gmail-label writer; Sundial/Usher own the calendar; Envoy owns external profiles.
2. **Suggest, don't destroy.** Anything destructive or outward-facing (delete, post, register, pay) is gated behind explicit human confirmation. Default = draft + ask. (Envoy, Usher, any delete.)
3. **Steward fetches nothing; it is fed.** All Vault state arrives as Wire events.
4. **Idempotent + observable.** Every run is safe to repeat (`idempotencyKey` on counters); every notable event/failure goes to Flagger.
5. **Single source of truth.** Personal facts live in the Codex (read-only to agents); dashboard state lives in the Vault (Steward-written).
6. **Cloud by default, local only when the OS forces it** (Echo audio, Quill screen). Raw capture never leaves the device unapproved.
7. **Switchboard is design-time only.** It recommends MCPs/tools when a new capability is needed; it never runs in the live loop.

---

## See also

- [Agent roster](01-agent-roster.md) — the canonical 16-agent list, runtimes, and importance tiers.
- [Scheduling](03-scheduling.md) — cron triggers, sequential vs parallel, concurrency rules.
- [Steward](agents/steward.md) — the write contract in depth and the Vault layout.
- [Flagger](08-flagger.md) — severity, trust score, routing, self-monitoring.
- [Hosting: Cloudflare + MCP](06-hosting-cloudflare-mcp.md) — Workers, Durable Objects, Queues, D1/KV/R2, MCP servers, the local daemon.
- [The Codex](07-source-of-truth-codex.md) — the source-of-truth profile doc.
