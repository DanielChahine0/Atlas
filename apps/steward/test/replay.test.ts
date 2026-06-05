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

  // CLAUDE.md Definition-of-Done replay test for the op:"upsert"/entity:"flag" shape that
  // Flagger (02-02) emits and the funnel upserts (02-05) ride. An upsert is a stable-row,
  // last-writer-wins view (NOT a counter), so its replay-safety lives entirely in the ledger:
  // the FIRST apply inserts the idempotency key (applied:true); the SECOND apply finds the key
  // already present, so the ledger INSERT OR IGNORE reports meta.changes===0 and apply()
  // returns {applied:false} — the vault_outbox INSERT OR IGNORE (PK idem) writes nothing new
  // either. A replayed flag-upsert is therefore a complete no-op at every table (Pillar 5).
  it("replaying an op:upsert/entity:flag event is a no-op (applied:false, no double-write)", async () => {
    const steward = STEWARD_LOCK.getByName("vault");
    const flagEvt: WireEvent = {
      agent: "Flagger",
      type: "flag.upserted",
      entity: "flag",
      op: "upsert",
      // The canonical flag-upsert payload: a stable row keyed by the flag id. note/field route
      // the op-mapping upsert to /vault/Flags/<id>.md (last-writer-wins).
      payload: { note: "Flags/flg-2026-05-31-abc", field: "status", id: "flg-2026-05-31-abc", status: "open" },
      // The structured flag idempotency key shape: flg:<date>:<agent>:<hash>.
      idempotencyKey: "flg:2026-05-31:Sundial:abc",
    };

    // First apply lands the row; the replay is a guaranteed no-op (key already in the ledger).
    expect(await steward.apply(flagEvt)).toEqual({ applied: true });
    expect(await steward.apply(flagEvt)).toEqual({ applied: false }); // replay → skipped
    // A third replay (any age) is STILL a no-op — the ledger has no TTL (D-08).
    expect(await steward.apply(flagEvt)).toEqual({ applied: false });
  });
});
