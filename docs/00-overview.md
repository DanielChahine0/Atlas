# Atlas — System Overview

> **Purpose:** Atlas is a personal **orchestrator** that runs a fleet of specialized sub-agents to manage the owner's digital life — email, tasks, calendar, events, job hunting, meeting capture, an Obsidian dashboard, screen autofill, and personal-brand publishing — while doing almost no domain work itself.

## At a glance

| | |
|---|---|
| **What it is** | A root orchestrator (**Atlas**) plus a fleet of 16 specialized sub-agents |
| **What Atlas itself does** | Schedules, routes, sequences, supervises — owns the event bus and shared state. It does *not* do domain work. |
| **Source of truth** | **The Codex** (`codex.md` — personal facts, read-only to agents) |
| **Dashboard / state** | **The Vault** (Obsidian) — written by exactly one agent, **Steward** |
| **Event bus** | the **Wire** (Cloudflare Queue) |
| **Hosting** | Cloudflare by default; **Echo** + **Quill** run as a local macOS daemon |
| **Default posture** | Suggest, don't destroy — destructive/outward actions gated behind human confirmation |
| **Reliability** | Idempotent runs; every notable event/failure reported to **Flagger** |
| **Related docs** | [agent roster](01-agent-roster.md) · [architecture](02-architecture.md) · [scheduling](03-scheduling.md) · [roadmap](12-roadmap.md) |

---

## What Atlas is

Atlas is an **orchestrator + fleet**. The orchestrator is one always-on cloud agent named **Atlas**; the fleet is 16 sub-agents, each with a **codename** and a plain-English role (e.g. **Herald** is the email digest, **Filer** is the email labeler, **Steward** is the dashboard writer).

The split is deliberate. Atlas does no email triage, no task extraction, no calendar writing. Its entire job is to **schedule, route, sequence, and supervise** the fleet, and to own the two shared things everyone depends on: the **Wire** (the event bus) and the system's state. Every piece of real work — labeling a thread, drafting a digest, extracting a task, capturing a meeting — belongs to exactly one sub-agent.

The fleet, by role:

- **Email & action:** **Filer** (labels every thread), **Herald** (the morning + Friday digest), **Forge** (turns information into tasks), **Sundial** (pushes deadline tasks to Google Calendar), **Compass** (synthesizes the day plan).
- **Weekly value:** **Scout** (events digest), **Headhunter** (job-board & hiring-window tracker), **Flagger** (incident flagging).
- **Capture:** **Echo** (local audio → transcripts), **Archivist** (structured meeting notes), **Quill** (screen-aware form autofill).
- **Outward / gated:** **Usher** (event registration), **Envoy** (personal-brand sync).
- **Meta:** **Switchboard** (capability router), **Librarian** (prompt library).
- **Infrastructure:** **Atlas** (orchestrator), **Steward** (sole Vault writer), and **The Codex** (source of truth).

The full table — codename, role, runtime, trigger, writes-to — and the two importance orderings (value vs. build order) live in [01-agent-roster.md](01-agent-roster.md).

---

## The five design pillars (SPEC §0)

Everything in Atlas follows from these five rules. They are the reason the system is safe to run unattended.

| # | Pillar | What it means in practice |
|---|--------|---------------------------|
| 1 | **One writer per resource** | Exactly one agent may mutate any given external system. The Vault has a single writer — **Steward**. This kills races and double-counting. |
| 2 | **Suggest, don't destroy** | Agents label, draft, and recommend. Anything destructive or outward-facing (delete, post, register, pay) is gated behind explicit human confirmation. Default = *draft + ask*. |
| 3 | **Cloud by default, local when it must be** | Most agents run on Cloudflare. Only the two that need the physical machine — **Echo** (audio) and **Quill** (screen) — run as a local daemon that talks to the cloud. |
| 4 | **Single source of truth** | Personal facts live in **The Codex**; dashboard state lives in **The Vault**. Agents *read* the Codex; only **Steward** *writes* the Vault. |
| 5 | **Idempotent + observable** | Every run is safe to repeat (replays can't double-count), and every notable event or failure is reported to **Flagger**. |

Pillar 1 is why **Filer** only labels (it never archives or deletes) and why every dashboard mutation flows through **Steward**. Pillar 2 is why **Envoy** drafts a post instead of posting and **Usher** asks before it registers or pays. Pillar 5 is why state changes carry an `idempotencyKey` — see the Steward write contract in [02-architecture.md](02-architecture.md).

---

## Cloud vs. local split

Atlas is **cloud by default** (pillar 3). Almost the entire fleet runs on Cloudflare — Workers for compute, Durable Objects for stateful agents, Queues for the Wire, Cron Triggers for the schedule, and D1/KV/R2 for state. Model calls go through the AI Gateway.

Two agents **cannot** run in the cloud because they need the physical machine:

- **Echo** — captures audio from all I/O devices during meetings. Requires OS audio access.
- **Quill** — fills forms on screen from the Codex. Requires screen/accessibility access.

Both run in a **local macOS daemon** (a menubar app / launchd) that authenticates to the cloud and pushes derived artifacts up — Echo sends transcripts, Quill returns fill results. The raw sensitive capture (audio, screen) never leaves the device except as artifacts the owner approves.

```
                         ┌──────────────────────── CLOUD (Cloudflare) ───────────────────────┐
                         │  Atlas · Filer · Herald · Forge · Sundial · Compass · Scout        │
                         │  Headhunter · Archivist · Steward · Envoy · Usher · Switchboard     │
                         │  Flagger · Librarian       (Workers · DO · Queues · D1/KV/R2)       │
                         └───────────────────────────────▲────────────────────────────────────┘
                                                         │ authenticated push (transcripts/results)
                         ┌───────────────────────────────┴────────────────────────────────────┐
                         │  LOCAL macOS daemon:   Echo (audio)   ·   Quill (screen)             │
                         └─────────────────────────────────────────────────────────────────────┘
```

Hosting details live in `06-hosting-cloudflare-mcp.md`.

---

## The core loop, in plain language

The heart of Atlas is the **morning pipeline**. It runs **strictly sequentially** — each agent consumes the previous one's output — and every state change fans into **Steward**, who writes it (and only it writes) to the Vault.

In order, every morning:

1. **Filer** sweeps Gmail and labels fresh threads (it also labels continuously, as mail arrives).
2. **Herald** reads those labels and drafts the digest — the thing the owner sees at 08:00.
3. **Forge** extracts tasks and subtasks (with deadlines) from the morning's `① Action Required` mail.
4. **Sundial** pushes the deadline tasks onto Google Calendar.
5. **Compass** synthesizes tasks + the settled calendar into a single **day plan** — "what do I actually do today."

Each step writes its counts and outputs to the Vault *through* Steward — never directly. Meetings follow a separate path: **Echo** captures audio locally in real time, hands the transcript to **Archivist** in the cloud, which produces structured notes and (again, via Steward) files them in the Vault.

```
                                THE CORE LOOP

  Gmail push
      │
      ▼
  ┌───────┐    ┌────────┐    ┌───────┐    ┌─────────┐    ┌─────────┐
  │ Filer │───▶│ Herald │───▶│ Forge │───▶│ Sundial │───▶│ Compass │
  │(label)│    │(digest)│    │(tasks)│    │ (cal.)  │    │ (plan)  │
  └───┬───┘    └───┬────┘    └───┬───┘    └────┬────┘    └────┬────┘
      │            │             │             │              │
      └────────────┴─────────────┴──────┬──────┴──────────────┘
                                        ▼
                                ┌───────────────┐
                                │   the Wire    │   (Cloudflare Queue / event bus)
                                └───────┬───────┘
                                        ▼
                                ┌───────────────┐
                                │    Steward    │   (single serialized writer)
                                └───────┬───────┘
                                        ▼
                                ┌───────────────┐         ┌─────────────┐
                                │   The Vault   │◀── reads │  The Codex  │
                                │  (Obsidian)   │  facts   │ (source of  │
                                │  dashboard    │          │   truth)    │
                                └───────────────┘         └─────────────┘

  Weekly / event-driven feeds also fan into the Wire ─▶ Steward:
      Scout · Headhunter · Usher · Envoy · Flagger

  Meetings (local ─▶ cloud):
      Echo (local) ─▶ transcript ─▶ Archivist (reads The Codex for context) ─▶ Steward ─▶ Vault
```

Two things to note from the map. First, **Steward fetches nothing** — it is *fed*. Every other agent sends it an event on the Wire (`{ agent, type, entity, op, payload, idempotencyKey }`) and Steward applies it; writes are serialized so two agents firing at once can't corrupt the Obsidian files. Second, **The Codex** is read-only: **Quill**, **Envoy**, and **Archivist** read it for personal facts and work context, but nobody writes it except through an explicit "update my profile" flow.

Full data-flow diagrams, dependency rules, and the Steward write contract are in [02-architecture.md](02-architecture.md). The complete clock — what fires at 07:45, 08:00, 08:15, 08:20, 08:30, 21:00, Mon 09:00, Fri 16:00, and the concurrency rules — is in [03-scheduling.md](03-scheduling.md).

---

## Is this a good idea? (the honest teaser)

Short answer: **yes for the read-only half, with eyes open on the rest.**

The parts of Atlas that **read, summarize, label, and plan** — Filer, Herald, Forge, Sundial, Compass, Scout, Headhunter, the dashboard — are low-risk and high-value. They never destroy anything (pillar 2) and a single writer keeps the data clean (pillar 1). Start here.

The parts that touch the physical machine or the outside world are where the real risk lives:

- **Echo** — OS audio capture raises consent and privacy questions.
- **Quill** — needs screen/accessibility access.
- **Usher** — captcha, payments, and site ToS when it auto-registers.
- **Envoy** — public posts are irreversible.

The strategy throughout is the same: **start read-only, then add write actions one at a time behind confirmation gates.** The candid feasibility note, phase-by-phase build order, and the full "is this a good idea" discussion live in [../docs/12-roadmap.md](12-roadmap.md).

---

## Where to go next

- **[01-agent-roster.md](01-agent-roster.md)** — the canonical 16-agent table, plus value vs. build-order rankings.
- **[02-architecture.md](02-architecture.md)** — pipelines, dependency rules, the Wire, and the Steward write contract.
- **[03-scheduling.md](03-scheduling.md)** — the full cron schedule and concurrency rules.
- **[12-roadmap.md](12-roadmap.md)** — phased build order and the honest feasibility assessment.
