/**
 * heartbeat.test.ts — Sundial heartbeat emit test (WEEKLY-02, Plan 02-03 Task 2).
 *
 * Verifies that sync() emits a kind:"heartbeat" RawIncident to INCIDENTS at the
 * end of a successful run, with the correct shape:
 *   { source_agent: "Sundial", kind: "heartbeat", severity_hint: "P4",
 *     title: "Sundial heartbeat <date>", run_id: date }
 *
 * Also verifies that the run succeeds (no throw) when INCIDENTS binding is absent.
 *
 * Note: Sundial.sync() with no tools → zero-summary path (still a successful run).
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { Sundial } from "../src/index.js";
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

describe("Sundial heartbeat", () => {
  it("emits kind:heartbeat incident to INCIDENTS after a successful sync() run", async () => {
    const { testEnv, incidents } = makeEnv();
    const sundial = new Sundial(testEnv, {} as DurableObjectState);
    // No tools → zero-summary path (still a successful run)
    await sundial.sync({ date: "2026-06-05" });

    const hb = incidents.find((i) => i.kind === "heartbeat");
    expect(hb).toBeDefined();
    expect(hb!.source_agent).toBe("Sundial");
    expect(hb!.severity_hint).toBe("P4");
    expect(hb!.title).toContain("Sundial");
    expect(hb!.title).toContain("2026-06-05");
    expect(hb!.run_id).toBe("2026-06-05");
  });

  it("emits exactly ONE heartbeat per successful sync() run", async () => {
    const { testEnv, incidents } = makeEnv();
    const sundial = new Sundial(testEnv, {} as DurableObjectState);
    await sundial.sync({ date: "2026-06-05" });

    const heartbeats = incidents.filter((i) => i.kind === "heartbeat");
    expect(heartbeats).toHaveLength(1);
  });

  it("run still succeeds when INCIDENTS binding is absent (optional-chaining)", async () => {
    const { testEnv } = makeEnv({ incidentsPresent: false });
    const sundial = new Sundial(testEnv, {} as DurableObjectState);
    // Should not throw even without INCIDENTS binding
    const result = await sundial.sync({ date: "2026-06-05" });
    expect(result).toBeDefined();
    expect(typeof result.created).toBe("number");
  });
});
