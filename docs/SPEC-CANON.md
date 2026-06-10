# Atlas — Canonical Design Spec (SPEC-CANON)

> **Status:** Authoritative reference. Every other README in this repo is written *from* this file.
> If two docs disagree, this file wins. Writers: read this whole file before drafting your doc,
> and reuse the exact names, codenames, schedules, label strings, and field names defined here.

---

## 0. What Atlas is

**Atlas** is a personal **orchestrator** that runs a fleet of specialized sub-agents to manage the
owner's (Daniel Chahine's) digital life: email triage, task creation, calendar, events, job hunting,
meeting capture, a personal Obsidian dashboard, screen autofill, and cross-platform personal-brand
publishing. Atlas itself does almost no domain work — it **schedules, routes, sequences, and
supervises** the sub-agents and owns the shared event bus and state.

Design pillars:

1. **One writer per resource.** Exactly one agent is allowed to mutate any given external system.
   The dashboard has a single writer (**Steward**). This prevents races and double-counting.
2. **Suggest, don't destroy.** Agents label, draft, and recommend. Anything destructive or
   outward-facing (delete, post, register, pay) is gated behind explicit human confirmation.
3. **Cloud by default, local when it must be.** Most agents run on Cloudflare. Two agents need
   the physical machine (audio, screen) and run as a local daemon that talks to the cloud.
4. **Single source of truth.** Personal facts live in **The Codex**; dashboard state lives in
   **The Vault** (Obsidian). Agents read the Codex; only Steward writes the Vault.
5. **Idempotent + observable.** Every run is safe to repeat, and every notable event/failure is
   reported to **Flagger**.

---

## 1. Naming conventions

- **System:** Atlas
- **Source-of-truth profile doc:** **The Codex** (`codex.md` in the Vault / a Google Doc)
- **Obsidian vault / dashboard:** **The Vault**
- **Event bus:** the **Wire** (Cloudflare Queue)
- Each sub-agent has a **codename** + a plain-English role. Always use the codename in headers and
  cross-links, with the role in parentheses on first mention, e.g. **Herald** (email digest).
- Cross-doc links use relative paths, e.g. `[Steward](agents/steward.md)`,
  `[scheduling](03-scheduling.md)`.
- Email label strings are **literal** — copy them exactly from §5.

---

## 2. The agent roster (canonical list)

| # | Codename | Role | Runtime | Trigger | Writes to |
|---|----------|------|---------|---------|-----------|
| 0 | **Atlas** | Root orchestrator / supervisor | Cloud | always-on | the Wire, schedules |
| 1 | **Herald** | Email digest (daily + weekly modes) | Cloud | cron 08:00 daily, Fri | Vault (via Steward), draft to owner |
| 2 | **Filer** | Email labeler / tagger (never archives/deletes) | Cloud | Gmail push + pre-Herald | Gmail labels only |
| 3 | **Forge** | Task & subtask extractor (with deadlines) | Cloud | after Herald + on-demand | task store, Steward |
| 4 | **Sundial** | Task → Google Calendar sync | Cloud | after Forge | Google Calendar, Steward |
| 5 | **Compass** | Daily planner (tasks + calendar → day plan) | Cloud | cron 08:30 + 21:00 | Vault (via Steward) |
| 6 | **Scout** | Event discovery & weekly events digest | Cloud | cron Fri 16:00 | Vault (via Steward) |
| 7 | **Usher** | Event search + registration + calendar add | Cloud + browser | on-demand | Google Calendar, Steward |
| 8 | **Headhunter** | Job-board & hiring-window tracker | Cloud | cron Mon 09:00 + daily-light | Forge (tasks), Steward |
| 9 | **Echo** | Audio capture (all I/O devices) → transcripts | **Local** | meeting/audio active | transcript store |
| 10 | **Archivist** | Meeting-notes organizer (structured, context-aware) | Cloud | after Echo | Vault (via Steward) |
| 11 | **Steward** | Dashboard manager (Obsidian) — sole Vault writer | Cloud | called by other agents only | The Vault |
| 12 | **Quill** | Screen-aware form autofill from the Codex | **Local** | hotkey / on-demand | active document (local) |
| 13 | **Envoy** | Personal-brand sync (LinkedIn, X, GitHub, portfolio) | Cloud + browser | on-demand | external profiles, Steward |
| 14 | **Switchboard** | Capability router — picks the right MCP/tools for a prompt | **Design-time only** — NOT a deployed Worker (D-07) | on-demand (design time) | recommendations only |
| 15 | **Flagger** | Incident/issue flagging with severity + trust score | Cloud | event-driven (all agents) | Vault (via Steward) |
| 16 | **Librarian** | Prompt library (save prompt → title + deep link) | Cloud | on-demand | Vault (via Steward) |

> **Note on Herald:** the owner asked for "a morning email agent" and "a Friday email agent." These
> are the *same* agent (**Herald**) with two run **modes** (`daily`, `weekly`) on two cron triggers —
> DRY, one prompt, one codebase. Document both modes in `agents/herald.md`.

---

## 3. Importance tiers (answers "number the agents by importance")

Two orderings matter: **value** (impact if it works) and **build order** (dependencies + difficulty).
Present both in `01-agent-roster.md`.

**Foundational (must exist for anything else to work) — build first:**
- **Atlas** (orchestrator), **Steward** (dashboard writer), **The Codex** (source of truth).
  These are infrastructure, not "features," so they sit above the value ranking.

**Tier 1 — highest daily value (the core loop):**
1. **Herald** — flagship; the thing the owner sees every morning.
2. **Filer** — makes Herald's job possible; labels are the substrate.
3. **Forge** — turns information into action (tasks).
4. **Compass** — the "what do I actually do today" synthesizer.
5. **Sundial** — puts deadlines where they can't be ignored (calendar).
6. **Steward** — (foundational, but its value shows here: the dashboard).

**Tier 2 — high value, weekly cadence:**
7. **Scout** — events digest.
8. **Headhunter** — job deadlines & hiring windows.
9. **Flagger** — reliability; matters more as the fleet grows.

**Tier 3 — high value, technically harder (local capture / screen):**
10. **Echo** — local audio capture → transcripts.
11. **Archivist** — structured meeting notes.
12. **Quill** — screen-aware autofill.

**Tier 4 — outward-facing / irreversible / convenience (build last, gate hardest):**
13. **Usher** — auto-registration (captcha/payment risk).
14. **Envoy** — brand sync (public posts are irreversible).
15. **Librarian** — prompt library (convenience).
16. **Switchboard** — meta/capability router (a force-multiplier, but not on the critical path).

---

## 4. Dependencies, data flow & the core pipelines

**The morning pipeline (sequential — each consumes the prior's output):**
```
Gmail push ─▶ Filer (label) ─▶ Herald (digest) ─▶ Forge (tasks) ─▶ Sundial (calendar) ─▶ Compass (day plan)
                                   │                    │                  │                    │
                                   └────────────────────┴──────────────────┴────────────────────┘
                                                        ▼
                                                     Steward  ──▶  The Vault (Obsidian)
```

**Event-bus / fan-in to Steward (Steward fetches NOTHING; it is fed):**
```
Usher       ─┐
Headhunter  ─┤
Scout       ─┤
Envoy       ─┤──▶  the Wire (queue) ──▶  Steward (single serialized writer) ──▶ The Vault
Forge       ─┤
Compass     ─┤
Flagger     ─┘
```

**Meetings pipeline (local → cloud):**
```
Echo (local daemon, real-time) ─▶ transcript ─▶ Archivist (cloud, after meeting) ─▶ Steward ─▶ Vault
                                                       ▲
                                                  The Codex (work context, past meetings)
```

**Dependency rules (must be stated in `02-architecture.md`):**
- **Forge** depends on parsed input (Herald, Headhunter, or manual). 
- **Sundial** depends on **Forge** (tasks with deadlines).
- **Compass** depends on **Forge** (tasks) + Google Calendar (events from Sundial/Usher).
- **Archivist** depends on **Echo** (transcript) + **The Codex** (context).
- **Headhunter** feeds **Forge** (creates "apply by X" tasks) and **Steward** (pipeline counts).
- **Usher** feeds **Google Calendar** and **Steward** (events attended++).
- **Envoy** feeds **Steward** (projects/experience counts) and reads **The Codex**.
- **Filer** runs **before** Herald (label first, then digest reads labels).
- **Steward** is fed by everyone and fetches nothing (owner's explicit requirement).
- **Flagger** receives error/incident events from every agent.
- **Switchboard** is consulted at design time when a new capability is needed; it doesn't run in the loop.

---

## 5. Email label taxonomy (answers "groups & tags + what to be careful about")

Gmail labels are **thread-level**. Use nested labels (`Parent/Child`). **Filer never archives or
deletes** — it only labels. Manual archiving/deleting stays with the owner.

### 5.1 Triage group (mutually exclusive — exactly one)
- `① Action Required` — owner must do something; usually has a deadline.
- `② Action Recommended` — should do, not mandatory.
- `③ Awaiting Reply` — owner is blocked on someone else.
- `④ FYI / Read Later` — informational, no action.
- `⑤ No Action` — safe to ignore.

### 5.2 Type group (category — can be multiple but prefer one)
- `Type/Job` → children: `Job/Application`, `Job/Recruiter`, `Job/OA` (online assessment),
  `Job/Interview`, `Job/Offer`, `Job/Rejection`.
- `Type/Events` → `Events/Invite`, `Events/Confirmed`, `Events/Reminder`.
- `Type/Finance` → `Finance/Bill`, `Finance/Receipt`, `Finance/Bank`, `Finance/Tax`, `Finance/Subscription`.
- `Type/School` → `School/Deadline`, `School/Grade`, `School/Admin`.
- `Type/Newsletter` — opted-in content digests.
- `Type/Promotion` — marketing / sales / advertisement.
- `Type/Social` — LinkedIn, X, Instagram notifications.
- `Type/Travel` — flights, hotels, itineraries.
- `Type/Dev` — GitHub, CI/CD, deploy, error alerts.
- `Type/Security` — 2FA, login alerts, password resets, account security.
- `Type/Personal` — friends, family.

### 5.3 Needs group (the specific action, drives Forge)
- `Needs/Reply`, `Needs/Pay`, `Needs/Register`, `Needs/Schedule`, `Needs/Upload`, `Needs/Sign`, `Needs/Decide`.

### 5.4 Deadline group
- `Due/Today`, `Due/ThisWeek`, `Due/Expired`.

### 5.5 Relationship group
- `From/VIP` — auto-bump triage priority.
- `From/Company/<Name>` — e.g. `From/Company/Shopify`, `From/Company/Amazon`.
- `From/Automated` — no-reply / system senders.

### 5.6 Suggestion group (Filer's recommendation — the owner decides)
- `Suggest/Keep`, `Suggest/Delete`, `Suggest/Unsubscribe`.

### 5.7 Agent-state group (idempotency + trust)
- `AI/Reviewed` — Filer has processed this thread (skip on re-run).
- `AI/Uncertain` — low confidence; needs a human glance.
- `⚠ Phishing-Suspect` — possible phishing; never follow links, never auto-act.

### 5.8 Things to be careful about (MUST be a section in `04-email-taxonomy.md`)
- **Never auto-archive / auto-delete.** Labels only. (Owner requirement.)
- **Idempotency:** skip threads already carrying `AI/Reviewed`; never thrash labels on re-run.
- **No contradictory labels** (e.g., `Suggest/Delete` + `① Action Required`).
- **Security mail is sensitive:** never reproduce 2FA codes / reset links in any digest;
  never click links in `Type/Security` or `⚠ Phishing-Suspect`.
- **Promotion vs Newsletter vs Transactional** are different — don't lump opted-in content with ads.
- **Finance/medical privacy:** flag but don't expose details in shared/exported views.
- **Thread vs message:** labels apply to whole threads; a long thread can be mixed — label by the
  latest actionable message.
- **Reserved system labels** (`INBOX`, `SENT`, `SPAM`, `TRASH`) can't be modified.
- **Gmail API rate limits & batch** — Filer must batch and back off.
- **Color-code** each parent group for fast visual scanning.

---

## 6. Obsidian dashboard — The Vault (answers "what else to track day-to-day")

Owner already wants: today's tasks (by date), month tasks, this-week events, and counters for
events attended/participated, jobs applied, rejections, interviews. Expand with:

### 6.1 Counters / metrics
- **Jobs funnel:** applied → OA → interview → offer / rejection (+ response rate, interview rate).
- **Events:** registered / attended / upcoming.
- **Email:** unread, action-required, processed-today.
- **Tasks:** open / done-today / overdue / due-this-week / completion rate.
- **Meetings:** count this week, hours in meetings.
- **Brand:** posts shipped (X/LinkedIn), projects published, GitHub streak.
- **Habits/streaks.**

### 6.2 Views (Dataview / Bases)
- **Today** (Compass output — the day plan).
- **This Month** (tasks calendar).
- **Upcoming events (7 days).**
- **Deadline board** — jobs + events + tasks merged, sorted by date.
- **Job pipeline kanban** — applied → OA → interview → offer/reject.
- **Waiting-on list** (`③ Awaiting Reply`).
- **Weekly review** (auto Friday).
- **Meeting-notes index** (recent, linked).
- **Flagger feed** (incidents, severity, trust) — see §8.
- **Prompt library table** (title + deep link) — see §9.
- **Reading queue** (`④ FYI / Read Later`, newsletters).
- **Finances snapshot** (bills due, subscriptions).
- **People/CRM** (who you met, follow-ups).
- **Goals / OKRs** (quarterly, with progress).
- **Agent heartbeat / run log** (which agents ran, when, status).
- **Quick-capture inbox** (unsorted).

### 6.3 What to look at daily (the "morning glance")
Top-3 priorities (Compass) · action-required emails · deadlines next 7 days · today's meetings ·
open flags · waiting-on.

### 6.4 Steward write contract
- Steward is the **only** writer. Other agents send it an **event** on the Wire; Steward applies it.
- Writes are **serialized** (single consumer / lock) to avoid Obsidian file conflicts.
- Event shape: `{ agent, type, entity, op: "increment"|"upsert"|"append", payload, idempotencyKey }`.
- Counters move via `increment` with an `idempotencyKey` so a replay can't double-count.

---

## 7. Hosting: Cloudflare + MCP (for `06-hosting-cloudflare-mcp.md`)

- **Compute:** Cloudflare **Workers**; long-lived/stateful agents use **Durable Objects** (one DO
  instance per agent for state + coordination; Echo uses a DO + WebSocket for the live stream).
- **Scheduling:** Cloudflare **Cron Triggers** (the schedule in §10). Multi-step durable runs use
  **Cloudflare Workflows**.
- **Event bus / Steward serialization:** Cloudflare **Queues** (the Wire).
- **State:** **D1** (SQLite: tasks, jobs, events, run-log), **KV** (config/flags), **R2** (audio blobs,
  exports), **Durable Objects** (per-agent live state).
- **Model access:** **Workers AI** + **AI Gateway** (caching, rate-limit, observability), or call
  Anthropic via AI Gateway. Default to the latest Claude (Opus for orchestration/reasoning,
  Sonnet/Haiku for cheap high-volume passes like Filer).
- **MCP:** host agents/tools as **remote MCP servers on Workers** (Cloudflare Agents SDK). Connect:
  - **Gmail / Calendar / Drive / Sheets** via Google OAuth2 (least-privilege scopes).
  - **GitHub** via a GitHub App.
  - **Obsidian** via a local MCP bridge (the Vault lives on the local machine / synced).
- **Auth/secrets:** Workers **OAuth Provider** for inbound; **Secrets Store / Wrangler secrets** for
  Google/GitHub tokens; per-agent least privilege.
- **Local agents:** **Echo** (audio) and **Quill** (screen) can't run on Cloudflare — they run in a
  **local macOS daemon** (menubar app / launchd) that authenticates to the cloud and pushes
  transcripts/results up. State this cloud-vs-local split explicitly.

---

## 8. Flagger (for `08-flagger.md` + a Vault section)

Purpose: when anything notable goes wrong — an agent error, a dashboard inconsistency, a missed
deadline, a low-confidence action, a possible phishing email — it gets **flagged**, with a
**severity** and a **trust/confidence score** so the owner knows how much to believe it.

- **Severity:** `P1 Critical` · `P2 High` · `P3 Medium` · `P4 Low / Info`.
- **Trust score (0–100):** how confident Atlas is the flag is real & correctly diagnosed
  (e.g., a caught exception = high trust; an LLM "this looks suspicious" = lower trust).
- **Flag shape:** `{ id, ts, source_agent, severity, trust, title, detail, suggested_action, status }`.
- **Status:** `open → ack → resolved → muted`.
- **Routing:** P1/P2 → push notification immediately; P3/P4 → batched into the dashboard feed.
- **Vault section:** a "Flagger" board sorted by severity then trust, with one-line titles and a
  click-through to detail. Self-monitoring: Flagger also flags *itself* / the heartbeat going stale.

---

## 9. Prompt library / Librarian (for `09-prompt-library.md` + a Vault table)

Owner wants to save prompts during the day and see them as **short titles** with a **link** to the
full prompt on the dashboard.

- **Capture:** a quick command/hotkey ("save this prompt") → **Librarian** stores it.
- **Record shape:** `{ title (≤ 6 words), slug, tags[], tool (Claude/Canva/etc.), full_prompt,
  created, last_used, uses }`.
- **Vault table:** columns = Title (link) · Tags · Tool · Last used. The title links to a note
  holding the full prompt (deep link `obsidian://` or relative note link).
- Optional: dedupe near-identical prompts; surface "most-used" at top.

---

## 10. Scheduling (answers Q3 — for `03-scheduling.md`)

Times are owner-local. **Sequential** means start-after-success; **parallel** means concurrent.

| Time / trigger | Agent | Mode | Notes / ordering |
|----------------|-------|------|------------------|
| continuous | **Filer** | event | Gmail push as mail arrives (label in near-real-time) |
| **07:45 daily** | **Filer** | sweep | pre-Herald sweep so digest reads fresh labels |
| **08:00 daily** | **Herald** | daily | depends on Filer sweep |
| **08:15 daily** | **Forge** | morning | extracts tasks from the morning's `① Action Required` |
| **08:20 daily** | **Sundial** | sync | after Forge; deadline tasks → calendar |
| **08:30 daily** | **Compass** | plan | after Sundial; needs tasks + settled calendar |
| **21:00 daily** | **Compass** | preview | next-day preview / prep |
| **09:00 daily (light)** | **Headhunter** | deadlines | cheap daily check for imminent job deadlines |
| **Mon 09:00** | **Headhunter** | full | full board scan + hiring-window update |
| **Fri 16:00** | **Scout** | weekly | upcoming events next week/month |
| **Fri 16:00** | **Herald** | weekly | weekly email review (parallel with Scout) |
| **Fri 16:30** | weekly-review build | — | Steward compiles the weekly dashboard summary |
| event: meeting starts | **Echo** | live | calendar-aware or audio-device-active trigger (local) |
| event: meeting ends | **Archivist** | — | after Echo transcript is ready |
| on-demand | **Usher**, **Quill**, **Envoy**, **Librarian**, **Switchboard** | — | user-initiated |
| event-driven | **Steward**, **Flagger** | — | fed by other agents; never self-scheduled |

**Concurrency rules:**
- The **morning chain** (Filer→Herald→Forge→Sundial→Compass) is **strictly sequential**.
- **Friday 16:00**: Scout and weekly-Herald run **in parallel** (independent sources), then both
  fan into Steward.
- **Steward writes are serialized** regardless of how many agents fire at once (single consumer).
- **Echo** runs **in parallel** with everything (real-time, local).
- Headhunter's weekly-full and the Friday digests can overlap; they touch different state.

---

## 11. The Codex — single source of truth (for `07-source-of-truth-codex.md`)

One document holding every reusable personal fact, read by **Quill** (autofill), **Envoy** (brand),
and **Archivist** (work context). Sections: identity (name, email, phone, links), addresses,
education, work experience (title, company, dates, bullets), skills, projects (name, repo, blurb,
links), bios (short/long), socials, demographics/EEO answers, and "voice" notes for posts. Quill
maps form-field labels → Codex fields (`first name`→Daniel, `last name`→Chahine, `email`→…).
**The Codex is read-only to agents except via an explicit "update my profile" flow.**

---

## 12. Security & privacy model (for `11-security-privacy.md`)

- **Confirmation gates** on every irreversible/outward action: Envoy posting, Usher registering/paying,
  any delete. Default = draft + ask.
- **Least-privilege OAuth scopes** per agent; Filer needs `gmail.modify` (labels) but **not** delete.
- **Local-only sensitive capture:** Echo audio and Quill screen never leave the device except as
  derived artifacts the owner approves.
- **Secrets** in Cloudflare Secrets Store; never in the Vault or Codex.
- **Audit log** of every agent action (D1) + surfaced via Flagger.
- **Phishing/2FA handling** per §5.8.

---

## 13. Roadmap / build order (for `12-roadmap.md`)

- **Phase 0 — Spine:** Atlas orchestrator, the Wire (queue), Steward + the Vault, the Codex,
  Cloudflare project, Google + GitHub OAuth.
- **Phase 1 — Core loop:** Filer → Herald → Forge → Sundial → Compass (the morning pipeline).
- **Phase 2 — Weekly value:** Scout, Headhunter, Flagger.
- **Phase 3 — Capture:** Echo (local daemon) + Archivist; Quill.
- **Phase 4 — Outward (gated):** Usher, Envoy.
- **Phase 5 — Meta/polish:** Switchboard, Librarian, dashboard refinement.
- Include a candid **feasibility / "is this a good idea"** note: yes for read/summarize/label/plan;
  highest-risk pieces are Echo (consent/privacy/OS audio), Quill (screen access), Usher (captcha,
  payments, ToS), Envoy (irreversible public posts). Start read-only, add write actions behind gates.

---

## 14. Doc style guide (for every writer)

- Start with a one-line **purpose**, then **At a glance** table (trigger, runtime, inputs, outputs,
  dependencies, MCPs/tools, writes-to).
- Sections: **What it does**, **How it works** (step list / pseudo-flow), **Inputs/Outputs**,
  **Dependencies**, **Schedule/Triggers**, **Failure modes & Flagger hooks**, **Config**,
  **Open questions**. Agent docs add **Example run**.
- Use real names/labels/schedules from this spec. Cross-link related agents.
- Markdown only, GitHub-flavored, with tables and fenced diagrams where useful. Keep it skimmable.
- Audience: the owner (technical, building this). Be concrete, not generic. No filler.
