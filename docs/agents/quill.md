# Quill (screen autofill)

**Purpose:** A **local** agent (roster #12) that reads the screen / current document, maps each form-field label to a field in [The Codex](../07-source-of-truth-codex.md), and autofills the form — confirming with the owner before anything is submitted. Screen content never leaves the device.

## At a glance

| | |
|---|---|
| **Codename** | **Quill** |
| **Role** | Screen-aware form autofill from the Codex |
| **Roster #** | 12 (Tier 3 — local capture / screen) |
| **Runtime** | **Local** macOS daemon (menubar app / launchd) — cannot run on Cloudflare |
| **Trigger** | **hotkey / on-demand** (user-initiated; never scheduled) |
| **Inputs** | Live screen content (accessibility tree / vision), the focused window/form, [The Codex](../07-source-of-truth-codex.md) (read-only) |
| **Outputs** | Filled field values written into the **active document** (local); a fill-summary the owner approves before submit |
| **Dependencies** | [The Codex](../07-source-of-truth-codex.md) (source of truth), the local daemon (shared with [Echo](echo.md)), macOS Accessibility + Screen Recording permissions |
| **MCPs / tools** | Local accessibility API (AX), optional on-device vision OCR, keystroke/value injection — **all local**. No cloud MCP needed for the read/fill loop. |
| **Writes to** | The **active document only** (local form fields). Never the Vault, never Gmail, never external systems. |
| **Confirmation gate** | Yes — Quill fills but **never auto-submits**. Submit stays with the owner. |

---

## What it does

The owner hits a hotkey while a form is on screen (a job application, an EEO/demographics page, a sign-up). Quill:

1. Reads the focused window and discovers the form's fields and their **labels**.
2. Maps each label to a Codex field using the canonical mapping (see [The Codex](../07-source-of-truth-codex.md) §11): `first name`→`Daniel`, `last name`→`Chahine`, `my email`→the owner's email, and so on.
3. Fills the matched fields with values pulled from the Codex.
4. Shows a **review panel** of every proposed fill (label → value, with confidence) and waits.
5. Leaves **submit** entirely to the owner — Quill never clicks Submit/Apply/Send.

Quill embodies two of Atlas's design pillars:

- **Suggest, don't destroy** (SPEC §0.2): autofill is a draft; the owner confirms before the irreversible step (submission).
- **Cloud by default, local when it must be** (SPEC §0.3): screen access requires the physical machine, so Quill runs as a local daemon — same split as [Echo](echo.md) (audio).

> Quill is **read-only against the Codex**. It never edits the profile. Profile changes go through the explicit "update my profile" flow (SPEC §11), not through Quill.

---

## How it works

### Screen reading — accessibility API first, vision as fallback

```
            ┌─────────────────────────────────────────────┐
  hotkey ─▶ │  Quill (local daemon)                        │
            │                                              │
            │  1. AX query focused window                  │
            │       ├─ found structured fields? ──▶ use AX │
            │       └─ web/canvas/no AX tree? ──▶ vision   │
            │  2. on-device OCR + layout (vision fallback) │
            │  3. build {label, role, bounds, current} list│
            └───────────────┬──────────────────────────────┘
                            ▼
                 field list (labels + element refs)
```

Two read strategies, tried in order:

1. **Accessibility API (AX) — preferred.** Quill queries the macOS Accessibility tree of the **focused** window for elements with roles like text field, combo box, checkbox, and radio group, plus their associated label / placeholder / `AXTitle`. This is exact (it sees the real field identity, not pixels) and is the fastest, most reliable path for native apps and accessibility-friendly web pages.
2. **Vision / OCR — fallback.** When a form has no usable AX tree (custom canvas widgets, some web forms, PDFs, screenshots), Quill captures the focused window and runs **on-device** OCR + layout analysis to recover label↔field pairs by spatial association (label left-of / above the input). Vision never leaves the machine (see Privacy).

The output of either path is a normalized list: `{ label, role, element_ref/bounds, current_value }`.

### Field-label → Codex-field mapping

Quill normalizes each discovered label (lowercase, strip punctuation, expand abbreviations) and matches it against the Codex field map. The canonical examples from [The Codex](../07-source-of-truth-codex.md) §11:

| Form-field label (normalized) | Codex section → field | Value |
|---|---|---|
| `first name`, `given name` | identity → first name | `Daniel` |
| `last name`, `surname`, `family name` | identity → last name | `Chahine` |
| `my email`, `email`, `e-mail address` | identity → email | the owner's email |
| `phone`, `mobile`, `telephone` | identity → phone | from Codex |
| `linkedin`, `github`, `portfolio`, `website` | links / socials | from Codex |
| `address`, `city`, `postal/zip`, `country` | addresses | from Codex |
| `school`, `university`, `degree`, `grad date` | education | from Codex |
| `current title`, `company`, `years of experience` | work experience | from Codex |
| `skills`, `technologies` | skills | from Codex |
| `short bio`, `summary`, `about you` | bios (short/long) | from Codex |
| `gender`, `race / ethnicity`, `veteran status`, `disability` | demographics / EEO answers | from Codex |
| `cover letter`, `why this role`, voice-sensitive free text | bios + "voice" notes | from Codex (drafted, flagged for review) |

Matching rules:

- **Confidence per field.** Each match gets a confidence score. Exact label hits (`first name`) are high; fuzzy/semantic hits (`legal first name` → first name) are medium; free-text prompts (`Tell us about yourself`) are low and always surfaced for review.
- **Unknown labels are left blank** and listed as "no Codex match" rather than guessed.
- **No invention.** If the Codex has no value for a field, Quill leaves it empty — it never fabricates data.
- **EEO / demographics** answers come only from the explicit demographics section of the Codex; if absent, Quill leaves them for the owner (these are sensitive and often "decline to answer").

### Confirm before submitting

Quill **fills, then stops**. It presents a review panel and waits for the owner.

```
┌──────────────── Quill — review before submit ────────────────┐
│ Form: "Software Engineer — Application" (lever.co)            │
│                                                              │
│  ✓ First name      Daniel                       (high)       │
│  ✓ Last name       Chahine                      (high)       │
│  ✓ Email           ****@****                     (high)       │
│  ✓ Phone           +1 ***‑***‑****               (high)       │
│  ✓ LinkedIn        linkedin.com/in/…             (high)       │
│  ~ Years of exp.   3                             (medium)     │
│  ✎ Why this role?  [drafted — review voice]      (low)        │
│  ✗ Referral code   — no Codex match — (left blank)           │
│                                                              │
│  [ Fill all ]   [ Edit a field ]   [ Skip field ]   [ Cancel ]│
│  Submit is up to you — Quill will NOT click Apply.            │
└──────────────────────────────────────────────────────────────┘
```

- The owner can accept all, edit any value inline, skip a field, or cancel.
- **Quill never clicks Submit / Apply / Send.** That irreversible, outward-facing action is the owner's, consistent with the confirmation-gate model (SPEC §12) used for [Usher](usher.md) (registration/payment) and [Envoy](envoy.md) (public posts).
- Sensitive values (email, phone) are **masked** in the review panel; the real value is injected into the field, but the on-screen summary is redacted.

### Privacy — screen content stays local

- **On-device only.** Both the AX read and the vision fallback run entirely in the local daemon. **Raw screen content, screenshots, and the OCR text never leave the device** and are never sent to Cloudflare, the Wire, or any model endpoint.
- **No cloud round-trip for the fill loop.** Mapping label→Codex value is a local lookup against the local copy of the Codex. Quill does not call a cloud LLM with your screen.
- **Ephemeral capture.** Screen captures used for the vision fallback are held in memory for the duration of one fill and discarded; nothing is persisted to R2 or D1.
- **Aligned with SPEC §12:** "Local-only sensitive capture: Echo audio and **Quill screen** never leave the device except as derived artifacts the owner approves." The only artifact that leaves Quill's hands is the **filled value the owner sees and confirms** — and even that only goes into the local form, not into Atlas state.
- **No Vault write.** Unlike most agents, Quill does **not** feed [Steward](steward.md) or the Wire. It has nothing to report to the dashboard; a fill is a private, local action.

---

## Inputs / Outputs

**Inputs**
- The **focused window** on the owner's screen (accessibility tree, or pixels for the vision fallback).
- [The Codex](../07-source-of-truth-codex.md) — the local, read-only copy of personal facts (identity, addresses, education, work, skills, projects, bios, socials, demographics/EEO, voice notes).
- The hotkey/on-demand trigger.

**Outputs**
- Field values written into the **active document** (local).
- A **review panel** of proposed fills with per-field confidence.
- (No external output. No Vault event. No queue message.)

---

## Dependencies

- **[The Codex](../07-source-of-truth-codex.md)** — the single source of truth Quill reads. Read-only; profile edits never happen through Quill (SPEC §11).
- **Local daemon** — the macOS menubar/launchd process that also hosts [Echo](echo.md). Quill cannot run on Cloudflare Workers (SPEC §7 — local agents).
- **macOS permissions** — **Accessibility** (to read the AX tree and inject values) and, for the vision fallback, **Screen Recording**. Both are owner-granted, OS-level prompts.

Quill has **no agent dependencies in the pipeline** — it is on-demand and standalone (see [scheduling](../03-scheduling.md): `on-demand … user-initiated`). It does not consume from [Filer](filer.md)/[Herald](herald.md)/[Forge](forge.md), and nothing downstream consumes from Quill.

---

## Schedule / Triggers

| Trigger | Mode | Notes |
|---|---|---|
| **hotkey / on-demand** | — | User-initiated only. Per [scheduling](../03-scheduling.md), Quill is in the `on-demand` row with [Usher](usher.md), [Envoy](envoy.md), [Librarian](librarian.md), [Switchboard](switchboard.md). |

Quill is **never** scheduled by a cron trigger and **never** runs in the morning chain or any pipeline. It fires only when the owner invokes it on the form in front of them.

---

## Failure modes & Flagger hooks

Quill is local and standalone, so most failures are surfaced inline in its own panel. Notable conditions still get reported to [Flagger](flagger.md) (SPEC §8) — the local daemon forwards a flag event over its authenticated channel when it is online.

| Failure mode | Handling | Flag (severity / trust) |
|---|---|---|
| **Accessibility permission missing/revoked** | Halt; prompt owner to grant in System Settings. No fill. | `P3 Medium`, high trust (deterministic) |
| **No AX tree and vision fallback fails** (unreadable form) | Tell owner Quill can't read this form; fill nothing. | `P3 Medium`, high trust |
| **Low-confidence label match** | Field left for review (not auto-filled); marked `~`/`✎` in panel. | `P4 Low / Info`, lower trust (LLM/heuristic guess) |
| **Codex field missing** | Leave blank, list as "no Codex match." Never fabricate. | `P4 Low / Info` (informational) |
| **Sensitive form detected** (payment, password, SSN field) | **Refuse to autofill** secrets; defer to the owner. | `P2 High`, high trust |
| **Value injection rejected by the app** | Report which fields didn't take; owner fills manually. | `P3 Medium`, high trust |
| **Owner cancels** | No-op; nothing written, nothing flagged. | — |

Privacy guard on flags: a Quill flag may name **the form and the field labels**, but **never the screen content or the filled values** — keeping with "screen content stays local."

---

## Config

| Key | Default | Notes |
|---|---|---|
| `hotkey` | owner-set chord | Global hotkey to invoke Quill on the focused form. |
| `read_strategy` | `ax_first` | `ax_first` (AX, vision fallback) · `ax_only` · `vision_only`. |
| `confirm_before_submit` | `true` (locked) | Quill never auto-submits; this is not user-disablable. |
| `mask_sensitive_in_panel` | `true` | Redact email/phone/etc. in the review panel. |
| `autofill_eeo` | `false` | Demographics/EEO answers are off by default (often "decline"). |
| `low_confidence_threshold` | tuned | Below this, a field is surfaced for review rather than filled. |
| `codex_path` | local | Path to the local read-only Codex copy. |

Secrets (any cloud auth for the daemon's Flagger channel) live in **Cloudflare Secrets Store / Wrangler secrets**, never in the Codex or [The Vault](steward.md) (SPEC §12).

---

## Open questions

- **Browser coverage:** native AX vs. a browser-extension bridge for web forms — which gives more reliable label↔field mapping for sites like Lever/Greenhouse/Workday?
- **Multi-page / dynamic forms:** how should Quill handle wizards that reveal fields page-by-page (re-scan on each step)?
- **Voice fields:** cover letters / "why this role" pull from the Codex "voice" notes — how much should Quill draft vs. leave entirely to the owner?
- **EEO defaults:** should `autofill_eeo` ever be on, given how often the right answer is "decline to answer"?
- **Codex freshness:** how does Quill ensure its local Codex copy is current without the cloud pushing screen-adjacent data down?

---

## Example run — filling a job application form

> Owner is on a **Software Engineer** application page (Lever) and presses the Quill hotkey.

1. **Invoke.** Hotkey fires. Quill identifies the focused window: `lever.co — "Software Engineer — Application"`.
2. **Read (AX first).** Quill queries the accessibility tree, finds 8 fields with labels: *First name, Last name, Email, Phone, LinkedIn, Years of experience, Why this role?, Referral code.* (Had the page exposed no AX tree, Quill would fall back to on-device OCR.)
3. **Map to Codex.** Each label is normalized and matched against [The Codex](../07-source-of-truth-codex.md) §11:
   - `first name` → `Daniel` (high)
   - `last name` → `Chahine` (high)
   - `email` → owner's email (high)
   - `phone` → owner's phone (high)
   - `linkedin` → owner's LinkedIn URL (high)
   - `years of experience` → `3` (medium — semantic match)
   - `why this role?` → drafted from bios + voice notes (low — flagged for review)
   - `referral code` → **no Codex match** → left blank
4. **Review panel.** Quill shows every proposed fill with confidence; email and phone are **masked** in the panel. The "Why this role?" draft is marked `✎ review voice`. Quill makes clear it will **not** click Apply.
5. **Owner confirms.** Owner edits the years-of-experience value, rewrites two sentences of the cover-letter draft, accepts the rest, and clicks **Fill all**.
6. **Inject.** Quill writes the confirmed values into the live form fields via the local AX/value-injection path.
7. **Stop.** The form is filled; the cursor is in the Submit button's vicinity but **Quill does not press it**. The owner reviews the page and submits themselves.
8. **Privacy outcome.** Nothing left the machine: no screenshot, no OCR text, no field values were sent to the cloud, and **no event was written to [Steward](steward.md) or the Wire**. The only state change is the locally filled form the owner is about to submit.

> Contrast with [Usher](usher.md), which *does* register/submit on the owner's behalf (behind a confirmation gate and with calendar/Steward writes). Quill deliberately stops one step earlier — it never submits, and it never writes to Atlas state.
