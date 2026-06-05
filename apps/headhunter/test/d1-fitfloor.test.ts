/**
 * d1-fitfloor.test.ts — H5: fit-floor guard through the REAL D1 read path.
 *
 * H5: decideWindow reads window.deadline and window.fit_score, but the `windows`
 * table had NEITHER column — both production SELECTs omitted them → both always
 * undefined → fit-floor guard never fired and explicit-deadline urgency override
 * never fired from D1.
 *
 * Fix: add `deadline` and `fit_score` columns to the `windows` table, and include
 * them in BOTH SELECTs in index.ts.
 *
 * These tests drive decideWindow through the actual D1 SELECT path (not injected
 * WindowRow) and assert that:
 *   1. A low-fit non-urgent window is suppressed by the fit-floor from D1.
 *   2. An urgent window (explicit deadline in D1) bypasses the fit-floor.
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { runFull, runDeadlines, type Env } from "../src/index.js";

// Apply migrations before tests (setup hook in apply-migrations.ts)
import "./apply-migrations.js";

function makeEnv(): { testEnv: Env; forgeTasks: Array<{ opts: { idempotencyKey: string } }> } {
  const forgeTasks: Array<{ opts: { idempotencyKey: string } }> = [];
  const testEnv: Env = {
    ...(env as unknown as Env),
    WIRE: { send: vi.fn(async () => {}) } as unknown as Queue<WireEvent>,
    INCIDENTS: { send: vi.fn(async () => {}) } as unknown as Queue<RawIncident>,
    CONFIG: {
      get: vi.fn(async (_key: string) => null),
    } as unknown as KVNamespace,
    FORGE: {
      createTask: vi.fn(async (_task: unknown, opts: unknown) => {
        forgeTasks.push({ opts: opts as { idempotencyKey: string } });
        return { id: "test-task" };
      }),
    },
  };
  return { testEnv, forgeTasks };
}

const TODAY = "2026-07-01";
const FUTURE = "2026-11-30"; // > 21 days away — not urgent

describe("H5: fit-floor via real D1 read path", () => {
  it("low-fit non-urgent window in D1 must be suppressed (fit_score from D1, not undefined)", async () => {
    const { testEnv, forgeTasks } = makeEnv();
    const db = testEnv.DB;

    // Insert a low-fit non-urgent window directly into D1
    // fit_score = 0.2 (below floor 0.4), closes_est far future (not urgent)
    await db
      .prepare(
        `INSERT OR REPLACE INTO windows(id,company,cycle,role_class,opens_est,closes_est,confidence,source,status,last_seen_open,created_at,updated_at,fit_score,deadline)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        "acme:fall-2026:new-grad",
        "Acme",
        "fall-2026",
        "new-grad",
        "2026-07-01",
        FUTURE,
        0.85,
        "board:test",
        "open",
        TODAY,
        Date.now(),
        Date.now(),
        0.2,   // fit_score well below floor
        null,  // no explicit deadline
      )
      .run();

    // runFull reads from D1 (no injected windows) — fit_score must survive the SELECT
    await runFull(testEnv, TODAY);

    // Fit-floor guard MUST fire: 0.2 < 0.4 and not urgent → no task created
    const acmeTasks = forgeTasks.filter((t) => t.opts.idempotencyKey.includes("acme"));
    expect(acmeTasks).toHaveLength(0);
  });

  it("window with explicit deadline in D1 bypasses fit-floor (urgent override from D1)", async () => {
    const { testEnv, forgeTasks } = makeEnv();
    const db = testEnv.DB;

    // Insert a low-fit window with explicit deadline set in D1
    await db
      .prepare(
        `INSERT OR REPLACE INTO windows(id,company,cycle,role_class,opens_est,closes_est,confidence,source,status,last_seen_open,created_at,updated_at,fit_score,deadline)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        "bravo:fall-2026:new-grad",
        "Bravo",
        "fall-2026",
        "new-grad",
        "2026-07-01",
        FUTURE,
        0.85,
        "board:test",
        "open",
        TODAY,
        Date.now(),
        Date.now(),
        0.1,          // very low fit_score
        "2026-07-15", // explicit deadline — urgency bypass
      )
      .run();

    await runFull(testEnv, TODAY);

    // Explicit deadline makes it urgent → fit-floor bypassed → task created
    const bravoTasks = forgeTasks.filter((t) => t.opts.idempotencyKey.includes("bravo"));
    expect(bravoTasks).toHaveLength(1);
  });
});

describe("H5: fit-floor via runDeadlines real D1 read path", () => {
  it("low-fit non-urgent window in D1 must be suppressed by runDeadlines too", async () => {
    const { testEnv, forgeTasks } = makeEnv();
    const db = testEnv.DB;

    await db
      .prepare(
        `INSERT OR REPLACE INTO windows(id,company,cycle,role_class,opens_est,closes_est,confidence,source,status,last_seen_open,created_at,updated_at,fit_score,deadline)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        "charlie:fall-2026:new-grad",
        "Charlie",
        "fall-2026",
        "new-grad",
        "2026-07-01",
        FUTURE,
        0.85,
        "board:test",
        "open",
        TODAY,
        Date.now(),
        Date.now(),
        0.15, // below floor
        null,
      )
      .run();

    await runDeadlines(testEnv, TODAY);

    const charlieTasks = forgeTasks.filter((t) => t.opts.idempotencyKey.includes("charlie"));
    expect(charlieTasks).toHaveLength(0);
  });
});
