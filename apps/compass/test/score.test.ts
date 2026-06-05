import { describe, it, expect } from "vitest";
import { deadlineWeight, isDueToday, isOverdue } from "../src/score.js";
import type { TaskRow } from "@atlas/tasks";

// NEW-SC1 — "today" is anchored at OWNER-LOCAL midnight, not UTC midnight. Forge writes real
// dues as owner-local datetimes WITH an offset (e.g. "<date>T23:59:00-04:00"). A UTC-midnight
// anchor (the old "T00:00:00Z" literal) is ~4-5h ahead of owner-local midnight and misclassifies
// every datetime-bearing due one urgency band too LOW — breaking the "OVERDUE never buried"
// guarantee. These tests pin the corrected owner-local classification while keeping the existing
// date-only behavior green.

function task(over: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    dedupe_key: "k-" + over.id,
    thread: "t",
    title: "Task " + over.id,
    priority: "P2",
    due: null,
    due_kind: "explicit",
    status: "open",
    source_agent: "Forge",
    locked_by_owner: 0,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as TaskRow;
}

describe("Compass score — deadlineWeight owner-local anchor (NEW-SC1)", () => {
  it("a Forge-shaped datetime due today ('...T23:59:00-04:00') scores 10 / isDueToday true", () => {
    // EDT = -04:00. 2026-06-05T23:59:00-04:00 is 2026-06-06T03:59:00Z — under a UTC-midnight
    // anchor this looked like "tomorrow" (weight 20, isDueToday false). Owner-local, it is today.
    const t = task({ id: "dt", due: "2026-06-05T23:59:00-04:00" });
    expect(deadlineWeight(t, "2026-06-05")).toBe(10);
    expect(isDueToday(t, "2026-06-05")).toBe(true);
    expect(isOverdue(t, "2026-06-05")).toBe(false);
  });

  it("a Forge-shaped datetime due YESTERDAY is OVERDUE (weight 0), never buried", () => {
    // 2026-06-04T23:59:00-04:00 is the owner's prior calendar day → overdue relative to 06-05.
    const t = task({ id: "od", due: "2026-06-04T23:59:00-04:00" });
    expect(deadlineWeight(t, "2026-06-05")).toBe(0);
    expect(isOverdue(t, "2026-06-05")).toBe(true);
    expect(isDueToday(t, "2026-06-05")).toBe(false);
  });

  it("a datetime due early TOMORROW (owner-local) is due-this-week (weight 20), not today", () => {
    const t = task({ id: "tm", due: "2026-06-06T00:30:00-04:00" });
    expect(deadlineWeight(t, "2026-06-05")).toBe(20);
    expect(isDueToday(t, "2026-06-05")).toBe(false);
  });

  // The existing date-only behavior must stay green.
  it("a date-only due today still scores 10 (isDueToday true)", () => {
    const t = task({ id: "do", due: "2026-06-05" });
    expect(deadlineWeight(t, "2026-06-05")).toBe(10);
    expect(isDueToday(t, "2026-06-05")).toBe(true);
  });

  it("a date-only due in the past is overdue (weight 0); a far-future due is 30; undated is 40", () => {
    expect(deadlineWeight(task({ id: "p", due: "2026-06-01" }), "2026-06-05")).toBe(0);
    expect(deadlineWeight(task({ id: "f", due: "2026-07-01" }), "2026-06-05")).toBe(30);
    expect(deadlineWeight(task({ id: "u", due: null }), "2026-06-05")).toBe(40);
  });

  it("a date-only due within the week (but not today) scores 20", () => {
    expect(deadlineWeight(task({ id: "w", due: "2026-06-08" }), "2026-06-05")).toBe(20);
  });
});
