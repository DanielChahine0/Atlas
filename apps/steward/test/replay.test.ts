import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { WireEvent } from "@atlas/wire";
import type { StewardWriter } from "../src/steward.js";

// SPINE-02 / Pillar 5 — THE single test that proves replay-idempotency end-to-end.
//
// Applying the SAME idempotencyKey twice must leave the counter UNCHANGED: the first
// apply() returns {applied:true} and bumps the counter; the second is a REPLAY —
// the INSERT OR IGNORE into idempotency_keys reports meta.changes===0, so apply()
// returns {applied:false} and the conditional counter bump is skipped (the
// WHERE NOT EXISTS guard fails). The ledger has no TTL (D-08), so a replay at ANY
// age is a guaranteed no-op. Runs against the REAL StewardWriter DO in workerd.

const STEWARD_LOCK = (
  env as unknown as { STEWARD_LOCK: DurableObjectNamespace<StewardWriter> }
).STEWARD_LOCK;

describe("replay — SPINE-02 / Pillar 5 (meta.changes===0)", () => {
  it("replaying a Wire event does not double-count", async () => {
    const steward = STEWARD_LOCK.getByName("vault");
    const evt: WireEvent = {
      agent: "Forge",
      type: "task.created",
      entity: "tasks",
      op: "increment",
      payload: { counter: "tasks_open", delta: 1 },
      idempotencyKey: "forge:task:2026-05-31:abc",
    };

    expect(await steward.apply(evt)).toEqual({ applied: true });
    expect(await steward.apply(evt)).toEqual({ applied: false }); // replay → skipped

    const { value } = await steward.counter("tasks_open");
    expect(value).toBe(1); // NOT 2
  });

  it("a third+ replay (any age) stays a no-op — counter still 1", async () => {
    const steward = STEWARD_LOCK.getByName("vault");
    // Distinct counter name from the test above so the two are independent
    // regardless of cross-test storage reuse.
    const evt: WireEvent = {
      agent: "Forge",
      type: "task.created",
      entity: "tasks",
      op: "increment",
      payload: { counter: "tasks_replayed", delta: 1 },
      idempotencyKey: "forge:task:2026-05-31:once",
    };
    expect(await steward.apply(evt)).toEqual({ applied: true });
    expect(await steward.apply(evt)).toEqual({ applied: false });
    expect(await steward.apply(evt)).toEqual({ applied: false });
    expect((await steward.counter("tasks_replayed")).value).toBe(1);
  });
});
