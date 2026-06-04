import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { WireEvent } from "@atlas/wire";
import type { StewardWriter } from "../src/steward.js";

// SPINE-02 — the single-writer / serialization invariant (Pillar 1).
//
// (1) Two env.STEWARD_LOCK.getByName("vault") handles resolve to the SAME DO
//     instance (one name = one instance = the single Vault write lock — never a
//     split writer, RESEARCH Pitfall 4). Proven by a write-then-read across handles.
// (2) 50 distinct-key increment events applied CONCURRENTLY against the same counter
//     must leave it exactly summed — no lost updates, no double counts. The DO's
//     this.ctx.blockConcurrencyWhile serializes the racing apply() calls.

const STEWARD_LOCK = (
  env as unknown as { STEWARD_LOCK: DurableObjectNamespace<StewardWriter> }
).STEWARD_LOCK;

describe("serialize — single writer + blockConcurrencyWhile", () => {
  it("two getByName('vault') address the SAME DO instance", async () => {
    const a = STEWARD_LOCK.getByName("vault");
    await a.apply({
      agent: "Forge",
      type: "marker.set",
      entity: "marker",
      op: "increment",
      payload: { counter: "marker", delta: 7 },
      idempotencyKey: "marker:set:once",
    });
    // A second handle resolved by the same name must see the first handle's write.
    const b = STEWARD_LOCK.getByName("vault");
    expect((await b.counter("marker")).value).toBe(7);
  });

  it("50 concurrent distinct applies sum exactly (no race, no double-count)", async () => {
    const steward = STEWARD_LOCK.getByName("vault");
    const N = 50;
    const events: WireEvent[] = Array.from({ length: N }, (_, i) => ({
      agent: "Forge",
      type: "task.created",
      entity: "tasks",
      op: "increment",
      payload: { counter: "tasks_open", delta: 1 },
      idempotencyKey: `forge:task:concurrent:${i}`,
    }));

    // Fire them all at once — they race the DO, but blockConcurrencyWhile serializes.
    const results = await Promise.all(events.map((e) => steward.apply(e)));

    // Every distinct-key apply applied exactly once.
    expect(results.every((r) => r.applied)).toBe(true);
    // The counter equals the summed deltas — no lost updates.
    expect((await steward.counter("tasks_open")).value).toBe(N);
  });
});
