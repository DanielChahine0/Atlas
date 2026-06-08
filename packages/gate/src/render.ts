/**
 * render.ts — Server-rendered HTML pages for the gate confirm surface (D4-04).
 *
 * Security:
 *   - Every response routes through authHtmlResponse() / authResponse() which attach
 *     AUTH_SECURITY_HEADERS (CSP default-src 'none', x-frame-options DENY, no-store).
 *   - All artifact content passes redact() from @atlas/security before interpolation
 *     (defense-in-depth against 2FA codes / reset links / login URLs leaking into HTML).
 *   - esc() HTML-escapes all dynamic strings before rendering.
 *   - No external scripts or fonts are loaded (CSP default-src 'none').
 *
 * Pattern: mirrors apps/atlas/src/auth/consent.ts (template-literal HTML) + headers.ts.
 */

import { redact } from "@atlas/security";
import type { GatePendingRow } from "./schema.js";

// ─── Hardened response helpers (copied from apps/atlas/src/auth/headers.ts) ──

/** The hardened header set shared by every auth-surface HTML response. */
export const AUTH_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/**
 * Build a Response that carries the hardened auth-surface headers.
 * Callers pass the body, the status, and any extra headers; the security
 * headers are always merged in (and take precedence).
 */
export function authResponse(
  body: BodyInit | null,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(AUTH_SECURITY_HEADERS)) headers.set(k, v);
  return new Response(body, { status: init.status ?? 200, headers });
}

/** An HTML auth-surface response (sets content-type: text/html + hardened headers). */
export function authHtmlResponse(
  html: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return authResponse(html, {
    status: init.status,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}

// ─── isSameOrigin (copied from apps/atlas/src/auth/consent.ts) ───────────────

/** True if the request originates same-origin (Origin / Sec-Fetch-Site). Fail-closed. */
export function isSameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  // Sec-Fetch-Site is the strongest signal when present.
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) return secFetchSite === "same-origin";
  // Fall back to Origin; reject if it disagrees with the request origin.
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  // No Origin AND no Sec-Fetch-Site → cannot prove same-origin → reject (fail-closed).
  return false;
}

// ─── HTML escape helper ───────────────────────────────────────────────────────

/** HTML-escape untrusted strings before rendering (copied from consent.ts). */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format epoch ms as a human-readable expiry string (owner-local Toronto time). */
function formatExpiry(expiresAt: number): string {
  const now = Date.now();
  const msLeft = expiresAt - now;
  if (msLeft <= 0) return "expired";
  const hLeft = Math.floor(msLeft / 3_600_000);
  const mLeft = Math.floor((msLeft % 3_600_000) / 60_000);
  if (hLeft < 1) return `${mLeft}m`;
  return `${hLeft}h ${mLeft}m`;
}

// ─── Inline styles (per 04-UI-SPEC.md) ───────────────────────────────────────

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 16px;
    line-height: 1.6;
    color: #111827;
    background: #fff;
    margin: 0;
    padding: 0 16px 32px;
  }
  .page { max-width: 480px; margin: 0 auto; }
  .header {
    display: flex; justify-content: space-between; align-items: center;
    background: #F3F4F6; padding: 12px 16px; margin: 0 -16px 24px;
    font-size: 14px; font-weight: 600;
  }
  .expiry { font-size: 12px; color: #6B7280; }
  .expiry.soon { color: #B45309; }
  h1 { font-size: 20px; font-weight: 600; line-height: 1.3; margin: 0 0 8px; }
  .summary { margin: 0 0 16px; color: #374151; }
  .badge {
    display: inline-block; font-size: 11px; font-weight: 600;
    padding: 2px 8px; border-radius: 4px; margin-left: 8px; vertical-align: middle;
  }
  .badge-irreversible { background: #FEE2E2; color: #B91C1C; }
  .badge-reversible   { background: #DCFCE7; color: #15803D; }
  .badge-registration { background: #FEF9C3; color: #B45309; }
  .artifact-zone {
    background: #F3F4F6; padding: 16px; border-radius: 6px;
    margin-bottom: 24px; overflow-x: auto;
  }
  .artifact-zone pre {
    font-family: monospace; font-size: 14px; line-height: 1.5;
    white-space: pre-wrap; margin: 0;
  }
  .meta { font-size: 14px; color: #6B7280; margin-bottom: 24px; }
  .controls { display: flex; flex-direction: column; gap: 12px; }
  .btn-approve {
    background: #1D4ED8; color: #fff; border: none; border-radius: 6px;
    font-size: 16px; font-weight: 600; min-height: 44px; width: 100%;
    cursor: pointer; padding: 8px 16px;
    outline: none;
  }
  .btn-approve:focus-visible { outline: 2px solid #1D4ED8; outline-offset: 2px; }
  .btn-reject {
    background: #fff; color: #B91C1C; border: 1.5px solid #B91C1C; border-radius: 6px;
    font-size: 16px; font-weight: 600; min-height: 44px; width: 100%;
    cursor: pointer; padding: 8px 16px;
    outline: none;
  }
  .btn-reject:focus-visible { outline: 2px solid #B91C1C; outline-offset: 2px; }
  .outcome-banner {
    padding: 16px; border-radius: 6px; margin-bottom: 24px;
    font-weight: 600; font-size: 16px;
  }
  .outcome-success { background: #DCFCE7; color: #15803D; }
  .outcome-neutral  { background: #F3F4F6; color: #374151; }
  .outcome-warning  { background: #FEF9C3; color: #B45309; }
  .outcome-expired  { color: #6B7280; }
  .detail { font-size: 14px; color: #374151; margin-top: 8px; }
  a { color: #1D4ED8; }
`;

// ─── Page renderers ───────────────────────────────────────────────────────────

/**
 * Render the gate confirm page for a pending gate row.
 * Applies redact() to the artifact before interpolation (security invariant: no 2FA/reset/login).
 */
export function renderConfirmPage(row: GatePendingRow): string {
  const expiryStr = formatExpiry(row.expires_at);
  const expiryIso = new Date(row.expires_at).toISOString();
  const isSoon = row.expires_at - Date.now() < 3_600_000; // < 1h

  // Apply redact() to the artifact BEFORE interpolating into HTML (T-04-04)
  const safeArtifact = redact(esc(row.artifact));

  // Reversibility badge based on action type
  let badgeHtml = "";
  if (row.agent === "Envoy") {
    badgeHtml = `<span class="badge badge-irreversible">IRREVERSIBLE — you click Post</span>`;
  } else if (row.agent === "Usher") {
    badgeHtml = `<span class="badge badge-registration">REGISTRATION — auto-submits after confirm</span>`;
  } else if (row.agent === "Sundial") {
    badgeHtml = `<span class="badge badge-reversible">REVERSIBLE — can be re-added</span>`;
  }

  // Action label on approve button
  const approveLabel =
    row.agent === "Usher"
      ? `Register for ${esc(row.target)}`
      : row.agent === "Envoy"
        ? "Approve — I'll click Post"
        : "Approve";

  const rejectLabel =
    row.agent === "Usher"
      ? "Don't register"
      : "Cancel — take no action";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Atlas — confirm ${esc(row.action)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <span>Atlas · ${esc(row.agent)}</span>
      <span class="expiry${isSoon ? " soon" : ""}">
        Expires in <time datetime="${expiryIso}">${expiryStr}</time>
        — after that, no action will be taken.
      </span>
    </div>

    <h1>Review and confirm${badgeHtml}</h1>
    <p class="summary">
      ${esc(row.agent === "Usher"
        ? `You're about to register for ${row.target}. This will submit your details automatically.`
        : row.agent === "Envoy"
          ? "You're about to publish. Review the draft below before confirming."
          : `You're about to confirm: ${row.action} for ${row.target}.`
      )}
    </p>

    <div class="artifact-zone">
      <pre>${safeArtifact}</pre>
    </div>

    <div class="meta">
      Target: <strong>${esc(row.target)}</strong> &middot;
      Agent: ${esc(row.agent)} &middot;
      Action: ${esc(row.action)}
    </div>

    <form method="POST" action="/confirm">
      <input type="hidden" name="decision" value="">
      <div class="controls">
        <button type="submit"
          class="btn-approve"
          onclick="this.form.decision.value='approve'"
        >${approveLabel}</button>
        <button type="submit"
          class="btn-reject"
          onclick="this.form.decision.value='reject'"
        >${rejectLabel}</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

/**
 * Render the post-decision outcome page.
 * Shows a success, neutral, or warning banner based on the decision.
 */
export function renderOutcomePage(
  decision: string,
  detail?: { url?: string; confirmation?: string; price?: string },
): string {
  let heading: string;
  let body: string;
  let bannerClass: string;

  switch (decision) {
    case "approved":
      heading = "Action confirmed";
      body = detail?.url
        ? `The action completed successfully. <a href="${esc(detail.url)}">View result</a>.`
        : detail?.confirmation
          ? `Registration confirmed. Confirmation #${esc(detail.confirmation)}.`
          : "Your request was approved. No further action needed.";
      bannerClass = "outcome-success";
      break;
    case "rejected":
      heading = "No action taken";
      body = "You chose not to proceed. Nothing was posted or submitted.";
      bannerClass = "outcome-neutral";
      break;
    case "expired":
      heading = "This gate has expired";
      body = "The confirmation window closed before a decision was made. Nothing was posted or submitted.";
      bannerClass = "outcome-expired";
      break;
    default:
      heading = "Something went wrong";
      body = "The gate encountered an error. No action was taken.";
      bannerClass = "outcome-neutral";
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Atlas — ${esc(heading)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <span>Atlas</span>
    </div>
    <div class="outcome-banner ${bannerClass}">
      ${esc(heading)}
    </div>
    <div class="detail">${body}</div>
  </div>
</body>
</html>`;
}

/**
 * Render the expired gate page (served as 410 Gone when the token's gate is past expires_at).
 */
export function renderExpiredPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Atlas — gate expired</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <span>Atlas</span>
    </div>
    <h1 class="outcome-expired">This gate has expired</h1>
    <p>The confirmation window closed before a decision was made.</p>
    <p>Nothing was posted or submitted.</p>
  </div>
</body>
</html>`;
}
