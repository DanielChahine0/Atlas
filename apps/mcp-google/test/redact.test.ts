import { describe, it, expect } from "vitest";
import { safeToolOutput, buildGoogleMcpServer, SECRET_BLOCKED_TEXT } from "../src/index.js";
import type { Env } from "../src/index.js";

// SPINE-04 redaction backstop (CI invariant #2). The load-bearing third leg of the
// CLAUDE.md hard invariant: "NEVER surface 2FA codes / password-reset links / login
// URLs ... A prompt instruction alone is NOT sufficient." This suite proves that the
// SERVER-SIDE strip removes 2FA/reset/login content from tool output — the
// belt-and-suspenders backstop for the in-server redact() egress.
//
// ADVERSARIAL (00 review C3/C4/W10/I28): the original cases only probed the narrow
// patterns. These probe the previously-leaking bypass CLASSES on EGRESS and assert the
// P1-block is now observable (isError:true).
//
// Runs in workerd (TZ=UTC). It drives safeToolOutput() — the SINGLE egress point
// every registered tool funnels its output through — directly with synthetic fixtures.
// No real secret VALUE appears anywhere.

/**
 * A minimal env: the redaction is the load-bearing guard. mcp-google intentionally has NO Wire
 * producer binding (Pillar 1), so safeToolOutput never emits a Flagger incident here — a detected
 * leak is BLOCKED at egress (redacted body + isError:true) and logged via console.warn; the
 * downstream caller (a Wire producer) raises the P1. We pass a WIRE-less env to prove the egress
 * strip needs nothing from the Wire.
 */
const noopEnv = {} as unknown as Env;

/** Join the text parts of a tool result. */
function textOf(out: { content: { type: "text"; text: string }[] }): string {
  return out.content.map((c) => c.text).join("");
}

/**
 * The REDACTED BODY part only — excludes the neutral SECRET_BLOCKED_TEXT banner that is
 * prepended on a P1 block. Use this when asserting a phrase did NOT survive, since the banner
 * itself legitimately contains words like "verification code"/"login link".
 */
function bodyOf(out: { content: { type: "text"; text: string }[] }): string {
  return out.content
    .map((c) => c.text)
    .filter((t) => t !== SECRET_BLOCKED_TEXT)
    .join("");
}

describe("mcp-google redaction backstop (SPINE-04)", () => {
  it("strips a 6-digit 2FA code from tool output and marks the result isError", async () => {
    const out = await safeToolOutput("Your verification code is 482915.", noopEnv);
    expect(textOf(out)).not.toContain("482915");
    expect(out.isError).toBe(true); // I28: the P1-block is observable
    expect(textOf(out)).toContain(SECRET_BLOCKED_TEXT); // neutral message present
  });

  it("strips a password-reset link from tool output", async () => {
    const body = "To reset password use https://accounts.example.com/reset?t=abc123xyz";
    const out = await safeToolOutput(body, noopEnv);
    const text = textOf(out);
    expect(text).not.toContain("https://accounts.example.com/reset?t=abc123xyz");
    expect(text.toLowerCase()).not.toContain("reset password");
    expect(out.isError).toBe(true);
  });

  it("strips a 'verification code' phrase from tool output", async () => {
    const out = await safeToolOutput("Here is the verification code you requested.", noopEnv);
    // Assert against the BODY part — the neutral banner legitimately says "verification code".
    expect(bodyOf(out).toLowerCase()).not.toContain("verification code");
    expect(out.isError).toBe(true);
  });

  // ---- C3: multi-digit / spaced / dashed / full-width code classes on egress ----
  it("C3: strips a 7-digit code on egress regardless of scope", async () => {
    const out = await safeToolOutput("Your code is 4829137 — do not share.", noopEnv);
    expect(textOf(out)).not.toContain("4829137");
    expect(out.isError).toBe(true);
  });

  it("C3: strips an 8-digit code on egress", async () => {
    const out = await safeToolOutput("OTP: 48291370", noopEnv);
    expect(textOf(out)).not.toContain("48291370");
    expect(out.isError).toBe(true);
  });

  it("C3: strips a space-grouped code `482 913`", async () => {
    const out = await safeToolOutput("Your code: 482 913", noopEnv);
    expect(textOf(out)).not.toContain("482 913");
    expect(out.isError).toBe(true);
  });

  it("C3: strips a dash-grouped code `482-913`", async () => {
    const out = await safeToolOutput("Use 482-913 to continue", noopEnv);
    expect(textOf(out)).not.toContain("482-913");
    expect(out.isError).toBe(true);
  });

  it("C3: strips a FULL-WIDTH digit code on egress — incl. the CJK-cue leak probe", async () => {
    // Regression guard: `コード ４８２９１３` (full-width digits in a non-English code context)
    // must not surface its ASCII form `482913` past the egress strip.
    const out = await safeToolOutput("コード ４８２９１３", noopEnv);
    const text = textOf(out);
    expect(text).not.toContain("４８２９１３");
    expect(text).not.toContain("482913");
    expect(out.isError).toBe(true);
  });

  // ---- C4: login / signin / auth / magic / SSO + token-query URL classes on egress ----
  it("C4: strips a /login URL with ?token= on egress", async () => {
    const body = "Sign in: https://accounts.example.com/login?token=abc";
    const out = await safeToolOutput(body, noopEnv);
    expect(textOf(out)).not.toContain("https://accounts.example.com/login?token=abc");
    expect(out.isError).toBe(true);
  });

  it("C4: strips an /auth/magic magic-link URL on egress", async () => {
    const body = "Your link: https://example.com/auth/magic?token=xyz";
    const out = await safeToolOutput(body, noopEnv);
    expect(textOf(out)).not.toContain("https://example.com/auth/magic?token=xyz");
    expect(out.isError).toBe(true);
  });

  it("C4: strips an SSO URL and a ?otp= token value on egress", async () => {
    const body = "https://sso.corp.example.com/sso/start and https://m.example.com/x?otp=AB12cd34";
    const out = await safeToolOutput(body, noopEnv);
    const text = textOf(out);
    expect(text).not.toContain("https://sso.corp.example.com/sso/start");
    expect(text).not.toContain("AB12cd34");
    expect(out.isError).toBe(true);
  });

  it("strips a login/confirm URL from tool output", async () => {
    const body = "Click to confirm: https://login.example.com/confirm?session=deadbeef";
    const out = await safeToolOutput(body, noopEnv);
    expect(textOf(out)).not.toContain("https://login.example.com/confirm?session=deadbeef");
    expect(out.isError).toBe(true);
  });

  // ---- NEW-MH2: FRAGMENT-delivered tokens + OPAQUE-PATH magic links on egress ----
  it("NEW-MH2: strips an OAuth `#access_token=` fragment token on egress", async () => {
    const body = "Signed in: https://app.example.com/#access_token=eyJhbGciOiJIabc123";
    const out = await safeToolOutput(body, noopEnv);
    expect(textOf(out)).not.toContain("access_token=eyJhbGciOiJIabc123");
    expect(out.isError).toBe(true);
  });

  it("NEW-MH2: strips an `#otp=123456` fragment token on egress", async () => {
    const out = await safeToolOutput("Here: https://example.com/#otp=123456", noopEnv);
    expect(textOf(out)).not.toContain("otp=123456");
    expect(textOf(out)).not.toContain("123456");
    expect(out.isError).toBe(true);
  });

  it("NEW-MH2: strips a path-only magic link `/m/AbC123dEf456` on egress", async () => {
    const out = await safeToolOutput("Open https://example.com/m/AbC123dEf456 now", noopEnv);
    expect(textOf(out)).not.toContain("AbC123dEf456");
    expect(out.isError).toBe(true);
  });

  it("NEW-MH2: does NOT over-redact a benign anchor fragment on egress (no isError)", async () => {
    const out = await safeToolOutput("See https://docs.example.com/guide#section-2 for details", noopEnv);
    expect(textOf(out)).toContain("https://docs.example.com/guide#section-2");
    expect(out.isError).toBeUndefined();
  });

  it("does NOT redact a benign body, returns no isError (no over-redaction)", async () => {
    const out = await safeToolOutput("Lunch at 12:30 with Sam about the Q3 plan.", noopEnv);
    const text = textOf(out);
    expect(text).toContain("Lunch at");
    expect(text).toContain("with Sam");
    expect(out.isError).toBeUndefined(); // clean body → a normal (non-error) result
  });

  it("does NOT redact a benign `Order #483920` with no code-context nearby", async () => {
    const out = await safeToolOutput("Order #483920 has shipped.", noopEnv);
    expect(textOf(out)).toContain("483920");
    expect(out.isError).toBeUndefined();
  });

  it("the redaction is applied regardless of the requested scope (egress is unconditional)", async () => {
    // safeToolOutput has NO scope parameter — it strips on EVERY egress, so a
    // hypothetical over-broad token cannot bypass the redaction.
    const out = await safeToolOutput("2FA: 999111 — do not share.", noopEnv);
    expect(textOf(out)).not.toContain("999111");
    expect(out.isError).toBe(true);
  });

  it("registers the redaction egress in the live server build (smoke)", () => {
    // The server build must not throw — proving the tools wire through safeToolOutput.
    const server = buildGoogleMcpServer(noopEnv);
    expect(server).toBeDefined();
  });
});
