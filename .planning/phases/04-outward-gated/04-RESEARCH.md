# Phase 4: Outward (Gated) — Research

**Researched:** 2026-06-06
**Domain:** Confirmation gates, browser automation, GitHub PR MCP, daemon transport, Wire/Steward integration
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D4-00:** Usher/Envoy = "cloud-brain + local-hands." Cloud resolves, drafts, gates, writes Calendar/GitHub via MCP, bumps Steward. Browser action runs in the Phase-3 local macOS daemon against the owner's already-logged-in session. Gate stays in the cloud; on approval the cloud enqueues a browser-action work item the daemon picks up on its next outbound poll.
- **D4-01:** Approval surface = ntfy push + token-gated confirm link. Reuse Phase-2 push (HTTP action buttons). Push carries "Review & edit" link only (no inline Approve for irreversible actions). Confirm page renders the literal artifact with edit box.
- **D4-02:** Gate waits as a D1 `gate_pending` row + re-invoke on approval. No live browser session held across the human pause. A cron sweep expires stale gates (fail-safe → `expired`, P3). On approval the agent is re-invoked and re-establishes context.
- **D4-03:** Per-action gate timeout. Usher ~24h (events sell out). Envoy ~7d (launch post not time-critical). Tunable config; pattern is per-action not global.
- **D4-04:** ONE shared `packages/gate` primitive. Owns: pending-row schema, push + token-gated confirm route, expiry sweep, dual `audit_log` rows. Usher, Envoy, Sundial removal proposal all call it.
- **D4-05:** Browser runs in the local daemon against the owner's already-logged-in sessions. Never stores or scrapes credentials. Extends Phase-3 macOS daemon. Rejected: Cloudflare Browser Rendering.
- **D4-06:** Phase 4 stays on Workers Free plan. D1 pending row (not Workflow waitForEvent), browser is local/MCP.
- **D4-07:** Clean MCP-vs-browser split. Usher Calendar add → Google Calendar MCP. Envoy README + portfolio PR → mcp-github. Browser strictly for login-required, ToS-gray targets (LinkedIn, X, event-site registration).
- **D4-08:** Envoy LinkedIn + X — owner clicks the final Post. Daemon opens the platform composer pre-filled; owner clicks Post. Maximum safety on irreversible public posts.
- **D4-09:** Usher registration — auto-submits free/captcha-free path after confirm. Hard stops always override (captcha P3, payment P2, sold-out/waitlist P3, login-wall P3, ToS/anti-bot P2). Submit without confirmation # = not registered (no Calendar add, no counter; P2). Submit attempted without confirmation = P1 self-flag.
- **D4-10:** Envoy GitHub targets — agent completes after confirm. Commits profile README + opens portfolio PR via mcp-github. PR is draft-by-nature; README commit is git-reversible.
- **D4-11:** Payment is always a manual hard stop. Never enters card details. Price + checkout link handed to owner. P2 flag. No override knob.
- **D4-12:** All four Envoy targets ship in v1 — LinkedIn + X (local browser, owner clicks) and GitHub profile README + portfolio PR (mcp-github, agent completes). Per-target approve/edit/skip at the gate.
- **D4-13:** LinkedIn = auto-fill the experience/project fields from the Codex, owner clicks Save. On DOM/layout block, abort that target + keep the draft (P2).
- **D4-14:** Portfolio repo + project-entry convention is configured at go-live, not in code. Lives in a config knob the owner seeds at go-live.
- **D4-15:** Envoy idempotency keyed on project slug (`envoy:<project-slug>`); a re-run for the same project is a no-op. Milestone-update mode is deferred.

### Claude's Discretion

- `packages/gate` internals: exact D1 schema, confirm-page rendering + edit round-trip, expiry-sweep cron cadence/owner-Worker, dual `audit_log` rows.
- Daemon ↔ cloud browser-action transport: work-item schema, daemon-side browser driver choice.
- mcp-github create-PR tool: permissions needed, REST calls, registerTool pattern.
- Usher operational lifecycle (attended-flip, cancellation, waitlist) — capture as follow-ups, don't build.
- Usher idempotency: event-id resolution + already-registered short-circuit.
- Per-platform selectors / field maps.
- Confirm-page hosting: which Worker serves the confirm page + route.

### Deferred Ideas (OUT OF SCOPE)

- Envoy milestone / re-announce mode (separate slug/idempotency granularity; not v1).
- Usher cancellation / un-register flow (separate gated flow involving a delete; not v1).
- Usher "attended" flip (post-event; out of v1 registration scope).
- Usher waitlist-as-tracked-state (distinct state; deferred).
- Cloud Browser Rendering fallback (documented fallback only; not v1 path per D4-05).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OUTWARD-01 | Usher does on-demand event search + gated registration (browser automation) + Google Calendar add and bumps the Steward `events-registered` counter; no outward action fires without explicit owner confirm (gate adherence = 100%); captcha/payment are hard stops handed back to the human. | packages/gate primitive + daemon browser-action transport + Calendar MCP + Wire event shape. |
| OUTWARD-02 | Envoy fans one owner intent out to LinkedIn / GitHub README / X / portfolio, drafts each (reading the Codex, GitHub via GitHub MCP), and ships only on confirmation; a public post / payment is never silent and a post can't be un-posted. | packages/gate primitive + mcp-github create-PR tool + daemon browser-action transport + Codex field map + Wire event shape. |
</phase_requirements>

---

## Summary

Phase 4 ships two outward, irreversible agents (Usher and Envoy) using a shared `packages/gate` confirmation primitive that is the actual deliverable of this phase. The agents themselves are light "cloud-brain + local-hands" Workers: the cloud side resolves, drafts, and runs the gate; the browser action runs in the Phase-3 macOS daemon in the owner's already-logged-in session. This architecture is forced by the §12 no-credential-storage invariant — a cloud headless browser cannot hold LinkedIn/X/event-site sessions without becoming a credential store.

The `packages/gate` primitive is a new shared package that owns: (1) a D1 `gate_pending` table with a token-gated confirm page served from a shared gate Worker; (2) ntfy push with a "Review & edit" link carrying the literal artifact; (3) a cron-sweep expiry; and (4) dual `audit_log` rows (pending + terminal). Sundial's existing gated-removal proposal in `apps/sundial/src/reconcile.ts` is retrofitted onto this primitive as its first consumer.

The browser-action transport reuses the `daemon/src/drain.ts` poll/drain/ack pattern exactly, adding a second outbox table (`browser_action_outbox`) drained by an extended daemon. Playwright 1.60.0 (current as of 2026-06-06) runs headed against a persistent Chromium profile (`launchPersistentContext(userDataDir)`), preserving the owner's logged-in sessions across daemon restarts. For irreversible posts (LinkedIn/X) the daemon pre-fills and leaves focus on the composer; the owner clicks Post. For Usher form submission (free/captcha-free) the daemon auto-submits and scrapes the confirmation number.

**Primary recommendation:** Build in this order: (1) `packages/gate` (the shared primitive, including migration 0007, the confirm Worker, and the expiry cron); (2) retrofit Sundial; (3) daemon browser-action extension with Playwright; (4) mcp-github create-branch/open-PR tool; (5) apps/usher Worker; (6) apps/envoy Worker.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Event search / resolution | API / Backend (Usher Worker, cloud) | Browser via daemon | Playwright in daemon scrapes event details; cloud makes the decision |
| Confirmation gate + push | API / Backend (gate Worker + Flagger push) | — | D1 pending row, token-gated confirm page, expiry cron — all cloud |
| Confirm page rendering | API / Backend (gate Worker, server-rendered HTML) | — | authHtmlResponse() pattern; no build step; single inline style block |
| Form fill + auto-submit (Usher) | Local daemon (Playwright against owner's session) | — | No credentials ever leave the device; bot-detection avoidance |
| LinkedIn/X pre-fill (Envoy) | Local daemon (Playwright, headed, owner clicks Post) | — | Irreversible post safety; ToS posture |
| GitHub README + portfolio PR | API / Backend (mcp-github, GitHub App) | — | Authorized, reversible, no browser needed |
| Calendar event add | API / Backend (mcp-google, calendar.events) | — | Authorized scope; not via browser |
| Steward counter bump | API / Backend (Wire producer → Steward) | — | Pillar 1; Steward is the sole atlas-wire consumer |
| Codex reads | API / Backend (packages/codex) | — | Read-only; same field mapping as Quill |
| Audit log | API / Backend (D1 audit_log) | — | Two rows per gated action (pending + terminal) |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `playwright` | 1.60.0 | Headed persistent-profile browser automation in the daemon | Only option for operating inside the owner's already-logged-in browser session; launchPersistentContext preserves cookies/localStorage across daemon restarts |
| `agents` (Cloudflare Agents SDK) | ^0.14.3 (current: 0.14.3) | McpAgent / registerTool for new mcp-github PR tool | Already pinned; `nodejs_compat` required |
| `@modelcontextprotocol/sdk` | 1.29.0 | registerTool() in mcp-github for create-branch/open-PR | Already pinned; prefer registerTool() (v2-forward path) |
| `@cloudflare/workers-oauth-provider` | ^0.7.x | Gate confirm page uses the same session/auth pattern | Already in atlas |
| `zod` | ^3.25 || ^4.0 | Schema validation for gate pending row and browser-action work item | Already pinned |

[VERIFIED: npm registry] — `playwright` 1.60.0 published 2026-06-06; `agents` 0.14.3 published 2026-06-05; `@modelcontextprotocol/sdk` 1.29.0 confirmed; all pass `slopcheck` [OK].

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@atlas/wire` | workspace | Wire event producer (send()) | Every Wire event from Usher/Envoy |
| `@atlas/shared` | workspace | flag() → atlas-incidents; FlagRecord type; contentHash; localDate() | All Usher/Envoy failure paths |
| `@atlas/codex` | workspace | Read-only Codex reader (identity/email/phone/EEO for Usher; bios/voice/projects for Envoy) | At the top of every Usher and Envoy invocation |
| `@atlas/model` | workspace | claudeFor(agent, env) → AI Gateway | Usher/Envoy Claude calls |
| `@atlas/security` | workspace | redact() on any output that might carry sensitive content before egress | Gate confirm page, ntfy push bodies |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Playwright persistent profile | puppeteer | Playwright has a cleaner launchPersistentContext API and is already the project's implicit choice per the build plan; puppeteer has no functional advantage here |
| Playwright persistent profile | WebDriver/CDP | Lower-level; more brittle; Playwright's auto-wait/fill semantics reduce selector fragility |
| Playwright persistent profile | Cloudflare Browser Rendering | Cannot hold the owner's login session; datacenter IPs get bot-blocked on LinkedIn/X; rejected by D4-05 |
| D1 gate_pending + cron sweep | Workflow step.waitForEvent | waitForEvent blocks for the full wait; Free plan 3-day Workflow state retention would expire before a 7d Envoy gate; rejected by D4-02 |

**Installation (daemon only — gate Worker and Workers are pnpm monorepo packages):**
```bash
# In daemon/ workspace
pnpm add playwright
npx playwright install chromium  # one-time; installs the managed Chromium binary
```

---

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `playwright` | npm | 6+ yrs | >5M/wk | github.com/microsoft/playwright | [OK] | Approved |
| `agents` | npm | ~1 yr | >200k/wk (growing) | github.com/cloudflare/agents | [OK] | Approved |
| `@modelcontextprotocol/sdk` | npm | ~1.5 yr | >1M/wk | github.com/modelcontextprotocol/typescript-sdk | [OK] | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

No postinstall scripts surfaced for any recommended package.

---

## Architecture Patterns

### System Architecture Diagram

```
Owner intent
     │
     ▼
┌──────────────────────────────────────────────────────────────┐
│  CLOUD (Cloudflare Workers)                                  │
│                                                              │
│  apps/usher or apps/envoy (WorkerEntrypoint, on-demand)      │
│    │ 1. Read Codex (packages/codex)                          │
│    │ 2. Resolve event/repo (browser-action outbox → daemon)  │
│    │ 3. Draft literal artifact                               │
│    │ 4. Call packages/gate → write gate_pending D1 row       │
│    │    → ntfy push with confirm link                        │
│    │    → return (gate is now waiting)                       │
│    │                                                         │
│  apps/gate (confirm-page Worker)                             │
│    │ GET /confirm?token=<T>  → render confirm HTML           │
│    │ POST /confirm           → validate token, set decision  │
│    │     → approved → re-invoke agent via service binding    │
│    │     → rejected → write audit_log terminal row           │
│    │                                                         │
│  On approval re-invoke:                                      │
│    │ Usher: write gate_pending.status=approved               │
│    │   → enqueue browser-action work item (D1 browser_action_outbox)
│    │   → [daemon picks up, fills+submits form, acks outcome] │
│    │   → on success outcome: Calendar MCP add                │
│    │   → send Wire event (events-registered++)               │
│    │ Envoy GitHub targets: mcp-github (README commit + PR)   │
│    │ Envoy LinkedIn/X: enqueue browser-action work item      │
│    │   → [daemon picks up, pre-fills composer, leaves focus] │
│    │   → on success: send Wire event (brand counters++)      │
│    │                                                         │
│  Steward (sole atlas-wire consumer)                          │
│    → D1 counters++ + vault_outbox → Obsidian Vault           │
│                                                              │
│  Flagger (P1/P2 → ntfy push; P3/P4 → Vault feed)            │
│                                                              │
│  Cron (gate-expiry sweep Worker or existing Worker cron)     │
│    → SELECT gate_pending WHERE expires_at < now AND status=pending
│    → UPDATE status=expired + write audit_log terminal row    │
│    → flag(P3, "gate expired")                                │
└──────────────────────────────────────────────────────────────┘
          │ poll/drain/ack (outbound only, no inbound port)
          ▼
┌──────────────────────────────────────────────────────────────┐
│  LOCAL macOS daemon (extended Phase-3 daemon)                │
│                                                              │
│  drain.ts pattern: poll cloud bridge → drain browser-action  │
│  outbox → execute locally → ack outcome                      │
│                                                              │
│  Playwright (launchPersistentContext, headed/headless)        │
│    Usher: fill form + auto-submit → scrape confirmation #     │
│    Envoy LinkedIn: fill experience/project form → owner Save │
│    Envoy X: open composer pre-filled → owner clicks Post      │
│                                                              │
│  Outcome: { status, confirmationNumber?, screenshotR2Key? }  │
│  Ack back to cloud via POST /browser/ack                     │
└──────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
packages/
└── gate/               # NEW: shared confirmation-gate primitive
    ├── src/
    │   ├── index.ts    # openGate(), getGate(), decideGate(), sweepExpired() exports
    │   ├── schema.ts   # GatePending zod schema + D1 row type
    │   ├── push.ts     # buildConfirmPush() — ntfy payload with confirm link
    │   ├── render.ts   # renderConfirmPage() → HTML string (follows consent.ts pattern)
    │   └── auth.ts     # generateGateToken() + timingSafeEqual (copied from flagger/auth.ts)
    └── package.json

apps/
├── gate/               # NEW: the confirm-page + expiry-sweep Worker
│   ├── src/
│   │   └── index.ts   # fetch() → GET /confirm, POST /confirm; scheduled() → sweep
│   └── wrangler.jsonc
├── usher/              # NEW: Usher cloud Worker (brain only)
│   ├── src/
│   │   ├── index.ts   # WorkerEntrypoint, on-demand fetch()
│   │   ├── find.ts    # event resolution via browser-action outbox (returns event details)
│   │   ├── fill.ts    # Codex→form field mapping (same as Quill)
│   │   └── calendar.ts # Google Calendar MCP add (after confirmed registration)
│   └── wrangler.jsonc
└── envoy/              # NEW: Envoy cloud Worker (brain + GitHub MCP only)
    ├── src/
    │   ├── index.ts   # WorkerEntrypoint, on-demand fetch()
    │   ├── draft.ts   # fan-out: draft all 4 targets from Codex
    │   ├── github.ts  # README commit + portfolio PR via mcp-github
    │   └── browser.ts # enqueue LinkedIn/X browser-action work items
    └── wrangler.jsonc

daemon/src/
├── drain.ts            # EXISTING — Obsidian bridge (unchanged)
├── browser-drain.ts    # NEW — browser-action outbox poll/drain/ack
└── browser-runner.ts   # NEW — Playwright execution (fill, submit, scrape)

migrations/
└── 0007_gate.sql       # NEW — gate_pending + browser_action_outbox tables
```

### Pattern 1: packages/gate openGate()

The canonical entry point for any agent that needs a human confirm before acting.

```typescript
// Source: derived from apps/flagger/src/auth.ts + docs/11-security-privacy.md §2.2 + §8
// packages/gate/src/index.ts

export interface GateOptions {
  agent: "Usher" | "Envoy" | "Sundial";
  action: string;          // e.g. "event.register", "brand.publish", "calendar.remove"
  target: string;          // event-id, project-slug, calendar-event-id
  /** The LITERAL artifact: exact post text or exact form values (§2.2). JSON string. */
  artifact: string;
  /** Edited version (null until owner edits at the gate). */
  editedArtifact?: string;
  idempotencyKey: string;  // "usher:<event-id>:registered" or "envoy:<project-slug>"
  expiresInMs: number;     // 24 * 60 * 60 * 1000 for Usher; 7 * 24 * 60 * 60 * 1000 for Envoy
  confirmBaseUrl: string;  // the gate Worker base URL (from [vars])
}

export interface GateRecord {
  id: string;         // ulid
  token: string;      // random hex, stored hashed, sent in confirm link
  status: "pending" | "approved" | "rejected" | "expired";
  decision: "pending" | "approved" | "rejected" | "expired";
  expires_at: number; // epoch ms
  flag_id?: string;
  created_at: number;
}

// D1 schema (migration 0007):
// CREATE TABLE gate_pending (
//   id              TEXT PRIMARY KEY,   -- ulid
//   agent           TEXT NOT NULL,
//   action          TEXT NOT NULL,
//   target          TEXT NOT NULL,
//   artifact        TEXT NOT NULL,      -- JSON literal artifact
//   edited_artifact TEXT,               -- JSON edited artifact (null until edited)
//   status          TEXT NOT NULL DEFAULT 'pending',
//   decision        TEXT NOT NULL DEFAULT 'pending',
//   idempotency_key TEXT NOT NULL UNIQUE,
//   token_hash      TEXT NOT NULL,      -- SHA-256 of the random token (never store plaintext)
//   expires_at      INTEGER NOT NULL,   -- epoch ms
//   flag_id         TEXT,               -- FK to Flagger flag (if raised)
//   created_at      INTEGER NOT NULL,
//   updated_at      INTEGER NOT NULL
// );
// CREATE INDEX IF NOT EXISTS idx_gate_status     ON gate_pending(status, expires_at);
// CREATE INDEX IF NOT EXISTS idx_gate_idem_key   ON gate_pending(idempotency_key);
```

**Key:** `token_hash` stores the SHA-256 of the opaque token (never the plaintext). The confirm link carries the plaintext token; the Worker hashes it and compares against token_hash (constant-time). This mirrors how the Obsidian bridge auth works.

### Pattern 2: Confirm-page Worker (apps/gate)

The gate Worker serves only two routes — confirm page GET/POST — and one scheduled sweep.

```typescript
// Source: apps/atlas/src/auth/consent.ts + apps/atlas/src/auth/headers.ts pattern
// apps/gate/src/index.ts (structural outline)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/confirm") {
      // Extract token from query string
      const token = url.searchParams.get("t");
      if (!token) return authResponse("Bad Request", { status: 400 });

      // Hash token + look up gate_pending row (fail-closed if missing/expired)
      const tokenHash = await sha256(token);
      const row = await env.DB.prepare(
        "SELECT * FROM gate_pending WHERE token_hash = ? AND status = 'pending'"
      ).bind(tokenHash).first<GatePendingRow>();

      if (!row || Date.now() > row.expires_at) {
        return authHtmlResponse(renderExpiredPage());
      }

      if (request.method === "GET") {
        return authHtmlResponse(renderConfirmPage(row));
      }

      if (request.method === "POST") {
        // Same-origin check (fail-closed per consent.ts pattern)
        if (!isSameOrigin(request)) return authResponse("Forbidden", { status: 403 });

        const form = await request.formData();
        const decision = form.get("decision"); // "approve" or "reject"
        const edited = form.get("edited_artifact"); // null if not edited

        if (decision !== "approve" && decision !== "reject") {
          return authResponse("Bad Request", { status: 400 });
        }

        // Write terminal audit_log row first (before any side effect)
        // Then update gate_pending status + re-invoke agent if approved
        await handleDecision(env, row, decision as "approve" | "reject", edited as string | null);

        return authHtmlResponse(renderOutcomePage(decision));
      }

      return authResponse("Method Not Allowed", { status: 405 });
    }

    return authResponse("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Sweep: SELECT WHERE status='pending' AND expires_at < now()
    // For each: UPDATE status=expired, write terminal audit_log row, flag(P3)
    await sweepExpired(env);
  },
} satisfies ExportedHandler<Env>;
```

**Hosting decision (Claude's Discretion resolved):** A dedicated `apps/gate` Worker (not per-agent). Rationale: (1) one place to audit the fail-safe; (2) Usher, Envoy, and Sundial all call it; (3) the confirm link URL must be stable — a shared Worker has one stable hostname. The Worker has DB + INCIDENTS + WIRE bindings plus the GATE_TOKEN Secrets Store binding (the ACK_TOKEN equivalent for the gate's bearer token).

### Pattern 3: Browser-action Transport (daemon extension)

The cloud side writes a `browser_action_outbox` D1 row (separate from `vault_outbox`) and the daemon polls a new `/browser/poll` endpoint on the gate Worker (or a dedicated bridge Worker). The daemon acks at `/browser/ack`.

```typescript
// Source: daemon/src/drain.ts pattern — reused verbatim
// daemon/src/browser-drain.ts (structural outline)

export interface BrowserActionWorkItem {
  id: string;          // ulid
  agent: "Usher" | "Envoy";
  action_type: "event_fill_submit" | "linkedin_prefill" | "x_prefill";
  /** JSON payload with all field values already resolved from Codex + gate. */
  fields: string;
  /** Gate row id — so the daemon acks back to the correct gate. */
  gate_id: string;
  /** For Usher: the event registration URL. For Envoy: the platform URL. */
  target_url: string;
  status: "pending" | "claimed" | "done" | "failed";
  created_at: number;
}

// Outcome acked back to cloud:
export interface BrowserActionOutcome {
  id: string;
  status: "success" | "hard_stop" | "error";
  hard_stop_reason?: "captcha" | "payment" | "sold_out" | "login_wall" | "tos_block" | "no_confirmation";
  confirmation_number?: string;  // Usher only, on success
  screenshot_r2_key?: string;    // on hard_stop or error, for forensics
}
```

D1 schema (`browser_action_outbox` in migration 0007):
```sql
CREATE TABLE IF NOT EXISTS browser_action_outbox (
  id              TEXT PRIMARY KEY,      -- ulid
  agent           TEXT NOT NULL,         -- "Usher" | "Envoy"
  action_type     TEXT NOT NULL,         -- "event_fill_submit" | "linkedin_prefill" | "x_prefill"
  fields          TEXT NOT NULL,         -- JSON: resolved field values from Codex + gate
  gate_id         TEXT NOT NULL,         -- FK → gate_pending.id
  target_url      TEXT NOT NULL,         -- registration URL or platform composer URL
  status          TEXT NOT NULL DEFAULT 'pending',
  claimed_at      INTEGER,               -- epoch ms when daemon claimed (same pattern as vault_outbox)
  outcome         TEXT,                  -- JSON BrowserActionOutcome on done/failed
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_action_status ON browser_action_outbox(status, created_at);
```

### Pattern 4: Playwright Persistent Context in the Daemon

The daemon manages a single persistent Chromium profile that preserves the owner's logged-in sessions. The profile lives at a local path (e.g., `~/.atlas/browser-profile`) configured in the daemon's environment (never a tracked file).

```typescript
// Source: Context7 Playwright docs — launchPersistentContext
// daemon/src/browser-runner.ts (structural outline)

import { chromium, type Browser, type BrowserContext } from "playwright";

export async function withBrowserContext(
  profilePath: string,
  fn: (ctx: BrowserContext) => Promise<void>,
): Promise<void> {
  // launchPersistentContext preserves cookies/localStorage across daemon restarts.
  // headless: false is required for LinkedIn/X where the owner clicks the final Post.
  // Usher can use headless: false for visibility; the form submission doesn't require UI.
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,   // owner needs to see the composer / confirm the submit
    slowMo: 50,        // reduces bot-detection signal from instant interactions
  });

  try {
    await fn(context);
  } finally {
    // Do NOT close the context on completion — it's persistent across work items.
    // Only close if the daemon is shutting down.
  }
}

// For Usher event fill+submit:
export async function fillAndSubmit(
  ctx: BrowserContext,
  item: BrowserActionWorkItem,
): Promise<BrowserActionOutcome> {
  const page = await ctx.newPage();
  try {
    await page.goto(item.target_url, { waitUntil: "networkidle" });

    // Hard stop: captcha detection (before filling anything)
    if (await detectCaptcha(page)) {
      return { id: item.id, status: "hard_stop", hard_stop_reason: "captcha" };
    }

    // Parse fields from JSON and fill form
    const fields = JSON.parse(item.fields) as Record<string, string>;
    for (const [selector, value] of Object.entries(fields)) {
      await page.fill(selector, value);  // Page.fill() waits for actionability
    }

    // Hard stop: payment wall check (before submit)
    if (await detectPaymentWall(page)) {
      return { id: item.id, status: "hard_stop", hard_stop_reason: "payment" };
    }

    // Submit and scrape confirmation
    await page.click('[type="submit"]');
    const confirmationNumber = await scrapeConfirmation(page);

    if (!confirmationNumber) {
      return { id: item.id, status: "hard_stop", hard_stop_reason: "no_confirmation" };
    }

    return { id: item.id, status: "success", confirmation_number: confirmationNumber };
  } finally {
    await page.close();
  }
}
```

**Browser driver recommendation (Claude's Discretion resolved):** Playwright 1.60.0 with `launchPersistentContext` against a daemon-managed persistent profile at `~/.atlas/browser-profile`. [VERIFIED: npm registry, Context7] This is the correct choice because:
1. `launchPersistentContext(userDataDir)` preserves cookies/localStorage across runs — the owner's LinkedIn, X, Meetup, Eventbrite sessions persist without any credential storage by Atlas.
2. Playwright's auto-wait (`page.fill`, `page.click`) reduces brittle timing bugs vs raw CDP.
3. The profile is managed by the daemon (`$ATLAS_BROWSER_PROFILE` env var, never a tracked file) — same pattern as `ATLAS_BRIDGE_TOKEN`.
4. `headless: false` lets the owner see the composer (Envoy) or the form being filled (Usher) and confirms their click (D4-08 Envoy).
5. No credential ever leaves the machine; bot-detection is reduced because it's the same Chromium instance the owner's IP/profile has used before.

### Pattern 5: mcp-github create-branch/open-PR Tool

Envoy needs two new tools in `apps/mcp-github/src/index.ts` beyond the existing `github_put_file`:

```typescript
// Source: apps/mcp-github/src/index.ts pattern (registerTool at MCP SDK 1.29.0)
// GitHub REST API: POST /repos/{owner}/{repo}/git/refs (create branch)
//                  PUT  /repos/{owner}/{repo}/contents/{path} (put file)
//                  POST /repos/{owner}/{repo}/pulls (open PR)

this.server.registerTool(
  "github_create_branch",
  {
    title: "Create a git branch",
    description: "Create a new branch ref in a repo. Requires github.write.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        branch: { type: "string" },   // e.g. "add-project/atlas"
        fromBranch: { type: "string" }, // base branch, e.g. "main"
      },
      required: ["owner", "repo", "branch", "fromBranch"],
    },
  },
  async (params) => {
    if (!this.hasScope("github.write")) return this.forbidden();
    try {
      const token = await this.mintToken({
        permissions: { contents: "write", metadata: "read", pull_requests: "write" },
      });
      // 1. GET /repos/{owner}/{repo}/git/ref/heads/{fromBranch} → SHA
      // 2. POST /repos/{owner}/{repo}/git/refs { ref: "refs/heads/{branch}", sha }
      // (token stays server-side; only result returned)
      return { content: [{ type: "text", text: JSON.stringify({ branch: params.branch }) }] };
    } catch (err) {
      return this.mintError(err);
    }
  },
);

this.server.registerTool(
  "github_open_pr",
  {
    title: "Open a pull request",
    description: "Open a PR in a repo. Requires github.write.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string" },   // source branch
        base: { type: "string" },   // target branch
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  async (params) => {
    if (!this.hasScope("github.write")) return this.forbidden();
    try {
      const token = await this.mintToken({
        permissions: { contents: "write", metadata: "read", pull_requests: "write" },
      });
      // POST /repos/{owner}/{repo}/pulls { title, body, head, base, draft: false }
      // Returns PR number + HTML URL
      return { content: [{ type: "text", text: JSON.stringify({ pr_url: "..." }) }] };
    } catch (err) {
      return this.mintError(err);
    }
  },
);
```

**GitHub App permission needed:** `pull_requests: "write"` (in addition to the existing `contents: "write"`). This must be added to the GitHub App's permissions in the GitHub Dashboard and re-installed (the owner grants it at the Phase 4 go-live gate). [ASSUMED — GitHub App permission model verified against training knowledge; the exact permission string "pull_requests" for the REST API `pull_requests: write` permission level is standard GitHub App convention; verify at https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request when implementing.]

**REST calls for portfolio PR flow:**
1. `GET /repos/{owner}/{repo}/git/ref/heads/{base}` → get SHA of base branch
2. `POST /repos/{owner}/{repo}/git/refs` with `{ ref: "refs/heads/add-project/{slug}", sha }` → create branch
3. `PUT /repos/{owner}/{repo}/contents/{path}` → commit file on new branch (existing `github_put_file` tool, extended with `branch` param)
4. `POST /repos/{owner}/{repo}/pulls` with `{ title, body, head: "add-project/{slug}", base: "main" }` → open PR

### Pattern 6: Dual Audit Log Rows (§8)

Every gated action writes exactly two `audit_log` rows:

```typescript
// Row 1 — written at gate open (openGate() in packages/gate)
{
  id: ulid(),
  ts: Date.now(),
  agent: "Usher",           // or "Envoy", "Sundial"
  action: "event.register", // or "brand.publish", "calendar.remove"
  target: "<event-id>",
  scope_used: "calendar.events",  // the scope the approved action WILL exercise
  gated: 1,
  decision: "pending",
  outcome: "pending",
  trust: 100,
  consent_flag: null,
  flag_id: null,
}

// Row 2 — written at gate decision (handleDecision() in apps/gate)
{
  id: ulid(),
  ts: Date.now(),
  agent: "Usher",
  action: "event.register",
  target: "<event-id>",
  scope_used: "calendar.events",
  gated: 1,
  decision: "approved",   // or "rejected" or "expired"
  outcome: "ok",          // or "error" if the post-approval action failed
  trust: 100,
  consent_flag: null,
  flag_id: null,          // set if a flag was raised
}
```

The two rows share the same `target` so the full approval trail is reconstructable by filtering `WHERE target = ? AND gated = 1 ORDER BY ts`.

### Pattern 7: Wire Event Shapes (§6.4)

Usher Wire event (after confirmed registration):
```json
{
  "agent": "Usher",
  "type": "event.registered",
  "entity": "events",
  "op": "increment",
  "payload": {
    "metric": "events-registered",
    "by": 1,
    "event": "<event title>",
    "confirmation": "<confirmation #>"
  },
  "idempotencyKey": "usher:<event-id>:registered"
}
```

Envoy Wire event (after approved targets published):
```json
{
  "agent": "Envoy",
  "type": "brand.project_published",
  "entity": "<project-slug>",
  "op": "increment",
  "payload": {
    "projects_published": 1,
    "posts_shipped": 1,
    "targets": ["linkedin", "github_readme", "x", "portfolio_pr"]
  },
  "idempotencyKey": "envoy:<project-slug>"
}
```

Note: D4-15 revises `envoy:<project-slug>` as the idempotency key (slug alone, not slug+date). A re-run for the same project is a no-op through Steward (`meta.changes === 0`). [CITED: 04-CONTEXT.md D4-15]

### Anti-Patterns to Avoid

- **Do NOT hold a live browser session across the human pause.** The confirmation gate is D1-backed; the daemon re-opens the URL fresh on approval. A headless browser held open for 24h+ will be killed by the OS or disconnect.
- **Do NOT emit Wire events before confirming the action succeeded.** Usher emits `events-registered++` only after the confirmation number is scraped. Envoy emits brand counters only after the target is published. Never emit optimistically.
- **Do NOT add a second `atlas-wire` consumer.** Usher and Envoy are Wire producers only. Steward remains the sole consumer. A second consumer is a hard CI failure (guard-wire-consumer.js hook).
- **Do NOT store credentials in gate_pending, browser_action_outbox, or audit_log.** Form field values in `browser_action_outbox.fields` must contain only filled values (name, email, phone from Codex) — never passwords, session tokens, or 2FA codes.
- **Do NOT use crypto.randomUUID() for idempotency keys.** Keys must be stable: `usher:<event-id>:registered`, `envoy:<project-slug>`, `gate:<ulid>`. Random keys cannot deduplicate replays.
- **Do NOT use `new Date()` for owner-local time.** Use `localDate()` from `@atlas/shared/src/flag.ts` (wraps `Intl.DateTimeFormat('en-CA', {timeZone: 'America/Toronto'})`).
- **Do NOT allow fail-open on error.** Every gate error path (exception in POST /confirm, timeout, malformed token) returns deny + "error → no action taken" response. Never execute a gated action on an error path.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Constant-time token comparison | Custom byte-by-byte string compare | `timingSafeEqual()` from `apps/flagger/src/auth.ts` (copy verbatim) | Timing attacks leak token length; HMAC-SHA-256 approach is already proven in the codebase |
| Browser auth/session management | OAuth flows in the daemon | `launchPersistentContext(userDataDir)` — Playwright native | Sessions are already in the owner's browser profile; any credential storage in Atlas violates §12 |
| Server-rendered confirm page | React/Svelte SPA | Template-literal HTML + `authHtmlResponse()` from `apps/atlas/src/auth/headers.ts` | Proven pattern; no build step; one inline style block; CSP compliant |
| Incident routing | Calling Flagger's ntfy push directly | `flag(env, severity, title, detail, options)` from `@atlas/shared/src/flag.ts` | Routes to `atlas-incidents`; Flagger scores, dedupes, and routes P1/P2 → push; P3/P4 → board |
| Wire event sending | Direct D1 writes | `send(env, event)` from `@atlas/wire` | Size-checked, schema-validated, 128KB cap enforced |
| Idempotency dedup | Custom counter logic | Steward's D1 `INSERT OR IGNORE` + `meta.changes` pattern | The ledger is forever; Steward is the only place that safely does this |

**Key insight:** The most dangerous custom-solution trap is implementing the confirmation gate inline per-agent. Even if the first implementation is correct, drift between Usher, Envoy, and Sundial implementations creates multiple places where a fail-open bug can appear. The shared `packages/gate` primitive is the single enforcement point.

---

## Common Pitfalls

### Pitfall 1: Fail-Open on Gate Error

**What goes wrong:** An exception in the confirm-page POST handler or the gate token verification results in a 500 response that is treated as "retry" by the browser, and the approval fires on the retry.

**Why it happens:** Missing try/catch at the outer handler level; 500 sent before the decision is committed to D1.

**How to avoid:** Write the terminal `audit_log` row and update `gate_pending.status` atomically in a D1 `batch()` BEFORE executing any approved side effect. If the batch fails, return 500 — no action was taken. Never execute the approved action before the D1 commit.

**Warning signs:** A submitted form that triggers the approved action without a corresponding `audit_log` terminal row with `decision='approved'`.

### Pitfall 2: Browser Profile Corruption

**What goes wrong:** The Playwright persistent profile is corrupted by an interrupted write or concurrent access, causing the daemon to fail on startup.

**Why it happens:** Two daemon processes sharing the same userDataDir. Playwright's lockfile prevents this, but a forced kill can leave locks behind.

**How to avoid:** The daemon must run as a single launchd LaunchAgent (exactly one process). Add a startup check: if `lock.db` exists in the profile dir and the daemon just started, remove it (stale lock from forced kill). Never run two instances.

**Warning signs:** Playwright `TargetCloseError` or `ENOENT` on launch; browser refusing to start.

### Pitfall 3: Double-count on Wire Replay

**What goes wrong:** Usher or Envoy emits a Wire event, it's delivered, but the Workflow/invocation retries (queue retry) and emits again. Steward double-counts `events-registered`.

**Why it happens:** Using a non-stable idempotency key (e.g., including a timestamp or random suffix) or emitting before the action is confirmed as successful.

**How to avoid:** Keys must be stable and action-scoped: `usher:<event-id>:registered` (not `usher:<event-id>:registered:<timestamp>`). The already-registered short-circuit checks D1 for this idempotency key before any browser action: `SELECT 1 FROM idempotency_keys WHERE key = 'usher:<event-id>:registered'`. If found, return "already done" with zero side effects.

**Warning signs:** `meta.changes === 0` in the Steward replay test failing (means the key is non-deterministic); dashboard counter incrementing twice for the same event.

### Pitfall 4: LinkedIn/X Selector Brittleness

**What goes wrong:** LinkedIn changes the DOM structure of the experience/project entry form; Envoy's Playwright selectors break silently.

**Why it happens:** LinkedIn has no public write API; the browser form is updated regularly.

**How to avoid:** Use semantic locators (`page.getByLabel("Title")`, `page.getByRole("textbox", {name: "Company"})`) over raw CSS selectors. Store per-platform selector hints as JSON in CONFIG KV (the `usher.platform_selectors` knob) so they can be updated without redeploy. On `page.fill()` timeout (selector not found), abort with D4-13 "keep draft + P2" rather than hard error.

**Warning signs:** `page.fill()` throwing `TimeoutError` (selector not found within 30s default timeout); `page.waitForSelector()` timing out.

### Pitfall 5: Gate Token Timing Attack

**What goes wrong:** The confirm link token comparison uses a naive `===` string equality, leaking token length/content through response timing.

**Why it happens:** Forgetting to use the constant-time comparison helper; writing a new comparison function instead of copying from `apps/flagger/src/auth.ts`.

**How to avoid:** Copy `timingSafeEqual()` from `apps/flagger/src/auth.ts` verbatim into `packages/gate/src/auth.ts`. Store `SHA-256(token)` in D1 (never the plaintext). Compare incoming `SHA-256(submitted_token)` against the stored hash using constant-time comparison.

**Warning signs:** Any code path with `token === storedToken` or `token.includes(storedToken)`.

### Pitfall 6: Confirmation Before Registration Confirmed

**What goes wrong:** Usher sends the Wire `events-registered++` event and adds the Calendar event before verifying the confirmation number was actually scraped.

**Why it happens:** Optimistic counter increment; not checking the scrape result before proceeding.

**How to avoid:** The confirmation number scrape must return a non-empty string before any post-registration write. `if (!confirmationNumber) { flag P2 "no confirmation number after submit"; return; }` — no Calendar add, no Wire event.

**Warning signs:** Dashboard showing `events-registered` incremented but no confirmation email received; Calendar event with empty notes field (no conf #).

### Pitfall 7: Sundial Retrofit Breaking Existing Reconcile Tests

**What goes wrong:** Retrofitting `apps/sundial/src/reconcile.ts`'s `propose-removal` path onto `packages/gate` changes the call signature or async behavior, breaking the existing reconcile tests.

**Why it happens:** The current `reconcile.ts` calls `flag(env, P2, ...)` directly; after retrofit it calls `gate.openGate(env, ...)`. The env type changes.

**How to avoid:** The retrofit is a thin adapter layer. `reconcile.ts` already surfaces `propose-removal` decisions; the retrofit adds a step where the caller (Sundial's main Worker) calls `openGate()` for each proposed removal. The `reconcile()` function itself does not change — it only returns the decisions. The Wire-contract test, replay test, and failure-path test for Sundial must still pass after the retrofit.

---

## Runtime State Inventory

> Phase 4 is greenfield — Usher and Envoy don't exist yet. The only "rename" work is retrofitting Sundial's gated-removal proposal onto `packages/gate`.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | D1 `events` table (0004 migration) has `status` field with values 'discovered', 'relevant', 'registered', 'skipped' — Usher will write 'registered'. No prior data conflicts. | Code edit only (Usher writes this field on success) |
| Live service config | No go-live config knobs set yet for Phase 4 (gates.default, usher.captcha, etc.) | Seed CONFIG KV at go-live: `gates.default=draft+ask`, `gates.timeout_usher_ms=86400000`, `gates.timeout_envoy_ms=604800000`, `usher.captcha=hand-to-owner`, `usher.payment=manual`, `envoy.publish=gated`, `gate.confirm_base_url=<gate-worker-url>`, `envoy.portfolio_repo=<owner/name>`, `envoy.portfolio_path=<path>`, `envoy.profile_repo=<owner/owner>` |
| OS-registered state | Browser profile at `~/.atlas/browser-profile` (new at Phase 4 go-live, not a rename) | Owner creates Chromium profile, logs into LinkedIn/X/Meetup/Eventbrite once, path seeded to daemon env |
| Secrets/env vars | New secrets needed: `GATE_CONFIRM_TOKEN` (the bearer token for the /confirm POST, analogous to `ATLAS_BRIDGE_TOKEN`), `NTFY_TOPIC`/`NTFY_TOKEN`/`ACK_TOKEN` already exist in Flagger | Seed in Secrets Store; add `ATLAS_BROWSER_PROFILE` to daemon environment |
| Build artifacts | `apps/usher/`, `apps/envoy/`, `apps/gate/`, `packages/gate/` are all new (greenfield) | No stale artifacts; fresh scaffold |
| mcp-github | New `pull_requests: write` GitHub App permission needed | Owner re-installs GitHub App with updated permissions at Phase 4 go-live |

**Note on Sundial retrofit:** `apps/sundial/src/reconcile.ts` does not change its exported interface. The retrofit happens in the Sundial Worker's main loop where it calls `gate.openGate()` for `propose-removal` decisions instead of only emitting a flag. The existing `flag()` call remains (the P2 flag is still emitted).

---

## Code Examples

### Already-registered short-circuit (Usher)

```typescript
// Source: idempotency pattern from packages/steward-core/src/apply.ts
// apps/usher/src/index.ts

const idem = `usher:${eventId}:registered`;

// Short-circuit: check if this event is already registered in D1
const existing = await env.DB.prepare(
  "SELECT 1 FROM idempotency_keys WHERE key = ?"
).bind(idem).first();

if (existing) {
  // Already registered — no-op (idempotent replay)
  return new Response(JSON.stringify({ status: "already_registered" }), { status: 200 });
}
```

### Envoy Wire event with idempotency (project slug only)

```typescript
// Source: packages/wire/src/send.ts + 04-CONTEXT.md D4-15
// apps/envoy/src/index.ts

import { send } from "@atlas/wire";

const projectSlug = slugify(projectName); // e.g. "atlas"
const idem = `envoy:${projectSlug}`;      // stable; re-run = no-op per D4-15

await send(env, {
  agent: "Envoy",
  type: "brand.project_published",
  entity: projectSlug,
  op: "increment",
  payload: {
    projects_published: 1,
    posts_shipped: approvedBrowserTargets.length,
    targets: approvedTargets,
  },
  idempotencyKey: idem,
});
```

### Expiry sweep (apps/gate scheduled())

```typescript
// Source: docs/11-security-privacy.md §2.2 + §8 pattern
// apps/gate/src/index.ts scheduled() handler

const expired = await env.DB.prepare(
  "SELECT id, agent, action, target, idempotency_key FROM gate_pending WHERE status = 'pending' AND expires_at < ?"
).bind(Date.now()).all<{ id: string; agent: string; action: string; target: string; idempotency_key: string }>();

for (const row of expired.results) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE gate_pending SET status = 'expired', decision = 'expired', updated_at = ? WHERE id = ?"
    ).bind(Date.now(), row.id),
    env.DB.prepare(
      "INSERT INTO audit_log (id, ts, agent, action, target, scope_used, gated, decision, outcome, trust, consent_flag, flag_id) VALUES (?, ?, ?, ?, ?, '', 1, 'expired', 'ok', 100, NULL, NULL)"
    ).bind(ulid(), Date.now(), row.agent, row.action, row.target),
  ]);

  await flag(env, "P3", `gate expired without decision: ${row.action} for ${row.target}`, undefined, {
    sourceAgent: row.agent,
    kind: "gate_expired",
  });
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `step.waitForEvent` for human confirmation gates | D1 `gate_pending` row + cron sweep (D4-02) | Phase 4 decision | Avoids Free plan 3-day Workflow state retention limit; survives restarts; no live browser held across wait |
| Cloud headless browser (Cloudflare Browser Rendering) | Local Playwright against owner's persistent profile | Phase 4 decision (D4-05) | No credential storage; no bot-detection from datacenter IPs; owner can click the final Post for irreversible actions |
| Per-agent inline gate logic | Shared `packages/gate` primitive (D4-04) | Phase 4 decision | One place to audit fail-safe; Sundial, Usher, Envoy all use it |
| `registerTool()` vs `server.tool()` | Both work in MCP SDK 1.29.0; **prefer `registerTool()`** (v2-forward path) | Already established in Phase 0 | No change needed; existing pattern in mcp-github is `server.registerTool()` which is correct |
| Playwright v1.x older API | Playwright 1.60.0 with `launchPersistentContext` | June 2026 (verified) | Stable persistent-profile API; auto-wait semantics reduce selector timing bugs |

**Deprecated/outdated (from build plan notes to correct):**
- `step.waitForEvent` confirmation gate: The build plan §4 mentions this as the "GA primitive." This is **superseded by D4-02** (D1 pending row + cron sweep) because the Free plan 3-day Workflow retention would expire before a 7d Envoy gate. Do NOT implement using `step.waitForEvent` for Phase 4 gates.
- `Usher Durable Object (session hold)`: The build plan §4 mentions this. This is **superseded by D4-02** — no session is held open across the human pause; the daemon re-opens the page fresh on approval. Do NOT add a Usher DO for session holding.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest + `@cloudflare/vitest-pool-workers` (existing) |
| Config file | `vitest.workspace.ts` (existing, auto-discovers per-app configs) |
| Quick run command | `pnpm test --filter @atlas/gate` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OUTWARD-01 | Usher Wire event shape + structured key `usher:<event-id>:registered` | unit | `pnpm test --filter apps/usher` | ❌ Wave 0 |
| OUTWARD-01 | Replay through Steward leaves `meta.changes===0` | unit | `pnpm test --filter apps/usher -- --grep replay` | ❌ Wave 0 |
| OUTWARD-01 | Captcha hard-stop → P3 flag, zero side effects | unit | `pnpm test --filter apps/usher -- --grep captcha` | ❌ Wave 0 |
| OUTWARD-01 | Payment hard-stop → P2 flag, zero side effects | unit | `pnpm test --filter apps/usher -- --grep payment` | ❌ Wave 0 |
| OUTWARD-01 | Gate fail-safe: timeout → expired, no Calendar add | unit | `pnpm test --filter @atlas/gate -- --grep expire` | ❌ Wave 0 |
| OUTWARD-01 | Gate fail-safe: error → deny (no fail-open) | unit | `pnpm test --filter @atlas/gate -- --grep fail-closed` | ❌ Wave 0 |
| OUTWARD-01 | Submit-without-confirmation → P1 self-flag | unit | `pnpm test --filter apps/usher -- --grep p1-self-flag` | ❌ Wave 0 |
| OUTWARD-01 | Already-registered short-circuit (idempotency key exists) | unit | `pnpm test --filter apps/usher -- --grep already-registered` | ❌ Wave 0 |
| OUTWARD-02 | Envoy Wire event shape + structured key `envoy:<project-slug>` | unit | `pnpm test --filter apps/envoy` | ❌ Wave 0 |
| OUTWARD-02 | Replay through Steward leaves `meta.changes===0` | unit | `pnpm test --filter apps/envoy -- --grep replay` | ❌ Wave 0 |
| OUTWARD-02 | Partial fan-out → P2 flag, exact succeeded targets reported | unit | `pnpm test --filter apps/envoy -- --grep partial-fanout` | ❌ Wave 0 |
| OUTWARD-02 | Browser block (LinkedIn/X) → abort target, keep draft, P2 | unit | `pnpm test --filter apps/envoy -- --grep dom-block` | ❌ Wave 0 |
| OUTWARD-02 | Per-target approve/skip: approved subset only published | unit | `pnpm test --filter apps/envoy -- --grep per-target` | ❌ Wave 0 |
| OUTWARD-01 + 02 | Dual audit_log rows per gated action (pending + terminal) | unit | `pnpm test --filter @atlas/gate -- --grep audit-log` | ❌ Wave 0 |
| OUTWARD-01 + 02 | Sundial retrofit: propose-removal calls gate.openGate() | unit | `pnpm test --filter apps/sundial -- --grep gate-retrofit` | ❌ Wave 0 |
| OUTWARD-01 + 02 | Pillar 1: no second atlas-wire consumer (CI guard) | integration | hook `guard-wire-consumer.js` (existing) | ✅ |
| OUTWARD-01 + 02 | Security: no 2FA codes/reset links in confirm page or push body | unit | `pnpm test --filter @atlas/gate -- --grep security` | ❌ Wave 0 |

**Observable signals for gate adherence = 100% (not automatable in unit tests):**
- Every outward action in `audit_log` has `gated=1` and `decision IN ('approved','rejected','expired')` — no `decision='auto'` for Usher/Envoy rows.
- Every `gate_pending` row with `status='done'` has a matching `audit_log` terminal row.
- No `browser_action_outbox` row with `status='done'` where the associated `gate_pending.status != 'approved'`.

### Sampling Rate

- **Per task commit:** `pnpm test --filter @atlas/gate && pnpm test --filter apps/usher && pnpm test --filter apps/envoy`
- **Per wave merge:** `pnpm test` (full 515+ test suite)
- **Phase gate:** Full suite green + Sundial tests still pass (retrofit regression) before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `packages/gate/src/index.test.ts` — gate schema, openGate(), decideGate(), sweepExpired()
- [ ] `packages/gate/src/auth.test.ts` — timingSafeEqual constant-time property
- [ ] `packages/gate/src/render.test.ts` — renderConfirmPage() security headers, no-2FA-code invariant
- [ ] `apps/gate/src/index.test.ts` — GET /confirm renders correctly; POST /confirm approve/reject; fail-closed on error; expired gate returns 410
- [ ] `apps/usher/src/index.test.ts` — Wire contract, replay, failure paths (captcha/payment/sold-out/P1)
- [ ] `apps/envoy/src/index.test.ts` — Wire contract, replay, partial fan-out, per-target approve/skip
- [ ] `apps/sundial/src/reconcile.test.ts` — add gate retrofit test (existing tests must still pass)
- [ ] `migrations/0007_gate.sql` — applied via `applyD1Migrations` in test setup (pattern from 0001–0006)

*(Daemon browser-runner tests are `swift test` or Node.js unit tests against mock pages — no workerd needed for Playwright logic)*

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes — gate token authentication | Constant-time HMAC-SHA-256 (`timingSafeEqual()` from flagger/auth.ts); fail-closed on missing binding |
| V3 Session Management | Yes — gate_pending row + short-lived token | Token single-use-by-design (status → approved/rejected after first decision); expires_at enforced by cron sweep |
| V4 Access Control | Yes — scope floor on mcp-github PR tool | `hasScope("github.write")` check at every tool entry point; 403 on missing scope (existing pattern) |
| V5 Input Validation | Yes — gate token, form decision, browser action fields | zod schema on GatePending; `decision` must be exactly `"approve"` or `"reject"`; no other value executes action |
| V6 Cryptography | Yes — token storage | SHA-256 stored (never plaintext); constant-time comparison; no MD5/SHA-1 |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Fail-open on gate error | Tampering | D1 batch commits decision BEFORE executing side effect; 5xx response = "no action taken" |
| Token replay (confirm link reuse) | Tampering | `gate_pending.status` transitions to `approved`/`rejected` atomically; a second POST with the same token finds `status != 'pending'` → 400 |
| CSRF on confirm POST | Tampering | `isSameOrigin(request)` check (per consent.ts pattern); `Referrer-Policy: no-referrer` header; `SameSite=Strict` if confirm link opens in same origin |
| 2FA code / reset link in confirm page or push | Information Disclosure | `redact()` from `@atlas/security` on artifact content before ntfy push; gate Worker never exposes email body content — only the agent-drafted artifact (post text / form values) |
| Credential storage in browser_action_outbox.fields | Information Disclosure | `fields` contains only form fill values from Codex (name, email, phone); never a password, session token, or 2FA code; `redact()` applied before writing |
| Bot detection on Playwright | Tampering | `launchPersistentContext` uses owner's real profile/IP; `headless: false`; `slowMo: 50`; no captcha solving |
| Double-emit on Wire retry | Tampering | Stable idempotency key (`usher:<event-id>:registered`); already-registered short-circuit; Steward `INSERT OR IGNORE` dedup |
| mcp-github token leaking to MCP client | Information Disclosure | `installationToken()` result consumed server-side only; `mintToken()` private method; token never returned in tool result (existing pattern, T-00-32) |
| Submit-without-confirmation bug | Tampering | Self-flag P1 (`usher:registration_attempted_without_confirmation`) if any browser submit occurs without a corresponding `gate_pending.status='approved'` row; `browser_action_outbox` rows are only written by the gate approval path |

---

## Open Questions (RESOLVED)

1. **Browser profile initial setup**
   - What we know: `launchPersistentContext(userDataDir)` uses a Chromium profile; the owner logs in manually on first use.
   - What's unclear: Whether the daemon should manage profile creation automatically or the owner is guided through it as a go-live gate (similar to OAuth round-trip gates).
   - Recommendation: Treat browser profile seed as a go-live gate (same pattern as Secrets Store seed). The plan should include a "ATLAS_BROWSER_PROFILE: owner logs into LinkedIn/X/Meetup/Eventbrite once" go-live checklist item.
   - **RESOLVED:** go-live gate. Plan 04-04 (`autonomous: false`) carries the Playwright/profile owner-setup checkpoint alongside the existing Secrets Store / OAuth go-live gates.

2. **Gate Worker co-location**
   - What we know: D4-01 requires a token-gated confirm page; the gate Worker serves GET + POST /confirm and the scheduled sweep.
   - What's unclear: Whether to add the expiry cron to the gate Worker's `wrangler.jsonc` (adding a cron to a Worker that also handles fetch) or to a thin separate cron Worker.
   - Recommendation: Add the expiry `scheduled()` to `apps/gate/src/index.ts` — it already has D1 + INCIDENTS bindings needed for the sweep. One Worker, two handlers. This is exactly the Flagger pattern (`queue()` + `fetch()` + `scheduled()` in one Worker).
   - **RESOLVED:** single `apps/gate` Worker with `fetch` + `scheduled` (Flagger pattern). Plan 04-03 implements both handlers in one Worker.

3. **Confirm page token URL length**
   - What we know: The confirm link carries the plaintext token as a query param (`?t=<token>`). Tokens should be long enough to be unguessable (≥32 bytes random hex = 64 chars).
   - What's unclear: ntfy push body URL length limits (ntfy allows long URLs in action button URLs; not a concern).
   - Recommendation: Use `crypto.randomBytes(32).toString('hex')` (64-char hex); store `SHA-256(token)` in D1. No length concern.
   - **RESOLVED:** 64-char hex plaintext token in the link; `SHA-256(token)` stored as `gate_pending.token_hash` in D1 (plaintext never persisted). Plan 04-01 implements this.

4. **Envoy partial fan-out state**
   - What we know: D4-12 ships all four targets; Envoy reports exactly which targets succeeded (from envoy.md failure modes).
   - What's unclear: Whether the gate_pending.artifact stores all four drafts as one JSON blob or whether there are four separate gate rows (one per target).
   - Recommendation: One gate row per Envoy invocation with a JSON `artifact` containing all four drafts. The confirm page renders all four as cards (per UI-SPEC.md). Per-target approve/skip is tracked via hidden checkbox inputs in the form POST body (per UI-SPEC.md). The gate row's `edited_artifact` field stores the owner's edits as a JSON patch. This keeps the single-gate-row-per-action model clean.
   - **RESOLVED:** one gate row per Envoy invocation, all four drafts in the `artifact` JSON; per-target approve/skip via hidden checkbox inputs. Plan 04-07 implements the single-row model.

5. **GitHub App `pull_requests` permission string** *(added during planning)*
   - What's unclear: The exact GitHub App permission key for opening PRs (`pull_requests: "write"`) was [ASSUMED] from the REST docs, not verified against a live App manifest.
   - **RESOLVED (deferred to a checkpoint):** Plan 04-02 is `autonomous: false` and carries an owner checkpoint to verify the `pull_requests: "write"` grant when re-installing the GitHub App at go-live, before the new mcp-github tools are exercised live.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Cloudflare D1 (atlas-db) | gate_pending + browser_action_outbox tables | ✓ | existing | — |
| Cloudflare Queues (atlas-wire, atlas-incidents) | Usher/Envoy Wire events + flag() | ✓ | existing | — |
| Cloudflare KV (CONFIG) | Gate config knobs (gates.default, timeouts, etc.) | ✓ | existing | — |
| Secrets Store | GATE_CONFIRM_TOKEN binding | ✓ | existing (atlas-store-id) | — |
| ntfy.sh push | Gate → Flagger push path (already wired in Phase 2) | ✓ | existing (Flagger) | Board fallback (flag lands via Steward) |
| mcp-google (calendar.events) | Usher Calendar add | ✓ | existing (Phase 0/1) | — |
| mcp-github (contents:write) | Envoy README + portfolio PR | ✓ | existing (Phase 0) — **needs pull_requests:write added** | — |
| GitHub App (pull_requests:write permission) | mcp-github create-PR tool | ✗ currently | — | Owner re-installs GitHub App at Phase 4 go-live gate |
| Playwright (local daemon) | Browser automation | ✗ in daemon currently | 1.60.0 | No fallback — must install in daemon/ workspace |
| Local Chromium browser profile | Playwright persistent sessions | ✗ currently | — | Owner creates profile at Phase 4 go-live gate |
| packages/codex | Usher form fill + Envoy copy | ✓ | existing (Phase 0) | — |

**Missing dependencies with no fallback:**
- Playwright + Chromium in the daemon workspace (must install before Phase 4 go-live)
- Local browser profile seeded with owner's sessions (go-live gate)

**Missing dependencies with fallback:**
- GitHub App `pull_requests:write` permission: without it, the `github_open_pr` tool will fail with a 403; Envoy reports "portfolio PR" target failed (P3); LinkedIn/X/README targets still work. This is a go-live gate, not a hard blocker for testing the cloud Workers.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | GitHub App permission string for PR creation is `pull_requests: "write"` (in the installationToken permissions object) | Code Examples / Pattern 5 | mcp-github `github_open_pr` tool returns 403; owner must re-install GitHub App with correct permission name |
| A2 | LinkedIn experience/project form uses stable ARIA labels accessible to Playwright's `getByLabel()` / `getByRole()` — these are the fallback selectors if CSS class names change | Common Pitfalls / Pitfall 4 | Envoy LinkedIn target breaks on next LinkedIn layout update; mitigated by CONFIG KV selector hints |
| A3 | X (Twitter) composer is accessible to Playwright without triggering bot-detection when using the owner's persistent Chromium profile | Architecture Patterns / Pattern 4 | Envoy X target fails; owner reports manually; flag P2 "browser block" per D4-08 abort path |
| A4 | The ntfy "Review & edit" action button URL (the confirm link) survives the full URL including the token query param without truncation | Open Questions #3 | Push notification link is broken; owner cannot open the confirm page from the notification; fallback is to open the confirm page manually at the known URL |

**If this table is empty:** Not applicable — four assumptions remain unverified by authoritative source in this session.

---

## Sources

### Primary (HIGH confidence)

- `apps/flagger/src/push.ts` + `apps/flagger/src/index.ts` — verified push payload shape, HTTP action buttons, constant-time `timingSafeEqual()`, `/ack` route pattern
- `apps/flagger/src/auth.ts` — HMAC-SHA-256 constant-time equality implementation (copy target)
- `apps/sundial/src/reconcile.ts` — verified `propose-removal` action type and `flag()` call signature for retrofit
- `apps/atlas/src/auth/consent.ts` + `apps/atlas/src/auth/headers.ts` — verified `authHtmlResponse()`, `AUTH_SECURITY_HEADERS`, `isSameOrigin()`, template-literal HTML pattern
- `apps/mcp-github/src/index.ts` — verified `McpAgent`, `server.registerTool()`, `hasScope()`, `mintToken()`, `mintError()` pattern for new PR tools
- `daemon/src/drain.ts` — verified `DrainIntent` schema, `pollOnce`, `ackIntent`, `drainOnce` function signatures for browser-action transport reuse
- `migrations/0001_init_core.sql` through `0006_meetings.sql` — verified migration numbering convention (0007 is next), positional `?` params, D1 schema patterns, INDEX naming
- `packages/shared/src/flag.ts` — verified `flag()` signature, `contentHash()`, `localDate()`, `FlagRecord` type
- `packages/wire/src/send.ts` — verified `send()` function signature
- Context7 `/microsoft/playwright` — verified `launchPersistentContext(userDataDir)` API signature and `page.fill()` semantics [VERIFIED: Context7]
- `docs/SPEC-CANON.md` §2/§3/§4/§6.1/§6.4/§11/§12 — verified pillar constraints, counter names, Wire event shape, Codex field sections
- `docs/11-security-privacy.md` §2/§3/§5/§7/§8/§9 — verified gate mechanics, dual audit_log rows, scope table, `audit_log` column names
- `docs/agents/usher.md` — verified Wire event shape, idempotency key format, failure-mode → Flagger severity table
- `docs/agents/envoy.md` — verified per-platform formatting, Wire event shape, partial fan-out handling
- `04-CONTEXT.md` D4-00..D4-15 — authoritative decisions; all locked choices verified against canonical refs

### Secondary (MEDIUM confidence)

- `npm view playwright version` → 1.60.0 published 2026-06-06 [VERIFIED: npm registry]
- `npm view agents version` → 0.14.3 published 2026-06-05 [VERIFIED: npm registry]
- `npm view @modelcontextprotocol/sdk version` → 1.29.0 [VERIFIED: npm registry]
- `slopcheck install playwright` → [OK] [VERIFIED: slopcheck 0.6.1]

### Tertiary (LOW confidence — [ASSUMED])

- GitHub App permission name `pull_requests: "write"` for REST API PR creation scope (A1 above)
- LinkedIn/X Playwright selector stability (A2, A3 above)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified via npm registry and Context7
- Architecture: HIGH — derived from verified codebase code reading (drain.ts, consent.ts, reconcile.ts, mcp-github/index.ts) + locked decisions D4-00..D4-15
- gate_pending schema: HIGH — derived from existing migration patterns (0001–0006) + §8 audit_log shape + security doc §2.2
- browser driver choice: HIGH — Context7-verified launchPersistentContext API; rationale forced by §12 no-credential-storage invariant
- mcp-github PR tool: MEDIUM — tool registration pattern HIGH (verified in codebase); GitHub REST API PR endpoint ASSUMED for exact permission string
- Pitfalls: HIGH — derived from existing codebase patterns (serialize.test.ts, auth.ts, reconcile.ts) + CLAUDE.md gotchas

**Research date:** 2026-06-06
**Valid until:** 2026-07-06 (stable stack; Playwright and agents SDK ship ~weekly — re-verify versions before install)
