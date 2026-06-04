import { describe, it, expect } from "vitest";
import { redact, containsSecret, SECRET_PATTERNS } from "../src/index.js";

// THE CI-BACKSTOP TEST (CLAUDE.md Definition of Done — second CI invariant). This is the
// load-bearing assertion behind the security invariant: "a prompt instruction alone is NOT
// sufficient." A real source assertion proves no 2FA code / reset link / login URL survives.

describe("SECRET_PATTERNS — the redaction backstop", () => {
  it("ships the four required patterns", () => {
    expect(SECRET_PATTERNS.length).toBe(4);
  });

  it("redacts a 6-digit 2FA code — the literal code does NOT survive", () => {
    const out = redact("Your code is 482913");
    expect(out).not.toContain("482913");
    expect(containsSecret("Your code is 482913")).toBe(true);
  });

  it("redacts a password-reset link — neither the phrase region nor the reset URL survives", () => {
    const input = "Reset your password: https://accounts.example.com/reset?token=abc";
    const out = redact(input);
    expect(out).not.toContain("reset?token=abc");
    expect(out).not.toContain("https://accounts.example.com/reset");
    expect(containsSecret(input)).toBe(true);
  });

  it("redacts a verification-code phrase and the /verify/ URL", () => {
    const input = "Verify your email at https://x.io/verify/9f2";
    const out = redact(input);
    expect(out).not.toContain("/verify/9f2");
    expect(out).not.toContain("https://x.io/verify");
    expect(containsSecret(input)).toBe(true);
  });

  it("redacts a /confirm/ login URL", () => {
    const input = "Sign in: https://login.example.com/confirm/xyz";
    const out = redact(input);
    expect(out).not.toContain("/confirm/xyz");
    expect(out).not.toContain("https://login.example.com/confirm");
    expect(containsSecret(input)).toBe(true);
  });

  it("also catches a literal 'verification code' phrase", () => {
    const input = "Your verification code is below";
    expect(redact(input)).not.toContain("verification code");
    expect(containsSecret(input)).toBe(true);
  });

  it("leaves ordinary text intact (no false-positive over-redaction)", () => {
    const benign = "Lunch at 12:30 with Sam";
    expect(redact(benign)).toBe(benign);
    expect(containsSecret(benign)).toBe(false);
  });
});
