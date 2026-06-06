// apps/echo/src/auth.ts
//
// Capture-app auth — the ECHO_CAPTURE_TOKEN bearer gate for the Echo cloud surface.
//
// The LOCAL macOS capture daemon authenticates OUTBOUND to the Echo Worker (the laptop
// has NO inbound port). Every cloud endpoint the daemon hits — the presign endpoint here,
// and the EchoSession WebSocket — must verify the daemon's bearer CRYPTOGRAPHICALLY
// against the seeded ECHO_CAPTURE_TOKEN. This MIRRORS the reviewed token-gate pattern in
// `apps/mcp-obsidian-bridge/src/auth.ts` (the other outbound-daemon door): the token is
// read ONLY via the Secrets Store async binding (await env.X.get()), and the compare is
// constant-time (length-independent: HMAC both inputs under a fresh ephemeral key, compare
// the fixed-size digests) so neither the token VALUE nor its LENGTH leaks via response timing.
//
// SECURITY (Pillar 2 — fail-safe, never fail-open):
//   - A missing binding, a missing bearer, or a wrong bearer ALL fail closed (→ 401).
//   - Scopes are derived SERVER-SIDE from the verified identity (ECHO_CAPTURE_SCOPES),
//     NEVER from a client-supplied header. A client cannot grant itself a scope.
//   - In production the granted scope set is what the Atlas OAuthProvider attaches to the
//     capture client's token; until that OAuth-client wiring lands (an owner go-live gate)
//     the verified capture client's scopes are the server-configured ECHO_CAPTURE_SCOPES
//     (default `echo:presign`, its sole least-privilege capability). The token gate is the
//     hard authentication floor regardless.

/** A Secrets Store async binding: `await env.X.get()` resolves to the secret value. */
interface SecretBinding {
  get(): Promise<string>;
}

/** The narrow env surface the capture-token gate needs. */
export interface CaptureAuthEnv {
  /** The capture-app bearer — Secrets Store async binding. */
  ECHO_CAPTURE_TOKEN?: SecretBinding;
  /**
   * Space-delimited scopes granted to the verified capture client (server-side, NOT
   * client-supplied). Defaults to the capture client's sole capability when unset.
   */
  ECHO_CAPTURE_SCOPES?: string;
}

/** The verified capture client's sole least-privilege capability. */
export const ECHO_PRESIGN_SCOPE = "echo:presign";

/**
 * Length-independent constant-time string equality. HMAC-SHA-256 both inputs under a
 * fresh random key and compare the 32-byte digests. Content- and length-independent
 * (the digest is fixed-size and not precomputable). Same primitive the OAuth front door
 * and the Obsidian bridge use.
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
export function bearer(request: Request): string | null {
  const header =
    request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() || null : null;
}

/**
 * Authenticate a capture-app request. Returns true ONLY if the presented Bearer token
 * constant-time-equals the seeded ECHO_CAPTURE_TOKEN. A missing binding or a
 * missing/wrong token fails closed (false → the handler returns 401).
 */
export async function authenticateCapture(
  request: Request,
  env: CaptureAuthEnv,
): Promise<boolean> {
  const expected = await env.ECHO_CAPTURE_TOKEN?.get();
  if (!expected) return false; // fail-closed: no token configured ⇒ no access
  const presented = bearer(request);
  if (!presented) return false;
  return await timingSafeEqual(presented, expected);
}

/**
 * The scopes granted to the verified capture client — read SERVER-SIDE from
 * ECHO_CAPTURE_SCOPES, NEVER from a client header. Defaults to the capture client's sole
 * capability (`echo:presign`) when the var is unset. An explicitly empty/other value
 * produces an empty set, exercising the fail-closed 403 scope path (T-03-02-03).
 */
export function grantedCaptureScopes(env: CaptureAuthEnv): Set<string> {
  const raw = env.ECHO_CAPTURE_SCOPES ?? ECHO_PRESIGN_SCOPE;
  return new Set(raw.split(" ").filter(Boolean));
}
