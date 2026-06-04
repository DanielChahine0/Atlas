# 04 — Email Label Taxonomy

**Purpose:** The complete, literal Gmail label taxonomy that **Filer** (email labeler / tagger) applies to threads — every group, every label, with a one-line meaning, an example, a color suggestion, and the rules Filer must never break.

## At a glance

| | |
|---|---|
| **Owning agent** | [Filer](agents/filer.md) (email labeler / tagger — never archives/deletes) |
| **Label level** | Gmail labels are **thread-level**; nested as `Parent/Child` |
| **Triggers** | Continuous Gmail push as mail arrives + **07:45 daily** pre-Herald sweep (see [scheduling](03-scheduling.md)) |
| **Writes to** | **Gmail labels only** — no archive, no delete, no send |
| **OAuth scope** | `gmail.modify` (labels) — **not** delete (see [security & privacy](11-security-privacy.md)) |
| **Consumed by** | [Herald](agents/herald.md) (digest reads labels), [Forge](agents/forge.md) (`Needs/*` drives tasks), the Vault dashboard |
| **Source of truth** | SPEC-CANON §5. Label strings below are **literal** — copy exactly |

> **One rule above all:** Filer **labels**. It never archives, never deletes, never sends, never clicks. Manual archiving/deleting stays with the owner. This is Atlas design pillar #2: *suggest, don't destroy.*

---

## How the groups fit together

A single thread typically ends up with labels drawn from several groups at once: **exactly one** triage label, usually **one** type label, zero-or-more `Needs/*`, an optional `Due/*`, relationship labels, an optional `Suggest/*`, and the agent-state labels Filer uses for its own bookkeeping.

```
   ┌─────────────────────────────────────────────────────────────────┐
   │  one thread                                                       │
   ├─────────────────────────────────────────────────────────────────┤
   │ Triage      ① ② ③ ④ ⑤          ◀ exactly one (mutually exclusive) │
   │ Type        Type/Job → Job/Recruiter, …    ◀ category (prefer one)│
   │ Needs       Needs/Reply, Needs/Pay, …      ◀ drives Forge tasks   │
   │ Deadline    Due/Today | Due/ThisWeek | Due/Expired                │
   │ Relationship From/VIP, From/Company/<Name>, From/Automated        │
   │ Suggestion  Suggest/Keep | Suggest/Delete | Suggest/Unsubscribe   │
   │ Agent-state AI/Reviewed, AI/Uncertain, ⚠ Phishing-Suspect         │
   └─────────────────────────────────────────────────────────────────┘
```

The groups below are reproduced from **SPEC-CANON §5** verbatim. Each label gets a one-line meaning + example; each parent group gets a color-coding suggestion for fast visual scanning in the Gmail sidebar.

---

## 5.1 Triage group

**Mutually exclusive — exactly one per thread.** This is the single most important label: it answers "do I need to do anything?" The leading circled numeral keeps Gmail's alphabetical label list in priority order.

🎨 **Color suggestion:** a red→grey gradient by urgency — `①` red, `②` orange, `③` yellow, `④` blue, `⑤` grey. The owner's eye should find red first.

| Label | Meaning | Example |
|-------|---------|---------|
| `① Action Required` | Owner must do something; usually has a deadline. | "Your OA for Shopify expires in 48h — start here." |
| `② Action Recommended` | Should do, not mandatory. | "Reminder: complete your profile to improve matches." |
| `③ Awaiting Reply` | Owner is blocked on someone else (owner already replied / acted). | Sent a recruiter availability; waiting on a slot. |
| `④ FYI / Read Later` | Informational, no action. | A newsletter issue, a course announcement to skim. |
| `⑤ No Action` | Safe to ignore. | "Thanks for registering" auto-acknowledgement. |

---

## 5.2 Type group

**Category — can be multiple but prefer one.** Parents have children for the high-traffic categories the owner cares about (jobs, events, finance, school).

🎨 **Color suggestion:** one distinct hue per parent (Job = teal, Events = purple, Finance = green, School = brown, Security = bright red, everything else its own muted tone). Children inherit a lighter shade of the parent hue.

| Label | Meaning | Example |
|-------|---------|---------|
| `Type/Job` | Anything job-hunt related (parent). | umbrella over the children below |
| `Job/Application` | An application the owner submitted / its status. | "We received your application." |
| `Job/Recruiter` | Recruiter / sourcer outreach. | "Saw your GitHub — open to a chat?" |
| `Job/OA` | Online assessment (coding test, HackerRank, etc.). | "Complete your online assessment by Friday." |
| `Job/Interview` | Interview scheduling / logistics. | "Let's book your technical round." |
| `Job/Offer` | An offer or offer-stage comms. | "We're pleased to extend an offer." |
| `Job/Rejection` | A rejection / "moving forward with others." | "We won't be proceeding at this time." |
| `Type/Events` | Events (parent). | umbrella over the children below |
| `Events/Invite` | An invitation to register / attend. | "You're invited to the React Toronto meetup." |
| `Events/Confirmed` | Registration confirmed / ticket. | "Your spot is confirmed — here's your QR." |
| `Events/Reminder` | "Happening soon" nudge. | "Starts in 1 hour." |
| `Type/Finance` | Money matters (parent). | umbrella over the children below |
| `Finance/Bill` | A bill due. | "Your credit-card statement is ready." |
| `Finance/Receipt` | Proof of a completed payment. | "Receipt for your $12.99 purchase." |
| `Finance/Bank` | Bank account activity / statements. | "Your monthly statement is available." |
| `Finance/Tax` | Tax documents / deadlines. | "Your T4 is ready to download." |
| `Finance/Subscription` | Recurring subscription billing / renewal. | "Your plan renews on the 1st." |
| `Type/School` | University / coursework (parent). | umbrella over the children below |
| `School/Deadline` | An assignment / registration deadline. | "Assignment 3 due Sunday 11:59pm." |
| `School/Grade` | A grade / feedback posting. | "Your midterm grade is posted." |
| `School/Admin` | Registrar / admin / logistics. | "Course add/drop closes Friday." |
| `Type/Newsletter` | Opted-in content digests. | A weekly engineering newsletter the owner subscribed to. |
| `Type/Promotion` | Marketing / sales / advertisement. | "50% off — today only!" |
| `Type/Social` | LinkedIn, X, Instagram notifications. | "You have 3 new connection requests." |
| `Type/Travel` | Flights, hotels, itineraries. | "Your boarding pass is ready." |
| `Type/Dev` | GitHub, CI/CD, deploy, error alerts. | "Build failed on `main`." |
| `Type/Security` | 2FA, login alerts, password resets, account security. | "Here is your verification code." |
| `Type/Personal` | Friends, family. | A message from a friend. |

> **Job pipeline note:** the `Job/*` children map directly onto the Vault job-funnel counters (applied → OA → interview → offer / rejection) that [Steward](agents/steward.md) tracks. Keep them clean — they feed the kanban.

---

## 5.3 Needs group

**The specific action — drives [Forge](agents/forge.md).** When Filer applies a `Needs/*` label, Forge knows there is a concrete task to extract. These are the verbs.

🎨 **Color suggestion:** a single shared "action" color (amber) for the whole group, so any `Needs/*` reads as "there's a TODO buried here."

| Label | Meaning | Example |
|-------|---------|---------|
| `Needs/Reply` | Owner must write a reply. | A recruiter asking for availability. |
| `Needs/Pay` | A payment is owed. | A bill or invoice. |
| `Needs/Register` | Owner must register / sign up. | Event registration, course enrollment. |
| `Needs/Schedule` | Owner must book a time. | "Pick an interview slot." |
| `Needs/Upload` | Owner must upload a document. | "Submit your transcript." |
| `Needs/Sign` | Owner must sign something. | An offer letter / e-signature request. |
| `Needs/Decide` | Owner must make a yes/no / choice. | "Accept or decline this invitation." |

---

## 5.4 Deadline group

When the thread carries a time pressure, Filer stamps **one** deadline bucket. This feeds the Vault deadline board and lets Herald front-load urgent items.

🎨 **Color suggestion:** `Due/Today` flashing red, `Due/ThisWeek` orange, `Due/Expired` dark grey (struck-through visually).

| Label | Meaning | Example |
|-------|---------|---------|
| `Due/Today` | The action is due today. | "OA expires tonight." |
| `Due/ThisWeek` | Due within the current week. | "Apply by Friday." |
| `Due/Expired` | The deadline has already passed. | A registration window that closed. |

> `Due/Expired` is kept (not deleted) so the owner can see what was missed and the run-log stays honest.

---

## 5.5 Relationship group

Who sent it, and how much it matters. `From/VIP` is the one that **changes behavior** (it auto-bumps triage priority).

🎨 **Color suggestion:** `From/VIP` gold/yellow (high contrast), `From/Company/<Name>` a single neutral blue, `From/Automated` light grey.

| Label | Meaning | Example |
|-------|---------|---------|
| `From/VIP` | Auto-bump triage priority. | The owner's manager, a key recruiter, a close contact. |
| `From/Company/<Name>` | Sender is a tracked company. | `From/Company/Shopify`, `From/Company/Amazon`. |
| `From/Automated` | No-reply / system sender. | `no-reply@…`, automated notifications. |

> `From/Company/<Name>` is a **template** — `<Name>` is filled with the real company (e.g. `From/Company/Shopify`). Filer creates these on demand and reuses them across threads from the same company.

---

## 5.6 Suggestion group

**Filer's recommendation — the owner decides.** These never trigger any action on their own; they are advisory and surface in the Vault. They embody pillar #2: Filer *suggests* deletion/unsubscribe, but the owner pulls the trigger.

🎨 **Color suggestion:** muted/pastel set distinct from triage (e.g. `Suggest/Keep` soft green, `Suggest/Delete` soft red, `Suggest/Unsubscribe` soft purple) so a suggestion never looks like a mandatory triage state.

| Label | Meaning | Example |
|-------|---------|---------|
| `Suggest/Keep` | Worth keeping / archiving for reference. | A receipt, a confirmation. |
| `Suggest/Delete` | Looks like clutter; owner may delete. | A duplicate promo. |
| `Suggest/Unsubscribe` | Recurring noise; owner may unsubscribe. | A promo list the owner never opens. |

---

## 5.7 Agent-state group

Filer's own bookkeeping — **idempotency + trust.** These keep re-runs safe and tell the owner where the machine was unsure or alarmed.

🎨 **Color suggestion:** `AI/Reviewed` near-invisible light grey (it's just a marker), `AI/Uncertain` amber, `⚠ Phishing-Suspect` the most aggressive red in the whole scheme — it must out-shout everything.

| Label | Meaning | Example |
|-------|---------|---------|
| `AI/Reviewed` | Filer has processed this thread (skip on re-run). | Applied to every thread Filer finishes. |
| `AI/Uncertain` | Low confidence; needs a human glance. | Ambiguous sender, mixed-intent thread. |
| `⚠ Phishing-Suspect` | Possible phishing; never follow links, never auto-act. | Spoofed "your account is locked" with a bad link. |

> `AI/Reviewed` is the idempotency anchor — see the careful-section below. `⚠ Phishing-Suspect` is a **safety stop**, not a category: Filer applies it and otherwise keeps its hands off the thread.

---

## Quick reference — the full label set

```
Triage (1, exclusive)   ① Action Required · ② Action Recommended · ③ Awaiting Reply
                         · ④ FYI / Read Later · ⑤ No Action

Type (prefer 1)         Type/Job → Job/{Application,Recruiter,OA,Interview,Offer,Rejection}
                        Type/Events → Events/{Invite,Confirmed,Reminder}
                        Type/Finance → Finance/{Bill,Receipt,Bank,Tax,Subscription}
                        Type/School → School/{Deadline,Grade,Admin}
                        Type/{Newsletter,Promotion,Social,Travel,Dev,Security,Personal}

Needs (0..n)            Needs/{Reply,Pay,Register,Schedule,Upload,Sign,Decide}

Deadline (0..1)         Due/{Today,ThisWeek,Expired}

Relationship (0..n)     From/VIP · From/Company/<Name> · From/Automated

Suggestion (0..1)       Suggest/{Keep,Delete,Unsubscribe}

Agent-state             AI/Reviewed · AI/Uncertain · ⚠ Phishing-Suspect
```

---

## Things to be careful about

This section expands **SPEC-CANON §5.8**. These are the rules Filer must enforce on every run; violating any of them is a [Flagger](agents/flagger.md) event.

### 1. Never auto-archive / auto-delete (owner requirement)
Filer **labels only.** It must never archive, delete, mark-as-spam, or move a thread out of the inbox. Its OAuth scope is `gmail.modify` (labels) and explicitly **not** delete (see [security & privacy](11-security-privacy.md)). Even `Suggest/Delete` and `Suggest/Unsubscribe` are *recommendations the owner acts on* — Filer never executes them. Manual archiving/deleting stays with the owner.

### 2. Idempotency — never thrash labels on re-run
Filer is triggered both continuously (Gmail push) and on a **07:45 daily sweep**, so the same thread can be seen many times.
- Threads already carrying `AI/Reviewed` are **skipped** on re-run unless the thread has a **new message** since review.
- Filer never removes-then-reapplies a label that's already correct (no flicker, no churn, no needless API writes).
- Re-running the whole sweep must converge to the same label set, not oscillate. `AI/Reviewed` is the anchor that makes the whole pipeline replay-safe — mirroring the `idempotencyKey` contract [Steward](agents/steward.md) uses for counters.

### 3. No contradictory labels
The classifier must not emit logically inconsistent sets. Hard exclusions:
- **More than one triage label** — `① … ⑤` are mutually exclusive; pick exactly one.
- `Suggest/Delete` **with** `① Action Required` — you can't both need to act and want it gone.
- `Suggest/Unsubscribe` **with** `Type/Personal` or `From/VIP` — never suggest unsubscribing from a human you care about.
- `Due/Expired` **with** `Due/Today`/`Due/ThisWeek` — one deadline bucket only.
- `⑤ No Action` **with** any `Needs/*` — "no action" means no action.

When the right label set is genuinely ambiguous, prefer `AI/Uncertain` over guessing into a contradiction.

### 4. Security mail is sensitive
`Type/Security` covers 2FA codes, login alerts, password resets, and account-security mail.
- **Never reproduce 2FA codes or reset links** in *any* digest, the Vault, exports, or a Herald draft. Refer to the email; never quote the secret.
- **Never click links** in `Type/Security` or `⚠ Phishing-Suspect`. Filer does not follow links anywhere, but this is the bright line.
- A genuine security alert and a phishing attempt can look identical — when sender authentication is off, lean toward `⚠ Phishing-Suspect` and stop. See [security & privacy](11-security-privacy.md).

### 5. Promotion vs Newsletter vs Transactional are different things
Do **not** lump opted-in content with ads, and don't treat receipts as marketing.
- `Type/Promotion` = marketing / sales / advertisement → fair game for `Suggest/Unsubscribe`.
- `Type/Newsletter` = **opted-in** content the owner wants → goes to the reading queue (`④ FYI / Read Later`), **not** an unsubscribe suggestion by default.
- **Transactional** mail (`Finance/Receipt`, `Events/Confirmed`, `Job/*` status, `Type/Security`) is triggered by something the owner *did* — never tag it promotional and never suggest unsubscribing; you'd lose receipts and confirmations.

### 6. Finance / medical privacy
Flag finance (and any medical) mail, but **don't expose details in shared or exported views.** Counts and "a bill is due" are fine; account numbers, balances, amounts, and diagnoses are not. The Vault's `Finances snapshot` shows *that* something is due, not the sensitive specifics. Treat this data as need-to-know.

### 7. Thread vs message
Gmail labels apply to the **whole thread**, but a long thread can be mixed (an old recruiter outreach that's now a scheduling thread).
- Label by the **latest actionable message**, not the first.
- When a reply changes the state (e.g. owner replied → thread moves from `① Action Required` to `③ Awaiting Reply`), re-evaluate the triage label on the **new** message — this is the legitimate exception to the `AI/Reviewed` skip in rule #2.

### 8. Reserved system labels can't be touched
`INBOX`, `SENT`, `SPAM`, `TRASH` (and other Gmail system labels) are reserved — Filer must not attempt to create, modify, or remove them. All Atlas labels live under the namespaces above (`Type/…`, `Needs/…`, `Due/…`, `From/…`, `Suggest/…`, `AI/…`, and the circled-numeral triage set). Don't collide with system names.

### 9. Gmail API rate limits & batching
The push trigger can fan out hard during a busy hour.
- **Batch** label modifications (`batchModify`) instead of one call per thread.
- **Exponential back-off** on `429` / `403 rateLimitExceeded`; respect quota.
- De-dupe within a sweep so the same thread isn't written twice.
- A sustained rate-limit or auth failure is a Flagger event (it means labels are going stale and Herald will read a stale picture).

### 10. Color-code every parent group
Each parent group has a suggested color above. The goal is **fast visual scanning** in the Gmail sidebar: red/urgent for `① Action Required` and `⚠ Phishing-Suspect`, a calm distinct hue per `Type/*` parent, one shared "action" amber for `Needs/*`. Set colors once at label-creation time; keep them stable so the owner's muscle memory holds.

---

## Worked example — incoming Shopify recruiter email

**Scenario.** A recruiter at Shopify emails the owner:

> *From:* `talent@shopify.com`
> *Subject:* "Daniel — interested in a Backend Engineer role? Quick OA first"
> *Body:* "We loved your GitHub. To move forward, please **complete a short online assessment by this Friday** and **reply** with your availability for a chat next week."

**How Filer reasons:**

1. It's a recruiter reaching out → `Type/Job` + `Job/Recruiter`. The body asks for an OA, so the OA child also applies → `Job/OA`.
2. The owner must *do* something concrete, with a hard date → triage `① Action Required` (not `②` — the OA is a gate, effectively mandatory to proceed).
3. Two concrete actions: complete the assessment, and reply with availability → `Needs/Reply` **and** `Needs/Register` (the OA must be started/registered). Both feed [Forge](agents/forge.md).
4. Deadline is "this Friday" → `Due/ThisWeek`. (Filer would re-stamp this to `Due/Today` on the sweep the morning it's actually due.)
5. Sender is Shopify → `From/Company/Shopify`. Shopify is on the VIP/target list → `From/VIP`, which auto-bumps priority (consistent with the `① Action Required` choice).
6. It's a real, useful thread → `Suggest/Keep`. Sender authenticates correctly and links go to `shopify.com`, so **no** `⚠ Phishing-Suspect`.
7. Filer is confident → `AI/Reviewed`, **no** `AI/Uncertain`.

**Exact label set Filer applies:**

```
① Action Required
Type/Job
Job/Recruiter
Job/OA
Needs/Reply
Needs/Register
Due/ThisWeek
From/Company/Shopify
From/VIP
Suggest/Keep
AI/Reviewed
```

**Downstream effects:**

- [Forge](agents/forge.md) reads `Needs/Reply` + `Needs/Register` + `Due/ThisWeek` → creates two tasks ("Start Shopify OA — due Fri", "Reply to Shopify recruiter with availability"), each with the Friday deadline.
- [Sundial](agents/sundial.md) puts the Friday deadline on Google Calendar.
- [Steward](agents/steward.md) increments the job funnel: this thread advances the Shopify application to the **OA** stage on the Vault kanban, under `From/Company/Shopify`.
- [Herald](agents/herald.md) surfaces it at the top of the morning digest because of `① Action Required` + `From/VIP`.

**Contrast — if the same email were a phishing spoof** (`From: talent@shopiffy-careers.net`, link to a credential-harvesting site): Filer applies `⚠ Phishing-Suspect`, leaves the thread otherwise untouched, applies `AI/Uncertain`, and does **not** create tasks or click anything. That's a [Flagger](agents/flagger.md) event with a trust score the owner can weigh.

---

## Related docs

- [Filer](agents/filer.md) — the agent that owns and applies this taxonomy.
- [Herald](agents/herald.md) — reads these labels to build the digest.
- [Forge](agents/forge.md) — turns `Needs/*` into tasks.
- [Sundial](agents/sundial.md) — puts `Due/*` deadlines on the calendar.
- [Steward](agents/steward.md) — counters fed by `Job/*`, `Events/*`, etc.
- [Flagger](agents/flagger.md) — receives phishing / rate-limit / low-confidence flags.
- [scheduling](03-scheduling.md) — Filer's continuous push + 07:45 pre-Herald sweep.
- [security & privacy](11-security-privacy.md) — `gmail.modify` scope, 2FA/phishing handling.
