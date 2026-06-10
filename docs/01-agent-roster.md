# 01 — Agent Roster & Importance

> **Purpose:** The canonical list of every Atlas agent (SPEC §2), plus the two importance
> orderings the owner asked for — **value ranking** (impact if it works) and **build order**
> (dependencies + difficulty) — with a one-line *why* for each agent's placement.

This doc answers "number the agents by importance" and gives you the whole-system mental model.
For data flow see [architecture](02-architecture.md); for when each runs see [scheduling](03-scheduling.md).

---

## At a glance

| | |
|---|---|
| **Total agents** | 17 (Atlas + 16 sub-agents, `#0`–`#16`) |
| **Always-on** | [Atlas](agents/atlas.md) (orchestrator) |
| **Local (not Cloudflare)** | [Echo](agents/echo.md) (audio), [Quill](agents/quill.md) (screen) |
| **Sole Vault writer** | [Steward](agents/steward.md) — fed by the Wire, fetches nothing |
| **Foundational (infra, not features)** | [Atlas](agents/atlas.md), [Steward](agents/steward.md), [The Codex](07-source-of-truth-codex.md) |
| **Core daily loop** | Filer → Herald → Forge → Sundial → Compass (strictly sequential) |
| **Outward-facing / gated** | [Usher](agents/usher.md), [Envoy](agents/envoy.md) (irreversible actions) |
| **Two-mode single agent** | [Herald](agents/herald.md) — `daily` (08:00) + `weekly` (Fri 16:00) |

---

## 1. The agent roster (canonical — SPEC §2)

Every codename links to its agent doc under [`agents/`](agents/). Codenames are authoritative;
the plain-English role is in parentheses.

| # | Codename | Role | Runtime | Trigger | Writes to |
|---|----------|------|---------|---------|-----------|
| 0 | [**Atlas**](agents/atlas.md) | Root orchestrator / supervisor | Cloud | always-on | the Wire, schedules |
| 1 | [**Herald**](agents/herald.md) | Email digest (daily + weekly modes) | Cloud | cron 08:00 daily, Fri | Vault (via Steward), draft to owner |
| 2 | [**Filer**](agents/filer.md) | Email labeler / tagger (never archives/deletes) | Cloud | Gmail push + pre-Herald | Gmail labels only |
| 3 | [**Forge**](agents/forge.md) | Task & subtask extractor (with deadlines) | Cloud | after Herald + on-demand | task store, Steward |
| 4 | [**Sundial**](agents/sundial.md) | Task → Google Calendar sync | Cloud | after Forge | Google Calendar, Steward |
| 5 | [**Compass**](agents/compass.md) | Daily planner (tasks + calendar → day plan) | Cloud | cron 08:30 + 21:00 | Vault (via Steward) |
| 6 | [**Scout**](agents/scout.md) | Event discovery & weekly events digest | Cloud | cron Fri 16:00 | Vault (via Steward) |
| 7 | [**Usher**](agents/usher.md) | Event search + registration + calendar add | Cloud + browser | on-demand | Google Calendar, Steward |
| 8 | [**Headhunter**](agents/headhunter.md) | Job-board & hiring-window tracker | Cloud | cron Mon 09:00 + daily-light | Forge (tasks), Steward |
| 9 | [**Echo**](agents/echo.md) | Audio capture (all I/O devices) → transcripts | **Local** | meeting/audio active | transcript store |
| 10 | [**Archivist**](agents/archivist.md) | Meeting-notes organizer (structured, context-aware) | Cloud | after Echo | Vault (via Steward) |
| 11 | [**Steward**](agents/steward.md) | Dashboard manager (Obsidian) — sole Vault writer | Cloud | called by other agents only | The Vault |
| 12 | [**Quill**](agents/quill.md) | Screen-aware form autofill from the Codex | **Local** | hotkey / on-demand | active document (local) |
| 13 | [**Envoy**](agents/envoy.md) | Personal-brand sync (LinkedIn, X, GitHub, portfolio) | Cloud + browser | on-demand | external profiles, Steward |
| 14 | [**Switchboard**](agents/switchboard.md) | Capability router — picks the right MCP/tools for a prompt | **Design-time only** — NOT a deployed Worker (D-07) | on-demand (design time) | recommendations only |
| 15 | [**Flagger**](agents/flagger.md) | Incident/issue flagging with severity + trust score | Cloud | event-driven (all agents) | Vault (via Steward) |
| 16 | [**Librarian**](agents/librarian.md) | Prompt library (save prompt → title + deep link) | Cloud | on-demand | Vault (via Steward) |

### The Herald decision — one agent, two modes

The owner asked for "a morning email agent" **and** "a Friday email agent." These are **not two
agents** — they are the *same* agent, [**Herald**](agents/herald.md), running in two **modes** on
two cron triggers:

- `daily` mode — cron **08:00 daily**, after the [Filer](agents/filer.md) pre-sweep. The thing the owner sees every morning.
- `weekly` mode — cron **Fri 16:00**, in parallel with [Scout](agents/scout.md). A week-in-review pass.

One prompt, one codebase, one deployment — DRY. Both modes are documented in
[`agents/herald.md`](agents/herald.md). Do not split this into two agents.

---

## 2. Foundational vs feature — read this first

Three things are **infrastructure, not features**. They sit **above** the value ranking entirely,
because nothing else can run without them. Ranking them "1, 2, 3" against features would be a
category error — they're the table the features sit on.

| Foundational piece | Why it's infra, not a feature |
|--------------------|-------------------------------|
| [**Atlas**](agents/atlas.md) (`#0`) | The orchestrator. Owns the Wire, schedules, routing, supervision. Without it there is no fleet — just disconnected scripts. |
| [**Steward**](agents/steward.md) (`#11`) | The **single writer** to The Vault. Every other agent *feeds* it events; it serializes them. Without it, dashboard writes race and counters double-count. |
| [**The Codex**](07-source-of-truth-codex.md) | The source-of-truth profile doc. Read by Quill, Envoy, Archivist. Not an agent — the data spine they all read from. |

> Steward appears in the value ranking too (Tier 1, see below) because its *output* — the
> dashboard — is high daily value. But you build it as spine in **Phase 0**, before any feature.

Build these first. See [roadmap](12-roadmap.md) Phase 0 — "Spine."

---

## 3. Ordering (a): Value ranking — impact if it works

This is "which agents matter most to my day," not "which to build first." Foundational infra is
listed above and excluded here (except Steward, whose dashboard *value* lands in Tier 1).

### Tier 1 — highest daily value (the core loop)

| Rank | Agent | Why it ranks here |
|------|-------|-------------------|
| 1 | [**Herald**](agents/herald.md) | The flagship. It's the thing the owner sees every morning — the system's daily face. |
| 2 | [**Filer**](agents/filer.md) | Makes Herald possible; the labels are the substrate the digest reads. No good labels → no good digest. |
| 3 | [**Forge**](agents/forge.md) | Turns information into action by extracting tasks. Without it the system only *informs*, never *acts*. |
| 4 | [**Compass**](agents/compass.md) | The "what do I actually do today" synthesizer — merges tasks + calendar into a day plan. |
| 5 | [**Sundial**](agents/sundial.md) | Puts deadlines where they can't be ignored (the calendar), so tasks don't rot in a list. |
| 6 | [**Steward**](agents/steward.md) | Foundational, but its *value* shows here: it is the dashboard the owner glances at. |

### Tier 2 — high value, weekly cadence

| Rank | Agent | Why it ranks here |
|------|-------|-------------------|
| 7 | [**Scout**](agents/scout.md) | The weekly events digest — high value, but cadence is weekly, not daily. |
| 8 | [**Headhunter**](agents/headhunter.md) | Tracks job deadlines & hiring windows; feeds Forge "apply by X" tasks. Weekly-full + daily-light. |
| 9 | [**Flagger**](agents/flagger.md) | Reliability backbone. Low value on day one, but matters more and more as the fleet grows. |

### Tier 3 — high value, technically harder (local capture / screen)

| Rank | Agent | Why it ranks here |
|------|-------|-------------------|
| 10 | [**Echo**](agents/echo.md) | Local audio capture → transcripts. Genuinely useful, but it's a **local daemon** with OS-audio/consent complexity. |
| 11 | [**Archivist**](agents/archivist.md) | Structured meeting notes — only as good as Echo's transcript, so it ranks just behind it. |
| 12 | [**Quill**](agents/quill.md) | Screen-aware autofill from the Codex. High convenience, but needs **local** screen access. |

### Tier 4 — outward-facing / irreversible / convenience (gate hardest)

| Rank | Agent | Why it ranks here |
|------|-------|-------------------|
| 13 | [**Usher**](agents/usher.md) | Auto-registration. Real value, but carries captcha/payment/ToS risk — irreversible, so it ranks low and gates hard. |
| 14 | [**Envoy**](agents/envoy.md) | Brand sync. Public posts are **irreversible**; mistakes are visible to the world. Build last, gate hardest. |
| 15 | [**Librarian**](agents/librarian.md) | Prompt library — pure convenience. Nice to have, never on the critical path. |
| 16 | [**Switchboard**](agents/switchboard.md) | Meta/capability router. A force-multiplier at *design time*, but it never runs in the live loop. |

---

## 4. Ordering (b): Build order — dependencies + difficulty

Value tells you what to *want*; build order tells you what's *possible* next, given what exists and
what's hard. This mirrors the [roadmap](12-roadmap.md) phases.

```
Phase 0  SPINE (foundational infra — build before any feature)
         Atlas ─┬─ Steward ─┬─ The Codex
                │           │
                └─ the Wire ┴─ Cloudflare project + Google/GitHub OAuth

Phase 1  CORE LOOP (the morning pipeline — strictly sequential)
         Filer ─▶ Herald ─▶ Forge ─▶ Sundial ─▶ Compass

Phase 2  WEEKLY VALUE
         Scout · Headhunter · Flagger

Phase 3  CAPTURE (local + structured notes)
         Echo (local daemon) ─▶ Archivist · Quill

Phase 4  OUTWARD (gated, irreversible)
         Usher · Envoy

Phase 5  META / POLISH
         Switchboard · Librarian · dashboard refinement
```

| Build step | Agent(s) | Why it's built here (deps + difficulty) |
|------------|----------|------------------------------------------|
| **P0** | [Atlas](agents/atlas.md), [Steward](agents/steward.md), [The Codex](07-source-of-truth-codex.md), the Wire | Nothing else can route, write, or read facts without these. Pure infra. |
| **P1.1** | [Filer](agents/filer.md) | First feature: labels are the substrate. Runs **before** Herald, so it's built first in the loop. |
| **P1.2** | [Herald](agents/herald.md) | Reads Filer's labels to produce the digest. Can't be built before labels exist. |
| **P1.3** | [Forge](agents/forge.md) | Extracts tasks from Herald's `① Action Required` output. Depends on parsed input. |
| **P1.4** | [Sundial](agents/sundial.md) | Depends on **Forge** (needs tasks-with-deadlines to sync to calendar). |
| **P1.5** | [Compass](agents/compass.md) | Depends on **Forge** (tasks) + calendar (events from Sundial/Usher). Last in the chain. |
| **P2** | [Scout](agents/scout.md), [Headhunter](agents/headhunter.md), [Flagger](agents/flagger.md) | Independent weekly sources + reliability. Headhunter feeds Forge; build after the loop exists. |
| **P3** | [Echo](agents/echo.md), [Archivist](agents/archivist.md), [Quill](agents/quill.md) | Hardest infra: **local daemon**, OS audio/screen access. Archivist depends on Echo's transcript + the Codex. |
| **P4** | [Usher](agents/usher.md), [Envoy](agents/envoy.md) | Outward, irreversible (captcha/payment/public posts). Build last so confirmation gates are mature. |
| **P5** | [Switchboard](agents/switchboard.md), [Librarian](agents/librarian.md) | Meta + convenience. No critical-path dependency; polish at the end. |

### Why value order ≠ build order

The two lists differ on purpose:

- **Filer ranks #2 in value but is built first in the loop** — Herald (the #1 value agent) literally
  *cannot exist* without Filer's labels. Dependency beats value.
- **Flagger is mid-value (#9) but built in Phase 2**, before the higher-difficulty capture tier —
  it's cheap to stand up and pays off more as the fleet grows.
- **Echo/Quill are high value but built in Phase 3** — they're the hard part (local OS access), so
  they wait until the cloud spine and core loop are stable.

---

## 5. Cross-references

- **Data flow & dependency rules:** [02-architecture.md](02-architecture.md)
- **Full schedule & concurrency rules:** [03-scheduling.md](03-scheduling.md)
- **Email labels (Filer's substrate):** [04-email-taxonomy.md](04-email-taxonomy.md)
- **The Vault / dashboard (Steward's output):** [05-dashboard.md](05-dashboard.md)
- **The Codex (source of truth):** [07-source-of-truth-codex.md](07-source-of-truth-codex.md)
- **Hosting (Cloudflare + MCP, cloud-vs-local split):** [06-hosting-cloudflare-mcp.md](06-hosting-cloudflare-mcp.md)
- **Phased build plan:** [12-roadmap.md](12-roadmap.md)
- **Per-agent detail:** [`agents/`](agents/) — one doc per codename above.
