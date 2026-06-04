# Flagger — incident & issue flagging (SPEC §8)

**Purpose:** When anything notable goes wrong across the Atlas fleet — an agent error, a dashboard inconsistency, a missed deadline, a low-confidence action, or a possible phishing email — **Flagger** turns it into a structured **flag** with a **severity** (`P1`–`P4`) and a **0–100 trust/confidence score** so the owner knows how much to believe it and how fast to react.

## At a glance

| | |
|---|---|
| **Codename** | **Flagger** (incident/issue flagging with severity + trust score) — agent #15 |
| **Runtime** | Cloud (Cloudflare Worker + a per-agent Durable Object for live flag state) |
| **Trigger** | Event-driven — receives error/incident events from **every** agent over [the Wire](02-architecture.md); never self-scheduled |
| **Inputs** | Incident events `{ source_agent, kind, payload }`, run-log entries (D1), heartbeats from every agent |
| **Outputs** | **Flags** (severity + trust + status), [push notifications](#9-routing-p1p2-push-vs-p3p4-batched) for P1/P2, the [Flagger feed](05-dashboard.md) for P3/P4 |
| **Dependencies** | [Steward](agents/steward.md) (sole Vault writer), the Wire (Cloudflare Queue), D1 run-log / audit log, KV (flag config) |
| **MCPs / tools** | Push-notification channel; D1; KV; reads (does not click) `⚠ Phishing-Suspect` / `AI/Uncertain` signals from [Filer](agents/filer.md) |
| **Writes to** | [The Vault](05-dashboard.md) **via [Steward](agents/steward.md)** only (event-bus `append`/`upsert`) — Flagger never writes the Vault directly |

> Flagger is **Tier 2** (high value, weekly cadence in the importance ranking) but its value compounds as the fleet grows: more agents → more failure surface → Flagger is how the owner stays ahead of it. See [01-agent-roster.md](01-agent-roster.md) and the per-agent spec at [agents/flagger.md](agents/flagger.md).

---

## 1. What it does

Flagger is the fleet's **observability + alerting** layer. It does **no domain work** — it consumes incident events that other agents emit, scores and classifies each one, deduplicates, decides how loud to be, and hands a clean flag to [Steward](agents/steward.md) for the Vault. Concretely:

- **Catches the explicit failures** every other agent reports (caught exceptions, MCP/API errors, rate-limit backoffs, OAuth-token expiry, queue retries exhausted).
- **Catches the soft failures** — a missed deadline that no task covered, a dashboard counter that drifted, an LLM low-confidence action (`AI/Uncertain`), a possible phishing email (`⚠ Phishing-Suspect`).
- **Watches the fleet's pulse** — every scheduled agent emits a heartbeat; Flagger flags when one goes **stale** (didn't run when [scheduling](03-scheduling.md) said it should).
- **Watches itself** — Flagger emits and checks its own heartbeat so a dead Flagger doesn't fail silently (see [§11 self-monitoring](#11-self-monitoring--heartbeat)).
- **Decides loudness** — `P1`/`P2` push immediately; `P3`/`P4` batch into the dashboard feed.

What it does **not** do: it never auto-remediates, never clicks links in suspect mail, never archives/deletes, and never mutates another agent's state. It **suggests** an action (`suggested_action`) and leaves the doing to the owner — per the *suggest, don't destroy* pillar.

---

## 2. Severity levels (P1–P4)

Severity answers **"how bad / how urgent is this?"** — independent of how confident we are it's real (that's trust, §3).

| Severity | Meaning | Examples | Routing |
|----------|---------|----------|---------|
| **P1 Critical** | The fleet (or a load-bearing piece) is down or a real, time-sensitive harm is in progress. Owner should look **now**. | Steward write-loop wedged; the Wire backed up; a scheduled agent's heartbeat **stale**; OAuth revoked so Gmail/Calendar access is dead. | **Push immediately** |
| **P2 High** | A single agent failed or produced a wrong/blocking result; the loop degraded but isn't down. Owner should look **today**. | [Forge](agents/forge.md) threw on a malformed thread; [Sundial](agents/sundial.md) couldn't create a calendar event; [Compass](agents/compass.md) ran with a partial task set. | **Push immediately** |
| **P3 Medium** | Something needs a human glance but nothing is broken right now. | Possible-phishing email (`⚠ Phishing-Suspect`); `AI/Uncertain` triage decision; a counter that looks off; a near-miss deadline. | **Batched** into feed |
| **P4 Low / Info** | Noted for the record; no action expected. | A rate-limit backoff that self-recovered; a retried-then-succeeded queue message; a routine heartbeat-OK roll-up. | **Batched** into feed |

**Severity is set by the source signal, not the LLM.** A caught exception in a critical-path agent maps to `P1`/`P2` deterministically; an LLM judgment ("this email looks like phishing") maps to `P3` because the *consequence* is "human glance," not "fleet down." Trust then modulates how the owner reads it.

---

## 3. The trust / confidence score (0–100)

Trust answers a **different** question than severity: **"how confident is Atlas that this flag is real and correctly diagnosed?"** A caught exception is near-certain (high trust). An LLM hunch is fuzzy (lower trust). Severity tells you *how bad if true*; trust tells you *how likely true*. The owner reads them together.

### 3.1 How it's derived

Trust starts from the **kind of evidence** behind the flag, then gets adjusted:

| Evidence source | Base trust | Why |
|-----------------|-----------:|-----|
| Caught exception / non-2xx API error / queue retries exhausted | **90–100** | Deterministic, the machine actually saw it fail. |
| Stale heartbeat (agent provably didn't run on schedule) | **100** | Binary fact: the scheduled run is missing. |
| Counter / invariant check (dashboard math doesn't reconcile) | **75–90** | Rule-based, but could be a benign data-shape edge case. |
| Deadline/SLA miss inferred from data | **60–80** | Depends on input completeness. |
| LLM classification with a tool-confirmed signal (e.g. SPF/DKIM fail + `⚠ Phishing-Suspect`) | **45–65** | Model judgment, partly corroborated. |
| Pure LLM judgment ("this looks suspicious / unusual") | **20–45** | A hunch worth surfacing, easy to be wrong. |

**Adjustments** (clamped to 0–100):
- **+** corroboration from a second independent signal (e.g. phishing hunch *and* a known-bad sender domain).
- **+** the same flag recurring across runs (a flaky pattern is more real than a one-off).
- **−** the source agent is itself in a degraded/uncertain state.
- **−** the flag depends on data Flagger knows is incomplete (e.g. Filer hadn't finished its sweep).

### 3.2 Reading severity × trust

```
        trust →   low (0–40)        mid (40–70)        high (70–100)
severity ↓
 P1/P2          investigate, but    push + verify       push, act now
                may be noise         the diagnosis       (machine-certain)
 P3/P4          log, low priority    glance when free    fix at leisure
```

A `P1 / trust 100` (stale heartbeat) is *do this now*. A `P3 / trust 40` (LLM phishing hunch) is *glance, don't trust blindly, never click*.

---

## 4. The flag shape (schema)

The canonical flag record (SPEC §8). Persisted in D1; mirrored into the Vault by Steward.

```jsonc
{
  "id": "flg_2026-05-29_a1b2c3",   // stable, dedupe-keyed
  "ts": "2026-05-29T08:31:14Z",    // ISO 8601, owner-local rendered in Vault
  "source_agent": "Sundial",       // codename of the emitting agent (or "Flagger" for self-flags)
  "severity": "P2",                // P1 | P2 | P3 | P4
  "trust": 95,                     // 0–100 (see §3)
  "title": "Sundial: calendar event create failed (3 deadlines)",  // one line, ≤ ~80 chars
  "detail": "Google Calendar API 503 on batch insert after 4 retries; 3 'apply by' tasks have no calendar block.",
  "suggested_action": "Re-run Sundial sync; if it persists, check Calendar OAuth scope/quota.",
  "status": "open"                 // open | ack | resolved | muted
}
```

**Field notes**
- `id` is derived from a **dedupe key** (`source_agent` + `kind` + a normalized signature) so the same recurring failure updates one flag instead of spamming new ones. Recurrence bumps trust (§3.1) and appends to `detail`.
- `source_agent` is always a roster codename from [§2 of the spec](01-agent-roster.md); self-flags use `"Flagger"`.
- `title` is what shows on the [Flagger board](#10-vault-flagger-board); `detail` is the click-through.
- `suggested_action` is advisory only — Flagger never executes it.

---

## 5. Status lifecycle

```
        emit
         │
         ▼
      ┌──────┐   owner sees / acknowledges   ┌─────┐   fixed (by owner or auto-clear)   ┌──────────┐
      │ open │ ────────────────────────────▶ │ ack │ ─────────────────────────────────▶ │ resolved │
      └──────┘                               └─────┘                                     └──────────┘
         │                                      │
         │  owner / rule says "stop alerting"   │
         └──────────────────────────────────────┴────────────────────▶  ┌───────┐
                                                                         │ muted │
                                                                         └───────┘
```

| Status | Meaning | How it's set |
|--------|---------|--------------|
| **open** | New, unhandled. P1/P2 have already pushed. | On emit. |
| **ack** | Owner has seen it; not yet fixed. Suppresses re-push for the same `id`. | Owner taps the push / marks it on the board. |
| **resolved** | The underlying condition cleared. | Owner marks it, **or** Flagger auto-resolves when the signal recovers (e.g. heartbeat returns, next run succeeds). |
| **muted** | Known/expected noise — stop alerting for this `id` or signature. | Owner mutes, or a KV mute-rule matches. Muted flags still log (audit), just don't push or surface. |

Auto-resolution is conservative: only **deterministic** recoveries auto-resolve (heartbeat back, error condition gone on the next run). LLM-judgment flags (`⚠ Phishing-Suspect`, `AI/Uncertain`) require an **owner** decision — Atlas won't decide on its own that a phishing call was wrong.

---

## 6. How it works (pseudo-flow)

```
1. Receive incident event off the Wire:  { source_agent, kind, payload, run_id }
2. Normalize → derive dedupe signature.
3. Look up existing open/ack flag by signature:
     ├─ exists  → bump recurrence, re-score trust, append detail, keep status
     └─ new     → create flag
4. Assign severity   (deterministic map: kind + source_agent criticality)
5. Compute trust     (§3: base by evidence + adjustments, clamp 0–100)
6. Apply mute-rules (KV) → if matched, status = muted, skip routing.
7. Route (§9):
     ├─ P1 / P2 → push notification now
     └─ P3 / P4 → enqueue for the batched dashboard feed
8. Emit a Steward event on the Wire:
     { agent:"Flagger", type:"flag", entity:"flag", op:"upsert", payload:<flag>, idempotencyKey:id }
9. Persist to D1 (audit log). Done.
```

Step 8 uses the standard [Steward write contract](05-dashboard.md) (`op: "upsert"` keyed by `idempotencyKey: id`) so a replayed event can't create a duplicate board row. Flagger **fetches nothing** from the Vault — like every agent, it feeds Steward and Steward writes.

---

## 7. Inputs & outputs

**Inputs**
- Incident events from every agent (errors, backoffs, exhausted retries, partial results).
- Heartbeats from every scheduled agent + Flagger's own.
- Run-log / audit entries from D1 (to detect missing or late runs).
- Low-confidence signals surfaced by [Filer](agents/filer.md): `AI/Uncertain`, `⚠ Phishing-Suspect`.
- Invariant/counter snapshots from [Steward](agents/steward.md) (to detect dashboard drift).

**Outputs**
- A scored, deduped **flag** record (§4).
- A **push notification** for P1/P2.
- A **Steward upsert event** that lands the flag on the Vault [Flagger board](#10-vault-flagger-board) (P3/P4 land here only, batched).
- An **audit-log** row in D1 (every flag, including muted ones).

---

## 8. Dependencies

| Depends on | For |
|------------|-----|
| **The Wire** (Cloudflare Queue) | Receiving incident events in, sending Steward events out. |
| [Steward](agents/steward.md) | The **only** path to the Vault; serialized, idempotent writes. |
| **D1** | Audit log + run-log queries (detect missing runs). |
| **KV** | Mute-rules + flag config (severity overrides, thresholds). |
| Every agent | They must **emit** incident + heartbeat events — Flagger is only as good as what's reported (the *idempotent + observable* pillar). |

Flagger is **not** a dependency of the morning pipeline — it sits to the side and observes. The pipeline runs whether or not Flagger is healthy (which is exactly why Flagger watches itself, §11).

---

## 9. Routing (P1/P2 push vs P3/P4 batched)

```
P1 Critical ─┐
P2 High      ┴─▶  PUSH NOW  ──▶  owner device  (and still lands on the board)
P3 Medium    ─┐
P4 Low/Info  ┴─▶  BATCH  ──▶  Flagger feed on the Vault (no interruption)
```

- **P1/P2 → push immediately.** One push per distinct `id`; once `ack`'d, the same flag won't re-push (recurrence updates the existing flag silently). A still-`open` P1 that hasn't been ack'd within a window **re-pushes** (escalation), so a missed first alert isn't lost.
- **P3/P4 → batched** into the [Flagger feed](05-dashboard.md). They appear at the next dashboard build (e.g. the morning glance, the Friday weekly-review at **Fri 16:30**) with no interruption.
- **Muted** flags route nowhere; they only hit the D1 audit log.

---

## 10. Vault Flagger board

The `Flagger feed` view in [The Vault](05-dashboard.md) (dashboard §6.2). One row per flag, **sorted by severity, then by trust descending** — so the most-urgent, most-believable flags sit on top. Titles are one line; the title click-throughs to the detail note.

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

Board columns map directly to flag fields: **Sev** = `severity`, **Trust** = `trust`, **Agent** = `source_agent`, **Title** = `title` (linked to a note holding `detail` + `suggested_action`), **Status** = `status`. The header shows Flagger's own heartbeat (§11) so a dead board is visibly dead.

---

## 11. Self-monitoring & heartbeat

Flagger watches the fleet **and itself** — a monitor that can fail silently is worse than no monitor.

**Fleet heartbeats.** Every scheduled agent emits a heartbeat tied to its [scheduling](03-scheduling.md) slot. Flagger holds the expected-run table and flags a **stale heartbeat** (`P1`, trust `100`) when an agent didn't run when it should have — e.g. no `Compass` heartbeat by **08:30 + grace**, or no `Filer` sweep by **07:45 + grace**.

**Self-heartbeat.** Flagger emits its own heartbeat each cycle. Because Flagger can't reliably flag its own death from inside a dead worker, the check is **externalized**:

```
Flagger ─heartbeat→ KV (last_seen=ts)
                     │
   Cloudflare Cron ──┴─▶ watchdog Worker:  if (now - last_seen) > threshold
                                            → push "Flagger may be down" (P1)
                                            → Steward upsert a self-flag
```

A lightweight **Cron-triggered watchdog** (separate from the main Flagger Worker, [hosting §7](06-hosting-cloudflare-mcp.md)) reads `last_seen` from KV; if Flagger has gone quiet past threshold it pushes a `P1` "Flagger may be down" and writes a self-flag with `source_agent: "Flagger"`. This is the one case where the alert path doesn't depend on the thing it's alerting about.

---

## 12. Example flags

Three flags spanning the severity × trust space (these are the rows in the board above).

### 12.1 Agent exception — `P2 / trust 95`

```jsonc
{
  "id": "flg_2026-05-29_sundial_calins",
  "ts": "2026-05-29T08:21:03Z",
  "source_agent": "Sundial",
  "severity": "P2",
  "trust": 95,
  "title": "Sundial: calendar event create failed (3 deadlines)",
  "detail": "Google Calendar API returned 503 on batch insert, 4 retries exhausted at 08:21. 3 'apply by' tasks from Forge have no calendar block. Tasks themselves are intact.",
  "suggested_action": "Re-run Sundial sync. If it recurs, check Calendar OAuth scope and per-minute quota.",
  "status": "ack"
}
```
High trust (90–100 band): a real, caught API failure with retries exhausted — the machine saw it fail. `P2`, not `P1`, because the loop degraded (3 deadlines un-blocked) but nothing is down. **Pushed**, owner ack'd.

### 12.2 Possible-phishing email — `P3 / trust 40`

```jsonc
{
  "id": "flg_2026-05-29_filer_phish_payroll",
  "ts": "2026-05-29T07:46:55Z",
  "source_agent": "Filer",
  "severity": "P3",
  "trust": 40,
  "title": "Possible phishing: \"Payroll update\" from unknown sender",
  "detail": "Thread labeled ⚠ Phishing-Suspect + AI/Uncertain. LLM judgment: urgent tone + credential-looking link + lookalike display name. SPF/DKIM not failed, so partly uncorroborated. Per §5.8, link NOT followed.",
  "suggested_action": "Owner: glance at the thread. Do NOT click the link. If legit, mark resolved; if phishing, delete manually.",
  "status": "open"
}
```
Low trust (20–45 band): a model **hunch** with only partial corroboration — easy to be wrong, so the owner shouldn't trust it blindly, and Atlas won't auto-act. `P3` because the consequence is "human glance," not "fleet down." **Batched** into the feed, never pushed. Note Flagger reads the suspect signal but, per [email taxonomy §5.8](04-email-taxonomy.md), **never clicks the link**.

### 12.3 Stale heartbeat — `P1 / trust 100`

```jsonc
{
  "id": "flg_2026-05-29_compass_heartbeat",
  "ts": "2026-05-29T08:41:00Z",
  "source_agent": "Compass",
  "severity": "P1",
  "trust": 100,
  "title": "Compass heartbeat stale — no 08:30 run",
  "detail": "Expected Compass 'plan' run at 08:30 (after Sundial). No heartbeat by 08:40 (10-min grace elapsed). Day plan for today is missing. Upstream Sundial reported P2 at 08:21 — possible cascade.",
  "suggested_action": "Check Compass Worker / Cron Trigger and the Sundial failure above. Manually re-run the morning chain from Sundial if needed.",
  "status": "open"
}
```
Trust `100`: a **binary fact** — the scheduled run is provably missing. `P1` because a load-bearing daily output (the day plan, the owner's morning glance) didn't happen. **Pushed immediately**; re-pushes on the escalation window until ack'd. The `detail` links it to the upstream Sundial P2, surfacing the likely cascade.

---

## 13. Config

| Key (KV) | Default | Purpose |
|----------|---------|---------|
| `push_severities` | `["P1","P2"]` | Which severities push vs batch. |
| `escalation_window` | `15m` | Re-push an un-ack'd P1/P2 after this. |
| `heartbeat_grace` | `10m` | Slack before a missed run becomes a stale-heartbeat flag. |
| `selfwatch_threshold` | `15m` | Watchdog declares Flagger down past this. |
| `trust_floor_for_push` | `0` | Optional: suppress push below a trust floor (default: push regardless of trust — severity decides loudness). |
| `mute_rules[]` | `[]` | Signatures to auto-mute (known noise). |
| `severity_overrides` | `{}` | Per-`source_agent`/`kind` severity overrides. |

---

## 14. Failure modes & Flagger hooks

Flagger is the thing other agents hook into — but it can fail too:

| Failure | Effect | Mitigation |
|---------|--------|------------|
| **Flagger Worker dies** | No flags surface; silent blindness. | Externalized Cron **watchdog** (§11) pushes a P1 from outside. |
| **Push channel down** | P1/P2 don't reach the owner. | Flags still land on the board (`open`); watchdog can fall back to a second channel. |
| **Flag storm** (one root cause, many agents) | Push spam. | Dedupe by signature + correlate via `run_id`; collapse cascades into one flag with linked detail. |
| **Steward backed up** | Board doesn't update. | Flags persist in D1 first; Steward upsert is idempotent and replays safely. |
| **Mis-scored trust** | Owner over/under-reacts. | Severity (deterministic) is the primary signal; trust modulates. Recurrence re-scores. |

---

## 15. Open questions

- **Trust calibration:** the base bands (§3.1) are a first guess — should they be tuned from real flag outcomes (was the flag actually right) over the first weeks?
- **Escalation breadth:** does an un-ack'd P1 escalate to a second channel (SMS/email) after a longer window, or just re-push?
- **Cascade grouping:** how aggressively to collapse a Sundial→Compass cascade into one parent flag vs. keeping linked children?
- **Auto-resolve scope:** which deterministic recoveries are safe to auto-resolve, and which always need an owner decision (currently: all LLM-judgment flags need a human)?

---

**See also:** [agents/flagger.md](agents/flagger.md) (per-agent spec & example run) · [05-dashboard.md](05-dashboard.md) (the Vault / Flagger board) · [agents/steward.md](agents/steward.md) (write contract) · [03-scheduling.md](03-scheduling.md) (heartbeat expectations) · [04-email-taxonomy.md](04-email-taxonomy.md) (`⚠ Phishing-Suspect`, §5.8 cautions).
