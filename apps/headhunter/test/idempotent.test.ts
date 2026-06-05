/**
 * idempotent.test.ts — Headhunter window/job idempotency tests (Plan 02-05 Task 1 — GATING).
 *
 * Verifies:
 *   1. Advancing the same window twice (same company/cycle) keeps ONE windows row
 *      and yields the SAME apply-by task idempotencyKey headhunter:window:<co>:<cycle>
 *      — no counter inflation; re-scan produces the same jobs rows (UNIQUE fingerprint).
 *
 *   2. Wire-contract: scan summary uses op:"upsert" with idempotencyKey headhunter:scan:<date>.
 *
 *   3. Replay-safe: calling upsertWindow twice on the same (company, cycle) row does NOT
 *      create a second D1 row (INSERT OR REPLACE dedupes by primary key).
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import {
  upsertWindow,
  upsertJob,
  decideWindow,
  buildScanSummaryEvent,
  type WindowRow,
  type JobRow,
} from "../src/windows.js";
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
    id: "google:fall-2026:new-grad",
    company: "Google",
    cycle: "fall-2026",
    role_class: "new-grad",
    opens_est: "2026-08-01",
    closes_est: "2026-09-30",
    confidence: 0.85,
    source: "board:levels.fyi",
    status: "open",
    last_seen_open: BASE_DATE,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function makeJob(window: WindowRow, overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "google:swe-new-grad:mountain-view:fall-2026",
    company: window.company,
    title_norm: "SWE New Grad",
    location_norm: "Mountain View",
    cycle: window.cycle,
    window_id: window.id,
    sources: JSON.stringify(["https://careers.google.com/jobs/123"]),
    deadline: window.closes_est,
    fit_score: 0.8,
    status: "new",
    first_seen: BASE_DATE,
    last_seen: BASE_DATE,
    ...overrides,
  };
}

// ── idempotency tests ──────────────────────────────────────────────────────────

describe("Headhunter window idempotency (GATING)", () => {
  it("upserting the same window twice keeps exactly ONE windows row", async () => {
    const { testEnv } = makeEnv();
    const window = makeWindow();

    await upsertWindow(testEnv.DB, window);
    await upsertWindow(testEnv.DB, window); // second upsert — same id

    const { results } = await testEnv.DB.prepare(
      "SELECT COUNT(*) as count FROM windows WHERE company = ? AND cycle = ?",
    )
      .bind(window.company, window.cycle)
      .all<{ count: number }>();

    expect(results[0]?.count).toBe(1);
  });

  it("upserting the same job twice keeps exactly ONE jobs row (UNIQUE fingerprint)", async () => {
    const { testEnv } = makeEnv();
    const window = makeWindow();
    const job = makeJob(window);

    await upsertWindow(testEnv.DB, window);
    await upsertJob(testEnv.DB, job);
    await upsertJob(testEnv.DB, job); // second upsert — same fingerprint (company+title_norm+cycle)

    const { results } = await testEnv.DB.prepare(
      "SELECT COUNT(*) as count FROM jobs WHERE company = ? AND title_norm = ? AND cycle = ?",
    )
      .bind(job.company, job.title_norm, job.cycle)
      .all<{ count: number }>();

    expect(results[0]?.count).toBe(1);
  });

  it("decideWindow produces the SAME task idempotencyKey for the same window on re-scan", async () => {
    const { testEnv, incidents } = makeEnv();
    const window = makeWindow();

    const decision1 = decideWindow(window, { leadTimeDays: 21, fitFloor: 0.4, date: BASE_DATE });
    const decision2 = decideWindow(window, { leadTimeDays: 21, fitFloor: 0.4, date: BASE_DATE });

    // No low-confidence incidents should be emitted
    expect(incidents).toHaveLength(0);

    // Both decisions should produce the SAME idempotency key (stable, structured, not random)
    expect(decision1).not.toBeNull();
    expect(decision2).not.toBeNull();
    expect(decision1!.idempotencyKey).toBe(decision2!.idempotencyKey);
    expect(decision1!.idempotencyKey).toBe(`headhunter:window:google:fall-2026`);
  });
});

describe("Headhunter Wire scan summary contract", () => {
  it("scan summary idempotencyKey matches headhunter:scan:<date>", () => {
    const evt = buildScanSummaryEvent(BASE_DATE, 3, 1);
    expect(evt.idempotencyKey).toBe(`headhunter:scan:${BASE_DATE}`);
    expect(evt.op).toBe("upsert");
    expect(evt.agent).toBe("Headhunter");
    expect(evt.entity).toBe("windows");
  });
});
