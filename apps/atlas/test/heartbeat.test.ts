import { describe, it, expect, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import type { AtlasCoordinator } from "../src/coordinator.js";

// Heartbeat self-monitor tests (D-10) + the single-instance invariant (Pillar 1).
//
// Runs against the REAL AtlasCoordinator DO inside workerd (per-test storage isolation is
// the vitest-pool-workers v4 default). We capture the DO's Flagger emission by spying the
// instance's own env.WIRE.send from inside runInDurableObject(...) — the DO emits via the
// @atlas/shared flag() helper -> @atlas/wire send() -> env.WIRE.send (Atlas is producer-only;
// it never reads atlas-wire). The TZ=UTC pool means the date inside the flag id is UTC-derived;
// we assert the canonical op/entity/severity shape, not a calendar date.

const ATLAS = (env as unknown as { ATLAS: DurableObjectNamespace<AtlasCoordinator> }).ATLAS;

/** Replace the DO instance's WIRE producer with a spy that collects emitted events. */
function spyWire(instance: AtlasCoordinator): unknown[] {
  const events: unknown[] = [];
  // env is protected on DurableObject; reach it in-context for the spy (test-only).
  const inst = instance as unknown as { env: { WIRE: { send: (e: unknown) => Promise<void> } } };
  inst.env = {
    ...inst.env,
    WIRE: { send: vi.fn(async (e: unknown) => { events.push(e); }) },
  };
  return events;
}

describe("AtlasCoordinator heartbeat self-monitor — D-10", () => {
  it("healthy: a fresh beat() leaves alarm() with NO P1 emit", async () => {
    const stub = ATLAS.getByName("root");
    const events = await runInDurableObject(stub, async (instance, state) => {
      const collected = spyWire(instance);
      // A fresh beat: lastBeat = now, well inside the 5-min window.
      await state.storage.put("lastBeat", Date.now());
      await instance.alarm();
      return collected;
    });
    expect(events).toHaveLength(0);
  });

  it("stale (>5 min): alarm() emits exactly one P1 Flagger event and reschedules", async () => {
    const stub = ATLAS.getByName("root");
    const { events, alarmAfter } = await runInDurableObject(stub, async (instance, state) => {
      const collected = spyWire(instance);
      // Force lastBeat 6 minutes into the past — beyond the 5-min staleness window.
      await state.storage.put("lastBeat", Date.now() - 6 * 60_000);
      await instance.alarm();
      const next = await state.storage.getAlarm();
      return { events: collected, alarmAfter: next };
    });

    // Failure-path -> correct Flagger severity (D-10): exactly one canonical flag event.
    expect(events).toHaveLength(1);
    const parsed = WireEvent.parse(events[0]);
    expect(parsed.op).toBe("upsert"); // a flag is a stable row, mutated in place
    expect(parsed.entity).toBe("flag");
    expect(parsed.type).toBe("flag");
    expect((parsed.payload as { severity?: string }).severity).toBe("P1");
    // The structured flag id is the idempotencyKey (replay re-upserts one row).
    expect(parsed.idempotencyKey).toBe((parsed.payload as { id?: string }).id);

    // alarm() ALWAYS reschedules — the heartbeat never stops (T-00-37).
    expect(alarmAfter).not.toBeNull();
  });

  it("C6 cold-start: a fresh DO's first alarm emits NO P1 (missing beat is not stale)", async () => {
    // A distinct DO name => a genuinely COLD instance (storage is per-name; tests in this file
    // share the "root" instance, so use an isolated name to model a true fresh/cold start).
    const stub = ATLAS.getByName("c6-cold");
    const { events, alarmAfter } = await runInDurableObject(stub, async (instance, state) => {
      const collected = spyWire(instance);
      // Fresh/cold DO: NO lastBeat has ever been written. The first alarm must treat a
      // missing beat as "just started, not stale" — NOT epoch 0 (infinitely stale).
      expect(await state.storage.get<number>("lastBeat")).toBeUndefined();
      await instance.alarm();
      const next = await state.storage.getAlarm();
      return { events: collected, alarmAfter: next };
    });
    // No spurious P1 on the very first alarm of a fresh DO.
    expect(events).toHaveLength(0);
    // ...and the heartbeat still (re)armed for the next tick.
    expect(alarmAfter).not.toBeNull();
  });

  it("C6 arm seeds lastBeat: startHeartbeat() on a fresh DO leaves it not-stale", async () => {
    const stub = ATLAS.getByName("c6-arm"); // isolated cold instance (see note above)
    const { lastBeat, alarm, events } = await runInDurableObject(stub, async (instance, state) => {
      const collected = spyWire(instance);
      await instance.startHeartbeat(); // seeds lastBeat + arms the alarm
      const seeded = await state.storage.get<number>("lastBeat");
      const armed = await state.storage.getAlarm();
      // The seeded beat is fresh, so an immediate alarm() must NOT flag.
      await instance.alarm();
      return { lastBeat: seeded, alarm: armed, events: collected };
    });
    expect(lastBeat).toBeTypeOf("number");
    expect(alarm).not.toBeNull();
    expect(events).toHaveLength(0);
  });

  it("C7 survives a flag failure: a throwing WIRE.send still leaves the next alarm scheduled", async () => {
    const stub = ATLAS.getByName("root");
    const alarmAfter = await runInDurableObject(stub, async (instance, state) => {
      // Make the Flagger emit THROW: flag() -> @atlas/wire send() -> env.WIRE.send rejects.
      const inst = instance as unknown as { env: { WIRE: { send: (e: unknown) => Promise<void> } } };
      inst.env = {
        ...inst.env,
        WIRE: { send: vi.fn(async () => { throw new Error("wire down"); }) },
      };
      // Force a STALE beat so alarm() takes the flag() branch (which now throws).
      await state.storage.put("lastBeat", Date.now() - 6 * 60_000);
      // alarm() must NOT reject even though flag() throws — and must still reschedule.
      await expect(instance.alarm()).resolves.toBeUndefined();
      return state.storage.getAlarm();
    });
    // C7: the heartbeat survives a flag failure — the next alarm is still armed.
    expect(alarmAfter).not.toBeNull();
  });

  it("single instance (Pillar 1): two getByName('root') handles address the SAME DO", async () => {
    // Write a marker via one handle...
    const a = ATLAS.getByName("root");
    await runInDurableObject(a, async (_instance, state) => {
      await state.storage.put("marker", 12345);
    });
    // ...and read it back via a SECOND handle resolved by the same name.
    const b = ATLAS.getByName("root");
    const seen = await runInDurableObject(b, async (_instance, state) => {
      return state.storage.get<number>("marker");
    });
    expect(seen).toBe(12345);
  });
});
