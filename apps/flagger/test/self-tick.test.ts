// self-tick.test.ts — H4 self-tick cron handler regression test (Plan 02-gap).
//
// Flagger's scheduled() handler fires every 10 min (every-10-min cron) and writes
// "flagger:last_seen" to CONFIG KV so the watchdog sees a liveness signal
// independent of incident volume. This test locks in the exact key and value
// shape so a regression (wrong key name, removed put, wrong value type) fails CI.
//
// Production behavior the watchdog depends on:
//   env.CONFIG.put("flagger:last_seen", String(Date.now()))
//
// This is a pure unit test (no workerd required — no DO, no D1).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import flaggerDefault from "../src/index.js";
import type { Env } from "../src/index.js";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMinimalEnv(): { env: Env; configPut: ReturnType<typeof vi.fn> } {
  const configPut = vi.fn(async (_key: string, _value: string) => {});

  const e: Env = {
    WIRE: { send: vi.fn(async () => {}) } as unknown as Queue<WireEvent>,
    INCIDENTS: { send: vi.fn(async () => {}) } as unknown as Queue<RawIncident>,
    CONFIG: {
      get: vi.fn(async () => null),
      put: configPut,
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: "" })),
      getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
    } as unknown as KVNamespace,
    FLAGGER_STATE: {} as unknown as DurableObjectNamespace,
    NTFY_TOPIC: { get: vi.fn(async () => null) } as unknown as SecretsStoreSecret,
    NTFY_TOKEN: { get: vi.fn(async () => null) } as unknown as SecretsStoreSecret,
    ACK_TOKEN: { get: vi.fn(async () => null) } as unknown as SecretsStoreSecret,
  } as unknown as Env;

  return { env: e, configPut };
}

// ── H4 tests ─────────────────────────────────────────────────────────────────

describe("H4 — Flagger self-tick cron handler (scheduled)", () => {
  let dateSpy: ReturnType<typeof vi.spyOn>;
  const FIXED_EPOCH = 1749168000000; // 2026-06-06T00:00:00Z

  beforeEach(() => {
    dateSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_EPOCH);
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  it("writes CONFIG.put('flagger:last_seen', ...) on scheduled()", async () => {
    const { env, configPut } = makeMinimalEnv();

    const fakeController = { scheduledTime: FIXED_EPOCH, cron: "*/10 * * * *" } as ScheduledController;
    await flaggerDefault.scheduled(fakeController, env);

    // The handler must call CONFIG.put at least once
    expect(configPut).toHaveBeenCalled();

    // The EXACT key the watchdog reads must be "flagger:last_seen"
    const [key, value] = configPut.mock.calls[0] as [string, string];
    expect(key).toBe("flagger:last_seen");

    // The value must be a numeric string (String(Date.now())) — the watchdog
    // parses it with parseInt to compare against Date.now() for staleness.
    expect(typeof value).toBe("string");
    expect(/^\d+$/.test(value)).toBe(true);
    expect(Number(value)).toBe(FIXED_EPOCH);
  });

  it("writes a numeric-string timestamp (parseable as ms epoch)", async () => {
    const { env, configPut } = makeMinimalEnv();

    const fakeController = { scheduledTime: FIXED_EPOCH, cron: "*/10 * * * *" } as ScheduledController;
    await flaggerDefault.scheduled(fakeController, env);

    const [, value] = configPut.mock.calls[0] as [string, string];
    const parsed = Number(value);

    // Must be a finite number (not NaN, not Infinity)
    expect(Number.isFinite(parsed)).toBe(true);
    // Must be plausibly a Unix millisecond epoch (> year 2020)
    expect(parsed).toBeGreaterThan(1_577_836_800_000); // 2020-01-01
  });

  it("scheduled() resolves without throwing even if CONFIG.put rejects", async () => {
    // The production handler uses .catch(() => {}) — a KV error must never surface
    // as a thrown exception from scheduled() (would count as a Worker failure).
    const { env } = makeMinimalEnv();
    // Override put to reject
    (env.CONFIG as unknown as { put: ReturnType<typeof vi.fn> }).put = vi.fn(async () => {
      throw new Error("KV transient error");
    });

    const fakeController = { scheduledTime: FIXED_EPOCH, cron: "*/10 * * * *" } as ScheduledController;
    // Must resolve, not reject
    await expect(flaggerDefault.scheduled(fakeController, env)).resolves.toBeUndefined();
  });
});
