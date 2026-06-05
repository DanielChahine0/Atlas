import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import { applyEvent } from "@atlas/steward-core";
import { buildDigestEvent, runDaily, type Env } from "../src/index.js";
import type { DigestThread } from "../src/bucket.js";

// DoD test 2 — Wire-contract + replay-through-Steward.

const env2 = env as unknown as Env;
const db = (env as unknown as { DB: D1Database }).DB;

describe("Herald Wire-contract", () => {
  it("emits the exact §6.4 digest event with a structured key", () => {
    const evt = buildDigestEvent("2026-06-05", { Important: 2 }, ["t1"], "draft-9");
    expect(evt.agent).toBe("Herald");
    expect(evt.type).toBe("digest");
    expect(evt.entity).toBe("email");
    expect(evt.op).toBe("upsert");
    expect(evt.idempotencyKey).toBe("herald:daily:2026-06-05");
    expect(evt.payload.draftId).toBe("draft-9");
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });

  it("a replay through Steward does not double-count (meta.changes===0)", async () => {
    const evt = buildDigestEvent("2026-06-05", { Important: 1 }, [], "draft-1");
    expect(await applyEvent(db, evt)).toEqual({ applied: true });
    expect(await applyEvent(db, evt)).toEqual({ applied: false }); // replay no-op
  });

  it("runDaily emits a valid digest event and returns Action Required refs for Forge", async () => {
    const threads: DigestThread[] = [
      { threadId: "ar1", sender: "a", subject: "s", labels: ["① Action Required", "Needs/Reply"] },
      { threadId: "n1", sender: "b", subject: "s", labels: ["Type/Newsletter"] },
    ];
    const drafts: { subject: string; body: string }[] = [];
    const result = await runDaily(env2, "2026-06-06", threads, {
      async createDraft(_to, subject, body) {
        drafts.push({ subject, body });
        return "draft-xyz";
      },
    });
    expect(result.drafted).toBe(true);
    expect(result.draftId).toBe("draft-xyz");
    expect(result.actionRequiredRefs).toContain("ar1");
    expect(drafts[0]?.subject).toContain("2026-06-06");
  });
});
