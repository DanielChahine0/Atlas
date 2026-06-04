# Herald (email digest)

> **Purpose:** Read [Filer](filer.md)'s thread-level Gmail labels and produce a structured email digest — once every morning (`daily`) and once on Friday afternoon (`weekly`) — delivered as a draft/summary to the owner, with a `digest` event emitted to [Steward](steward.md).

Herald is **Roster #1** and the flagship agent — the thing the owner sees every morning. It is one prompt and one codebase with **two run modes** (`daily`, `weekly`) on two cron triggers. Herald **reads labels; it never writes labels** (that is Filer's job, see [email taxonomy](../04-email-taxonomy.md)).

---

## At a glance

| | |
|---|---|
| **Codename** | **Herald** |
| **Role** | Email digest (daily + weekly modes) |
| **Roster #** | 1 (Tier 1 — highest daily value; the core loop) |
| **Runtime** | Cloud (Cloudflare Worker; Durable Object for per-run state) |
| **Trigger** | Cron **08:00 daily** (`daily`) · Cron **Fri 16:00** (`weekly`) |
| **Modes** | `daily`, `weekly` |
| **Inputs** | Gmail thread labels (set by Filer), thread metadata (sender, subject, snippet, latest message ts), [The Codex](../07-source-of-truth-codex.md) for VIP context |
| **Outputs** | (1) Gmail **draft/summary to the owner**; (2) a `digest` **event on the Wire** → Steward |
| **Writes to** | The Vault **via Steward** (digest summary + email counters); a draft in the owner's mailbox. **Never writes Gmail labels.** |
| **Depends on** | [Filer](filer.md) (must run first — the **07:45 sweep** before the 08:00 daily run) |
| **MCPs / tools** | Gmail MCP (read threads/labels, create draft), the Wire (Cloudflare Queue) to Steward, AI Gateway → Claude (Sonnet for high-volume classification, Opus for the synthesis pass) |
| **Confirmation gate** | None — Herald only **drafts** and **summarizes** (read-only + draft). It never sends mail, never labels, never deletes. |

---

## What it does

The owner asked for "a morning email agent" and "a Friday email agent." Those are the **same agent** with two modes — DRY, one prompt.

1. **Reads** the labels Filer already applied (Herald does not classify mail from scratch — it trusts and summarizes the label substrate).
2. **Groups** threads into the owner's requested digest subsections (below).
3. **Synthesizes** a skimmable digest: a top-line glance, then per-subsection bullet lists, each linking back to the Gmail thread.
4. **Delivers** the digest as a **Gmail draft to the owner** (default = draft + ask; Herald never auto-sends).
5. **Emits** a `digest` event on the Wire so [Steward](steward.md) records the run and bumps email counters in [The Vault](../06-obsidian-dashboard.md).

### The owner's requested subsections

Herald maps Filer's [triage and type labels](../04-email-taxonomy.md) onto exactly these five sections, in this order:

| Digest subsection | Sourced from labels |
|---|---|
| **Important** | `From/VIP`, or `③ Awaiting Reply` from a VIP/company thread; high-signal `Type/Job` (`Job/Interview`, `Job/Offer`, `Job/OA`), `Type/Finance` bills due, `School/Deadline` |
| **Action Required** | `① Action Required` (+ its `Needs/*` and `Due/*` qualifiers) |
| **Action Recommended** | `② Action Recommended` |
| **Advertisement** | `Type/Promotion` (marketing / sales / ads) |
| **Other** | everything else: `④ FYI / Read Later`, `⑤ No Action`, `Type/Newsletter`, `Type/Social`, `From/Automated`, etc. |

> **Promotion ≠ Newsletter ≠ Transactional.** Per §5.8, opted-in `Type/Newsletter` content is **not** advertising — it lands in **Other** (reading queue), never in **Advertisement**. Only `Type/Promotion` is an ad.

### Mode differences

| | `daily` (08:00) | `weekly` (Fri 16:00) |
|---|---|---|
| **Window** | New/unread threads since the previous daily run (~last 24h) | The whole week — a review across the last 7 days |
| **Emphasis** | "What hit my inbox overnight; what must I act on today" | "What did I miss / let slide; what's still `③ Awaiting Reply`; what's `Due/ThisWeek`" |
| **Sections** | All five, ranked by urgency (`Due/Today` first) | All five, plus a **weekly rollup**: counts per label group, unresolved `① Action Required`, aging `③ Awaiting Reply`, `Due/Expired` |
| **Runs after** | Filer's **07:45 sweep** (strictly sequential) | Filer's continuous push labeling (no dedicated pre-sweep; runs in **parallel** with [Scout](scout.md)) |
| **Fan-in** | Feeds the morning chain → [Forge](forge.md) at 08:15 | Both Herald-weekly and Scout fan into Steward; Steward compiles the weekly dashboard at **Fri 16:30** |

---

## How it works

```
                 07:45  Filer sweep (labels fresh)        ← daily prerequisite
                   │
   cron 08:00  ────┤
   cron Fri 16:00  │
                   ▼
            ┌──────────────────────────────────────────────┐
            │ Herald (mode = daily | weekly)               │
            │                                              │
            │ 1. read threads + labels (Gmail MCP)         │
            │ 2. filter to mode window (24h | 7d)          │
            │ 3. bucket → Important / Action Required /    │
            │    Action Recommended / Advertisement / Other│
            │ 4. redact security mail (see Security)       │
            │ 5. synthesize digest (Opus pass)             │
            │ 6. create Gmail DRAFT to owner               │
            │ 7. emit `digest` event → the Wire            │
            └───────────────┬──────────────────────────────┘
                            │
              draft to owner │ digest event
                            ▼
                        Steward ──▶ The Vault (counters + summary note)
                            │
              (daily only)  ▼
                          Forge (08:15 — reads `① Action Required`)
```

**Step list:**

1. **Pull labeled threads.** Query Gmail for threads carrying Filer's labels within the mode window. Skip nothing on the basis of `AI/Reviewed` (that flag is for Filer's idempotency, not Herald's) — but **do** rely on it being present as a signal that Filer has actually processed the thread; threads still lacking it are noted as "unlabeled / Filer may be behind."
2. **Bucket** each thread into one of the five subsections using the label→section map above. A thread labeled by its **latest actionable message** (Filer's convention) is summarized by that message.
3. **Redact** sensitive content (see [Security](#security-never-reproduce-2fa-codes--reset-links)) — `Type/Security` and `⚠ Phishing-Suspect` threads are listed by sender/subject only, with **no codes, no links**.
4. **Rank** within sections: `Due/Today` → `Due/ThisWeek` → `From/VIP` → rest. In `weekly` mode also surface `Due/Expired` and aging `③ Awaiting Reply`.
5. **Synthesize** the digest body (the Opus pass) into the five sections, each bullet linking to the thread.
6. **Create a Gmail draft** addressed to the owner (`chahinedaniel0@gmail.com`). Subject e.g. `Atlas Digest — Thu 29 May (daily)` / `Atlas Weekly Email Review — Fri 30 May`. **Draft only — never send.**
7. **Emit a `digest` event** on the Wire for Steward (shape below). Idempotency key keyed on `(mode, run date)` so a retried run can't double-count.
8. **On error**, emit a Flagger event (see [Failure modes](#failure-modes--flagger-hooks)).

---

## Inputs / Outputs

### Inputs
- **Gmail threads + labels** (read-only) via the Gmail MCP — the labels are the substrate; Herald does not re-classify.
- **The Codex** — read-only, for VIP/company context (who counts as VIP, current job-search companies) to rank the **Important** section. See [the Codex](../07-source-of-truth-codex.md).
- **Previous run timestamp** (Durable Object state) to compute the `daily` 24h window.

### Outputs
1. **Gmail draft to owner** — the human-readable digest (the morning glance). Draft, never auto-sent.
2. **`digest` event → the Wire → Steward.** Steward is the **sole Vault writer**; Herald feeds it and writes nothing to the Vault directly.

**Event shape** (conforms to the Steward write contract, §6.4 — `{ agent, type, entity, op, payload, idempotencyKey }`):

```json
{
  "agent": "Herald",
  "type": "digest",
  "entity": "email",
  "op": "upsert",
  "payload": {
    "mode": "daily",
    "runDate": "2026-05-29",
    "counts": {
      "important": 3,
      "actionRequired": 4,
      "actionRecommended": 2,
      "advertisement": 11,
      "other": 18,
      "processedToday": 38
    },
    "topActionRequired": ["thread/abc123", "thread/def456"],
    "draftId": "draft/r-99xx"
  },
  "idempotencyKey": "herald:daily:2026-05-29"
}
```

Steward applies this to the Vault's **Email** counters (`unread`, `action-required`, `processed-today`) via `increment`/`upsert`, and links the draft in the Agent run log. Herald may emit a second `increment` event for the run-log heartbeat.

---

## Dependencies

| Depends on | Why |
|---|---|
| **[Filer](filer.md)** (hard dependency) | Herald reads Filer's labels. The **07:45 daily sweep** must complete before the **08:00 daily** run so the digest reads *fresh* labels. If Filer is behind, Herald digests stale state. |
| **[Steward](steward.md)** | Consumes Herald's `digest` event; sole writer of email counters + summary note to the Vault. |
| **[The Codex](../07-source-of-truth-codex.md)** | VIP / company context for the **Important** ranking. |

**Downstream consumers (daily mode):**
- **[Forge](forge.md)** runs at **08:15** and extracts tasks from the morning's `① Action Required` threads — effectively the same set Herald surfaced under **Action Required**. Herald → Forge → [Sundial](sundial.md) → [Compass](compass.md) is the strictly sequential morning chain (see [scheduling](../03-scheduling.md)).

```
Gmail push ─▶ Filer (07:45 sweep) ─▶ Herald (08:00) ─▶ Forge (08:15) ─▶ Sundial (08:20) ─▶ Compass (08:30)
```

---

## Schedule / Triggers

From [scheduling](../03-scheduling.md) §10:

| Time / trigger | Mode | Ordering |
|---|---|---|
| **07:45 daily** | — (Filer sweep) | **prerequisite** — labels fresh before Herald |
| **08:00 daily** | `daily` | depends on the Filer sweep; first link of the morning chain (strictly sequential) |
| **Fri 16:00** | `weekly` | runs **in parallel** with [Scout](scout.md) (independent sources); both fan into Steward, which compiles the weekly dashboard at **Fri 16:30** |

**Concurrency notes:**
- The morning chain is **strictly sequential** — Herald starts only after Filer's sweep succeeds, and Forge starts only after Herald succeeds.
- The Friday weekly Herald and Scout are **independent** and run concurrently; Steward serializes their writes regardless.

---

## Security: never reproduce 2FA codes / reset links

This is non-negotiable (SPEC §5.8, §12). Herald processes the whole inbox, including `Type/Security` and `⚠ Phishing-Suspect` mail, so it is a place where secrets could leak into a draft.

- **Never reproduce 2FA / OTP codes, magic links, or password-reset links** in any digest, draft, or Vault summary. `Type/Security` threads are listed by **sender + subject only** (e.g. "GitHub — security alert"), with a flat note like *"security-sensitive; opened in Gmail only."* Strip any code-looking token (`\b\d{4,8}\b` near "code"/"OTP"/"verification") and any reset/login URL from snippets before they reach the model's synthesis output.
- **Never click or resolve links** in `Type/Security` or `⚠ Phishing-Suspect`. Herald does not follow links; it only reads labels and thread metadata.
- **`⚠ Phishing-Suspect`** threads are surfaced under **Other** with a visible warning and **no clickable link** — never under Important/Action, so the owner is never nudged to act on a phish.
- **Finance / medical privacy:** `Finance/*` and any health mail are summarized as *existence + action* ("Bill due Fri — open in Gmail"), never with account numbers, balances, or details — especially in any exported/shared view (§5.8).
- **Draft, never send.** Herald has no send scope. The digest is a draft addressed to the owner; only the owner sends/forwards if they choose to.
- **Least privilege:** Herald's Gmail scope is read + draft-create only — **no** `gmail.modify` (labels) and **no** delete. Labeling is Filer's job; Herald cannot mutate the inbox.

---

## Failure modes & Flagger hooks

| Failure | Detection | Flagger action |
|---|---|---|
| **Filer sweep didn't finish before 08:00** | run-log shows no 07:45 Filer success, or threads lack `AI/Reviewed` | `P2 High`, high trust — digest may be stale; note "ran on stale labels" in the draft header |
| **Gmail API rate limit / 5xx** | Gmail MCP errors | `P3 Medium` — back off + retry; if still failing, emit `P2` and skip the run (idempotent — next run recovers) |
| **Empty inbox / no labeled threads** | zero threads in window | not a failure — emit a "nothing actionable" digest; `P4 Info` only |
| **Steward event rejected / Wire backpressure** | enqueue failure | `P3 Medium`, high trust — counters out of sync; retry with same `idempotencyKey` |
| **LLM low-confidence bucketing** | model uncertainty on Important ranking | `P4 Low`, lower trust — fall back to label-literal bucketing; don't guess |
| **Possible secret leak detected pre-draft** | redaction regex tripped on output | block the draft, `P2 High`, high trust — never emit a digest containing a code/link |

All flags carry severity + trust per [Flagger](../08-flagger.md) (`{ id, ts, source_agent: "Herald", severity, trust, title, detail, suggested_action, status }`). P1/P2 push immediately; P3/P4 batch into the Vault Flagger feed. **Idempotency:** Herald is safe to re-run — the `idempotencyKey` (`herald:<mode>:<runDate>`) prevents double-counting in Steward.

---

## Config

| Key | Default | Notes |
|---|---|---|
| `cron.daily` | `0 8 * * *` (08:00 local) | the morning digest |
| `cron.weekly` | `0 16 * * 5` (Fri 16:00 local) | the weekly review, parallel with Scout |
| `window.daily` | 24h since last daily run | computed from DO state |
| `window.weekly` | 7 days | the review window |
| `sections` | `[Important, Action Required, Action Recommended, Advertisement, Other]` | owner-requested order — do not reorder |
| `delivery` | `draft` | draft to owner; **never** `send` |
| `model.classify` | Sonnet (via AI Gateway) | cheap high-volume bucketing |
| `model.synthesize` | Opus (via AI Gateway) | the digest narrative |
| `vip.source` | The Codex | who bumps into **Important** |
| `redact.security` | `on` | strip codes/links from `Type/Security` + `⚠ Phishing-Suspect` |

---

## Example run — a real morning digest (`daily`, Thu 29 May 2026, 08:00)

*Filer's 07:45 sweep labeled 38 threads. Herald reads them, buckets, redacts, drafts. Below is the draft Herald leaves in the owner's mailbox.*

```
Subject:  Atlas Digest — Thu 29 May (daily)
To:       chahinedaniel0@gmail.com

ATLAS MORNING DIGEST · 38 threads · 4 action-required · 2 due today
──────────────────────────────────────────────────────────────────

★ IMPORTANT (3)
  • Shopify — Interview scheduling: virtual onsite                 [Job/Interview · From/Company/Shopify]
  • Visa bill — $214.86 due FRI 31 May                            [Finance/Bill · Due/ThisWeek]
  • Prof. Liu — CS449 final project rubric posted                  [School/Deadline · From/VIP]

▲ ACTION REQUIRED (4)
  • Reply to recruiter (Amazon) — confirm availability THU/FRI     [① Action Required · Needs/Reply · Due/Today]
  • Sign housing renewal — landlord                                [① Action Required · Needs/Sign · Due/Today]
  • Upload transcript — co-op portal                               [① Action Required · Needs/Upload · Due/ThisWeek]
  • Pay Visa bill ($214.86)                                        [① Action Required · Needs/Pay · Due/ThisWeek]
  → Forge will extract these into tasks at 08:15.

◇ ACTION RECOMMENDED (2)
  • Register: "Cloudflare Developer Week" talk (free)              [② Action Recommended · Needs/Register]
  • Review PR feedback on atlas-worker repo                        [② Action Recommended · Type/Dev]

▣ ADVERTISEMENT (11)   — collapsed; 0 require action
  Uber, DoorDash, Notion, 8 more.  Suggest/Unsubscribe: 3 senders.

· OTHER (18)
  • 5 newsletters (TLDR, Pragmatic Engineer, +3)                   [Type/Newsletter → Reading queue]
  • 4 LinkedIn / X notifications                                   [Type/Social]
  • 2 SECURITY (sender+subject only — opened in Gmail):
        – GitHub — "New sign-in to your account"   [Type/Security · code/link redacted]
        – Google — "Security alert"                [Type/Security · code/link redacted]
  • 1 ⚠ Phishing-Suspect — "Your package is held" (DO NOT CLICK)   [⚠ Phishing-Suspect · no link shown]
  • 6 No-Action / automated

Waiting on (③): 2 threads — recruiter (Meta), advisor.
──────────────────────────────────────────────────────────────────
Draft only. Atlas did not send, label, or delete anything.
```

**Event Herald emits to Steward for this run:**

```json
{
  "agent": "Herald", "type": "digest", "entity": "email", "op": "upsert",
  "payload": {
    "mode": "daily", "runDate": "2026-05-29",
    "counts": { "important": 3, "actionRequired": 4, "actionRecommended": 2,
                "advertisement": 11, "other": 18, "processedToday": 38 },
    "topActionRequired": ["thread/amzn-recruiter", "thread/housing-renewal"],
    "draftId": "draft/r-2026-05-29-am"
  },
  "idempotencyKey": "herald:daily:2026-05-29"
}
```

Note what Herald did **not** do: it did not reproduce the GitHub/Google security codes, did not render the phishing link, did not send the draft, and did not touch a single label.

---

## Open questions

- **Delivery channel:** draft-to-self (current default) vs. a push notification with the top-3 vs. writing the digest straight into the Vault's "morning glance." The owner sees the Vault daily anyway (§6.3) — is the Gmail draft redundant?
- **Daily/weekly overlap:** Friday morning gets a `daily` digest at 08:00 *and* a `weekly` review at 16:00. Suppress Friday's daily, or keep both (daily = today, weekly = the rollup)?
- **VIP definition:** sourced from the Codex today. Should `From/Company/<active job search>` auto-promote into **Important**, and should that list update from Headhunter's pipeline?
- **Advertisement handling:** Herald only summarizes ads. Should it pre-stage `Suggest/Unsubscribe` candidates for a one-click owner action (still Filer's label, Herald's surfacing)?
- **Window edges:** if a daily run is missed (Worker outage), should the next run widen its 24h window to backfill, or stay fixed and let `weekly` catch the gap?
