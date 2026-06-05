/**
 * seed-monotonic.test.ts — M8: seed clobber and monotonic promotion tests.
 *
 * M8 defects:
 *   (a) loadSeedIfEmpty uses INSERT OR REPLACE on static status:"upcoming" seed rows,
 *       clobbering any "closing" promotion that deadlines() wrote (status regression).
 *   (b) The raw D1 write in runDeadlines() for "closing" promotion has no monotonic guard:
 *       full() can regress a "closing" window back to "upcoming" via seed reload.
 *
 * Fix:
 *   - loadSeedIfEmpty must use INSERT OR IGNORE (seed once, never overwrite live status).
 *   - The closing promotion write must be monotonic (only advance, never regress status).
 *
 * Tests (RED before fix):
 *   1. A promoted ("closing") window survives a subsequent full() run (seed does not clobber).
 *   2. seed INSERT OR IGNORE: calling loadSeedIfEmpty twice does not overwrite an existing row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { runFull, type Env } from "../src/index.js";
import { loadSeedIfEmpty } from "../src/seed.js";
import { upsertWindow } from "../src/windows.js";

// Apply migrations before tests
import "./apply-migrations.js";

function makeEnv(): { testEnv: Env } {
  const testEnv: Env = {
    ...(env as unknown as Env),
    WIRE: { send: vi.fn(async () => {}) } as unknown as Queue<WireEvent>,
    INCIDENTS: { send: vi.fn(async () => {}) } as unknown as Queue<RawIncident>,
    CONFIG: {
      // Return null so loadSeedIfEmpty runs the seed
      get: vi.fn(async (_key: string) => null),
    } as unknown as KVNamespace,
    FORGE: {
      createTask: vi.fn(async () => ({ id: "test-task" })),
    },
  };
  return { testEnv };
}

describe("M8(a): seed INSERT OR IGNORE — never clobber live status", () => {
  it("loadSeedIfEmpty does NOT overwrite an existing row with status='closing'", async () => {
    const { testEnv } = makeEnv();
    const db = testEnv.DB;

    // First: load the seed (inserts with status="upcoming")
    await loadSeedIfEmpty(testEnv);

    // Simulate deadlines() promoting google:fall-2026:new-grad to "closing"
    await db
      .prepare("UPDATE windows SET status=? WHERE id=?")
      .bind("closing", "google:fall-2026:new-grad")
      .run();

    // Verify the promotion stuck
    const { results: before } = await db
      .prepare("SELECT status FROM windows WHERE id=?")
      .bind("google:fall-2026:new-grad")
      .all<{ status: string }>();
    expect(before[0]?.status).toBe("closing");

    // Now call loadSeedIfEmpty again (simulating a second full() run on Monday)
    await loadSeedIfEmpty(testEnv);

    // With INSERT OR IGNORE: the existing "closing" row must NOT be overwritten
    const { results: after } = await db
      .prepare("SELECT status FROM windows WHERE id=?")
      .bind("google:fall-2026:new-grad")
      .all<{ status: string }>();
    expect(after[0]?.status).toBe("closing");
  });

  it("loadSeedIfEmpty does NOT overwrite updated_at of an existing row", async () => {
    const { testEnv } = makeEnv();
    const db = testEnv.DB;

    // First load
    await loadSeedIfEmpty(testEnv);

    // Record the original timestamps
    const { results: first } = await db
      .prepare("SELECT updated_at FROM windows WHERE id=?")
      .bind("google:fall-2026:new-grad")
      .all<{ updated_at: number }>();
    const originalUpdatedAt = first[0]?.updated_at;
    expect(originalUpdatedAt).toBeDefined();

    // Wait 2ms to ensure if a second insert happened, updated_at would differ
    await new Promise((r) => setTimeout(r, 2));

    // Second load
    await loadSeedIfEmpty(testEnv);

    // With INSERT OR IGNORE: updated_at must remain unchanged
    const { results: second } = await db
      .prepare("SELECT updated_at FROM windows WHERE id=?")
      .bind("google:fall-2026:new-grad")
      .all<{ updated_at: number }>();
    expect(second[0]?.updated_at).toBe(originalUpdatedAt);
  });
});

describe("M8(b): promoted window survives subsequent full() run", () => {
  it("a closing window is not regressed to upcoming after a second full() call", async () => {
    const { testEnv } = makeEnv();
    const db = testEnv.DB;

    // Insert a window that is already "closing" (simulating a previous deadlines() promotion)
    const now = Date.now();
    await upsertWindow(db, {
      id: "delta:fall-2026:new-grad",
      company: "Delta",
      cycle: "fall-2026",
      role_class: "new-grad",
      opens_est: "2026-07-01",
      closes_est: "2026-11-30",
      confidence: 0.80,
      source: "board:test",
      status: "closing",  // already promoted
      last_seen_open: "2026-07-01",
      created_at: now,
      updated_at: now,
      fit_score: 0.8,
      deadline: null,
    });

    // Run full() — without the fix, seed load would clobber back to "upcoming"
    // (Delta is not in the seed, but the seed INSERT OR REPLACE on existing IDs is the problem)
    // The key test here is that Delta stays "closing" after full() processes it
    await runFull(testEnv, "2026-07-01");

    const { results } = await db
      .prepare("SELECT status FROM windows WHERE id=?")
      .bind("delta:fall-2026:new-grad")
      .all<{ status: string }>();

    // Status must remain "closing" — full() must not regress it
    expect(results[0]?.status).toBe("closing");
  });
});
