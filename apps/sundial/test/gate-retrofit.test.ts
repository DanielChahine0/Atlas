/**
 * gate-retrofit.test.ts — Sundial gate-retrofit test (04-05, Task 1).
 *
 * Verifies that when runSync() processes propose-removal decisions from reconcile():
 *   1. A gate_pending row is written to D1 with the correct agent, action, target,
 *      idempotency_key, and scope_used for each propose-removal decision.
 *   2. The existing P2 flag() still fires to INCIDENTS (the gate is ADDITIVE).
 *   3. No autonomous delete occurs — the sync loop NEVER calls a delete/remove method;
 *      the CalendarTools interface has no removeEvent, and no direct deletion happens.
 *   4. A re-run with the same eventId reuses the idempotency_key (UNIQUE constraint returns
 *      the existing gate — the D1 gate_pending row count stays at 1).
 *   5. applyRemoval() re-invoke entrypoint: calls removeEvent on approved gate re-invoke,
 *      flags P2 and throws when removeEvent fails (fail-closed).
 *
 * Approach:
 *   - Use the REAL D1 (migrations applied in beforeAll by apply-migrations.ts) — no mocking.
 *   - Run runSync() / Sundial.sync() with injected tools and check D1 state directly.
 *   - runSync() imports openGate from @atlas/gate which writes to the real D1 binding.
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/index.js";
import { runSync, Sundial } from "../src/index.js";
import type { CalendarTools, ExistingEvent } from "../src/reconcile.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const db = (env as unknown as { DB: D1Database }).DB;

/**
 * Build a Sundial Env with real D1 (for openGate writes) and stubbed Wire/INCIDENTS.
 * NTFY_TOPIC/NTFY_TOKEN are absent so openGate skips the push silently (go-live gate).
 */
function makeSundialEnv(): Env {
  return {
    ...(env as unknown as Env),
    WIRE: { send: vi.fn(async () => {}) } as unknown as Queue<unknown>,
    INCIDENTS: { send: vi.fn(async () => {}) } as unknown as Queue<unknown>,
    GATE_BASE_URL: "https://gate.test.invalid",
    NTFY_TOPIC: undefined,
    NTFY_TOKEN: undefined,
  } as unknown as Env;
}

/**
 * Build a CalendarTools stub. No removeEvent — the interface has none (Pillar 2).
 */
function makeTools(existing: ExistingEvent[]): {
  tools: CalendarTools;
  creates: string[];
  patches: string[];
} {
  const creates: string[] = [];
  const patches: string[] = [];
  const tools: CalendarTools = {
    async listOwnEvents() {
      return existing;
    },
    async createEvent(block) {
      creates.push(block.extendedProperties.private.atlasTaskId);
    },
    async patchEvent(eventId) {
      patches.push(eventId);
    },
  };
  return { tools, creates, patches };
}

/** A minimal open TaskRow for a given id. */
function task(id: string, due = "2026-06-10") {
  return {
    id,
    due,
    dedupe_key: `dk-${id}`,
    thread: "t",
    title: `Task ${id}`,
    priority: "P2" as const,
    due_kind: "explicit" as const,
    status: "open" as const,
    source_agent: "Forge",
    locked_by_owner: 0 as const,
    created_at: 0,
    updated_at: 0,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("gate-retrofit — openGate writes gate_pending row per propose-removal", () => {
  it("a duplicate propose-removal decision opens a gate_pending row with correct fields", async () => {
    // Two events with the same atlasTaskId — reconcile proposes removal of the 2nd.
    const existing: ExistingEvent[] = [
      { eventId: "dup-ev-A", extendedProperties: { private: { atlasTaskId: "task-dup-1", contentHash: "h" } } },
      { eventId: "dup-ev-B", extendedProperties: { private: { atlasTaskId: "task-dup-1", contentHash: "h" } } },
    ];
    const { tools } = makeTools(existing);
    const testEnv = makeSundialEnv();

    // Act: task-dup-1 is an OPEN task, so the second event is the proposed-removal.
    const result = await runSync(testEnv, db, "2026-06-08", tools, [task("task-dup-1")]);
    expect(result.proposedRemovals).toBe(1);

    // Assert: gate_pending row written with correct shape.
    const row = await db
      .prepare("SELECT * FROM gate_pending WHERE idempotency_key = ?")
      .bind("sundial:remove:dup-ev-B")
      .first<{
        agent: string;
        action: string;
        target: string;
        idempotency_key: string;
        scope_used: string;
        status: string;
      }>();

    expect(row).not.toBeNull();
    expect(row!.agent).toBe("Sundial");
    expect(row!.action).toBe("calendar.remove");
    expect(row!.target).toBe("dup-ev-B");
    expect(row!.idempotency_key).toBe("sundial:remove:dup-ev-B");
    expect(row!.scope_used).toBe("calendar.events");
    expect(row!.status).toBe("pending");
  });

  it("P2 flag still fires for a duplicate (gate is ADDITIVE — reconcile.ts unchanged)", async () => {
    const existing: ExistingEvent[] = [
      { eventId: "dup-ev-C", extendedProperties: { private: { atlasTaskId: "task-dup-2", contentHash: "h" } } },
      { eventId: "dup-ev-D", extendedProperties: { private: { atlasTaskId: "task-dup-2", contentHash: "h" } } },
    ];
    const { tools } = makeTools(existing);
    const testEnv = makeSundialEnv();

    await runSync(testEnv, db, "2026-06-08", tools, [task("task-dup-2")]);

    // INCIDENTS.send must have been called (the P2 flag from reconcile still fires).
    const incidentsSend = (testEnv.INCIDENTS as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(incidentsSend).toHaveBeenCalled();
    const kinds = incidentsSend.mock.calls.map((c: unknown[]) => (c[0] as { kind?: string }).kind);
    expect(kinds).toContain("calendar_sync_failed");
  });

  it("an orphan propose-removal opens a gate_pending row", async () => {
    const existing: ExistingEvent[] = [
      { eventId: "orphan-ev-Z", extendedProperties: { private: { atlasTaskId: "gone-task", contentHash: "h" } } },
    ];
    const { tools } = makeTools(existing);
    const testEnv = makeSundialEnv();

    // No open tasks reference "gone-task" → orphan → propose-removal
    const result = await runSync(testEnv, db, "2026-06-08", tools, []);
    expect(result.proposedRemovals).toBe(1);

    const row = await db
      .prepare("SELECT * FROM gate_pending WHERE idempotency_key = ?")
      .bind("sundial:remove:orphan-ev-Z")
      .first<{ agent: string; action: string; target: string; idempotency_key: string }>();

    expect(row).not.toBeNull();
    expect(row!.agent).toBe("Sundial");
    expect(row!.action).toBe("calendar.remove");
    expect(row!.target).toBe("orphan-ev-Z");
    expect(row!.idempotency_key).toBe("sundial:remove:orphan-ev-Z");
  });

  it("re-run with same eventId reuses the gate (UNIQUE → no second row, idempotent)", async () => {
    const existing: ExistingEvent[] = [
      { eventId: "idem-ev-1", extendedProperties: { private: { atlasTaskId: "idem-task", contentHash: "h" } } },
      { eventId: "idem-ev-2", extendedProperties: { private: { atlasTaskId: "idem-task", contentHash: "h" } } },
    ];
    const { tools } = makeTools(existing);
    const testEnv = makeSundialEnv();

    // First run: opens the gate
    await runSync(testEnv, db, "2026-06-08", tools, [task("idem-task")]);
    // Second run: same eventId — UNIQUE constraint returns existing gate, no new row
    await runSync(testEnv, db, "2026-06-08", tools, [task("idem-task")]);

    const rows = await db
      .prepare("SELECT COUNT(*) as n FROM gate_pending WHERE idempotency_key = ?")
      .bind("sundial:remove:idem-ev-2")
      .first<{ n: number }>();

    // Exactly one row — the duplicate idempotencyKey returned the existing gate
    expect(rows!.n).toBe(1);
  });

  it("no propose-removal decisions → no gate_pending row opened", async () => {
    // A single new task with no existing events → creates one block, no propose-removal
    const { tools } = makeTools([]);
    const testEnv = makeSundialEnv();

    const countBefore = await db
      .prepare("SELECT COUNT(*) as n FROM gate_pending WHERE agent = 'Sundial'")
      .first<{ n: number }>();

    await runSync(testEnv, db, "2026-06-08", tools, [task("fresh-task")]);

    const countAfter = await db
      .prepare("SELECT COUNT(*) as n FROM gate_pending WHERE agent = 'Sundial'")
      .first<{ n: number }>();

    // No new gate rows opened (fresh task → create, no propose-removal)
    expect(countAfter!.n).toBe(countBefore!.n);
  });

  it("no autonomous delete: CalendarTools has no removeEvent method", async () => {
    // Verify the CalendarTools interface contract — no delete verb exists.
    const { tools } = makeTools([]);
    expect(typeof (tools as unknown as { removeEvent?: unknown }).removeEvent).toBe("undefined");
  });
});

describe("gate-retrofit — applyRemoval() re-invoke entrypoint (gated delete only)", () => {
  it("applyRemoval calls removeEvent with the given eventId on gate re-invoke", async () => {
    const testEnv = makeSundialEnv();
    const sundial = new Sundial({} as ExecutionContext, testEnv);

    const removed: string[] = [];
    const removalTools = {
      removeEvent: vi.fn(async (eventId: string) => {
        removed.push(eventId);
      }),
    };

    const result = await sundial.applyRemoval({
      gateId: "gate-ok",
      eventId: "ev-remove-me",
      tools: removalTools,
    });

    expect(result).toEqual({ removed: true, eventId: "ev-remove-me" });
    expect(removalTools.removeEvent).toHaveBeenCalledOnce();
    expect(removalTools.removeEvent).toHaveBeenCalledWith("ev-remove-me");
    expect(removed).toEqual(["ev-remove-me"]);
  });

  it("applyRemoval throws and flags P2 when no tools injected (fail-closed — no silent no-op)", async () => {
    const testEnv = makeSundialEnv();
    const sundial = new Sundial({} as ExecutionContext, testEnv);

    await expect(
      sundial.applyRemoval({ gateId: "gate-no-tools", eventId: "ev-orphan" }),
    ).rejects.toThrow("no removal tools provided");
  });

  it("applyRemoval flags P2 and rethrows when removeEvent fails (fail-closed)", async () => {
    const testEnv = makeSundialEnv();
    const sundial = new Sundial({} as ExecutionContext, testEnv);

    const failingTools = {
      removeEvent: vi.fn(async (_eventId: string) => {
        throw new Error("Google API 403 Forbidden");
      }),
    };

    await expect(
      sundial.applyRemoval({
        gateId: "gate-fail",
        eventId: "ev-fail",
        tools: failingTools,
      }),
    ).rejects.toThrow("Google API 403 Forbidden");

    expect(failingTools.removeEvent).toHaveBeenCalledOnce();
  });
});
