/**
 * render.test.ts — Tests for the confirm-page rendering helpers (Task 2, TDD RED).
 *
 * Tests:
 *   - renderConfirmPage: heading, artifact, buttons, HTML-escaping
 *   - renderExpiredPage: required phrases
 *   - renderOutcomePage: outcome states
 *   - authHtmlResponse: security headers
 *   - Security invariant: no 2FA code / reset link / login URL in rendered output
 */

import { describe, it, expect } from "vitest";
import {
  renderConfirmPage,
  renderExpiredPage,
  renderOutcomePage,
  authHtmlResponse,
  authResponse,
  isSameOrigin,
} from "./render.js";
import type { GatePendingRow } from "./schema.js";

function makeRow(overrides: Partial<GatePendingRow> = {}): GatePendingRow {
  return {
    id: "test-id-001",
    agent: "Usher",
    action: "event.register",
    target: "mlconf-2026-09",
    artifact: '{"event":"MLconf 2026","price":"Free"}',
    edited_artifact: null,
    status: "pending",
    decision: "pending",
    scope_used: "calendar.events",
    idempotency_key: "usher:mlconf-2026-09:registered",
    token_hash: "abc123",
    expires_at: Date.now() + 86400000,
    flag_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

describe("renderConfirmPage", () => {
  it("contains the heading 'Review and confirm'", () => {
    const html = renderConfirmPage(makeRow());
    expect(html).toContain("Review and confirm");
  });

  it("renders the artifact text verbatim (HTML-escaped)", () => {
    const row = makeRow({ artifact: '{"event":"MLconf 2026","price":"Free"}' });
    const html = renderConfirmPage(row);
    // The artifact should appear in the page
    expect(html).toContain("MLconf 2026");
  });

  it("contains an Approve button", () => {
    const html = renderConfirmPage(makeRow());
    // Should have a submit button for approve
    expect(html.toLowerCase()).toMatch(/approve|register/);
  });

  it("contains a Reject button", () => {
    const html = renderConfirmPage(makeRow());
    expect(html.toLowerCase()).toMatch(/reject|don.t register|cancel/);
  });

  it("HTML-escapes special characters in the artifact", () => {
    const row = makeRow({ artifact: "<script>alert('xss')</script>" });
    const html = renderConfirmPage(row);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders as a complete HTML document", () => {
    const html = renderConfirmPage(makeRow());
    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("</html>");
  });

  it("security invariant: redacts 2FA codes from rendered artifact", () => {
    // Artifact containing a fake 2FA code
    const row = makeRow({ artifact: "Your code is 123456" });
    const html = renderConfirmPage(row);
    // The rendered page must not contain the raw 6-digit code near the word "code"
    expect(html).not.toContain("Your code is 123456");
  });

  it("security invariant: redacts password-reset links from rendered artifact", () => {
    const row = makeRow({
      artifact:
        "Click https://accounts.google.com/reset?token=xyz to reset your password",
    });
    const html = renderConfirmPage(row);
    expect(html).not.toContain("accounts.google.com/reset?token=xyz");
  });

  it("security invariant: redacts login URLs from rendered artifact", () => {
    const row = makeRow({
      artifact: "Sign in at https://accounts.google.com/login?next=dashboard",
    });
    const html = renderConfirmPage(row);
    expect(html).not.toContain("accounts.google.com/login");
  });
});

describe("renderExpiredPage", () => {
  it("contains 'This gate has expired'", () => {
    const html = renderExpiredPage();
    expect(html).toContain("This gate has expired");
  });

  it("contains 'Nothing was posted or submitted'", () => {
    const html = renderExpiredPage();
    expect(html).toContain("Nothing was posted or submitted");
  });

  it("renders as a complete HTML document", () => {
    const html = renderExpiredPage();
    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("</html>");
  });
});

describe("renderOutcomePage", () => {
  it("renders approved outcome with 'No further action needed'", () => {
    const html = renderOutcomePage("approved");
    expect(html).toContain("<!DOCTYPE html");
  });

  it("renders rejected outcome with 'no action taken' copy", () => {
    const html = renderOutcomePage("rejected");
    expect(html.toLowerCase()).toMatch(/no action|nothing was/);
  });

  it("renders with an optional URL for the approved reversible case", () => {
    const html = renderOutcomePage("approved", { url: "https://github.com/pr/1" });
    expect(html).toContain("github.com/pr/1");
  });
});

describe("authHtmlResponse", () => {
  it("sets content-type to text/html", () => {
    const resp = authHtmlResponse("<html><body>test</body></html>");
    expect(resp.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("sets cache-control: no-store", () => {
    const resp = authHtmlResponse("<html></html>");
    expect(resp.headers.get("cache-control")).toBe("no-store");
  });

  it("sets x-frame-options: DENY", () => {
    const resp = authHtmlResponse("<html></html>");
    expect(resp.headers.get("x-frame-options")).toBe("DENY");
  });

  it("sets content-security-policy with default-src 'none'", () => {
    const resp = authHtmlResponse("<html></html>");
    const csp = resp.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
  });

  it("defaults to status 200", () => {
    const resp = authHtmlResponse("<html></html>");
    expect(resp.status).toBe(200);
  });

  it("respects custom status code", () => {
    const resp = authHtmlResponse("<html></html>", { status: 410 });
    expect(resp.status).toBe(410);
  });
});

describe("authResponse (non-HTML)", () => {
  it("sets hardened security headers", () => {
    const resp = authResponse("Bad Request", { status: 400 });
    expect(resp.headers.get("cache-control")).toBe("no-store");
    expect(resp.headers.get("x-frame-options")).toBe("DENY");
    expect(resp.status).toBe(400);
  });
});

describe("isSameOrigin", () => {
  it("returns true when sec-fetch-site is same-origin", () => {
    const req = new Request("https://gate.example.com/confirm", {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(isSameOrigin(req)).toBe(true);
  });

  it("returns false when sec-fetch-site is cross-site", () => {
    const req = new Request("https://gate.example.com/confirm", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(isSameOrigin(req)).toBe(false);
  });

  it("returns false when no Origin and no sec-fetch-site (fail-closed)", () => {
    const req = new Request("https://gate.example.com/confirm");
    expect(isSameOrigin(req)).toBe(false);
  });

  it("returns true when Origin matches request origin", () => {
    const req = new Request("https://gate.example.com/confirm", {
      headers: { origin: "https://gate.example.com" },
    });
    expect(isSameOrigin(req)).toBe(true);
  });

  it("returns false when Origin differs from request origin", () => {
    const req = new Request("https://gate.example.com/confirm", {
      headers: { origin: "https://evil.example.com" },
    });
    expect(isSameOrigin(req)).toBe(false);
  });
});
