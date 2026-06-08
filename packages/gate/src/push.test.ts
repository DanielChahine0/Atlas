/**
 * push.test.ts — Unit tests for buildConfirmPush (Task 2, TDD RED).
 *
 * Tests:
 *   - buildConfirmPush: produces ntfy payload with 'view' action labeled 'Review & edit'
 *   - Confirm link URL contains correct token parameter
 *   - Body ≤ 120 chars
 *   - Title/body pass redact()
 *   - buildConfirmPush ONLY builds the payload — it must NOT call fetch()
 */

import { describe, it, expect } from "vitest";
import { buildConfirmPush } from "./push.js";

const BASE_OPTS = {
  confirmBaseUrl: "https://gate.example.com",
  plaintextToken: "abc123def456abc123def456abc123de",
  title: "Usher — registration pending",
  body: "Register for MLconf 2026 (Free) on 2026-09-15? Review before it expires in 24h.",
};

describe("buildConfirmPush", () => {
  it("produces a payload with a 'view' action labeled 'Review & edit'", () => {
    const payload = buildConfirmPush(BASE_OPTS);
    expect(payload.actions).toHaveLength(1);
    expect(payload.actions[0]?.action).toBe("view");
    expect(payload.actions[0]?.label).toBe("Review & edit");
  });

  it("the view action URL is the confirm page with the token", () => {
    const payload = buildConfirmPush(BASE_OPTS);
    const action = payload.actions[0];
    expect(action?.url).toBe(
      `${BASE_OPTS.confirmBaseUrl}/confirm?t=${BASE_OPTS.plaintextToken}`,
    );
  });

  it("body is ≤ 120 characters", () => {
    const payload = buildConfirmPush(BASE_OPTS);
    expect(payload.message.length).toBeLessThanOrEqual(120);
  });

  it("truncates long bodies to ≤ 120 characters", () => {
    const longBody = "x".repeat(200);
    const payload = buildConfirmPush({ ...BASE_OPTS, body: longBody });
    expect(payload.message.length).toBeLessThanOrEqual(120);
  });

  it("title is included in the payload", () => {
    const payload = buildConfirmPush(BASE_OPTS);
    expect(payload.title).toBeDefined();
    expect(typeof payload.title).toBe("string");
  });

  it("redacts 2FA codes from the body", () => {
    const payload = buildConfirmPush({
      ...BASE_OPTS,
      body: "Your code is 123456. Review before it expires.",
    });
    expect(payload.message).not.toContain("123456");
  });

  it("redacts reset links from the body", () => {
    const payload = buildConfirmPush({
      ...BASE_OPTS,
      body: "Reset at https://accounts.google.com/reset?token=x",
    });
    expect(payload.message).not.toContain("accounts.google.com/reset");
  });

  it("does NOT call fetch() — pure payload builder only", () => {
    // This is a source-grep contract, verified separately.
    // At runtime: buildConfirmPush should return synchronously (no Promise)
    const result = buildConfirmPush(BASE_OPTS);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.actions).toBeDefined();
  });

  it("produces a message field (ntfy body)", () => {
    const payload = buildConfirmPush(BASE_OPTS);
    expect(typeof payload.message).toBe("string");
    expect(payload.message.length).toBeGreaterThan(0);
  });
});
