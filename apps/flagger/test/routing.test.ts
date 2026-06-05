/**
 * routing.test.ts — Flagger queue consumer routing tests (WEEKLY-02, Plan 02-02 Task 2).
 *
 * Verifies the queue() handler routing behavior:
 * - P1 incident → pushFlag called AND canonical flag upsert sent to WIRE
 * - P2 incident → pushFlag called AND flag upsert sent to WIRE
 * - P3 incident → pushFlag NOT called BUT flag upsert sent to WIRE (board batch)
 * - P4 incident → pushFlag NOT called BUT flag upsert sent to WIRE
 * - Push gated off (NTFY_TOPIC unset) → no throw, flag still sent to WIRE
 * - Malformed incident (fails RawIncidentSchema) → msg.ack() + P3 flag DIRECTLY to WIRE (no retry)
 *
 * Pillar 1: WIRE never appears in consumers (only steward consumes atlas-wire).
 * The routing test verifies Flagger emits TO WIRE but does not CONSUME it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/index.js";
import type { RawIncident, FlagRecord } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import flaggerDefault from "../src/index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** A fake MessageBatch over a single incident. */
function fakeBatch(body: unknown, opts: { id?: string; attempts?: number } = {}) {
  const ack = vi.fn();
  const retry = vi.fn();
  const msg = {
    id: opts.id ?? "msg-1",
    timestamp: new Date(),
    attempts: opts.attempts ?? 1,
    body,
    ack,
    retry,
  };
  const batch = {
    queue: "atlas-incidents",
    messages: [msg],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
  return { batch, ack, retry, msg };
}

/** Build a test env with spied WIRE.send, INCIDENTS.send, and CONFIG. */
function makeTestEnv(opts: {
  pushEnabled?: boolean;
  ntfyTopicSet?: boolean;
} = {}) {
  const wireEvents: WireEvent[] = [];
  const pushCalls: Array<{ flag: FlagRecord; ackUrl: string }> = [];

  // Mock WIRE: spy on send
  const wireSend = vi.fn(async (event: WireEvent) => {
    wireEvents.push(event);
  });

  // Mock INCIDENTS: spy on send (for malformed → direct WIRE path, INCIDENTS not used)
  const incidentsSend = vi.fn(async () => {});

  // Mock CONFIG: push_enabled flag + NTFY_TOPIC presence
  const configData: Record<string, string> = {};
  if (opts.pushEnabled) {
    configData["flagger.push_enabled"] = "true";
  }

  // Mock ACK_TOKEN for push (separate from NTFY_TOKEN)
  const ackToken = "test-ack-token-abc123";
  const ntfyTopic = opts.ntfyTopicSet ? "test-private-topic" : undefined;
  const ntfyToken = "test-ntfy-token";

  const e: Env = {
    ...(env as unknown as Env),
    WIRE: {
      send: wireSend,
    } as unknown as Queue<WireEvent>,
    INCIDENTS: {
      send: incidentsSend,
    } as unknown as Queue<RawIncident>,
    FLAGGER_STATE: (env as unknown as Env).FLAGGER_STATE,
    CONFIG: {
      get: vi.fn(async (key: string) => configData[key] ?? null),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: "" })),
      getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
    } as unknown as KVNamespace,
    // Secrets Store bindings
    NTFY_TOPIC: ntfyTopic
      ? { get: vi.fn(async () => ntfyTopic) }
      : { get: vi.fn(async () => null) },
    NTFY_TOKEN: { get: vi.fn(async () => ntfyToken) },
    ACK_TOKEN: { get: vi.fn(async () => ackToken) },
  } as unknown as Env;

  return { env: e, wireEvents, pushCalls };
}

/** A valid P1 RawIncident. */
const p1Incident: RawIncident = {
  source_agent: "Forge",
  kind: "chain_halted",
  severity_hint: "P1",
  title: "Forge chain halted unexpectedly",
  detail: "step 3 failed",
};

/** A valid P2 RawIncident. */
const p2Incident: RawIncident = {
  source_agent: "Herald",
  kind: "security_leak_blocked",
  severity_hint: "P2",
  title: "Herald security leak blocked",
};

/** A valid P3 RawIncident. */
const p3Incident: RawIncident = {
  source_agent: "Sundial",
  kind: "calendar_sync_failed",
  severity_hint: "P3",
  title: "Sundial calendar sync failed",
};

/** A valid P4 RawIncident. */
const p4Incident: RawIncident = {
  source_agent: "Compass",
  kind: "overcommit",
  severity_hint: "P4",
  title: "Compass day plan overcommitted",
};

// ── tests ────────────────────────────────────────────────────────────────────

describe("Flagger queue() — routing (P1/P2 push; P3/P4 board-only; malformed → P3 direct)", () => {
  it("P1 incident: flag upsert sent to WIRE AND ntfy push called (push enabled + topic set)", async () => {
    const { env: e, wireEvents } = makeTestEnv({ pushEnabled: true, ntfyTopicSet: true });

    // Spy on fetch (ntfy push uses fetch)
    const fetchMock = vi.fn(async () => new Response("OK"));
    vi.stubGlobal("fetch", fetchMock);

    const { batch, ack, retry } = fakeBatch(p1Incident, { id: "p1-1" });
    await flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e);

    // Wire event should have been sent (flag upsert)
    expect(wireEvents.length).toBeGreaterThanOrEqual(1);
    const flagEvent = wireEvents.find(e => e.entity === "flag" && e.op === "upsert");
    expect(flagEvent).toBeDefined();
    expect(flagEvent?.agent).toBe("Flagger");
    expect(flagEvent?.type).toBe("flag");

    // ntfy push was called (fetch to ntfy.sh)
    expect(fetchMock).toHaveBeenCalledOnce();
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall?.[0]).toContain("ntfy.sh");

    // Message was ack'd (not retried)
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("P2 incident: push called + WIRE flag upsert sent", async () => {
    const { env: e, wireEvents } = makeTestEnv({ pushEnabled: true, ntfyTopicSet: true });
    const fetchMock = vi.fn(async () => new Response("OK"));
    vi.stubGlobal("fetch", fetchMock);

    const { batch, ack } = fakeBatch(p2Incident, { id: "p2-1" });
    await flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(wireEvents.some(e => e.entity === "flag" && e.op === "upsert")).toBe(true);
    expect(ack).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("P3 incident: push NOT called, WIRE flag upsert IS sent (board batch)", async () => {
    const { env: e, wireEvents } = makeTestEnv({ pushEnabled: true, ntfyTopicSet: true });
    const fetchMock = vi.fn(async () => new Response("OK"));
    vi.stubGlobal("fetch", fetchMock);

    const { batch, ack } = fakeBatch(p3Incident, { id: "p3-1" });
    await flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e);

    // P3 → no ntfy push
    expect(fetchMock).not.toHaveBeenCalled();
    // But flag upsert IS sent to WIRE
    expect(wireEvents.some(e => e.entity === "flag" && e.op === "upsert")).toBe(true);
    expect(ack).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("P4 incident: push NOT called, WIRE flag upsert IS sent", async () => {
    const { env: e, wireEvents } = makeTestEnv({ pushEnabled: true, ntfyTopicSet: true });
    const fetchMock = vi.fn(async () => new Response("OK"));
    vi.stubGlobal("fetch", fetchMock);

    const { batch, ack } = fakeBatch(p4Incident, { id: "p4-1" });
    await flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wireEvents.some(e => e.entity === "flag" && e.op === "upsert")).toBe(true);
    expect(ack).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("push gated off (NTFY_TOPIC unset) → no throw, flag still sent to WIRE (D2-03 fallback)", async () => {
    const { env: e, wireEvents } = makeTestEnv({ pushEnabled: true, ntfyTopicSet: false });
    const fetchMock = vi.fn(async () => new Response("OK"));
    vi.stubGlobal("fetch", fetchMock);

    const { batch, ack } = fakeBatch(p1Incident, { id: "p1-gated" });
    await expect(
      flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e),
    ).resolves.toBeUndefined();

    // Push gated off → fetch NOT called
    expect(fetchMock).not.toHaveBeenCalled();
    // But flag IS sent to WIRE
    expect(wireEvents.some(e => e.entity === "flag" && e.op === "upsert")).toBe(true);
    expect(ack).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("push_enabled false → push NOT called even for P1", async () => {
    const { env: e, wireEvents } = makeTestEnv({ pushEnabled: false, ntfyTopicSet: true });
    const fetchMock = vi.fn(async () => new Response("OK"));
    vi.stubGlobal("fetch", fetchMock);

    const { batch, ack } = fakeBatch(p1Incident, { id: "p1-disabled" });
    await flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e);

    // push_enabled=false → no ntfy push
    expect(fetchMock).not.toHaveBeenCalled();
    // Flag still upserted to WIRE
    expect(wireEvents.some(e => e.entity === "flag" && e.op === "upsert")).toBe(true);
    expect(ack).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("malformed incident (fails schema) → ack() + P3 flag DIRECTLY to WIRE (no retry)", async () => {
    const { env: e, wireEvents } = makeTestEnv();

    const malformed = { foo: "not a valid incident", missing_fields: true };
    const { batch, ack, retry } = fakeBatch(malformed, { id: "mal-1" });

    await flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e);

    // Always ack — never retry a malformed incident
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    // P3 flag sent directly to WIRE
    expect(wireEvents.length).toBeGreaterThanOrEqual(1);
    const malformedFlag = wireEvents.find(e => e.entity === "flag" && e.op === "upsert");
    expect(malformedFlag).toBeDefined();
    expect(malformedFlag?.agent).toBe("Flagger");
  });

  it("ntfy push failure → board fallback (no throw, flag still reaches WIRE)", async () => {
    const { env: e, wireEvents } = makeTestEnv({ pushEnabled: true, ntfyTopicSet: true });

    // Make fetch throw (network error)
    const fetchMock = vi.fn(async () => { throw new Error("ntfy.sh unreachable"); });
    vi.stubGlobal("fetch", fetchMock);

    const { batch, ack, retry } = fakeBatch(p1Incident, { id: "p1-pushfail" });
    await expect(
      flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e),
    ).resolves.toBeUndefined();

    // Flag still sent to WIRE (board fallback per D2-03)
    expect(wireEvents.some(e => e.entity === "flag" && e.op === "upsert")).toBe(true);
    // Message ack'd (not retried because of push failure)
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
