import { describe, it, expect, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { RawIncident } from "@atlas/shared";
import type { AtlasCoordinator } from "../src/coordinator.js";

// Heartbeat self-monitor tests (D-10) + the single-instance invariant (Pillar 1).
//
// Runs against the REAL AtlasCoordinator DO inside workerd (per-test storage isolation is
// the vitest-pool-workers v4 default). We capture the DO's Flagger emission by spying the
// instance's own env.INCIDENTS.send from inside runInDurableObject(...) — the DO emits via the
// @atlas/shared flag() helper -> env.INCIDENTS.send (D2-05: flag() now enqueues a RawIncident
// onto atlas-incidents; Flagger is the sole consumer). Atlas is producer-only; it never reads
// atlas-wire. The TZ=UTC pool means the date inside any structured id is UTC-derived;
// we assert the canonical severity/kind/source_agent shape, not a calendar date.

const ATLAS = (env as unknown as { ATLAS: DurableObjectNamespace<AtlasCoordinator> }).ATLAS;

/** Replace the DO instance's INCIDENTS producer with a spy that collects raw incidents. */
function spyIncidents(instance: AtlasCoordinator): RawIncident[] {
  const incidents: RawIncident[] = [];
  // env is protected on DurableObject; reach it in-context for the spy (test-only).
  const inst = instance as unknown as { env: { INCIDENTS: { send: (e: RawIncident) => Promise<void> } } };
  inst.env = {
    ...inst.env,
    INCIDENTS: { send: vi.fn(async (inc: RawIncident) => { incidents.push(inc); }) },
  };
  return incidents;
}

describe("AtlasCoordinator heartbeat self-monitor — D-10", () => {
  it("healthy: a fresh beat() leaves alarm() with NO P1 emit", async () => {
    const stub = ATLAS.getByName("root");
    const incidents = await runInDurableObject(stub, async (instance, state) => {
      const collected = spyIncidents(instance);
      // A fresh beat: lastBeat = now, well inside the 5-min window.
      await state.storage.put("lastBeat", Date.now());
      await instance.alarm();
      return collected;
    });
    expect(incidents).toHaveLength(0);
  });

  it("stale (>5 min): alarm() emits exactly one P1 RawIncident and reschedules", async () => {
    const stub = ATLAS.getByName("root");
    const { incidents, alarmAfter } = await runInDurableObject(stub, async (instance, state) => {
      const collected = spyIncidents(instance);
      // Force lastBeat 6 minutes into the past — beyond the 5-min staleness window.
      await state.storage.put("lastBeat", Date.now() - 6 * 60_000);
      await instance.alarm();
      const next = await state.storage.getAlarm();
      return { incidents: collected, alarmAfter: next };
    });

    // Failure-path -> correct Flagger severity (D-10): exactly one RawIncident (D2-05).
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.severity_hint).toBe("P1");
    expect(incidents[0]!.kind).toBe("heartbeat_stale");
    expect(incidents[0]!.source_agent).toBe("Atlas");

    // alarm() ALWAYS reschedules — the heartbeat never stops (T-00-37).
    expect(alarmAfter).not.toBeNull();
  });

  it("C6 cold-start: a fresh DO's first alarm emits NO P1 (missing beat is not stale)", async () => {
    // A distinct DO name => a genuinely COLD instance (storage is per-name; tests in this file
    // share the "root" instance, so use an isolated name to model a true fresh/cold start).
    const stub = ATLAS.getByName("c6-cold");
    const { incidents, alarmAfter } = await runInDurableObject(stub, async (instance, state) => {
      const collected = spyIncidents(instance);
      // Fresh/cold DO: NO lastBeat has ever been written. The first alarm must treat a
      // missing beat as "just started, not stale" — NOT epoch 0 (infinitely stale).
      expect(await state.storage.get<number>("lastBeat")).toBeUndefined();
      await instance.alarm();
      const next = await state.storage.getAlarm();
      return { incidents: collected, alarmAfter: next };
    });
    // No spurious P1 on the very first alarm of a fresh DO.
    expect(incidents).toHaveLength(0);
    // ...and the heartbeat still (re)armed for the next tick.
    expect(alarmAfter).not.toBeNull();
  });

  it("C6 arm seeds lastBeat: startHeartbeat() on a fresh DO leaves it not-stale", async () => {
    const stub = ATLAS.getByName("c6-arm"); // isolated cold instance (see note above)
    const { lastBeat, alarm, incidents } = await runInDurableObject(stub, async (instance, state) => {
      const collected = spyIncidents(instance);
      await instance.startHeartbeat(); // seeds lastBeat + arms the alarm
      const seeded = await state.storage.get<number>("lastBeat");
      const armed = await state.storage.getAlarm();
      // The seeded beat is fresh, so an immediate alarm() must NOT flag.
      await instance.alarm();
      return { lastBeat: seeded, alarm: armed, incidents: collected };
    });
    expect(lastBeat).toBeTypeOf("number");
    expect(alarm).not.toBeNull();
    expect(incidents).toHaveLength(0);
  });

  it("C7 survives a flag failure: a throwing INCIDENTS.send still leaves the next alarm scheduled", async () => {
    const stub = ATLAS.getByName("root");
    const alarmAfter = await runInDurableObject(stub, async (instance, state) => {
      // Make the Flagger emit THROW: flag() -> env.INCIDENTS.send rejects (D2-05).
      const inst = instance as unknown as { env: { INCIDENTS: { send: (e: unknown) => Promise<void> } } };
      inst.env = {
        ...inst.env,
        INCIDENTS: { send: vi.fn(async () => { throw new Error("incidents down"); }) },
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
