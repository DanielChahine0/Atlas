/**
 * Owner-session primitives for the OAuth auth surface (SPINE-04 hardening, post-review).
 *
 * The `/authorize` consent surface authenticates NOBODY on its own — so before this hardening
 * an attacker who reached `/authorize` could complete authorization AS THE OWNER. We gate the
 * consent surface behind an owner session: `/login` constant-time-compares a submitted token
 * against the `OWNER_AUTH_TOKEN` Secrets Store binding and, on match, issues a signed, HttpOnly,
 * Secure, SameSite=Strict, short-TTL session cookie. `/authorize` requires a valid session.
 *
 * The cookie is an HMAC-SHA-256 signed payload (`<base64url(payload)>.<base64url(sig)>`); the
 * payload carries an absolute `exp` (epoch seconds) so a stolen-then-expired cookie is rejected
 * even before the cookie's own Max-Age elapses. The signing key is `SESSION_SIGNING_KEY` if set,
 * else HKDF-derived from `OWNER_AUTH_TOKEN` (so a single owner secret suffices). No secret value
 * is ever logged or rendered.
 *
 * Web Crypto (`crypto.subtle`, `crypto.getRandomValues`) is global in workerd.
 */

/** The session cookie name. */
export const SESSION_COOKIE = "atlas_session";

/** Session lifetime (seconds) — short by design; the owner authorizes once per session. */
export const SESSION_TTL_SECONDS = 900; // 15 minutes

interface SessionPayload {
  /** Subject — the single owner. */
  sub: string;
  /** Absolute expiry, epoch seconds. */
  exp: number;
}

const encoder = new TextEncoder();

/** base64url-encode bytes (no padding) — URL/cookie safe. */
function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url-decode to bytes. */
function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Length-independent constant-time compare (Round-2 hardening). A naive `max(lenA, lenB)` loop
 * leaks the longer input's length via its iteration count. Instead we HMAC-SHA-256 BOTH inputs
 * under a fresh ephemeral random key and compare the fixed 32-byte digests — the comparison cost
 * is identical regardless of input length OR content, and an attacker can't precompute a digest
 * (the key is random per call). Applied to the OWNER_AUTH_TOKEN compare, the session-signature
 * compare, and the CSRF compare.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const ephemeral = new Uint8Array(32);
  crypto.getRandomValues(ephemeral);
  const key = await crypto.subtle.importKey("raw", ephemeral, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const [da, db] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(a)),
    crypto.subtle.sign("HMAC", key, encoder.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  // Both digests are exactly 32 bytes — fixed-length, content+length-independent compare.
  // (`?? 0` keeps strict noUncheckedIndexedAccess happy without changing the fixed-cost loop.)
  let diff = va.length ^ vb.length;
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}

/** Generate an opaque random id (consent id / CSRF token). Randomness is REQUIRED here. */
export function randomId(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

/**
 * Derive the HMAC signing key. Prefers `SESSION_SIGNING_KEY`; else HKDF-SHA-256 from
 * `OWNER_AUTH_TOKEN` (so the owner can provision a single secret). Throws if neither is set —
 * fail-closed (no session can be minted/verified without a key).
 */
async function signingKey(env: {
  SESSION_SIGNING_KEY?: SecretsStoreSecret;
  OWNER_AUTH_TOKEN?: SecretsStoreSecret;
}): Promise<CryptoKey> {
  const explicit = await env.SESSION_SIGNING_KEY?.get();
  if (explicit) {
    return crypto.subtle.importKey("raw", encoder.encode(explicit), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  }
  const ownerToken = await env.OWNER_AUTH_TOKEN?.get();
  if (!ownerToken) {
    throw new Error("Session misconfigured: neither SESSION_SIGNING_KEY nor OWNER_AUTH_TOKEN is set");
  }
  // HKDF-derive an HMAC key from the owner token (so a separate signing key is optional).
  const ikm = await crypto.subtle.importKey("raw", encoder.encode(ownerToken), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("atlas-session-v1"), info: encoder.encode("hmac") },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

async function hmacSign(key: CryptoKey, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

/**
 * Mint a signed session cookie VALUE (`<payload>.<sig>`) for the owner, expiring in
 * `SESSION_TTL_SECONDS`. The caller wraps it in a Set-Cookie with the hardened attributes.
 */
export async function issueSession(
  env: { SESSION_SIGNING_KEY?: SecretsStoreSecret; OWNER_AUTH_TOKEN?: SecretsStoreSecret },
  sub = "owner",
): Promise<string> {
  const payload: SessionPayload = { sub, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const encoded = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await signingKey(env);
  const sig = await hmacSign(key, encoded);
  return `${encoded}.${sig}`;
}

/**
 * Verify a session cookie value. Returns the payload if the signature is valid (constant-time)
 * AND the payload is unexpired; null otherwise. Never throws on a malformed/forged cookie.
 */
export async function verifySession(
  env: { SESSION_SIGNING_KEY?: SecretsStoreSecret; OWNER_AUTH_TOKEN?: SecretsStoreSecret },
  cookieValue: string | undefined,
): Promise<SessionPayload | null> {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  let key: CryptoKey;
  try {
    key = await signingKey(env);
  } catch {
    return null; // fail-closed if the signing key is unprovisioned
  }
  const expected = await hmacSign(key, encoded);
  if (!(await timingSafeEqual(sig, expected))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(encoded))) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Build the hardened Set-Cookie header for the session cookie. */
export function sessionSetCookie(value: string): string {
  return (
    `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`
  );
}

/** Parse a single cookie value out of a request's Cookie header. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
