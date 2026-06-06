/**
 * recurrence.test.ts — M6/M7 gap-closure tests for Flagger (Phase 2, gap-pass 2).
 *
 * M6: a recurring heartbeat_stale's trust is NON-DECREASING across repeats (stays ~100, not 55).
 *     The recurrence re-score must use existing.kind (not "unknown").
 * M7: the 2nd occurrence emits a DISTINCT wire idempotencyKey from the 1st (so Steward
 *     renders the update) while the flag.id/entity is unchanged.
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/index.js";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import flaggerDefault from "../src/index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeBatch(body: unknown, opts: { id?: string } = {}) {
  const ack = vi.fn();
  const retry = vi.fn();
  const msg = {
    id: opts.id ?? "rec-msg-1",
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

function makeTestEnv(): Env & { _wireEvents: WireEvent[] } {
  const wireEvents: WireEvent[] = [];
  const wireSend = vi.fn(async (event: WireEvent) => {
    wireEvents.push(event);
  });
  const incidentsSend = vi.fn(async () => {});

  const e: Env = {
    ...(env as unknown as Env),
    WIRE: { send: wireSend } as unknown as Queue<WireEvent>,
    INCIDENTS: { send: incidentsSend } as unknown as Queue<RawIncident>,
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

// Unique heartbeat_stale incident (same kind, deterministic signature).
const heartbeatStaleIncident: RawIncident = {
  source_agent: "Forge",
  kind: "heartbeat_stale",
  severity_hint: "P1",
  title: "Forge heartbeat stale — no 15 8 * * * run detected",
};

// ── M6 tests ─────────────────────────────────────────────────────────────────

describe("M6 — recurrence re-scoring uses stored kind (trust NON-DECREASING for heartbeat_stale)", () => {
  it("recurring heartbeat_stale: trust stays >= 100 (not drops to 55 from kind:unknown)", async () => {
    const e = makeTestEnv();
    const wireEvents = e._wireEvents;

    // First occurrence
    const { batch: b1 } = fakeBatch(heartbeatStaleIncident, { id: "m6-1" });
    await flaggerDefault.queue(b1 as unknown as MessageBatch<RawIncident>, e);

    const firstFlagEvent = wireEvents.find((ev) => ev.entity === "flag" && ev.op === "upsert");
    expect(firstFlagEvent).toBeDefined();
    const firstTrust = (firstFlagEvent?.payload as { trust?: number })?.trust ?? 0;
    expect(firstTrust).toBeGreaterThanOrEqual(100); // heartbeat_stale baseTrust=100

    wireEvents.length = 0; // clear

    // Second occurrence (same incident, same signature → recurrence bump)
    const { batch: b2 } = fakeBatch(heartbeatStaleIncident, { id: "m6-2" });
    await flaggerDefault.queue(b2 as unknown as MessageBatch<RawIncident>, e);

    const secondFlagEvent = wireEvents.find((ev) => ev.entity === "flag" && ev.op === "upsert");
    expect(secondFlagEvent).toBeDefined();
    const secondTrust = (secondFlagEvent?.payload as { trust?: number })?.trust ?? 0;

    // M6 key assertion: trust must NOT drop below firstTrust (55 < 100 would be the bug)
    expect(secondTrust).toBeGreaterThanOrEqual(firstTrust);
  });
});

// ── M7 tests ─────────────────────────────────────────────────────────────────

describe("M7 — recurrence bumps idempotencyKey so Steward renders the update", () => {
  it("second occurrence has DISTINCT idempotencyKey from first (format: <id>:r<n>)", async () => {
    const e = makeTestEnv();
    const wireEvents = e._wireEvents;

    const inc: RawIncident = {
      source_agent: "Herald",
      kind: "chain_halted",
      severity_hint: "P1",
      title: "Herald chain halted at step 2",
    };

    // First occurrence
    const { batch: b1 } = fakeBatch(inc, { id: "m7-1" });
    await flaggerDefault.queue(b1 as unknown as MessageBatch<RawIncident>, e);

    const firstEv = wireEvents.find((ev) => ev.entity === "flag" && ev.op === "upsert");
    expect(firstEv).toBeDefined();
    const firstKey = firstEv?.idempotencyKey ?? "";
    const firstFlagId = (firstEv?.payload as { id?: string })?.id ?? "";

    wireEvents.length = 0;

    // Second occurrence (same incident)
    const { batch: b2 } = fakeBatch(inc, { id: "m7-2" });
    await flaggerDefault.queue(b2 as unknown as MessageBatch<RawIncident>, e);

    const secondEv = wireEvents.find((ev) => ev.entity === "flag" && ev.op === "upsert");
    expect(secondEv).toBeDefined();
    const secondKey = secondEv?.idempotencyKey ?? "";
    const secondFlagId = (secondEv?.payload as { id?: string })?.id ?? "";

    // M7 key assertions:
    // 1. idempotencyKey must be DIFFERENT between occurrences (so Steward doesn't dedup)
    expect(secondKey).not.toBe(firstKey);
    // 2. flag.id (the board row entity) must be the SAME (overwrites same Vault row)
    expect(secondFlagId).toBe(firstFlagId);
    // 3. The second key must encode recurrence (format: <id>:r<n>)
    expect(secondKey).toMatch(/:r\d+$/);
  });

  it("idempotencyKey for recurrence 0 (first) is the flag.id itself", async () => {
    const e = makeTestEnv();
    const wireEvents = e._wireEvents;

    const inc: RawIncident = {
      source_agent: "Sundial",
      kind: "calendar_sync_failed",
      severity_hint: "P3",
      title: "Sundial calendar sync failed on 2026-06-05",
    };

    const { batch } = fakeBatch(inc, { id: "m7-base-1" });
    await flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e);

    const flagEv = wireEvents.find((ev) => ev.entity === "flag" && ev.op === "upsert");
    expect(flagEv).toBeDefined();
    const key = flagEv?.idempotencyKey ?? "";
    const flagId = (flagEv?.payload as { id?: string })?.id ?? "";

    // First occurrence: key = flagId:r0 (or just flagId — either is acceptable;
    // the important invariant is the SECOND occurrence differs)
    // Per locked decision: idempotencyKey = `${flag.id}:r${flag.recurrence}`
    expect(key).toBe(`${flagId}:r0`);
  });
});
