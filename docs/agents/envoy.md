# Envoy (personal-brand sync)

> **Purpose:** When the owner starts a new experience or project, **Envoy** propagates it everywhere at once — LinkedIn, the GitHub profile README, an X post, and the personal portfolio site — drafting every post/PR first and shipping only after an explicit confirmation gate.

Envoy is roster **#13** (Tier 4 — outward-facing / irreversible / convenience; build last, gate hardest). It is an **on-demand**, **OUTWARD/IRREVERSIBLE** agent. Public posts cannot be un-posted, so Envoy never acts without a human "yes."

---

## At a glance

| | |
|---|---|
| **Codename** | Envoy |
| **Role** | Personal-brand sync (LinkedIn, X, GitHub, portfolio) |
| **Roster #** | 13 (Tier 4 — outward-facing / irreversible / gated) |
| **Runtime** | Cloud + browser (Cloudflare Worker + headless browser) |
| **Trigger** | on-demand (user-initiated — see [scheduling](../03-scheduling.md)) |
| **Inputs** | Owner intent ("I started a new project/experience"); **The Codex** (identity, bios, voice notes, projects, work experience); GitHub repo for the project |
| **Outputs** | LinkedIn experience/project entry · GitHub profile README update · X post · portfolio-repo PR — **each drafted first**, shipped only on confirm |
| **Dependencies** | Reads **The Codex** (read-only); needs a GitHub repo to link the project to |
| **MCPs / tools** | **GitHub MCP** (profile README + portfolio PR), **browser** (LinkedIn, X), **The Codex** (read) |
| **Writes to** | External profiles (LinkedIn, X, GitHub README, portfolio site) and **Steward** (`projects published`++ / experience counts) via the **Wire** |
| **Gate** | **Confirmation gate** on every target — default = draft + ask (SPEC §2 pillar 2, §12) |

---

## What it does

The owner does one thing — "I started a new project" or "I started a new experience" — and Envoy fans that single event out to **four targets at once** so the personal brand stays consistent everywhere:

1. **LinkedIn** — adds a new **experience** entry (for a role/job) or a new **project** entry (for a side project), formatted in the owner's voice.
2. **GitHub profile README** — updates the special `<owner>/<owner>` profile repo's `README.md` (the pinned profile page) to feature the new project/experience.
3. **X (Twitter)** — composes a launch/announcement post sized for X.
4. **Personal portfolio site** — opens a **PR to the portfolio repo** that adds the project as code (a new card/entry), **linking the project to its GitHub repo**.

Everything Envoy writes — copy, bullets, links, bios — is sourced from **The Codex** (§11): identity, bios (short/long), socials, the project record (`name, repo, blurb, links`), and the **"voice" notes for posts**. Envoy never invents facts; if a field is missing it asks rather than guessing.

Two hard rules from the spec:

- **Suggest, don't destroy** (§0 pillar 2): every outward action is gated behind explicit human confirmation. Envoy **drafts every post and PR first**.
- **One writer per resource** (§0 pillar 1): Envoy does **not** touch the Vault. Brand counters move through **Steward** via an event on the **Wire**.

---

## How it works

### Multi-target fan-out

```
                            owner: "I started a new <project|experience>"
                                              │
                                              ▼
                                     ┌──────────────────┐
                                     │      Envoy       │
                                     │  reads The Codex │  (identity, bios, voice,
                                     │  + project repo  │   project blurb, socials)
                                     └────────┬─────────┘
                                              │  fan-out (draft all 4 in parallel)
              ┌───────────────┬───────────────┼───────────────┬───────────────┐
              ▼               ▼               ▼               ▼               
        ┌──────────┐   ┌────────────┐   ┌──────────┐   ┌──────────────┐
        │ LinkedIn │   │  GitHub    │   │    X     │   │  Portfolio   │
        │ exp/proj │   │  profile   │   │  post    │   │  repo  (PR)  │
        │ (browser)│   │  README    │   │ (browser)│   │ (GitHub MCP) │
        │          │   │(GitHub MCP)│   │          │   │ links → repo │
        └────┬─────┘   └─────┬──────┘   └────┬─────┘   └──────┬───────┘
             │               │               │                │
             └───────────────┴───────┬───────┴────────────────┘
                                      ▼
                         ┌─────────────────────────────┐
                         │   CONFIRMATION GATE          │
                         │   show all drafts → owner    │
                         │   per-target approve / edit  │
                         └──────────────┬──────────────┘
                                        │  approved targets only
                                        ▼
                            publish ▶ (post / push / open PR)
                                        │
                                        ▼
                          Wire event ▶ Steward (projects published++,
                                                experience count++)
                                        │
                                        ▼
                                    The Vault (Brand counters, §6.1)
```

### Step-by-step (pseudo-flow)

1. **Receive intent.** Owner triggers Envoy on-demand with: kind (`project` | `experience`), the title, the GitHub repo URL, and any free-text notes.
2. **Load the Codex.** Read identity, bios (short/long), socials, voice notes, and the matching `projects` / `work experience` record (`name, repo, blurb, links` for projects; `title, company, dates, bullets` for experience). Codex is **read-only** to Envoy.
3. **Resolve the repo.** Via **GitHub MCP**, confirm the project repo exists, read its `README` / description / topics to enrich the blurb, and capture the canonical repo URL (used as the link target on the portfolio + posts).
4. **Draft all four targets** (per-platform formatting, see below). Nothing is sent yet.
5. **Confirmation gate.** Present all drafts together. Owner can approve all, approve a subset, edit any draft, or cancel. Each target is independently confirmable — e.g. "post X and update the README, but hold LinkedIn."
6. **Publish approved targets only:**
   - LinkedIn → fill the new experience/project entry via **browser**.
   - GitHub README → commit the change to the profile repo via **GitHub MCP**.
   - X → publish the post via **browser**.
   - Portfolio → open a **PR** to the portfolio repo via **GitHub MCP** (a branch + file change + PR, not a direct push to the default branch).
7. **Update Steward.** Emit one **Wire** event per published outcome so the **Brand** counters in the Vault move (§6.1). Counters use `increment` + `idempotencyKey` so a re-run can't double-count.
8. **Report.** Surface success/partial-success; route any failure to **Flagger** (see Failure modes).

### Per-platform formatting

Each target has its own shape; Envoy formats from the **same** Codex facts but tailors copy per platform.

| Target | What gets written | Source fields (Codex) | Tool | Format notes |
|--------|-------------------|------------------------|------|--------------|
| **LinkedIn** | New **experience** entry (role) *or* new **project** entry (side project) | `work experience` (title, company, dates, bullets) **or** `projects` (name, blurb, links); `voice` | browser | Professional tone; bullet-style accomplishments; include repo/live links. Experience vs project chosen by the trigger `kind`. |
| **GitHub profile README** | Update the `<owner>/<owner>` profile repo `README.md` to feature the new project/experience | `projects` (name, repo, blurb), `socials`, `voice` | GitHub MCP | Markdown; add/refresh a project row or "currently building" line; keep existing layout; link the repo. |
| **X** | A single announcement/launch post | short `bio`, `projects` blurb, `socials`, `voice` | browser | Tight, within X length limits; 1 link (the repo or live site); hashtags only if the voice notes use them. |
| **Portfolio site** | **PR** to the portfolio repo adding the project as a code entry/card, **linking the project to its GitHub repo** | `projects` (name, repo, blurb, links) | GitHub MCP | Code change (e.g. a new project object/MDX/component) on a branch; PR title + body summarize the addition; the project entry links to its GitHub repo. |

---

## Inputs / Outputs

**Inputs**
- Owner intent: `kind` (`project` | `experience`), title, **GitHub repo URL**, optional notes.
- **The Codex** (§11): identity, bios (short/long), socials, voice notes, and the relevant `projects` / `work experience` record. Read-only.
- The project's GitHub repo (read via GitHub MCP to enrich the blurb and confirm the link target).

**Outputs (each drafted first, published only on confirm)**
- LinkedIn experience **or** project entry.
- Updated GitHub profile `README.md`.
- An X post.
- A **PR** against the portfolio repo (project entry linking to the GitHub repo).
- A **Wire** event to **Steward** moving the **Brand** counters (`projects published`++, plus posts-shipped / experience as applicable).

---

## Dependencies

Per SPEC §4 (data flow):

- **Reads The Codex** — all copy is grounded in the owner's stored facts and voice (§11). Envoy is one of the three Codex readers (with **Quill** and **Archivist**).
- **Feeds Steward** — Envoy contributes the **projects/experience counts** (and brand posts) to the Vault, and **only** via Steward over the **Wire**. Envoy fetches nothing from and writes nothing directly to the Vault (§4: "Steward is fed by everyone and fetches nothing").
- **Needs a GitHub repo** for the project — it is the link target on the portfolio PR, the X post, and the README.
- **Flagger** — receives any Envoy error/incident (§8).

Related agents: [Steward](steward.md) (counter writer), [Quill](quill.md) and [Archivist](archivist.md) (co-readers of the Codex), [Flagger](flagger.md) (incident routing), and [Usher](usher.md) (the other Tier-4 gated outward agent).

See also: [agent roster](../01-agent-roster.md), [architecture](../02-architecture.md), [scheduling](../03-scheduling.md), [the Codex](../07-source-of-truth-codex.md), [security & privacy](../11-security-privacy.md).

---

## Schedule / Triggers

- **on-demand** only — user-initiated (§10: *"on-demand · Usher, Quill, Envoy, Librarian, Switchboard"*). Envoy is **not** cron-scheduled and is **not** in any sequential pipeline.
- It does **not** self-schedule. The owner kicks it off when a new project/experience actually exists.
- Its single write into shared state (Steward) is **event-driven**, serialized like every other Steward write (§6.4, §10).

---

## Failure modes & Flagger hooks

Public posts are irreversible, so most safeguards live **before** the gate; failures after the gate are reported precisely so the fan-out can be reconciled.

| Failure | Handling | Flagger |
|---------|----------|---------|
| Codex field missing (e.g. no blurb/voice) | Pause and ask the owner rather than inventing copy | `P3 Medium`, moderate trust |
| GitHub repo not found / private / wrong URL | Halt the README + portfolio targets; ask for the correct repo | `P3 Medium`, high trust (deterministic) |
| **Partial fan-out** — some targets published, others failed (e.g. X posted, portfolio PR failed) | Report exactly which targets succeeded; do **not** silently retry an outward post; offer to re-run only the failed targets | `P2 High`, high trust |
| Browser flow blocked (LinkedIn/X login wall, captcha, layout change) | Abort that target; keep the draft so the owner can finish manually | `P2 High`, moderate trust |
| Portfolio PR conflicts / CI fails | Leave the PR open for the owner to resolve (it is a draft-by-nature) | `P3 Medium`, high trust |
| Steward/Wire event drop after publishing | Re-emit with the same `idempotencyKey` (idempotent — no double count) | `P4 Low / Info` if recovered, else `P3` |
| Owner cancels at the gate | No-op everywhere; nothing published; not an incident | — |

Routing follows §8: `P1`/`P2` → immediate push notification; `P3`/`P4` → batched into the dashboard Flagger feed.

---

## Config

- **Targets toggle** — enable/disable any of the four targets per run (e.g. README-only) or set defaults.
- **Portfolio repo** — owner/name + the file/path convention for the project entry (so the PR edits the right place).
- **GitHub profile repo** — the `<owner>/<owner>` README repo.
- **PR mode** — always open a **PR** (never push to the portfolio default branch); branch name template.
- **Voice/tone** — pulled from the Codex `voice` notes; optional per-platform overrides.
- **Auth/scopes (least privilege, §7/§12):** GitHub via the **GitHub App** (repo contents + pull-requests on the profile/portfolio repos only); LinkedIn/X via the **browser** session. Secrets live in Cloudflare **Secrets Store**, never in the Vault or Codex.
- **Gate policy** — `draft + ask` is the **default and non-overridable** for outward posts (§12); a per-target approve/edit/skip UI at the gate.

---

## Example run — new project → LinkedIn + README + X draft + portfolio PR

**Trigger (on-demand):**
> "I just launched **Atlas** — my personal multi-agent orchestrator. Repo: `github.com/danielchahine/atlas`. Sync it everywhere."

**1. Envoy reads the Codex + repo:**
- Codex `projects` record for *Atlas* (`name`, `repo`, `blurb`, `links`), short bio, socials, and voice notes.
- GitHub MCP reads the *atlas* repo (description, topics, README) to enrich the blurb and confirm the link target `https://github.com/danielchahine/atlas`.

**2. Envoy drafts all four targets (nothing sent yet):**

```
┌─ DRAFT · LinkedIn (project) ──────────────────────────────┐
│ Atlas — Personal Multi-Agent Orchestrator                 │
│ Built Atlas, a fleet of specialized agents that run my    │
│ digital life: email triage, tasks, calendar, meeting      │
│ capture, and cross-platform brand sync. Cloudflare-native.│
│ 🔗 github.com/danielchahine/atlas                          │
└───────────────────────────────────────────────────────────┘

┌─ DRAFT · GitHub profile README (danielchahine/danielchahine) ─┐
│ + **Atlas** — personal multi-agent orchestrator             │
│   (email, tasks, calendar, brand). → /danielchahine/atlas   │
└─────────────────────────────────────────────────────────────┘

┌─ DRAFT · X post ──────────────────────────────────────────┐
│ Shipped Atlas: a personal multi-agent system that runs my │
│ inbox, tasks, calendar, and brand on autopilot.           │
│ Cloud-native, gated on anything irreversible.             │
│ github.com/danielchahine/atlas                            │
└───────────────────────────────────────────────────────────┘

┌─ DRAFT · Portfolio PR (danielchahine/portfolio) ──────────┐
│ branch: add-project/atlas                                 │
│ + projects/atlas.mdx  (card: title, blurb, repo link)     │
│ PR: "Add Atlas to projects — links to github.com/.../atlas"│
└───────────────────────────────────────────────────────────┘
```

**3. Confirmation gate** — Envoy presents all four. Owner replies: *"approve LinkedIn, README, and the portfolio PR; tighten the X post and re-show."* Envoy edits the X draft, re-shows it, owner approves.

**4. Publish approved targets:**
- LinkedIn project entry filled via browser. ✅
- Profile `README.md` committed via GitHub MCP. ✅
- Portfolio **PR** `add-project/atlas` opened via GitHub MCP, project card links to the repo. ✅
- X post published via browser. ✅

**5. Update Steward** — one Wire event:

```json
{
  "agent": "Envoy",
  "type": "brand.project_published",
  "entity": "Atlas",
  "op": "increment",
  "payload": { "projects_published": 1, "posts_shipped": 1, "targets": ["linkedin", "github_readme", "x", "portfolio_pr"] },
  "idempotencyKey": "envoy:atlas:2026-05-29"
}
```

Steward applies it to the **Brand** counters in the Vault (§6.1: *posts shipped (X/LinkedIn), projects published, GitHub streak*). A replay with the same `idempotencyKey` does not double-count.

**6. Report:** "Atlas synced to 4/4 targets. Portfolio PR `#42` is open for merge." Had the portfolio PR failed, Envoy would report *3/4 succeeded* and raise a `P2 High` flag to **Flagger** with an offer to re-run only the portfolio target.

---

## Open questions

- **LinkedIn automation surface.** LinkedIn has no friendly write API for adding experience/project entries; the browser flow is brittle and against some ToS interpretations. Should the LinkedIn target degrade to "open the form pre-filled, owner clicks save" rather than full auto-fill?
- **X API vs browser.** Post via the X API (paid tier, cleaner) or stay on the browser path (no cost, more fragile)?
- **Experience vs project on LinkedIn.** Confirm the exact field mapping for an **experience** entry (title/company/dates/bullets) vs a **project** entry, and whether a job should also create an X/portfolio item or LinkedIn-only.
- **Portfolio repo conventions.** Lock the file format/location for a new project entry (MDX? a JSON list? a component?) so the PR always edits the right place.
- **Idempotency window.** Is `envoy:<project>:<date>` the right `idempotencyKey` granularity, or should it key on the project slug alone to prevent a same-project re-announcement?
- **Cross-posting cadence.** Should re-running Envoy for a *milestone* on an existing project (vs first launch) be a different mode to avoid duplicate "launch" posts?
