import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { resolveEffort, DEFAULT_EFFORT, COMPASS_EFFORT_KEY } from "../src/plan.js";

// DoD test 3 — effort default + KV override (D1-05). With no compass.effort key, effort is
// "medium" (NEVER "high"); setting compass.effort="high" makes the next resolve return "high".

const env2 = env as unknown as { CONFIG: KVNamespace };

describe("Compass effort (D1-05)", () => {
  it("defaults to medium with no compass.effort key (never high)", async () => {
    // Ensure the key is absent in this isolated KV.
    await env2.CONFIG.delete(COMPASS_EFFORT_KEY);
    const effort = await resolveEffort(env2);
    expect(effort).toBe("medium");
    expect(effort).not.toBe("high");
    expect(DEFAULT_EFFORT).toBe("medium");
  });

  it("the compass.effort KV override is honored (medium → high)", async () => {
    await env2.CONFIG.put(COMPASS_EFFORT_KEY, "high");
    const effort = await resolveEffort(env2);
    expect(effort).toBe("high"); // a hard day can be bumped up via KV, not by shipping high
    // restore
    await env2.CONFIG.delete(COMPASS_EFFORT_KEY);
  });

  it("a low override is also honored (e.g. 'low' for a quiet day)", async () => {
    await env2.CONFIG.put(COMPASS_EFFORT_KEY, "low");
    expect(await resolveEffort(env2)).toBe("low");
    await env2.CONFIG.delete(COMPASS_EFFORT_KEY);
  });
});
