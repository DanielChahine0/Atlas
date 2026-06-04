# Filer (email labeler)

> **Purpose:** Apply the Atlas email-label taxonomy to incoming Gmail threads in near-real-time and on a pre-Herald sweep — **labels only, never archives or deletes** — so that [Herald](herald.md) reads fresh, structured labels and [Forge](forge.md) can turn the `Needs/*` labels into tasks.

Filer is **roster #2** and the second-highest **Tier 1** agent: it makes Herald's job possible because *labels are the substrate* the rest of the morning pipeline reads. See [agent roster](../01-agent-roster.md) and [email taxonomy](../04-email-taxonomy.md) for the full label list (SPEC §5).

---

## At a glance

| Field | Value |
|-------|-------|
| **Codename** | Filer |
| **Role** | Email labeler / tagger (never archives/deletes) |
| **Runtime** | Cloud (Cloudflare Worker; Durable Object for per-account cursor + dedupe state) |
| **Trigger** | Continuous Gmail push as mail arrives **+ 07:45 daily** pre-Herald sweep |
| **Inputs** | New/changed Gmail threads; the label taxonomy (SPEC §5); `From/VIP` & `From/Company/*` hints |
| **Outputs** | Gmail labels applied to threads (triage / type / needs / due / from / suggest / agent-state) |
| **Writes to** | **Gmail labels only** (`gmail.modify` scope — no delete) |
| **Reads from** | Gmail (threads, message bodies, headers, existing labels) |
| **MCPs / tools** | Gmail MCP: `list_labels`, `create_label`, `label_thread`, `search_threads` |
| **Dependencies** | None upstream. **Runs before Herald** (label first, then digest reads labels) |
| **Downstream** | [Herald](herald.md) (reads labels), [Forge](forge.md) (reads `Needs/*`), [Flagger](../08-flagger.md) (`⚠ Phishing-Suspect`, `AI/Uncertain`) |
| **Idempotency** | `AI/Reviewed` label — skip any thread already carrying it |
| **Model** | Cheap high-volume pass (Sonnet/Haiku via AI Gateway) per SPEC §7 |

---

## What it does

Filer reads each new or updated Gmail **thread**, decides which labels apply, and writes them. It never touches the mailbox structure — **manual archiving and deleting stay with the owner** (SPEC §5, §5.8). Its label decisions span the seven groups defined in [SPEC §5](../04-email-taxonomy.md):

| Group | Labels | Rule |
|-------|--------|------|
| **§5.1 Triage** | `① Action Required` · `② Action Recommended` · `③ Awaiting Reply` · `④ FYI / Read Later` · `⑤ No Action` | **Mutually exclusive — exactly one** |
| **§5.2 Type** | `Type/Job` (+ `Job/Application` `Job/Recruiter` `Job/OA` `Job/Interview` `Job/Offer` `Job/Rejection`), `Type/Events` (+ `Events/Invite` `Events/Confirmed` `Events/Reminder`), `Type/Finance` (+ `Finance/Bill` `Finance/Receipt` `Finance/Bank` `Finance/Tax` `Finance/Subscription`), `Type/School` (+ `School/Deadline` `School/Grade` `School/Admin`), `Type/Newsletter`, `Type/Promotion`, `Type/Social`, `Type/Travel`, `Type/Dev`, `Type/Security`, `Type/Personal` | Category — can be multiple, **prefer one** |
| **§5.3 Needs** | `Needs/Reply` · `Needs/Pay` · `Needs/Register` · `Needs/Schedule` · `Needs/Upload` · `Needs/Sign` · `Needs/Decide` | The specific action — **drives Forge** |
| **§5.4 Deadline** | `Due/Today` · `Due/ThisWeek` · `Due/Expired` | Only when a date is detected |
| **§5.5 Relationship** | `From/VIP` · `From/Company/<Name>` · `From/Automated` | `From/VIP` auto-bumps triage priority |
| **§5.6 Suggestion** | `Suggest/Keep` · `Suggest/Delete` · `Suggest/Unsubscribe` | **Filer recommends — the owner decides** |
| **§5.7 Agent-state** | `AI/Reviewed` · `AI/Uncertain` · `⚠ Phishing-Suspect` | Idempotency + trust |

Each parent group is **color-coded** for fast visual scanning (SPEC §5.8); colors are set once at `create_label` time.

---

## How it works

```
                  ┌──────────────────────────────────────────────┐
  Gmail push ───▶ │ 1. enqueue thread id on the Wire             │
  (continuous)    └──────────────────────────────────────────────┘
  07:45 sweep ───▶ search_threads("newer_than:2d -label:AI/Reviewed")
                          │
                          ▼
        ┌─────────────────────────────────────────────────────┐
        │ per thread (batched, see "Batching"):               │
        │  2. has AI/Reviewed?  ── yes ─▶ SKIP (idempotent)   │
        │  3. read latest actionable message                  │
        │  4. classify → candidate label set                  │
        │  5. phishing / security guard                       │
        │  6. contradiction check + confidence                │
        │  7. label_thread(thread_id, finalLabels)            │
        │  8. always add AI/Reviewed (+ AI/Uncertain if low)  │
        └─────────────────────────────────────────────────────┘
```

**0. Bootstrap labels (once / on drift).** `list_labels` → diff against the taxonomy → `create_label` for any missing label (and its parent, e.g. create `Type/Job` before `Job/OA`). Set the group color here. Never touch the **reserved system labels** `INBOX`, `SENT`, `SPAM`, `TRASH` (SPEC §5.8) — they can't be modified.

**1–2. Trigger & idempotency gate.** Continuous runs come from Gmail push notifications; the 07:45 sweep runs `search_threads` for anything newer than the last sweep that lacks `AI/Reviewed`. Either way, **the first check is for `AI/Reviewed`** — if present, the thread is skipped entirely (no re-classification, no label thrash). See [Idempotency](#idempotency).

**3. Pick the message to classify.** Labels are **thread-level**, but a long thread can be mixed. Filer **labels by the latest actionable message** (SPEC §5.8), not the whole history — a resolved 30-message thread whose last message is a new question is `① Action Required`, not `⑤ No Action`.

**4. Classify.** The model proposes one triage label, the best-fit `Type/*` (+ child), any `Needs/*`, a `Due/*` if a date is parseable, relationship labels from sender, and a `Suggest/*`. It returns a per-thread **confidence** used in step 6.

**5. Phishing / security guard.** Run *before* writing (see [Phishing & security handling](#phishing--security-handling)).

**6. Contradiction + confidence check.** Reject any label set that violates the [no-contradictory-labels rule](#no-contradictory-labels). If confidence is below threshold, add `AI/Uncertain` rather than guessing.

**7–8. Write + mark reviewed.** `label_thread` applies the final set; `AI/Reviewed` is **always** added last so the thread is never re-processed. Low-confidence threads also get `AI/Uncertain` for a human glance.

---

## Labeling decision logic

**Triage — pick exactly one (§5.1).** Decision order, first match wins:

```
is it actionable now (deadline / explicit ask)?        ─▶ ① Action Required
should do, not mandatory?                               ─▶ ② Action Recommended
owner already replied / sent, waiting on someone else?  ─▶ ③ Awaiting Reply
informational, worth reading, no action?                ─▶ ④ FYI / Read Later
otherwise (ads, automated noise, nothing to do)         ─▶ ⑤ No Action
```

`From/VIP` **bumps the result up one tier** (e.g. an FYI from a VIP becomes `② Action Recommended`).

**Type (§5.2):** prefer a single `Type/*`. When chosen, also apply the most specific child (`Type/Job` + `Job/OA`). Keep the three lookalikes distinct (SPEC §5.8):

- `Type/Promotion` = marketing / sales / ads.
- `Type/Newsletter` = **opted-in** content digests.
- Transactional mail (receipts, confirmations, bills) → `Type/Finance`, `Type/Travel`, `Events/Confirmed`, etc. — **never** lumped under Promotion.

**Needs (§5.3):** attach when the action is concrete — `Needs/Pay` (a bill), `Needs/Sign` (a document), `Needs/Register` (an event/form). These are the labels [Forge](forge.md) reads to mint tasks, so they must be precise.

**Due (§5.4):** apply only when a date is detected. `Due/Today`, `Due/ThisWeek`, or `Due/Expired` (a past-due deadline still labeled so it surfaces, not hidden).

**Suggest (§5.6):** advisory only. `Suggest/Unsubscribe` on low-value recurring promo; `Suggest/Delete` on transient noise; `Suggest/Keep` on records worth retaining. **Filer never acts on these** — the owner decides.

---

## Idempotency

The `AI/Reviewed` label (§5.7) is the idempotency key for the whole agent.

- **Skip on re-run:** any thread carrying `AI/Reviewed` is never re-classified. The 07:45 sweep query is literally `-label:AI/Reviewed`, so reviewed threads are filtered out at the source.
- **No label thrash:** Filer computes the *delta* between existing and desired labels and only writes additions. It does **not** remove and re-add labels it already set on a prior run.
- **Re-processing a changed thread:** when a **new message** lands on an already-reviewed thread, Gmail push re-fires. Filer re-evaluates against the latest message and may *add* labels (e.g. a reply turns `③ Awaiting Reply` → `① Action Required`); the stale triage label is the **one** case where Filer reconciles the mutually-exclusive group rather than appending.
- **Safe to repeat:** every run is replay-safe (SPEC pillar 5) — re-running the sweep over the same window produces no duplicate work and no duplicate labels.

---

## No-contradictory-labels

Filer enforces a consistency pass (SPEC §5.8) before `label_thread`. The label set is rejected/repaired if it contains:

| Conflict | Why it's invalid |
|----------|------------------|
| `Suggest/Delete` **+** `① Action Required` | You can't be told to delete something you must act on. |
| More than one **§5.1 triage** label | Triage is mutually exclusive — exactly one. |
| `Suggest/Unsubscribe` **+** `Type/Personal` / `From/VIP` | Don't suggest unsubscribing from people. |
| `Type/Promotion` **+** any `Needs/*` | Marketing has no owner action. |
| `⑤ No Action` **+** any `Needs/*` or `Due/*` | "No action" can't carry an action or deadline. |
| `Due/Expired` **+** `① Action Required` (no live ask) | Expired ≠ actionable unless a fresh ask exists. |

On conflict, Filer keeps the **higher-trust** label, drops the loser, and — if the conflict came from genuine ambiguity — adds `AI/Uncertain` so the owner can confirm.

---

## Phishing & security handling

Security mail is sensitive (SPEC §5.8, §12). Filer treats it as **read-and-label only, never act**:

- **`⚠ Phishing-Suspect`** — applied when sender/domain mismatch, urgency + credential ask, or link/display-name spoofing is detected. Filer **never follows links, never auto-acts**, and routes a flag to [Flagger](../08-flagger.md) (the suspicion is also surfaced there with a trust score).
- **`Type/Security`** — 2FA codes, login alerts, password resets, account-security mail. Filer **never clicks links** in these threads and **never reproduces 2FA codes or reset links** anywhere — not in labels, not in any digest [Herald](herald.md) might generate, not in exports (SPEC §5.8).
- **Finance / medical privacy** — labeled (`Type/Finance`, `Finance/Bank`, etc.) so they surface, but details are **never exposed in shared or exported views** (SPEC §5.8).
- A `⚠ Phishing-Suspect` thread gets **no** `Suggest/*` and **no** `Needs/*` — Filer must not nudge any action on suspected phishing.

---

## Batching & rate limits

Gmail API enforces per-user rate limits, so Filer **batches and backs off** (SPEC §5.8, §7):

- **Continuous mode** debounces push notifications into small windows so a burst of mail becomes one batched pass rather than N hot calls.
- **Sweep mode** pages `search_threads` and processes threads in chunks, with a delay between chunks.
- **Exponential backoff with jitter** on `429` / `403 rateLimitExceeded`; partial progress is preserved because every successfully-labeled thread already carries `AI/Reviewed`, so a retried run resumes from where it stopped.
- `list_labels` result is **cached** per run; `create_label` is only called on a real diff (bootstrap or taxonomy drift), never per thread.
- All heavy classification uses the cheap model tier (Sonnet/Haiku) via **AI Gateway** caching to keep volume cost and latency down.

---

## Gmail MCP tools

Filer uses exactly four Gmail MCP tools (SPEC §2, §7). Notably **no delete/archive tool** — least-privilege `gmail.modify`, not delete (SPEC §12).

| Tool | When | Why |
|------|------|-----|
| `list_labels` | Bootstrap / start of run | Read current labels, diff against the taxonomy, cache for the run. |
| `create_label` | Only on diff | Create missing taxonomy labels (parent before child) and set group color. |
| `search_threads` | Sweep mode + targeting | Find `newer_than:2d -label:AI/Reviewed`; also resolve `From/VIP` / `From/Company/*` candidates. |
| `label_thread` | Per thread | Apply the final, conflict-checked label set; always include `AI/Reviewed`. |

---

## Schedule / Triggers

From [scheduling](../03-scheduling.md) (SPEC §10):

| Time / trigger | Mode | Notes |
|----------------|------|-------|
| **continuous** | `event` | Gmail push as mail arrives — label in near-real-time. |
| **07:45 daily** | `sweep` | Pre-Herald sweep so the 08:00 digest reads fresh labels. |

The morning chain **Filer → [Herald](herald.md) → [Forge](forge.md) → [Sundial](sundial.md) → [Compass](compass.md)** is **strictly sequential** (SPEC §10). Filer's 07:45 sweep must finish before Herald starts at 08:00. There is also a **weekly Herald** (Fri 16:00) which relies on labels Filer has been applying continuously all week.

---

## Failure modes & Flagger hooks

| Failure | Handling | Flagger |
|---------|----------|---------|
| Gmail rate-limit (`429`) | Backoff + jitter; resume via `AI/Reviewed` cursor | `P4` if transient; `P3` if sweep misses the 08:00 deadline |
| Push subscription expired / silent | 07:45 sweep is the safety net (catches anything missed) | `P3` — push channel stale |
| Low classification confidence | Add `AI/Uncertain`, don't guess | batched, low severity |
| Suspected phishing | `⚠ Phishing-Suspect`, no links, no action | `P2` with trust score |
| Sweep overruns 08:00 (Herald waiting) | Herald reads whatever's labeled; remainder finishes async | `P2` — pipeline-blocking |
| Reserved-label write attempt | Hard-blocked before the call | `P3` — taxonomy/config bug |
| Contradictory labels detected pre-write | Repair + `AI/Uncertain` | only if repeated |

Per SPEC §1 pillar 5, every notable event/failure is reported to [Flagger](../08-flagger.md). P1/P2 push immediately; P3/P4 batch into the dashboard feed (SPEC §8).

---

## Config

| Key | Default | Purpose |
|-----|---------|---------|
| `sweep_cron` | `07:45 daily` | Pre-Herald sweep time. |
| `sweep_window` | `newer_than:2d` | Lookback for the sweep query. |
| `confidence_threshold` | tunable | Below this → add `AI/Uncertain`. |
| `vip_senders` | from Codex/config | Drives `From/VIP` + triage bump. |
| `company_map` | config | Sender domain → `From/Company/<Name>`. |
| `batch_size` / `backoff` | tuned to Gmail quota | Batching & rate-limit behavior. |
| `group_colors` | per parent group | Color-code at `create_label` time. |
| `model_tier` | Sonnet/Haiku via AI Gateway | Cheap high-volume pass. |

Secrets (Google OAuth token, `gmail.modify` only) live in **Cloudflare Secrets Store**, never in [the Vault](../01-agent-roster.md) or the Codex (SPEC §12).

---

## Example run

**07:45 sweep, a Tuesday.** Filer wakes on cron.

```
1. list_labels()                → taxonomy present; `Job/OA` missing → create_label("Job/OA", color=blue)
2. search_threads("newer_than:2d -label:AI/Reviewed")  → 14 threads
3. batch of 14 classified (Haiku via AI Gateway):

   • "Coding challenge — due Thu" (recruiter@acme.com)
       triage: ① Action Required   (deadline Thursday)
       type:   Type/Job + Job/OA
       needs:  Needs/Upload
       due:    Due/ThisWeek
       from:   From/Company/Acme
       → label_thread(t1, [...]) + AI/Reviewed

   • "Your Visa statement is ready"
       triage: ② Action Recommended
       type:   Type/Finance + Finance/Bill
       needs:  Needs/Pay
       from:   From/Automated
       suggest:Suggest/Keep
       (privacy: balance NOT echoed anywhere)
       → label_thread(t2, [...]) + AI/Reviewed

   • "URGENT: verify your account now" (paypa1-secure.co)
       guard:  domain spoof + credential ask → ⚠ Phishing-Suspect
       type:   Type/Security
       NO links followed, NO Needs/*, NO Suggest/*
       → label_thread(t3, [⚠ Phishing-Suspect, Type/Security, AI/Reviewed])
       → Flagger: P2, trust 72, "Suspected phishing impersonating PayPal"

   • "50% off this weekend!" (deals@store.com)
       triage: ⑤ No Action
       type:   Type/Promotion
       suggest:Suggest/Unsubscribe
       → label_thread(t4, [...]) + AI/Reviewed

   • 1 ambiguous thread → + AI/Uncertain (low confidence)

4. 14/14 labeled, 0 deleted, 0 archived. Cursor advanced.
```

**08:00 — [Herald](herald.md) runs**, reads the fresh labels Filer just applied, and builds the daily digest. **08:15 — [Forge](forge.md)** reads the `Needs/Upload` and `Needs/Pay` labels and mints "Acme OA — due Thu" and "Pay Visa bill" tasks.

---

## Open questions

- **VIP source:** is `From/VIP` driven from the Codex, a static config, or learned from reply history?
- **`Due/*` recompute:** a `Due/ThisWeek` thread becomes `Due/Today`/`Due/Expired` as time passes — does Filer re-sweep reviewed threads to roll deadline labels forward, or does [Compass](compass.md) own time-based recompute?
- **Triage reconciliation cost:** how often does a new message flip the mutually-exclusive triage label, and is that the only label Filer is allowed to *remove*?
- **Phishing trust threshold:** what trust score gates `⚠ Phishing-Suspect` vs. a softer `AI/Uncertain`?
- **Company map maintenance:** auto-extend `From/Company/<Name>` from new domains, or keep it owner-curated?

---

**Related:** [email taxonomy](../04-email-taxonomy.md) · [scheduling](../03-scheduling.md) · [Herald](herald.md) · [Forge](forge.md) · [Flagger](../08-flagger.md) · [architecture](../02-architecture.md) · [security & privacy](../11-security-privacy.md)
