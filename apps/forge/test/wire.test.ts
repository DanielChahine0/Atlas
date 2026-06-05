import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import { applyEvent } from "@atlas/steward-core";
import { buildTaskEvent, taskIdFor } from "../src/index.js";

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
});
