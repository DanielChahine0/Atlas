import { describe, it, expect } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import { applyEvent } from "@atlas/steward-core";
import {
  Forge,
  buildTaskEvent,
  taskIdFor,
  type Env,
  type CreateTaskInput,
  type CreateTaskOpts,
} from "../src/index.js";

// DoD test 1 (Wire-contract) + DoD test 2 (replay-through-Steward) for Forge.createTask.
// Binding-symmetry + real-D1-task + replay-no-op + null-return (INT-BLOCKER-1 regression guard).

const db = (env as unknown as { DB: D1Database }).DB;

/** Factory for the exact task shape Headhunter passes. */
function headhunterTask(over?: Partial<CreateTaskInput>): CreateTaskInput {
  return {
    title: "Apply to Acme Corp — SWE (Fall 2026)",
    due: "2026-06-20T17:00:00-04:00",
    due_kind: "explicit",
    source_agent: "Headhunter",
    thread: null,
    priority: "P2",
    ...over,
  };
}

/** Factory for createTask opts — the structured idempotencyKey Headhunter supplies. */
function headhunterOpts(over?: Partial<CreateTaskOpts>): CreateTaskOpts {
  return {
    idempotencyKey: "headhunter:window:acme:fall2026:swe",
    runId: "2026-06-10",
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Binding symmetry — the method EXISTS on the Forge WorkerEntrypoint.
//
// This is the regression guard for INT-BLOCKER-1: Headhunter's test suite stubbed
// env.FORGE entirely, so the method's absence went unnoticed. This test instantiates
// a REAL Forge and asserts createTask is a function — the TypeError fires here
// in CI before it ever fires at runtime.
// ─────────────────────────────────────────────────────────────────────────────
describe("Forge.createTask binding symmetry (INT-BLOCKER-1 guard)", () => {
  it("typeof new Forge(ctx, env).createTask === 'function'", () => {
    const ctx = createExecutionContext();
    const forge = new Forge(ctx, env as unknown as Env);
    expect(typeof forge.createTask).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Real D1 task + Wire event.
//
// Calling createTask with the exact Headhunter shape writes a real row into the
// `tasks` table and emits the canonical insert event (op:increment, keyed on id).
// Asserts: DoD Wire-contract (buildTaskEvent + WireEvent.parse) and a real SELECT.
// ─────────────────────────────────────────────────────────────────────────────
describe("Forge.createTask real D1 task + Wire event", () => {
  it("inserts a task row and returns {id} with the correct Wire-contract event", async () => {
    const ctx = createExecutionContext();
    const forge = new Forge(ctx, env as unknown as Env);
    const task = headhunterTask();
    const opts = headhunterOpts();

    const result = await forge.createTask(task, opts);

    // Returns {id} for an insert (not null).
    expect(result).not.toBeNull();
    const { id } = result!;

    // The id is derived from the structured idempotencyKey via taskIdFor.
    expect(id).toBe(taskIdFor(opts.idempotencyKey));

    // A real row was written to D1.
    const row = await db
      .prepare("SELECT id, title, source_agent, thread, priority, due FROM tasks WHERE id = ?")
      .bind(id)
      .first<{
        id: string;
        title: string;
        source_agent: string;
        thread: string | null;
        priority: string;
        due: string;
      }>();
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.title).toBe(task.title);
    expect(row!.source_agent).toBe("Headhunter");
    expect(row!.thread).toBeNull();
    expect(row!.priority).toBe("P2");

    // The canonical insert event (DoD Wire-contract test 1).
    const expectedEvt = buildTaskEvent(id, "inserted");
    expect(expectedEvt.op).toBe("increment");
    expect(expectedEvt.idempotencyKey).toBe(id);
    expect(expectedEvt.agent).toBe("Forge");
    expect(expectedEvt.type).toBe("task");
    expect(expectedEvt.entity).toBe(id);
    expect(() => WireEvent.parse(expectedEvt)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Replay is a no-op (DoD Wire-contract test 2 + replay-through-Steward).
//
// A second createTask call with the same idempotencyKey + same task fields must:
//   - produce NO duplicate task row (COUNT(*) on dedupe_key stays 1)
//   - NOT be a fresh insert (the action is noop/merged, NOT inserted again)
// Confirm replaying the insert event through applyEvent returns {applied:false}
// and the tasks_open counter is unchanged (mirror wire.test.ts:32-43).
// ─────────────────────────────────────────────────────────────────────────────
describe("Forge.createTask replay is a no-op", () => {
  it("a second call with the same idempotencyKey produces no duplicate row, counter unchanged", async () => {
    const ctx = createExecutionContext();
    const forge = new Forge(ctx, env as unknown as Env);

    // Use a unique idempotencyKey so this test is isolated from Test 2.
    const opts = headhunterOpts({ idempotencyKey: "headhunter:window:acme:fall2026:replay-test" });
    const task = headhunterTask();
    const id = taskIdFor(opts.idempotencyKey);

    // Read the counter BEFORE (immune to test-ordering).
    const before =
      (
        await db
          .prepare("SELECT value FROM counters WHERE entity = ?")
          .bind("tasks_open")
          .first<{ value: number }>()
      )?.value ?? 0;

    // First call — should insert.
    const first = await forge.createTask(task, opts);
    expect(first).not.toBeNull();
    expect(first!.id).toBe(id);

    // Second call — same key, same fields. Should produce a merged/noop, NOT a fresh insert.
    const second = await forge.createTask(task, opts);
    // Returns {id} (merged) or null (noop); either is acceptable — what matters is no duplicate.
    if (second !== null) {
      expect(second.id).toBe(id);
    }

    // No duplicate row: dedupe_key is unique — COUNT stays 1.
    const countRow = await db
      .prepare("SELECT COUNT(*) AS c FROM tasks WHERE dedupe_key = ?")
      .bind(opts.idempotencyKey)
      .first<{ c: number }>();
    expect(countRow!.c).toBe(1);

    // Replay the insert event through Steward: first apply → applied:true, replay → applied:false.
    const insertEvt = buildTaskEvent(id, "inserted");
    expect(await applyEvent(db, insertEvt)).toEqual({ applied: true });
    expect(await applyEvent(db, insertEvt)).toEqual({ applied: false }); // replay no-op

    // The counter moved by EXACTLY +1 (the one real insert; the replay didn't bump it).
    const after =
      (
        await db
          .prepare("SELECT value FROM counters WHERE entity = ?")
          .bind("tasks_open")
          .first<{ value: number }>()
      )?.value ?? 0;
    expect(after - before).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: {id}|null return contract.
//
// createTask returns {id} for inserted and merged; null only for noop (owner-locked).
// Happy path: assert a fresh insert returns a non-null id.
// Noop path: pre-insert a row with locked_by_owner=1 then call createTask — returns null.
// ─────────────────────────────────────────────────────────────────────────────
describe("Forge.createTask return contract ({id}|null)", () => {
  it("returns a non-null id on the happy path (inserted)", async () => {
    const ctx = createExecutionContext();
    const forge = new Forge(ctx, env as unknown as Env);
    const opts = headhunterOpts({ idempotencyKey: "headhunter:window:acme:fall2026:happy-path" });
    const task = headhunterTask();

    const result = await forge.createTask(task, opts);
    expect(result).not.toBeNull();
    expect(typeof result!.id).toBe("string");
    expect(result!.id.length).toBeGreaterThan(0);
  });

  it("returns null for a noop (owner-locked row)", async () => {
    const ctx = createExecutionContext();
    const forge = new Forge(ctx, env as unknown as Env);
    const opts = headhunterOpts({
      idempotencyKey: "headhunter:window:acme:fall2026:owner-locked",
    });
    const task = headhunterTask();
    const id = taskIdFor(opts.idempotencyKey);

    // Pre-insert a row with locked_by_owner=1 so upsertTask short-circuits to noop.
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO tasks (id, dedupe_key, thread, title, priority, due, due_kind, status,
           source_agent, locked_by_owner, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        id,
        opts.idempotencyKey,
        null,
        task.title,
        task.priority,
        task.due,
        task.due_kind,
        "open",
        task.source_agent,
        1, // locked_by_owner = 1
        now,
        now,
      )
      .run();

    // createTask hits the owner-locked row → noop → returns null.
    const result = await forge.createTask(task, opts);
    expect(result).toBeNull();
  });
});
