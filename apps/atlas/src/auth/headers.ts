/**
 * Shared security headers for the OAuth auth surface (SPINE-04 hardening, post-review).
 *
 * Every consent + login HTML response carries the same hardened header set:
 *   - `Content-Security-Policy: frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'`
 *     — clickjacking + injection defense-in-depth (the page loads no scripts/objects/frames).
 *   - `X-Frame-Options: DENY` — clickjacking belt-and-suspenders for older agents.
 *   - `Referrer-Policy: no-referrer` — never leak the authorize URL (with its OAuth params) to a
 *     downstream origin.
 *   - `Cache-Control: no-store` — the consent/login pages carry single-use CSRF + consent ids;
 *     they must never be cached.
 */

/** The hardened header set shared by every auth-surface HTML response. */
export const AUTH_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/**
 * Build a Response that carries the hardened auth-surface headers. Callers pass the body, the
 * status, and any extra headers (e.g. `content-type`, `set-cookie`, `location`); the security
 * headers are always merged in (and take precedence — a caller cannot weaken `cache-control`).
 */
export function authResponse(
  body: BodyInit | null,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(AUTH_SECURITY_HEADERS)) headers.set(k, v);
  return new Response(body, { status: init.status ?? 200, headers });
}

/** An HTML auth-surface response (sets `content-type: text/html` + the hardened headers). */
export function authHtmlResponse(
  html: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return authResponse(html, {
    status: init.status,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}
