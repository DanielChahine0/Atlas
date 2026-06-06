/**
 * heartbeat.test.ts — Compass heartbeat emit test (WEEKLY-02, Plan 02-03 Task 2).
 *
 * Verifies that plan() emits a kind:"heartbeat" RawIncident to INCIDENTS at the
 * end of a successful run, with the correct shape:
 *   { source_agent: "Compass", kind: "heartbeat", severity_hint: "P4",
 *     title: "Compass heartbeat <date>", run_id: date }
 *
 * Also verifies that the run succeeds (no throw) when INCIDENTS binding is absent.
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { Compass } from "../src/index.js";
import type { Env } from "../src/index.js";
import type { BusyInterval } from "../src/grid.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEnv(opts: { incidentsPresent?: boolean } = {}): {
  testEnv: Env;
  incidents: RawIncident[];
  wireEvents: WireEvent[];
} {
  const incidents: RawIncident[] = [];
  const wireEvents: WireEvent[] = [];

  const wireSend = vi.fn(async (event: WireEvent) => {
    wireEvents.push(event);
  });

  const incidentsSend = vi.fn(async (incident: RawIncident) => {
    incidents.push(incident);
  });

  const testEnv: Env = {
    ...(env as unknown as Env),
    WIRE: { send: wireSend } as unknown as Queue<WireEvent>,
    INCIDENTS: opts.incidentsPresent === false
      ? (undefined as unknown as Queue<RawIncident>)
      : ({ send: incidentsSend } as unknown as Queue<RawIncident>),
    // CONFIG needed for resolveEffort (compass.effort key)
    CONFIG: { get: vi.fn(async () => null) } as unknown as KVNamespace,
  };

  return { testEnv, incidents, wireEvents };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Compass heartbeat", () => {
  it("emits kind:heartbeat incident to INCIDENTS after a successful plan() run", async () => {
    const { testEnv, incidents } = makeEnv();
    const compass = new Compass({} as ExecutionContext, testEnv);
    // Inject empty tasks + events (no model needed for zero-task plan)
    const emptyCalendar: BusyInterval[] = [];
    await compass.plan({ date: "2026-06-05", tasks: [], calendar: emptyCalendar });

    const hb = incidents.find((i) => i.kind === "heartbeat");
    expect(hb).toBeDefined();
    expect(hb!.source_agent).toBe("Compass");
    expect(hb!.severity_hint).toBe("P4");
    expect(hb!.title).toContain("Compass");
    expect(hb!.title).toContain("2026-06-05");
    expect(hb!.run_id).toBe("2026-06-05");
  });

  it("emits exactly ONE heartbeat per successful plan() run", async () => {
    const { testEnv, incidents } = makeEnv();
    const compass = new Compass({} as ExecutionContext, testEnv);
    await compass.plan({ date: "2026-06-05", tasks: [], calendar: [] });

    const heartbeats = incidents.filter((i) => i.kind === "heartbeat");
    expect(heartbeats).toHaveLength(1);
  });

  it("run still succeeds when INCIDENTS binding is absent (optional-chaining)", async () => {
    const { testEnv } = makeEnv({ incidentsPresent: false });
    const compass = new Compass({} as ExecutionContext, testEnv);
    // Should not throw even without INCIDENTS binding
    const result = await compass.plan({ date: "2026-06-05", tasks: [], calendar: [] });
    expect(result).toBeDefined();
    expect(typeof result.overcommitted).toBe("boolean");
  });

  it("M9: plan() still resolves when INCIDENTS.send rejects (best-effort heartbeat)", async () => {
    // Simulate a transient queue error on INCIDENTS.send AFTER the real work succeeds.
    // plan() must resolve normally — a heartbeat enqueue failure must never convert a
    // successful plan into a failure or halt the MorningChain (M9 regression test).
    const wireEvents: WireEvent[] = [];
    const rejectingSend = vi.fn(async (_incident: RawIncident) => {
      throw new Error("transient queue error");
    });
    const testEnv: Env = {
      ...(env as unknown as Env),
      WIRE: { send: vi.fn(async (event: WireEvent) => { wireEvents.push(event); }) } as unknown as Queue<WireEvent>,
      INCIDENTS: { send: rejectingSend } as unknown as Queue<RawIncident>,
      CONFIG: { get: vi.fn(async () => null) } as unknown as KVNamespace,
    };

    const compass = new Compass({} as ExecutionContext, testEnv);
    const emptyCalendar: BusyInterval[] = [];
    const result = await compass.plan({ date: "2026-06-05", tasks: [], calendar: emptyCalendar });
    // Must resolve normally even though INCIDENTS.send rejects
    expect(result).toBeDefined();
    expect(typeof result.overcommitted).toBe("boolean");
    // INCIDENTS.send was called (heartbeat was attempted, just rejected)
    expect(rejectingSend).toHaveBeenCalledOnce();
  });
});
