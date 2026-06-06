# Phase 4: Outward (Gated) - Context

**Gathered:** 2026-06-06
**Status:** Ready for planning

<domain>
## Phase Boundary

The two **outward, irreversible** agents — the last and most-gated capabilities in Atlas. Scope is
fixed by ROADMAP.md → Phase 4 (build-plan §4 "Outward/gated", milestone M6):

```
Usher (#7)  — on-demand: owner names ONE event → resolve (browser) → CONFIRM GATE (price disclosed)
              → fill from Codex → auto-submit if path clear → scrape confirmation #
              → Google Calendar add (Calendar MCP) → Steward events-registered++
              hard stops: captcha · payment · sold-out · login-wall · ToS-block → hand back to owner

Envoy (#13) — on-demand: owner intent ("I started a <project|experience>") → read Codex + GitHub repo
              → draft 4 targets (LinkedIn · GitHub profile README · X · portfolio PR)
              → CONFIRM GATE (per-target approve/edit/skip, literal artifacts)
              → publish approved targets → Steward brand counters++
```

**The confirmation-gate UX is the real work** (roadmap: "build last, gate hardest"). The agents are
read/draft up to the gate; the gate is the single, hard, literal-artifact consent point. Everything
outward is fail-safe: **decline → no action; timeout → expired with NO action; error → deny** (never
fail-open). There is no autonomous outward action anywhere.

**Locked requirements:** OUTWARD-01 (Usher), OUTWARD-02 (Envoy) — see `.planning/REQUIREMENTS.md`.
The decisions below settle **how** to build, not **what** — scope is fixed by ROADMAP.md.

**Success criteria carried from ROADMAP.md (what must be TRUE):**
1. No outward action ever fires without an explicit owner confirm (gate adherence = 100%; gate
   fail-safe = deny on error); a public post / payment is never silent.
2. Usher does on-demand search + gated registration + Calendar add and bumps `events-registered`;
   captcha + payment are hard stops handed back to the human.
3. Envoy fans one intent into per-channel drafts (LinkedIn / README / X / portfolio) from the Codex,
   and ships a channel only on confirmation — a post can't be un-posted, so nothing posts silently.

**Dependency satisfied:** "a mature confirmation-gate UX proven on lower-stakes actions" — this phase
*builds* that maturity as a shared primitive (D4-04) and retrofits the existing Sundial duplicate-removal
proposal onto it.

</domain>

<decisions>
## Implementation Decisions

> Numbered `D4-NN` (Phase 4), continuing the project decision log (Phase 0 `D-NN`, Phase 1 `D1-NN`,
> Phase 2 `D2-NN`, Phase 3 `D3-NN`). Status: decided, not locked.

### Cross-cutting architecture (the most important takeaway for research/planning)
- **D4-00 (derived): Usher/Envoy are "cloud-brain + local-hands," NOT pure-cloud-browser.** The spec's
  literal "Cloud + browser (Worker driving headless Playwright)" is **refined** by D4-05: the cloud side
  resolves, drafts, runs the gate, writes Calendar/GitHub via MCP, and bumps Steward counters; the
  **browser action itself runs in the Phase-3 local macOS daemon, inside the owner's already-logged-in
  session.** This is forced by §12 (no credential storage / no session scraping) — a cloud headless
  browser cannot hold the owner's LinkedIn/X/event-site login without becoming a credential store. The
  gate stays in the cloud (D4-02); on approval the cloud enqueues a **browser-action work item** that the
  daemon picks up on its next outbound poll, executes locally, and acks the outcome (confirmation # /
  success/fail) back. This reuses the exact Phase-0/3 outbound-only poll/drain/ack pattern — no inbound
  port, no new credential surface, no Workers Paid.

### 1. The confirmation gate (the phase's real work)
- **D4-01: Approval surface = push + token-gated confirm link.** Reuse Phase-2's ntfy push (already has
  HTTP action buttons → constant-time token-gated `/ack`): the push carries **Approve / Reject** buttons
  for quick cases, plus a **"Review & edit" link** that opens a constant-time-token-gated confirm page
  rendering the **literal artifact** (exact post text / exact form values + price) with an **edit box**.
  Supports both one-tap approve and rich review/edit (needed for Envoy's multi-line posts). *Rejected:*
  Vault dashboard approval queue (the outbound-only bridge can't carry an approval signal back without a
  new inbound path); push-inline-only (too weak to review/edit a public post).
- **D4-02: The gate waits as a D1 `pending` row + re-invoke on approval.** Durable for **any** duration;
  a cron sweep expires stale gates (fail-safe → `expired`, no action, P3); on approval the agent is
  re-invoked and re-establishes browser/calendar context to act. **No live browser session is held across
  the human pause.** *Rejected:* Workflow `step.waitForEvent` (a >3-day wait exceeds Free's 3-day Workflow
  state retention, and holding a browser across the pause is fraught); a DO holding the live browser (a
  headless browser can't be held open for a long human pause).
- **D4-03: Per-action gate timeout.** Each agent sets its own expiry: **Usher short (~24h** — events sell
  out), **Envoy longer (~7d** — a launch post isn't time-critical). Matches the real urgency of each
  outward action. (Exact values are tunable config; the *pattern* is per-action, not one global value.)
- **D4-04: ONE shared `packages/gate` primitive.** It owns the pending-row schema, the push + token-gated
  confirm route, the expiry sweep, and the **dual `audit_log` rows** (the `pending` decision + the
  terminal `approved`/`rejected`/`expired` outcome — §8). Usher, Envoy, the **existing Sundial
  duplicate-removal proposal**, and any future delete all call it — one place to enforce + audit Pillar 2.
  This is the roadmap's "gate-UX maturity." *Rejected:* per-agent inline gate logic (duplicates the
  fail-safe/audit/expiry surface across two outward agents + Sundial — more places to fail open).

### 2. Browser-automation runtime
- **D4-05: Browser runs in the local daemon, against the owner's already-logged-in sessions.** Extend the
  Phase-3 macOS daemon to drive a local browser already authenticated to the owner's LinkedIn / X /
  Meetup / Eventbrite accounts. **Never stores or scrapes credentials** (honors §12), avoids datacenter
  bot-detection, and needs no Workers Paid. See D4-00 for the cloud-brain/local-hands split. *Rejected:*
  Cloudflare Browser Rendering (can't hold the owner's login without storing credentials; datacenter
  browsers get bot-blocked on LinkedIn/X; likely needs Paid); no-browser-at-all (too little automation —
  Usher registration + LinkedIn/X are core scope).
- **D4-06: Phase 4 stays on the Workers Free plan.** The gate uses a D1 pending row (not a >3-day Workflow
  wait, D4-02) and the browser is local/MCP (D4-05), so Phase 4 has **no hard Workers-Paid dependency**.
  Consistent with the project's Free-first posture (Phase-0 D-01).
- **D4-07: Clean MCP-vs-browser split.** Usher's Calendar add → **Google Calendar MCP** (`calendar.events`,
  already built); Envoy's profile README + portfolio PR → **mcp-github** (`contents:write` already exists;
  GitHub App, scoped repos). Browser is reserved **strictly** for the login-required, ToS-gray targets
  (LinkedIn, X, event-site registration). Maximizes the clean, reliable, authorized paths.

### 3. Automation depth past the gate (principle: **depth scales with reversibility**)
- **D4-08: Envoy LinkedIn + X — owner clicks the final Post.** After the owner confirms the literal draft
  at the gate, Envoy opens the platform composer **pre-filled** in the owner's local browser; the owner
  clicks Post. Maximum safety on irreversible public posts **and** sidesteps ToS-automation concerns (a
  human posts, not a bot). Mirrors Quill's locked "never auto-submits."
- **D4-09: Usher registration — auto-submits free/captcha-free path after confirm.** The gate already
  confirmed event + price + account; Usher submits in the owner's local browser and scrapes the
  confirmation #. Delivers the "without touching a form" value. **Hard stops always override** (even with
  a yes): captcha (screenshot + hand back, P3), payment (D4-11), sold-out/waitlist (P3), login-wall (P3),
  ToS/anti-bot signal (P2). A submit with no confirmation #/email = **not registered** (no Calendar add,
  no counter; P2). A submit attempted without confirmation = P1 self-flag (gate bug).
- **D4-10: Envoy GitHub targets — agent completes after confirm.** Once approved, Envoy commits the
  profile README + opens the portfolio **PR** via mcp-github (GitHub App). A PR is a draft-by-nature (not
  merged) and a README commit is git-reversible — both safe to complete; no browser, no ToS issue.
- **D4-11: Payment is always a manual hard stop — no auto-pay, no override knob.** Usher never enters card
  details; paid events stop with the price + checkout link handed to the owner (P2 flag). Matches §12
  ("payment is never automatic") and the project's standing "no money movement" exclusion. (Closes the
  Usher spec open question "pay up to $N override?" → **no**.)

### 4. Envoy v1 target scope
- **D4-12: All four Envoy targets ship in v1** — LinkedIn + X (local browser, owner clicks) and GitHub
  profile README + portfolio PR (mcp-github, agent completes). Per-target approve/edit/skip at the gate
  means the owner can still run any subset on a given invocation.
- **D4-13: LinkedIn = auto-fill the experience/project fields from the Codex, owner clicks Save.**
  Best-effort automation on a brittle, API-less, ToS-gray, churny form, with the owner pulling the final
  trigger (consistent with D4-08). On a DOM/layout block, abort that target + keep the draft (P2).
- **D4-14: Portfolio repo + project-entry convention is configured at go-live, not in code.** The repo
  owner/name + file path/format (MDX / JSON list / component) live in a **config knob the owner seeds at
  go-live** (mirrors the Phase-1/2/3 owner go-live gates); planning builds Envoy to read it. Keeps the
  owner's repo specifics out of code and out of CONTEXT.md.
- **D4-15: Envoy idempotency keyed on project slug** (`envoy:<project-slug>`); a re-run for the same
  project is a **no-op** (no duplicate "launch" posts / counter double-count). A later milestone-update
  mode is a separate, **deferred** capability (not v1).

### Claude's Discretion
Left to research/planning, constrained by the canonical refs + `CLAUDE.md` pins:
- **`packages/gate` internals** — exact D1 `pending` table schema (fields: id, agent, action, target,
  literal-artifact payload, edited-artifact, status, decision, expires_at, idempotency_key, flag_id…),
  the confirm-page rendering + the edit round-trip, the expiry-sweep cron cadence/owner-Worker, and how
  the dual `audit_log` rows (§8 shape) are written. Reuse Flagger's `/ack` auth pattern (constant-time
  token, fail-closed) and the existing `flag()`/Flagger routing for the P-levels in D4-09.
- **Daemon ↔ cloud browser-action transport** — the work-item schema the cloud enqueues and the daemon
  drains/acks (reuse the Phase-0/3 `vault_outbox`-style outbound poll/drain/ack pattern; a browser-action
  outbox vs. extending the capture app's existing poll response). The daemon-side browser driver
  (Playwright/WebDriver vs. driving the owner's actual browser vs. a daemon-managed persistent profile).
- **mcp-github create-PR tool** — `contents:write` exists; a branch-create + open-PR tool likely needs
  adding for Envoy's portfolio PR (pull-requests permission on the scoped repos; GitHub App).
- **Usher operational lifecycle** (spec open questions, out of v1 *registration* scope — capture as
  follow-ups, don't build now): who/when flips `events-registered` → *attended*; cancellation/un-register
  as a separate gated flow; waitlist-as-tracked-state. Login persistence is **resolved** by D4-05 (owner's
  local session — no credential storage).
- **Usher idempotency** — `usher:<event-id>:registered` (spec); the event-id resolution + the
  "already-registered" short-circuit before submit.
- **Per-platform selectors / field maps** — LinkedIn/X/event-site label→Codex field mapping (the same
  mapping Quill uses, `packages/codex`); optional KV per-platform selector hints (Usher config).
- **Confirm-page hosting** — which Worker serves the token-gated confirm page + route (per-agent vs. a
  shared gate Worker); the authenticated approval surface (§2.2 / §10 open question) is now answered as
  push + token-gated link (D4-01).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Authoritative design (wins all conflicts)
- `docs/SPEC-CANON.md` — §12 (security/privacy: confirmation gates on every irreversible/outward action,
  default = draft+ask, captcha/payment hard stops, least-privilege scopes), §2 (Pillar 2 suggest-don't-
  destroy; gate fail-safe = deny on error), §4 (data flow: Usher/Envoy → the Wire → Steward → the Vault;
  Usher writes Calendar directly, Envoy reads the Codex), §6.1 (Events counters: registered/attended/
  upcoming; Brand counters: posts shipped / projects published / GitHub streak), §6.4 (the Wire event
  contract), §11 (the Codex sections both agents read), §3 (Tier-4 importance — build last, gate hardest).
  If two docs disagree, this wins.

### How to build Phase 4 (primary build guide)
- `docs/13-build-plan.md §4` — "Outward/gated" sequencing, the gate-UX-maturity dependency edge, the
  new-tech notes (browser automation, gates), model tiers, and the build-posture "start read-only, add
  write actions behind gates."

### Per-agent specs (Phase 4)
- `docs/agents/usher.md` — the FIND→CONFIRM→FILL→SUBMIT→CALENDAR→STEWARD flow, the confirmation-gate rules
  (one fresh confirm, price disclosed at the gate, re-confirm on material change, hard stops override), the
  Wire event (`usher:<event-id>:registered`, `op:increment`, `events-registered`), the full failure-mode
  → Flagger severity table, and the open questions (attended-flip, cancellation, login, waitlists) — several
  now resolved by D4-05/09/11.
- `docs/agents/envoy.md` — the multi-target fan-out, per-platform formatting table (LinkedIn / GitHub
  README / X / portfolio PR), per-target approve/edit/skip gate, the Codex source fields, the Wire event
  (`envoy:<project>:<date>` → reconsidered to slug-only, D4-15; `op:increment`, Brand counters), failure
  modes (partial fan-out → P2; browser block → P2 + keep draft; PR conflict → P3), and the open questions
  (LinkedIn degrade, X API vs browser, portfolio convention, idempotency window, milestone mode) — resolved
  by D4-08/12/13/14/15.

### Security / gates / scopes (the heart of this phase)
- `docs/11-security-privacy.md` — §2 (confirmation gates: what requires a gate, the gate mechanics
  pending-row → push → approve/reject/edit → timeout=expired, per-agent gate summary), §3 (least-privilege
  scopes: Usher `calendar.events` + browser-gated registration; Envoy minimal publish scopes + GitHub App
  scoped repos), §5 (secrets only via bindings — platform/publish tokens in Secrets Store, never Vault/
  Codex), §7 (outward irreversibility, captcha never solved, payment never automatic, ToS posture), §8
  (the `audit_log` shape + dual gated rows + Flagger surfacing), §9 (config knobs: `gates.default`,
  `gates.timeout`, `usher.captcha`, `usher.payment`, `envoy.publish`), §10 (open question "gate approval
  channel" — now answered: push + token-gated confirm link).

### Substrate / cross-cutting
- `docs/06-hosting-cloudflare-mcp.md` §7 — the cloud-vs-local split + the **outbound-only daemon pattern**
  (authenticate outbound, long-poll, drain, ack; no inbound port) that D4-00/D4-05 reuse for browser
  actions; the Connect-a-new-MCP checklist; the Worker+browser note for Usher/Envoy.
- `docs/08-flagger.md` — severity (P1–P4) + trust scoring + routing (P1/P2 → push immediately; P3/P4 →
  batched feed) that the gate (expired/rejected) and Usher/Envoy failure modes emit into; the Flagger feed.
- `docs/07-source-of-truth-codex.md` §11 — the Codex sections Usher (registration facts: identity, email,
  phone, demographics/EEO) and Envoy (identity, bios, socials, projects, work experience, voice notes)
  read; read-only to agents (same field mapping Quill uses).
- `docs/05-dashboard.md` §6.1 — the **Events** counters (registered/attended/upcoming) Usher bumps and the
  **Brand** counters (posts shipped, projects published, GitHub streak) Envoy bumps, via Steward.
- `docs/02-architecture.md` §4 — the fan-in (Usher/Envoy → the Wire → Steward → the Vault); single-writer
  model (Steward sole Vault writer; Usher/Envoy are Wire producers, write Calendar/GitHub directly).
- `docs/03-scheduling.md` §10 — Usher/Envoy are **on-demand** only (never cron-scheduled, not in any
  pipeline); their single shared-state write (Steward) is event-driven + serialized like every other.

### Project state & conventions
- `.planning/REQUIREMENTS.md` — OUTWARD-01, OUTWARD-02 (locked requirements + acceptance). MUST read.
- `.planning/PROJECT.md` — the 5 SPEC-CANON pillars (esp. Pillar 2) + D-01 (Free-plan posture, carried by
  D4-06) + the "Autonomous outward actions" out-of-scope row (carried by D4-08/09/11).
- `.planning/phases/03-capture-local/03-CONTEXT.md` — the macOS daemon D4-00/D4-05 extend: D3-01 (Swift
  menubar app, launchd, outbound poll/drain), D3-02 (per-agent least-privilege OAuth client), the Keychain
  OAuth + outbox pattern, **no inbound port** invariant.
- `.planning/phases/00-spine/00-CONTEXT.md` — the outbound Obsidian bridge + `vault_outbox`/`SAFE_METHODS`
  op→REST map + OAuth Provider with `ctx.props {ownerId, agent, scopes}` that the browser-action transport
  mirrors.
- `CLAUDE.md` — pins (`agents ^0.14.x` + `nodejs_compat`, `@modelcontextprotocol/sdk 1.29.0`, GitHub App
  RS256 JWT + opaque `ghs_` installation token, `compatibility_date 2026-04-25`), the §6.4 Wire contract,
  structured idempotency keys (never `crypto.randomUUID()`), DO = PascalCase, model tiering, the
  Definition-of-Done three tests (Wire-contract + replay + failure-path), the one-`atlas-wire`-consumer CI
  invariant.

### Existing code to reuse (verify before copying)
- `apps/flagger/src/push.ts` + `apps/flagger/src/index.ts` — the ntfy push with HTTP **action buttons** +
  the constant-time **token-gated `/ack`** inbound route: the exact substrate D4-01 extends (Approve/Reject
  + confirm link).
- `apps/sundial/src/reconcile.ts` — the existing **gated-removal proposal** (owner-confirm, never an
  autonomous delete) to **retrofit onto `packages/gate`** (D4-04).
- `apps/mcp-github/src/index.ts` — `contents:write` tool (Envoy README/portfolio file writes); a
  branch+open-PR tool likely needs adding (Claude's discretion).
- `apps/mcp-google` — `calendar.events` scope (no delete) for Usher's Calendar add (D4-07).
- `packages/codex` — read-only Codex reader (Usher registration facts + Envoy copy/voice).
- `packages/wire` + `packages/shared/src/flag.ts` — the §6.4 producer + `flag()` → `atlas-incidents`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (built, code-complete)
- **Flagger push + `/ack` (Phase 2)** — `apps/flagger/src/push.ts` + `index.ts`: ntfy push carries HTTP
  action buttons (an "Ack" button POSTing a Bearer token to a constant-time token-gated `/ack` route).
  This is the proven pattern the gate's Approve/Reject + token-gated confirm route extends (D4-01).
- **Sundial gated-removal proposal (Phase 1)** — `apps/sundial/src/reconcile.ts`: already frames a
  duplicate/orphan calendar block as a *gated* removal (owner confirm, never an autonomous delete). It is
  the first real consumer to retrofit onto the shared `packages/gate` primitive (D4-04).
- **mcp-github (Phase 0)** — `apps/mcp-github/src/index.ts`: GitHub App (RS256 JWT → opaque `ghs_`
  installation token, minted per-run), with a `contents:write` tool already present (Envoy README +
  portfolio file writes). Needs a create-branch/open-PR tool for the portfolio PR.
- **mcp-google (Phase 0/1)** — `calendar.events` (no delete) for Usher's direct Calendar add (D4-07);
  redaction egress on every tool output.
- **The macOS daemon (Phase 3)** — `daemon/` (Node bridge) + the Swift capture app: the outbound-only
  poll/drain/ack pattern, Keychain OAuth, per-agent least-privilege OAuth client, **no inbound port**.
  D4-00/D4-05 extend this to carry browser-action work items (Usher fill/submit, Envoy LinkedIn/X) that
  run locally in the owner's logged-in session.
- **Steward + `packages/steward-core`** — sole `atlas-wire` consumer + sole Vault writer; consumes
  Usher's `events-registered` increment + Envoy's Brand-counter increments unchanged (idempotent dedup).
- **`packages/codex`** — read-only Codex reader (Usher registration facts; Envoy bios/voice/projects).

### Established Patterns (must conform)
- **One writer per resource (Pillar 1).** Steward stays the sole `atlas-wire` consumer + sole Vault
  writer; Usher/Envoy are Wire **producers** and write Calendar/GitHub **directly** (not via Steward, not
  via Sundial). No new `atlas-wire` consumer (a second is a hard CI failure).
- **Suggest, don't destroy (Pillar 2) — the whole phase.** Every outward action gates; gate fail-safe =
  deny on error; timeout = expired with no action; payment never automatic; captcha never solved.
- **Idempotent + structured keys.** `usher:<event-id>:registered`, `envoy:<project-slug>` (D4-15); replay
  through Steward leaves counters unchanged (`meta.changes === 0`). Never `crypto.randomUUID()`.
- **Least-privilege scopes.** Usher `calendar.events` (browser registration is gated, not a scope);
  Envoy GitHub App scoped to the profile/portfolio repos + minimal per-platform publish; secrets in
  Secrets Store only.
- **Owner-local date via `Intl`** (`America/Toronto`), never `new Date()` (workerd TZ=UTC).
- **Definition of Done per agent PR** (CLAUDE.md): a Wire-contract test (shape + structured key), a replay
  test through Steward (`meta.changes === 0`), and a failure-path test asserting the right Flagger severity.

### Integration Points (NEW code this phase)
- **New `packages/gate`** — the shared confirmation-gate primitive (D4-04): pending-row schema, push +
  token-gated confirm route + edit round-trip, expiry-sweep cron, dual `audit_log` rows. Sundial removal
  retrofitted; any future delete uses it.
- **New cloud Workers** — `apps/usher` (on-demand event search + gated registration brain + Calendar MCP +
  Steward) and `apps/envoy` (on-demand brand-sync brain + GitHub MCP + gate). On-demand WorkerEntrypoints,
  not cron, not in the morning chain.
- **New D1** — a `gate_pending` (or similar) table for the gate; a D1 migration. Possible Usher event /
  Envoy publish bookkeeping rows.
- **Daemon extension** — a browser-action work-item channel (cloud enqueues, daemon drains/acks) layered
  on the Phase-3 outbound transport; the daemon-side local browser driver.
- **mcp-github** — add a create-branch/open-PR tool (portfolio PR).
- **Retrofit** — Sundial's `reconcile.ts` removal proposal onto `packages/gate`.

</code_context>

<specifics>
## Specific Ideas

- **The gate IS the consent point; the final click depends on reversibility.** Irreversible public posts
  (LinkedIn/X) get the owner's literal final click (D4-08); reversible/draft-like writes (GitHub PR, git
  commit, lower-stakes RSVP) the agent completes after the gate (D4-09/10). Payment never (D4-11). This
  "depth scales with reversibility" rule should be applied uniformly by the planner.
- **The local browser is the security win, not just a runtime choice** (D4-00/D4-05). Driving the owner's
  already-logged-in session is what lets Atlas honor §12 ("no credential storage / no scraping") while
  still automating LinkedIn/X/event sites — a cloud headless browser literally cannot do this without
  becoming a credential store. Planning should treat "no platform credential ever leaves the owner's
  machine" as a mechanical invariant, like the Phase-3 no-inbound-port proof.
- **Reuse the push/`ack` substrate verbatim where possible** (D4-01) — the confirm route should mirror
  Flagger's constant-time token gate (fail-closed), and the gate's P-levels (expired P3, rejected-repeats
  P2, submit-without-confirm P1) should emit through the existing `flag()`/Flagger routing.
- **The confirm page renders the LITERAL artifact** (§2.2) — exact post text for Envoy, exact form values +
  price for Usher — never a paraphrase. Edits at the gate apply to the edited version and are re-logged.

</specifics>

<deferred>
## Deferred Ideas

- **Envoy milestone / re-announce mode** — re-running Envoy for a *milestone* on an existing project (vs.
  first launch) as a distinct mode, to avoid duplicate "launch" posts (D4-15 keys on slug = no-op per
  project). A separate mode + idempotency granularity; not v1.
- **Usher cancellation / un-register flow** — decrement `events-registered` + delete the calendar event
  when the owner cancels. A separate, also-gated flow (involves a delete → must use `packages/gate`); not
  v1 (this phase is registration).
- **Usher "attended" flip** — who/when flips `events-registered` → *attended* (post-event check, owner
  tap, or calendar heuristic). §6.1 tracks both; out of v1 registration scope.
- **Usher waitlist-as-tracked-state** — treat a waitlist join as a distinct dashboard state vs. a gated
  registration. Spec open question; deferred.
- **Cloud Browser Rendering fallback** — if the local-daemon browser path proves insufficient, revisit
  Cloudflare Browser Rendering (would require Workers Paid + an ephemeral per-run login, and would NOT hold
  the owner's session). Documented fallback only; not the v1 path (D4-05).

None of the above block Phase 4. Discussion stayed within phase scope.

</deferred>

---

*Phase: 4-Outward (Gated)*
*Context gathered: 2026-06-06*
