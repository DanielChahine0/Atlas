# The Codex — single source of truth

> **Purpose:** One canonical document holding every reusable personal fact about the owner (Daniel Chahine), read by [Quill](agents/quill.md) (autofill), [Envoy](agents/envoy.md) (brand sync), and **Archivist** (work context) — and writable only through a guarded "update my profile" flow. (SPEC-CANON §11.)

## At a glance

| | |
|---|---|
| **Codename** | The Codex |
| **Lives in** | `codex.md` in [The Vault](06-hosting-cloudflare-mcp.md) (Obsidian) and/or a mirrored Google Doc |
| **Trigger** | Read on-demand by consuming agents; written only via the explicit "update my profile" flow |
| **Runtime** | Storage artifact (not an agent); read via the Obsidian MCP bridge / Google Drive MCP |
| **Inputs** | Owner-curated personal facts; profile-update events (gated) |
| **Outputs** | Field values for autofill, brand copy, and meeting context |
| **Read by** | **Quill** (form autofill), **Envoy** (brand sync), **Archivist** (work context) |
| **Writes to** | **Read-only to agents** except via the guarded update flow |
| **Written via** | **Steward**-style serialized write on owner confirmation (one writer, no races) |
| **MCPs / tools** | Obsidian MCP bridge, Google Drive MCP (for the Doc mirror) |

> The Codex is the **identity/profile** source of truth. It is distinct from **The Vault**, which holds
> live dashboard *state* (counters, day plans, flags). Personal facts live in the Codex; dashboard
> state lives in the Vault. See SPEC-CANON §1 and [the dashboard doc](05-dashboard.md).

---

## What it does

The Codex is the place every reusable fact about the owner is written **once** and read **everywhere**.
Instead of three agents each hardcoding "Daniel Chahine / chahinedaniel0@gmail.com", they all read the
same record. That gives:

- **Quill** the field values to autofill a form on screen (`first name` → `Daniel`, `email` → …).
- **Envoy** the bios, links, and project blurbs to sync to LinkedIn / X / GitHub / the portfolio.
- **Archivist** the work context (current title, company, ongoing projects) to write meeting notes that
  understand who the owner is and what they work on.

Because it is the single source of truth, **the Codex is read-only to agents**. The only way it changes
is the explicit, owner-confirmed **"update my profile"** flow (see below). This keeps Quill from
silently "learning" a wrong value off a form, and keeps Envoy from rewriting your bio because a
platform reworded it.

---

## Full section list

The Codex is organized into the sections below (SPEC-CANON §11). Order is stable so deep links and the
mapping table stay valid.

| § | Section | Holds | Primary reader |
|---|---------|-------|----------------|
| 1 | **identity** | name, preferred name, pronouns, email, phone, links | Quill, Envoy |
| 2 | **addresses** | mailing, city/region/country, willing-to-relocate | Quill |
| 3 | **education** | school, degree, field, dates, GPA | Quill, Archivist |
| 4 | **work experience** | title, company, dates, location, bullets | Quill, Envoy, Archivist |
| 5 | **skills** | languages, frameworks, tools (grouped) | Quill, Envoy |
| 6 | **projects** | name, repo, blurb, links, tags | Envoy, Quill |
| 7 | **bios** | short bio, long bio, one-liner / headline | Envoy |
| 8 | **socials** | LinkedIn, X, GitHub, portfolio, handles | Envoy, Quill |
| 9 | **demographics / EEO** | voluntary self-ID answers (gender, race/ethnicity, veteran, disability, work auth) | Quill |
| 10 | **voice** | tone/voice notes for posts, do/don't list | Envoy |

> **Demographics / EEO are voluntary.** Every EEO field supports an explicit *"Decline to self-identify"*
> value, and Quill must never invent one. See [the autofill mapping](#field-label--codex-field-mapping-autofill)
> and the careful-handling note there.

---

## Schema — concrete example (YAML)

Realistic placeholder data. This is the canonical layout `codex.md` front-matter / the Google Doc
mirror is generated from.

```yaml
# codex.md  —  The Codex (single source of truth)  —  SPEC §11
# Read-only to agents. Mutate ONLY via the "update my profile" flow.
schema_version: 1
updated: 2026-05-29T09:14:00-04:00

identity:
  first_name: Daniel
  last_name: Chahine
  preferred_name: Daniel
  full_name: Daniel Chahine
  pronouns: he/him
  email: chahinedaniel0@gmail.com
  phone: "+1-416-555-0142"
  links:
    portfolio: https://danielchahine.dev
    resume: https://danielchahine.dev/resume.pdf

addresses:
  primary:
    line1: "123 Example St"
    city: Toronto
    region: ON
    postal_code: "M5V 2T6"
    country: Canada
  willing_to_relocate: true
  remote_ok: true

education:
  - school: University of Toronto
    degree: BSc
    field: Computer Science
    start: 2021-09
    end: 2025-06
    gpa: "3.8/4.0"
    location: "Toronto, ON"

work_experience:
  - title: Software Engineer Intern
    company: Shopify
    location: "Toronto, ON (Remote)"
    start: 2024-05
    end: 2024-08
    current: false
    bullets:
      - "Built a Workers-based pipeline cutting webhook latency 40%."
      - "Shipped an internal MCP tool used by 3 teams."

skills:
  languages: [TypeScript, Python, Go, SQL]
  frameworks: [React, Next.js, Cloudflare Workers]
  tools: [Git, Obsidian, Wrangler, D1]

projects:
  - name: Atlas
    repo: https://github.com/dchahine/atlas
    blurb: "Personal multi-agent orchestrator for email, tasks, and brand."
    links: [https://danielchahine.dev/atlas]
    tags: [agents, cloudflare, automation]

bios:
  headline: "Software engineer building personal AI infrastructure."
  short: "Daniel Chahine — CS @ UofT, building Atlas, a personal multi-agent system."
  long: >
    Daniel Chahine is a software engineer focused on agentic systems and developer
    tooling. He builds Atlas, a personal orchestrator that runs a fleet of
    specialized sub-agents across email, calendar, job-hunting, and personal brand.

socials:
  linkedin: https://linkedin.com/in/danielchahine
  x: https://x.com/danielchahine
  github: https://github.com/dchahine
  github_username: dchahine
  website: https://danielchahine.dev

demographics_eeo:                # voluntary; "Decline to self-identify" always allowed
  gender: "Decline to self-identify"
  race_ethnicity: "Decline to self-identify"
  hispanic_latino: "Decline to self-identify"
  veteran_status: "I am not a protected veteran"
  disability_status: "Decline to self-identify"
  work_authorization: "Authorized to work in Canada; require sponsorship in the US"
  requires_sponsorship: true

voice:
  tone: "Direct, concrete, lightly technical. No hype, no emoji."
  do: ["lead with the result", "name the stack", "short sentences"]
  dont: ["buzzwords", "exclamation marks", "first-person plural for solo work"]
```

For consumers that want JSON (Quill's local autofill engine, Envoy's API payloads), the same record
serializes 1:1:

```json
{
  "schema_version": 1,
  "identity": { "first_name": "Daniel", "last_name": "Chahine",
                "email": "chahinedaniel0@gmail.com", "phone": "+1-416-555-0142" },
  "demographics_eeo": { "gender": "Decline to self-identify",
                        "veteran_status": "I am not a protected veteran" }
}
```

---

## How Quill, Envoy, and Archivist read it

All three are **read-only** consumers. None of them writes the Codex.

```
                          ┌─────────────────────────┐
                          │        The Codex        │   (read-only to agents)
                          │  identity · education   │
                          │  work · projects · bios │
                          │  socials · EEO · voice  │
                          └────────────┬────────────┘
              read identity/EEO/       │ read identity/work/projects/bios/socials/voice
              addresses/socials  ┌─────┴─────┐  read work/education/projects (context)
                                 ▼           ▼               ▼
                            ┌────────┐  ┌─────────┐    ┌────────────┐
                            │ Quill  │  │  Envoy  │    │ Archivist  │
                            │ (local │  │ (brand  │    │ (meeting   │
                            │ autofill)  │  sync)  │    │  notes)    │
                            └────────┘  └─────────┘    └────────────┘
```

- **[Quill](agents/quill.md) — screen-aware form autofill (local).** On a hotkey, Quill reads the form
  on screen, maps each visible field label to a Codex field via the [mapping table](#field-label--codex-field-mapping-autofill),
  and fills it. It reads mostly **identity**, **addresses**, **education**, **work experience**,
  **skills**, **socials**, and — only when the form asks — **demographics / EEO**. Quill **suggests, does
  not submit**: it fills, the owner reviews and clicks submit (SPEC-CANON pillar 2). Runs **local**
  because it needs screen access (SPEC-CANON §7).

- **[Envoy](agents/envoy.md) — personal-brand sync (cloud + browser).** Envoy reads **bios**, **socials**,
  **projects**, **work experience**, and **voice** to keep LinkedIn / X / GitHub / portfolio in sync.
  The **voice** section governs *how* generated posts read. Because public posts are irreversible,
  Envoy drafts and **gates behind owner confirmation** (SPEC-CANON §3 Tier 4, §12). Envoy also feeds
  **Steward** with projects/experience counts.

- **Archivist — meeting-notes organizer (cloud).** Archivist reads **work experience** (current title,
  company), **education**, and **projects** as *context* so meeting notes know who the owner is and what
  they're working on. It pairs this Codex context with the **Echo** transcript (SPEC-CANON §4 meetings
  pipeline) and writes notes through **Steward** — never to the Codex.

> **One writer per resource** (SPEC-CANON pillar 1): the Codex's "writer" is the owner via the update
> flow. Quill, Envoy, and Archivist are strictly readers.

---

## Field-label → Codex-field mapping (autofill)

This is the table [Quill](agents/quill.md) uses to translate a form's visible label into a Codex value.
Matching is case-insensitive and tolerant of common variants. Order matters: more specific labels win
(e.g. `preferred name` before `name`).

| Form field label (and common variants) | Codex field | Example value |
|---|---|---|
| First name · Given name · Legal first name | `identity.first_name` | `Daniel` |
| Last name · Surname · Family name | `identity.last_name` | `Chahine` |
| Full name · Name · Legal name | `identity.full_name` | `Daniel Chahine` |
| Preferred name · Nickname · "Goes by" | `identity.preferred_name` | `Daniel` |
| Email · Email address · Contact email | `identity.email` | `chahinedaniel0@gmail.com` |
| Phone · Mobile · Phone number | `identity.phone` | `+1-416-555-0142` |
| Address · Street address · Address line 1 | `addresses.primary.line1` | `123 Example St` |
| City · Town | `addresses.primary.city` | `Toronto` |
| State · Province · Region | `addresses.primary.region` | `ON` |
| Zip · Postal code · ZIP/Postal | `addresses.primary.postal_code` | `M5V 2T6` |
| Country | `addresses.primary.country` | `Canada` |
| LinkedIn · LinkedIn URL · LinkedIn profile | `socials.linkedin` | `https://linkedin.com/in/danielchahine` |
| GitHub · GitHub URL · GitHub username | `socials.github` / `socials.github_username` | `https://github.com/dchahine` |
| Portfolio · Website · Personal site | `socials.website` | `https://danielchahine.dev` |
| Current title · Job title · Position | `work_experience[0].title` | `Software Engineer Intern` |
| Current company · Employer · Organization | `work_experience[0].company` | `Shopify` |
| School · University · Institution | `education[0].school` | `University of Toronto` |
| Degree · Degree type | `education[0].degree` | `BSc` |
| Major · Field of study | `education[0].field` | `Computer Science` |
| Graduation date · End date (education) | `education[0].end` | `2025-06` |
| **Gender** (EEO/voluntary) | `demographics_eeo.gender` | `Decline to self-identify` |
| **Race / Ethnicity** (EEO/voluntary) | `demographics_eeo.race_ethnicity` | `Decline to self-identify` |
| **Hispanic or Latino?** (EEO/voluntary) | `demographics_eeo.hispanic_latino` | `Decline to self-identify` |
| **Veteran status** (EEO/voluntary) | `demographics_eeo.veteran_status` | `I am not a protected veteran` |
| **Disability status** (EEO/voluntary) | `demographics_eeo.disability_status` | `Decline to self-identify` |
| Are you authorized to work…? | `demographics_eeo.work_authorization` | see field |
| Do you require sponsorship? | `demographics_eeo.requires_sponsorship` | `true` |

**Careful-handling rules for the mapping (Quill enforces these):**

- **No invented values.** If a label has no confident mapping, Quill leaves it blank and surfaces it to
  the owner — it never guesses.
- **EEO / demographics are voluntary.** Prefer the owner's stored value; where they chose *"Decline to
  self-identify"*, select that option literally. Never substitute a different answer.
- **Low-confidence → ask.** Ambiguous labels (e.g. a bare `Name` that could be full or first) are filled
  with the best match but **flagged for review**, consistent with [Flagger](08-flagger.md) trust scoring.
- **Sensitive fields stay local.** Quill reads the Codex and fills on the local machine; values aren't
  shipped to the cloud (SPEC-CANON §12).
- **Fill, don't submit.** Quill populates fields only; the owner reviews and submits (suggest-don't-destroy).

---

## The guarded "update my profile" flow

The Codex is **read-only to agents except via an explicit "update my profile" flow** (SPEC-CANON §11).
This is the *only* sanctioned write path. It exists so a stale or wrong fact can be corrected without
any agent silently mutating the source of truth.

```
Owner: "Atlas, update my profile"  (or supplies a corrected value)
        │
        ▼
1. Atlas opens the update flow and reads the current Codex value(s).
        │
        ▼
2. Produces a DIFF:   field            old              new
                      identity.phone   +1-416-555-0142  +1-647-555-0199
        │
        ▼
3. CONFIRMATION GATE — owner reviews the diff and approves/edits/cancels.
        │  (no approval ⇒ no write; SPEC §12 confirmation gates)
        ▼
4. Serialized write to the Codex (one writer, no races; bumps `updated`
   and `schema_version` if structure changed). Mirror to the Google Doc.
        │
        ▼
5. Emits an event on the Wire → logged in the Vault run-log; any failure
   → Flagger (severity + trust). Consumers (Quill/Envoy/Archivist) pick up
   the new value on their next read — no caches to invalidate by hand.
```

Rules for the flow:

- **Diff + confirm, always.** Every change is shown as old → new and gated behind explicit owner
  confirmation (SPEC-CANON §12). Default is *propose, don't apply*.
- **Single serialized writer.** Writes go through one path so two updates can't race or corrupt
  `codex.md` (mirrors Steward's serialized-write discipline, SPEC-CANON §6.4).
- **No secrets in the Codex.** Tokens, passwords, and 2FA codes never go here — they live in Cloudflare
  Secrets Store (SPEC-CANON §12). The Codex holds public-ish identity facts only.
- **Auditable.** Each accepted change is logged (D1 audit log) and surfaced via [Flagger](08-flagger.md)
  if anything looks off (e.g. an EEO field changing unexpectedly).
- **Agents propose at most.** If Envoy notices LinkedIn has a newer title than the Codex, it does **not**
  edit the Codex — it can *suggest* an update that runs through this same gated flow.

---

## Failure modes & Flagger hooks

| Failure | Detection | Flag (severity / trust) |
|---|---|---|
| Codex file missing / unpar. YAML | Read fails on consumer load | `P2 High`, high trust (hard error) |
| `schema_version` mismatch vs. consumer | Version check on read | `P3 Medium`, high trust |
| Quill can't map a required field | No confident mapping | `P4 Low`, medium trust → ask owner |
| EEO field changed without an update-flow event | Audit-log diff | `P2 High`, medium trust |
| Google Doc mirror drifted from `codex.md` | Mirror checksum compare | `P3 Medium`, high trust |
| Update flow write fails mid-write | Serialized-writer exception | `P1 Critical`, high trust (roll back) |

All flags route per [Flagger](08-flagger.md) §8: P1/P2 → push immediately; P3/P4 → batched into the
dashboard feed.

---

## Config

| Key | Default | Notes |
|---|---|---|
| `codex.path` | `Vault/codex.md` | Canonical file (Obsidian MCP bridge) |
| `codex.mirror` | Google Doc | Optional read mirror via Google Drive MCP |
| `codex.schema_version` | `1` | Bumped on structural change |
| `update_flow.require_confirmation` | `true` | Never write without an owner gate |
| `quill.mapping.case_insensitive` | `true` | Label matching |
| `quill.eeo.default_decline` | `true` | Prefer "Decline to self-identify" unless owner set a value |

---

## Open questions

- **Multiple addresses / experiences:** the mapping table targets index `[0]` (current). Do forms ever
  need a *prior* role/address, and should Quill prompt which one?
- **Resume parity:** should the Codex generate the resume PDF, or stay the upstream record the resume is
  built from?
- **EEO per-jurisdiction:** US EEO categories differ from Canadian self-ID — do we store both and let
  Quill pick by the form's locale?
- **Conflict surfacing:** when Envoy sees a platform value newer than the Codex, what's the exact UX for
  the suggested-update prompt?

---

### Related docs

- [Quill — screen-aware form autofill](agents/quill.md) (primary reader / autofill)
- [Envoy — personal-brand sync](agents/envoy.md) (primary reader / brand)
- [Dashboard — The Vault](05-dashboard.md) (live state, distinct from the Codex)
- [Flagger](08-flagger.md) (incident flagging for Codex failures)
- [Hosting — Cloudflare + MCP](06-hosting-cloudflare-mcp.md) (Obsidian/Drive MCP bridges)
- [Security & privacy](11-security-privacy.md) (secrets stay out of the Codex; local-only sensitive data)
