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
 * --- Pattern strategy (revised after the 00 review C3/C4/W10, hardened after the full-width-CJK leak) ---
 *
 * The original patterns were too narrow (a bare `\b\d{6}\b`, a `reset|verify|confirm` URL only,
 * two phrase patterns) and leaked: 7/8-digit and spaced/dashed codes, full-width-digit codes,
 * login/signin/magic-link/SSO URLs, and the `OTP`/`one-time passcode`/`security code` phrases.
 *
 * Hardened again (NEW-MH2) against URL bypasses where the sensitive token rides in the URL
 * FRAGMENT (after `#`, e.g. an OAuth implicit-flow `#access_token=…` or `#otp=…`) — which the
 * query-marker rule (`[?&]…=`) never sees — or as an opaque high-entropy PATH segment under a
 * magic/login-ish prefix with no keyword path (`/m/AbC123dEf456`). Both are anchored on the token
 * keyword / magic prefix so ordinary anchor fragments (`#section-2`) and word slugs are not
 * over-redacted.
 *
 * THREE classes of digit pattern, deliberately split to balance fail-safe redaction against
 * over-redaction (T-00-26 / I24):
 *   - FULL-WIDTH origin (ALWAYS-ON, no cue): a run of 6–8 FULL-WIDTH digits (U+FF10–U+FF19) in
 *     the ORIGINAL text is redacted UNCONDITIONALLY — full-width digit runs are a strong 2FA
 *     signal and benign full-width 6–8 digit numbers in prose are vanishingly rare. This closes
 *     the leak where `コード ４８２９１３` (a non-English / CJK code context) normalized to ASCII
 *     `482913` but then escaped the cue-gated branch (the cue "コード" is not English). Detected on
 *     the PRE-normalization text; the normalized run is what gets masked.
 *   - ALWAYS-ON (formatted codes): clearly-formatted code shapes (3-3 / 3-4 / 3-5 groupings
 *     with a space or dash separator) are redacted unconditionally — a `482 913` or `482-9137`
 *     run almost never appears in benign prose and reads as a code.
 *   - PROXIMITY-GATED (bare ASCII runs): a bare ASCII 6–8 digit run is redacted ONLY when a code
 *     cue (see CODE_CUE) appears within ~20 chars. This keeps a benign `Order #483920` (no cue
 *     nearby) and a year range intact while `your code is 483920` is stripped.
 *
 * INTENTIONAL NON-COVERAGE: a bare ASCII 6–8 digit run with NO nearby cue is intentionally NOT
 * redacted, to avoid masking order numbers / years / tracking IDs (the `Order #483920` and
 * year-range controls guard this). That is an accepted residual: the PRIMARY 2FA defense is the
 * upstream `Type/Security` WHOLESALE body strip in mcp-google (00-08), which removes the entire
 * security-mail body server-side regardless of scope. THIS regex is the defense-in-depth
 * BACKSTOP, not the sole gate — so erring toward ASCII-number precision here is acceptable.
 *
 * Over-redaction of a rare benign formatted-number is an accepted residual risk (T-00-26):
 * losing a stray number is fail-safe vs leaking a 2FA code. The benign-fixture tests guard
 * against gross over-redaction.
 */

const MASK = "[REDACTED]";

/**
 * Code cue tokens that gate the bare-ASCII-digit-run branch (proximity cue, ~20 chars).
 * Broadened (hardening) beyond the original code/otp/verification set so common code contexts
 * aren't missed: pin / token / passcode / mfa / 2fa / auth / security / one-time / login /
 * sign-in / access. (Full-width-origin runs do NOT depend on this list — see below.)
 */
const CODE_CUE =
  "(?:code|otp|verification|verify|pin|token|passcode|mfa|2fa|auth|security|one[-\\s]?time|login|sign[-\\s]?in|access)";

/**
 * A run of 6–8 FULL-WIDTH digits (U+FF10–U+FF19). Detected on the ORIGINAL (pre-normalization)
 * text and redacted UNCONDITIONALLY — full-width origin is itself a strong code signal, so no
 * proximity cue is required (this is what closes the CJK-context full-width leak). Authored with
 * `g` for the redact walk; a non-`g` clone is used for the `.test()` in `containsSecret`.
 */
const FULLWIDTH_CODE_RUN = /[０-９]{6,8}/g;

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
  // FRAGMENT-delivered token (NEW-MH2): an OAuth implicit-flow / magic-link token in the URL
  // FRAGMENT (after `#`) bypasses the query-marker rule above (which only sees `?`/`&`). Anchor
  // on `#…<keyword>=` so an ordinary anchor fragment (`#section-2`) is NOT over-redacted — only a
  // fragment carrying a sensitive token KEY is masked. Covers `#access_token=`, `#id_token=`,
  // `#token=`, `#otp=`, `#code=`, `#ticket=`, and the same keys after a `&` inside the fragment.
  /https?:\/\/\S*#\S*(?:access_token|id_token|token|otp|code|ticket)=\S*/i,
  // OPAQUE-PATH magic/login link (NEW-MH2): a token delivered as a high-entropy PATH segment with
  // NO query/fragment marker and NO keyword path (e.g. `https://example.com/m/AbC123dEf456`). We
  // anchor CONSERVATIVELY on a short magic/login-ish path prefix (`/m/`, `/l/`, `/magic/`,
  // `/login/`, `/auth/`, `/verify/`, `/confirm/`, `/invite/`) IMMEDIATELY followed by an opaque
  // token: ≥12 chars of URL-safe token alphabet that contains BOTH a letter and a digit (a
  // high-entropy signal), so a short/word segment like `/m/cart` is NOT redacted by THIS rule,
  // and an opaque token under a non-magic prefix (`/items/AbC123dEf456`) is left intact.
  /https?:\/\/\S*\/(?:m|l|magic|login|auth|verify|confirm|invite)\/(?=[\w-]{12,})(?=[\w-]*[A-Za-z])(?=[\w-]*\d)[\w-]+/i,

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
 * Replace every SECRET_PATTERNS match with the mask token. Order of operations:
 *   1. FULL-WIDTH-origin pass FIRST, on the ORIGINAL text — any 6–8 full-width digit run is
 *      masked UNCONDITIONALLY (no cue), closing the CJK-context leak. Because the run is replaced
 *      with the (ASCII) mask, the subsequent normalization can't resurrect it.
 *   2. Normalize remaining full-width digits to ASCII (so a SHORT full-width run adjacent to an
 *      English cue, or a full-width formatted shape, still feeds the ASCII patterns).
 *   3. Apply the ASCII pattern set globally.
 */
export function redact(text: string): string {
  let out = text.replace(FULLWIDTH_CODE_RUN, MASK);
  out = normalizeDigits(out);
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, MASK);
  }
  return out;
}

/**
 * True iff a secret pattern matches — the signal a caller maps to a P1 block-and-flag.
 * Mirrors `redact`'s order: a full-width 6–8 digit run in the ORIGINAL text is an unconditional
 * hit; otherwise normalize and test the ASCII pattern set. Uses non-`g` `.test()` (a fresh clone
 * for the full-width run) so there is no shared `lastIndex` state between calls.
 */
export function containsSecret(text: string): boolean {
  if (/[０-９]{6,8}/.test(text)) return true;
  const normalized = normalizeDigits(text);
  return TEST_PATTERNS.some((pattern) => pattern.test(normalized));
}
