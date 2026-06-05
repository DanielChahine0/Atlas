/**
 * Bridge auth — the ATLAS_BRIDGE_TOKEN bearer gate (SPINE-05, T-00-33).
 *
 * Both /bridge/poll and /bridge/ack require `Authorization: Bearer <ATLAS_BRIDGE_TOKEN>`.
 * The token is read ONLY via the Secrets Store async binding (await env.X.get()); the
 * compare is constant-time (length-independent: HMAC both inputs under a fresh ephemeral
 * key, compare the fixed-size digests) so neither the token VALUE nor its LENGTH leaks
 * through response timing.
 */

export interface BridgeAuthEnv {
  /** The long-poll bearer — Secrets Store async binding. */
  ATLAS_BRIDGE_TOKEN?: SecretsStoreSecret;
}

/**
 * Length-independent constant-time string equality. HMAC-SHA-256 both inputs under a
 * fresh random key and compare the 32-byte digests. Content- and length-independent
 * (the digest is fixed-size and not precomputable). Same primitive family the OAuth
 * front door uses (00-06 P5).
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const da = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

/** Extract the Bearer token from the Authorization header (null if absent/malformed). */
function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * Authorize a bridge request. Returns true ONLY if the presented Bearer token
 * constant-time-equals the seeded ATLAS_BRIDGE_TOKEN. A missing binding or a
 * missing/wrong token fails closed (false → the handler returns 401).
 */
export async function authorizeBridge(request: Request, env: BridgeAuthEnv): Promise<boolean> {
  const expected = await env.ATLAS_BRIDGE_TOKEN?.get();
  if (!expected) return false; // fail-closed: no token configured ⇒ no access
  const presented = bearer(request);
  if (!presented) return false;
  return await timingSafeEqual(presented, expected);
}

/** A 401 response for a missing/wrong bridge token. */
export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
  });
}
