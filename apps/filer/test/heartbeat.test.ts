/**
 * heartbeat.test.ts — Filer heartbeat emit test (WEEKLY-02, Plan 02-03 Task 2).
 *
 * Verifies that sweep() emits a kind:"heartbeat" RawIncident to INCIDENTS at the
 * end of a successful run, with the correct shape:
 *   { source_agent: "Filer", kind: "heartbeat", severity_hint: "P4",
 *     title: "Filer heartbeat <date>", run_id: date }
 *
 * Also verifies that the run succeeds (no throw) when INCIDENTS binding is absent
 * (optional-chaining: env.INCIDENTS?.send).
 */

import { describe, it, expect, vi } from "vitest";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { Filer } from "../src/index.js";
import type { GmailTools, SweepSummary, Env } from "../src/index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal working GmailTools stub for a successful sweep. */
function makeTools(): GmailTools {
  return {
    listLabels: vi.fn(async () => []),
    createLabel: vi.fn(async () => {}),
    searchThreads: vi.fn(async () => []),
    labelThread: vi.fn(async () => {}),
  };
}

function makeEnv(opts: { incidentsPresent?: boolean } = {}): {
  env: Env;
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

  const e = {
    WIRE: { send: wireSend } as unknown as Queue<WireEvent>,
    INCIDENTS: opts.incidentsPresent === false
      ? (undefined as unknown as Queue<RawIncident>)
      : ({ send: incidentsSend } as unknown as Queue<RawIncident>),
    CONFIG: { get: vi.fn(async () => null) } as unknown as KVNamespace,
  } as unknown as Env;

  return { env: e, incidents, wireEvents };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Filer heartbeat", () => {
  it("emits kind:heartbeat incident to INCIDENTS after a successful sweep", async () => {
    const { env, incidents } = makeEnv();
    const filer = new Filer({} as ExecutionContext, env as unknown as Env);
    await filer.sweep({ date: "2026-06-05", tools: makeTools() });

    const hb = incidents.find((i) => i.kind === "heartbeat");
    expect(hb).toBeDefined();
    expect(hb!.source_agent).toBe("Filer");
    expect(hb!.severity_hint).toBe("P4");
    expect(hb!.title).toContain("Filer");
    expect(hb!.title).toContain("2026-06-05");
    expect(hb!.run_id).toBe("2026-06-05");
  });

  it("emits exactly ONE heartbeat per successful sweep", async () => {
    const { env, incidents } = makeEnv();
    const filer = new Filer({} as ExecutionContext, env as unknown as Env);
    await filer.sweep({ date: "2026-06-05", tools: makeTools() });

    const heartbeats = incidents.filter((i) => i.kind === "heartbeat");
    expect(heartbeats).toHaveLength(1);
  });

  it("run still succeeds when INCIDENTS binding is absent (optional-chaining)", async () => {
    const { env } = makeEnv({ incidentsPresent: false });
    const filer = new Filer({} as ExecutionContext, env as unknown as Env);
    // Should not throw even without INCIDENTS binding
    const result = await filer.sweep({ date: "2026-06-05", tools: makeTools() });
    expect(result).toBeDefined();
    expect(typeof result.labeled).toBe("number");
  });

  it("M9: run still succeeds when INCIDENTS.send rejects (best-effort heartbeat)", async () => {
    // Simulate a transient queue error on INCIDENTS.send AFTER the real work succeeds.
    // sweep() must resolve normally — a heartbeat enqueue failure must never convert a
    // successful sweep into a failure or halt the MorningChain (M9 regression test).
    const wireEvents: WireEvent[] = [];
    const rejectingSend = vi.fn(async (_incident: RawIncident) => {
      throw new Error("transient queue error");
    });
    const e = {
      WIRE: { send: vi.fn(async (event: WireEvent) => { wireEvents.push(event); }) } as unknown as Queue<WireEvent>,
      INCIDENTS: { send: rejectingSend } as unknown as Queue<RawIncident>,
      CONFIG: { get: vi.fn(async () => null) } as unknown as KVNamespace,
    } as unknown as Env;

    const filer = new Filer({} as ExecutionContext, e);
    // Must not throw even though INCIDENTS.send rejects
    const result = await filer.sweep({ date: "2026-06-05", tools: makeTools() });
    expect(result).toBeDefined();
    expect(typeof result.labeled).toBe("number");
    // The Wire event for sweep.done must still have been emitted before the heartbeat
    expect(wireEvents.some((ev) => ev.idempotencyKey === "filer:sweep:2026-06-05")).toBe(true);
    // INCIDENTS.send was called (heartbeat was attempted, just rejected)
    expect(rejectingSend).toHaveBeenCalledOnce();
  });
});
