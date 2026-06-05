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

describe("Compass preview vs plan keys (NEW-SC2)", () => {
  it("the preview key is distinct from the plan key (spec: compass:<mode>:<date>)", () => {
    expect(buildDayPlanEvent("2026-06-06", "preview", plan).idempotencyKey).toBe(
      "compass:preview:2026-06-06",
    );
    expect(buildDayPlanEvent("2026-06-05", "morning", plan).idempotencyKey).toBe(
      "compass:plan:2026-06-05",
    );
  });

  it("a preview (tomorrow) and a plan (today) BOTH apply — neither deduped against the other", async () => {
    // The 21:00 preview plans for owner-local TOMORROW; the morning step plans for today. With
    // distinct keys, Steward applies both even when the dates are adjacent (the old shared
    // "compass:plan:<date>" key would have silently dropped one).
    const previewTomorrow = buildDayPlanEvent("2026-06-21", "preview", plan);
    const planToday = buildDayPlanEvent("2026-06-20", "morning", plan);
    expect(await applyEvent(db, previewTomorrow)).toEqual({ applied: true });
    expect(await applyEvent(db, planToday)).toEqual({ applied: true });
    // And the SAME preview is itself replay-safe (no double-apply).
    expect(await applyEvent(db, previewTomorrow)).toEqual({ applied: false });
  });
});

describe("Compass couldnt_fit / at_risk disjointness (NEW-SC5)", () => {
  it("at-risk overflow appears in at_risk ONLY, never double-listed under couldnt_fit", () => {
    const mixedPlan: DayPlan = {
      blocks: [],
      top3: [],
      couldntFit: [
        { taskId: "risk1", title: "Overdue thing", atRisk: true },
        { taskId: "calm1", title: "Someday thing", atRisk: false },
      ],
      overcommitted: true,
    };
    const evt = buildDayPlanEvent("2026-06-05", "morning", mixedPlan);
    const couldntFit = evt.payload.couldnt_fit as { taskId: string }[];
    const atRisk = evt.payload.at_risk as { taskId: string }[];
    expect(atRisk.map((c) => c.taskId)).toEqual(["risk1"]);
    expect(couldntFit.map((c) => c.taskId)).toEqual(["calm1"]); // at-risk excluded → disjoint
    // No taskId appears in both lists.
    const overlap = couldntFit.filter((c) => atRisk.some((a) => a.taskId === c.taskId));
    expect(overlap).toEqual([]);
  });
});
