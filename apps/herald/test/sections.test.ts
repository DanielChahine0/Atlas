import { describe, it, expect } from "vitest";
import { bucketThreads, sectionFor, SECTIONS, type DigestThread } from "../src/bucket.js";

// DoD test 1 — section bucketing + order. A fixture of labeled threads buckets into the
// five sections in EXACTLY the fixed order; Type/Newsletter → Other, Type/Promotion →
// Advertisement (the §5.8 distinction).

function t(over: Partial<DigestThread> & { threadId: string }): DigestThread {
  return { sender: "x@y.com", subject: "s", labels: [], ...over };
}

describe("Herald bucketing", () => {
  it("the five sections render in the fixed owner order", () => {
    expect([...SECTIONS]).toEqual([
      "Important",
      "Action Required",
      "Action Recommended",
      "Advertisement",
      "Other",
    ]);
  });

  it("maps labels onto the right section (Newsletter→Other, Promotion→Advertisement)", () => {
    expect(sectionFor(t({ threadId: "a", labels: ["From/VIP"] }))).toBe("Important");
    expect(sectionFor(t({ threadId: "b", labels: ["Job/Offer"] }))).toBe("Important");
    expect(sectionFor(t({ threadId: "c", labels: ["① Action Required", "Needs/Reply"] }))).toBe(
      "Action Required",
    );
    expect(sectionFor(t({ threadId: "d", labels: ["② Action Recommended"] }))).toBe(
      "Action Recommended",
    );
    expect(sectionFor(t({ threadId: "e", labels: ["Type/Promotion"] }))).toBe("Advertisement");
    // Newsletter is NOT advertising — it lands in Other.
    expect(sectionFor(t({ threadId: "f", labels: ["Type/Newsletter"] }))).toBe("Other");
    expect(sectionFor(t({ threadId: "g", labels: ["④ FYI / Read Later"] }))).toBe("Other");
    // A phishing thread never lands in Important/Action — it goes to Other.
    expect(sectionFor(t({ threadId: "h", labels: ["⚠ Phishing-Suspect"] }))).toBe("Other");
  });

  it("buckets a mixed fixture and ranks Due/Today first within Action Required", () => {
    const threads = [
      t({ threadId: "vip", labels: ["From/VIP"] }),
      t({ threadId: "ar-week", labels: ["① Action Required", "Due/ThisWeek"] }),
      t({ threadId: "ar-today", labels: ["① Action Required", "Due/Today"] }),
      t({ threadId: "promo", labels: ["Type/Promotion"] }),
      t({ threadId: "news", labels: ["Type/Newsletter"] }),
    ];
    const b = bucketThreads(threads);
    expect(b["Important"].map((x) => x.threadId)).toEqual(["vip"]);
    // Due/Today ranks before Due/ThisWeek.
    expect(b["Action Required"].map((x) => x.threadId)).toEqual(["ar-today", "ar-week"]);
    expect(b["Advertisement"].map((x) => x.threadId)).toEqual(["promo"]);
    expect(b["Other"].map((x) => x.threadId)).toEqual(["news"]);
    // The Buckets key-iteration order is the SECTIONS order.
    expect(Object.keys(b)).toEqual([...SECTIONS]);
  });
});
