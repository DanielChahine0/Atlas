import { describe, it, expect } from "vitest";
import { redact, containsSecret, SECRET_PATTERNS } from "../src/index.js";

// THE CI-BACKSTOP TEST (CLAUDE.md Definition of Done — second CI invariant). This is the
// load-bearing assertion behind the security invariant: "a prompt instruction alone is NOT
// sufficient." A real source assertion proves no 2FA code / reset link / login URL survives.
//
// ADVERSARIAL by design (00 review C3/C4/W10): the original tests only probed the exact
// fixtures the narrow patterns were built for, so the bypasses (7/8-digit, spaced, dashed,
// full-width codes; login/magic/SSO URLs; OTP/passcode/security-code phrases) went unnoticed.
// Each block below probes a bypass CLASS, not a single fixture, and asserts containsSecret()
// agrees with redact() on every case (no secret value survives the egress).
//
// No real secret VALUE appears anywhere — every code/token/URL here is synthetic.

/** Helper: assert the literal secret substring does NOT survive redaction AND containsSecret agrees. */
function assertRedacted(input: string, secret: string) {
  const out = redact(input);
  expect(out, `redact() must strip "${secret}" from "${input}"`).not.toContain(secret);
  expect(containsSecret(input), `containsSecret() must flag "${input}"`).toBe(true);
}

/** Helper: assert a benign string is left fully intact AND containsSecret agrees it is clean. */
function assertClean(input: string) {
  expect(redact(input), `redact() must NOT touch benign "${input}"`).toBe(input);
  expect(containsSecret(input), `containsSecret() must NOT flag benign "${input}"`).toBe(false);
}

describe("SECRET_PATTERNS — the redaction backstop", () => {
  it("exports a frozen, non-empty pattern set (none carry the stateful `g` flag)", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(SECRET_PATTERNS)).toBe(true);
    // TEST_PATTERNS must not carry `g` — a `g`-flagged `.test()` carries lastIndex between calls.
    for (const p of SECRET_PATTERNS) expect(p.flags).not.toContain("g");
  });
});

// ---------------------------------------------------------------------------
// CLASS C3 — multi-digit / spaced / dashed / full-width 2FA codes
// ---------------------------------------------------------------------------
describe("C3 — 2FA code bypass classes (was: 6-digit-only `\\b\\d{6}\\b`)", () => {
  it("redacts a 6-digit code with a code cue nearby", () => {
    assertRedacted("Your code is 482913", "482913");
  });

  it("redacts a 7-digit code (the original pattern leaked this)", () => {
    assertRedacted("Your code is 4829137", "4829137");
  });

  it("redacts an 8-digit code (the original pattern leaked this)", () => {
    assertRedacted("OTP: 48291370", "48291370");
  });

  it("redacts a space-grouped code `482 913`", () => {
    assertRedacted("Your code: 482 913", "482 913");
  });

  it("redacts a dash-grouped code `482-913`", () => {
    assertRedacted("Use 482-913 to sign in", "482-913");
  });

  it("redacts a 3-4 grouped code `482-9137`", () => {
    assertRedacted("code 482-9137", "482-9137");
  });

  it("redacts a FULL-WIDTH digit code `４８２９１３` (normalized before matching)", () => {
    const input = "your code is ４８２９１３";
    // After normalization the run becomes ASCII; assert neither form survives.
    const out = redact(input);
    expect(out).not.toContain("４８２９１３");
    expect(out).not.toContain("482913");
    expect(containsSecret(input)).toBe(true);
  });

  it("redacts a code cue AFTER the digits (`483920 is your code`)", () => {
    assertRedacted("483920 is your code", "483920");
  });
});

// ---------------------------------------------------------------------------
// CLASS C3 over-redaction guard (I24) — proximity cue prevents stripping benign numbers
// ---------------------------------------------------------------------------
describe("C3/I24 — proximity cue limits over-redaction of benign bare digit runs", () => {
  it("does NOT redact a bare `Order #483920` with no code-context nearby", () => {
    // 6-digit run, but no code/otp/verification cue within ~20 chars → benign, left intact.
    assertClean("Order #483920 has shipped");
  });

  it("DOES redact the same digits when a code cue IS nearby", () => {
    assertRedacted("your code is 483920", "483920");
  });

  it("does NOT redact a 4-digit year or a price", () => {
    assertClean("Q3 2024 revenue was 12500");
  });

  it("does NOT redact a long benign ID with no cue", () => {
    assertClean("Tracking number 12345678 delivered");
  });
});

// ---------------------------------------------------------------------------
// CLASS C4 — login / signin / auth / magic-link / SSO URLs + token-query URLs
// ---------------------------------------------------------------------------
describe("C4 — login/auth URL bypass classes (was: only reset|verify|confirm)", () => {
  it("redacts a /reset URL (original coverage retained)", () => {
    const input = "Reset your password: https://accounts.example.com/reset?token=abc";
    const out = redact(input);
    expect(out).not.toContain("https://accounts.example.com/reset?token=abc");
    expect(containsSecret(input)).toBe(true);
  });

  it("redacts a /login URL with ?token= (the invariant explicitly names login URLs)", () => {
    assertRedacted(
      "Sign in here: https://accounts.example.com/login?token=abc",
      "https://accounts.example.com/login?token=abc",
    );
  });

  it("redacts a /signin URL", () => {
    assertRedacted(
      "Go to https://app.example.com/signin?next=/home now",
      "https://app.example.com/signin?next=/home",
    );
  });

  it("redacts a magic-link /auth/magic URL", () => {
    assertRedacted(
      "Your magic link: https://example.com/auth/magic?token=xyz",
      "https://example.com/auth/magic?token=xyz",
    );
  });

  it("redacts an SSO URL", () => {
    assertRedacted(
      "SSO entry https://sso.corp.example.com/sso/start?RelayState=abc",
      "https://sso.corp.example.com/sso/start?RelayState=abc",
    );
  });

  it("redacts ANY URL carrying a `?token=` query marker (even a plain path)", () => {
    assertRedacted(
      "Continue at https://m.example.com/x?token=deadbeefcafe",
      "https://m.example.com/x?token=deadbeefcafe",
    );
  });

  it("redacts a URL carrying an `?otp=` query marker — the opaque value does NOT survive", () => {
    assertRedacted(
      "Use https://m.example.com/x?otp=AB12cd34EF56gh to continue",
      "AB12cd34EF56gh",
    );
  });

  it("redacts a URL carrying a `?ticket=` query marker (CAS/SSO ticket)", () => {
    assertRedacted(
      "Validate https://cas.example.com/p?ticket=ST-9f2-abc",
      "ST-9f2-abc",
    );
  });
});

// ---------------------------------------------------------------------------
// CLASS W10 — phrase coverage: OTP / one-time passcode / security code / double-spaced reset
// ---------------------------------------------------------------------------
describe("W10 — phrase bypass classes", () => {
  it("redacts the 'verification code' phrase (original coverage retained)", () => {
    assertRedacted("Your verification code is below", "verification code");
  });

  it("redacts a 'one-time passcode' phrase", () => {
    assertRedacted("Your one-time passcode follows", "one-time passcode");
  });

  it("redacts a bare 'OTP' token", () => {
    assertRedacted("Enter the OTP to proceed", "OTP");
  });

  it("redacts a 'security code' phrase", () => {
    assertRedacted("Your security code is attached", "security code");
  });

  it("redacts a single-space 'reset password' phrase (original)", () => {
    assertRedacted("Please reset password now", "reset password");
  });

  it("redacts a DOUBLE-SPACED `reset  password` (was: `[-_ ]?` allowed only one separator)", () => {
    assertRedacted("Please reset  password here", "reset  password");
  });

  it("redacts a 'reset-link' phrase", () => {
    assertRedacted("Click the reset-link below", "reset-link");
  });
});

// ---------------------------------------------------------------------------
// containsSecret() / redact() agreement + benign controls
// ---------------------------------------------------------------------------
describe("agreement + no gross over-redaction", () => {
  it("leaves ordinary prose intact", () => {
    assertClean("Lunch at 12:30 with Sam about the Q3 plan.");
  });

  it("leaves a benign date range intact", () => {
    assertClean("From 2020 to 2024 the team doubled.");
  });

  it("containsSecret() is stable across repeated calls (no leaked `g`-flag lastIndex state)", () => {
    const leak = "your code is 483920";
    // Repeated calls must return the SAME result — a stateful `g`-flagged `.test()` would alternate.
    expect(containsSecret(leak)).toBe(true);
    expect(containsSecret(leak)).toBe(true);
    expect(containsSecret(leak)).toBe(true);
    const clean = "Order #483920 has shipped";
    expect(containsSecret(clean)).toBe(false);
    expect(containsSecret(clean)).toBe(false);
  });

  it("redact() is idempotent and stable across repeated calls", () => {
    const input = "OTP: 48291370 — https://x.io/login?token=abc";
    const once = redact(input);
    const twice = redact(once);
    expect(redact(input)).toBe(once); // same input → same output every call
    expect(twice).toBe(once); // re-running on already-redacted output is a no-op for the masks
  });
});
