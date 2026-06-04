# 11 — Security & Privacy Model

**Purpose:** Define how Atlas keeps the owner safe: confirmation gates on irreversible/outward actions, least-privilege OAuth scopes per agent, local-only sensitive capture (Echo audio, Quill screen), secrets handling, the D1 audit log surfaced via [Flagger](08-flagger.md), and phishing/2FA rules. (Canonical source: SPEC-CANON §12, with §5.8, §7, §8.)

## At a glance

| | |
|---|---|
| **Applies to** | All 17 agents (Atlas + 16 sub-agents) |
| **Core principle** | Pillar 2 — *Suggest, don't destroy.* Default = draft + ask. |
| **Gated actions** | Envoy posting, Usher registering/paying, **any** delete |
| **Scopes** | Per-agent least privilege; Filer = `gmail.modify`, **never** delete |
| **Local-only capture** | Echo (audio), Quill (screen) — derived artifacts only leave the device on owner approval |
| **Secrets** | Cloudflare Secrets Store / Wrangler secrets — **never** in the Vault or the Codex |
| **Audit log** | Every agent action → D1 `audit_log`; surfaced via [Flagger](08-flagger.md) |
| **Phishing / 2FA** | `⚠ Phishing-Suspect`, `Type/Security` — never click, never reproduce codes (per [§5.8](04-email-taxonomy.md)) |
| **Highest risk surface** | Echo consent/two-party law · Quill screen access · Envoy irreversible posts · Usher captcha/payment/ToS |

---

## 1. Threat model — what we are actually defending against

This is a personal system with broad reach into the owner's accounts. The realistic failure modes, in rough order of blast radius:

| Risk | Where it lives | Worst case | Mitigation |
|---|---|---|---|
| **Irreversible outward action** | Envoy (public post), Usher (registration/payment) | A bad LLM judgment posts to LinkedIn or pays for an event | Confirmation gate (§2); draft-first default |
| **Destructive mutation** | any agent with write scope | A thread/file/calendar event deleted by mistake | No agent holds delete scope by default (§3); deletes are gated and owner-only |
| **Sensitive capture leak** | Echo (audio), Quill (screen) | Meeting audio or on-screen secrets exfiltrated to cloud | Local-only processing; derived-artifact-only egress (§4) |
| **Secret exfiltration** | tokens, OAuth refresh tokens | A leaked Vault/Codex export hands an attacker your Gmail | Secrets Store only; never in Vault/Codex (§5) |
| **Phishing / credential theft** | inbound email | Filer or owner follows a malicious link | `⚠ Phishing-Suspect`; never auto-act, never click (§6) |
| **2FA / reset code exposure** | `Type/Security` mail → Herald digest | A code or reset link reproduced in a digest is intercepted | Never reproduce codes/links in any digest (§6) |
| **Two-party consent violation** | Echo recording calls | Recording another party without consent is illegal in some jurisdictions | Consent gate + jurisdiction note (§4.2) |
| **ToS / captcha abuse** | Usher auto-registration | Account flagged/banned for automated signup | Human-in-the-loop on captcha; ToS note (§7) |
| **Silent compromise** | any agent | An agent misbehaves and nobody notices | D1 audit log + Flagger self-monitoring (§8) |

The cheap, low-risk core (read / summarize / label / plan — Filer, Herald, Compass, Scout) is safe to run autonomously. Everything that **writes outward or captures the physical machine** is gated. That gating is the whole point of this document.

---

## 2. Confirmation gates (irreversible / outward actions)

> **Rule (SPEC §12):** *Default = draft + ask.* Nothing irreversible or outward-facing happens without an explicit human confirmation.

### 2.1 What requires a gate

| Action | Agent | Gate type | Reversible? |
|---|---|---|---|
| Public post (LinkedIn, X, GitHub, portfolio) | **Envoy** | Confirm before publish; show the exact rendered post | **No** — assume permanent |
| Event registration | **Usher** | Confirm before submit; surface captcha to owner | Sometimes (cancellation) |
| Payment | **Usher** | Confirm with amount + payee; never auto-pay | **No** |
| Delete (email thread, calendar event, file, note) | **any** | Confirm + name the target | **No** (Filer cannot delete at all — §3) |
| Profile update to the Codex | owner-initiated only | Explicit "update my profile" flow (SPEC §11) | Yes (versioned) |
| Outbound email send | **Herald** and any drafter | **Draft only** — Herald writes a draft to the owner, never sends | n/a — owner sends |

Everything else (labeling, task creation, calendar *adds* from owned deadlines, dashboard writes) is **suggest-class** and runs without a gate, because it is additive and easily undone.

### 2.2 Gate mechanics

```
agent decides action ──▶ classify: suggest-class or gated-class?
                              │                     │
                       suggest-class           gated-class
                              │                     │
                          execute            write a "pending" record (D1)
                              │                     │
                              │            PushNotification to owner
                              │                     │
                              │         owner: approve │ reject │ edit
                              │                     │
                              ▼                     ▼
                       audit_log (done)      approve → execute → audit_log
                                              reject  → discard → audit_log
```

- A gated action is **never** executed inline. The agent writes a `pending` row to D1 and emits a `P2 High` (or higher) flag / push via [Flagger](08-flagger.md) routing.
- Approval is a separate, explicit owner step. **Timeout = no action** (fail-safe, never fail-open): a pending action that is not approved expires and is logged as `expired`, not executed.
- The confirmation surface shows the **literal artifact** — the exact post text for Envoy, the exact form values + amount for Usher — not a paraphrase. The owner approves what they can see.
- Edits during approval are allowed (e.g., tweak the post) and re-logged; approval applies to the edited version.

### 2.3 Per-agent gate summary

- **Envoy** — every publish is gated. The brand-sync pipeline is read/draft up to the publish boundary. Treat all posts as irreversible even where a platform allows deletion (caches, scrapers, screenshots).
- **Usher** — registration and payment are gated. Captcha is **handed to the owner**, never solved or bypassed by the agent (see §7). Calendar *add* after a confirmed registration is suggest-class.
- **Any delete** — there is no autonomous delete anywhere in Atlas. This is a hard invariant.

---

## 3. Least-privilege OAuth scopes (the scopes table)

> **Rule (SPEC §12):** Per-agent least privilege. Each agent gets the **minimum** scope set for its job and nothing more. Filer needs `gmail.modify` (to add labels) but **not** delete.

Atlas does **not** mint one fat token for everything. Each agent (or its MCP server) authorizes against its own least-privilege scope set. Tokens live in Secrets Store (§5), scoped per agent.

| Agent | Provider | OAuth scope(s) | Why this and not more |
|---|---|---|---|
| **Filer** | Google (Gmail) | `gmail.modify` | Add/remove labels only. **No `gmail.delete`, no full `mail.google.com`.** Filer never archives/deletes (SPEC §5). |
| **Herald** | Google (Gmail) | `gmail.readonly` + `gmail.compose` | Read threads/labels to build the digest; write a **draft** to the owner. No send scope — owner sends. |
| **Forge** | Google (Gmail) | `gmail.readonly` | Read flagged threads to extract tasks. No write to Gmail. |
| **Sundial** | Google (Calendar) | `calendar.events` | Create/update deadline events. No `calendar` full-admin, no calendar delete/sharing. |
| **Compass** | Google (Calendar) | `calendar.readonly` | Reads settled calendar to build the day plan. Read-only. |
| **Scout** | none (web) / Google | `calendar.readonly` (optional) | Discovers events from the web; reads calendar only to dedupe. |
| **Usher** | Google (Calendar) + browser | `calendar.events` | Adds confirmed events. Registration/payment are **browser-driven and gated**, not an OAuth scope. |
| **Headhunter** | none (web/job boards) | — | Reads public boards; writes only via Forge (tasks) and Steward. |
| **Echo** | **local only** | — | No cloud OAuth. Captures audio on-device (§4). |
| **Archivist** | Google (Drive/Docs, read) | `drive.readonly` (Codex) | Reads the Codex for context; writes notes via Steward. |
| **Steward** | Obsidian (local MCP bridge) | local file scope to the Vault | Sole Vault writer. No cloud write scope. |
| **Quill** | **local only** | — | No cloud OAuth. Reads the screen + the Codex locally (§4). |
| **Envoy** | LinkedIn / X / GitHub App + browser | minimal publish scopes per platform; GitHub App with scoped repos | Publish is **gated** (§2). Request the narrowest content-write scope each platform offers. |
| **Switchboard** | none | — | Design-time recommender; no runtime credentials. |
| **Flagger** | none | — | Consumes events; writes to Vault via Steward. No external scope. |
| **Librarian** | none | — | Stores prompts; writes to Vault via Steward. |
| **Atlas** | none (orchestration) | — | Routes/schedules. Holds no domain scopes itself; delegates to agents. |

**Google OAuth granularity notes:**

- `gmail.modify` grants label + read but **not** permanent delete (`gmail.modify` cannot empty Trash). This is exactly the Filer ceiling. Permanent delete would require `https://mail.google.com/` — which **no agent is granted**.
- `calendar.events` is per-event create/update; it is narrower than the full `calendar` scope (which includes calendar list/ACL management). Sundial/Usher use `calendar.events`; Compass/Scout use `calendar.readonly`.
- `drive.readonly` (or, better, `drive.file` scoped to the Codex doc) limits Archivist to the source-of-truth doc rather than the whole Drive.
- Where a platform supports **incremental authorization**, request scopes lazily — don't ask for write scopes until the first gated write is actually attempted.

**Auth plumbing (per SPEC §7):** inbound auth via the Workers **OAuth Provider**; Google/GitHub tokens stored in **Secrets Store / Wrangler secrets**, scoped per agent. GitHub access is a **GitHub App** with per-repo grants, not a personal access token.

---

## 4. Local-only sensitive capture (Echo + Quill)

> **Rule (SPEC §12):** Echo audio and Quill screen **never leave the device** except as derived artifacts the owner approves. (SPEC §7 establishes the cloud-vs-local split.)

These are the two agents that **cannot** run on Cloudflare — they need the physical machine (microphone, screen buffer). They run in a **local macOS daemon** (menubar app / launchd) that authenticates to the cloud and pushes only **results** up.

```
   LOCAL macOS daemon                         |   CLOUD (Cloudflare)
   ─────────────────                          |   ──────────────────
   Echo  ──▶ raw audio (RAM/disk, local) ──┐  |
            ──▶ on-device transcript ───────┼──┼──▶ transcript text ──▶ Archivist ──▶ Steward ──▶ Vault
   Quill ──▶ screen frame (RAM, local) ─────┘  |
            ──▶ filled field values (local) ───┼──×  (nothing crosses; writes the active document locally)
                                               |
   raw audio / raw screen frames  ──────────×──┼──  NEVER cross this boundary
```

### 4.1 Echo (audio capture)

- **Raw audio stays local.** What crosses the cloud boundary is the **derived transcript text**, not the waveform. Raw audio is processed on-device; if persisted to R2 at all (SPEC §7 lists "audio blobs" in R2), that is an **owner-approved** opt-in, encrypted, with retention limits — not the default.
- Echo runs over a **Durable Object + WebSocket** for the live stream (SPEC §7), but the stream content is the transcript, not raw PCM, unless the owner explicitly enables raw upload.
- **Default retention:** transcripts are kept; raw audio is discarded after transcription. Owner-configurable.

### 4.2 Echo consent & two-party-consent law (be candid)

This is the single most legally sensitive capability in Atlas.

- Many jurisdictions are **all-party (two-party) consent** for recording conversations (e.g., several US states, and recording others without consent can be unlawful elsewhere). Recording a meeting where another party has not consented can be a crime, not just a faux pas.
- **Echo must gate on consent**, not just on "audio is active." A meeting-start trigger is not consent. Recommended posture:
  - Default to **owner's own audio / explicitly owner-controlled meetings**.
  - Require an explicit per-context **consent acknowledgement** before capturing multi-party audio, and consider an audible/visible "this is being transcribed" notice where the platform/meeting allows.
  - Store a **consent flag** alongside each transcript in the audit log.
- This is an owner-responsibility area: Atlas enforces the gate, but the owner is accountable for lawful use. Flag jurisdiction explicitly in any deployment notes. **Open question:** automatic jurisdiction detection vs. manual per-meeting acknowledgement.

### 4.3 Quill (screen-aware autofill)

- Quill reads the **active document / screen** to map form-field labels → Codex fields, and writes back into the **active document locally** (SPEC §11). Nothing about the screen contents crosses to the cloud.
- **macOS Screen Recording permission** is required and is itself a sensitive grant — the daemon can see whatever is on screen. Scope its activation to **hotkey / on-demand** (SPEC §2 trigger), not always-on, so it only reads the screen when the owner asks.
- Quill pulls values **from the Codex**, which may contain demographics/EEO answers and personal identifiers (SPEC §11). Those values are entered into third-party forms only when the owner triggers autofill — never speculatively.
- **The Codex is read-only to agents** except via the explicit "update my profile" flow (SPEC §11). Quill reads it; it does not write it.

---

## 5. Secrets handling

> **Rule (SPEC §12):** Secrets live in **Cloudflare Secrets Store** (and/or Wrangler secrets). **Never** in the Vault or the Codex.

| Secret class | Stored in | Never stored in |
|---|---|---|
| Google OAuth tokens (per agent) | Secrets Store / Wrangler secrets | Vault, Codex, D1, KV, logs |
| GitHub App credentials | Secrets Store | Vault, Codex |
| Platform publish tokens (LinkedIn/X) | Secrets Store | Vault, Codex |
| Anthropic / Workers AI keys | Secrets Store, behind AI Gateway | Vault, Codex |
| Inbound OAuth provider keys | Workers OAuth Provider config | Vault, Codex |

- **The Vault is a dashboard, not a vault for credentials** — despite the name. It is an Obsidian directory that can be synced, exported, and shared. Treat anything in it as potentially leaving the machine, so **no secrets, ever**.
- **The Codex holds personal facts** (name, addresses, education, EEO answers) — sensitive, but **not credentials**. Keep tokens out of it too.
- **Never log secrets.** The D1 audit log (§8) records *that* an authenticated action occurred and against which scope — not the token.
- **Scope tokens per agent** so a single leaked token is blast-radius-limited to one agent's capability (e.g., a leaked Filer token can label mail but cannot send, delete, or touch Calendar).
- **Rotation:** store refresh tokens in Secrets Store; rotate on suspicion. A Flagger `P1`/`P2` on an auth anomaly should prompt rotation.

---

## 6. Phishing & 2FA handling

Per [§5.8 of the email taxonomy](04-email-taxonomy.md) — this is security-critical and restated here:

- **`⚠ Phishing-Suspect`** — possible phishing. **Never follow links, never auto-act.** Filer labels it and stops. No task extraction, no autofill, no registration. The owner reviews.
- **`Type/Security`** (2FA, login alerts, password resets, account security):
  - **Never reproduce 2FA codes or reset links in any digest** (Herald daily/weekly) or any exported/shared Vault view. A code echoed into a digest is a code that can be intercepted.
  - **Never click links** in `Type/Security` or `⚠ Phishing-Suspect`.
- **Finance / medical privacy** — flag but do not expose details in shared/exported views (SPEC §5.8). `Finance/*` and any medical content stay summarized, not reproduced.
- **`From/Automated`** (no-reply / system senders) — Filer does not attempt replies; combined with phishing heuristics, a "security alert" from an automated-but-unverifiable sender should bias toward `⚠ Phishing-Suspect` and `AI/Uncertain` rather than auto-action.
- **`AI/Uncertain`** — low-confidence classifications get a human glance rather than autonomous action. This is the trust-score floor for the email surface.

Filer's confidence here feeds the Flagger **trust score** (SPEC §8): an LLM "this looks suspicious" is *low-trust* and routes to a human glance, whereas a caught exception is *high-trust*.

---

## 7. Outward-action irreversibility & auto-registration (be candid)

The outward-facing agents (SPEC §3 Tier 4) carry real, non-technical risk. Stated plainly:

- **Envoy posts are irreversible.** Even where a platform offers "delete," the content may be cached, scraped, screenshotted, or already in someone's feed. Treat **every** publish as permanent. Hence: draft → owner reviews exact rendered text → explicit confirm (§2). No scheduled-post autonomy without the same gate.
- **Usher auto-registration touches ToS, captcha, and payment:**
  - **Captcha** exists specifically to block automation. Atlas does **not** solve, farm out, or bypass captcha — it **surfaces the captcha to the owner** to complete. Auto-solving captcha risks account bans and may violate the site's ToS.
  - **ToS:** automated registration can violate a site's terms. Usher should respect robots/ToS signals and fail toward "ask the owner" rather than forcing a signup.
  - **Payment is never automatic.** Any cost is confirmed with amount + payee before submission (§2.1). No stored card is charged without an explicit per-transaction approval.
- **Browser-driven agents (Usher, Envoy)** run with the narrowest practical session and are still bound by the same confirmation gates — being in a browser does not exempt an action from the gate.

Build posture (SPEC §13): **start read-only, add write actions behind gates.** The outward agents are the *last* to gain write capability, and they never lose the gate.

---

## 8. Audit log (D1) + Flagger

> **Rule (SPEC §12):** Audit log of **every agent action** (D1) + surfaced via [Flagger](08-flagger.md).

Every agent action — suggest-class or gated-class, success or failure — writes an immutable row to a D1 `audit_log` table. This is the forensic record and the input to Flagger's reliability view.

**Suggested `audit_log` shape (D1):**

```
{
  id,                 // ulid
  ts,                 // ISO timestamp
  agent,              // codename: Filer, Envoy, Usher, ...
  action,             // "label.add", "post.publish", "event.register", "delete", "draft.create"
  target,             // resource touched (thread id, event id, profile, note path)
  scope_used,         // e.g. "gmail.modify" — proves least-privilege at runtime
  gated,              // bool — was this a gated action?
  decision,           // "auto" | "approved" | "rejected" | "expired"
  outcome,            // "ok" | "error"
  trust,              // 0–100 (for classifications; mirrors Flagger trust score)
  consent_flag,       // for Echo: was multi-party consent acknowledged?
  flag_id             // FK to a Flagger flag, if one was raised
}
```

- **Secrets never appear in `audit_log`.** It records `scope_used`, not the token.
- **Gated actions** always produce two rows: the `pending` decision and the terminal `approved`/`rejected`/`expired` outcome — so the full approval trail is reconstructable.

### 8.1 Surfacing via Flagger

[Flagger](08-flagger.md) is how the audit log becomes visible. When something notable happens (an agent error, a low-confidence action, a phishing suspect, a missed deadline, an expired gate), Flagger raises a flag with **severity** + **trust score** (SPEC §8):

- **Severity:** `P1 Critical` · `P2 High` · `P3 Medium` · `P4 Low / Info`.
- **Trust score (0–100):** how confident Atlas is the flag is real (caught exception = high; LLM "looks suspicious" = low).
- **Routing:** `P1`/`P2` → **push notification immediately**; `P3`/`P4` → batched into the dashboard **Flagger feed**.
- **Flag shape:** `{ id, ts, source_agent, severity, trust, title, detail, suggested_action, status }`, status `open → ack → resolved → muted`.

Security-relevant flags and their typical severity:

| Event | Source | Severity | Notes |
|---|---|---|---|
| Gated action expired without approval | gate (§2) | `P3` | Logged, not executed (fail-safe) |
| Auth anomaly / token rejected | any | `P2` | Consider rotation (§5) |
| `⚠ Phishing-Suspect` detected | Filer | `P2`/`P3` | Trust depends on confidence |
| 2FA code about to be exposed (caught) | Herald guardrail | `P1` | Block + flag |
| Echo capturing without consent flag | Echo | `P1` | Block capture |
| Repeated rejected gated actions | gate | `P2` | Possible misbehaving agent |
| Heartbeat stale / agent silent | Flagger self-monitor | `P2` | Flagger flags *itself* and the heartbeat (SPEC §8) |

**Self-monitoring:** Flagger also flags itself and a stale heartbeat — so a compromised or hung agent doesn't go unnoticed (SPEC §8).

---

## 9. Config

| Knob | Default | Notes |
|---|---|---|
| `gates.default` | `draft+ask` | Never auto-execute gated-class actions |
| `gates.timeout` | expire → `expired` (no action) | Fail-safe, never fail-open |
| `echo.raw_audio_upload` | `false` | Raw audio stays local; transcript only |
| `echo.retention.raw` | discard after transcription | Owner-configurable |
| `echo.consent_required` | `true` for multi-party | Stores `consent_flag` per transcript |
| `quill.trigger` | hotkey / on-demand | Never always-on screen read |
| `usher.captcha` | hand to owner | Never auto-solve / bypass |
| `usher.payment` | per-transaction approval | Never auto-pay |
| `envoy.publish` | gated, show literal text | Treat as irreversible |
| `secrets.store` | Cloudflare Secrets Store | Never Vault/Codex/logs |
| `scopes.*` | per §3 table | Per-agent least privilege |

---

## 10. Open questions

- **Echo jurisdiction:** automatic location/jurisdiction detection for two-party-consent law vs. a manual per-meeting consent acknowledgement? (§4.2)
- **Raw-audio retention:** is owner-approved encrypted R2 storage of raw audio ever worth the privacy cost, or is transcript-only the permanent default? (§4.1)
- **Drive scope for Archivist:** `drive.readonly` (whole Drive) vs. `drive.file` scoped to just the Codex doc — the latter is tighter but needs the doc to be created/opened by the app. (§3)
- **Gate approval channel:** push notification with inline approve/reject, vs. a dashboard approval queue, vs. both? What is the authenticated approval surface? (§2.2)
- **Vault export safety:** automated redaction pass on any exported/shared Vault view to enforce "no finance/medical/2FA details" (§6) — built-in or manual?
- **Token rotation cadence:** scheduled rotation vs. rotate-on-suspicion only. (§5)

---

### Related docs

- [04 — Email taxonomy](04-email-taxonomy.md) — §5.8 phishing/2FA/finance-privacy rules
- [06 — Hosting: Cloudflare + MCP](06-hosting-cloudflare-mcp.md) — Secrets Store, OAuth Provider, local daemon split
- [07 — The Codex (source of truth)](07-source-of-truth-codex.md) — personal facts; read-only-to-agents flow
- [08 — Flagger](08-flagger.md) — severity, trust score, routing, self-monitoring
- [12 — Roadmap](12-roadmap.md) — start read-only, add gated writes last
