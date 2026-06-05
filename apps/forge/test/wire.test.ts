import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import { applyEvent } from "@atlas/steward-core";
import { buildTaskEvent, taskIdFor, contentHashOf } from "../src/index.js";

// DoD test 2 — Wire-contract + replay-through-Steward. One event per task keyed on the task
// id; insert→increment, merge→upsert; a replay leaves the counter unchanged.

const db = (env as unknown as { DB: D1Database }).DB;

describe("Forge Wire-contract", () => {
  it("emits an increment event on insert, keyed on the task id", () => {
    const id = taskIdFor("abc123def456");
    const evt = buildTaskEvent(id, "inserted");
    expect(evt.agent).toBe("Forge");
    expect(evt.type).toBe("task");
    expect(evt.entity).toBe(id);
    expect(evt.op).toBe("increment");
    expect(evt.idempotencyKey).toBe(id); // the task id IS the idempotency anchor
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });

  it("emits an upsert event on merge (delta 0)", () => {
    const id = taskIdFor("zzz999");
    const evt = buildTaskEvent(id, "merged");
    expect(evt.op).toBe("upsert");
    expect(evt.payload.delta).toBe(0);
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });

  it("a replay through Steward leaves the counter unchanged (meta.changes===0)", async () => {
    const id = taskIdFor("replay-task-key");
    const evt = buildTaskEvent(id, "inserted");
    expect(await applyEvent(db, evt)).toEqual({ applied: true });
    expect(await applyEvent(db, evt)).toEqual({ applied: false }); // replay no-op

    const row = await db
      .prepare("SELECT value FROM counters WHERE entity = ?")
      .bind("tasks_open")
      .first<{ value: number }>();
    expect(row?.value).toBe(1); // NOT 2
  });

  it("a merge carries change identity in its key — a priority bump emits a NEW (distinct-key) upsert Steward applies (NEW-F3)", async () => {
    // Before the fix, the merge event reused idempotencyKey === taskId (same as the insert),
    // so Steward — which dedups PERMANENTLY on idempotencyKey — dropped every merge: a real
    // priority bump / earlier due never reached the Vault projection (Pillar 4 D1↔Vault
    // divergence). The merge key must encode the merged (priority, due) state so a TRUE replay
    // (same state) still dedups, but a real change yields a DISTINCT, applied ledger entry.
    const id = taskIdFor("merge-change-identity-key");

    // Read the counter BEFORE so we assert the DELTA (immune to test-ordering / storage).
    const before =
      (
        await db
          .prepare("SELECT value FROM counters WHERE entity = ?")
          .bind("tasks_open")
          .first<{ value: number }>()
      )?.value ?? 0;

    // 1) Insert (op:increment, keyed on the task id) — applies, distinct from any merge key.
    const insert = buildTaskEvent(id, "inserted");
    expect(insert.idempotencyKey).toBe(id);
    expect(await applyEvent(db, insert)).toEqual({ applied: true });

    // 2) A merge at priority P2 — its key carries the merged state, so it is DISTINCT from the
    //    insert key (taskId) and Steward APPLIES it (the insert no longer shadows the merge).
    const keyP2 = await contentHashOf("P2", "2026-06-10T23:59:00-04:00");
    const mergeP2 = buildTaskEvent(id, "merged", keyP2);
    expect(mergeP2.op).toBe("upsert");
    expect(mergeP2.idempotencyKey).toBe(`task:${id}:${keyP2}`);
    expect(mergeP2.idempotencyKey).not.toBe(insert.idempotencyKey); // not shadowed by the insert
    expect(await applyEvent(db, mergeP2)).toEqual({ applied: true });

    // 3) A genuine PRIORITY BUMP (P2 → P1) — a different merged state → a DIFFERENT key →
    //    Steward APPLIES it (the bug would have deduped it against the prior merge).
    const keyP1 = await contentHashOf("P1", "2026-06-10T23:59:00-04:00");
    const mergeP1 = buildTaskEvent(id, "merged", keyP1);
    expect(mergeP1.idempotencyKey).not.toBe(mergeP2.idempotencyKey);
    expect(await applyEvent(db, mergeP1)).toEqual({ applied: true }); // NOT deduped

    // 4) A TRUE replay of the same bumped state (same key) is a no-op (counter neutral).
    expect(await applyEvent(db, mergeP1)).toEqual({ applied: false });

    // The merges are op:upsert with delta 0, so the counter moved by EXACTLY +1 (the insert);
    // neither merge nor the replay bumped it.
    const after =
      (
        await db
          .prepare("SELECT value FROM counters WHERE entity = ?")
          .bind("tasks_open")
          .first<{ value: number }>()
      )?.value ?? 0;
    expect(after - before).toBe(1); // one insert (+1); both merges contribute delta 0

    // Three distinct ledger entries exist for this task (insert + two real merges), and the
    // replay added none — proving change identity, not permanent dedup-on-taskId.
    const ledger = await db
      .prepare("SELECT COUNT(*) AS c FROM idempotency_keys WHERE entity = ?")
      .bind(id)
      .first<{ c: number }>();
    expect(ledger?.c).toBe(3);
  });
});
