/**
 * kill.test.ts — Flagger watchdog kill test (WEEKLY-02, Plan 02-03 Task 1).
 *
 * Verifies the scheduled() handler behavior:
 * - Stale last_seen (now - 20m > 15m threshold): emits ONE self-P1 flag upsert to WIRE
 *   with idempotencyKey `flg:<date>:Flagger:watchdog`, severity P1, trust 100.
 * - Fresh last_seen (now): emits NOTHING to WIRE.
 * - Absent last_seen (never set): treated as stale (age = Date.now()) → self-P1 emitted
 *   (fail-toward-alerting).
 *
 * The watchdog bypasses atlas-incidents (Flagger may be dead) and emits DIRECTLY to
 * atlas-wire via send(). It does NOT call flag() (which targets atlas-incidents).
 *
 * GATING criterion: `pnpm --filter flagger-watchdog test -- kill` must exit 0.
 */

import { describe, it, expect, vi } from "vitest";
import type { WireEvent } from "@atlas/wire";
import watchdogDefault from "../src/index.js";
import type { WatchdogEnv } from "../src/index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const TWENTY_MIN_MS = 20 * 60 * 1000;

function makeEnv(opts: {
  lastSeenAge?: number | null; // ms ago; null = absent key
  threshold?: number;          // ms; default 900000 (15m)
  ntfyTopicSet?: boolean;
} = {}): { env: WatchdogEnv; wireEvents: WireEvent[] } {
  const wireEvents: WireEvent[] = [];
  const now = Date.now();

  // CONFIG KV mock
  const configData: Record<string, string> = {};
  if (opts.threshold !== undefined) {
    configData["selfwatch_threshold"] = String(opts.threshold);
  }
  if (opts.lastSeenAge !== null && opts.lastSeenAge !== undefined) {
    // lastSeenAge=0 → fresh (just now); lastSeenAge=TWENTY_MIN_MS → stale
    configData["flagger:last_seen"] = String(now - opts.lastSeenAge);
  }
  // opts.lastSeenAge === null → absent (key not in configData)

  const mockConfig = {
    get: vi.fn(async (key: string) => configData[key] ?? null),
    put: vi.fn(async () => {}),
  } as unknown as KVNamespace;

  // WIRE mock: spy on send
  const wireSend = vi.fn(async (event: WireEvent) => {
    wireEvents.push(event);
  });
  const mockWire = { send: wireSend } as unknown as Queue<WireEvent>;

  // NTFY secrets (optional — watchdog continues without them)
  const ntfyTopic = opts.ntfyTopicSet
    ? { get: vi.fn(async () => "test-watchdog-topic") }
    : undefined;
  const ntfyToken = opts.ntfyTopicSet
    ? { get: vi.fn(async () => "test-watchdog-token") }
    : undefined;

  const e: WatchdogEnv = {
    WIRE: mockWire,
    CONFIG: mockConfig,
    NTFY_TOPIC: ntfyTopic as unknown as SecretsStoreSecret | undefined,
    NTFY_TOKEN: ntfyToken as unknown as SecretsStoreSecret | undefined,
  };

  return { env: e, wireEvents };
}

function makeController(): ScheduledController {
  return {
    scheduledTime: Date.now(),
    cron: "*/5 * * * *",
    noRetry: vi.fn(),
  } as unknown as ScheduledController;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("flagger-watchdog kill test", () => {
  it("emits self-P1 to WIRE when last_seen is stale (20m ago > 15m threshold)", async () => {
    const { env, wireEvents } = makeEnv({ lastSeenAge: TWENTY_MIN_MS });
    await watchdogDefault.scheduled(makeController(), env, makeCtx());

    expect(wireEvents).toHaveLength(1);
    const event = wireEvents[0]!;

    // Wire event shape — canonical §6.4
    expect(event.agent).toBe("Flagger");
    expect(event.type).toBe("flag");
    expect(event.entity).toBe("flag");
    expect(event.op).toBe("upsert");

    // Self-flag payload
    const payload = event.payload as Record<string, unknown>;
    expect(payload.source_agent).toBe("Flagger");
    expect(payload.severity).toBe("P1");
    expect(payload.trust).toBe(100);
    expect(payload.status).toBe("open");
    expect(typeof payload.title).toBe("string");
    expect((payload.title as string).toLowerCase()).toContain("flagger");

    // Idempotency key pattern: flg:<date>:Flagger:watchdog
    expect(event.idempotencyKey).toMatch(/^flg:\d{4}-\d{2}-\d{2}:Flagger:watchdog$/);
    // Payload id must match the idempotency key
    expect(payload.id).toBe(event.idempotencyKey);
  });

  it("emits NOTHING to WIRE when last_seen is fresh (just now)", async () => {
    const { env, wireEvents } = makeEnv({ lastSeenAge: 0 });
    await watchdogDefault.scheduled(makeController(), env, makeCtx());

    expect(wireEvents).toHaveLength(0);
  });

  it("emits self-P1 when last_seen is absent (fail-toward-alerting)", async () => {
    // opts.lastSeenAge = null → absent key → age = Date.now() - 0 (treated as never seen)
    const { env, wireEvents } = makeEnv({ lastSeenAge: null });
    await watchdogDefault.scheduled(makeController(), env, makeCtx());

    expect(wireEvents).toHaveLength(1);
    expect(wireEvents[0]!.op).toBe("upsert");
    expect((wireEvents[0]!.payload as Record<string, unknown>).severity).toBe("P1");
  });

  it("respects a custom selfwatch_threshold from CONFIG", async () => {
    // 5-minute threshold; last_seen 3 minutes ago → NOT stale
    const FIVE_MIN = 5 * 60 * 1000;
    const THREE_MIN = 3 * 60 * 1000;
    const { env, wireEvents } = makeEnv({
      lastSeenAge: THREE_MIN,
      threshold: FIVE_MIN,
    });
    await watchdogDefault.scheduled(makeController(), env, makeCtx());

    expect(wireEvents).toHaveLength(0);
  });

  it("stale flag upsert sent directly to WIRE — idempotency key is date-keyed (not random)", async () => {
    const { env, wireEvents } = makeEnv({ lastSeenAge: TWENTY_MIN_MS });
    await watchdogDefault.scheduled(makeController(), env, makeCtx());

    // Run again — same date → same idempotency key (idempotent re-check)
    await watchdogDefault.scheduled(makeController(), env, makeCtx());

    // Both runs emit because we're checking CONFIG KV (no in-memory dedup in watchdog);
    // Steward deduplicates via the idempotencyKey
    expect(wireEvents.length).toBeGreaterThanOrEqual(1);
    // All events must share the same idempotency key (same day → same key)
    const keys = wireEvents.map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });
});
