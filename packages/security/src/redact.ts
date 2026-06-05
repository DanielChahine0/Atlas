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
 * --- Pattern strategy (revised after the 00 review C3/C4/W10) ---
 *
 * The original patterns were too narrow (a bare `\b\d{6}\b`, a `reset|verify|confirm` URL only,
 * two phrase patterns) and leaked: 7/8-digit and spaced/dashed codes, full-width-digit codes,
 * login/signin/magic-link/SSO URLs, and the `OTP`/`one-time passcode`/`security code` phrases.
 *
 * Two classes of digit pattern, deliberately split to balance fail-safe redaction against
 * over-redaction (T-00-26 / I24):
 *   - ALWAYS-ON (formatted codes): clearly-formatted code shapes (3-3 / 3-4 / 3-5 groupings
 *     with a space or dash separator) are redacted unconditionally — a `482 913` or `482-9137`
 *     run almost never appears in benign prose and reads as a code.
 *   - PROXIMITY-GATED (bare runs): a bare 6–8 digit run is redacted ONLY when a code cue
 *     (code / OTP / passcode / verification / verify / 2fa) appears within ~20 chars. This keeps
 *     a benign `Order #483920` (no cue nearby) intact while `your code is 483920` is stripped.
 *
 * Full-width digits (U+FF10–U+FF19) are normalized to ASCII BEFORE matching so a `４８２９１３`
 * code cannot slip past an ASCII-only `\d`.
 *
 * Over-redaction of a rare benign formatted-number is an accepted residual risk (T-00-26):
 * losing a stray number is fail-safe vs leaking a 2FA code. The benign-fixture tests guard
 * against gross over-redaction.
 */

const MASK = "[REDACTED]";

/** Code cue tokens that gate the bare-digit-run branch (proximity cue, ~20 chars). */
const CODE_CUE = "(?:code|otp|passcode|verification|verify|2fa)";

/**
 * The canonical pattern set, authored WITHOUT the `g` flag (source of truth for both
 * `containsSecret` via `.test()` and the global redactor). The `g` variants are derived once
 * at module load (see `REDACT_PATTERNS`). NOTE: a pattern that needs a proximity cue without
 * consuming/redacting it uses a lookbehind/lookahead so only the digit run is masked.
 */
const BASE_PATTERNS: readonly RegExp[] = [
  // --- Sensitive URL patterns FIRST (C4: login/signin/auth/magic/SSO paths + token/otp/code/ticket
  // query markers). These run BEFORE the bare phrase patterns so the WHOLE URL (including its
  // opaque token value) is masked as a unit — otherwise the `\bOTP\b` phrase below would mask
  // the `otp=` query KEY first, hiding the marker from the URL pattern and leaking the value. ---
  // reset / verify / confirm path (original).
  /https?:\/\/\S*\/(?:reset|verify|confirm)\S*/i,
  // login / signin / sign-in / auth / sso / magic path (the invariant explicitly names login URLs).
  /https?:\/\/\S*\/(?:login|signin|sign-in|auth|sso|magic)\S*/i,
  // ANY URL carrying a token/otp/code/ticket query marker (magic-link / SSO ticket).
  /https?:\/\/\S*[?&](?:token|otp|code|ticket)=\S*/i,

  // --- Formatted codes (ALWAYS-ON): grouped digit runs that read as a code. ---
  // 3-3, 3-4, or 3-5 with a single space or dash separator: `482 913`, `482-9137`, `123 45678`.
  /\b\d{3}[-\s]\d{3,5}\b/,

  // --- Bare digit runs (PROXIMITY-GATED): 6–8 contiguous digits with a code cue within ~20 chars. ---
  // Cue-before: "your code is 483920", "OTP: 4829137".
  new RegExp(`(?<=${CODE_CUE}[\\s\\S]{0,20})\\b\\d{6,8}\\b`, "i"),
  // Cue-after: "483920 is your code".
  new RegExp(`\\b\\d{6,8}\\b(?=[\\s\\S]{0,20}${CODE_CUE})`, "i"),

  // --- Reset / verification phrase patterns (W10: broadened separators + OTP/passcode/security code). ---
  // "reset password" / "reset-link" / double-spaced "reset  password" (loosened separator).
  /reset[-_\s]+(password|link)/i,
  // "verification code" phrase.
  /verification code/i,
  // "one-time passcode" / "one time code" / bare "passcode" / "OTP" / "security code".
  /one[-\s]?time[-\s]?(?:pass)?code|passcode|\bOTP\b|security code/i,
];

/**
 * Frozen, pre-built pattern arrays (I22 — the redactor runs on EVERY mcp-google egress, a hot
 * path; recompiling a fresh RegExp per call per pattern was wasteful).
 *
 * - `TEST_PATTERNS`: no `g` flag → safe for `.test()` (no `lastIndex` statefulness).
 * - `REDACT_PATTERNS`: `g` flag forced → `String.prototype.replace` walks every occurrence.
 *
 * We never call `.test()` / `.exec()` on a `g`-flagged pattern (which would carry `lastIndex`
 * between calls); `containsSecret` uses `TEST_PATTERNS` and `redact` uses `.replace`, so neither
 * leaks regex state across calls.
 */
const TEST_PATTERNS: readonly RegExp[] = Object.freeze(
  BASE_PATTERNS.map((p) => Object.freeze(p)) as RegExp[],
);

const REDACT_PATTERNS: readonly RegExp[] = Object.freeze(
  BASE_PATTERNS.map(
    (p) => new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g"),
  ),
);

/**
 * The canonical pattern set (no `g`), exported for tests/introspection. Mutation-safe (frozen).
 */
export const SECRET_PATTERNS: readonly RegExp[] = TEST_PATTERNS;

/** Normalize full-width ASCII digits (U+FF10–U+FF19) to ASCII so `\d` can match them. */
function normalizeDigits(text: string): string {
  return text.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30),
  );
}

/**
 * Replace every SECRET_PATTERNS match with the mask token. Each pattern is applied GLOBALLY
 * (every occurrence). Full-width digits are normalized first so a `４８２９１３` code is caught.
 */
export function redact(text: string): string {
  let out = normalizeDigits(text);
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, MASK);
  }
  return out;
}

/**
 * True iff any SECRET_PATTERNS match — the signal a caller maps to a P1 block-and-flag.
 * Uses the non-`g` `TEST_PATTERNS` so there is no shared `lastIndex` state between calls.
 * Normalizes full-width digits first to stay in lockstep with `redact`.
 */
export function containsSecret(text: string): boolean {
  const normalized = normalizeDigits(text);
  return TEST_PATTERNS.some((pattern) => pattern.test(normalized));
}
