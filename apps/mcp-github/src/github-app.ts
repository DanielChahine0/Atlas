/**
 * GitHub App token minting (mcp-github) — mirrors apps/atlas/src/oauth/github.ts
 * (00-06). The GitHub MCP authenticates to GitHub as a GitHub App (NOT a PAT): a
 * short-lived RS256 App JWT proves it is the App, exchanged per-call for an opaque
 * `ghs_…` installation token (~1h), down-scoped via repositories/permissions.
 *
 * HARD invariants (CLAUDE.md "GitHub App" gotcha + threat register T-00-32):
 *   - The private key is read ONLY via the Secrets Store async binding
 *     (`await env.GH_APP_PRIVATE_KEY.get()`); never logged or persisted.
 *   - The installation token is OPAQUE — minted PER RUN, NEVER persisted, NEVER
 *     parsed/split, and NEVER returned to the MCP client (only the RESULT of a
 *     GitHub call is returned; the bearer credential stays server-side).
 *   - The App client id (`iss`) is a plaintext [vars] identifier, NOT a secret.
 */

import { SignJWT, importPKCS8 } from "jose";

const GITHUB_API = "https://api.github.com";

/** The GitHub App env surface this module reads. */
export interface GitHubAppEnv {
  /** Plaintext GitHub App client id used as the JWT `iss` (a [vars] value, NOT a secret). */
  GH_APP_CLIENT_ID?: string;
  /** The installation id (a [vars] value, NOT a secret). */
  GH_APP_INSTALLATION_ID?: string;
  /** The App's RS256 PKCS8 private key — Secrets Store async binding (never logged/persisted). */
  GH_APP_PRIVATE_KEY?: SecretsStoreSecret;
}

export interface InstallationTokenOptions {
  repositories?: string[];
  permissions?: Record<string, string>;
}

function requireVar(value: string | undefined, name: string): string {
  if (!value) throw new Error(`GitHub App misconfigured: ${name} is not set in [vars]`);
  return value;
}

/**
 * Mint a short-lived RS256 App JWT (jose). `iss` = the App client id, `iat`
 * backdated 60s (clock-skew), `exp` = iat + 9 minutes (<= GitHub's 10-minute max).
 * The private key never leaves memory.
 */
export async function appJwt(env: GitHubAppEnv): Promise<string> {
  const pem = await env.GH_APP_PRIVATE_KEY?.get();
  if (!pem) {
    throw new Error("GitHub App misconfigured: GH_APP_PRIVATE_KEY Secrets Store binding empty");
  }
  const clientId = requireVar(env.GH_APP_CLIENT_ID, "GH_APP_CLIENT_ID");
  const privateKey = await importPKCS8(pem, "RS256");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const issuedAt = nowSeconds - 60;
  const expiresAt = issuedAt + 9 * 60;

  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(clientId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(privateKey);
}

/**
 * Exchange the App JWT for an opaque `ghs_…` installation token, down-scoped via
 * repositories/permissions. Minted PER RUN — used immediately and discarded; NEVER
 * persisted, NEVER parsed, NEVER returned to the MCP client.
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
    // Status only — never the response body (it carries the freshly-minted token on success).
    throw new Error(`GitHub installation token mint failed: ${res.status}`);
  }
  const json = (await res.json()) as { token: string };
  // Treat the token as OPAQUE — return it verbatim to the caller, never split/parse/store it.
  return json.token;
}
