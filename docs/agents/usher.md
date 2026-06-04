# Usher (event registration)

**Purpose:** On demand, find a *specific* event the owner names, confirm it, register the owner via browser automation, add it to Google Calendar, and tell [Steward](steward.md) to bump `events-registered`. Outward and irreversible — every registration is gated behind explicit owner confirmation, and Usher stops cold for captchas and payments.

> Roster **#7** · Tier 4 (outward-facing / irreversible — build last, gate hardest). See [agent roster](../01-agent-roster.md) and [importance tiers](../SPEC-CANON.md) §3.

---

## At a glance

| | |
|---|---|
| **Codename** | Usher |
| **Role** | Event search + registration + calendar add |
| **Runtime** | Cloud + browser (Cloudflare Worker driving headless Playwright) |
| **Trigger** | **on-demand** (user-initiated; never scheduled) |
| **Inputs** | Owner's event request (name/link/criteria); registration facts from [The Codex](../07-source-of-truth-codex.md) |
| **Outputs** | A completed registration, a Google Calendar event, an `events-registered` increment to Steward |
| **Writes to** | **Google Calendar**, **Steward** (via the [Wire](../02-architecture.md)) |
| **MCPs / tools** | **Playwright** (browser automation) · **Google Calendar** (MCP) · **The Codex** (read-only) |
| **Reads** | The Codex (identity, email, phone, demographics/EEO answers) |
| **Reversible?** | **No** — registration is outward; gated behind a hard confirmation. |
| **Confidence** | Stops and asks on every captcha, payment, ambiguity, or sold-out state. |

---

## What it does

Usher is the *active* counterpart to [Scout](scout.md). Where Scout **discovers** events and pushes a weekly digest, Usher **acts**: the owner says "register me for X," and Usher takes it from a search query to a confirmed seat plus a calendar block — without the owner touching a form.

It does exactly one event per invocation. It is **not** a crawler, not a bulk registrar, and not a discovery engine. The owner names the event (by title, link, or tight criteria); Usher resolves it, confirms it with the owner, fills the registration form from [The Codex](../07-source-of-truth-codex.md), and records the outcome.

Because registering is **outward and irreversible** (design pillar #2, "Suggest, don't destroy"; see [security & privacy](../11-security-privacy.md) §12), Usher never submits a registration without a fresh, explicit yes — and it refuses to push through the two things it must not automate: **captchas** and **payments**.

---

## How it works

```
                    owner: "register me for <event>"
                                  │
                                  ▼
              ┌───────────────────────────────────────┐
        (1)   │  FIND — Playwright resolves the event  │
              │  (search / open link), scrapes details │
              └───────────────────────────────────────┘
                                  │  one match? → continue
                                  │  0 or >1   → ask owner to pick / refine
                                  ▼
              ┌───────────────────────────────────────┐
        (2)   │  CONFIRM GATE — present details, ask:  │
              │  "Register you for THIS? (price/free,  │
              │   date, location, account)"            │
              └───────────────────────────────────────┘
                          yes │            │ no → abort, no writes
                              ▼
              ┌───────────────────────────────────────┐
        (3)   │  FILL — map form fields → Codex fields │
              │  via Playwright; do NOT submit yet     │
              └───────────────────────────────────────┘
                              │
                 ┌────────────┼─────────────┐
        captcha? │   payment? │   sold out? │  → STOP, hand back to owner
                 └────────────┴─────────────┘
                              │ clear path
                              ▼
              ┌───────────────────────────────────────┐
        (4)   │  SUBMIT — confirm registration, scrape │
              │  confirmation # / email                │
              └───────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────────────┐
        (5)   │  CALENDAR ADD — Google Calendar event  │
              │  (title, time, location, conf #, link) │
              └───────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────────────┐
        (6)   │  STEWARD — Wire event: events-          │
              │  registered++ (increment, idempotent)  │
              └───────────────────────────────────────┘
```

**Step by step:**

1. **Find.** Usher drives **Playwright** to resolve the named event. If given a URL, it opens it directly; if given a title/criteria, it searches the relevant platform(s) and scrapes the candidate's name, date/time, location (or "online"), price, host, and registration URL. It then **disambiguates**: exactly one match → proceed; zero matches → report "not found" and ask the owner to refine; multiple matches → present the shortlist and ask the owner to pick. Usher never guesses which event the owner meant.

2. **Confirm with the owner (the gate).** Usher surfaces the resolved details and asks for an explicit go/no-go. Crucially, the price (or "free") is shown *here*, before any form is touched. No confirmation → **no writes, no submission, full stop.** See [the confirmation gate](#the-confirmation-gate) below.

3. **Fill registration.** With a yes in hand, Usher navigates the registration form and fills it by mapping form-field labels → **Codex** fields, the same mapping [Quill](quill.md) uses (`first name` → Daniel, `last name` → Chahine, `email` → …, plus phone and demographics/EEO answers where asked). Usher reads the Codex **read-only** (§11) and fills, but does **not** click the final submit yet.

4. **Submit.** If the path is clear (no captcha, no payment, seats available), Usher submits and scrapes the confirmation number / confirmation-email signal as proof of success. A failure to obtain confirmation is treated as **not registered** (see [failure modes](#failure-modes--flagger-hooks)).

5. **Calendar add.** Usher writes the event to **Google Calendar** via its MCP: title, start/end, location or join link, and the confirmation number + registration URL in the notes. This is the one calendar write Usher owns directly (it does not route this through Sundial). [Compass](compass.md) then sees the event when it builds the day plan, since Compass reads Google Calendar.

6. **Tell Steward.** Usher emits a single **Wire** event so [Steward](steward.md) increments the dashboard counter. Steward is fed and fetches nothing (§4); Usher never writes the Vault directly.

```jsonc
// Step 6 — Wire event to Steward (shape per SPEC-CANON §6.4)
{
  "agent": "usher",
  "type": "event.registered",
  "entity": "events",
  "op": "increment",
  "payload": { "metric": "events-registered", "by": 1, "event": "<title>", "confirmation": "<conf#>" },
  "idempotencyKey": "usher:<event-id>:registered"  // replay-safe; can't double-count
}
```

> **Counter name.** Per §6.1 the Events block tracks **registered / attended / upcoming**. Usher's job is the *registration* leg, so it increments **`events-registered`**. (Roster line §2 phrases this as "events attended++"; the registered counter is the precise metric Usher owns. "Attended" is set later, after the event actually happens.)

---

## The confirmation gate

This is the agent's defining constraint. Usher is in [Tier 4](../SPEC-CANON.md) precisely because registration is outward and irreversible, so the gate is **non-negotiable**:

- **One fresh confirmation per registration.** No standing/blanket approval. The owner must say yes to *this* event, *this* run.
- **Price is disclosed at the gate**, before any form interaction — "free" vs "$X" is part of the confirmation prompt, never a surprise mid-flow.
- **No confirmation → no side effects.** If the owner declines or doesn't respond, Usher aborts with zero writes: no submission, no calendar event, no Steward increment.
- **Re-confirm on material change.** If details discovered after the gate differ from what the owner approved (price changed, date moved, it became a paid tier), Usher stops and re-asks rather than proceeding on stale consent.
- **Hard stops override the gate.** Even *with* a yes, Usher will not push through a **captcha** or a **payment** — see below. A confirmation authorizes Usher to fill and submit a free, captcha-free form; it does not authorize spending money or defeating bot checks.

This mirrors the system-wide rule in §12: "Confirmation gates on every irreversible/outward action: … Usher registering/paying … Default = draft + ask."

---

## Failure modes & Flagger hooks

Usher fails **safe**: when in doubt, stop and hand control back to the owner rather than complete a registration it isn't sure about. Notable events go to [Flagger](../08-flagger.md) with a severity and trust score.

| Condition | What Usher does | Flag | Severity · trust |
|---|---|---|---|
| **Captcha encountered** | **Stop.** Never attempt to solve. Screenshot the challenge, hand off, ask the owner to clear it (or complete manually). | `Usher: captcha blocks registration for <event>` | P3 Medium · high (caught deterministically) |
| **Paid event / payment wall** | **Stop before any charge.** Do not enter card details. Report price + checkout URL; ask the owner to pay manually or explicitly re-confirm. | `Usher: <event> requires payment ($X)` | P2 High · high |
| **Sold out / waitlist only** | Do not register a waitlist as if it were a seat. Report status; ask whether to join the waitlist. | `Usher: <event> sold out / waitlist` | P3 Medium · high |
| **Ambiguous match (0 or >1)** | Do not pick. Present options or "not found"; ask owner. | `Usher: could not uniquely resolve <query>` | P4 Low · medium |
| **Login / account required** | Pause for owner auth (no scraping/storing of credentials). | `Usher: <platform> requires sign-in` | P3 Medium · high |
| **Missing Codex field** (form asks for something not in the Codex) | Fill what's known; ask the owner for the gap rather than fabricating. | `Usher: form field <x> not in Codex` | P3 Medium · medium |
| **Submit without confirmation** | Self-flag — should be impossible; indicates a gate bug. | `Usher: registration attempted w/o confirmation` | P1 Critical · high |
| **No confirmation #/email after submit** | Treat as **not registered**: do **not** add calendar, do **not** increment Steward. | `Usher: <event> submit returned no confirmation` | P2 High · medium |
| **Calendar add fails after success** | Registration stands; retry calendar; flag so the owner adds it manually. | `Usher: registered but calendar add failed` | P3 Medium · high |
| **ToS / anti-bot risk** | If a site forbids automation, stop and report rather than evade. | `Usher: automation disallowed on <platform>` | P2 High · medium |

Routing per §8: **P1/P2 → push notification immediately**; **P3/P4 → batched into the dashboard Flagger feed**.

**Idempotency:** the `idempotencyKey` (`usher:<event-id>:registered`) means a retried run that already registered will **not** double-count in Steward or create a duplicate calendar event. Before submitting, Usher checks whether this event-id is already registered and short-circuits to "already done."

---

## Dependencies

- **Reads** [The Codex](../07-source-of-truth-codex.md) for registration facts (identity, email, phone, demographics/EEO) — read-only (§11), same field mapping as [Quill](quill.md).
- **Writes** **Google Calendar** directly (the registered event) and **Steward** (the `events-registered` increment) via the [Wire](../02-architecture.md).
- **Feeds** [Compass](compass.md) indirectly: Compass reads Google Calendar when synthesizing the day plan, so Usher's event surfaces there (§4: "Compass depends on Forge + Google Calendar (events from Sundial/Usher)").
- **Reports to** [Flagger](../08-flagger.md) on every stop/error.
- **Complements** [Scout](scout.md): Scout discovers (read-only, weekly); Usher registers (outward, on-demand). Usher does not crawl for events itself.
- **Not** dependent on the morning pipeline — Usher runs purely on demand and touches different state.

See [dependencies & data flow](../02-architecture.md) and the fan-in diagram in §4 (Usher → the Wire → Steward → The Vault).

---

## Schedule / Triggers

| Trigger | Mode | Notes |
|---|---|---|
| **on-demand** | — | User-initiated only. Listed alongside Quill, Envoy, Librarian, Switchboard in [scheduling](../03-scheduling.md) §10. |

Usher is **never** cron-scheduled and is not part of the strictly-sequential morning chain. Each invocation is one event, start to finish.

---

## Config

| Key | Where | Purpose |
|---|---|---|
| Google OAuth (Calendar scope) | Cloudflare Secrets Store | Least-privilege calendar write; **no** broader Google access. |
| Codex location | KV / Vault | Read-only source for form fill (§11). |
| Playwright runtime | Worker + browser | Headless browser session for find/fill/submit. |
| Confirmation channel | KV | Where the gate prompt + go/no-go are exchanged with the owner. |
| `payment_policy` | KV | Hard default: **never pay automatically.** Stop and ask. |
| `captcha_policy` | KV | Hard default: **never solve.** Stop and ask. |
| Per-platform selectors | KV | Optional field-mapping hints for known event sites. |

Per [hosting](../06-hosting-cloudflare-mcp.md) §7: Cloudflare Worker for compute (Durable Object if a multi-step run needs to hold browser/session state across the confirmation pause), Playwright for browser automation, Calendar via Google OAuth2 MCP, the Wire (Queue) to reach Steward.

---

## Example run

```
Owner ▸  "Usher, register me for the Toronto JS Meetup on June 12."

Usher ▸  [FIND] Playwright searches → 1 match:
         • Toronto JS Meetup — Thu Jun 12, 6:30–9:00 PM
         • Location: Shopify, 80 Spadina Ave
         • Price: FREE (RSVP) · Host: Toronto JavaScript
         • https://meetup.com/toronto-js/events/…

Usher ▸  [CONFIRM GATE]
         "Register you for the Toronto JS Meetup, Thu Jun 12
          6:30 PM @ 80 Spadina Ave? It's FREE. (yes / no)"

Owner ▸  "yes"

Usher ▸  [FILL] mapping form fields → Codex:
           name  → Daniel Chahine
           email → chahinedaniel0@gmail.com
           "How did you hear about us?" → (from Codex/voice notes)
         No captcha. No payment. Seats available. → submitting.

Usher ▸  [SUBMIT] ✅ Registered. Confirmation: TJS-2026-0612-0481
                  (confirmation email received)

Usher ▸  [CALENDAR] ➕ Google Calendar:
           "Toronto JS Meetup" · Jun 12 6:30–9:00 PM
           @ 80 Spadina Ave · notes: conf TJS-2026-0612-0481 + link

Usher ▸  [STEWARD] Wire → events-registered++ (idempotencyKey set)

Usher ▸  "Done. You're registered for Toronto JS Meetup (Jun 12,
          6:30 PM). Added to your calendar. Confirmation
          TJS-2026-0612-0481."
```

**Contrast — a gated stop:**

```
Owner ▸  "Register me for the AI Summit on July 3."
Usher ▸  [FIND] 1 match — AI Summit, Jul 3 · Price: $249.
Usher ▸  [CONFIRM GATE]
         "AI Summit is a PAID event — $249. I don't process
          payments automatically. Want the checkout link to pay
          yourself, or should I stop?"
         → Flagger: P2 High · "Usher: AI Summit requires payment ($249)"
         (no submission, no calendar add, no Steward increment)
```

---

## Open questions

- **"Registered" vs "attended."** Usher increments **`events-registered`** at registration time. Who flips **attended**, and when — a post-event check, an owner tap, or a calendar-based heuristic? (§6.1 tracks both.)
- **Cancellations.** If the owner later cancels, should Usher *decrement* `events-registered` and delete the calendar event, or is un-registering a separate, also-gated flow?
- **Login persistence.** For platforms that require sign-in (Meetup, Eventbrite), where do session cookies live, and how long are they trusted before re-auth? (Must stay within §12 least-privilege / no-credential-storage rules.)
- **Paid-event escape hatch.** Is there ever an explicit "yes, pay up to $N" owner override, or is payment *always* manual? (Current default: always manual.)
- **Waitlists.** Treat a waitlist join as a (gated) success that increments `events-registered`, or as a distinct state the dashboard tracks separately?
- **Multi-event requests.** Out of scope by design (one event per run) — confirm that batch registration is intentionally excluded.
