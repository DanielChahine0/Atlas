/**
 * auth.test.ts — Unit tests for the constant-time token helpers (Task 2, TDD RED).
 *
 * Tests:
 *   - timingSafeEqual: equal strings → true; differing strings → false; error → false (fail-closed)
 *   - sha256: deterministic 64-char lowercase hex
 */

import { describe, it, expect } from "vitest";
import { timingSafeEqual, sha256 } from "./auth.js";

describe("timingSafeEqual", () => {
  it("returns true for equal strings", async () => {
    expect(await timingSafeEqual("hello", "hello")).toBe(true);
  });

  it("returns false for differing strings (same length)", async () => {
    expect(await timingSafeEqual("hello1", "hello2")).toBe(false);
  });

  it("returns false for differing strings (different length)", async () => {
    expect(await timingSafeEqual("short", "longerstring")).toBe(false);
  });

  it("returns false for empty vs non-empty", async () => {
    expect(await timingSafeEqual("", "x")).toBe(false);
  });

  it("returns true for empty vs empty", async () => {
    expect(await timingSafeEqual("", "")).toBe(true);
  });

  it("is fail-closed — no exception propagates", async () => {
    // The function must not throw even if called with unusual inputs
    const result = await timingSafeEqual(
      "token-a".repeat(1000),
      "token-b".repeat(1000),
    );
    expect(result).toBe(false);
  });
});

describe("sha256", () => {
  it("returns a 64-char lowercase hex string", async () => {
    const hash = await sha256("hello");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic — same input produces same output", async () => {
    const a = await sha256("my-test-token");
    const b = await sha256("my-test-token");
    expect(a).toBe(b);
  });

  it("different inputs produce different hashes", async () => {
    const a = await sha256("token-a");
    const b = await sha256("token-b");
    expect(a).not.toBe(b);
  });

  it("known sha256 hash of empty string", async () => {
    const hash = await sha256("");
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
