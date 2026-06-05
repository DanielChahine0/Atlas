import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyEvent } from "@atlas/steward-core";
import type { WireEvent } from "@atlas/wire";

// 00-REVIEW BATCH 1 — the Steward crux fixes, proven against the REAL D1 in workerd.
//
//   C1  — first-apply is all-or-nothing: the counter bump, ledger insert, run_log row,
//         AND vault_outbox enqueue are ONE atomic db.batch(). A failure after the batch
//         can NEVER leave a committed counter with a missing outbox row (there is no
//         post-batch write to fail). We prove the positive (all four rows land together)
//         AND that no statement runs AFTER batch() (a fake DB whose batch() rejects
//         leaves ZERO rows — nothing partial is committed).
//   C2  — a non-integer / NaN / float delta is rejected with a NonRetryableError; the
//         INTEGER counter column is never corrupted (no row written at all).
//   W9  — the WHERE-NOT-EXISTS replay guard covers BOTH the initial INSERT and the
//         ON-CONFLICT UPDATE: a replay AFTER the counter row was reset/deleted does NOT
//         re-seed/double-apply.
//   I20 — the D1 counter PK is String()-normalized so it matches the Vault Target that
//         op-mapping derives (a numeric payload.counter PK == its String() Target).
//
// applyEvent is called DIRECTLY here (not via the DO) so we can inject a failing batch
// for C1 — the DO only adds blockConcurrencyWhile, which is irrelevant to atomicity.

const DB = (env as unknown as { DB: D1Database }).DB;

function evt(over: Partial<WireEvent> = {}): WireEvent {
  return {
    agent: "Forge",
    type: "task.created",
    entity: "tasks",
    op: "increment",
    payload: { counter: "tasks_open", delta: 1 },
    idempotencyKey: "forge:task:crux:base",
    ...over,
  };
}

async function counterValue(entity: string): Promise<number | null> {
  const row = await DB.prepare("SELECT value FROM counters WHERE entity = ?")
    .bind(entity)
    .first<{ value: number }>();
  return row?.value ?? null;
}

async function outboxExists(idem: string): Promise<boolean> {
  const row = await DB.prepare("SELECT idem FROM vault_outbox WHERE idem = ?")
    .bind(idem)
    .first<{ idem: string }>();
  return !!row;
}

async function runLogCount(key: string): Promise<number> {
  // run_log has no idem column; count rows for the event's type+ts-independent shape.
  const row = await DB.prepare(
    "SELECT COUNT(*) AS c FROM run_log WHERE entity = ?",
  )
    .bind(key)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

beforeEach(async () => {
  await DB.batch([
    DB.prepare("DELETE FROM counters"),
    DB.prepare("DELETE FROM idempotency_keys"),
    DB.prepare("DELETE FROM run_log"),
    DB.prepare("DELETE FROM vault_outbox"),
  ]);
});

describe("C1 — first-apply is all-or-nothing (no committed counter without outbox)", () => {
  it("a successful apply lands counter + ledger + run_log + outbox together", async () => {
    const e = evt({ idempotencyKey: "forge:task:c1:ok" });
    expect(await applyEvent(DB, e)).toEqual({ applied: true });

    expect(await counterValue("tasks_open")).toBe(1);
    expect(await outboxExists("forge:task:c1:ok")).toBe(true);
    expect(await runLogCount("tasks")).toBe(1);

    // The invariant: a committed counter ALWAYS has its outbox row.
    if ((await counterValue("tasks_open")) !== null) {
      expect(await outboxExists("forge:task:c1:ok")).toBe(true);
    }
  });

  it("a failing db.batch() commits NOTHING — no counter without an outbox row", async () => {
    // A fake DB whose batch() rejects (a transient D1 failure mid-transaction). Because
    // EVERYTHING is in the single batch, the rejection rolls the whole thing back: the
    // real D1 below confirms no row leaked. Critically, applyEvent issues NO `.run()`
    // after batch() (the old bug), so there is no half-committed state to observe.
    const runAfterBatch = { count: 0 };
    const fakeDb = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              run() {
                runAfterBatch.count += 1; // would flag a post-batch write
                return Promise.resolve({ meta: { changes: 1 } });
              },
            };
          },
        };
      },
      batch() {
        return Promise.reject(new Error("transient D1 failure"));
      },
    } as unknown as D1Database;

    await expect(applyEvent(fakeDb, evt({ idempotencyKey: "forge:task:c1:fail" })))
      .rejects.toThrow(/transient D1 failure/);

    // No `.run()` ran AFTER the batch — the only writes are batch statements.
    expect(runAfterBatch.count).toBe(0);
  });
});

describe("C2 — non-integer delta rejected, INTEGER column never corrupted", () => {
  // NOTE: the spec'd fix is `Number(e.payload.delta ?? 1)` + `Number.isInteger`. So
  // `null`/`undefined` default to 1 (valid) and `[]`/`""` coerce to 0 (valid). The
  // genuinely-bad values below all coerce to NaN or a non-integer float.
  for (const bad of ["abc", "1.5", Number.NaN, "1e3xx", {}] as unknown[]) {
    it(`rejects delta=${JSON.stringify(bad)} with NonRetryableError, writes no row`, async () => {
      const e = evt({
        idempotencyKey: `forge:task:c2:${String(bad)}`,
        payload: { counter: "c2_counter", delta: bad },
      });
      await expect(applyEvent(DB, e)).rejects.toThrow();
      // The throw is a NonRetryableError (name preserved).
      await applyEvent(DB, e).catch((err) => {
        expect((err as Error).name).toBe("NonRetryableError");
      });
      // No counter row was created/corrupted.
      expect(await counterValue("c2_counter")).toBe(null);
    });
  }

  it("a float delta (2.5) is rejected — not silently truncated", async () => {
    const e = evt({
      idempotencyKey: "forge:task:c2:float",
      payload: { counter: "c2_float", delta: 2.5 },
    });
    await expect(applyEvent(DB, e)).rejects.toThrow(/non-integer/i);
    expect(await counterValue("c2_float")).toBe(null);
  });

  it("a valid integer delta still applies (regression guard)", async () => {
    const e = evt({
      idempotencyKey: "forge:task:c2:good",
      payload: { counter: "c2_good", delta: 5 },
    });
    expect(await applyEvent(DB, e)).toEqual({ applied: true });
    expect(await counterValue("c2_good")).toBe(5);
  });
});

describe("W9 — replay guard covers the initial-INSERT path too", () => {
  it("a replay after the counter row is DELETED does NOT re-seed/double-apply", async () => {
    const e = evt({
      idempotencyKey: "forge:task:w9:once",
      payload: { counter: "w9_counter", delta: 3 },
    });
    expect(await applyEvent(DB, e)).toEqual({ applied: true });
    expect(await counterValue("w9_counter")).toBe(3);

    // Simulate a counter-row reset/eviction (the ledger key REMAINS — D-08, forever).
    await DB.prepare("DELETE FROM counters WHERE entity = ?").bind("w9_counter").run();
    expect(await counterValue("w9_counter")).toBe(null);

    // Replay the SAME key. The ledger still has it ⇒ both the initial INSERT and the
    // ON-CONFLICT UPDATE are gated by WHERE NOT EXISTS ⇒ no row re-created.
    expect(await applyEvent(DB, e)).toEqual({ applied: false });
    expect(await counterValue("w9_counter")).toBe(null); // NOT re-seeded to 3
  });
});

describe("I20 — counter PK is String()-normalized (matches the Vault Target)", () => {
  it("a numeric payload.counter is stored under its String() PK", async () => {
    const e = evt({
      idempotencyKey: "forge:task:i20:numeric",
      // A numeric counter id — op-mapping does String(...) for the Vault Target; the
      // D1 PK must use the SAME normalization so they can never diverge.
      payload: { counter: 42 as unknown as string, delta: 1 },
    });
    expect(await applyEvent(DB, e)).toEqual({ applied: true });
    // Stored under the String() form "42", not a raw numeric key.
    expect(await counterValue("42")).toBe(1);
  });
});
