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
 * Two security floors, enforced by CONSTRUCTION (not by prose):
 *   1. REDACTION — every tool-output body is run through `@atlas/security` `redact()`
 *      BEFORE it leaves the server, so a 2FA code / reset link / login URL never
 *      reaches the caller, regardless of the requested scope. A caught attempt to
 *      surface a secret is a P1 incident (the caller maps `containsSecret` → flag).
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
import { createMcpHandler, getMcpAuthContext } from "agents/mcp";
import { redact, containsSecret } from "@atlas/security";
import { flag } from "@atlas/shared";
import type { Env as SharedEnv } from "@atlas/shared";

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

/**
 * The least-privilege scope floor for the Filer label tools. Filer is granted
 * `gmail.modify` ONLY (labels) — it can NEVER delete/archive (that needs the
 * never-granted full `https://mail.google.com/` scope). The full URI form is what
 * the grant carries; the short form is accepted as an alias for resilience.
 */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_MODIFY_ALIASES = new Set([GMAIL_MODIFY_SCOPE, "gmail.modify"]);

/**
 * Read the inbound granted scopes from the MCP auth context the OAuthProvider
 * attaches (`ctx.props.scopes`). A missing context / missing scopes array means an
 * unauthenticated or scope-less caller — treated as the empty set (fail-closed).
 */
export function grantedScopes(): string[] {
  const auth = getMcpAuthContext();
  const raw = auth?.props?.["scopes"];
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string");
  }
  return [];
}

/** True iff the granted scopes include the `gmail.modify` floor (in either form). */
export function hasGmailModify(scopes: string[]): boolean {
  return scopes.some((s) => GMAIL_MODIFY_ALIASES.has(s));
}

/** A 403-equivalent MCP error result for an out-of-scope tool call. */
export const FORBIDDEN_TEXT =
  "403 Forbidden: this tool requires the gmail.modify scope, which the presented token does not carry.";

function forbiddenResult() {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: FORBIDDEN_TEXT }],
  };
}

/**
 * The single egress point for EVERY tool-output body. Runs the body through the
 * `@atlas/security` redactor so 2FA codes / reset links / login URLs are stripped
 * before the result leaves the server — regardless of scope. If a secret was
 * present, the caller is given an env to raise a P1 (block + flag); the redacted
 * text is returned either way (fail-safe: the secret never escapes).
 *
 * This is the function the CI backstop (test/redact.test.ts) drives directly, and
 * the function EVERY registered tool funnels its output through.
 */
export async function safeToolOutput(
  body: string,
  env?: Env,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const leaked = containsSecret(body);
  const clean = redact(body);
  if (leaked && env) {
    // A caught attempt to surface a secret is a P1 (block + flag). We never include
    // the offending body in the flag detail — only the fact + the source tool.
    try {
      await flag(
        env,
        "P1",
        "secret-exposure-blocked",
        "a Type/Security body was redacted server-side before egress",
        { sourceAgent: "Filer" },
      );
    } catch {
      // Flag emission is best-effort; the redaction itself is the load-bearing guard.
    }
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
