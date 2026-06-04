# Headhunter (job-board & hiring-window tracker)

**Purpose:** Scrape job boards, track per-company **hiring windows** and per-role **application deadlines**, and turn imminent ones into `apply by <date>` tasks — so a window like Shopify fall-2026 closing ~May or Amazon fall-2026 ~April never slips by unnoticed.

## At a glance

| | |
|---|---|
| **Codename** | Headhunter |
| **Roster #** | 8 (Tier 2 — high value, weekly cadence) |
| **Runtime** | Cloud (Cloudflare Worker + Durable Object for state) |
| **Trigger** | cron **Mon 09:00** (full scan) + **09:00 daily (light)** (imminent-deadline check) |
| **Modes** | `full` (Monday), `deadlines` (daily-light) |
| **Inputs** | job-board listings, tracked-company hiring-window model (D1), [The Codex](../07-source-of-truth-codex.md) (skills/interests for ranking) |
| **Outputs** | `apply by <date>` tasks (via Forge), job-pipeline counter updates (via Steward), a ranked "interesting roles" shortlist |
| **Dependencies** | feeds **[Forge](forge.md)** (creates tasks) and **[Steward](steward.md)** (pipeline counts); reads **[The Codex](../07-source-of-truth-codex.md)** |
| **MCPs / tools** | browser fetch (job boards / careers pages), D1 (job + company-window store), reads the Codex |
| **Writes to** | **Forge** (tasks), **Steward** (Vault counters, via the Wire) — never the Vault directly |
| **Reports to** | **[Flagger](../08-flagger.md)** on scrape failures, stale windows, dedupe collisions |

> Headhunter **fetches** from job boards but **writes nothing outward**. It only emits tasks (to Forge) and counter events (to Steward). No applications are ever submitted — applying stays with the owner.

---

## What it does

1. **Tracks hiring windows per company.** New-grad / internship hiring runs in seasonal cohorts, not continuously. Headhunter holds a model of *when* each tracked company opens and closes a given cycle (e.g. **Shopify** fall-2026 typically closes **~May**; **Amazon** fall-2026 **~April**) and warns before the window shuts — even when no single posting carries an explicit deadline.
2. **Scrapes job boards & careers pages** for roles matching the owner's target profile, normalizes them, and **dedupes** against everything already seen.
3. **Ranks "interesting" roles** against [The Codex](../07-source-of-truth-codex.md) (skills, projects, target titles/locations) so the owner sees the best-fit roles first.
4. **Creates `apply by <date>` tasks** via [Forge](forge.md) for imminent deadlines and closing windows.
5. **Updates the job-pipeline counts** (`applied → OA → interview → offer / rejection`) via [Steward](steward.md) so the [Vault](../06-obsidian-dashboard-vault.md) **Job pipeline kanban** and **Jobs funnel** stay current.

It does **not** label email (that's [Filer](filer.md) with `Type/Job` + `Job/*`), schedule calendar entries (that's [Sundial](sundial.md), downstream of Forge), or apply on the owner's behalf.

---

## The company hiring-window model

A tracked company is one row of a small model in D1. A **window** is one company × one cycle (e.g. `Shopify / Fall 2026 / Intern`). This is what lets Headhunter warn on *time* even when a posting has no deadline field.

```
window {
  company         "Shopify"
  cycle           "fall-2026"            // season + year
  role_class      "intern" | "new-grad" | "experienced"
  opens_est       2026-01-15             // estimated open (historical + observed)
  closes_est      2026-05-15             // estimated close — drives "window closing" warnings
  confidence      0.0–1.0                // how trustworthy the estimate is → Flagger trust score
  source          "historical" | "posting" | "owner"
  status          "upcoming" | "open" | "closing" | "closed"
  last_seen_open  2026-05-02             // last scan where a matching posting was live
}
```

| Company (example) | Cycle | Typical close | Notes |
|---|---|---|---|
| **Shopify** | fall-2026 | **~May** | window-based; postings often lack a hard date |
| **Amazon** | fall-2026 | **~April** | earlier cohort; rolling, fills fast — treat as urgent sooner |

How estimates evolve:

- **historical** — seeded close month from past cycles (Shopify ~May, Amazon ~April). Low-to-mid confidence.
- **posting** — if a scraped role exposes a real deadline, it **overrides** the estimate for that window (high confidence) and tightens `closes_est`.
- **owner** — a manual correction; highest confidence, never overwritten by a scan.
- **`last_seen_open`** moves forward each scan a matching role is live. If a previously-open window goes several scans with nothing live, status flips `open → closing → closed` and Headhunter flags it (the cohort may have quietly filled).

**Status drives urgency.** `closing` windows (within the lead-time threshold of `closes_est`, default **21 days**) and rolling companies like Amazon get promoted into the daily-light path and produce `apply by` tasks even mid-week.

---

## How it works

### `full` mode — Mon 09:00 (full board scan + window update)

```
1. Load tracked companies + windows from D1.
2. For each board / careers page:
     fetch listings ─▶ parse ─▶ normalize (title, company, location, deadline?, url, posted_at)
3. Dedupe each normalized role against the seen-store (see Dedupe).
4. For new roles:
     - if posting carries a deadline ─▶ override the matching window's closes_est (source=posting)
     - rank against the Codex (see Ranking)
5. Recompute every window's status from listings + last_seen_open + closes_est.
6. Emit tasks (Forge) for:
     - roles with an explicit deadline ≤ lead-time
     - windows now in `closing` status
7. Emit counter events (Steward) for pipeline + "tracked windows" stats.
8. Report anomalies to Flagger (scrape failures, windows gone stale, low-confidence closes).
```

### `deadlines` mode — 09:00 daily (light)

A cheap check — **no full scrape**. Reads existing windows/roles from D1 and only acts on what's about to close:

```
1. Load windows where status ∈ {open, closing} AND closes_est within lead-time.
2. Load roles with explicit deadline within lead-time not yet tasked.
3. Emit / refresh `apply by <date>` tasks via Forge (idempotent — see below).
4. Push-worthy closes (window closing in ≤ 3 days, or a rolling Amazon-style cohort)
   ─▶ Flagger (which routes P2 → push).
```

> The split is deliberate: the Monday `full` run does the expensive board crawl; the daily `deadlines` run is a near-free reminder pass over already-known data. This matches the [scheduling](../03-scheduling.md) table (`09:00 daily (light)` = `deadlines`, `Mon 09:00` = `full`).

---

## Dedupe

The same role appears across boards, gets reposted, and reappears each scan. Headhunter keeps a **seen-store** keyed by a stable fingerprint so it neither double-tasks nor double-counts.

- **Fingerprint:** `normalize(company) + normalize(title) + location + cycle`. Posting URL/ID is a secondary key (URLs churn).
- **Cross-board:** same fingerprint from two boards → one logical role, multiple `sources[]`.
- **Reposts:** a re-listed role keeps its original fingerprint; `posted_at` refreshes but it does **not** generate a second `apply by` task.
- **Task idempotency:** every emitted task carries an `idempotencyKey` (`headhunter:role:<fingerprint>` or `headhunter:window:<company>:<cycle>`). Re-running a scan, or the daily-light pass touching the same deadline, **upserts** the same task instead of creating duplicates — consistent with [Forge](forge.md) and Steward's idempotent write contract.
- **Counter safety:** pipeline `increment` events to [Steward](steward.md) reuse the same `idempotencyKey`, so a replayed run can't inflate "applied" / "interview" counts (see [Steward write contract](steward.md), SPEC-CANON §6.4).

---

## Ranking "interesting" roles against the Codex

Headhunter reads [The Codex](../07-source-of-truth-codex.md) (read-only) to score fit, so the shortlist leads with best matches rather than raw scrape order.

| Signal | Source in Codex | Effect |
|---|---|---|
| **Skill overlap** | `skills`, `projects` | core ranking weight — overlap of role keywords with the owner's stack |
| **Target title** | `work experience` titles, "voice"/goals | boosts matching seniority/role class |
| **Location / remote fit** | `addresses`, preferences | down-weights non-viable locations |
| **Company on watchlist** | tracked-window list | boost — owner already cares about this company |
| **Urgency** | window `status` / `closes_est` | `closing` and rolling cohorts (Amazon) sort to the top regardless of fit |

The score blends **fit** (Codex overlap) with **urgency** (window status). A merely-good-fit role with a closing window outranks a perfect-fit role months out. Below a fit floor, a role is stored and deduped but **not** surfaced or tasked. The ranked shortlist is sent to Steward for the Vault's deadline/job views; only roles above the fit floor **and** inside the lead-time produce `apply by` tasks.

---

## Inputs / Outputs

**Inputs**
- Job-board listings & company careers pages (browser fetch).
- Tracked-company **hiring-window** model + seen-store (D1).
- [The Codex](../07-source-of-truth-codex.md) — skills, projects, target titles, locations (for ranking).

**Outputs**
- **`apply by <date>` tasks** → [Forge](forge.md) (which may then hand deadlines to [Sundial](sundial.md) for the calendar).
- **Counter events** → [Steward](steward.md): job-pipeline funnel + tracked-windows stats, via the Wire.
- **Ranked shortlist** of interesting roles → Steward (Vault **Deadline board** / **Job pipeline kanban**).
- **Flags** → [Flagger](../08-flagger.md).

---

## Dependencies

Per SPEC-CANON §4:

- **Headhunter feeds [Forge](forge.md)** (creates `apply by X` tasks) and **[Steward](steward.md)** (pipeline counts). It does **not** write the Vault directly — Steward is the sole Vault writer.
- **Reads [The Codex](../07-source-of-truth-codex.md)** for ranking (read-only; never writes it).
- Downstream of Forge, deadline tasks can reach Google Calendar via **[Sundial](sundial.md)** and the daily plan via **[Compass](compass.md)** — Headhunter doesn't call these directly; it just produces the tasks.
- **Steward fetches nothing** — Headhunter pushes events onto the Wire; Steward serializes the writes.

```
Headhunter ─┬─▶ Forge ──▶ (Sundial → Calendar, Compass → day plan)
            └─▶ the Wire ──▶ Steward ──▶ The Vault (job pipeline, deadline board)
                         ▲
                  The Codex (skills/interests, read-only)
```

---

## Schedule / Triggers

From [scheduling](../03-scheduling.md) (SPEC-CANON §10):

| Time / trigger | Mode | What runs |
|---|---|---|
| **09:00 daily (light)** | `deadlines` | cheap check for imminent job deadlines / closing windows; refresh tasks |
| **Mon 09:00** | `full` | full board scan + hiring-window update |

**Concurrency:** Headhunter's Monday `full` run and the **Fri 16:00** digests ([Scout](scout.md) + weekly [Herald](herald.md)) touch different state and may overlap freely. Steward serializes any writes that land at once, so concurrent fan-in is safe.

---

## Failure modes & Flagger hooks

| Condition | Severity | Trust | Routing |
|---|---|---|---|
| Board fetch fails / layout changed (parser yields 0 roles for a known board) | **P2 High** | high (caught error) | push |
| Window estimate has no live posting for N scans (cohort may have quietly closed) | **P3 Medium** | mid (inference) | dashboard feed |
| Window `closing` ≤ 3 days, or rolling cohort (Amazon-style) about to fill | **P2 High** | high | push |
| Low-confidence `closes_est` (historical-only, never confirmed by a posting) | **P4 Low / Info** | low (LLM/heuristic) | dashboard feed |
| Dedupe collision (two distinct roles share a fingerprint) | **P3 Medium** | mid | dashboard feed |
| Forge/Steward emit rejected or unacked | **P2 High** | high | push |

Flag shape and severity/trust/status semantics follow [Flagger](../08-flagger.md) (SPEC-CANON §8). All side-effects (tasks, counter events) are idempotent, so a retried run after a transient scrape failure is safe to repeat.

---

## Config

| Key | Default | Meaning |
|---|---|---|
| `boards[]` | — | job boards / careers pages to scrape in `full` mode |
| `tracked_companies[]` | Shopify, Amazon, … | companies with a maintained hiring-window model |
| `lead_time_days` | `21` | how far before `closes_est` / deadline to start tasking + flagging |
| `push_threshold_days` | `3` | window/deadline this close ⇒ P2 push (not just dashboard) |
| `fit_floor` | `0.4` | minimum Codex fit score to surface/task a role |
| `rolling_companies[]` | Amazon, … | companies whose cohorts fill rolling — treat as urgent earlier |
| `cycle` | `fall-2026` | active hiring cycle label |

Stored in KV (config) per SPEC-CANON §7; windows + seen-store in D1.

---

## Example run

**`deadlines` mode — Tue 2026-05-05, 09:00 (light).** No full scrape; reads known windows.

```
[09:00] Headhunter/deadlines start (cycle=fall-2026, lead_time=21d)
  load windows status∈{open,closing} within lead-time → 2 hits
    • Shopify  / fall-2026 / intern : closes_est 2026-05-15 (10d) → status "closing"
    • Amazon   / fall-2026 / new-grad: rolling, last_seen_open 2026-05-04 → "open" (urgent)
  load roles w/ explicit deadline within lead-time, not yet tasked → 1 hit
    • "SWE Intern, Fall 2026" @ Shopify  deadline 2026-05-15

  rank vs Codex:
    Shopify intern  fit 0.78  + urgency(closing)  → surface + task
    Amazon new-grad fit 0.71  + urgency(rolling)  → surface + task

  emit → Forge:
    task "apply by 2026-05-15 — Shopify SWE Intern (fall-2026)"
         idempotencyKey=headhunter:window:Shopify:fall-2026   [upsert, existed → no-op]
    task "apply by ~2026-04-?? — Amazon new-grad (rolling, apply ASAP)"
         idempotencyKey=headhunter:window:Amazon:fall-2026     [new]
  emit → Steward (Wire): upsert tracked-windows=2 closing, op=increment pipeline n/a

  Flagger:
    P2 High  trust 92  "Amazon fall-2026 cohort filling — apply ASAP"        → push
    P3 Med   trust 70  "Shopify fall-2026 intern window closes in 10 days"   → dashboard feed

[09:00] done in 1.4s — 0 scrapes, 1 new task, 1 task confirmed, 2 flags
```

**What the owner sees:** a push for Amazon (rolling, time-critical), the Shopify close on the Vault **Deadline board**, and two `apply by` tasks in the day plan — without Headhunter ever re-crawling a board or submitting anything.

---

## Open questions

- **Window seeds:** hand-curate historical close months per company, or infer from observed `last_seen_open` over multiple cycles?
- **Board coverage vs. ToS:** which boards allow scraping vs. need an API / RSS / careers-page fetch? (Respect rate limits, mirror [Filer](filer.md)'s batch-and-back-off discipline.)
- **Applied-state source of truth:** does the funnel `applied++` come from Headhunter (task marked done) or from [Filer](filer.md) seeing a `Job/Application` confirmation email? Avoid double-counting across the two paths.
- **Fit floor tuning:** is `0.4` too aggressive — should closing-window roles bypass the floor entirely so nothing time-critical is ever hidden?
- **Multi-role-class windows:** one company can have intern + new-grad windows closing on different dates — confirm the `(company, cycle, role_class)` key is granular enough.
