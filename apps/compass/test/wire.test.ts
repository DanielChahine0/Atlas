import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import { applyEvent } from "@atlas/steward-core";
import { buildDayPlanEvent } from "../src/index.js";
import type { DayPlan } from "../src/plan.js";

// DoD test 2 — Wire-contract + replay-through-Steward. The day_plan is op:upsert (REPLACES the
// Today note); a same-date replay leaves Steward unchanged.

const db = (env as unknown as { DB: D1Database }).DB;

const plan: DayPlan = {
  blocks: [{ taskId: "a", title: "Do A", startMin: 540, endMin: 585 }],
  top3: [{ taskId: "a", title: "Do A" }],
  couldntFit: [],
  overcommitted: false,
};

describe("Compass Wire-contract", () => {
  it("emits the exact §6.4 day_plan event with a structured key (op:upsert)", () => {
    const evt = buildDayPlanEvent("2026-06-05", "morning", plan);
    expect(evt.agent).toBe("Compass");
    expect(evt.type).toBe("day_plan");
    expect(evt.entity).toBe("Today");
    expect(evt.op).toBe("upsert"); // upsert REPLACES the Today note, never appends
    expect(evt.idempotencyKey).toBe("compass:plan:2026-06-05");
    expect((evt.payload.top3 as unknown[]).length).toBe(1);
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });

  it("a same-date replay through Steward does not double-count (meta.changes===0)", async () => {
    const evt = buildDayPlanEvent("2026-06-05", "morning", plan);
    expect(await applyEvent(db, evt)).toEqual({ applied: true });
    expect(await applyEvent(db, evt)).toEqual({ applied: false }); // upsert replay no-op
  });
});
