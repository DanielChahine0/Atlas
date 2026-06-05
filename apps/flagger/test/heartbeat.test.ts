/**
 * heartbeat.test.ts — H1/H3 gap-closure tests for Flagger (Phase 2, gap-pass 2).
 *
 * H1: a heartbeat incident through queue() seeds an `hb:<agent>` slot AND produces
 *     NO flag upsert / NO atlas-wire event.
 * H3: a single stale slot fires the heartbeat_stale incident ONCE even if alarm() is
 *     invoked again (no storm — the slot is advanced so it doesn't re-emit).
 */

import { describe, it, expect, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/index.js";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import type { FlaggerState, HeartbeatSlot } from "../src/state.js";
import flaggerDefault from "../src/index.js";

const FLAGGER_STATE = (env as unknown as { FLAGGER_STATE: DurableObjectNamespace<FlaggerState> }).FLAGGER_STATE;

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeBatch(body: unknown, opts: { id?: string } = {}) {
  const ack = vi.fn();
  const retry = vi.fn();
  const msg = {
    id: opts.id ?? "hb-msg-1",
    timestamp: new Date(),
    attempts: 1,
    body,
    ack,
    retry,
  };
  return {
    batch: {
      queue: "atlas-incidents",
      messages: [msg],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    },
    ack,
    retry,
  };
}

function makeTestEnv(): Env {
  const wireEvents: WireEvent[] = [];
  const wireSend = vi.fn(async (event: WireEvent) => {
    wireEvents.push(event);
  });
  const incidentsSend = vi.fn(async () => {});

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
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: "" })),
      getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
    } as unknown as KVNamespace,
    NTFY_TOPIC: { get: vi.fn(async () => null) } as unknown as SecretsStoreSecret,
    NTFY_TOKEN: { get: vi.fn(async () => null) } as unknown as SecretsStoreSecret,
    ACK_TOKEN: { get: vi.fn(async () => null) } as unknown as SecretsStoreSecret,
  } as unknown as Env;

  return Object.assign(e, { _wireEvents: wireEvents });
}

// ── H1 tests ─────────────────────────────────────────────────────────────────

describe("H1 — heartbeat incident branches into recordHeartbeat (no flag / no wire emit)", () => {
  it("heartbeat incident → recordHeartbeat called, hb:slot written, NO WIRE event emitted, msg.ack()", async () => {
    const e = makeTestEnv();
    const wireEvents = (e as unknown as { _wireEvents: WireEvent[] })._wireEvents;

    const heartbeatIncident: RawIncident = {
      source_agent: "Filer",
      kind: "heartbeat",
      severity_hint: "P4",
      title: "Filer heartbeat",
      run_id: "filer:sweep:2026-06-05",
    };

    const { batch, ack, retry } = fakeBatch(heartbeatIncident);
    await flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e);

    // No wire events should be emitted (no flag upsert)
    expect(wireEvents).toHaveLength(0);

    // Message ack'd (not retried)
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    // hb:Filer slot should be written in the DO storage
    const stub = e.FLAGGER_STATE.getByName("fleet");
    const slot = await runInDurableObject(stub, async (_instance, state) => {
      return state.storage.get<HeartbeatSlot>("hb:Filer");
    });
    expect(slot).not.toBeNull();
    expect(slot?.agent).toBe("Filer");
  });

  it("heartbeat incident → no flag upsert in DO (no open flag created)", async () => {
    const e = makeTestEnv();
    const wireEvents = (e as unknown as { _wireEvents: WireEvent[] })._wireEvents;

    const heartbeatIncident: RawIncident = {
      source_agent: "Herald",
      kind: "heartbeat",
      severity_hint: "P4",
      title: "Herald heartbeat",
      run_id: "herald:daily:2026-06-05",
    };

    const { batch } = fakeBatch(heartbeatIncident, { id: "hb-herald-1" });
    await flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e);

    // No WIRE events
    expect(wireEvents).toHaveLength(0);

    // No open flags in DO
    const stub = e.FLAGGER_STATE.getByName("fleet");
    const flags = await runInDurableObject(stub, async (_instance, state) => {
      return state.storage.list({ prefix: "flag:" });
    });
    expect(flags.size).toBe(0);
  });
});

// ── H3 tests ─────────────────────────────────────────────────────────────────

describe("H3 — stale-heartbeat alarm fires once and advances slot (no storm)", () => {
  it("single stale slot fires heartbeat_stale incident ONCE; second alarm() call does NOT re-emit", async () => {
    const stub = FLAGGER_STATE.getByName("fleet-h3-no-storm");

    const { firstCount, secondCount } = await runInDurableObject(stub, async (instance, state) => {
      const firstIncidents: RawIncident[] = [];
      const secondIncidents: RawIncident[] = [];

      // Inject INCIDENTS spy
      const inst = instance as unknown as { env: { INCIDENTS: { send: (e: RawIncident) => Promise<void> } } };

      const now = Date.now();
      const GRACE_MS = 10 * 60 * 1000;

      // Stale slot
      const staleSlot: HeartbeatSlot = {
        agent: "Sundial",
        cron_utc: "20 12 * * *",
        grace_ms: GRACE_MS,
        last_seen: now - 40 * 60 * 1000,
        expected_by: now - 20 * 60 * 1000,
      };
      await state.storage.put("hb:Sundial", staleSlot);

      // First alarm call — stale, should emit
      inst.env = {
        ...inst.env,
        INCIDENTS: { send: vi.fn(async (inc: RawIncident) => { firstIncidents.push(inc); }) },
      };
      await instance.runAlarm();

      // Second alarm call — slot should be advanced, should NOT re-emit
      inst.env = {
        ...inst.env,
        INCIDENTS: { send: vi.fn(async (inc: RawIncident) => { secondIncidents.push(inc); }) },
      };
      await instance.runAlarm();

      return { firstCount: firstIncidents.length, secondCount: secondIncidents.length };
    });

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(0);
  });
});
