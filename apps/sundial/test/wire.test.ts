import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import { applyEvent } from "@atlas/steward-core";
import { buildSyncEvent, upcoming7d } from "../src/index.js";
import type { ReconcileResult } from "../src/reconcile.js";
import type { TaskRow } from "@atlas/tasks";

// DoD test 2 — Wire-contract + replay-through-Steward.

const db = (env as unknown as { DB: D1Database }).DB;

const summary: ReconcileResult = {
  created: 2,
  updated: 1,
  skipped: 3,
  proposedRemovals: 0,
  decisions: [],
};

describe("Sundial Wire-contract", () => {
  it("emits the exact §6.4 calendar.sync event with a structured key", () => {
    const evt = buildSyncEvent("2026-06-05", summary, 4);
    expect(evt.agent).toBe("Sundial");
    expect(evt.type).toBe("calendar.sync");
    expect(evt.entity).toBe("deadlines");
    expect(evt.op).toBe("upsert");
    expect(evt.idempotencyKey).toBe("sundial-2026-06-05");
    expect(evt.payload.created).toBe(2);
    expect(evt.payload.upcoming7d).toBe(4);
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });

  it("a replay through Steward does not double-count (meta.changes===0)", async () => {
    const evt = buildSyncEvent("2026-06-05", summary, 4);
    expect(await applyEvent(db, evt)).toEqual({ applied: true });
    expect(await applyEvent(db, evt)).toEqual({ applied: false }); // replay no-op
  });

  it("upcoming7d counts only deadlines within 7 days", () => {
    const tasks: TaskRow[] = [
      { id: "a", due: "2026-06-07", status: "open" } as TaskRow,
      { id: "b", due: "2026-06-20", status: "open" } as TaskRow,
      { id: "c", due: null, status: "open" } as TaskRow,
    ];
    expect(upcoming7d(tasks, "2026-06-05")).toBe(1); // only "a" is within 7d
  });

  // IN-06 — the window is lower-bounded at today: already-OVERDUE deadlines do NOT count under
  // an "upcoming-7d" name (today..+7d only, not "anything not past the horizon").
  it("upcoming7d EXCLUDES already-overdue deadlines (lower bound = today)", () => {
    const tasks: TaskRow[] = [
      { id: "past", due: "2026-06-01", status: "open" } as TaskRow, // overdue → excluded
      { id: "today", due: "2026-06-05", status: "open" } as TaskRow, // today → included
      { id: "soon", due: "2026-06-07", status: "open" } as TaskRow, // within 7d → included
      { id: "far", due: "2026-06-20", status: "open" } as TaskRow, // beyond → excluded
    ];
    expect(upcoming7d(tasks, "2026-06-05")).toBe(2); // "today" + "soon"
  });

  // NEW-SC4-anchor — the window anchors at owner-local (America/Toronto) midnight, not bare
  // UTC midnight. An all-day deadline equal to today's owner-local date still counts (it must
  // not be excluded by a UTC-vs-local off-by-a-few-hours anchor).
  it("upcoming7d anchors at owner-local midnight (today's all-day deadline counts)", () => {
    const tasks: TaskRow[] = [{ id: "today", due: "2026-06-05", status: "open" } as TaskRow];
    expect(upcoming7d(tasks, "2026-06-05")).toBe(1);
  });
});
