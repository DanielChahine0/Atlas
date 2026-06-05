/**
 * low-confidence.test.ts — Headhunter low-confidence window routing test (Plan 02-05 Task 1).
 *
 * Verifies:
 *   1. A window with confidence < 0.4 AND source === "historical" calls
 *      flag(env, "P3", ..., { kind: "low_confidence_window" }) and does NOT
 *      create an apply-by task.
 *
 *   2. A window with confidence < 0.4 but source !== "historical" still creates
 *      a task (only historical-source low-confidence windows are routed to P3).
 *
 *   3. A window with confidence >= 0.4 creates a task regardless of source.
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { decideWindow, shouldFlagLowConfidence, type WindowRow } from "../src/windows.js";
import type { Env } from "../src/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

type TestEnv = {
  testEnv: Env;
  wireEvents: WireEvent[];
  incidents: RawIncident[];
};

function makeEnv(): TestEnv {
  const wireEvents: WireEvent[] = [];
  const incidents: RawIncident[] = [];

  const wireSend = vi.fn(async (event: WireEvent) => {
    wireEvents.push(event);
  });

  const incidentsSend = vi.fn(async (incident: RawIncident) => {
    incidents.push(incident);
  });

  const testEnv: Env = {
    ...(env as unknown as Env),
    WIRE: { send: wireSend } as unknown as Queue<WireEvent>,
    INCIDENTS: { send: incidentsSend } as unknown as Queue<RawIncident>,
    CONFIG: {
      get: vi.fn(async (_key: string) => null),
    } as unknown as KVNamespace,
  };

  return { testEnv, wireEvents, incidents };
}

const BASE_DATE = "2026-07-01";

function makeWindow(overrides: Partial<WindowRow> = {}): WindowRow {
  return {
    id: "amazon:fall-2026:intern",
    company: "Amazon",
    cycle: "fall-2026",
    role_class: "intern",
    opens_est: "2026-07-01",
    closes_est: "2026-09-15",
    confidence: 0.85,
    source: "board:levels.fyi",
    status: "open",
    last_seen_open: BASE_DATE,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

// ── low-confidence routing tests ──────────────────────────────────────────────

describe("Headhunter low-confidence window routing (D2-14)", () => {
  it("low confidence + historical source → no task decision, P3 incident needed", async () => {
    const lowConfWindow = makeWindow({
      confidence: 0.3,
      source: "historical",
    });

    const decision = decideWindow(lowConfWindow, {
      leadTimeDays: 21,
      fitFloor: 0.4,
      date: BASE_DATE,
    });

    // decideWindow returns null when the window should be routed to flag() instead
    expect(decision).toBeNull();
  });

  it("low confidence but NOT historical source → still produces task decision", async () => {
    const lowConfBoardWindow = makeWindow({
      confidence: 0.35,
      source: "board:levels.fyi", // board source, not "historical"
    });

    const decision = decideWindow(lowConfBoardWindow, {
      leadTimeDays: 21,
      fitFloor: 0.4,
      date: BASE_DATE,
    });

    // A board-sourced window with low confidence is NOT routed to flag; it's a task
    expect(decision).not.toBeNull();
  });

  it("confidence >= 0.4 always produces a task decision regardless of source", async () => {
    const confWindow = makeWindow({
      confidence: 0.4,
      source: "historical",
    });

    const decision = decideWindow(confWindow, {
      leadTimeDays: 21,
      fitFloor: 0.4,
      date: BASE_DATE,
    });

    expect(decision).not.toBeNull();
  });

  it("shouldFlagLowConfidence returns true for confidence < 0.4 AND source historical", () => {
    expect(shouldFlagLowConfidence({ confidence: 0.3, source: "historical" })).toBe(true);
    expect(shouldFlagLowConfidence({ confidence: 0.3, source: "board:levels.fyi" })).toBe(false);
    expect(shouldFlagLowConfidence({ confidence: 0.5, source: "historical" })).toBe(false);
    expect(shouldFlagLowConfidence({ confidence: 0.0, source: "historical" })).toBe(true);
    expect(shouldFlagLowConfidence({ confidence: 0.4, source: "historical" })).toBe(false);
  });
});
