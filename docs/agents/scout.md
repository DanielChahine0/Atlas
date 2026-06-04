# Scout (event discovery)

> **Purpose:** Discover interesting upcoming events from the web, filter them against the owner's interests in [The Codex](../07-source-of-truth-codex.md), and produce a **weekly events digest** every **Fri 16:00** of what's coming in the next week/month — with chosen events able to hand off to [Usher](usher.md) for registration.

Scout is roster **#6**, Tier 2 (high value, weekly cadence). It is a **read-and-summarize** agent: it scrapes, ranks, and recommends, but never registers, pays, or writes anything outward-facing on its own. All discovered events flow to [Steward](steward.md) (via the [Wire](../02-architecture.md)) for the dashboard, and any event the owner picks is handed to [Usher](usher.md).

---

## At a glance

| | |
|---|---|
| **Codename** | Scout |
| **Role** | Event discovery & weekly events digest |
| **Runtime** | Cloud (Cloudflare Worker + Workflow; browser via Playwright/MCP for scrape) |
| **Trigger** | cron **Fri 16:00** (weekly) — parallel with weekly-[Herald](herald.md) |
| **Mode** | `weekly` |
| **Inputs** | Event sites, newsletters (`Type/Newsletter`), community feeds; [The Codex](../07-source-of-truth-codex.md) interests; existing Vault events (dedupe) |
| **Outputs** | Weekly events digest (draft to owner) + per-event `upsert` events to Steward |
| **Dependencies** | [The Codex](../07-source-of-truth-codex.md) (interest filter), [Steward](steward.md) (write), [Usher](usher.md) (registration hand-off), [Flagger](flagger.md) (incidents) |
| **MCPs / tools** | Web search; **browser/Playwright** (MCP) for scrape; Gmail read (newsletter sources); the **Wire** (Cloudflare Queue) |
| **Writes to** | **Vault (via Steward only)** — never writes the Vault directly |

---

## What it does

Once a week, Scout answers one question: **"What's coming up in the next week/month that I'd actually care about?"**

1. **Pulls candidate events** from a fixed set of sources (see [Sources](#sources)) — event-listing sites, opted-in newsletters, and community feeds.
2. **Filters & ranks** every candidate against the owner's declared interests in [The Codex](../07-source-of-truth-codex.md) (see [Interest filtering](#interest-filtering)). Low-relevance noise is dropped before it ever reaches the owner.
3. **Dedupes** against events already on the dashboard and against last week's digest, so the same conference doesn't show up four Fridays in a row.
4. **Produces a digest** — a single skimmable draft (see [Digest format](#digest-format)) split into *This week* and *This month+*, each event tagged with a relevance score and a one-line "why you".
5. **Feeds [Steward](steward.md)** an `upsert` event per surfaced event so the **Upcoming events (7 days)** view and the events counters stay current.
6. **Stages registration hand-offs** — the owner replies / clicks "register" on chosen events, and Scout queues them for [Usher](usher.md). Scout itself **never registers** (see [Hand-off to Usher](#hand-off-to-usher)).

Scout is **idempotent**: re-running the same Friday produces the same digest and does not double-count events in the Vault (every Steward write carries an `idempotencyKey`).

---

## How it works

```
                    Fri 16:00 cron
                          │
                          ▼
        ┌──────────────────────────────────┐
        │  1. Gather sources                │
        │   event sites · newsletters       │
        │   community feeds                 │   ◀── browser/Playwright + web search
        └──────────────────────────────────┘   ◀── Gmail read (Type/Newsletter)
                          │  raw candidates
                          ▼
        ┌──────────────────────────────────┐
        │  2. Normalize → Event records     │
        │   {title,date,location,url,...}   │
        └──────────────────────────────────┘
                          │
                          ▼
        ┌──────────────────────────────────┐
        │  3. Interest filter (the Codex)   │   ◀── reads Codex interests/voice
        │   score 0–100, drop < threshold   │
        └──────────────────────────────────┘
                          │
                          ▼
        ┌──────────────────────────────────┐
        │  4. Dedupe vs Vault + last digest │
        └──────────────────────────────────┘
                          │
              ┌───────────┴────────────┐
              ▼                        ▼
   ┌───────────────────┐    ┌────────────────────────┐
   │  5a. Digest draft │    │  5b. upsert each event │──▶ the Wire ──▶ Steward ──▶ Vault
   │   → owner inbox   │    │      to Steward        │
   └───────────────────┘    └────────────────────────┘
              │
              ▼
   owner picks events ──▶ queue for Usher (registration, gated)
```

**Step detail:**

1. **Gather.** For each configured source, fetch the listing. Static HTML / RSS → web fetch. JS-rendered or login-walled listings (Luma, Eventbrite, Meetup) → **browser/Playwright** snapshot. Newsletters → read recent `Type/Newsletter` threads in Gmail (read-only) and extract event mentions.
2. **Normalize.** Coerce each candidate into the [Event record](#event-record) schema. Discard anything without a resolvable date in the next ~35 days.
3. **Score.** Ask the model to score relevance 0–100 against the Codex interest set, returning a one-line rationale per event. Drop everything below `min_relevance` (default **55**).
4. **Dedupe.** Skip events already present in the Vault (match on `url` or `title+date`) and events surfaced in the previous digest unless their details changed.
5. **Emit.** Build the digest draft and, in parallel, send one Steward `upsert` per surfaced event. Both fan into Steward on the same Friday; Steward serializes the writes.

> **Concurrency:** per [scheduling](../03-scheduling.md) §10, Scout and weekly-[Herald](herald.md) run **in parallel** at Fri 16:00 (independent sources), then both fan into [Steward](steward.md), which writes serially. At **Fri 16:30** the weekly-review build compiles the dashboard summary that includes Scout's events.

---

## Sources

Scout reads only opted-in / public sources. Source list lives in KV config (see [Config](#config)).

| Class | Examples | Fetch method | Notes |
|---|---|---|---|
| **Event sites** | Luma, Eventbrite, Meetup, conference/hackathon listings, local university + city event calendars | browser/Playwright (JS-rendered) | many require a rendered DOM or scroll |
| **Newsletters** | `Type/Newsletter` threads in Gmail (tech, local, community digests) | Gmail read (read-only) | reuse [Filer](filer.md)'s labels; never act on links |
| **Communities** | Discord/Slack community announcements, subreddit + forum event threads, RSS feeds | web fetch / RSS, browser where needed | community-announced meetups, talks, AMAs |
| **Direct invites** | `Type/Events` / `Events/Invite` threads | Gmail read | surfaces invites already in the inbox into the same digest |

**Source rules:**
- **Read-only.** Scout scrapes and reads; it never clicks "register," logs in to act, or submits forms — that's [Usher](usher.md), and only behind a confirmation gate.
- **Respect the source.** Honor robots/ToS where applicable; rate-limit and back off browser sessions. Scrape failures are flagged, not retried infinitely (see [Failure modes](#failure-modes--flagger-hooks)).
- **No security mail.** Never pull from `Type/Security` or `⚠ Phishing-Suspect`; never follow links in any email source (per [email taxonomy](../04-email-taxonomy.md) §5.8).

---

## Interest filtering

Scout matches candidates against the owner's interests stored in [The Codex](../07-source-of-truth-codex.md). The Codex is **read-only** to Scout (no profile writes).

**What it reads from the Codex:**
- **Skills** (e.g. systems, ML, web) and **projects** (topic adjacency).
- **Voice / interest notes** — the free-text "what I care about" the owner maintains.
- **Location / addresses** — to weight local, in-person, and reachable events.

**Scoring:**
- Each candidate gets a **relevance 0–100**: topic match × proximity × novelty (penalize repeats), plus a one-line "why you" rationale.
- Below `min_relevance` (default **55**) → dropped, not shown.
- `From/VIP`-adjacent or directly-invited (`Events/Invite`) events get a relevance bump so personal invites never get filtered out.

```
relevance = w_topic·topicMatch(Codex)        // does it match interests/skills/projects?
          + w_local·proximity(Codex.address) // local in-person > distant > online
          + w_novel·novelty(Vault history)   // penalize already-seen recurring events
          + w_invite·invitedBump             // Events/Invite or VIP → bump
```

Weights live in KV `scout/weights`; defaults favor topic match, then local proximity.

---

## Digest format

A single draft to the owner's inbox, split by horizon and ranked by relevance within each block. Mirrors the structure of the Vault **Upcoming events (7 days)** view so the digest and dashboard read the same.

```
┌──────────────────────────────────────────────────────────────┐
│  Scout — Weekly Events Digest · Fri 2026-05-29                │
│  12 surfaced · 4 this week · 8 this month · 31 scanned        │
├──────────────────────────────────────────────────────────────┤
│  THIS WEEK (next 7 days)                                      │
│  ──────────────────────────────────────────────────────────  │
│  [92] Tue Jun 2 · 18:30 · Toronto  ·  "AI Infra Meetup"      │
│        why you: systems + ML; 15 min away; free   [Register] │
│  [78] Thu Jun 4 · all-day · online ·  "Rust Conf talks"     │
│        why you: matches your Rust project          [Register] │
│  ...                                                          │
├──────────────────────────────────────────────────────────────┤
│  THIS MONTH+ (8–35 days)                                      │
│  ──────────────────────────────────────────────────────────  │
│  [85] Jun 14 · Waterloo  ·  "Hack the North info session"   │
│        why you: hackathon interest; local          [Register] │
│  ...                                                          │
└──────────────────────────────────────────────────────────────┘
```

**Per-event line carries:**

| Field | Source |
|---|---|
| `[relevance]` 0–100 | interest filter |
| Date / time | normalized `start` |
| Location (city or "online") | `location` |
| Title (links to source) | `title` + `url` |
| **why you** (one line) | filter rationale |
| **[Register]** action | hand-off to [Usher](usher.md) |

**Horizons:** *This week* = next 7 days (feeds the Vault 7-day view); *This month+* = 8–35 days. Anything past the month window is dropped (re-surfaces in a later week's digest when it enters range).

---

## Hand-off to Usher

Scout discovers; **[Usher](usher.md) registers.** This split keeps Scout fully reversible and puts the irreversible/risky action (registration, captcha, payment, ToS) behind [Usher](usher.md)'s confirmation gate (per [security & privacy](../11-security-privacy.md) §12 and roster Tier 4).

```
Scout digest ──[ owner clicks "Register" / replies ]──▶ queue hand-off
                                                              │
                                                              ▼  the Wire
                                                         Usher (on-demand)
                                                              │  confirmation gate
                                                  ┌───────────┴───────────┐
                                                  ▼                       ▼
                                          Google Calendar add      Steward (events ++)
```

- The owner selects events from the digest (reply, dashboard action, or the **[Register]** link).
- Scout packages each chosen event (`title`, `start`, `url`, `location`, source) and queues a hand-off for [Usher](usher.md) on the **Wire**.
- [Usher](usher.md) runs **on-demand**, performs the registration **behind a confirmation gate**, adds the event to **Google Calendar**, and reports `events attended++` to [Steward](steward.md).
- **Scout never registers or pays.** If a candidate looks high-value but has a paywall/captcha, Scout still only *suggests* it — Usher + the human decide.

---

## Inputs / Outputs

**Inputs**
- Configured **sources** — event sites, newsletters, community feeds (KV `scout/sources`).
- **[The Codex](../07-source-of-truth-codex.md)** — interests, skills, projects, location (read-only).
- **Existing Vault events** + last week's digest — for dedupe (read via Steward's published state / D1).
- **Gmail** `Type/Newsletter`, `Type/Events`, `Events/Invite` threads (read-only).

**Outputs**
- **Weekly events digest** — draft to the owner's inbox (never auto-sent as an outward action).
- **Steward `upsert` events** — one per surfaced event, onto the Wire.
- **Usher hand-off events** — for owner-chosen events (queued, gated).
- **Flagger events** — on scrape failure, stale sources, or low-confidence scoring.

### Event record

The normalized shape Scout produces per candidate (D1-backed, surfaced to Steward):

```json
{
  "id": "evt_2026-06-02_ai-infra-meetup",
  "title": "AI Infra Meetup",
  "start": "2026-06-02T18:30:00-04:00",
  "end": null,
  "location": "Toronto, ON",
  "online": false,
  "url": "https://lu.ma/...",
  "source": "luma",
  "relevance": 92,
  "why": "systems + ML interest; 15 min away; free",
  "horizon": "week",
  "status": "surfaced"
}
```

`status`: `surfaced → chosen → handed_off` (to Usher) → `registered` (set by Usher).

### Steward write contract

Scout sends to [Steward](steward.md) on the Wire — it **never writes the Vault directly** (per [architecture](../02-architecture.md) one-writer rule):

```json
{
  "agent": "scout",
  "type": "event_surfaced",
  "entity": "event",
  "op": "upsert",
  "payload": { "id": "evt_...", "title": "...", "start": "...", "relevance": 92, "horizon": "week" },
  "idempotencyKey": "scout:evt_2026-06-02_ai-infra-meetup"
}
```

Steward updates the **Upcoming events (7 days)** view and the **Events: registered / attended / upcoming** counters; the `idempotencyKey` makes replays safe.

---

## Dependencies

- **[The Codex](../07-source-of-truth-codex.md)** — interest filter source (read-only).
- **[Steward](steward.md)** — the only Vault writer; Scout feeds it events, fetches nothing back to write.
- **[Usher](usher.md)** — receives registration hand-offs for chosen events.
- **[Flagger](flagger.md)** — receives scrape/scoring incidents.
- **[Filer](filer.md)** — its `Type/Newsletter` / `Type/Events` labels make the newsletter source clean to read.
- Runs **parallel** with weekly-[Herald](herald.md) at Fri 16:00 (independent), both fanning into Steward.

---

## Schedule / Triggers

| Time / trigger | Mode | Notes |
|---|---|---|
| **Fri 16:00** (cron) | `weekly` | upcoming events next week/month — **parallel** with weekly-[Herald](herald.md) |
| **Fri 16:30** | — | weekly-review build (Steward) compiles the summary including Scout's events |
| on-demand re-run | `weekly` | manual re-scan; idempotent, won't double-count |

See [scheduling](../03-scheduling.md) §10. Scout is **not** event-driven and **not** part of the strictly-sequential morning chain — it's a standalone weekly job whose only fan-in target is Steward (and Usher, on owner choice).

---

## Failure modes & Flagger hooks

| Failure | Detection | Severity → [Flagger](flagger.md) | Trust |
|---|---|---|---|
| Source unreachable / layout changed (scrape returns nothing) | empty/short result vs baseline | `P3 Medium` | high (caught) |
| Browser/Playwright session times out or hits a captcha | session error | `P3 Medium` | high (caught) |
| Newsletter parse yields no events | zero extracted from non-empty source | `P4 Low / Info` | medium |
| Codex unreadable / interests empty | read error | `P2 High` (digest can't be relevance-filtered) | high |
| Low-confidence scoring across the board | mean relevance / model uncertainty | `P4 Low / Info` | low (LLM judgment) |
| Steward write rejected | NACK on the Wire | `P3 Medium` | high |
| Heartbeat: Friday run didn't fire | missing run-log entry by 16:15 | `P2 High` | high |

- Per-source isolation: one dead source **does not** sink the digest — Scout flags it and ships the rest.
- Phishing/security hygiene: never follow links from email sources; treat `⚠ Phishing-Suspect` as off-limits.
- All flags carry a **trust score 0–100** and route per [Flagger](flagger.md) §8 (P1/P2 → push; P3/P4 → batched into the dashboard feed).

---

## Config

KV-backed, editable without redeploy:

| Key | Default | Meaning |
|---|---|---|
| `scout/sources` | curated list | event sites, newsletter senders, community feeds |
| `scout/min_relevance` | `55` | drop candidates scoring below this |
| `scout/horizon_week_days` | `7` | "This week" window |
| `scout/horizon_month_days` | `35` | outer "This month+" window |
| `scout/weights` | topic > local > novelty > invite | interest-filter weights |
| `scout/max_per_digest` | `15` | cap surfaced events per digest |
| `scout/browser_timeout_ms` | `30000` | per-source Playwright budget |
| `scout/dedupe_window_weeks` | `4` | suppress repeats already shown recently |

Secrets (Google OAuth read scope, source logins where unavoidable) live in Cloudflare Secrets Store, never in the Vault/Codex (per [security & privacy](../11-security-privacy.md) §12).

---

## Example run

**Friday, 2026-05-29, 16:00 — Scout `weekly` fires (parallel with weekly-Herald).**

```
16:00:01  Scout: weekly run start (workflow wf_scout_20260529)
16:00:02  Gather: 7 sources → luma, eventbrite, meetup, 2× community RSS,
                   Gmail Type/Newsletter (9 threads), Events/Invite (2 threads)
16:00:09  Playwright: luma + meetup rendered OK; eventbrite timed out (30s)
                   → Flagger P3 "eventbrite scrape empty" trust 88 — continue
16:00:14  Normalize: 31 raw candidates → 27 with resolvable dates ≤ 35 days
16:00:21  Codex interest filter: scored 27
                   dropped 13 (< 55) · kept 14
16:00:23  Dedupe: −2 already in Vault (recurring weekly meetup) → 12 surfaced
16:00:25  Emit:
            • 12× Steward upsert (op=upsert, idempotencyKey=scout:evt_…) → the Wire
            • digest draft → owner inbox
16:00:26  Scout: done. 12 surfaced (4 week / 8 month), 31 scanned.
```

**Digest delivered to the owner's inbox:**

```
Scout — Weekly Events Digest · Fri 2026-05-29
12 surfaced · 4 this week · 8 this month · 31 scanned · 1 source flagged (eventbrite)

THIS WEEK (next 7 days)
[92] Tue Jun 2 · 18:30 · Toronto · AI Infra Meetup
     why you: systems + ML; 15 min away; free                          [Register]
[81] Wed Jun 3 · 19:00 · online · "Building Agents on Cloudflare" talk
     why you: matches your Atlas / Workers project                     [Register]
[78] Thu Jun 4 · all-day · online · RustConf community stream
     why you: matches your Rust project                                [Register]
[71] Sat Jun 6 · 10:00 · Toronto · Indie Hackers coffee
     why you: side-project / founder interest                          [Register]

THIS MONTH+ (8–35 days)
[88] Jun 14 · Waterloo · Hack the North — info session
     why you: hackathon interest; local; you applied last year         [Register]
[85] Jun 18 · Toronto · ML Systems reading group
     why you: ML + systems overlap                                     [Register]
[73] Jun 21 · online · Postgres internals workshop
     why you: adjacent to your data work                               [Register]
… 5 more
```

**Owner replies "register me for the AI Infra Meetup and Hack the North info session."**

```
16:42  Scout: 2 events → status chosen
              package + queue Usher hand-off on the Wire
16:42  Usher (on-demand): picks up 2 hand-offs
              → confirmation gate: "Register Daniel for these 2 events?"  [Y/N]
```

Steward (after the 16:00 fan-in and the 16:30 weekly-review build) shows **12 upcoming events** in the 7-day/month views, and — once Usher completes behind its gate — bumps **Events: registered** by 2.

---

## Open questions

- **Newsletter extraction precision:** event mentions in prose newsletters are noisy — do we need a dedicated extractor pass, or is the relevance filter enough to absorb false positives?
- **Source auth:** some listings (private Discords, member-only calendars) need a logged-in session. Does Scout get scoped read credentials, or do those stay out of scope (Usher-only)?
- **Recurring events:** how aggressively should `dedupe_window_weeks` suppress a weekly meetup the owner *does* want re-reminded about? Per-event "always show" override?
- **Relevance threshold tuning:** is `min_relevance = 55` too strict for a sparse week (digest comes back near-empty)? Consider a "fill to N" relaxation when fewer than `k` events clear the bar.
- **Calendar pre-check:** should Scout cross-reference Google Calendar to mark conflicts in the digest before the owner picks, or leave conflict detection entirely to Usher/Compass?
