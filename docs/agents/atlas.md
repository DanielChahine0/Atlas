# Atlas (orchestrator)

> **Purpose:** Atlas is the root **orchestrator / supervisor** (roster #0). It schedules cron jobs, routes events on the **Wire**, sequences the morning pipeline, retries failures, enforces confirmation gates, and supervises every sub-agent — but does **no domain work** itself.

## At a glance

| | |
|---|---|
| **Codename** | Atlas |
| **Role** | Root orchestrator / supervisor |
| **Runtime** | Cloud (Cloudflare) — always-on |
| **Trigger** | always-on; owns the schedule (§10), reacts to the Wire |
| **Inputs** | Cron Triggers, events on the Wire, agent success/failure signals, owner commands (on-demand invocations) |
| **Outputs** | sub-agent invocations, messages enqueued on the Wire, run-log entries, incident events to [Flagger](flagger.md) |
| **Dependencies** | the Wire (Cloudflare Queue), [Steward](steward.md) (single writer), [Flagger](flagger.md) (escalation), every sub-agent it supervises |
| **MCPs / tools** | Cloudflare Cron Triggers, Workflows, Queues; D1 (run-log), KV (config/flags), Durable Objects (per-agent coordination); AI Gateway → Claude **Opus** for orchestration/reasoning |
| **Writes to** | the **Wire**, the **schedule** — never the Vault, never Gmail, never the Codex |

Atlas is **infrastructure, not a feature** — it sits above the value ranking alongside [Steward](steward.md) and [The Codex](../07-source-of-truth-codex.md) in the foundational tier (§3). Nothing else works until Atlas, the Wire, and Steward exist (Phase 0 — Spine, §13).

---

## What it does

Atlas embodies the system's five design pillars (§0) by being the only component that has a fleet-wide view:

1. **Schedules** all cron-driven runs from the canonical schedule (§10) via Cloudflare **Cron Triggers**.
2. **Routes** events on the **Wire** (Cloudflare Queue) — the shared event bus — from producers to consumers, and fans everything into [Steward](steward.md).
3. **Sequences** the multi-step morning pipeline (`Filer → Herald → Forge → Sundial → Compass`) as a durable, start-after-success chain.
4. **Retries** transient failures with backoff and **times out** stuck steps.
5. **Enforces confirmation gates** before any irreversible / outward-facing action ([Usher](usher.md) registering/paying, [Envoy](envoy.md) posting, any delete).
6. **Supervises** every sub-agent — collects success/failure, writes the run-log, and **escalates to [Flagger](flagger.md)** when something is notable.

What Atlas explicitly does **not** do:

- It does **not** label email, write tasks, plan days, or touch the Vault. Those are domain agents' jobs.
- It does **not** fetch *for* Steward. Steward is fed and fetches nothing (§4, §6.4); Atlas only ensures events reach Steward's queue in order.
- It does **not** itself mutate any external system. One writer per resource (Pillar 1) means Atlas owns coordination, not content.

---

## How it works

### Owning the schedule

Atlas is the single place where Cloudflare **Cron Triggers** are registered. The full canonical schedule lives in [scheduling](../03-scheduling.md) (§10); Atlas is its executor. Key triggers Atlas fires:

| Time / trigger | Agent | Mode | Atlas's job |
|----------------|-------|------|-------------|
| continuous | [Filer](filer.md) | event | route Gmail-push events to Filer in near-real-time |
| **07:45 daily** | [Filer](filer.md) | sweep | pre-Herald label sweep |
| **08:00 daily** | [Herald](herald.md) | daily | start morning chain (after Filer sweep succeeds) |
| **08:15 daily** | [Forge](forge.md) | morning | extract tasks from `① Action Required` |
| **08:20 daily** | [Sundial](sundial.md) | sync | deadline tasks → Google Calendar |
| **08:30 daily** | [Compass](compass.md) | plan | day plan from settled tasks + calendar |
| **21:00 daily** | [Compass](compass.md) | preview | next-day preview / prep |
| **09:00 daily (light)** | [Headhunter](headhunter.md) | deadlines | cheap imminent-deadline check |
| **Mon 09:00** | [Headhunter](headhunter.md) | full | full board scan + hiring-window update |
| **Fri 16:00** | [Scout](scout.md) | weekly | events digest (parallel with weekly Herald) |
| **Fri 16:00** | [Herald](herald.md) | weekly | weekly email review (parallel with Scout) |
| **Fri 16:30** | weekly-review build | — | tells [Steward](steward.md) to compile the weekly summary |
| event: meeting starts | [Echo](echo.md) | live | local trigger; Atlas tracks the run, does not host it |
| event: meeting ends | [Archivist](archivist.md) | — | start after Echo transcript is ready |
| on-demand | [Usher](usher.md), [Quill](quill.md), [Envoy](envoy.md), [Librarian](librarian.md), [Switchboard](switchboard.md) | — | user-initiated; Atlas dispatches and applies gates |
| event-driven | [Steward](steward.md), [Flagger](flagger.md) | — | fed by other agents; Atlas never self-schedules them |

> Atlas never *invents* a schedule. If §10 and this table disagree, §10 (via [scheduling](../03-scheduling.md)) wins.

### Owning the Wire

The **Wire** is the Cloudflare **Queue** event bus. Atlas owns it: it publishes invocation/control messages and routes producer output to consumers. Every domain agent that needs to change dashboard state emits an event onto the Wire; Atlas guarantees it reaches [Steward](steward.md), the **single serialized writer** (§6.4).

```
 producers                          the Wire (queue)            single consumer
 ─────────                          ────────────────            ───────────────
 Usher ─┐
 Headhunter ─┤
 Scout ─┤
 Envoy ─┤──▶  Atlas routes ──▶  [ ordered queue ]  ──▶  Steward ──▶ The Vault
 Forge ─┤
 Compass ─┤
 Flagger ─┘
```

Steward's write contract (§6.4) carries the idempotency guarantee, and Atlas preserves it:

- Event shape on the Wire: `{ agent, type, entity, op: "increment"|"upsert"|"append", payload, idempotencyKey }`.
- Atlas **does not** dedupe or coalesce payloads — it preserves the `idempotencyKey` end-to-end so a replay can't double-count. **Idempotent + observable** (Pillar 5) means every route is safe to repeat.
- Writes are **serialized** at Steward (single consumer / lock) regardless of how many agents fire at once. Atlas's job is ordering and delivery, not arbitration of content.

### Sequencing the morning pipeline

The morning chain is **strictly sequential** — each step consumes the prior step's output (§4, §10). Atlas runs it as a Cloudflare **Workflow** (durable, resumable across steps) so a mid-pipeline failure doesn't lose completed work.

```
07:45  Filer (sweep) ──▶ 08:00 Herald (daily) ──▶ 08:15 Forge ──▶ 08:20 Sundial ──▶ 08:30 Compass
        label first              digest reads        tasks          deadlines→cal     day plan
        (start-after-success at each arrow)                                              │
                                                                                         ▼
                              all steps emit Wire events ──────────────────────▶  Steward ─▶ Vault
```

Rules Atlas enforces here:

- **Start-after-success.** Each step starts only after the previous one reports success. Filer's sweep must finish before Herald reads labels (label first, then digest — §4).
- **Sequential, not parallel.** The morning chain never overlaps internally.
- **Friday 16:00 is the exception.** [Scout](scout.md) (weekly) and [Herald](herald.md) (weekly) run **in parallel** — independent sources — then both fan into Steward. Atlas dispatches them concurrently and waits for both before the **Fri 16:30** weekly-review build.
- **Echo runs in parallel with everything** (real-time, local); Atlas never blocks the morning chain on it.
- **Headhunter's weekly-full** and the Friday digests may overlap — they touch different state, so Atlas lets them run concurrently.

### Retry / timeout policy

Because every run is idempotent (Pillar 5, and the `idempotencyKey` contract), Atlas can safely retry without fear of double-effects:

| Concern | Atlas policy |
|---|---|
| **Transient failure** (timeout, 5xx, rate limit) | retry with exponential backoff; bounded attempts per step |
| **Rate limits** (e.g. Gmail API for Filer) | back off and re-enqueue; the agent itself also batches (§5.8) |
| **Stuck step** | per-step timeout; on expiry, abort the step and mark it failed |
| **Step failure after retries exhausted** | stop the dependent chain (don't run Sundial if Forge failed), emit a [Flagger](flagger.md) incident, continue independent runs |
| **Replay / re-run** | safe — idempotent by design; preserve `idempotencyKey` so counters don't double-count |
| **Workflow crash mid-pipeline** | Cloudflare Workflows resume from the last durable step; completed steps are not re-executed destructively |

A failed *non-blocking* run (e.g. the 09:00 light Headhunter check) is flagged but does **not** halt unrelated schedules. A failed *blocking* step in the morning chain halts only its downstream dependents.

### Enforcing confirmation gates

Atlas is where **Suggest, don't destroy** (Pillar 2) is mechanically enforced. Anything irreversible or outward-facing is gated behind explicit human confirmation (§12) before the action runs:

- [Envoy](envoy.md) posting to LinkedIn / X / GitHub / portfolio (public posts are irreversible).
- [Usher](usher.md) registering or paying (captcha / payment / ToS risk).
- **Any delete**, anywhere.

Atlas's default for every gated action is **draft + ask**: the agent produces a draft/recommendation, Atlas holds the irreversible step, the owner confirms, then Atlas releases it. [Filer](filer.md) never archives or deletes (labels only, §5.8) — so its runs are never gated, but its `Suggest/Delete` / `Suggest/Unsubscribe` recommendations stay recommendations until the owner acts.

### Escalating to Flagger

Atlas is the fleet-wide supervisor, so it is the natural source of incident events. When a run errors, a step times out, a dependency is missing, or a confidence is low, Atlas emits a flag to [Flagger](flagger.md) (§8) using the canonical shape:

```
{ id, ts, source_agent, severity, trust, title, detail, suggested_action, status }
```

- **Severity** (§8): `P1 Critical` · `P2 High` · `P3 Medium` · `P4 Low / Info`.
- **Trust score (0–100):** how confident Atlas is the flag is real. A caught exception from a supervised run = **high trust**; an LLM "this looks off" = **lower trust**.
- **Routing:** `P1`/`P2` → push notification immediately; `P3`/`P4` → batched into the dashboard Flagger feed.
- **Status** lifecycle: `open → ack → resolved → muted`.
- Flagger writes to the Vault **via [Steward](steward.md)** like every other agent — Atlas does not write the flag to the Vault directly. **Self-monitoring:** Atlas also flags the **heartbeat going stale** so a silent orchestrator failure surfaces.

### Staying out of Steward's way

[Steward](steward.md) is the **sole Vault writer** (Pillar 1, §6.4). Atlas respects single-writer discipline rigorously:

- Atlas **never** writes the Vault. It routes events *toward* Steward and lets Steward apply them.
- Atlas **never** fetches data on Steward's behalf — Steward fetches nothing; it is fed (§4, §6.4).
- Atlas guarantees **serialization** by routing all Vault-bound events through the single Wire consumer; it never opens a second writer path.
- Atlas preserves Steward's `op` and `idempotencyKey` untouched so `increment` counters stay replay-safe.

The same discipline applies to other single-writer resources: [Filer](filer.md) owns Gmail labels, [Sundial](sundial.md)/[Usher](usher.md) own Google Calendar writes, [The Codex](../07-source-of-truth-codex.md) is read-only except via the explicit "update my profile" flow. Atlas coordinates; it never becomes a second writer.

---

## Inputs / Outputs

**Inputs**

- **Cron Triggers** — the §10 schedule.
- **Wire events** — producer output, success/failure signals, [Flagger](flagger.md)-bound incidents.
- **Agent run results** — success/fail/timeout from each supervised invocation.
- **Owner commands** — on-demand invocations (e.g. [Usher](usher.md), [Quill](quill.md), [Envoy](envoy.md), [Librarian](librarian.md), [Switchboard](switchboard.md)) and confirmation responses at gates.

**Outputs**

- **Sub-agent invocations** (with mode, e.g. Herald `daily` vs `weekly`).
- **Routed Wire messages** to consumers and to [Steward](steward.md).
- **Run-log entries** in D1 (feeds the Vault's "Agent heartbeat / run log" view, §6.2).
- **Incident events** to [Flagger](flagger.md).

---

## Dependencies

- **The Wire** (Cloudflare Queue) — Atlas owns it; without it there is no routing.
- **[Steward](steward.md)** — the single serialized sink for all Vault-bound events.
- **[Flagger](flagger.md)** — escalation target for every supervised failure.
- **Every sub-agent** — Atlas supervises the whole roster (§2) but depends on none of them for its own logic.
- **Cloudflare primitives** — Cron Triggers (schedule), Workflows (durable pipelines), Queues (the Wire), Durable Objects (per-agent coordination), D1 (run-log/audit), KV (config/flags). See [hosting](../06-hosting-cloudflare-mcp.md).

Atlas is a **dependency-of**, not a **dependency-on**: it is foundational, so the rest of the fleet depends on it, while it depends only on the spine (Wire + Steward + Cloudflare).

---

## Schedule / Triggers

Atlas is **always-on** (Cloud runtime, §2). It does not have its own cron line — it **is** the thing that fires every other cron line in [scheduling](../03-scheduling.md). It reacts continuously to the Wire and to owner commands. Concurrency rules it enforces (§10):

- Morning chain (`Filer→Herald→Forge→Sundial→Compass`) — **strictly sequential**.
- Friday 16:00 — Scout + weekly Herald **parallel**, then fan into Steward, then 16:30 weekly-review build.
- Steward writes — **serialized** no matter how many agents fire.
- Echo — **parallel** with everything.

---

## Failure modes & Flagger hooks

| Failure mode | Detection | Flagger hook |
|---|---|---|
| Morning-chain step fails after retries | start-after-success gate sees no success | `P2 High`, high trust; halt downstream, leave completed steps intact |
| Step exceeds timeout (stuck) | per-step timeout expiry | `P2 High`; abort + retry-or-fail |
| Wire backlog / consumer lag at Steward | queue depth / dwell-time threshold | `P2`/`P3` by depth; Steward stays single-consumer (no second writer to "help") |
| Gated action attempted without confirmation | gate enforcement | `P3 Medium`; action held, owner re-prompted |
| Idempotency violation risk (missing/duplicate `idempotencyKey`) | event validation on the Wire | `P2 High`, high trust; reject malformed event |
| Cron misfire / overlap on shared state | run-log + concurrency rules | `P3`; suppress or serialize the offending overlap |
| **Orchestrator heartbeat stale** | self-monitoring | `P1 Critical`; Flagger flags Atlas/the heartbeat itself (§8) |

Severity → routing follows §8: `P1`/`P2` push immediately; `P3`/`P4` batch into the dashboard feed.

---

## Config

- **Schedule source:** Cloudflare Cron Triggers, derived from §10 / [scheduling](../03-scheduling.md). Single source of truth — no per-agent ad-hoc crons.
- **Retry policy:** max attempts + exponential backoff per step (KV-configurable); per-step timeouts.
- **Gate list:** which actions require confirmation (Envoy post, Usher register/pay, any delete) — see [security & privacy](../11-security-privacy.md) (§12). Default `draft + ask`.
- **Model:** Claude **Opus** for orchestration/reasoning via AI Gateway; cheaper Sonnet/Haiku reserved for high-volume domain passes (e.g. Filer) — not Atlas's concern except routing (§7).
- **State:** D1 for run-log/audit; KV for config/flags; Durable Objects for per-agent coordination (§7).
- **Secrets:** Cloudflare Secrets Store / Wrangler secrets — never in the Vault or Codex (§12).

---

## Example run — a morning kickoff

A normal weekday, owner-local time. Atlas drives the whole chain; no domain logic lives in Atlas.

```
07:45  Cron fires ▸ Atlas invokes Filer (sweep).
       Filer labels fresh threads (① Action Required, Type/*, Needs/*, AI/Reviewed …),
       skips threads already carrying AI/Reviewed, emits a Wire event for counters.
       Atlas: success ✓ → run-log ✓ → release next step.

08:00  Atlas starts the morning Workflow ▸ invokes Herald (mode=daily).
       Herald reads the now-fresh labels, drafts the digest to the owner,
       sends a Wire event to Steward (email counters: action-required, processed-today).
       Atlas: success ✓ → start-after-success → next.

08:15  Atlas invokes Forge (mode=morning).
       Forge extracts tasks from ① Action Required (with deadlines), Wire-events to Steward.
       ── Forge throws (Gmail rate limit). ──
       Atlas: retry w/ backoff ▸ attempt 2 succeeds ✓.
       (Had it exhausted retries → halt Sundial+Compass, P2 flag to Flagger, push.)

08:20  Atlas invokes Sundial (mode=sync) — only because Forge succeeded.
       Deadline tasks → Google Calendar; Wire-event to Steward.   ✓

08:30  Atlas invokes Compass (mode=plan).
       Compass reads settled tasks + the now-current calendar → builds the day plan,
       Wire-events to Steward (Today view, top-3 priorities).      ✓

       Throughout: every Steward-bound event flows the single Wire path,
       idempotencyKey preserved, Steward writes the Vault serially.

08:31  Owner opens the Vault "morning glance": top-3 priorities, action-required
       emails, deadlines next 7 days, today's meetings, open flags, waiting-on.
       Atlas's run-log shows all five steps green in the heartbeat view.
```

If instead the **08:00 Herald** step had stalled past its timeout, Atlas would abort it, retry once, and on a second failure: stop the chain (no Forge/Sundial/Compass), emit a `P2 High` flag to [Flagger](flagger.md) (high trust — caught at the supervisor), and push it to the owner — leaving the Vault untouched rather than half-written.

---

## Open questions

- **Backpressure on the Wire:** at what queue depth / dwell time does Steward lag become a `P2` vs `P3`? Single-consumer is non-negotiable, so the lever is alerting + retry, not a second writer.
- **Retry budgets per agent:** are bounds uniform, or should high-volume agents (Filer) get a different backoff curve than the morning chain?
- **Gate UX:** where do confirmation prompts surface — push notification, Vault inbox, or both — and what's the timeout/expiry on an unanswered gate?
- **Partial-pipeline recovery:** if Forge succeeds but Sundial fails, should Compass run on the available tasks-without-calendar, or wait for a Sundial re-run?
- **Schedule drift / DST:** Cron Triggers are UTC-based; how is owner-local time (and DST shifts) reconciled for the 07:45–08:30 chain?
- **Heartbeat cadence:** how stale is "stale" before Atlas self-flags `P1` (§8)?
