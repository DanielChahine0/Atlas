/**
 * mcp-google — the STATELESS Google MCP server (SPINE-04 redaction backstop).
 *
 * This Worker is the THIRD, load-bearing leg of the CLAUDE.md hard invariant:
 *   "NEVER surface 2FA codes / password-reset links / login URLs anywhere ... A
 *    prompt instruction alone is NOT sufficient."
 * Defense-in-depth: the Google MCP strips `Type/Security` bodies SERVER-SIDE
 * regardless of scope (HERE), the Herald digest-builder guardrail catches a leak
 * (Phase 1), and a CI unit test backstops it (test/redact.test.ts).
 *
 * NOTE (Pillar 1): this Worker intentionally NEVER touches `atlas-wire` — its
 * `wrangler.jsonc` declares NO `queues` block, so `env.WIRE` is undefined here. It
 * therefore CANNOT emit a Wire incident (a Wire P1 would require a producer binding
 * that would weaken the single-writer pillar). A detected egress leak is BLOCKED (the
 * redacted body + `isError: true` are returned to the caller) and logged via
 * `console.warn` for observability; raising the documented P1 incident is the
 * downstream caller's job (it maps `containsSecret` → a Flagger emit from a Worker that
 * IS a Wire producer). Do NOT add a `queues.producers` block to this Worker.
 *
 * Two security floors, enforced by CONSTRUCTION (not by prose):
 *   1. REDACTION — every tool-output body is run through `@atlas/security` `redact()`
 *      BEFORE it leaves the server, so a 2FA code / reset link / login URL never
 *      reaches the caller, regardless of the requested scope. A detected leak is
 *      blocked at egress (`isError: true` + redacted body) and logged; the caller
 *      raises the P1 (it maps `containsSecret` → flag from a Wire producer).
 *   2. LEAST-PRIVILEGE SCOPE — every tool invocation reads the inbound granted scopes
 *      via the agents-SDK `getMcpAuthContext()` (the OAuthProvider attaches them as
 *      `ctx.props.scopes`) and returns a 403-equivalent MCP error if the tool's
 *      required scope is absent. Filer = `gmail.modify` ONLY; NO message- or
 *      thread-removal tool is registered — the removal path needs the never-granted
 *      full `https://mail.google.com/` scope and is unreachable by construction
 *      (Pillar 2: suggest, don't destroy).
 *
 * Stateless server shape: agents@0.14.1 named export `createMcpHandler(server, opts)`
 * returns `(request, env, ctx) => Promise<Response>`; tools are registered on a
 * `McpServer` (MCP SDK 1.29.0) via the v2-forward `registerTool()`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { redact, containsSecret } from "@atlas/security";
import type { Env as SharedEnv } from "@atlas/shared";
import {
  GMAIL_MODIFY_SCOPE,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_READONLY_SCOPE,
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  FORBIDDEN_TEXT,
  grantedScopes,
  forbiddenResult,
  hasGmailModify,
  hasGmailCompose,
  hasGmailReadonly,
  hasCalendarEvents,
  hasCalendarReadonly,
} from "./scopes.js";

// Re-export the scope surface so existing importers (test/scope.test.ts) and the new
// Phase-1 tools resolve everything through index.ts unchanged. scopes.ts is the single
// source of truth for the per-agent least-privilege floors.
export {
  GMAIL_MODIFY_SCOPE,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_READONLY_SCOPE,
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  FORBIDDEN_TEXT,
  grantedScopes,
  forbiddenResult,
  hasGmailModify,
  hasGmailCompose,
  hasGmailReadonly,
  hasCalendarEvents,
  hasCalendarReadonly,
};

/** The Google MCP env surface. */
export interface Env extends SharedEnv {
  /** Inbound OAuthProvider grant store (the provider attaches ctx.props.scopes). */
  OAUTH_KV?: KVNamespace;
  /** Google OAuth public client id (a [vars] value, NOT a secret). */
  GOOGLE_CLIENT_ID?: string;
  /** Google client secret — Secrets Store async binding (never logged/persisted). */
  GOOGLE_CLIENT_SECRET?: SecretsStoreSecret;
  /** Google refresh token — Secrets Store async binding (never logged/persisted). */
  GOOGLE_REFRESH_TOKEN?: SecretsStoreSecret;
}

/** A neutral, secret-free message surfaced when a leak was detected and blocked. */
export const SECRET_BLOCKED_TEXT =
  "Sensitive content (e.g. a verification code or login link) was detected and redacted before egress (P1 block).";

/**
 * The single egress point for EVERY tool-output body. Runs the body through the
 * `@atlas/security` redactor so 2FA codes / reset links / login URLs are stripped
 * before the result leaves the server — regardless of scope. The redacted text is
 * returned either way (fail-safe: the secret never escapes).
 *
 * When a leak is detected, the result is returned with `isError: true` and a NEUTRAL,
 * secret-free message PREPENDED so the block is OBSERVABLE to the client (I28) instead
 * of looking like a normal tool result. The redacted content is still returned (never
 * the secret) so a caller can see what was stripped.
 *
 * This Worker has NO Wire producer binding (Pillar 1 — see file header), so it does
 * NOT emit a Flagger incident here: `env.WIRE` is undefined and a `flag()` call would
 * throw and be swallowed, making the "P1 from mcp-google" promise dead code. Instead a
 * detected leak is logged via `console.warn` (structured, secret-free) so it is
 * observable in Worker logs; the downstream caller — a Worker that IS a Wire producer —
 * maps the `isError: true` block to the documented P1 Flagger emit. The `env` param is
 * retained for signature stability and any future non-Wire use; it is not used to flag.
 *
 * This is the function the CI backstop (test/redact.test.ts) drives directly, and
 * the function EVERY registered tool funnels its output through.
 */
export async function safeToolOutput(
  body: string,
  _env?: Env,
): Promise<{ content: { type: "text"; text: string }[]; isError?: true }> {
  const leaked = containsSecret(body);
  const clean = redact(body);
  if (leaked) {
    // Observability without the Wire: a structured, SECRET-FREE marker in Worker logs.
    // We never log the offending body — only the fact that a leak was blocked at egress.
    console.warn("[mcp-google] secret-exposure blocked on tool egress");
    // I28: make the block OBSERVABLE — isError:true + neutral message, redacted content kept.
    return {
      isError: true,
      content: [
        { type: "text", text: SECRET_BLOCKED_TEXT },
        { type: "text", text: clean },
      ],
    };
  }
  return { content: [{ type: "text", text: clean }] };
}

/**
 * Build the Google MCP server with the Filer label tools. EVERY tool:
 *   - enforces the `gmail.modify` scope floor (403 if absent) BEFORE doing anything,
 *   - funnels its output through `safeToolOutput()` so no secret escapes.
 *
 * Registered tools (Filer's least-privilege surface — labels only):
 *   - gmail_list_labels   — read the label taxonomy
 *   - gmail_modify_labels — add/remove labels on a message (the only mutation)
 *   - gmail_get_message   — fetch a message body (the redaction egress is critical
 *                           here: a `Type/Security` body is stripped server-side)
 *
 * There is deliberately NO removal/archive tool. The message-removal and
 * thread-removal endpoints require the full `https://mail.google.com/` scope (never
 * granted) — the path is unreachable by construction, not merely gated (Pillar 2).
 */
export function buildGoogleMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "atlas-mcp-google", version: "0.1.0" });

  // Read the Filer label taxonomy. Requires gmail.modify (Filer's only scope).
  server.registerTool(
    "gmail_list_labels",
    {
      title: "List Gmail labels",
      description: "List the Gmail label taxonomy (Filer substrate). Requires gmail.modify.",
    },
    async () => {
      if (!hasGmailModify(grantedScopes())) return forbiddenResult();
      // Phase 0: the live Gmail call lands in Phase 1 (Filer). Here we prove the
      // scope floor + the redaction egress are wired. Output funnels through the strip.
      return await safeToolOutput("(labels would be listed here)", env);
    },
  );

  // The ONLY mutation Filer is permitted: add/remove labels (never delete/archive).
  server.registerTool(
    "gmail_modify_labels",
    {
      title: "Modify Gmail labels",
      description: "Add/remove labels on a message (Filer's only mutation). Requires gmail.modify.",
    },
    async () => {
      if (!hasGmailModify(grantedScopes())) return forbiddenResult();
      return await safeToolOutput("(labels modified)", env);
    },
  );

  // Fetch a message body. The redaction egress is CRITICAL here — a `Type/Security`
  // body (2FA code / reset link / login URL) is stripped server-side before egress,
  // regardless of scope. (The live Gmail fetch lands in Phase 1; the strip is here now.)
  server.registerTool(
    "gmail_get_message",
    {
      title: "Get a Gmail message",
      description: "Fetch a message body (server-side redacted). Requires gmail.modify.",
    },
    async () => {
      if (!hasGmailModify(grantedScopes())) return forbiddenResult();
      // In Phase 1 the raw body comes from the Gmail API; here a placeholder proves
      // the egress path. Any real secret in the body would be stripped by safeToolOutput.
      return await safeToolOutput("(message body would be fetched and redacted here)", env);
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 1 — the four reasoning agents' least-privilege tool surfaces.
  // Each tool checks its EXACT scope floor (forbiddenResult names the scope) BEFORE
  // doing anything, and funnels EVERY output through safeToolOutput(body, env) so a
  // 2FA code / reset link / login URL is stripped server-side regardless of scope.
  // The tool bodies here are Phase-1 placeholders proving scope-floor + redaction are
  // wired; each agent's Wave-2 plan adds the live Gmail/Calendar fetch.
  //
  // Pillar 2 (suggest, don't destroy) by CONSTRUCTION: there is NO gmail_send tool
  // (Herald is draft-only), NO gmail delete/archive tool, and NO calendar_delete tool.
  // Those outward/destructive paths are unreachable — not merely gated.
  // ───────────────────────────────────────────────────────────────────────────

  // Herald + Forge: read Gmail threads. Requires gmail.readonly (NOT gmail.modify —
  // these agents never mutate the inbox). The redaction egress is critical on
  // gmail_get_thread: a Type/Security thread body is stripped before egress.
  server.registerTool(
    "gmail_search_threads",
    {
      title: "Search Gmail threads",
      description:
        "Search Gmail threads in a window (Herald/Forge input). Read-only. Requires gmail.readonly.",
    },
    async () => {
      if (!hasGmailReadonly(grantedScopes())) return forbiddenResult(GMAIL_READONLY_SCOPE);
      return await safeToolOutput("(matching threads would be listed here)", env);
    },
  );

  server.registerTool(
    "gmail_get_thread",
    {
      title: "Get a Gmail thread",
      description:
        "Fetch a thread's messages (server-side redacted). Read-only. Requires gmail.readonly.",
    },
    async () => {
      if (!hasGmailReadonly(grantedScopes())) return forbiddenResult(GMAIL_READONLY_SCOPE);
      // Critical egress: a Type/Security body (2FA code / reset link / login URL) is
      // stripped server-side by safeToolOutput before it can reach Herald/Forge.
      return await safeToolOutput("(thread messages would be fetched and redacted here)", env);
    },
  );

  // Herald: create a Gmail DRAFT to the owner (never sent). Requires gmail.compose.
  // There is deliberately NO gmail_send tool — the send path needs no scope here
  // because it is simply not registered (unreachable by construction, Pillar 2).
  server.registerTool(
    "gmail_create_draft",
    {
      title: "Create a Gmail draft",
      description:
        "Create a DRAFT email to the owner (never sent). Requires gmail.compose. No send path exists.",
    },
    async () => {
      if (!hasGmailCompose(grantedScopes())) return forbiddenResult(GMAIL_COMPOSE_SCOPE);
      return await safeToolOutput("(a draft would be created here — never sent)", env);
    },
  );

  // Sundial: write calendar deadline blocks. Requires calendar.events (create/update/
  // list). There is deliberately NO calendar_delete_event tool — Sundial can never
  // delete an event (the autonomous-delete path stays off the toolset, Pillar 2).
  server.registerTool(
    "calendar_list_events",
    {
      title: "List calendar events",
      description: "List calendar events in a window (Sundial reconcile). Requires calendar.events.",
    },
    async () => {
      if (!hasCalendarEvents(grantedScopes())) return forbiddenResult(CALENDAR_EVENTS_SCOPE);
      return await safeToolOutput("(events would be listed here)", env);
    },
  );

  server.registerTool(
    "calendar_create_event",
    {
      title: "Create a calendar event",
      description: "Create a deadline-block event (Sundial). Requires calendar.events.",
    },
    async () => {
      if (!hasCalendarEvents(grantedScopes())) return forbiddenResult(CALENDAR_EVENTS_SCOPE);
      return await safeToolOutput("(an event would be created here)", env);
    },
  );

  server.registerTool(
    "calendar_update_event",
    {
      title: "Update a calendar event",
      description: "Update an existing deadline block (Sundial reconcile). Requires calendar.events.",
    },
    async () => {
      if (!hasCalendarEvents(grantedScopes())) return forbiddenResult(CALENDAR_EVENTS_SCOPE);
      return await safeToolOutput("(an event would be updated here)", env);
    },
  );

  server.registerTool(
    "calendar_suggest_time",
    {
      title: "Suggest a free time slot",
      description: "Suggest a free slot for a deadline block (Sundial). Requires calendar.events.",
    },
    async () => {
      if (!hasCalendarEvents(grantedScopes())) return forbiddenResult(CALENDAR_EVENTS_SCOPE);
      return await safeToolOutput("(a free slot would be suggested here)", env);
    },
  );

  // Compass: read-only calendar access. Requires ONLY calendar.readonly — Compass
  // never needs (and is never granted) the calendar.events write scope. Separate
  // read-only variants so the read path never depends on a write floor.
  server.registerTool(
    "calendar_list_events_readonly",
    {
      title: "List calendar events (read-only)",
      description: "List calendar events for day planning (Compass). Requires calendar.readonly.",
    },
    async () => {
      if (!hasCalendarReadonly(grantedScopes())) return forbiddenResult(CALENDAR_READONLY_SCOPE);
      return await safeToolOutput("(events would be listed read-only here)", env);
    },
  );

  server.registerTool(
    "calendar_freebusy",
    {
      title: "Query calendar free/busy",
      description: "Query free/busy windows for day planning (Compass). Requires calendar.readonly.",
    },
    async () => {
      if (!hasCalendarReadonly(grantedScopes())) return forbiddenResult(CALENDAR_READONLY_SCOPE);
      return await safeToolOutput("(free/busy windows would be returned here)", env);
    },
  );

  return server;
}

/**
 * The stateless Worker default export. `createMcpHandler` returns the request
 * handler; we build a per-request server so tool callbacks close over `env`.
 *
 * `satisfies ExportedHandler<Env>` (NEVER the `: ExportedHandler<Env>` annotation).
 */
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handler = createMcpHandler(buildGoogleMcpServer(env), { route: "/mcp" });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
