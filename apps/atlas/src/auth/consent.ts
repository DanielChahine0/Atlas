/**
 * Inbound OAuth consent handler — the `defaultHandler` for the Workers OAuthProvider
 * (SPINE-04, Plan 00-06, Wave 4; hardened post security review).
 *
 * The OAuthProvider routes any non-API request (anything not matching `apiRoute`) to this
 * handler. It implements the owner-facing auth surface:
 *
 *   - `/login`     — the owner authenticates ONCE with `OWNER_AUTH_TOKEN` (constant-time compare
 *                    against the Secrets Store binding); on match it issues a signed, HttpOnly,
 *                    Secure, SameSite=Strict, short-TTL session cookie.
 *   - `/authorize` — GATED on a valid owner session. GET stores the canonical authorize request
 *                    + a single-use CSRF token in OAUTH_KV under an opaque `consent:<id>` and
 *                    renders ONLY the opaque id (scope can't be inflated from the form). POST
 *                    loads + deletes that record (single-use), verifies the CSRF token + same
 *                    origin, and completes authorization with the SERVER-SIDE authReq.
 *
 * This is the front door to the owner's entire digital life — the four hardenings (owner-session
 * gate, server-side consent record, CSRF + same-origin, security headers) close an auth-bypass,
 * a scope-inflation, a CSRF, and a clickjacking finding respectively.
 *
 * SECURITY: no secret/token value is ever rendered or logged. The page shows only scope
 * identifiers (public capability labels) + the client name. The daemon/MCP RUNTIME token path
 * hits `apiRoute` (the provider's token endpoint), NOT this consent surface — it is unaffected.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { AtlasEnv } from "../env.js";
import { authHtmlResponse, authResponse } from "./headers.js";
import {
  SESSION_COOKIE,
  issueSession,
  randomId,
  readCookie,
  sessionSetCookie,
  timingSafeEqual,
  verifySession,
} from "./session.js";

/**
 * The env the consent handler sees. The OAuthProvider injects `env.OAUTH_PROVIDER` (the
 * `OAuthHelpers` instance) into the handler's `env` automatically. `AtlasEnv` declares it.
 */
type ConsentEnv = AtlasEnv;

/** A single owner identity — Atlas serves exactly one owner (no multi-user). */
const OWNER_ID = "owner";

/** The server-side consent record stored in OAUTH_KV under `consent:<id>` (single-use). */
interface ConsentRecord {
  /** The CANONICAL parsed authorize request — the ONLY source of truth for scope. */
  authReq: AuthRequest;
  /** Single-use CSRF token bound to this consent record. */
  csrf: string;
}

/** TTL for a pending consent record — short; the owner approves promptly. */
const CONSENT_TTL_SECONDS = 600;
const CONSENT_KEY_PREFIX = "consent:";

/** HTML-escape untrusted strings (client name, scopes, ids) before rendering. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render the minimal token-entry login form. */
function renderLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Atlas — owner login</title></head>
<body>
  <h1>Atlas owner login</h1>
  <form method="POST" action="/login">
    <label>Owner token: <input type="password" name="token" autocomplete="off"></label>
    <button type="submit">Sign in</button>
  </form>
</body></html>`;
}

/** Render the consent page — embeds ONLY the opaque consent id + the CSRF token. */
function renderConsentPage(authReq: AuthRequest, clientName: string, consentId: string, csrf: string): string {
  const scopeItems = authReq.scope.map((s) => `<li><code>${esc(s)}</code></li>`).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize Atlas</title></head>
<body>
  <h1>Authorize ${esc(clientName)}</h1>
  <p>This client is requesting the following least-privilege scopes:</p>
  <ul>${scopeItems}</ul>
  <p>Granting a scope does NOT authorize silent execution — every destructive or
     outward-facing action still parks at its own confirmation gate.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="consent_id" value="${esc(consentId)}">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
</body></html>`;
}

/** True if the request originates same-origin (Origin / Sec-Fetch-Site). Fail-closed. */
function isSameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  // Sec-Fetch-Site is the strongest signal when present.
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) return secFetchSite === "same-origin";
  // Fall back to Origin; reject if it disagrees with the request origin.
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  // No Origin AND no Sec-Fetch-Site → cannot prove same-origin → reject (fail-closed).
  return false;
}

export const consentHandler = {
  async fetch(request: Request, env: ConsentEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── /login — owner authentication ──────────────────────────────────────────────────────
    if (url.pathname === "/login") {
      if (request.method === "GET") {
        return authHtmlResponse(renderLoginPage());
      }
      if (request.method === "POST") {
        // Same-origin only (the login POST sets an auth cookie).
        if (!isSameOrigin(request)) return authResponse("Forbidden", { status: 403 });
        const form = await request.formData();
        const submitted = form.get("token");
        const ownerToken = await env.OWNER_AUTH_TOKEN?.get();
        // Fail-closed if the owner token is not yet provisioned (Gate C).
        if (!ownerToken) return authResponse("Owner auth not configured", { status: 503 });
        if (typeof submitted !== "string" || !timingSafeEqual(submitted, ownerToken)) {
          // No Set-Cookie on failure.
          return authResponse("Invalid token", { status: 401 });
        }
        const session = await issueSession(env);
        return authResponse("Signed in", {
          status: 200,
          headers: { "set-cookie": sessionSetCookie(session) },
        });
      }
      return authResponse("Method Not Allowed", { status: 405 });
    }

    // ── /authorize — owner-session-gated consent surface ───────────────────────────────────
    if (url.pathname === "/authorize") {
      const session = await verifySession(env, readCookie(request, SESSION_COOKIE));

      if (request.method === "GET") {
        // No owner session → bounce to /login (the owner authenticates first).
        if (!session) {
          return authResponse(null, { status: 302, headers: { location: "/login" } });
        }
        // Parse the inbound OAuth request server-side and look up the client metadata.
        const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const clientInfo = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
        const clientName = clientInfo?.clientName ?? authReq.clientId;

        // Store the CANONICAL authReq + a single-use CSRF token server-side under an opaque id.
        // The browser only ever sees the opaque consent id — scope can't be inflated from the form.
        const consentId = randomId();
        const csrf = randomId();
        const record: ConsentRecord = { authReq, csrf };
        await env.OAUTH_KV.put(`${CONSENT_KEY_PREFIX}${consentId}`, JSON.stringify(record), {
          expirationTtl: CONSENT_TTL_SECONDS,
        });
        return authHtmlResponse(renderConsentPage(authReq, clientName, consentId, csrf));
      }

      if (request.method === "POST") {
        // No owner session → 401 (the consent surface authenticates nobody on its own).
        if (!session) return authResponse("Unauthorized", { status: 401 });
        // Same-origin only — CSRF defense-in-depth alongside the token check.
        if (!isSameOrigin(request)) return authResponse("Forbidden", { status: 403 });

        const form = await request.formData();
        const decision = form.get("decision");
        const consentId = form.get("consent_id");
        const csrf = form.get("csrf");
        if (typeof consentId !== "string" || typeof csrf !== "string") {
          return authResponse("Bad Request", { status: 400 });
        }

        // Load + DELETE the server-side consent record (single-use). Unknown/expired → 400.
        const kvKey = `${CONSENT_KEY_PREFIX}${consentId}`;
        const raw = await env.OAUTH_KV.get(kvKey);
        if (raw === null) return authResponse("Bad Request: consent expired or unknown", { status: 400 });
        // Single-use: delete BEFORE acting so a replay of the same consent_id fails.
        await env.OAUTH_KV.delete(kvKey);
        const record = JSON.parse(raw) as ConsentRecord;

        // CSRF: constant-time-compare the submitted token against the bound one.
        if (!timingSafeEqual(csrf, record.csrf)) {
          return authResponse("Forbidden: CSRF", { status: 403 });
        }

        if (decision !== "approve") {
          // Fail-safe: deny on anything that isn't an explicit approve.
          return authResponse("Authorization denied", { status: 403 });
        }

        // Complete authorization with the SERVER-SIDE authReq — scope comes from KV, NEVER the
        // form. `props` is the identity the apiHandler reads from `ctx.props` for door-level
        // least privilege (full per-tool 403 enforcement lands in mcp-google at 00-08).
        const authReq = record.authReq;
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: authReq,
          userId: OWNER_ID,
          metadata: { client: authReq.clientId },
          scope: authReq.scope,
          props: { ownerId: OWNER_ID, scopes: authReq.scope },
        });
        return authResponse(null, { status: 302, headers: { location: redirectTo } });
      }

      return authResponse("Method Not Allowed", { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },
};

export type { ConsentEnv, ConsentRecord };
