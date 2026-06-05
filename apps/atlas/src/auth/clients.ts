/**
 * Out-of-band OAuth client seeding (SPINE-04, Round-2 hardening; plan decision D4).
 *
 * Round-1 set `disallowPublicClientRegistration: true`, but that blocks only PUBLIC clients —
 * the (now-removed) `clientRegistrationEndpoint` still accepted ANONYMOUS CONFIDENTIAL-client
 * registration, letting an attacker register a confidential client with THEIR OWN redirect_uri
 * and phish the authenticated owner into approving it (the code/token would land at the attacker).
 *
 * Fix (D4 — confidential clients via the Workers OAuth Provider, registered out-of-band): the
 * provider exposes no public registration endpoint at all; instead Atlas seeds its known clients
 * (the local daemon + each MCP client) directly into OAUTH_KV at startup via the provider's
 * `createClient` helper (`getOAuthApi(options, env)` gives the `OAuthHelpers` outside a request).
 * No unauthenticated party can register any client.
 *
 * The client registry (id + redirect_uris + name per client) is an OWNER-provisioned, non-secret
 * value supplied via the `CLIENT_REGISTRY` [vars] JSON — declared-and-deferred (Gate C), NOT
 * fabricated here. If `CLIENT_REGISTRY` is unset, seeding is a no-op (the spine still builds; the
 * owner seeds it when the daemon/MCP redirect URIs are known). Seeding is idempotent: an already
 * present clientId is left as-is.
 */

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { AtlasEnv } from "../env.js";

/** A single registry entry (the non-secret part of an out-of-band client registration). */
interface ClientRegistryEntry {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
}

/** The env surface seeding reads — the CLIENT_REGISTRY [vars] JSON (non-secret). */
interface ClientSeedEnv extends AtlasEnv {
  /** Owner-provisioned JSON array of { clientId, redirectUris, clientName } (a [vars] value). */
  CLIENT_REGISTRY?: string;
}

/**
 * Seed the out-of-band confidential clients into OAUTH_KV (idempotent). Called once at startup.
 * `providerOptions` MUST be the same options object passed to `new OAuthProvider(...)` so the
 * helper reads/writes the same KV namespace + crypto config.
 */
export async function ensureSeededClients(
  env: ClientSeedEnv,
  providerOptions: OAuthProviderOptions<AtlasEnv>,
): Promise<void> {
  const raw = env.CLIENT_REGISTRY;
  if (!raw) return; // declared-and-deferred: no registry yet → nothing to seed (no-op)

  let entries: ClientRegistryEntry[];
  try {
    entries = JSON.parse(raw) as ClientRegistryEntry[];
  } catch {
    // A malformed registry must NOT crash the Worker; skip seeding (fail-safe, not fail-open —
    // an unseeded client simply can't authorize, the conservative outcome).
    return;
  }
  if (!Array.isArray(entries)) return;

  const api = getOAuthApi(providerOptions, env);
  for (const entry of entries) {
    if (!entry?.clientId || !Array.isArray(entry.redirectUris)) continue;
    const existing = await api.lookupClient(entry.clientId);
    if (existing) continue; // idempotent: already seeded
    await api.createClient({
      clientId: entry.clientId,
      redirectUris: entry.redirectUris,
      clientName: entry.clientName ?? entry.clientId,
      // Confidential client (tokenEndpointAuthMethod default); the provider stores a secret hash.
    });
  }
}

export type { ClientRegistryEntry, ClientSeedEnv };
