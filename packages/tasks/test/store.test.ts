import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  upsertTask,
  readOpenDeadlineTasks,
  readOpenTasks,
  dedupeKey,
  normalizeTitle,
  type TaskInput,
} from "../src/index.js";

// store.ts against a REAL D1 in workerd. Proves the structural dedupe guarantee:
//   - the idx_tasks_dedupe unique index makes a duplicate task IMPOSSIBLE;
//   - a same-key second insert reports merged/noop (never crashes, never duplicates);
//   - an owner-locked row is not overwritten;
//   - readOpenDeadlineTasks returns only open rows with a due.
//
// Per-test storage isolation is the v4 pool default; apply-migrations.ts applies
// 0001+0002+0003 to the fresh D1 in beforeAll.

const db = (env as unknown as { DB: D1Database }).DB;

async function makeTask(over: Partial<TaskInput> = {}): Promise<TaskInput> {
  const thread = over.thread ?? "t1";
  const rawTitle = over.title ?? "Submit Shopify OA";
  const norm = normalizeTitle(rawTitle);
  const due = over.due === undefined ? "2026-06-02T23:59:00-04:00" : over.due;
  const dueForKey = due ?? "";
  const key = over.dedupe_key ?? (await dedupeKey(thread ?? "", norm, dueForKey));
  return {
    id: over.id ?? `task-${key.slice(0, 12)}`,
    dedupe_key: key,
    thread,
    title: rawTitle,
    priority: over.priority ?? "P2",
    due,
    due_kind: over.due_kind ?? "explicit",
    status: over.status ?? "open",
    source_agent: over.source_agent ?? "Forge",
    locked_by_owner: over.locked_by_owner ?? 0,
    subtasks: over.subtasks ?? [],
  };
}

async function countTasks(): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();
  return r?.n ?? -1;
}

describe("@atlas/tasks store (real D1)", () => {
  it("inserts a task on a dedupe miss", async () => {
    const task = await makeTask({ id: "ins-1", thread: "thr-ins-1" });
    const res = await upsertTask(db, task);
    expect(res.action).toBe("inserted");
    const row = await db
      .prepare("SELECT title, priority FROM tasks WHERE id = ?")
      .bind("ins-1")
      .first<{ title: string; priority: string }>();
    expect(row?.title).toBe("Submit Shopify OA");
  });

  it("a second insert of the SAME thread+title+due does NOT duplicate (unique index held)", async () => {
    const before = await countTasks();
    const t1 = await makeTask({ id: "dup-a", thread: "thr-dup" });
    const t2 = await makeTask({ id: "dup-b", thread: "thr-dup" }); // same dedupe inputs, different id
    expect(t1.dedupe_key).toBe(t2.dedupe_key);
    const r1 = await upsertTask(db, t1);
    const r2 = await upsertTask(db, t2);
    expect(r1.action).toBe("inserted");
    expect(["merged", "noop"]).toContain(r2.action);
    // Exactly one new row survived for this dedupe key.
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE dedupe_key = ?")
      .bind(t1.dedupe_key)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
    // And the second upsert resolved to the FIRST row's id (the merge target).
    expect(r2.id).toBe("dup-a");
    // total count grew by exactly 1 across both upserts.
    expect(await countTasks()).toBe(before + 1);
  });

  it("merge unions subtasks, takes earliest due + strongest priority", async () => {
    const thread = "thr-merge";
    const t1 = await makeTask({
      id: "mrg-1",
      thread,
      priority: "P3",
      due: "2026-06-10T23:59:00-04:00",
      subtasks: [{ id: "s1", title: "open link" }],
    });
    // Same dedupe key requires same normalized title + due used for the key. Force the
    // same key so this is a cross-channel hit, but carry a stronger priority + earlier due.
    const t2 = await makeTask({
      id: "mrg-2",
      thread,
      dedupe_key: t1.dedupe_key,
      priority: "P1",
      due: "2026-06-05T23:59:00-04:00",
      subtasks: [{ id: "s2", title: "do work" }],
    });
    await upsertTask(db, t1);
    const r2 = await upsertTask(db, t2);
    expect(r2.action).toBe("merged");
    const row = await db
      .prepare("SELECT priority, due FROM tasks WHERE id = ?")
      .bind("mrg-1")
      .first<{ priority: string; due: string }>();
    expect(row?.priority).toBe("P1"); // strongest
    expect(row?.due).toBe("2026-06-05T23:59:00-04:00"); // earliest
    const subs = await db
      .prepare("SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ?")
      .bind("mrg-1")
      .first<{ n: number }>();
    expect(subs?.n).toBe(2); // union
  });

  it("does NOT overwrite a locked_by_owner=1 row (short-circuit to noop)", async () => {
    const t1 = await makeTask({
      id: "lock-1",
      thread: "thr-lock",
      priority: "P4",
      locked_by_owner: 1,
    });
    await upsertTask(db, t1);
    const t2 = await makeTask({
      id: "lock-2",
      thread: "thr-lock",
      dedupe_key: t1.dedupe_key,
      priority: "P1",
    });
    const r2 = await upsertTask(db, t2);
    expect(r2.action).toBe("noop");
    const row = await db
      .prepare("SELECT priority FROM tasks WHERE id = ?")
      .bind("lock-1")
      .first<{ priority: string }>();
    expect(row?.priority).toBe("P4"); // unchanged — owner edit preserved
  });

  it("readOpenDeadlineTasks returns only open rows with a due", async () => {
    await upsertTask(db, await makeTask({ id: "rd-due", thread: "thr-rd-due" }));
    await upsertTask(
      db,
      await makeTask({ id: "rd-nodue", thread: "thr-rd-nodue", due: null }),
    );
    await upsertTask(
      db,
      await makeTask({ id: "rd-done", thread: "thr-rd-done", status: "done" }),
    );
    const rows = await readOpenDeadlineTasks(db);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("rd-due");
    expect(ids).not.toContain("rd-nodue"); // no due
    expect(ids).not.toContain("rd-done"); // not open
  });

  it("readOpenTasks returns all open rows (with or without a due)", async () => {
    await upsertTask(db, await makeTask({ id: "ot-due", thread: "thr-ot-due" }));
    await upsertTask(
      db,
      await makeTask({ id: "ot-nodue", thread: "thr-ot-nodue", due: null }),
    );
    await upsertTask(
      db,
      await makeTask({ id: "ot-done", thread: "thr-ot-done", status: "done" }),
    );
    const rows = await readOpenTasks(db);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("ot-due");
    expect(ids).toContain("ot-nodue");
    expect(ids).not.toContain("ot-done");
  });
});
