/**
 * heartbeat.test.ts — Forge heartbeat emit test (WEEKLY-02, Plan 02-03 Task 2).
 *
 * Verifies that morning() emits a kind:"heartbeat" RawIncident to INCIDENTS at the
 * end of a successful run, with the correct shape:
 *   { source_agent: "Forge", kind: "heartbeat", severity_hint: "P4",
 *     title: "Forge heartbeat <date>", run_id: date }
 *
 * Also verifies that the run succeeds (no throw) when INCIDENTS binding is absent.
 *
 * Note: Forge.morning() with no extractor/candidates returns early (empty result).
 * Heartbeat is emitted on a successful run — even an empty run (no candidates).
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { Forge } from "../src/index.js";
import type { Env } from "../src/index.js";

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

  // Spread the real workerd env (which has DB etc.) and override WIRE+INCIDENTS
  const testEnv: Env = {
    ...(env as unknown as Env),
    WIRE: { send: wireSend } as unknown as Queue<WireEvent>,
    INCIDENTS: opts.incidentsPresent === false
      ? (undefined as unknown as Queue<RawIncident>)
      : ({ send: incidentsSend } as unknown as Queue<RawIncident>),
  };

  return { testEnv, incidents, wireEvents };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Forge heartbeat", () => {
  it("emits kind:heartbeat incident to INCIDENTS after a successful morning() run", async () => {
    const { testEnv, incidents } = makeEnv();
    const forge = new Forge({} as ExecutionContext, testEnv);
    // No extractor/candidates → early-return empty result (still a successful run)
    await forge.morning({ date: "2026-06-05" });

    const hb = incidents.find((i) => i.kind === "heartbeat");
    expect(hb).toBeDefined();
    expect(hb!.source_agent).toBe("Forge");
    expect(hb!.severity_hint).toBe("P4");
    expect(hb!.title).toContain("Forge");
    expect(hb!.title).toContain("2026-06-05");
    expect(hb!.run_id).toBe("2026-06-05");
  });

  it("emits exactly ONE heartbeat per successful morning() run", async () => {
    const { testEnv, incidents } = makeEnv();
    const forge = new Forge({} as ExecutionContext, testEnv);
    await forge.morning({ date: "2026-06-05" });

    const heartbeats = incidents.filter((i) => i.kind === "heartbeat");
    expect(heartbeats).toHaveLength(1);
  });

  it("run still succeeds when INCIDENTS binding is absent (optional-chaining)", async () => {
    const { testEnv } = makeEnv({ incidentsPresent: false });
    const forge = new Forge({} as ExecutionContext, testEnv);
    // Should not throw even without INCIDENTS binding
    const result = await forge.morning({ date: "2026-06-05" });
    expect(result).toBeDefined();
    expect(typeof result.inserted).toBe("number");
  });

  it("M9: run still succeeds when INCIDENTS.send rejects (best-effort heartbeat)", async () => {
    // Simulate a transient queue error on INCIDENTS.send AFTER the real work succeeds.
    // morning() must resolve normally — a heartbeat enqueue failure must never convert a
    // successful morning run into a failure or halt the MorningChain (M9 regression test).
    const rejectingSend = vi.fn(async () => {
      throw new Error("transient queue error");
    });
    const testEnv: Env = {
      ...(env as unknown as Env),
      WIRE: { send: vi.fn(async () => {}) } as unknown as Queue<WireEvent>,
      INCIDENTS: { send: rejectingSend } as unknown as Queue<import("@atlas/shared").RawIncident>,
    };

    const forge = new Forge({} as ExecutionContext, testEnv);
    // No extractor/candidates → early-return empty result (still a successful run)
    const result = await forge.morning({ date: "2026-06-05" });
    // Must resolve normally even though INCIDENTS.send rejects
    expect(result).toBeDefined();
    expect(typeof result.inserted).toBe("number");
    // INCIDENTS.send was called (heartbeat was attempted, just rejected)
    expect(rejectingSend).toHaveBeenCalledOnce();
  });
});
