/**
 * auth.ts — Constant-time token comparison for the Flagger /ack endpoint (WEEKLY-02, Plan 02-02 Task 3).
 *
 * Copied verbatim from apps/mcp-obsidian-bridge/src/auth.ts (SPINE-05 pattern).
 * Uses HMAC-SHA-256 under a fresh random key so neither the token VALUE nor its LENGTH
 * leaks through response timing (length-independent constant-time compare).
 *
 * Security invariant: the token is NEVER written to any log, audit row, or output stream.
 * crypto.timingSafeEqual is NOT available in Workers — this HMAC approach is the
 * canonical constant-time equality primitive for Cloudflare Workers.
 */

/**
 * Length-independent constant-time string equality. HMAC-SHA-256 both inputs under a
 * fresh random key and compare the 32-byte digests. Content- and length-independent
 * (the digest is fixed-size and not precomputable). Fail-closed: returns false on any error.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
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
