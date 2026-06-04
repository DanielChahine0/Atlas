/**
 * The redaction primitive — the load-bearing backstop for the CLAUDE.md security invariant:
 * "NEVER surface 2FA codes / password-reset links / login URLs anywhere ... A prompt
 * instruction alone is NOT sufficient." (T-00-22, Information Disclosure.)
 *
 * This is defense-in-depth WITH the Google MCP server-side strip (00-08) and the Herald
 * digest-builder guardrail (Phase 1). It lands now (Phase 0) as a shared primitive so Herald
 * inherits it in Phase 1 (the digest builder does not exist yet).
 *
 * IMPORTANT: this module imports NOTHING from the Wire / Queue / Cloudflare bindings. It must
 * stay reusable inside the STATELESS Google MCP server (00-08). A caller that detects a leak
 * raises a P1 (block + flag) via `@atlas/shared` `flag(env, "P1", "secret-exposure-blocked",
 * detail?)` — but the primitive itself never reaches for the Wire.
 *
 * Patterns are intentionally NARROW (docs/00-PATTERNS.md line 252) — a 6-digit code, a
 * reset/verify/confirm URL, and two phrase patterns. Over-redaction (a rare benign 6-digit
 * match) is an accepted residual risk (T-00-26): losing a stray number is fail-safe vs leaking
 * a 2FA code. The benign-fixture test guards against gross over-redaction.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\b\d{6}\b/, // 2FA / verification 6-digit code
  /reset[-_ ]?(password|link)/i, // "reset password" / "reset-link" phrase
  /verification code/i, // "verification code" phrase
  /https?:\/\/\S*\/(reset|verify|confirm)\S*/i, // reset/verify/confirm (login) URL
];

const MASK = "[REDACTED]";

/**
 * Replace every SECRET_PATTERNS match with the mask token. Each pattern is applied GLOBALLY
 * (every occurrence), so a 2FA code, a reset link, a verification-code phrase, and a
 * login/confirm URL are each removed from the returned string.
 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
    out = out.replace(new RegExp(pattern.source, flags), MASK);
  }
  return out;
}

/**
 * True iff any SECRET_PATTERNS match — the signal a caller maps to a P1 block-and-flag.
 * Uses a fresh, non-stateful test per pattern (no shared lastIndex from a `g` flag).
 */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) =>
    new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text),
  );
}
