/**
 * Inbound API handler — the OAuthProvider `apiHandler` (SPINE-04, Plan 00-06, Wave 4).
 *
 * The OAuthProvider routes requests matching `apiRoute` (`/mcp/`, `/api/`) here ONLY after it
 * has validated the access token. The validated grant's `props` (set in consent.ts via
 * `completeAuthorization({ props })`) are exposed as `this.ctx.props` — the `{ ownerId, scopes }`
 * identity this handler reads to enforce least-privilege AT THE DOOR.
 *
 * Phase 0 keeps this a minimal seam: it confirms a token was validated and surfaces the granted
 * scopes. The full per-tool 403 enforcement (a tool call whose required scope is absent from
 * `ctx.props.scopes` is rejected) lands in mcp-google at 00-08 — defense-in-depth in two places.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { AtlasEnv } from "../env.js";

/** The identity the OAuthProvider attaches to a validated grant (from consent.ts `props`). */
export interface AtlasProps {
  ownerId: string;
  /** The OAuth scopes granted to this token — the least-privilege floor enforced at the door. */
  scopes: string[];
  /** Optional per-agent codename, set when a specific agent's grant is issued (Phase 1+). */
  agent?: string;
}

/**
 * The API handler. A `WorkerEntrypoint` (the provider supports a class extending
 * `WorkerEntrypoint`). `this.ctx.props` carries the validated grant's `AtlasProps`.
 */
export class AtlasApiHandler extends WorkerEntrypoint<AtlasEnv> {
  override async fetch(request: Request): Promise<Response> {
    // The token was already validated by the OAuthProvider before reaching here; the granted
    // identity is in ctx.props. Cast through unknown — the base ctx.props is typed `unknown`.
    const props = (this.ctx as unknown as { props?: AtlasProps }).props;
    if (!props) {
      // Defense-in-depth: the provider should never route an unauthenticated request here.
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/whoami") {
      // Surface the granted scopes (public capability labels) — NEVER a token value.
      return Response.json({ ownerId: props.ownerId, scopes: props.scopes, agent: props.agent });
    }

    // Phase-0 seam: real per-tool 403 enforcement against props.scopes lands in mcp-google (00-08).
    return new Response("Not found", { status: 404 });
  }
}
