# Atlas — Roadmap & Feasibility

**Purpose:** the order in which Atlas gets built (6 phases, 0–5), *why* that order, the hard dependencies between phases, an honest effort/risk read on each, and a candid verdict on what is worth building versus what should be gated or deferred. Ends with the recommended MVP and the success metrics that say it works.

## At a glance

| | |
|---|---|
| **Phases** | 0 Spine · 1 Core loop · 2 Weekly value · 3 Capture · 4 Outward (gated) · 5 Meta/polish |
| **MVP** | Morning pipeline (**Filer → Herald → Forge → Sundial → Compass**) + **Steward** dashboard |
| **Build-first (infra)** | **Atlas**, **Steward**, **The Codex**, the **Wire** — not "features," they sit above the value ranking |
| **Clearly worth building** | read / label / summarize / plan / track — the entire core loop and weekly value |
| **High-risk, gate or defer** | **Echo** (audio consent/OS), **Quill** (screen access), **Usher** (captcha/payment/ToS), **Envoy** (irreversible public posts) |
| **Verdict** | Yes — *as a read-only, suggest-don't-destroy system.* Start read-only, add write actions behind confirmation gates. |
| **Source** | SPEC-CANON [§13](SPEC-CANON.md) (build order), [§3](SPEC-CANON.md) (importance tiers), [§4](SPEC-CANON.md) (dependencies), [§10](03-scheduling.md) (schedule) |

Cross-links: [agent roster](01-agent-roster.md) · [architecture](02-architecture.md) · [scheduling](03-scheduling.md) · [email taxonomy](04-email-taxonomy.md) · [hosting](06-hosting-cloudflare-mcp.md) · [the Codex](07-source-of-truth-codex.md) · [Flagger](08-flagger.md) · [security & privacy](11-security-privacy.md)

---

## The order at a glance

```
Phase 0  SPINE              Atlas · the Wire · Steward · The Vault · The Codex · CF + OAuth
   │     (infrastructure — nothing observable yet, everything depends on it)
   ▼
Phase 1  CORE LOOP          Filer ─▶ Herald ─▶ Forge ─▶ Sundial ─▶ Compass     ◀── THE MVP
   │     (the morning pipeline — the thing the owner sees every day)
   ▼
Phase 2  WEEKLY VALUE       Scout · Headhunter · Flagger
   │     (weekly cadence + reliability; Flagger matters more as the fleet grows)
   ▼
Phase 3  CAPTURE  (local)   Echo ─▶ Archivist · Quill
   │     (first local daemon — audio + screen; harder, riskier)
   ▼
Phase 4  OUTWARD  (gated)   Usher · Envoy
   │     (irreversible / outward-facing — build last, gate hardest)
   ▼
Phase 5  META / POLISH      Switchboard · Librarian · dashboard refinement
         (force-multipliers and convenience, off the critical path)
```

**Why this order, in one line each:** infrastructure before features (0); the daily loop is the flagship and where 80% of the value lives (1); weekly agents reuse the loop's plumbing and Flagger hardens it (2); local capture needs a whole new runtime so it waits until cloud is solid (3); outward/irreversible actions are gated and come only after everything read-only is trustworthy (4); meta and convenience polish last (5).

---

## Phase 0 — Spine

**Build:** **Atlas** (root orchestrator), the **Wire** (Cloudflare Queue), **Steward** (sole Vault writer) + **The Vault** (Obsidian), **The Codex** (source of truth), the Cloudflare project itself, and Google + GitHub OAuth.

**Why first.** Per [§3](SPEC-CANON.md), these are *foundational infrastructure, not features* — they sit above the value ranking because nothing else can run without them. Every other agent either routes through Atlas, writes through Steward, or reads the Codex. Building any Tier-1 agent before the spine means building it twice.

**What "done" looks like.**
- Atlas can schedule a no-op agent and route a message onto the Wire.
- Steward consumes one Wire event and applies it to the Vault following the §6.4 write contract: `{ agent, type, entity, op, payload, idempotencyKey }`, serialized single-consumer, `increment` is idempotent on replay.
- The Codex exists with the §11 sections (identity, education, work, skills, projects, bios, socials) and is read-only to agents except the explicit "update my profile" flow.
- OAuth round-trips for Google (least-privilege scopes) and GitHub (GitHub App) succeed; tokens live in Cloudflare Secrets Store, never in the Vault or Codex.

| | |
|---|---|
| **Depends on** | Nothing (greenfield) |
| **Unlocks** | Everything |
| **Effort** | High — most plumbing, least visible payoff |
| **Risk** | Medium — config-heavy (OAuth scopes, DO lifecycle, Queue back-pressure, Obsidian MCP bridge), but no irreversible actions |
| **Watch out for** | The Obsidian bridge is the one *local* dependency in an otherwise-cloud phase — the Vault lives on the machine ([§7](06-hosting-cloudflare-mcp.md)). Get Steward's serialization and idempotency right *now*; retrofitting it after counters exist means reconciling double-counts. |

> Phase 0 ships zero user-visible features. Resist the urge to skip the idempotency/serialization work to "see something." That work is the whole point of the spine.

---

## Phase 1 — Core loop (the MVP)

**Build the morning pipeline, in dependency order:** **Filer** (label) → **Herald** (digest) → **Forge** (tasks) → **Sundial** (calendar) → **Compass** (day plan). All feed **Steward** → the Vault.

```
Gmail push ─▶ Filer ─▶ Herald ─▶ Forge ─▶ Sundial ─▶ Compass
                 │        │         │         │          │
                 └────────┴─────────┴─────────┴──────────┘
                                    ▼
                                 Steward ─▶ The Vault
```

**Why second, and why this internal order.** This is the flagship — Herald is "the thing the owner sees every morning" ([§3](SPEC-CANON.md)). The internal order is forced by data dependencies ([§4](SPEC-CANON.md)):
- **Filer runs before Herald** — labels are the substrate; the digest reads labels.
- **Forge depends on parsed input** (Herald's `① Action Required` set).
- **Sundial depends on Forge** — only tasks-with-deadlines reach the calendar.
- **Compass depends on Forge + Calendar** — it needs tasks *and* a settled calendar (from Sundial).

The schedule that realizes this is the strictly-sequential morning chain in [§10](03-scheduling.md): Filer sweep 07:45 → Herald 08:00 → Forge 08:15 → Sundial 08:20 → Compass 08:30, plus Compass 21:00 preview. "Sequential" = start-after-success; a failure upstream stops the chain rather than feeding garbage downstream.

**What "done" looks like.** A real 08:00 digest lands as a draft to the owner; `① Action Required` threads become Forge tasks with deadlines; deadline tasks appear on Google Calendar; the Vault **Today** view shows Compass's top-3 priorities and the morning-glance set ([§6.3](SPEC-CANON.md)): action-required emails, deadlines next 7 days, today's meetings, open flags, waiting-on.

| | |
|---|---|
| **Depends on** | Phase 0 (all of it) |
| **Unlocks** | The MVP; the plumbing every later agent reuses (Wire events, Steward writes, task store) |
| **Effort** | High — five agents, but they share one pattern and Filer is a cheap high-volume Haiku pass |
| **Risk** | Low–medium — read/label/summarize only; the one careful surface is Gmail labelling ([§5.8](04-email-taxonomy.md)) |
| **Watch out for** | **Filer never archives/deletes — labels only.** Skip threads already carrying `AI/Reviewed` (idempotency); no contradictory labels; **never reproduce 2FA codes / reset links** from `Type/Security` or `⚠ Phishing-Suspect` in the digest; batch + back off against Gmail rate limits. |

> Once Phase 1 is live the system already pays for itself. Everything after is additive.

---

## Phase 2 — Weekly value

**Build:** **Scout** (events digest, cron Fri 16:00), **Headhunter** (job-board + hiring-window tracker, Mon 09:00 full + daily-light 09:00), **Flagger** (incident flagging, event-driven).

**Why third.** These reuse Phase 1's plumbing rather than inventing new runtime: Headhunter *feeds Forge* ("apply by X" tasks) and Steward (pipeline counts); Scout fans into Steward; Flagger receives error/incident events from *every* agent — so it's worth building once the fleet is big enough to need it (per [§3](SPEC-CANON.md), Flagger "matters more as the fleet grows"). On Friday 16:00, Scout and weekly-Herald run **in parallel** (independent sources), then both fan into Steward, and Steward compiles the weekly-review build at 16:30 ([§10](03-scheduling.md)).

**What "done" looks like.** Friday events digest + weekly email review land; Headhunter creates "apply by X" tasks and updates the job-pipeline kanban counts (applied → OA → interview → offer/reject, [§6.1](SPEC-CANON.md)); Flagger routes P1/P2 to push notifications immediately and batches P3/P4 into the dashboard feed, with the Vault Flagger board sorted by severity then trust ([§8](08-flagger.md)).

| | |
|---|---|
| **Depends on** | Phase 1 (Forge for Headhunter's tasks; Steward fan-in; the parallel-Friday concurrency model) |
| **Unlocks** | Weekly review; reliability/observability for everything that follows |
| **Effort** | Medium — Scout/Headhunter are scrapers + LLM passes; Flagger is mostly schema + routing |
| **Risk** | Low — still read/track only; Headhunter scraping is brittle (boards change markup) but non-destructive |
| **Watch out for** | Flagger must **self-monitor** — flag its own staleness / the heartbeat going stale ([§8](08-flagger.md)). Headhunter's hiring-window detection is the load-bearing claim; wrong dates here mean missed deadlines, so route low-confidence finds to a flag, not silently to a task. |

---

## Phase 3 — Capture (first local runtime)

**Build:** **Echo** (audio capture, all I/O devices → transcripts, **local**) → **Archivist** (structured meeting notes, cloud); and **Quill** (screen-aware form autofill from the Codex, **local**).

**Why fourth.** This is the first time Atlas leaves Cloudflare. Echo and Quill *can't* run on Workers — they need the physical machine (audio devices, screen) and live in a **local macOS daemon** (menubar / launchd) that authenticates to the cloud ([§7](06-hosting-cloudflare-mcp.md)). That's a whole new runtime, packaging, update, and trust surface, so it waits until the cloud system is proven. Echo also adds a Durable Object + WebSocket live stream — the one always-on, real-time path. Archivist depends on Echo's transcript **and** the Codex (work context, past meetings) per [§4](SPEC-CANON.md); Echo runs **in parallel** with everything ([§10](03-scheduling.md)).

```
Echo (local daemon, real-time) ─▶ transcript ─▶ Archivist (cloud) ─▶ Steward ─▶ Vault
                                                      ▲
                                                 The Codex (work context)
```

| | |
|---|---|
| **Depends on** | Phase 0 (Codex, Steward) + a working cloud system to authenticate the daemon into |
| **Unlocks** | Meeting capture + notes index; the autofill convenience |
| **Effort** | High — new runtime (macOS daemon), audio plumbing, OS permissions, live WebSocket stream |
| **Risk** | **High** — this is where "is this a good idea?" gets real (see verdict below) |
| **Watch out for** | **Consent & privacy.** Echo captures *all* audio I/O — two-party-consent jurisdictions, who-is-in-the-room, and OS audio capture are genuinely hard. Quill has screen access. Per [§12](11-security-privacy.md), Echo audio and Quill screen **never leave the device except as derived artifacts the owner approves**. Build the daemon with that boundary first, features second. |

---

## Phase 4 — Outward (gated, build last)

**Build:** **Usher** (event search + registration + calendar add, cloud + browser) and **Envoy** (personal-brand sync to LinkedIn / X / GitHub / portfolio, cloud + browser).

**Why fifth.** These are the only agents that take **irreversible, outward-facing** actions — registering, paying, posting publicly. Per the design pillar "suggest, don't destroy," and [§12](11-security-privacy.md), every irreversible/outward action sits behind a **confirmation gate** with default = *draft + ask*. They come last not because they're low-value but because they're the highest-blast-radius, and you only want them firing once every read-only agent is trustworthy enough that the owner believes a gate when it asks. Both are on-demand ([§10](03-scheduling.md)); Usher feeds Calendar + Steward (events attended++), Envoy feeds Steward (projects/experience counts) and reads the Codex ([§4](SPEC-CANON.md)).

| | |
|---|---|
| **Depends on** | Phase 0 (Codex for Envoy), Phase 1 (Calendar/Steward), and a mature confirmation-gate UX |
| **Unlocks** | Auto-registration; brand publishing |
| **Effort** | Medium–high — browser automation is fragile; the gate UX is the real work |
| **Risk** | **High / highest** — captcha, payments, ToS (Usher); irreversible public posts (Envoy) |
| **Watch out for** | A public post can't be un-posted and a payment can't be un-paid. **No silent writes — ever.** Keep these strictly draft-and-confirm; treat captcha/payment as hard stops that hand back to the human. |

---

## Phase 5 — Meta / polish

**Build:** **Switchboard** (capability router — picks the right MCP/tools for a prompt, consulted at *design time*), **Librarian** (prompt library: save prompt → title + deep link), and general dashboard refinement.

**Why last.** Switchboard is a force-multiplier but explicitly **not on the critical path** — it's consulted when a new capability is needed, it "doesn't run in the loop" ([§4](SPEC-CANON.md)). Librarian is pure convenience. Neither blocks anything, so they polish the system rather than power it. Librarian writes the Vault prompt-library table (Title link · Tags · Tool · Last used) per [§9](09-prompt-library.md).

| | |
|---|---|
| **Depends on** | A working fleet to route for / capture prompts from |
| **Unlocks** | Faster future development (Switchboard); prompt reuse (Librarian) |
| **Effort** | Low–medium |
| **Risk** | Low — recommendations and a notes table; nothing destructive |

---

## Dependency map (what blocks what)

```
Phase 0 ─────────────────────────────────────────────┐
  Atlas · Wire · Steward+Vault · Codex · OAuth        │ (everything below needs this)
     │                                                │
     ├──▶ Phase 1  Filer→Herald→Forge→Sundial→Compass │
     │        │                                       │
     │        ├──▶ Phase 2  Scout · Headhunter(↳Forge) · Flagger(↤all)
     │        │
     │        └──▶ Phase 4  Usher(↳Cal,Steward) · Envoy(↳Steward, ↤Codex)
     │
     └──▶ Phase 3  Echo→Archivist(↤Codex) · Quill(↤Codex)   [needs cloud proven first]
              │
              └──▶ Phase 5  Switchboard · Librarian · polish
```

Hard edges (cannot reorder): Filer **before** Herald · Forge **before** Sundial · Forge + Calendar **before** Compass · Echo **before** Archivist · Headhunter **into** Forge. Soft edges (sequencing choice, not data): Phase 2 before Phase 3 (cloud-before-local), Phase 4 last (gate maturity).

---

## Is this a good idea? — the honest verdict

**Yes — as a read-only, "suggest-don't-destroy" system. The risk lives entirely in the four write-the-outside-world agents, and the build order already quarantines them to the end.**

### Clearly worth building (low risk, high daily value)

The entire **read / label / summarize / plan / track** surface — Phases 0–2. None of it touches anything irreversible:

| Capability | Agents | Why it's safe |
|---|---|---|
| **Read & label** email | Filer | Labels only — never archives/deletes ([§5.8](04-email-taxonomy.md)); `gmail.modify` scope, not delete ([§12](11-security-privacy.md)) |
| **Summarize** | Herald | Produces a *draft* digest to the owner |
| **Plan** the day | Compass | Writes a Vault view; suggests, doesn't act |
| **Track** tasks/jobs/events | Forge, Sundial, Scout, Headhunter | Creates tasks + calendar entries the owner owns; counters are idempotent |
| **Observe** | Flagger, Steward | Pure observation + serialized dashboard writes |

This is the part that pays for itself every morning with effectively no blast radius.

### High-risk — gate hard or defer (Phases 3–4)

| Agent | The real risk | Disposition |
|---|---|---|
| **Echo** | OS audio capture; **consent** (two-party-consent law); recording people who didn't agree | **Gate.** Local-only; explicit per-meeting consent; transcripts are derived artifacts the owner approves before they leave the device ([§12](11-security-privacy.md)). Defer until the cloud loop is solid. |
| **Quill** | Full screen access; could autofill into the wrong field / wrong site | **Gate.** Local-only; hotkey-triggered, never autonomous; never writes the Codex back. |
| **Usher** | Captcha, **payments**, sites' ToS on automation | **Defer to Phase 4 + hard gate.** Draft-and-confirm; captcha/payment = stop and hand to human. |
| **Envoy** | **Irreversible public posts** to LinkedIn / X | **Defer to Phase 4 + hard gate.** Default draft + ask; a post can't be un-posted. |

The throughline: every one of these is fine *as a draft-and-confirm tool* and dangerous *as an autonomous one*. The roadmap's job is to make sure they only ever ship in the first mode — which is exactly why they're last, behind a confirmation-gate UX that's already proven on lower-stakes actions.

### Recommended MVP

> **The morning pipeline — Filer → Herald → Forge → Sundial → Compass — plus the Steward dashboard.** (Phase 0 + Phase 1.)

It is the highest-value, lowest-risk slice; it exercises the full spine (orchestration, the Wire, Steward writes, OAuth, the Vault) so nothing is throwaway; and it delivers the flagship the owner asked for — the morning digest and day plan — with zero irreversible actions. Ship this, live on it, *then* decide whether the local-capture and outward phases are worth their risk.

---

## Success metrics

Measured on the MVP first, then tracked as the fleet grows. These are the numbers that say "it works":

**The headline three**
- **Minutes saved/day** — target **≥ 20 min/day** of triage + planning replaced by the 08:00 digest and Compass plan. (Baseline: time the owner currently spends on inbox + day-planning for one week before launch.)
- **% action-required emails caught** — of threads that genuinely needed action, the share Filer tagged `① Action Required` and Forge turned into a task. Target **≥ 95%**; misses are the metric that matters most.
- **Deadlines missed = 0** — every Forge/Headhunter "due by X" that reaches Sundial and the calendar. This is a hard zero; one miss is a P-level Flagger incident.

**Supporting metrics**

| Metric | Source | Target |
|---|---|---|
| Digest accuracy (no hallucinated / mis-prioritized items) | Herald | ≥ 95% items correct on owner spot-check |
| False-positive `① Action Required` rate | Filer | ≤ 10% (don't cry wolf) |
| Tasks needing manual correction after Forge | Forge | ≤ 1 / day |
| Pipeline freshness — Vault counters match reality | Steward | 100% (idempotency invariant; any drift = a flag) |
| Morning-chain success rate (07:45–08:30 runs clean) | Atlas run-log | ≥ 99% of days |
| Flagger noise — % flags the owner acts on vs mutes | Flagger | ≥ 70% actionable |
| **Security invariant** | Filer/Herald | **Zero** 2FA codes / reset links ever surfaced in a digest ([§5.8](04-email-taxonomy.md)) |

**Gating metrics for the risky phases** — do not promote Echo/Usher/Envoy past draft-mode until:
- **Confirmation-gate adherence = 100%** — no outward action ever fires without an explicit owner confirm ([§12](11-security-privacy.md)).
- **Consent capture = 100%** for any Echo session before it records.

---

## Open questions

- **Effort estimates are deliberately relative (High/Medium/Low), not calendar dates** — single-owner velocity is unknown until Phase 0 ships. Re-baseline after the spine.
- **Where does the "minutes saved" baseline come from?** Needs a one-week manual measurement *before* launch, or the headline metric is unfalsifiable.
- **Quill's phase placement** — it's grouped in Phase 3 with Echo as the local-runtime work, but it has no Echo dependency. It could slip earlier (right after the daemon exists) or later (it's convenience). Owner's call.
- **Is Phase 5's Switchboard worth building at all**, or is it a design-time habit (consult ad hoc) rather than a coded agent? Revisit once the fleet is large enough to feel the routing pain.
