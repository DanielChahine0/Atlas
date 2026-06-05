import { describe, it, expect } from "vitest";
import { dedupeKey, normalizeTitle } from "../src/dedupe.js";

// Pure dedupe-key tests (no D1). The key is the STRUCTURAL identity of a task — it must
// be deterministic for the same inputs (no salt, no randomUUID, no time component) so
// the D1 unique index can reject a duplicate and Forge replays are no-ops.
//
// Runs in workerd (TZ=UTC); crypto.subtle is the workerd WebCrypto.

describe("normalizeTitle", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeTitle("  Your  Online   Assessment ")).toBe("your online assessment");
  });

  it("strips leading reply/forward prefixes (repeated)", () => {
    expect(normalizeTitle("RE: Your Online Assessment")).toBe("your online assessment");
    expect(normalizeTitle("Fwd: Re: Your Online Assessment")).toBe("your online assessment");
    expect(normalizeTitle("FW:  Submit Shopify OA")).toBe("submit shopify oa");
  });

  it("is stable for an already-normalized title", () => {
    const once = normalizeTitle("submit shopify oa");
    expect(normalizeTitle(once)).toBe(once);
  });
});

describe("dedupeKey", () => {
  it("is deterministic across calls for the same inputs (no UUID/salt)", async () => {
    const a = await dedupeKey("t1", "submit shopify oa", "2026-06-02");
    const b = await dedupeKey("t1", "submit shopify oa", "2026-06-02");
    expect(a).toBe(b);
    // sha256 hex is 64 chars.
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when any field differs", async () => {
    const base = await dedupeKey("t1", "submit shopify oa", "2026-06-02");
    expect(await dedupeKey("t2", "submit shopify oa", "2026-06-02")).not.toBe(base);
    expect(await dedupeKey("t1", "submit shopify oa", "2026-06-03")).not.toBe(base);
    expect(await dedupeKey("t1", "submit amazon oa", "2026-06-02")).not.toBe(base);
  });

  it("has no field-boundary collision (separator is unambiguous)", async () => {
    // ("ab","c") must not collide with ("a","bc") — a naive concat would.
    const x = await dedupeKey("ab", "c", "");
    const y = await dedupeKey("a", "bc", "");
    expect(x).not.toBe(y);
  });

  it("does not collide when a field itself contains a space (NUL separator, not space)", async () => {
    // A literal-space separator would map ("a","b c") and ("a b","c") to the same
    // material ("a b c") and collide. The NUL separator keeps them distinct (WR-02).
    const x = await dedupeKey("a", "b c", "");
    const y = await dedupeKey("a b", "c", "");
    expect(x).not.toBe(y);
  });
});
