# Flagger (incident flagging)

> **Purpose:** Receive incident events from every agent in the fleet, assign a **severity** (`P1`–`P4`) and a **0–100 trust score**, dedupe and route them — pushing `P1`/`P2` to the owner immediately and batching `P3`/`P4` into the dashboard — then write the resulting **flag** to [The Vault](../05-dashboard.md) via [Steward](steward.md). It also watches the fleet's (and its own) heartbeat so nothing fails silently.

Roster **#15** ([01-agent-roster.md](../01-agent-roster.md)). Tier 2 (high value, reliability — *"matters more as the fleet grows"*). This is the per-agent spec & **Example run**; the chapter-level reference is [../08-flagger.md](../08-flagger.md). Keep the two consistent — codenames, severities, trust bands, schema, and routing all come from [SPEC-CANON §8](../SPEC-CANON.md).

---

## At a glance

| | |
|---|---|
| **Codename** | **Flagger** (incident/issue flagging with severity + trust score) |
| **Role** | Fleet observability + alerting — scores, dedupes, and routes incidents |
| **Runtime** | Cloud (Cloudflare Worker + a per-agent Durable Object for live flag state; a separate Cron watchdog Worker for self-monitoring) |
| **Trigger** | **Event-driven** — incident + heartbeat events from **every** agent over [the Wire](../02-architecture.md); never self-scheduled (see [scheduling](../03-scheduling.md)) |
| **Inputs** | Incident events `{ source_agent, kind, payload, run_id }`, heartbeats from every scheduled agent, D1 run-log entries, `AI/Uncertain` / `⚠ Phishing-Suspect` signals from [Filer](filer.md), counter snapshots from [Steward](steward.md) |
| **Outputs** | A scored, deduped **flag** (§[The flag shape](#the-flag-shape)); a **push notification** for `P1`/`P2`; a **Steward upsert** that lands the flag on the [Flagger board](#vault-flagger-board); a D1 audit row |
| **Depends on** | [Steward](steward.md) (sole Vault writer), the **Wire** (Cloudflare Queue), **D1** (run-log + audit), **KV** (mute-rules / config), and *every agent emitting events* |
| **Feeds** | [Steward](steward.md) → [The Vault](../05-dashboard.md) (the Flagger feed); the **push channel** (owner device) |
| **MCPs / tools** | Push-notification channel; D1; KV. **Reads** (never clicks) the `⚠ Phishing-Suspect` / `AI/Uncertain` signals — per [email taxonomy §5.8](../04-email-taxonomy.md) |
| **Writes to** | [The Vault](../05-dashboard.md) **via [Steward](steward.md) only** (`op: "upsert"`) — Flagger never writes the Vault directly |

> Flagger is **not** in the morning pipeline. It sits to the side and observes; the [Filer→Herald→Forge→Sundial→Compass](../02-architecture.md) chain runs whether or not Flagger is healthy — which is exactly why Flagger watches *itself* ([self-monitoring](#self-monitoring--heartbeat)).

---

## What it does

Flagger does **no domain work**. It consumes the incident events other agents emit, scores and classifies each one, deduplicates, decides how loud to be, and hands a clean flag to [Steward](steward.md) for the Vault.

- **Catches explicit failures** every agent reports — caught exceptions, non-2xx MCP/API errors, rate-limit backoffs, OAuth-token expiry, exhausted queue retries.
- **Catches soft failures** — a missed deadline no task covered, a dashboard counter that drifted, a low-confidence LLM action (`AI/Uncertain`), a possible phishing email (`⚠ Phishing-Suspect` from [Filer](filer.md)).
- **Watches the fleet's pulse** — every scheduled agent emits a heartbeat; Flagger flags a **stale** one when an agent didn't run when [scheduling](../03-scheduling.md) said it should.
- **Watches itself** — emits and externally checks its own heartbeat so a dead Flagger doesn't fail silently.
- **Decides loudness** — `P1`/`P2` push immediately; `P3`/`P4` batch into the dashboard feed.

What it does **not** do (per the *suggest, don't destroy* pillar): never auto-remediates, never clicks links in suspect mail, never archives/deletes, never mutates another agent's state. It writes a `suggested_action` and leaves the doing to the owner.

```
   Atlas ┐
  Herald ┤
   Filer ┤
   Forge ┤   incident +              ┌──────────┐  P1/P2 ─push─▶ owner device
 Sundial ┤   heartbeat   ──the Wire──▶│ FLAGGER  │
 Compass ┤   events                  │ score +  │  P3/P4 ─batch─┐
   Scout ┤                           │ route    │              ▼
Headhunter┤                          └────┬─────┘   Steward ─▶ The Vault
   …all  ┘                                │  Steward upsert (flag)  (Flagger board)
                                          ▼
                                      D1 audit log
```

---

## The flag lifecycle

A flag moves through three stages: **derive** (sever­ity + trust), **dedupe** (one flag per recurring cause), **route** (push vs batch), then it lives out a **status** lifecycle until the owner or a deterministic recovery closes it.

### Pseudo-flow

```
1. Receive incident event off the Wire:  { source_agent, kind, payload, run_id }
2. Normalize → derive a dedupe signature  (source_agent + kind + normalized fingerprint)
3. Look up existing open/ack flag by signature:
     ├─ exists  → bump recurrence, re-score trust, append detail, keep status
     └─ new     → create flag (mint id from the signature)
4. Assign SEVERITY   (deterministic map: kind + source_agent criticality)  → §severity
5. Compute TRUST     (base by evidence + adjustments, clamp 0–100)         → §trust
6. Apply mute-rules (KV) → if matched: status = muted, skip routing (still audited)
7. ROUTE:
     ├─ P1 / P2 → push notification now (re-push on escalation window if un-ack'd)
     └─ P3 / P4 → enqueue for the batched dashboard feed
8. Emit Steward event on the Wire:
     { agent:"Flagger", type:"flag", entity:"flag", op:"upsert",
       payload:<flag>, idempotencyKey:id }
9. Persist to D1 (audit log). Done.
```

Step 8 uses the standard [Steward write contract](steward.md) — `op: "upsert"` keyed by `idempotencyKey: id` — so a replayed event updates the one board row rather than spawning a duplicate. Flagger **fetches nothing** from the Vault; like every agent, it feeds Steward and Steward writes.

### Status lifecycle

```
        emit
         │
         ▼
      ┌──────┐   owner sees / acks    ┌─────┐   condition clears        ┌──────────┐
      │ open │ ─────────────────────▶ │ ack │ ────────────────────────▶ │ resolved │
      └──────┘                        └─────┘                           └──────────┘
         │                               │
         │   owner / KV rule "stop alerting"
         └───────────────────────────────┴───────────────▶  ┌───────┐
                                                             │ muted │
                                                             └───────┘
```

| Status | Meaning | How it's set |
|--------|---------|--------------|
| **open** | New, unhandled. `P1`/`P2` have already pushed. | On emit. |
| **ack** | Owner has seen it; not yet fixed. Suppresses re-push for the same `id`. | Owner taps the push / marks it on the [board](#vault-flagger-board). |
| **resolved** | The underlying condition cleared. | Owner marks it, **or** Flagger auto-resolves on a deterministic recovery (heartbeat returns, next run succeeds). |
| **muted** | Known/expected noise — stop alerting for this `id` or signature. | Owner mutes, or a KV `mute_rules[]` entry matches. Muted flags **still log** (audit); they just don't push or surface. |

**Auto-resolution is conservative.** Only *deterministic* recoveries auto-resolve (heartbeat back, error gone on the next run). LLM-judgment flags (`⚠ Phishing-Suspect`, `AI/Uncertain`) always require an **owner** decision — Atlas won't decide on its own that a phishing call was wrong.

---

## Severity (P1–P4)

Severity answers **"how bad / how urgent?"** — independent of how sure we are it's real. It's set by the **source signal, deterministically**, *not* by the LLM.

| Severity | Meaning | Examples | Routing |
|----------|---------|----------|---------|
| **P1 Critical** | A load-bearing piece is down or time-sensitive harm is in progress. Look **now**. | [Steward](steward.md) write-loop wedged; the Wire backed up; a scheduled agent's heartbeat **stale**; OAuth revoked → Gmail/Calendar dead. | **Push now** |
| **P2 High** | A single agent failed or produced a wrong/blocking result; the loop degraded but isn't down. Look **today**. | [Forge](forge.md) threw on a malformed thread; [Sundial](sundial.md) couldn't create a calendar event; [Compass](compass.md) ran with a partial task set. | **Push now** |
| **P3 Medium** | Needs a human glance; nothing is broken right now. | Possible-phishing email; an `AI/Uncertain` triage call; a counter that looks off; a near-miss deadline. | **Batched** |
| **P4 Low / Info** | Noted for the record; no action expected. | A rate-limit backoff that self-recovered; a retried-then-succeeded queue message; a routine heartbeat-OK roll-up. | **Batched** |

A caught exception on a critical-path agent maps to `P1`/`P2` by rule; an LLM hunch maps to `P3` because the *consequence* is "human glance," not "fleet down." Trust then modulates how the owner reads it.

---

## Trust score (0–100)

Trust answers a **different** question: **"how confident is Atlas that this flag is real and correctly diagnosed?"** Severity = *how bad if true*; trust = *how likely true*. The owner reads them together.

### How it's derived

Trust starts from the **kind of evidence**, then gets adjusted:

| Evidence source | Base trust | Why |
|-----------------|-----------:|-----|
| Caught exception / non-2xx API error / queue retries exhausted | **90–100** | Deterministic — the machine actually saw it fail. |
| Stale heartbeat (agent provably didn't run on schedule) | **100** | Binary fact: the scheduled run is missing. |
| Counter / invariant check (dashboard math doesn't reconcile) | **75–90** | Rule-based, but could be a benign data-shape edge. |
| Deadline/SLA miss inferred from data | **60–80** | Depends on input completeness. |
| LLM classification + a tool-confirmed signal (e.g. SPF/DKIM fail + `⚠ Phishing-Suspect`) | **45–65** | Model judgment, partly corroborated. |
| Pure LLM judgment ("this looks suspicious / unusual") | **20–45** | A hunch worth surfacing, easy to be wrong. |

**Adjustments** (clamped to 0–100):

- **+** corroboration from a second independent signal (phishing hunch *and* a known-bad sender domain).
- **+** the same flag recurring across runs (a flaky pattern is more real than a one-off).
- **−** the source agent is itself in a degraded/uncertain state.
- **−** the flag depends on data Flagger knows is incomplete (e.g. [Filer](filer.md) hadn't finished its `07:45` sweep).

### Reading severity × trust

```
        trust →   low (0–40)         mid (40–70)         high (70–100)
severity ↓
 P1/P2          investigate, but     push + verify        push, act now
                may be noise          the diagnosis        (machine-certain)
 P3/P4          log, low priority     glance when free     fix at leisure
```

`P1 / trust 100` (stale heartbeat) is *do this now*. `P3 / trust 40` (LLM phishing hunch) is *glance, don't trust blindly, never click*.

---

## The flag shape

The canonical flag record (SPEC §8). Persisted in D1; mirrored into the Vault by [Steward](steward.md).

```jsonc
{
  "id": "flg_2026-05-29_a1b2c3",   // stable, dedupe-keyed
  "ts": "2026-05-29T08:31:14Z",    // ISO 8601; rendered owner-local in the Vault
  "source_agent": "Sundial",       // roster codename of the emitter (or "Flagger" for self-flags)
  "severity": "P2",                // P1 | P2 | P3 | P4
  "trust": 95,                     // 0–100 (see §trust)
  "title": "Sundial: calendar event create failed (3 deadlines)",  // one line, ≤ ~80 chars
  "detail": "Google Calendar API 503 on batch insert after 4 retries; 3 'apply by' tasks have no calendar block.",
  "suggested_action": "Re-run Sundial sync; if it persists, check Calendar OAuth scope/quota.",
  "status": "open"                 // open | ack | resolved | muted
}
```

| Field | Notes |
|-------|-------|
| `id` | Derived from the **dedupe signature** (`source_agent` + `kind` + normalized fingerprint) so a recurring failure updates one flag instead of spamming new ones. Recurrence bumps trust and appends to `detail`. |
| `source_agent` | Always a roster codename from [01-agent-roster.md](../01-agent-roster.md); self-flags use `"Flagger"`. |
| `severity` / `trust` | See [§severity](#severity-p1p4) and [§trust](#trust-score-0100). Severity is deterministic; trust modulates. |
| `title` | What shows on the [Flagger board](#vault-flagger-board). |
| `detail` | The click-through note (also carries cascade links, e.g. *"upstream Sundial P2 at 08:21"*). |
| `suggested_action` | **Advisory only** — Flagger never executes it. |
| `status` | `open → ack → resolved → muted` (see [lifecycle](#status-lifecycle)). |

---

## Routing (P1/P2 push vs P3/P4 batched)

```
P1 Critical ─┐
P2 High      ┴─▶  PUSH NOW  ──▶  owner device   (and still lands on the board)
P3 Medium    ─┐
P4 Low/Info  ┴─▶  BATCH     ──▶  Flagger feed on the Vault   (no interruption)
```

- **`P1`/`P2` → push immediately.** One push per distinct `id`; once `ack`'d the same flag won't re-push (recurrence updates it silently). A still-`open` `P1` that hasn't been ack'd within `escalation_window` (default `15m`) **re-pushes**, so a missed first alert isn't lost.
- **`P3`/`P4` → batched** into the [Flagger feed](#vault-flagger-board). They appear at the next dashboard build — the morning glance, or the Friday weekly-review compiled at **Fri 16:30** ([scheduling](../03-scheduling.md)) — with no interruption.
- **Muted** flags route nowhere; they only hit the D1 audit log.

Routing is severity-driven by default. The KV knob `push_severities` (default `["P1","P2"]`) decides which severities push vs batch; `trust_floor_for_push` (default `0`) can optionally suppress a push below a trust floor, but the default is *severity decides loudness, regardless of trust*.

---

## Vault Flagger board

The `Flagger feed` view in [The Vault](../05-dashboard.md) (dashboard §6.2). One row per flag, **sorted by severity, then by trust descending** — so the most-urgent, most-believable flags sit on top. The title click-throughs to a detail note holding `detail` + `suggested_action`.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  FLAGGER                                              heartbeat: ✓ OK (08:31)      │
├─────┬───────┬────────────┬─────────────────────────────────────────┬──────────────┤
│ Sev │ Trust │ Agent      │ Title (→ detail)                         │ Status       │
├─────┼───────┼────────────┼─────────────────────────────────────────┼──────────────┤
│ P1  │  100  │ Compass    │ Compass heartbeat stale — no 08:30 run   │ open         │
│ P2  │   95  │ Sundial    │ Calendar event create failed (3 dl)      │ ack          │
│ P3  │   40  │ Filer      │ Possible phishing: "Payroll update"      │ open         │
│ P4  │   88  │ Headhunter │ Rate-limit backoff, self-recovered       │ resolved     │
└─────┴───────┴────────────┴─────────────────────────────────────────┴──────────────┘
```

Columns map directly to flag fields: **Sev** = `severity`, **Trust** = `trust`, **Agent** = `source_agent`, **Title** = `title` (linked), **Status** = `status`. The header shows Flagger's own heartbeat so a dead board is visibly dead.

---

## Self-monitoring & heartbeat

Flagger watches the fleet **and itself** — a monitor that can fail silently is worse than no monitor.

**Fleet heartbeats.** Every scheduled agent emits a heartbeat tied to its [scheduling](../03-scheduling.md) slot. Flagger holds the expected-run table and raises a **stale-heartbeat** flag (`P1`, trust `100`) when an agent didn't run when it should have — e.g. no `Compass` heartbeat by **08:30 + grace**, or no `Filer` sweep by **07:45 + grace**. The grace is the KV knob `heartbeat_grace` (default `10m`).

**Self-heartbeat (externalized).** Flagger can't reliably flag its own death from inside a dead Worker, so the check lives **outside** it:

```
Flagger ─heartbeat→ KV (last_seen=ts)
                     │
   Cloudflare Cron ──┴─▶ watchdog Worker:  if (now - last_seen) > selfwatch_threshold
                                            → push "Flagger may be down" (P1)
                                            → Steward upsert a self-flag (source_agent:"Flagger")
```

A lightweight **Cron-triggered watchdog Worker** (separate from the main Flagger Worker — [hosting §7](../06-hosting-cloudflare-mcp.md)) reads `last_seen` from KV; if Flagger has gone quiet past `selfwatch_threshold` (default `15m`) it pushes a `P1` and writes a self-flag. This is the one case where the alert path doesn't depend on the thing it's alerting about.

---

## Inputs / Outputs

**Inputs**

- Incident events from every agent: errors, backoffs, exhausted retries, partial results — `{ source_agent, kind, payload, run_id }`.
- Heartbeats from every scheduled agent + Flagger's own.
- D1 run-log / audit entries (to detect missing or late runs).
- Low-confidence signals surfaced by [Filer](filer.md): `AI/Uncertain`, `⚠ Phishing-Suspect`.
- Invariant / counter snapshots from [Steward](steward.md) (to detect dashboard drift).

**Outputs**

- A scored, deduped **flag** record (§[The flag shape](#the-flag-shape)).
- A **push notification** for `P1`/`P2`.
- A **Steward upsert event** that lands the flag on the [Flagger board](#vault-flagger-board) (`P3`/`P4` land here only, batched).
- An **audit-log** row in D1 for *every* flag, including muted ones.

---

## Dependencies

| Depends on | For |
|------------|-----|
| **The Wire** (Cloudflare Queue) | Receiving incident events in; sending Steward events out. |
| [Steward](steward.md) | The **only** path to the Vault — serialized, idempotent writes. |
| **D1** | Audit log + run-log queries (detect missing runs). |
| **KV** | `mute_rules[]`, `severity_overrides`, and the threshold knobs in [config](#config). |
| **Every agent** | They must **emit** incident + heartbeat events — Flagger is only as good as what's reported (the *idempotent + observable* pillar). |

Flagger is **not** a dependency of the morning pipeline; it observes from the side. Nothing in the [Filer→Herald→Forge→Sundial→Compass](../02-architecture.md) chain blocks on Flagger.

---

## Schedule / Triggers

Flagger is **event-driven** and never self-schedules ([scheduling §10](../03-scheduling.md), `event-driven` row alongside [Steward](steward.md)):

| Trigger | What fires |
|---------|------------|
| Incident event on the Wire | Score → dedupe → route → Steward upsert → D1 audit. |
| Heartbeat event on the Wire | Update last-seen; mark the agent's expected slot as satisfied. |
| Expected-run check (per agent's [schedule](../03-scheduling.md) + `heartbeat_grace`) | Missing run → emit a stale-heartbeat `P1`. |
| **Cron watchdog** (separate Worker) | Reads Flagger's own `last_seen` from KV; if stale past `selfwatch_threshold`, pushes a self-`P1`. |

This watchdog Cron Trigger is the **only** scheduled clock Flagger touches — and it deliberately runs in a *different* Worker so it survives Flagger's own death.

---

## Failure modes & Flagger hooks

Flagger is what other agents hook into — but it can fail too:

| Failure | Effect | Mitigation |
|---------|--------|------------|
| **Flagger Worker dies** | No flags surface; silent blindness. | Externalized Cron **watchdog** ([§self-monitoring](#self-monitoring--heartbeat)) pushes a `P1` from outside. |
| **Push channel down** | `P1`/`P2` don't reach the owner. | Flags still land on the board (`open`); watchdog can fall back to a second channel. |
| **Flag storm** (one root cause, many agents) | Push spam. | Dedupe by signature + correlate via `run_id`; collapse cascades into one flag with linked detail. |
| **Steward backed up** | Board doesn't update. | Flags persist in **D1 first**; the Steward upsert is idempotent and replays safely. |
| **Mis-scored trust** | Owner over/under-reacts. | Severity (deterministic) is the primary signal; trust only modulates. Recurrence re-scores over time. |

---

## Config

KV-backed knobs (matching [../08-flagger.md §13](../08-flagger.md)):

| Key (KV) | Default | Purpose |
|----------|---------|---------|
| `push_severities` | `["P1","P2"]` | Which severities push vs batch. |
| `escalation_window` | `15m` | Re-push an un-ack'd `P1`/`P2` after this. |
| `heartbeat_grace` | `10m` | Slack before a missed run becomes a stale-heartbeat flag. |
| `selfwatch_threshold` | `15m` | Watchdog declares Flagger down past this. |
| `trust_floor_for_push` | `0` | Optional: suppress push below a trust floor (default: push regardless of trust). |
| `mute_rules[]` | `[]` | Signatures to auto-mute (known noise). |
| `severity_overrides` | `{}` | Per-`source_agent`/`kind` severity overrides. |

---

## Example run

**08:21–08:41, Thursday morning.** A real cascade through the [morning pipeline](../02-architecture.md), watched live by Flagger.

**1. 08:21 — [Sundial](sundial.md) fails.** Sundial's `08:20` calendar sync hits a Google Calendar `503` on batch insert and exhausts 4 retries. It emits an incident:

```
{ source_agent:"Sundial", kind:"api_error_exhausted",
  payload:{ http:503, op:"batch_insert", retries:4, affected:3 }, run_id:"r-0529-am" }
```

Flagger derives signature `Sundial|api_error_exhausted|calendar.batch_insert` → **new** flag. Severity = **P2** (a single agent degraded the loop — 3 deadlines un-blocked — but nothing is down). Evidence = caught/exhausted API error → base trust **95**. No mute-rule matches → **push now**, status `open`. Steward upserts it to the board; D1 logs it. Owner taps the push → status flips to `ack`.

**2. 08:30 — [Compass](compass.md) never reports.** Compass's `08:30 plan` run depends on a settled calendar. With Sundial's blocks missing, the run wedges and emits **no heartbeat**.

**3. 08:41 — stale-heartbeat fires.** Flagger's expected-run table says *Compass plan @ 08:30*; `08:30 + heartbeat_grace (10m)` = `08:40` has elapsed with no heartbeat. Flagger mints a stale-heartbeat flag — severity **P1** (a load-bearing daily output, the owner's morning glance, didn't happen), evidence = provably-missing run → trust **100**. The `detail` correlates it to the upstream Sundial `P2` via shared `run_id` (likely cascade). **Pushed immediately**; will re-push every `escalation_window` until ack'd.

**4. 07:46 (earlier the same morning) — a phishing hunch.** [Filer](filer.md)'s `07:45` sweep labeled a thread `⚠ Phishing-Suspect` + `AI/Uncertain` and emitted it. Severity = **P3** (consequence is "human glance," not "fleet down"); evidence = pure-LLM hunch, SPF/DKIM *not* failed → trust **40**. **Batched**, never pushed; per [email taxonomy §5.8](../04-email-taxonomy.md) Flagger reads the signal but **never clicks the link**.

**The board after the morning** (sorted by severity, then trust desc):

```
│ P1 │ 100 │ Compass │ Compass heartbeat stale — no 08:30 run   │ open │
│ P2 │  95 │ Sundial │ Calendar event create failed (3 dl)      │ ack  │
│ P3 │  40 │ Filer   │ Possible phishing: "Payroll update"      │ open │
```

**Auto-resolve.** The owner manually re-runs the chain from Sundial. Sundial's next run succeeds (heartbeat + clean run) → Flagger **auto-resolves** the Sundial `P2` (deterministic recovery). Compass's `08:30` slot can't retroactively un-miss, so its `P1` stays until the owner marks it `resolved`. The Filer `P3` stays `open` — an LLM-judgment flag **always** waits for an owner decision; Atlas won't decide on its own that the phishing call was wrong.

---

## Open questions

- **Trust calibration.** The base bands ([§trust](#how-its-derived)) are a first guess — should they be tuned from real outcomes (was the flag actually right) over the first weeks of running?
- **Escalation breadth.** Does an un-ack'd `P1` escalate to a *second* channel (SMS/email) after a longer window, or just re-push on the same channel?
- **Cascade grouping.** How aggressively to collapse a Sundial→Compass cascade into one parent flag vs. keeping linked children with shared `run_id`?
- **Auto-resolve scope.** Which deterministic recoveries are safe to auto-resolve, and which always need an owner decision (currently: all LLM-judgment flags need a human)?

---

**See also:** [../08-flagger.md](../08-flagger.md) (chapter reference) · [05-dashboard.md](../05-dashboard.md) (the Vault / Flagger board) · [steward.md](steward.md) (write contract) · [03-scheduling.md](../03-scheduling.md) (heartbeat expectations) · [04-email-taxonomy.md](../04-email-taxonomy.md) (`⚠ Phishing-Suspect`, §5.8) · [02-architecture.md](../02-architecture.md) (the Wire / data flow).
