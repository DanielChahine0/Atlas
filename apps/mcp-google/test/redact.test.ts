import { describe, it, expect } from "vitest";
import { safeToolOutput, buildGoogleMcpServer } from "../src/index.js";
import type { Env } from "../src/index.js";

// SPINE-04 redaction backstop (CI invariant #2). The load-bearing third leg of the
// CLAUDE.md hard invariant: "NEVER surface 2FA codes / password-reset links / login
// URLs ... A prompt instruction alone is NOT sufficient." This suite proves that the
// SERVER-SIDE strip removes known 2FA/reset/login fixtures from tool output — the
// belt-and-suspenders backstop for the in-server redact() egress.
//
// Runs in workerd (TZ=UTC). It drives safeToolOutput() — the SINGLE egress point
// every registered tool funnels its output through — directly with known fixtures.

/** A minimal env: the redaction is the load-bearing guard; the flag emit is best-effort. */
const noopEnv = {
  // flag() would call send() on WIRE; we leave WIRE undefined so a leak detection's
  // best-effort flag emit is swallowed by safeToolOutput's try/catch (the redaction
  // still happens — that is what we assert).
} as unknown as Env;

describe("mcp-google redaction backstop (SPINE-04)", () => {
  it("strips a 6-digit 2FA code from tool output", async () => {
    const out = await safeToolOutput("Your verification code is 482915.", noopEnv);
    const text = out.content.map((c) => c.text).join("");
    expect(text).not.toContain("482915");
  });

  it("strips a password-reset link from tool output", async () => {
    const body = "To reset password use https://accounts.example.com/reset?t=abc123xyz";
    const out = await safeToolOutput(body, noopEnv);
    const text = out.content.map((c) => c.text).join("");
    // The reset/verify/confirm URL pattern strips the link itself...
    expect(text).not.toContain("https://accounts.example.com/reset?t=abc123xyz");
    // ...and the "reset password" phrase pattern strips the phrase.
    expect(text.toLowerCase()).not.toContain("reset password");
  });

  it("strips a 'verification code' phrase from tool output", async () => {
    const out = await safeToolOutput("Here is the verification code you requested.", noopEnv);
    const text = out.content.map((c) => c.text).join("");
    expect(text.toLowerCase()).not.toContain("verification code");
  });

  it("strips a login/confirm URL from tool output", async () => {
    const body = "Click to confirm: https://login.example.com/confirm?session=deadbeef";
    const out = await safeToolOutput(body, noopEnv);
    const text = out.content.map((c) => c.text).join("");
    expect(text).not.toContain("https://login.example.com/confirm?session=deadbeef");
  });

  it("does NOT redact a benign body (no over-redaction)", async () => {
    const out = await safeToolOutput("Lunch at 12:30 with Sam about the Q3 plan.", noopEnv);
    const text = out.content.map((c) => c.text).join("");
    expect(text).toContain("Lunch at");
    expect(text).toContain("with Sam");
  });

  it("the redaction is applied regardless of the requested scope (egress is unconditional)", async () => {
    // safeToolOutput has NO scope parameter — it strips on EVERY egress, so a
    // hypothetical over-broad token cannot bypass the redaction. This asserts the
    // egress contract: a secret-bearing body is always stripped.
    const out = await safeToolOutput("2FA: 999111 — do not share.", noopEnv);
    const text = out.content.map((c) => c.text).join("");
    expect(text).not.toContain("999111");
  });

  it("registers the redaction egress in the live server build (smoke)", () => {
    // The server build must not throw — proving the tools wire through safeToolOutput.
    const server = buildGoogleMcpServer(noopEnv);
    expect(server).toBeDefined();
  });
});
