/**
 * GitHub App — outbound (SPINE-04, Plan 00-06, Wave 4).
 *
 * Atlas authenticates to GitHub as a GitHub App (NOT a PAT — Envoy's Phase-4 README writes
 * use scoped, revocable, per-repo installation tokens). The flow is two-legged:
 *   1. `appJwt(env)`  — a short-lived RS256 JWT signed with the App's private key (the App
 *      proves it is the App). `iss` = the App client id, `iat` backdated ~60s (clock-skew
 *      tolerance), `exp` <= 10 minutes (GitHub rejects longer).
 *   2. `installationToken(env, id, ...)` — POSTs that JWT to GitHub's
 *      `/app/installations/{id}/access_tokens`, down-scoped via `repositories`/`permissions`,
 *      returning the opaque `ghs_…` installation token (~1h).
 *
 * HARD invariants (CLAUDE.md "GitHub App" gotcha + threat register T-00-24):
 *   - The private key is read ONLY via the Secrets Store async binding
 *     (`await env.GH_APP_PRIVATE_KEY.get()`); it is never logged or persisted.
 *   - The installation token is OPAQUE — minted PER RUN, NEVER persisted to any store, and
 *     NEVER parsed/split (treated as a bearer string only).
 *   - The App client id (`iss`) is a plaintext [vars] identifier, NOT a secret.
 */

import { SignJWT, importPKCS8 } from "jose";
import type { Env as SharedEnv } from "@atlas/shared";

const GITHUB_API = "https://api.github.com";

/** The GitHub App env surface this module reads. */
export interface GitHubAppEnv extends SharedEnv {
  /** Plaintext GitHub App client id used as the JWT `iss` (a [vars] value, NOT a secret). */
  GH_APP_CLIENT_ID?: string;
  /** The App's RS256 PKCS8 private key — Secrets Store async binding (never logged/persisted). */
  GH_APP_PRIVATE_KEY?: SecretsStoreSecret;
}

/** Per-call down-scoping for an installation token (RFC of least privilege at the GitHub door). */
export interface InstallationTokenOptions {
  /** Restrict the token to these repositories (by name). Omit = the App's full installation scope. */
  repositories?: string[];
  /** Restrict the token to these permissions, e.g. `{ contents: "write", metadata: "read" }`. */
  permissions?: Record<string, string>;
}

function requireVar(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`GitHub App misconfigured: ${name} is not set in [vars]`);
  }
  return value;
}

/**
 * Mint a short-lived RS256 App JWT (jose). `iss` = the App client id, `iat` backdated 60s to
 * tolerate clock skew between Atlas and GitHub, `exp` = iat + 9 minutes (<= GitHub's 10-minute
 * ceiling). The private key is imported from the Secrets Store PKCS8 PEM and never leaves memory.
 */
export async function appJwt(env: GitHubAppEnv): Promise<string> {
  const pem = await env.GH_APP_PRIVATE_KEY?.get();
  if (!pem) {
    throw new Error("GitHub App misconfigured: GH_APP_PRIVATE_KEY Secrets Store binding empty");
  }
  const clientId = requireVar(env.GH_APP_CLIENT_ID, "GH_APP_CLIENT_ID");
  const privateKey = await importPKCS8(pem, "RS256");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const issuedAt = nowSeconds - 60; // backdate 60s for clock skew
  const expiresAt = issuedAt + 9 * 60; // 9 min => well within GitHub's 10-min max

  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(clientId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(privateKey);
}

/**
 * Exchange the App JWT for an opaque `ghs_…` installation token (~1h), down-scoped via
 * `repositories`/`permissions`. Minted PER RUN — the caller uses it immediately and discards
 * it; it is NEVER persisted to D1/KV/Vault/Codex and NEVER parsed (returned as an opaque string).
 */
export async function installationToken(
  env: GitHubAppEnv,
  installationId: string | number,
  options: InstallationTokenOptions = {},
): Promise<string> {
  const jwt = await appJwt(env);

  const body: Record<string, unknown> = {};
  if (options.repositories) body.repositories = options.repositories;
  if (options.permissions) body.permissions = options.permissions;

  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "atlas-orchestrator",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Status only — never the response body (it carries the freshly-minted token on success
    // and can echo request detail on failure).
    throw new Error(`GitHub installation token mint failed: ${res.status}`);
  }
  const json = (await res.json()) as { token: string };
  // Treat the token as OPAQUE — return it verbatim, never split/parse it, never store it.
  return json.token;
}
