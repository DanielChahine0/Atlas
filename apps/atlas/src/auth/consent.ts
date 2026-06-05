/**
 * Inbound OAuth consent handler — the `defaultHandler` for the Workers OAuthProvider
 * (SPINE-04, Plan 00-06, Wave 4).
 *
 * The OAuthProvider routes any non-API request (anything not matching `apiRoute`) to this
 * handler. We implement the owner-facing `/authorize` consent surface here: parse the OAuth
 * request, look up the client, render a minimal page listing the REQUESTED per-agent scopes
 * (surfaced against the `scopesSupported` least-privilege floor), and — on owner approval —
 * call `env.OAUTH_PROVIDER.completeAuthorization()` to issue the authorization code.
 *
 * This backs the owner's "what can Atlas do" surface: `env.OAUTH_PROVIDER.listUserGrants()` /
 * `.revokeGrant()` (referenced below) let the owner audit and revoke grants later.
 *
 * SECURITY: no secret/token value is ever rendered or logged. The page shows only scope
 * identifiers (which are public capability labels), the client name, and the redirect URI.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { AtlasEnv } from "../env.js";

/**
 * The env the consent handler sees. The OAuthProvider injects `env.OAUTH_PROVIDER` (the
 * `OAuthHelpers` instance) into the handler's `env` automatically. `AtlasEnv` already declares
 * `OAUTH_PROVIDER`, so the handler object is assignable to the provider's `ExportedHandler<Env>`
 * slot. No secret is read here.
 */
type ConsentEnv = AtlasEnv;

/** A single owner identity — Atlas serves exactly one owner (no multi-user). */
const OWNER_ID = "owner";

/** HTML-escape untrusted strings (client name, redirect URI, scopes) before rendering. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render the minimal consent page listing the requested per-agent scopes. */
function renderConsentPage(authReq: AuthRequest, clientName: string): string {
  const scopeItems = authReq.scope.map((s) => `<li><code>${esc(s)}</code></li>`).join("");
  // The form re-POSTs the original OAuth params so the handler can complete the authorization.
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize Atlas</title></head>
<body>
  <h1>Authorize ${esc(clientName)}</h1>
  <p>This client is requesting the following least-privilege scopes:</p>
  <ul>${scopeItems}</ul>
  <p>Granting a scope does NOT authorize silent execution — every destructive or
     outward-facing action still parks at its own confirmation gate.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="oauth_request" value="${esc(JSON.stringify(authReq))}">
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
</body></html>`;
}

/**
 * The OAuthProvider `defaultHandler`. An object with a `fetch(request, env, ctx)` method —
 * exactly the shape the provider expects (README: "an object with a fetch method").
 */
export const consentHandler = {
  async fetch(request: Request, env: ConsentEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      if (request.method === "GET") {
        // Render consent: parse the inbound OAuth request + look up the client metadata.
        const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const clientInfo = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
        const clientName = clientInfo?.clientName ?? authReq.clientId;
        return new Response(renderConsentPage(authReq, clientName), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST") {
        // Owner submitted the consent decision.
        const form = await request.formData();
        const decision = form.get("decision");
        const rawReq = form.get("oauth_request");
        if (typeof rawReq !== "string") {
          return new Response("Bad Request: missing oauth_request", { status: 400 });
        }
        const authReq = JSON.parse(rawReq) as AuthRequest;

        if (decision !== "approve") {
          // Fail-safe: deny on anything that isn't an explicit approve.
          return new Response("Authorization denied", { status: 403 });
        }

        // Issue the code. We grant the REQUESTED scopes (the provider's `scopesSupported`
        // allow-list is the floor the provider already enforces at parse time). `props` is the
        // identity the apiHandler reads from `ctx.props` for least-privilege enforcement at the
        // door (full per-tool 403 enforcement lands in mcp-google at 00-08).
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: authReq,
          userId: OWNER_ID,
          metadata: { client: authReq.clientId },
          scope: authReq.scope,
          props: { ownerId: OWNER_ID, scopes: authReq.scope },
        });
        return Response.redirect(redirectTo, 302);
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },
};

export type { ConsentEnv };
