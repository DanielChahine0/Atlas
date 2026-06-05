/**
 * The OAuth scope allow-list — the SINGLE source of truth (SPINE-04, Round-2 hardening).
 *
 * Round-1 advertised this list as `scopesSupported` on the provider and CALLED it "the FLOOR",
 * but @cloudflare/workers-oauth-provider 0.7.2 uses `scopesSupported` ONLY for RFC-8414 metadata
 * advertising — it does NOT reject or clamp a requested scope at authorize time. `parseAuthRequest`
 * reads `?scope=` verbatim from the URL, so an over-broad request (e.g. the full
 * `https://mail.google.com/` that CLAUDE.md says is NEVER granted, or `vault.write`) would flow
 * straight into the grant and into `ctx.props.scopes` — the effective door-level authority in
 * Phase 0. The floor is therefore ENFORCED in `auth/consent.ts` against this exact list (both on
 * the authorize GET and again before `completeAuthorization` on POST), and the SAME array is
 * passed to the provider as `scopesSupported` so the advertised metadata and the enforced floor
 * can never drift.
 *
 * Enforcement REJECTS an out-of-allow-list scope (HTTP 400 invalid_scope) rather than silently
 * downscoping — an over-broad request must be visible and auditable, not quietly trimmed.
 */

/** The least-privilege scope allow-list. gmail.modify (NOT the full mail.google.com/),
 *  calendar.events (NOT the bare calendar scope) — the per-agent floor (docs/11 §3). */
export const SCOPES_SUPPORTED: readonly string[] = [
  "gmail.modify",
  "calendar.events",
  "calendar.readonly",
  "drive.file",
  "drive.readonly",
  "spreadsheets",
  "github.read",
  "github.write",
  "vault.write",
];

const ALLOWED = new Set(SCOPES_SUPPORTED);

/**
 * Return the subset of `requested` that is NOT in the allow-list. An empty array means every
 * requested scope is allowed. Callers REJECT (do not downscope) when this is non-empty.
 */
export function disallowedScopes(requested: readonly string[]): string[] {
  return requested.filter((s) => !ALLOWED.has(s));
}

/** True iff every requested scope is in the allow-list. */
export function scopesAllowed(requested: readonly string[]): boolean {
  return disallowedScopes(requested).length === 0;
}
