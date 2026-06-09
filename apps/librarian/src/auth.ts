/**
 * Librarian auth — the ATLAS_LIBRARIAN_TOKEN Bearer gate (T-5-Auth).
 *
 * POST /prompt/save requires `Authorization: Bearer <ATLAS_LIBRARIAN_TOKEN>`.
 * The token is read ONLY via the Secrets Store async binding (await env.X.get()); the
 * compare is constant-time (length-independent: HMAC both inputs under a fresh ephemeral
 * key, compare the fixed-size digests) imported from @atlas/gate so neither the token
 * VALUE nor its LENGTH leaks through response timing.
 *
 * Fail-closed: returns false on ANY error path — missing binding, wrong token,
 * missing header, or any unexpected error. Never pass-through.
 *
 * Security invariant: the token value is NEVER logged and NEVER written to any D1 row,
 * KV key, Wire payload, audit_log row, or output stream.
 */

import { timingSafeEqual } from "@atlas/gate";

export interface LibrarianAuthEnv {
  /** The Librarian Bearer secret — Secrets Store async binding. */
  ATLAS_LIBRARIAN_TOKEN?: SecretsStoreSecret;
}

/** Extract the Bearer token from the Authorization header (null if absent/malformed). */
function bearer(request: Request): string | null {
  const header =
    request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * Authorize a POST /prompt/save request. Returns true ONLY if the presented Bearer token
 * constant-time-equals the seeded ATLAS_LIBRARIAN_TOKEN. A missing binding or a
 * missing/wrong token fails closed (false → the handler returns 401).
 *
 * Auth runs BEFORE body parse (T-5-Auth: reject unauthenticated requests before any
 * body processing to avoid DoS via large-body parsing).
 */
export async function authorizeSave(
  request: Request,
  env: LibrarianAuthEnv,
): Promise<boolean> {
  const expected = await env.ATLAS_LIBRARIAN_TOKEN?.get();
  if (!expected) return false; // fail-closed: no token configured ⇒ no access
  const presented = bearer(request);
  if (!presented) return false;
  return await timingSafeEqual(presented, expected);
}

/** A 401 response for a missing/wrong Librarian token. */
export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
  });
}
