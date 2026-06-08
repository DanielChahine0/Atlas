/**
 * auth.ts — Constant-time token comparison + SHA-256 hashing for the gate primitive (D4-04).
 *
 * Copied verbatim from apps/flagger/src/auth.ts (WEEKLY-02 pattern) — the HMAC-SHA-256
 * constant-time equality is the project's canonical Workers implementation.
 * crypto.timingSafeEqual is NOT available in Workers — this HMAC approach is the
 * proven substitute.
 *
 * Security invariant: token values are NEVER written to any log, audit row, or output stream.
 * sha256 is used for storing only the token HASH in D1 (never the plaintext).
 */

/**
 * Length-independent constant-time string equality. HMAC-SHA-256 both inputs under a
 * fresh random key and compare the 32-byte digests. Content- and length-independent
 * (the digest is fixed-size and not precomputable). Fail-closed: returns false on any error.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  try {
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
  } catch {
    // Fail-closed: any crypto error returns false
    return false;
  }
}

/**
 * SHA-256 hash of the input string. Returns a lowercase 64-char hex string.
 * Used for storing the token hash in D1 — the plaintext token is NEVER persisted.
 */
export async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
