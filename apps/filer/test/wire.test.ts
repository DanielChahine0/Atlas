import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import { applyEvent } from "@atlas/steward-core";
import { buildSweepEvent } from "../src/index.js";

// DoD test 2 — Wire-contract + replay-through-Steward.
//   (a) the emitted event matches the exact §6.4 shape + structured idempotencyKey;
//   (b) applying it twice via @atlas/steward-core (the StewardWriter critical section)
//       leaves the counter unchanged on the second apply (meta.changes===0 → applied:false).

const db = (env as unknown as { DB: D1Database }).DB;

describe("Filer Wire-contract", () => {
  it("emits the exact §6.4 sweep.done event with a structured key", () => {
    const evt = buildSweepEvent("2026-06-05", { labeled: 3, uncertain: 1, phishing: 0 });
    expect(evt.agent).toBe("Filer");
    expect(evt.type).toBe("sweep.done");
    expect(evt.entity).toBe("email");
    expect(evt.op).toBe("increment");
    expect(evt.idempotencyKey).toBe("filer:sweep:2026-06-05");
    expect(evt.payload.labeled).toBe(3);
    // Parses against the single canonical WireEvent schema.
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });

  it("a replay through Steward leaves the counter unchanged (meta.changes===0)", async () => {
    const evt = buildSweepEvent("2026-06-05", { labeled: 5, uncertain: 0, phishing: 0 });
    expect(await applyEvent(db, evt)).toEqual({ applied: true });
    expect(await applyEvent(db, evt)).toEqual({ applied: false }); // replay → no-op

    const row = await db
      .prepare("SELECT value FROM counters WHERE entity = ?")
      .bind("emails_labeled")
      .first<{ value: number }>();
    expect(row?.value).toBe(5); // bumped once by delta=5, NOT 10
  });
});
