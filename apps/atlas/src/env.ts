/**
 * Atlas's runtime Env — the local binding surface (Phase 0; Plan 03 + Plan 06).
 *
 * Defined in its OWN module (not index.ts) so the OAuthProvider handlers (auth/consent.ts,
 * auth/api-handler.ts) and the index dispatcher can all import the SAME `AtlasEnv` without a
 * circular import (index.ts imports the handlers; the handlers would otherwise import index.ts).
 *
 * Extends the shared canonical binding surface (`@atlas/shared` `Env`) with:
 *   - `NOOP`           — the D-11 self service-binding the dispatcher invokes.
 *   - `OAUTH_PROVIDER` — injected by the OAuthProvider at runtime into every handler's env.
 *   - the three OAuth provider SECRETS (Secrets Store async bindings) the outbound helpers read.
 *
 * No secret VALUE ever appears here — these are TYPE declarations referencing bindings only
 * (CLAUDE.md security invariant). Secret reads are async: `await env.X.get()`.
 */

import type { Env as SharedEnv } from "@atlas/shared";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { NoopAgent } from "./noop-agent.js";

export interface AtlasEnv extends SharedEnv {
  /** The D-11 self service-binding; `Service<NoopAgent>` exposes the agent's public RPC. */
  NOOP: Service<NoopAgent>;
  /** Injected by the OAuthProvider at runtime into the default + api handlers' env. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Google confidential client secret — Secrets Store async binding (oauth/google.ts). */
  GOOGLE_CLIENT_SECRET?: SecretsStoreSecret;
  /** Google owner-once refresh token — Secrets Store async binding (oauth/google.ts). */
  GOOGLE_REFRESH_TOKEN?: SecretsStoreSecret;
  /** GitHub App RS256 PKCS8 private key — Secrets Store async binding (oauth/github.ts). */
  GH_APP_PRIVATE_KEY?: SecretsStoreSecret;
}
