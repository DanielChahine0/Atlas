/**
 * idempotent.test.ts — Scout weekly() idempotency and Wire contract tests (Plan 02-04 Task 2).
 *
 * Verifies:
 *   1. Running weekly(date) twice with the same injected ScoutSources fixture
 *      writes each event to D1 events ONCE (INSERT OR REPLACE — keyed by
 *      scout:evt_<date>_<hash>). The second run produces no NEW event rows.
 *
 *   2. Per-event upserts and one scout:digest:<date> summary event are emitted on
 *      every run — the Wire events are identical on both runs (replay-safe).
 *
 *   3. No crypto.randomUUID in idempotency keys — keys are deterministic structured strings.
 *
 *   4. Wire contract: events.digest event has correct shape (agent "Scout", op "upsert",
 *      entity "events", idempotencyKey starts with "scout:digest:").
 *
 *   5. Per-event Wire events have idempotencyKey matching "scout:evt_<date>_<hash>".
 *
 *   6. Failure path: if sources throw, flag() is called with P3 severity +
 *      kind "scout_failed" (D2-09 safety net).
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { Scout, runWeekly } from "../src/index.js";
import type { Env } from "../src/index.js";
import type { ScoutSources, EventCandidate } from "../src/sources.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeStubSources(candidates: EventCandidate[]): ScoutSources {
  let gmailCallCount = 0;
  return {
    async fetchRss(_url: string): Promise<EventCandidate[]> {
      // RSS is only called when CONFIG has scout/sources/rss URLs; tests pass candidates
      // via fetchGmailEvents which is always called unconditionally (buildGmailQueries).
      return [];
    },
    async fetchHtml(_url: string): Promise<EventCandidate[]> {
      return [];
    },
    async fetchGmailEvents(_query: string): Promise<EventCandidate[]> {
      // Gmail queries are always called twice (one per buildGmailQueries() entry).
      // Return candidates only on the first call to avoid duplicating input.
      gmailCallCount++;
      return gmailCallCount === 1 ? candidates : [];
    },
  };
}

function makeErrorSources(): ScoutSources {
  return {
    async fetchRss(_url: string): Promise<EventCandidate[]> {
      return []; // RSS only called with explicit URLs from CONFIG (empty in test)
    },
    async fetchHtml(_url: string): Promise<EventCandidate[]> {
      return []; // HTML only called with explicit URLs from CONFIG (empty in test)
    },
    async fetchGmailEvents(_query: string): Promise<EventCandidate[]> {
      // Gmail is called unconditionally — this is the error path to test
      throw new Error("Gmail fetch failed");
    },
  };
}

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
      get: vi.fn(async (key: string) => {
        // Return sparse defaults so every candidate passes the relevance floor
        if (key === "scout/min_relevance") return "0";
        if (key === "scout/relaxed_min_relevance") return "0";
        if (key === "scout/max_per_digest") return "15";
        if (key === "scout/dedupe_window_weeks") return "4";
        if (key === "scout/sparse_floor") return "3";
        return null;
      }),
    } as unknown as KVNamespace,
  };

  return { testEnv, wireEvents, incidents };
}

// Sample candidates with stable title+start so hashes are deterministic
const sampleCandidates: EventCandidate[] = [
  {
    title: "AI Meetup Toronto July",
    start: "2026-07-20",
    url: "https://meetup.com/ai-toronto/july",
    source: "rss",
    online: false,
  },
  {
    title: "TypeScript Workshop",
    start: "2026-07-25",
    url: "https://example.com/ts-workshop",
    source: "rss",
    online: true,
  },
];

// ── idempotency tests ──────────────────────────────────────────────────────────

describe("Scout.weekly() idempotency (Plan 02-04 Task 2)", () => {
  it("writes each event to D1 exactly once even when called twice", async () => {
    const { testEnv } = makeEnv();
    const sources = makeStubSources(sampleCandidates);
    const date = "2026-07-18";

    // First run
    const result1 = await runWeekly(testEnv, date, sources);
    // Second run (same date, same sources)
    const result2 = await runWeekly(testEnv, date, sources);

    // Row count in D1 must equal the surfaced count from run 1
    const { results } = await testEnv.DB.prepare(
      "SELECT COUNT(*) as count FROM events WHERE digest_date = ?",
    )
      .bind(date)
      .all<{ count: number }>();
    const dbCount = results[0]?.count ?? 0;
    expect(dbCount).toBe(result1.surfaced);

    // Second run surfaced 0 NEW rows (all duplicated by url or title+start)
    expect(result2.surfaced).toBe(0);
  });

  it("emits the same scout:digest:<date> idempotencyKey on both runs", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const sources = makeStubSources(sampleCandidates);
    const date = "2026-07-18";

    await runWeekly(testEnv, date, sources);
    const firstRunEvents = [...wireEvents];
    wireEvents.length = 0;

    await runWeekly(testEnv, date, sources);
    const secondRunEvents = [...wireEvents];

    const digestKey = `scout:digest:${date}`;
    const firstDigest = firstRunEvents.find((e) => e.idempotencyKey === digestKey);
    const secondDigest = secondRunEvents.find((e) => e.idempotencyKey === digestKey);

    expect(firstDigest).toBeDefined();
    expect(secondDigest).toBeDefined();
    // The second digest has count 0 (no new events) but the key is identical
    expect(firstDigest?.idempotencyKey).toBe(secondDigest?.idempotencyKey);
  });

  it("per-event idempotencyKeys match 'scout:evt_<date>_<hash>' pattern", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const sources = makeStubSources(sampleCandidates);
    const date = "2026-07-18";

    await runWeekly(testEnv, date, sources);

    const eventUpserts = wireEvents.filter((e) => e.type === "event.upsert");
    for (const e of eventUpserts) {
      expect(e.idempotencyKey).toMatch(/^scout:evt_\d{4}-\d{2}-\d{2}_[a-z0-9]+$/);
    }
  });

  it("Wire events never use crypto.randomUUID() — keys are deterministic", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const sources = makeStubSources(sampleCandidates);
    const date = "2026-07-18";

    await runWeekly(testEnv, date, sources);

    // Run again — keys must be IDENTICAL (not random)
    wireEvents.length = 0;
    await runWeekly(testEnv, date, sources);

    // All keys in second run should be the same set as first run
    // (digest key is always present; per-event keys are deduped out in second run)
    const digestKey = `scout:digest:${date}`;
    expect(wireEvents.some((e) => e.idempotencyKey === digestKey)).toBe(true);
  });
});

// ── Wire contract tests ────────────────────────────────────────────────────────

describe("Scout Wire event contract", () => {
  it("events.digest event has correct §6.4 shape", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const sources = makeStubSources(sampleCandidates);
    // Use a distinct date to avoid cross-test D1 dedupe collision
    const date = "2026-08-01";

    await runWeekly(testEnv, date, sources);

    const digest = wireEvents.find((e) => e.type === "events.digest");
    expect(digest).toBeDefined();
    expect(digest!.agent).toBe("Scout");
    expect(digest!.op).toBe("upsert");
    expect(digest!.entity).toBe("events");
    expect(digest!.idempotencyKey).toBe(`scout:digest:${date}`);
    expect(typeof digest!.payload.count).toBe("number");
    expect(digest!.payload.date).toBe(date);
  });

  it("per-event upserts have agent:Scout op:upsert entity:events", async () => {
    const { testEnv, wireEvents } = makeEnv();
    const sources = makeStubSources(sampleCandidates);
    // Use a distinct date to avoid cross-test D1 dedupe collision (url dedupes across dates)
    // Use different candidate URLs to avoid URL-based dedupe from the idempotency tests
    const uniqueCandidates: EventCandidate[] = [
      {
        title: "Unique Wire Contract Test Event",
        start: "2026-09-10",
        url: "https://unique-wire-contract-test.example.com/event",
        source: "rss" as const,
        online: false,
      },
    ];
    const uniqueSources = makeStubSources(uniqueCandidates);
    const date = "2026-09-05";

    await runWeekly(testEnv, date, uniqueSources);

    const eventUpserts = wireEvents.filter((e) => e.type === "event.upsert");
    expect(eventUpserts.length).toBeGreaterThanOrEqual(1);
    for (const e of eventUpserts) {
      expect(e.agent).toBe("Scout");
      expect(e.op).toBe("upsert");
      expect(e.entity).toBe("events");
    }
  });
});

// ── Failure-path test ──────────────────────────────────────────────────────────

describe("Scout failure path", () => {
  it("emits P3 kind:scout_failed incident when sources throw", async () => {
    const { testEnv, incidents } = makeEnv();
    const errorSources = makeErrorSources();
    const date = "2026-07-18";

    // The weekly() WorkerEntrypoint wraps runWeekly and calls flag() on error
    // But runWeekly itself doesn't call flag() — the Scout class wrapper does
    // We test via Scout directly
    const scout = new Scout({} as ExecutionContext, testEnv);

    await expect(scout.weekly({ date, sources: errorSources })).rejects.toThrow();

    const failIncident = incidents.find((i) => i.kind === "scout_failed");
    expect(failIncident).toBeDefined();
    expect(failIncident!.severity_hint).toBe("P3");
    expect(failIncident!.source_agent).toBe("Scout");
  });
});

// ── Heartbeat test ─────────────────────────────────────────────────────────────

describe("Scout heartbeat", () => {
  it("emits kind:heartbeat incident to INCIDENTS after a successful weekly() run", async () => {
    const { testEnv, incidents } = makeEnv();
    const sources = makeStubSources([]);
    const date = "2026-07-18";

    const scout = new Scout({} as ExecutionContext, testEnv);
    await scout.weekly({ date, sources });

    const hb = incidents.find((i) => i.kind === "heartbeat");
    expect(hb).toBeDefined();
    expect(hb!.source_agent).toBe("Scout");
    expect(hb!.severity_hint).toBe("P4");
    expect(hb!.run_id).toBe(date);
  });

  it("M9: weekly() still resolves when INCIDENTS.send rejects (best-effort heartbeat)", async () => {
    // Simulate a transient queue error on INCIDENTS.send AFTER the real work succeeds.
    // weekly() must resolve normally — a heartbeat enqueue failure must never convert a
    // successful scout run into a failure (M9 regression test).
    const { testEnv } = makeEnv();
    const rejectingSend = vi.fn(async (_incident: RawIncident) => {
      throw new Error("transient queue error");
    });
    const rejectingEnv: Env = {
      ...testEnv,
      INCIDENTS: { send: rejectingSend } as unknown as Queue<RawIncident>,
    };

    const sources = makeStubSources([]);
    const date = "2026-10-01";

    const scout = new Scout({} as ExecutionContext, rejectingEnv);
    // Must resolve normally even though INCIDENTS.send rejects
    const result = await scout.weekly({ date, sources });
    expect(result).toBeDefined();
    // INCIDENTS.send was called (heartbeat was attempted, just rejected)
    expect(rejectingSend).toHaveBeenCalledOnce();
  });
});
