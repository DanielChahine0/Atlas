# Constraints (synthesized intel)

> Extracted from the 23 SPEC docs. SPEC-CANON.md is the authoritative parent; per-agent and
> per-topic SPECs are derived from it and were found consistent with it (classifier notes confirm
> each derived SPEC defers authority to SPEC-CANON §-sections). Where a derived SPEC's assumption
> differed from canon, canon wins — see INGEST-CONFLICTS.md INFO bucket.

Each entry: title · source · type (api-contract | schema | nfr | protocol) · content.

---

## CON-wire-event-contract
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/SPEC-CANON.md §6.4; docs/agents/steward.md; docs/agents/atlas.md; docs/02-architecture.md
- type: schema
- content: The Wire (Cloudflare Queue) is the single event bus. Canonical event shape:
  `{ agent, type, entity, op: "increment"|"upsert"|"append", payload, idempotencyKey }`.
  Counters move via `increment` with an `idempotencyKey` so replays cannot double-count.
  Messages are JSON (default contentType); max size 128 KB (oversized rejected).

## CON-steward-single-writer
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/SPEC-CANON.md §0/§6.4; docs/agents/steward.md; docs/02-architecture.md
- type: protocol
- content: Steward is the ONLY writer to the Vault. Other agents send events on the Wire; Steward
  applies them. Writes are serialized (single consumer / DO write lock) to avoid Obsidian file
  conflicts. Steward fetches nothing — it is fed (owner's explicit requirement). CI invariant:
  exactly one `atlas-wire` consumer (Steward); a second consumer fails the build (Pillar-1 violation).

## CON-idempotency-ledger
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md (§5.3); docs/agents/steward.md
- type: protocol
- content: A D1 idempotency ledger backs every write. Applying the same `idempotencyKey` twice leaves
  the counter unchanged (`meta.changes === 0` on replay). A malformed event (missing
  `op`/`entity`/`idempotencyKey`) is rejected with no write and surfaces a Flagger P3. DLQ produces a
  P2/P3 flag — never silent loss.

## CON-d1-system-of-record
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md (D2, §6.2)
- type: nfr
- content: D1 is the authoritative system-of-record for every counter. `Counters/metrics.md` is a
  rendered projection Steward keeps in sync. D1 supports anonymous `?` positional binding only (no
  named params). Fri 16:30 weekly build re-derives counters from D1 and overwrites Vault drift,
  emitting a P3 `counter_drift` flag.

## CON-email-taxonomy
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/04-email-taxonomy.md; docs/SPEC-CANON.md §5; docs/agents/filer.md
- type: schema
- content: Literal, thread-level Gmail labels using nested `Parent/Child`. Groups:
  - Triage (mutually exclusive, exactly one): `① Action Required`, `② Action Recommended`,
    `③ Awaiting Reply`, `④ FYI / Read Later`, `⑤ No Action`.
  - Type: `Type/Job` (+ Application/Recruiter/OA/Interview/Offer/Rejection), `Type/Events`
    (+ Invite/Confirmed/Reminder), `Type/Finance` (+ Bill/Receipt/Bank/Tax/Subscription),
    `Type/School` (+ Deadline/Grade/Admin), `Type/Newsletter`, `Type/Promotion`, `Type/Social`,
    `Type/Travel`, `Type/Dev`, `Type/Security`, `Type/Personal`.
  - Needs: `Needs/Reply|Pay|Register|Schedule|Upload|Sign|Decide`.
  - Deadline: `Due/Today|ThisWeek|Expired`.
  - Relationship: `From/VIP`, `From/Company/<Name>`, `From/Automated`.
  - Suggestion: `Suggest/Keep|Delete|Unsubscribe`.
  - Agent-state: `AI/Reviewed`, `AI/Uncertain`, `⚠ Phishing-Suspect`.
  Label strings are copied exactly; copy them verbatim from SPEC-CANON §5.

## CON-filer-labels-only
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/SPEC-CANON.md §5.8; docs/04-email-taxonomy.md; docs/11-security-privacy.md
- type: protocol
- content: Filer never auto-archives or auto-deletes — labels only (owner requirement). Idempotency:
  skip threads carrying `AI/Reviewed`; never thrash labels on re-run. No contradictory labels (e.g.
  `Suggest/Delete` + `① Action Required`). Reserved system labels (INBOX/SENT/SPAM/TRASH) are immutable.
  Batch + back off against Gmail API rate limits. Color-code each parent group. Scope: `gmail.modify`
  only — no `messages.delete`/`threads.delete` path reachable (would need full `mail.google.com/`).

## CON-security-mail-redaction
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/SPEC-CANON.md §5.8/§12; docs/11-security-privacy.md; docs/agents/herald.md
- type: nfr
- content: Security mail is sensitive. NEVER reproduce 2FA codes / reset links in any digest; never
  click links in `Type/Security` or `⚠ Phishing-Suspect`. Redaction must be enforced at the
  Google-MCP server-side strip point (a prompt instruction alone is NOT sufficient), with a
  digest-builder unit test as a CI backstop. Headline security invariant: ZERO codes/links surfaced.

## CON-scheduling-clock
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/03-scheduling.md; docs/SPEC-CANON.md §10
- type: protocol
- content: Cloudflare Cron Triggers (UTC-only, no DST) + Workflows for durable multi-step runs. Owner-
  local schedule: Filer continuous (Gmail push) + 07:45 sweep; Herald 08:00 daily / Fri 16:00 weekly;
  Forge 08:15; Sundial 08:20; Compass 08:30 + 21:00 preview; Headhunter 09:00 daily-light + Mon 09:00
  full; Scout Fri 16:00; weekly-review build Fri 16:30; Echo on meeting start (local, parallel);
  Archivist on meeting end; Usher/Quill/Envoy/Librarian/Switchboard on-demand; Steward/Flagger
  event-driven (never self-scheduled).
  Concurrency: the morning chain (Filer->Herald->Forge->Sundial->Compass) is STRICTLY SEQUENTIAL
  (start-after-success); Friday 16:00 Scout + weekly-Herald run in parallel then fan into Steward;
  Steward writes are serialized regardless of concurrent firings; Echo runs in parallel with everything.

## CON-timezone-policy
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/13-build-plan.md (D1, §1, §5.5)
- type: protocol
- content: Cron Triggers are UTC-only, no DST. Policy: UTC-translation-with-DST-edits — each owner-local
  §10 line is hand-translated to UTC (07:45 ET = `45 11 * * *` EDT / `45 12 * * *` EST) and re-derived
  at each EST/EDT boundary. Internal step budgets use `step.sleepUntil` with a tz-correct `Date`;
  only the trigger cron needs the twice-yearly edit. (See DEC-cron-timezone / D1.)

## CON-cloudflare-primitive-map
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/06-hosting-cloudflare-mcp.md; docs/SPEC-CANON.md §7; docs/13-build-plan.md (§1)
- type: protocol
- content: Compute = Workers; stateful/long-lived agents = Durable Objects (one DO per agent; Echo uses
  DO + WebSocket live stream). Scheduling = Cron Triggers; durable multi-step = Workflows. Event bus /
  Steward serialization = Queues (the Wire) + a mandatory DLQ (`atlas-wire-dlq`). State: D1 (tasks,
  jobs, events, run-log, audit_log), KV (config/flags + OAuth provider store), R2 (audio blobs,
  exports), DOs (per-agent live state). Model access = Claude via AI Gateway (Workers AI as Filer
  fallback only). Hard prerequisite: Cloudflare Workers PAID plan (Queues, Workflows, KV-backed DOs).

## CON-mcp-connectivity
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/06-hosting-cloudflare-mcp.md; docs/10-switchboard.md; docs/agents/switchboard.md
- type: api-contract
- content: Agents/tools are hosted as remote MCP servers on Workers (Cloudflare Agents SDK). Connect
  Gmail/Calendar/Drive/Sheets via Google OAuth2 (least-privilege scopes); GitHub via a GitHub App;
  Obsidian via a LOCAL MCP bridge (the Vault lives on the local machine). Switchboard (design-time
  router) selects the minimal MCP server + tools + resources + OAuth scopes for a goal and hands a
  toolset to the executing agent; reports capability gaps to Flagger.

## CON-oauth-least-privilege
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/11-security-privacy.md; docs/SPEC-CANON.md §7/§12; docs/06-hosting-cloudflare-mcp.md
- type: protocol
- content: Per-agent least-privilege OAuth scopes. Filer = `gmail.modify` (labels), NOT delete. Codex
  read = `drive.readonly`. Workers OAuth Provider for inbound (PKCE S256; startup fails without a real
  `OAUTH_KV` namespace). Google refresh tokens + GitHub installation tokens in Cloudflare Secrets Store;
  GitHub tokens minted per-run (~1h, never persisted). Secrets are async-read in Workers. No secrets in
  the Vault or Codex. `listUserGrants`/`revokeGrant` back an owner "what can Atlas do / revoke" surface.

## CON-confirmation-gates
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/11-security-privacy.md; docs/SPEC-CANON.md §12; docs/agents/usher.md; docs/agents/envoy.md
- type: protocol
- content: Confirmation gates on every irreversible/outward action (Envoy posting, Usher
  registering/paying, any delete). Default = draft + ask. Gate fail-safe = deny on error. CI test
  asserts no outward action fires without explicit owner confirm. Captcha/payment are hard stops that
  hand back to the human. No silent writes — ever.

## CON-local-capture-boundary
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/11-security-privacy.md; docs/SPEC-CANON.md §12; docs/agents/echo.md; docs/agents/quill.md; docs/13-build-plan.md (D3, D4)
- type: nfr
- content: Echo audio and Quill screen never leave the device except as derived artifacts the owner
  approves. Echo: per-session consent before recording; two-party-consent jurisdictions honored; raw
  audio uploaded via presigned URL direct from the daemon (never proxied through a Worker); raw expires
  at 7 days (`audio/raw/` R2 prefix only; `transcripts/`/`exports/` persist). Quill: hotkey-triggered,
  never autonomous, never writes the Codex back. Daemon transport: OAuth-bearer over outbound-only
  pull/long-poll — NO inbound port to the laptop (verified: only Obsidian's `127.0.0.1:27124` listens).

## CON-audit-log-schema
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/11-security-privacy.md; docs/13-build-plan.md (§5.2)
- type: schema
- content: D1 `audit_log` records every agent action (surfaced via Flagger). D1 `run_log` carries one
  row per agent pass with non-null `rows_read`/`duration_ms`; a forced exception leaves an `audit_log`
  row with `outcome="error"`. Observability is wired from day 0, before any Flagger code exists.

## CON-flag-schema
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/SPEC-CANON.md §8; docs/08-flagger.md; docs/agents/flagger.md
- type: schema
- content: Flag shape: `{ id, ts, source_agent, severity, trust, title, detail, suggested_action,
  status }`. Severity: `P1 Critical | P2 High | P3 Medium | P4 Low/Info`. Trust score 0-100 (caught
  exception = high trust; LLM "looks suspicious" = lower). Status lifecycle: `open -> ack -> resolved
  -> muted`. Routing: P1/P2 -> push immediately; P3/P4 -> batched into the dashboard feed. Vault
  Flagger board sorted by severity then trust. Flagger self-monitors (flags its own heartbeat staleness).

## CON-codex-schema
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/07-source-of-truth-codex.md; docs/SPEC-CANON.md §11
- type: schema
- content: The Codex (`codex.md` in the Vault / a Google Doc) holds every reusable personal fact:
  identity (name, email, phone, links), addresses, education, work experience (title, company, dates,
  bullets), skills, projects (name, repo, blurb, links), bios (short/long), socials, demographics/EEO,
  and "voice" notes. Quill maps form-field labels -> Codex fields. Read by Quill (autofill), Envoy
  (brand), Archivist (work context). Read-only to agents except an explicit "update my profile" flow.

## CON-prompt-library-record
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/09-prompt-library.md; docs/SPEC-CANON.md §9; docs/agents/librarian.md
- type: schema
- content: Librarian record shape: `{ title (<= 6 words), slug, tags[], tool (Claude/Canva/etc.),
  full_prompt, created, last_used, uses }`. Vault table columns: Title (link) · Tags · Tool · Last used;
  title deep-links to the full-prompt note (`obsidian://` or relative link). Optional dedupe of
  near-identical prompts via `idempotencyKey`; surface most-used at top. NOTE: librarian.md (a DOC)
  is the agent-doc companion and defers schema authority to 09-prompt-library.md (SPEC) — the SPEC's
  record shape is canonical.

## CON-task-store-schema
- source: /Users/danielchahine/Desktop/Programs/Atlas/docs/agents/forge.md
- type: schema
- content: Forge writes a D1 task store (tasks/subtasks) with deadlines, deduped by a `dedupe_key`
  algorithm under a Durable Object lock; emits Wire events on create/update. Sundial dedupes calendar
  blocks by `atlasTaskId` extended properties on the Google Calendar event.
