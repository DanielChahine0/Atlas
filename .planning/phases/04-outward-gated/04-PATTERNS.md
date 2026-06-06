# Phase 4: Outward (Gated) - Pattern Map

**Mapped:** 2026-06-06
**Files analyzed:** 12 (new/modified files across packages, apps, daemon, migrations)
**Analogs found:** 12 / 12

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/gate/src/auth.ts` | utility | request-response | `apps/flagger/src/auth.ts` | exact |
| `packages/gate/src/push.ts` | utility | event-driven | `apps/flagger/src/push.ts` | exact |
| `packages/gate/src/render.ts` | utility | request-response | `apps/atlas/src/auth/consent.ts` | exact |
| `packages/gate/src/index.ts` | utility | CRUD | `apps/sundial/src/reconcile.ts` + `apps/atlas/src/auth/consent.ts` | role-match |
| `apps/gate/src/index.ts` | Worker (fetch + scheduled) | request-response | `apps/flagger/src/index.ts` | exact |
| `apps/usher/src/index.ts` | WorkerEntrypoint | request-response | `apps/headhunter/src/index.ts` | exact |
| `apps/envoy/src/index.ts` | WorkerEntrypoint | event-driven | `apps/headhunter/src/index.ts` | exact |
| `apps/mcp-github/src/index.ts` | MCP tool (MODIFY) | request-response | `apps/mcp-github/src/index.ts` | self (extend) |
| `apps/sundial/src/reconcile.ts` | utility (RETROFIT) | CRUD | `apps/sundial/src/reconcile.ts` | self (retrofit) |
| `migrations/0007_gate.sql` | migration | CRUD | `migrations/0004_incidents_flagger.sql` | exact |
| `daemon/src/browser-drain.ts` | daemon drain loop | event-driven | `daemon/src/drain.ts` | exact |
| `daemon/src/browser-runner.ts` | daemon executor | event-driven | `daemon/src/drain.ts` (drainOnce deps) | role-match |

---

## Pattern Assignments

### `packages/gate/src/auth.ts` (utility, request-response)

**Analog:** `apps/flagger/src/auth.ts`

Copy verbatim — the HMAC-SHA-256 constant-time equality is the project's canonical Workers
implementation. `crypto.timingSafeEqual` is not available in Workers; this HMAC approach is
the proven substitute.

**Full file to copy** (`apps/flagger/src/auth.ts`, lines 1–33):
```typescript
/**
 * Length-independent constant-time string equality. HMAC-SHA-256 both inputs under a
 * fresh random key and compare the 32-byte digests. Content- and length-independent
 * (the digest is fixed-size and not precomputable). Fail-closed: returns false on any error.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const da = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}
```

Additionally, `packages/gate/src/auth.ts` must export `sha256(token: string): Promise<string>`
for token-hash storage in D1. Pattern:
```typescript
export async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
```

**Binding/secret the gate token check uses:** `env.GATE_CONFIRM_TOKEN` (Secrets Store async
binding, same shape as `env.ACK_TOKEN` in Flagger). Never log the token value.

---

### `packages/gate/src/push.ts` (utility, event-driven)

**Analog:** `apps/flagger/src/push.ts`

The gate push extends Flagger's push: same ntfy.sh endpoint, same HTTP-action-button shape,
same `redact()` guard on the title before external egress, same non-fatal error handling.

**Imports pattern** (`apps/flagger/src/push.ts`, lines 14–17):
```typescript
import type { FlagRecord } from "@atlas/shared";
import { redact } from "@atlas/security";
import type { Env } from "./index.js";
```

**Core push pattern** (`apps/flagger/src/push.ts`, lines 38–73):
```typescript
const payload = {
  topic,
  title: `[${flag.severity}] ${flag.source_agent}`,
  message: safeTitle,
  priority: flag.severity === "P1" ? 5 : 4,
  actions: ackToken
    ? [
        {
          action: "http",
          label: "Ack",
          url: ackUrl,
          method: "POST",
          headers: { Authorization: `Bearer ${ackToken}` },
          body: JSON.stringify({ id: flag.id }),
          clear: true,
        },
      ]
    : [],
};
```

**Gate-specific extension:** Replace `ackToken` action with a "Review & edit" action pointing
to the confirm page URL (a `view` action, not `http` — no inline approve for irreversible
actions per D4-01/UI-SPEC). The confirm page URL carries the plaintext token as `?t=<hex>`.

```typescript
// gate push action — replaces the Ack http action:
{
  action: "view",
  label: "Review & edit",
  url: `${confirmBaseUrl}/confirm?t=${plaintextToken}`,
  clear: false,   // don't dismiss the push — the owner may want to come back
}
```

**Secret bindings required (from wrangler.jsonc):**
- `NTFY_TOPIC`, `NTFY_TOKEN` — same as Flagger (Secrets Store async bindings)
- `GATE_CONFIRM_TOKEN` — the Bearer token for the POST /confirm endpoint
- `GATE_BASE_URL` — the confirm page base URL (from `[vars]`, NOT secrets)

**Non-fatal error handling pattern** (`apps/flagger/src/push.ts`, lines 71–75):
```typescript
if (!resp.ok) {
  console.error("flagger: ntfy push failed", resp.status, await resp.text().catch(() => ""));
  // Non-fatal — caller catches; board fallback (D2-03)
}
```

---

### `packages/gate/src/render.ts` (utility, request-response)

**Analog:** `apps/atlas/src/auth/consent.ts` (template-literal HTML pattern)

**HTML helpers to import** (`apps/atlas/src/auth/headers.ts`, lines 36–45):
```typescript
import { authHtmlResponse, authResponse } from "./headers.js";
// authHtmlResponse(html: string, init?) sets content-type + AUTH_SECURITY_HEADERS
// AUTH_SECURITY_HEADERS:
//   "content-security-policy": "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'"
//   "x-frame-options": "DENY"
//   "referrer-policy": "no-referrer"
//   "cache-control": "no-store"
```

**HTML escape helper pattern** (`apps/atlas/src/auth/consent.ts`, lines 67–73):
```typescript
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

**Template-literal HTML function pattern** (`apps/atlas/src/auth/consent.ts`, lines 76–86):
```typescript
function renderLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Atlas — owner login</title></head>
<body>
  <h1>Atlas owner login</h1>
  <form method="POST" action="/login">
    ...
  </form>
</body></html>`;
}
```

**isSameOrigin check** (`apps/atlas/src/auth/consent.ts`, lines 109–119):
```typescript
function isSameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) return secFetchSite === "same-origin";
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  return false;  // fail-closed
}
```

**Confirm page must export:** `renderConfirmPage(row: GatePendingRow): string`,
`renderOutcomePage(decision: string): string`, `renderExpiredPage(): string`.
Each calls `authHtmlResponse()` from `packages/gate/src/render.ts` re-exporting the
`authHtmlResponse` and `authResponse` helpers (or packages/gate re-exports them from a local
copy of headers.ts — same pattern as apps/atlas).

**UI-SPEC colors to hardcode in the inline `<style>` block:**
- Approve button: `background: #1D4ED8; color: #fff; min-height: 44px; width: 100%; border-radius: 6px; font-weight: 600;`
- Reject button: `background: #fff; border: 1.5px solid #B91C1C; color: #B91C1C; min-height: 44px; width: 100%;`
- Artifact zone: `background: #F3F4F6; font-family: monospace; font-size: 14px; white-space: pre-wrap; overflow-x: auto;`

---

### `packages/gate/src/index.ts` (utility/library, CRUD)

**Analogs:** `apps/sundial/src/reconcile.ts` (exported pure functions + injected env), `apps/atlas/src/auth/consent.ts` (D1 batch + single-use record pattern)

This is the shared primitive that callers (`apps/gate`, Usher, Envoy, Sundial) import.

**Exported function shape pattern** (`apps/sundial/src/reconcile.ts`, lines 62–66):
```typescript
export async function reconcile(
  env: { INCIDENTS: Queue<RawIncident> },
  tasks: TaskRow[],
  tools: CalendarTools,
): Promise<ReconcileResult> {
```

**Gate env surface** (must inject, not import from any single Worker's Env):
```typescript
export async function openGate(
  env: { DB: D1Database; INCIDENTS: Queue<RawIncident>; WIRE?: Queue<unknown> },
  opts: GateOptions,
): Promise<GateRecord> { ... }
```

**D1 single-use / atomic pattern** (`apps/atlas/src/auth/consent.ts`, lines 207–211):
```typescript
// Load + DELETE the server-side consent record (single-use). Unknown/expired → 400.
const kvKey = `${CONSENT_KEY_PREFIX}${consentId}`;
const raw = await env.OAUTH_KV.get(kvKey);
if (raw === null) return authResponse("Bad Request: consent expired or unknown", { status: 400 });
// Single-use: delete BEFORE acting so a replay of the same consent_id fails.
await env.OAUTH_KV.delete(kvKey);
```

**Gate equivalent — D1 batch for atomic decision** (derived from RESEARCH.md Pattern 6 +
`apps/atlas/src/auth/consent.ts` single-use pattern):
```typescript
// Write terminal audit_log row + update gate_pending status atomically BEFORE any side effect.
// If the batch fails, return 500 — no action was taken.
await env.DB.batch([
  env.DB.prepare(
    "UPDATE gate_pending SET status = ?, decision = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
  ).bind(decision, decision, Date.now(), row.id),
  env.DB.prepare(
    "INSERT INTO audit_log (id, ts, agent, action, target, scope_used, gated, decision, outcome, trust, consent_flag, flag_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'ok', 100, NULL, NULL)"
  ).bind(ulid(), Date.now(), row.agent, row.action, row.target, row.scope_used, decision),
]);
// THEN (and only then) execute the approved side effect.
```

**Idempotency keys (must be exact strings):**
- Usher gate: `usher:<event-id>:registered`
- Envoy gate: `envoy:<project-slug>`
- Sundial gate: `sundial:remove:<eventId>` (proposed naming)
- Gate itself: no idempotency key on the gate row — the `idempotency_key` column in
  `gate_pending` is the CALLER's key (deduplicated by UNIQUE constraint)

**flag() call for sweep expiry** (`apps/shared/src/flag.ts`, lines 93–112 shape):
```typescript
await flag(env, "P3", `gate expired without decision: ${row.action} for ${row.target}`, undefined, {
  sourceAgent: row.agent,
  kind: "gate_expired",
});
```

---

### `apps/gate/src/index.ts` (Worker, request-response + scheduled)

**Analog:** `apps/flagger/src/index.ts`

This is the confirm-page Worker with `fetch()` (GET + POST /confirm) and `scheduled()`
(expiry sweep). Mirrors Flagger's dual-handler shape exactly.

**Imports pattern** (`apps/flagger/src/index.ts`, lines 12–23):
```typescript
import { RawIncidentSchema } from "@atlas/shared";
import type { RawIncident, FlagRecord } from "@atlas/shared";
import { send } from "@atlas/wire";
import { redact } from "@atlas/security";
// Gate equivalent:
import { authHtmlResponse, authResponse } from "../../packages/gate/src/render.js";
import { timingSafeEqual, sha256 } from "../../packages/gate/src/auth.js";
import { sweepExpired } from "../../packages/gate/src/index.js";
```

**satisfies ExportedHandler pattern** (`apps/flagger/src/index.ts`, lines 95–226):
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ack" && request.method === "POST") {
      const token = await env.ACK_TOKEN?.get();
      if (!token) return new Response("Unauthorized", { status: 401 });
      const auth = request.headers.get("Authorization") ?? "";
      if (!(await timingSafeEqual(auth, `Bearer ${token}`))) {
        return new Response("Unauthorized", { status: 401 });
      }
      // ... validate body, act
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await env.CONFIG.put("flagger:last_seen", String(Date.now())).catch(() => {});
  },
} satisfies ExportedHandler<Env>;
```

**Gate Worker fetch handler structure** (derived from RESEARCH.md Pattern 2 + consent.ts):
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/confirm") {
      const token = url.searchParams.get("t");
      if (!token) return authResponse("Bad Request", { status: 400 });
      const tokenHash = await sha256(token);
      const row = await env.DB.prepare(
        "SELECT * FROM gate_pending WHERE token_hash = ? AND status = 'pending'"
      ).bind(tokenHash).first<GatePendingRow>();
      if (!row || Date.now() > row.expires_at) {
        return authHtmlResponse(renderExpiredPage(), { status: 410 });
      }
      if (request.method === "GET") return authHtmlResponse(renderConfirmPage(row));
      if (request.method === "POST") {
        if (!isSameOrigin(request)) return authResponse("Forbidden", { status: 403 });
        // ... parse form, validate decision, atomic D1 batch, then side effect
        return authHtmlResponse(renderOutcomePage(decision));
      }
      return authResponse("Method Not Allowed", { status: 405 });
    }
    // Browser-action poll/ack endpoints also served here (see browser-drain.ts)
    return authResponse("Not found", { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await sweepExpired(env);
  },
} satisfies ExportedHandler<Env>;
```

**Env bindings required in wrangler.jsonc:**
```
DB          — D1 (atlas-db)
WIRE        — Queue producer (atlas-wire)
INCIDENTS   — Queue producer (atlas-incidents)
CONFIG      — KV (CONFIG)
GATE_CONFIRM_TOKEN — Secrets Store binding
NTFY_TOPIC, NTFY_TOKEN — Secrets Store bindings
USHER, ENVOY, SUNDIAL — service bindings (for re-invoke on approval)
```

---

### `apps/usher/src/index.ts` (WorkerEntrypoint, request-response)

**Analog:** `apps/headhunter/src/index.ts`

Usher is an on-demand `WorkerEntrypoint` invoked by Atlas via service binding — exactly the
Headhunter shape. No own cron, no queue consumer.

**WorkerEntrypoint pattern** (`apps/headhunter/src/index.ts`, lines 345–388):
```typescript
import { WorkerEntrypoint } from "cloudflare:workers";
import { send } from "@atlas/wire";
import { flag, localDate } from "@atlas/shared";
import type { Env as SharedEnv, RawIncident } from "@atlas/shared";

export class Headhunter extends WorkerEntrypoint<Env> {
  async full(params?: { date?: string; windows?: WindowRow[] }): Promise<FullResult> {
    const date = params?.date ?? localDate(this.env);
    try {
      return await runFull(this.env, date, params?.windows);
    } catch (err) {
      await flag(this.env, "P2", `Headhunter full() failed: ${date}`, String(err), {
        sourceAgent: "Headhunter",
        kind: "headhunter_failed",
        runId: date,
      });
      throw err;
    }
  }
}

export default {
  fetch(): Response {
    return new Response("Headhunter runs via Atlas service binding.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
```

**Usher equivalent entrypoint method:**
```typescript
export class Usher extends WorkerEntrypoint<Env> {
  async register(params: { eventId: string; eventUrl: string }): Promise<UsherResult> {
    const date = localDate(this.env);
    try {
      return await runRegister(this.env, params.eventId, params.eventUrl, date);
    } catch (err) {
      await flag(this.env, "P2", `Usher register() failed: ${params.eventId}`, String(err), {
        sourceAgent: "Usher",
        kind: "usher_failed",
        runId: date,
      });
      throw err;
    }
  }
}
```

**Already-registered short-circuit pattern** (derived from RESEARCH.md Code Examples):
```typescript
// apps/usher/src/index.ts — check before any browser action
const idem = `usher:${eventId}:registered`;
const existing = await env.DB.prepare(
  "SELECT 1 FROM idempotency_keys WHERE key = ?"
).bind(idem).first();
if (existing) {
  return { status: "already_registered" };
}
```

**Wire event** (must match exactly):
```typescript
await send(env, {
  agent: "Usher",
  type: "event.registered",
  entity: "events",
  op: "increment",
  payload: { metric: "events-registered", by: 1, event: eventTitle, confirmation: confirmationNumber },
  idempotencyKey: `usher:${eventId}:registered`,
});
```

**D1 update after confirmed registration:**
```typescript
await env.DB.prepare(
  "UPDATE events SET status = ? WHERE id = ?"
).bind("registered", eventId);
```

**Env bindings:**
```
DB, WIRE, INCIDENTS, CONFIG
GATE   — service binding to apps/gate (to open a gate)
MCP_GOOGLE — service binding to mcp-google (calendar.events add)
```

---

### `apps/envoy/src/index.ts` (WorkerEntrypoint, event-driven)

**Analog:** `apps/headhunter/src/index.ts`

Same `WorkerEntrypoint` shape as Usher and Headhunter. On-demand only; no cron.

**WorkerEntrypoint + Codex read pattern** (`apps/headhunter/src/index.ts`, lines 21–24, extended):
```typescript
import { WorkerEntrypoint } from "cloudflare:workers";
import { send } from "@atlas/wire";
import { flag, localDate } from "@atlas/shared";
import type { Env as SharedEnv, RawIncident } from "@atlas/shared";
// Envoy adds:
import { readCodex } from "@atlas/codex";
```

**Service binding pattern for Forge** (`apps/headhunter/src/index.ts`, lines 55–67):
```typescript
FORGE?: {
  createTask(
    task: { title: string; due: string | null; ... },
    opts: { idempotencyKey: string; runId: string },
  ): Promise<{ id: string } | null>;
};
```

**Envoy equivalent Env surface:**
```typescript
export interface Env extends Omit<SharedEnv, "INCIDENTS"> {
  INCIDENTS: Queue<RawIncident>;
  GATE?: { openGate(opts: GateOptions): Promise<GateRecord> };
  MCP_GITHUB?: { /* github_put_file, github_create_branch, github_open_pr */ };
}
```

**Wire event** (must match exactly):
```typescript
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
  idempotencyKey: `envoy:${projectSlug}`,  // slug only — D4-15
});
```

**Idempotency key:** `envoy:<project-slug>` — slug only, never slug+date (D4-15). A re-run
for the same project is a no-op through Steward (`meta.changes === 0`).

---

### `apps/mcp-github/src/index.ts` — MODIFY: add `github_create_branch` + `github_open_pr`

**Analog:** `apps/mcp-github/src/index.ts` (self — extend the existing pattern)

**registerTool pattern to copy** (`apps/mcp-github/src/index.ts`, lines 58–96):
```typescript
this.server.registerTool(
  "github_put_file",
  {
    title: "Write a GitHub file",
    description: "Create/update a file in a repo (Envoy README writes). Requires github.write.",
  },
  async () => {
    if (!this.hasScope("github.write")) return this.forbidden();
    try {
      await this.mintToken({ permissions: { contents: "write", metadata: "read" } });
    } catch (err) {
      return this.mintError(err);
    }
    return { content: [{ type: "text", text: "(file written via the App installation)" }] };
  },
);
```

**New tools must follow this exact structure.** `github_create_branch` needs:
```typescript
await this.mintToken({ permissions: { contents: "write", metadata: "read", pull_requests: "write" } });
// 1. GET /repos/{owner}/{repo}/git/ref/heads/{fromBranch} → SHA
// 2. POST /repos/{owner}/{repo}/git/refs { ref: "refs/heads/{branch}", sha }
```

`github_open_pr` needs:
```typescript
await this.mintToken({ permissions: { contents: "write", metadata: "read", pull_requests: "write" } });
// POST /repos/{owner}/{repo}/pulls { title, body, head, base, draft: false }
```

**mintError + mintToken private helpers** (`apps/mcp-github/src/index.ts`, lines 119–146):
```typescript
private mintError(_err: unknown) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: "502 Bad Gateway: GitHub App token could not be minted..." }],
  };
}
private async mintToken(opts: { permissions?: Record<string, string> }): Promise<void> {
  const installId = this.env.GH_APP_INSTALLATION_ID;
  if (!installId) throw new Error("GitHub App misconfigured: GH_APP_INSTALLATION_ID is not set in [vars]");
  await installationToken(this.env, installId, { permissions: opts.permissions });
}
```

**GITHUB_SCOPES constant must be updated** (line 45) to include `"github.pr"` or keep
`"github.write"` to cover both `github_put_file` and the new PR tools — reuse the existing
`github.write` scope check (no new scope needed if the same scope covers it).

---

### `apps/sundial/src/reconcile.ts` — RETROFIT onto `packages/gate`

**Analog:** `apps/sundial/src/reconcile.ts` (self — the `propose-removal` path)

The retrofit does NOT change `reconcile()`'s signature or its `propose-removal` decision type.
It changes the caller (Sundial's main Worker) to call `gate.openGate()` for each
`propose-removal` decision instead of only emitting a `flag()`.

**Existing pattern to preserve** (`apps/sundial/src/reconcile.ts`, lines 104–116):
```typescript
result.decisions.push({ action: "propose-removal", atlasTaskId: taskId, eventId: ev.eventId });
result.proposedRemovals++;
proposedEventIds.add(ev.eventId);
// The P2 flag call stays — the gate is additive:
await flag(
  env,
  "P2",
  "sundial detected a duplicate calendar block",
  `Two blocks share atlasTaskId ${taskId}; keeping the earliest and proposing removal...`,
  { sourceAgent: "Sundial", kind: "calendar_sync_failed" },
);
```

**What the CALLER adds** (in the Sundial Worker's main loop, not in `reconcile.ts` itself):
```typescript
// After reconcile() returns, handle propose-removal decisions:
for (const decision of result.decisions) {
  if (decision.action === "propose-removal" && decision.eventId) {
    await openGate(env, {
      agent: "Sundial",
      action: "calendar.remove",
      target: decision.eventId,
      artifact: JSON.stringify({ atlasTaskId: decision.atlasTaskId, eventId: decision.eventId }),
      idempotencyKey: `sundial:remove:${decision.eventId}`,
      expiresInMs: 7 * 24 * 60 * 60 * 1000,  // 7d — calendar removal is not time-critical
      confirmBaseUrl: env.GATE_BASE_URL,
    });
  }
}
```

**Existing test must still pass:** `reconcile()` itself is unchanged. The new retrofit test
verifies that the Sundial Worker calls `openGate()` for each `propose-removal` decision.

---

### `migrations/0007_gate.sql` (migration, CRUD)

**Analog:** `migrations/0004_incidents_flagger.sql`

**Migration header comment pattern** (`migrations/0004_incidents_flagger.sql`, lines 1–18):
```sql
-- migrations/0007_gate.sql
--
-- Atlas D1 Phase-4 tables — the shared confirmation-gate primitive (D4-04).
-- D1 is authoritative (Pillar 4).
--
-- HARD RULES (same as 0001/0004 — see CLAUDE.md gotchas):
--   * D1 supports anonymous positional `?` params ONLY at the call site.
--   * No 2FA codes / reset links / login URLs are ever stored here.
```

**Table DDL pattern** (`migrations/0004_incidents_flagger.sql`, lines 28–43):
```sql
CREATE TABLE IF NOT EXISTS gate_pending (
  id              TEXT PRIMARY KEY,   -- ulid (stable, not UUID)
  agent           TEXT NOT NULL,      -- "Usher" | "Envoy" | "Sundial"
  action          TEXT NOT NULL,      -- "event.register" | "brand.publish" | "calendar.remove"
  target          TEXT NOT NULL,      -- event-id, project-slug, or calendar event-id
  artifact        TEXT NOT NULL,      -- JSON literal artifact (exact post text / form values)
  edited_artifact TEXT,               -- JSON edited artifact (null until owner edits)
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | expired
  decision        TEXT NOT NULL DEFAULT 'pending',
  scope_used      TEXT NOT NULL DEFAULT '',          -- the scope the approved action will exercise
  idempotency_key TEXT NOT NULL,      -- caller's stable key; UNIQUE enforces no duplicate gates
  token_hash      TEXT NOT NULL,      -- SHA-256 of the opaque plaintext token (never store plaintext)
  expires_at      INTEGER NOT NULL,   -- epoch ms
  flag_id         TEXT,               -- FK to flags.id (if raised at gate open)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

**Index naming convention** (`migrations/0004_incidents_flagger.sql`, lines 108–112):
```sql
-- idx_<table>_<column(s)> — always "IF NOT EXISTS"
CREATE INDEX IF NOT EXISTS idx_gate_status     ON gate_pending(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_gate_idem_key   ON gate_pending(idempotency_key);
```

**browser_action_outbox table:**
```sql
CREATE TABLE IF NOT EXISTS browser_action_outbox (
  id          TEXT PRIMARY KEY,       -- ulid
  agent       TEXT NOT NULL,          -- "Usher" | "Envoy"
  action_type TEXT NOT NULL,          -- "event_fill_submit" | "linkedin_prefill" | "x_prefill"
  fields      TEXT NOT NULL,          -- JSON: resolved field values (name, email, phone — NEVER passwords)
  gate_id     TEXT NOT NULL,          -- FK → gate_pending.id (app-enforced, no DB constraint)
  target_url  TEXT NOT NULL,          -- registration URL or platform composer URL
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | claimed | done | failed
  claimed_at  INTEGER,                -- epoch ms when daemon claimed (same as vault_outbox W14 fix)
  outcome     TEXT,                   -- JSON BrowserActionOutcome on done/failed
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_action_status ON browser_action_outbox(status, created_at);
```

The `claimed_at` column mirrors the `vault_outbox` W14 fix (`migrations/0002_vault_outbox_claim.sql`,
lines 21–25) — same claim/lease boundary to prevent double-drain on overlapping polls.

---

### `daemon/src/browser-drain.ts` (daemon drain loop, event-driven)

**Analog:** `daemon/src/drain.ts`

Copy the full `pollOnce` / `ackIntent` / `drainOnce` / `drainLoop` structure verbatim and
substitute the browser-action endpoint and payload types.

**Full interface pattern** (`daemon/src/drain.ts`, lines 29–78):
```typescript
export interface DrainIntent {
  idem: string;
  path: string;
  method: string;
  headers: string;
  body: string | null;
}

export interface DaemonConfig {
  bridgeBaseUrl: string;
  bridgeToken: string;
  obsidianApiKey: string;
  backoffMs: number;
}

export interface DrainDeps {
  fetchCloud: typeof fetch;
  writeObsidian: (intent: DrainIntent, cfg: DaemonConfig) => Promise<void>;
}
```

**Browser-drain equivalent types:**
```typescript
export interface BrowserActionWorkItem {
  id: string;
  agent: "Usher" | "Envoy";
  action_type: "event_fill_submit" | "linkedin_prefill" | "x_prefill";
  fields: string;    // JSON — never credentials, only Codex field values
  gate_id: string;
  target_url: string;
}

export interface BrowserDrainConfig {
  bridgeBaseUrl: string;
  bridgeToken: string;   // same ATLAS_BRIDGE_TOKEN as the Obsidian drain
  browserProfilePath: string;  // $ATLAS_BROWSER_PROFILE env var
  backoffMs: number;
}
```

**pollOnce function pattern** (`daemon/src/drain.ts`, lines 85–93):
```typescript
export async function pollOnce(cfg: DaemonConfig, deps: DrainDeps): Promise<DrainIntent[]> {
  const res = await deps.fetchCloud(`${cfg.bridgeBaseUrl}/bridge/poll`, {
    method: "GET",
    headers: { Authorization: `Bearer ${cfg.bridgeToken}` },
  });
  if (!res.ok) throw new Error(`bridge poll failed: ${res.status}`);
  const body = (await res.json()) as { intents?: DrainIntent[] };
  return body.intents ?? [];
}
```

**Browser poll endpoint:** `GET ${bridgeBaseUrl}/browser/poll`
**Browser ack endpoint:** `POST ${bridgeBaseUrl}/browser/ack` with `{ id, outcome }` body

**drainOnce serial pattern** (`daemon/src/drain.ts`, lines 118–133):
```typescript
export async function drainOnce(cfg: DaemonConfig, deps: DrainDeps): Promise<number> {
  const intents = await pollOnce(cfg, deps);
  let drained = 0;
  for (const intent of intents) {   // SERIAL for...of — never Promise.all
    if (!ALLOWED_METHODS.has(intent.method.toUpperCase())) {
      throw new Error(`refusing non-safe Vault method from bridge intent: ${intent.method}`);
    }
    await deps.writeObsidian(intent, cfg);
    await ackIntent(intent.idem, cfg, deps);
    drained++;
  }
  return drained;
}
```

**loadConfig fail-fast pattern** (`daemon/src/drain.ts`, lines 62–70):
```typescript
export function loadConfig(env: Record<string, string | undefined>): DaemonConfig {
  const bridgeBaseUrl = env.ATLAS_BRIDGE_URL;
  const bridgeToken = env.ATLAS_BRIDGE_TOKEN;
  if (!bridgeBaseUrl) throw new Error("daemon misconfigured: ATLAS_BRIDGE_URL is not set");
  if (!bridgeToken) throw new Error("daemon misconfigured: ATLAS_BRIDGE_TOKEN is not set");
  const backoffMs = Number(env.ATLAS_DRAIN_BACKOFF_MS ?? "5000") || 5000;
  return { bridgeBaseUrl, bridgeToken, backoffMs };
}
```

**Browser-drain loadConfig adds:** `browserProfilePath = env.ATLAS_BROWSER_PROFILE` with the
same fail-loud pattern. Never fall back to a default path.

---

### `daemon/src/browser-runner.ts` (daemon executor, event-driven)

**Analog:** `daemon/src/drain.ts` (the `writeObsidian` injectable dep pattern)

`browser-runner.ts` is the injected dep for `browser-drain.ts`, the same way `writeObsidian`
is the injected dep for `drain.ts`.

**Injectable dep pattern** (`daemon/src/drain.ts`, lines 73–78):
```typescript
export interface DrainDeps {
  fetchCloud: typeof fetch;
  writeObsidian: (intent: DrainIntent, cfg: DaemonConfig) => Promise<void>;
}
// Real impl injected at main(); mock injected in tests.
```

**Browser-runner injectable dep:**
```typescript
export interface BrowserRunnerDeps {
  runBrowserAction: (item: BrowserActionWorkItem, cfg: BrowserDrainConfig) => Promise<BrowserActionOutcome>;
}
```

**drainLoop runForever + sleep injection** (`daemon/src/drain.ts`, lines 177–193):
```typescript
export async function drainLoop(
  cfg: DaemonConfig,
  deps: DrainDeps,
  options: { runForever?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  do {
    try {
      const drained = await drainOnce(cfg, deps);
      if (drained === 0) await sleep(cfg.backoffMs);
    } catch (err) {
      console.warn(`drain iteration error (backing off): ${String(err)}`);
      await sleep(cfg.backoffMs);
    }
  } while (options.runForever);
}
```

**Playwright persistent-context pattern** (from RESEARCH.md Pattern 4 — no existing analog,
but follows the injectable-dep testability pattern):
```typescript
import { chromium, type BrowserContext } from "playwright";

export async function withBrowserContext(
  profilePath: string,
  fn: (ctx: BrowserContext) => Promise<void>,
): Promise<void> {
  // launchPersistentContext preserves cookies/localStorage across daemon restarts.
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,   // owner needs to see the composer for Envoy LinkedIn/X (D4-08)
    slowMo: 50,        // reduces bot-detection signal
  });
  try {
    await fn(context);
  } finally {
    // Do NOT close — persistent across work items. Only close on daemon shutdown.
  }
}
```

**Hard-stop detection must precede any form submit** — the `ALLOWED_METHODS` guard equivalent
for the browser runner:
```typescript
// Check for captcha BEFORE filling any field (P3 flag, no submit)
// Check for payment wall BEFORE submit (P2 flag, no submit)
// A submit that returns no confirmation # = P2 "no confirmation after submit"
// A submit attempted without gate_pending.status='approved' = P1 self-flag
```

---

## Shared Patterns

### Constant-time Token Comparison
**Source:** `apps/flagger/src/auth.ts` (the complete file, 33 lines)
**Apply to:** `packages/gate/src/auth.ts` (copy verbatim), `apps/gate/src/index.ts` (import)
```typescript
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const da = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}
```

### Hardened HTML Response Headers
**Source:** `apps/atlas/src/auth/headers.ts` (the complete file, 45 lines)
**Apply to:** `packages/gate/src/render.ts` (copy `authHtmlResponse`, `authResponse`, `AUTH_SECURITY_HEADERS`)
```typescript
export const AUTH_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
```

### Wire Producer Pattern
**Source:** `packages/wire/src/send.ts`
**Apply to:** `apps/usher/src/index.ts`, `apps/envoy/src/index.ts`
```typescript
import { send } from "@atlas/wire";
await send(env, {
  agent: "...",
  type: "...",
  entity: "...",
  op: "increment",
  payload: { ... },
  idempotencyKey: "...",  // STABLE — never crypto.randomUUID()
});
```

### Incident Routing (flag())
**Source:** `packages/shared/src/flag.ts`
**Apply to:** all new agents and `packages/gate/src/index.ts`
```typescript
import { flag } from "@atlas/shared";
await flag(env, "P2", "title", "detail", {
  sourceAgent: "Usher",   // or "Envoy", "Sundial", "Gate"
  kind: "usher_failed",   // machine-readable class tag
  runId: date,
});
```

### Owner-local Date
**Source:** `packages/shared/src/flag.ts`, lines 9–11
**Apply to:** all Workers in this phase (never `new Date()`)
```typescript
import { localDate } from "@atlas/shared";
const date = localDate(this.env);  // Intl America/Toronto → YYYY-MM-DD
```

### satisfies ExportedHandler
**Source:** every Worker in the project
**Apply to:** `apps/gate/src/index.ts`, `apps/usher/src/index.ts`, `apps/envoy/src/index.ts`
```typescript
export default { ... } satisfies ExportedHandler<Env>;
// NEVER: }: ExportedHandler<Env>  (old annotation style)
```

### Secrets Store Async Binding
**Source:** `apps/flagger/src/index.ts`, lines 34–44
**Apply to:** `apps/gate/src/index.ts` (GATE_CONFIRM_TOKEN, NTFY_TOPIC, NTFY_TOKEN)
```typescript
GATE_CONFIRM_TOKEN?: SecretsStoreSecret;  // await env.GATE_CONFIRM_TOKEN?.get()
// Fail-closed if binding is not seeded:
const token = await env.GATE_CONFIRM_TOKEN?.get();
if (!token) return new Response("Unauthorized", { status: 401 });
```

### D1 Positional ? Params Only
**Source:** `migrations/0001_init_core.sql` header comment + every agent
**Apply to:** all D1 queries in this phase
```typescript
// CORRECT — positional ? only:
await env.DB.prepare("SELECT * FROM gate_pending WHERE token_hash = ? AND status = ?")
  .bind(tokenHash, "pending").first();
// WRONG — no named params:
// .bind({ token_hash: tokenHash })  ← D1 does not support this
```

### Fail-Closed on Error
**Source:** `apps/atlas/src/auth/consent.ts` (overall pattern)
**Apply to:** `apps/gate/src/index.ts` POST /confirm handler
```typescript
// Commit D1 batch BEFORE executing side effect.
// If batch throws → 500 → no action taken → fail-closed.
// NEVER execute an approved action before the D1 commit succeeds.
try {
  await env.DB.batch([updateGatePending, insertAuditLog]);
} catch {
  return authResponse("Something went wrong — no action taken", { status: 500 });
}
// Now execute the approved side effect:
await executeApprovedAction(env, row);
```

---

## No Analog Found

All files have close analogs in the codebase. The Playwright executor (`daemon/src/browser-runner.ts`)
has no existing browser-automation file to copy from, but it follows the injected-dep testability
pattern from `daemon/src/drain.ts` and uses the `launchPersistentContext` API verified in RESEARCH.md
Pattern 4.

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `daemon/src/browser-runner.ts` (Playwright execution) | executor | event-driven | No existing browser-automation in codebase; use drain.ts's injectable-dep pattern + RESEARCH.md Pattern 4 for Playwright API |

---

## Metadata

**Analog search scope:** `apps/flagger/`, `apps/atlas/src/auth/`, `apps/sundial/src/`,
`apps/mcp-github/src/`, `apps/headhunter/src/`, `daemon/src/`, `migrations/`, `packages/shared/src/`,
`packages/wire/src/`
**Files scanned:** 18 source files + 6 migration files
**Pattern extraction date:** 2026-06-06

### Key binding/idempotency strings to use verbatim

| String | Where used |
|--------|-----------|
| `usher:<event-id>:registered` | Usher Wire idempotencyKey + D1 short-circuit check |
| `envoy:<project-slug>` | Envoy Wire idempotencyKey (slug only, D4-15) |
| `sundial:remove:<eventId>` | Sundial gate openGate idempotencyKey |
| `gate:<ulid>` | Internal gate row id (not used as an idempotency key externally) |
| `GATE_CONFIRM_TOKEN` | Secrets Store binding name in gate Worker |
| `ATLAS_BROWSER_PROFILE` | Daemon env var for Playwright persistent profile path |
| `events-registered` | Steward counter metric name for Usher Wire event |
| `projects_published`, `posts_shipped` | Steward counter metric names for Envoy Wire event |
| `atlas-incidents` | Queue name for flag() routing (NEVER atlas-wire for incidents) |
| `Usher`, `Envoy` | Wire agent field exact strings (PascalCase codenames) |
