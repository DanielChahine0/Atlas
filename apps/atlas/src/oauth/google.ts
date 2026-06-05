/**
 * Google OAuth — outbound (SPINE-04, Plan 00-06, Wave 4).
 *
 * The OWNER-once authorize/exchange flow plus the per-run refresh flow for every
 * Google-acting agent (Filer `gmail.modify`, Herald draft scope, Sundial
 * `calendar.events`, Compass `calendar.readonly`, Archivist `drive.readonly`).
 *
 * HARD invariants (CLAUDE.md "Security" + the Google-OAuth gotchas):
 *   - The authorize request MUST set `access_type=offline` + `prompt=consent` or Google
 *     returns NO refresh token. We also use S256 PKCE (`code_challenge_method=S256`).
 *   - A `grant_type=refresh_token` response NEVER returns a new refresh token — the helper
 *     keeps the ORIGINAL refresh token (it never overwrites/discards the stored one).
 *   - Least-privilege scope FLOOR only: `gmail.modify` (labels; NOT the full
 *     `https://mail.google.com/`), `calendar.events` (NOT the full `calendar` scope),
 *     `calendar.readonly`, `drive.readonly` (the Codex). A granted scope does NOT authorize
 *     silent execution — each outward action still parks at its own confirm gate elsewhere.
 *   - Provider credentials are read ONLY via Cloudflare Secrets Store async bindings
 *     (`await env.GOOGLE_CLIENT_SECRET.get()` / `await env.GOOGLE_REFRESH_TOKEN.get()`).
 *     No token/secret value is ever logged, returned to the Vault/Codex, or written to D1/KV.
 */

import type { Env as SharedEnv } from "@atlas/shared";

const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * The least-privilege Google scope FLOOR for the Phase-0 agents (docs/11-security-privacy.md
 * §3 + CLAUDE.md). Full `https://www.googleapis.com/auth/<scope>` URIs are required in the
 * authorize request. Deliberately at the floor:
 *   - `gmail.modify`  — Filer labels only; the delete path is unreachable by scope (NOT
 *                       `https://mail.google.com/`, which is never requested).
 *   - `calendar.events` — Sundial/Usher write events (NOT the broad `calendar` scope; no delete).
 *   - `calendar.readonly` — Compass/Scout read-only planning.
 *   - `drive.readonly`  — Archivist reads the Codex.
 * Herald's `gmail.readonly` + `gmail.compose` (draft, no send) are a subset/peer of `gmail.modify`
 * and are requested per-agent in Phase 1 — the floor here is the Phase-0 surface.
 */
export const GOOGLE_SCOPE_FLOOR: readonly string[] = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];

/**
 * The Google OAuth env surface this module reads. `GOOGLE_CLIENT_ID` is a plaintext [vars]
 * identifier (NOT a secret); the client secret + refresh token are Secrets Store async bindings.
 * `GOOGLE_REDIRECT_URI` is the deployed Atlas `/authorize` callback (plaintext).
 */
export interface GoogleOAuthEnv extends SharedEnv {
  /** Plaintext OAuth client id (a [vars] value, NOT a secret). */
  GOOGLE_CLIENT_ID?: string;
  /** Plaintext redirect URI = the deployed Atlas `/authorize` callback (a [vars] value). */
  GOOGLE_REDIRECT_URI?: string;
  /** Confidential client secret — Secrets Store async binding (PKCE does NOT remove the secret). */
  GOOGLE_CLIENT_SECRET?: SecretsStoreSecret;
  /** Owner-once refresh token — Secrets Store async binding; read on every refresh, never replaced. */
  GOOGLE_REFRESH_TOKEN?: SecretsStoreSecret;
}

/** The shape Google's token endpoint returns for the authorization-code exchange. */
export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

function requireVar(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Google OAuth misconfigured: ${name} is not set in [vars]`);
  }
  return value;
}

/**
 * Build the owner-once Google authorize URL. The owner clicks this ONCE; Google returns a
 * `code` to `GOOGLE_REDIRECT_URI`, which `exchangeCode` swaps for the refresh token.
 *
 * Caller supplies `state` (CSRF/round-trip binding) and the S256 PKCE `codeChallenge`
 * (the BASE64URL(SHA-256(codeVerifier)) the caller computed); `exchangeCode` later presents
 * the matching `codeVerifier`.
 *
 * The query string MUST carry every offline/consent/PKCE flag below — omitting
 * `access_type=offline` or `prompt=consent` means Google returns NO refresh token.
 */
export function googleAuthorizeUrl(env: GoogleOAuthEnv, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: requireVar(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
    redirect_uri: requireVar(env.GOOGLE_REDIRECT_URI, "GOOGLE_REDIRECT_URI"),
    scope: GOOGLE_SCOPE_FLOOR.join(" "),
    // Without offline + consent Google issues NO refresh token (CLAUDE.md gotcha).
    access_type: "offline",
    prompt: "consent",
    // Layer the new floor scopes on top of any previously-granted scopes.
    include_granted_scopes: "true",
    // S256 PKCE (OAuth 2.1) — the token endpoint rejects the exchange without the matching verifier.
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${GOOGLE_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/**
 * Exchange the owner-once authorization `code` for tokens. Reads the confidential client secret
 * from Secrets Store (PKCE does NOT remove the need for it — this is a Web-application client).
 * Returns `{ access_token, refresh_token, expires_in, ... }`. The CALLER persists the returned
 * `refresh_token` into Secrets Store (`google-refresh-token`) — this helper never writes it
 * anywhere itself (no token value touches D1/KV/logs/Vault/Codex).
 */
export async function exchangeCode(
  env: GoogleOAuthEnv,
  code: string,
  codeVerifier: string,
): Promise<GoogleTokenResponse> {
  const clientSecret = await env.GOOGLE_CLIENT_SECRET?.get();
  if (!clientSecret) {
    throw new Error("Google OAuth misconfigured: GOOGLE_CLIENT_SECRET Secrets Store binding empty");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: requireVar(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
    client_secret: clientSecret,
    redirect_uri: requireVar(env.GOOGLE_REDIRECT_URI, "GOOGLE_REDIRECT_URI"),
    code_verifier: codeVerifier,
  });
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    // Surface only the HTTP status — NEVER the response body (it can echo back the code/secret).
    throw new Error(`Google code exchange failed: ${res.status}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

/**
 * Mint a FRESH short-lived Google access token from the stored refresh token — WITHOUT
 * re-consent. Reads both the refresh token and the client secret from Secrets Store.
 *
 * The refresh response NEVER returns a new refresh token; this helper returns only the new
 * `access_token` and does NOT touch the stored refresh token (it keeps the ORIGINAL — the
 * Secrets Store entry is never rewritten here). Per-run tokens are never persisted.
 */
export async function googleAccessToken(env: GoogleOAuthEnv): Promise<string> {
  const [refreshToken, clientSecret] = await Promise.all([
    env.GOOGLE_REFRESH_TOKEN?.get(),
    env.GOOGLE_CLIENT_SECRET?.get(),
  ]);
  if (!refreshToken) {
    throw new Error("Google OAuth misconfigured: GOOGLE_REFRESH_TOKEN Secrets Store binding empty");
  }
  if (!clientSecret) {
    throw new Error("Google OAuth misconfigured: GOOGLE_CLIENT_SECRET Secrets Store binding empty");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: requireVar(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
    client_secret: clientSecret,
  });
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${res.status}`);
  }
  const json = (await res.json()) as GoogleTokenResponse;
  // Return ONLY the fresh access token. We deliberately ignore any `refresh_token` in the
  // response (Google does not send one on refresh) and never rewrite the stored credential —
  // the original refresh token is the durable one.
  return json.access_token;
}
