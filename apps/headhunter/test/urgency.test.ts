/**
 * urgency.test.ts — Headhunter urgency bypass test (Plan 02-05 Task 1).
 *
 * Verifies (D2-14):
 *   1. A window inside lead_time_days (closes_est within 21 days) produces a task
 *      even if fit_score is below fit_floor (0.4) — urgency bypasses the fit floor.
 *
 *   2. A window with an explicit deadline (deadline field set) also bypasses the
 *      fit floor regardless of lead time.
 *
 *   3. A non-urgent window (closes_est far in future) with fit_score below fit_floor
 *      does NOT produce a task.
 *
 *   4. isUrgent() predicate is exported and correct.
 */

import { describe, it, expect } from "vitest";
import { decideWindow, isUrgent, type WindowRow } from "../src/windows.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const LEAD_TIME = 21;
const FIT_FLOOR = 0.4;

function makeWindow(overrides: Partial<WindowRow>): WindowRow {
  return {
    id: "meta:fall-2026:new-grad",
    company: "Meta",
    cycle: "fall-2026",
    role_class: "new-grad",
    opens_est: "2026-07-01",
    closes_est: "2026-11-30", // default far future
    confidence: 0.85,
    source: "board:levels.fyi",
    status: "open",
    last_seen_open: "2026-07-01",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

// ── urgency bypass tests ──────────────────────────────────────────────────────

describe("Headhunter urgency bypass (D2-14)", () => {
  const TODAY = "2026-07-10"; // reference date

  it("window inside lead_time (closes in 10 days) with low fit → still produces task", () => {
    const urgentWindow = makeWindow({
      closes_est: "2026-07-20", // 10 days from TODAY
      fit_score: 0.2, // below fit_floor 0.4
    });

    const decision = decideWindow(urgentWindow, {
      leadTimeDays: LEAD_TIME,
      fitFloor: FIT_FLOOR,
      date: TODAY,
    });

    // Urgency bypass: even below fit_floor, closing window gets a task
    expect(decision).not.toBeNull();
    expect(decision!.priority).toBe("P1"); // closing = P1
  });

  it("window with explicit deadline + low fit → still produces task", () => {
    const explicitDeadlineWindow = makeWindow({
      closes_est: "2026-12-15", // not inside lead time
      deadline: "2026-07-25", // explicit deadline set
      fit_score: 0.1, // well below fit_floor
    });

    const decision = decideWindow(explicitDeadlineWindow, {
      leadTimeDays: LEAD_TIME,
      fitFloor: FIT_FLOOR,
      date: TODAY,
    });

    expect(decision).not.toBeNull();
  });

  it("non-urgent window with fit_score below fit_floor → no task", () => {
    const nonUrgentLowFitWindow = makeWindow({
      closes_est: "2026-11-30", // far future, not inside lead time
      fit_score: 0.2, // below fit_floor
    });

    const decision = decideWindow(nonUrgentLowFitWindow, {
      leadTimeDays: LEAD_TIME,
      fitFloor: FIT_FLOOR,
      date: TODAY,
    });

    expect(decision).toBeNull();
  });

  it("non-urgent window with fit_score >= fit_floor → produces task", () => {
    const nonUrgentGoodFitWindow = makeWindow({
      closes_est: "2026-11-30", // far future
      fit_score: 0.7, // above fit_floor
    });

    const decision = decideWindow(nonUrgentGoodFitWindow, {
      leadTimeDays: LEAD_TIME,
      fitFloor: FIT_FLOOR,
      date: TODAY,
    });

    expect(decision).not.toBeNull();
    expect(decision!.priority).toBe("P2"); // non-urgent = P2
  });

  it("isUrgent: returns true when closes_est within leadTimeDays", () => {
    expect(isUrgent("2026-07-20", undefined, LEAD_TIME, TODAY)).toBe(true); // 10 days
    expect(isUrgent("2026-07-31", undefined, LEAD_TIME, TODAY)).toBe(false); // 21 days, not inside
    expect(isUrgent("2026-07-30", undefined, LEAD_TIME, TODAY)).toBe(true); // exactly 20 days
  });

  it("isUrgent: returns true when explicit deadline is set", () => {
    expect(isUrgent("2026-12-15", "2026-07-25", LEAD_TIME, TODAY)).toBe(true);
    expect(isUrgent("2026-12-15", undefined, LEAD_TIME, TODAY)).toBe(false);
  });

  it("closing window priority is P1; non-closing urgent is still determined correctly", () => {
    // A window closing in 5 days → P1
    const p1Window = makeWindow({
      closes_est: "2026-07-15", // 5 days
      fit_score: 0.8,
    });
    const p1Decision = decideWindow(p1Window, {
      leadTimeDays: LEAD_TIME,
      fitFloor: FIT_FLOOR,
      date: TODAY,
    });
    expect(p1Decision!.priority).toBe("P1");

    // A window with good fit but far future → P2
    const p2Window = makeWindow({
      closes_est: "2026-12-30",
      fit_score: 0.9,
    });
    const p2Decision = decideWindow(p2Window, {
      leadTimeDays: LEAD_TIME,
      fitFloor: FIT_FLOOR,
      date: TODAY,
    });
    expect(p2Decision!.priority).toBe("P2");
  });
});
