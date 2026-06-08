/**
 * index.test.ts — Usher WorkerEntrypoint tests (Wave 0 stub)
 *
 * Covers the exact --grep cases from 04-VALIDATION.md:
 *   - already-registered: pre-gate short-circuit (no gate, no browser action)
 *   - gate-open: initial register() opens gate, returns gate_opened
 *   - continuation: gate-approved re-invocation inserts browser_action_outbox row
 *   - p1-self-flag: continuation without approved gate → P1 flag + no browser action
 *   - captcha: hard_stop captcha → P3 flag, zero side effects
 *   - payment: hard_stop payment → P2 flag, zero side effects
 *   - sold-out: hard_stop sold_out → P3 flag, zero side effects
 *   - no-confirmation: success with empty confirmation_number → P2 flag, not registered
 *   - Wire-contract: Wire event shape (agent/op/idempotencyKey) + Pattern 7 exact match
 *   - replay: second registration is no-op (key exists → meta.changes===0 through Steward path)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  runRegister,
  runOutcome,
  HARD_STOP_SEVERITY,
  type Env,
  type RegisterParams,
  type OutcomeParams,
} from "./index.js";
import type { CalendarTools } from "./calendar.js";

// ─── Test env setup ──────────────────────────────────────────────────────────

/** Build a test Env that uses the real workerd D1 from cloudflare:test. */
function makeEnv(overrides?: Partial<Env>): Env {
  const base = env as unknown as { DB: D1Database; WIRE: Queue<unknown>; INCIDENTS: Queue<unknown>; CONFIG: KVNamespace };

  // Captured Wire events for assertion
  const wireEvents: unknown[] = [];

  // Captured flag() calls — flag() sends to INCIDENTS queue
  const flagCalls: Array<{
    severity: string;
    title: string;
    kind: string;
  }> = [];

  // Mock WIRE queue — captures send() calls for assertion
  const mockWire = {
    send: vi.fn(async (msg: unknown) => {
      wireEvents.push(msg);
    }),
    sendBatch: vi.fn(),
    wireEvents, // expose for assertions
  } as unknown as Queue<unknown>;

  // Mock INCIDENTS queue — captures flag() calls
  const mockIncidents = {
    send: vi.fn(async (msg: unknown) => {
      const m = msg as { kind?: string; severity_hint?: string; title?: string };
      flagCalls.push({
        severity: m.severity_hint ?? "",
        title: m.title ?? "",
        kind: m.kind ?? "",
      });
    }),
    sendBatch: vi.fn(),
    flagCalls, // expose for assertions
  } as unknown as Queue<unknown>;

  return {
    DB: base.DB,
    WIRE: mockWire,
    INCIDENTS: mockIncidents as Queue<unknown>,
    CONFIG: base.CONFIG,
    GATE_BASE_URL: "https://gate.test.workers.dev",
    NTFY_TOPIC: { get: async () => null },  // unseeded — push silently skipped
    NTFY_TOKEN: { get: async () => null },
    ...overrides,
  } as Env & {
    WIRE: typeof mockWire;
    INCIDENTS: typeof mockIncidents;
  };
}

/** Seed an event row into the events table. */
async function seedEvent(db: D1Database, id: string, overrides?: Partial<{
  title: string;
  start: string;
  end: string;
  location: string;
  url: string;
  status: string;
}>) {
  await db.prepare(
    `INSERT OR REPLACE INTO events (id, title, start, end, location, online, url, source, relevance, why, horizon, status, digest_date, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'test', 80, 'test', 'this_week', ?, '2026-06-08', ?)`,
  )
    .bind(
      id,
      overrides?.title ?? "Test Conference 2026",
      overrides?.start ?? "2026-09-15T09:00:00-04:00",
      overrides?.end ?? "2026-09-15T17:00:00-04:00",
      overrides?.location ?? "Toronto, ON",
      overrides?.url ?? `https://event.example.com/${id}`,
      overrides?.status ?? "relevant",
      Date.now(),
    )
    .run();
}

/** Seed the gate_pending row with status=approved (simulates an owner confirm). */
async function seedApprovedGate(db: D1Database, gateId: string, eventId: string) {
  await db.prepare(
    `INSERT INTO gate_pending (id, agent, action, target, artifact, edited_artifact, status, decision, scope_used, idempotency_key, token_hash, expires_at, flag_id, created_at, updated_at)
     VALUES (?, 'Usher', 'event.register', ?, '{}', NULL, 'approved', 'approved', 'calendar.events', ?, 'fakehash', ?, NULL, ?, ?)`,
  )
    .bind(
      gateId,
      eventId,
      `usher:${eventId}:registered`,
      Date.now() + 86400000,
      Date.now(),
      Date.now(),
    )
    .run();
}

/** Seed the gate_pending row with status=pending. */
async function seedPendingGate(db: D1Database, gateId: string, eventId: string) {
  await db.prepare(
    `INSERT INTO gate_pending (id, agent, action, target, artifact, edited_artifact, status, decision, scope_used, idempotency_key, token_hash, expires_at, flag_id, created_at, updated_at)
     VALUES (?, 'Usher', 'event.register', ?, '{}', NULL, 'pending', 'pending', 'calendar.events', ?, 'fakehash', ?, NULL, ?, ?)`,
  )
    .bind(
      gateId,
      eventId,
      `usher:${eventId}:registered`,
      Date.now() + 86400000,
      Date.now(),
      Date.now(),
    )
    .run();
}

/** Insert the idempotency_key row to simulate an already-registered event. */
async function seedIdempotencyKey(db: D1Database, key: string) {
  // idempotency_keys schema (0001_init_core.sql): key, agent, type, entity, op, applied_at
  await db.prepare(
    "INSERT INTO idempotency_keys (key, agent, type, entity, op, applied_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(key, "Usher", "event.registered", "events", "increment", Date.now())
    .run();
}

/**
 * Seed the authorization evidence onOutcome's success path requires (T-04-30):
 * an APPROVED gate + a COMPLETED (status='done') browser_action_outbox row linked to it.
 * Without this, a success outcome is treated as fabricated → P1 + zero side effects.
 */
async function seedAuthorizedCompletion(db: D1Database, gateId: string, eventId: string) {
  await seedApprovedGate(db, gateId, eventId);
  await db.prepare(
    `INSERT INTO browser_action_outbox (id, agent, action_type, fields, gate_id, target_url, status, outcome, created_at)
     VALUES (?, 'Usher', 'event_fill_submit', '{}', ?, ?, 'done', NULL, ?)`,
  )
    .bind(`outbox-${gateId}`, gateId, `https://event.example.com/${eventId}`, Date.now())
    .run();
}

const TEST_CODEX_FIELDS = {
  full_name: "Daniel Chahine",
  email: "chahinedaniel0@gmail.com",
  phone: "+1-416-555-0123",
  title: "Software Engineer",
};

// ─── already-registered ──────────────────────────────────────────────────────

describe("already-registered", () => {
  it("returns already_registered without opening a gate when idempotency key exists", async () => {
    const testEnv = makeEnv();
    const eventId = "already-registered-evt-001";
    await seedIdempotencyKey(testEnv.DB, `usher:${eventId}:registered`);

    const params: RegisterParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      _codexFields: TEST_CODEX_FIELDS,
    };

    const result = await runRegister(testEnv, params, "2026-06-08");

    expect(result.status).toBe("already_registered");
    expect(result.gateId).toBeUndefined();

    // No gate_pending row should have been inserted
    const gateRows = await testEnv.DB.prepare(
      "SELECT COUNT(*) as cnt FROM gate_pending WHERE idempotency_key = ?",
    )
      .bind(`usher:${eventId}:registered`)
      .first<{ cnt: number }>();
    expect(gateRows?.cnt).toBe(0);

    // No browser_action_outbox row
    const outboxRows = await testEnv.DB.prepare(
      "SELECT COUNT(*) as cnt FROM browser_action_outbox WHERE agent = 'Usher'",
    ).first<{ cnt: number }>();
    expect(outboxRows?.cnt).toBe(0);

    // No Wire event
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);
  });
});

// ─── gate-open ───────────────────────────────────────────────────────────────

describe("gate-open", () => {
  it("opens a gate and returns gate_opened on initial register", async () => {
    const testEnv = makeEnv();
    const eventId = "gate-open-evt-001";
    await seedEvent(testEnv.DB, eventId);

    const params: RegisterParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      _codexFields: TEST_CODEX_FIELDS,
    };

    const result = await runRegister(testEnv, params, "2026-06-08");

    expect(result.status).toBe("gate_opened");
    expect(result.gateId).toBeDefined();

    // gate_pending row should exist with status=pending
    const gateRow = await testEnv.DB.prepare(
      "SELECT status, action, scope_used, idempotency_key FROM gate_pending WHERE id = ?",
    )
      .bind(result.gateId!)
      .first<{ status: string; action: string; scope_used: string; idempotency_key: string }>();

    expect(gateRow?.status).toBe("pending");
    expect(gateRow?.action).toBe("event.register");
    expect(gateRow?.scope_used).toBe("calendar.events");
    expect(gateRow?.idempotency_key).toBe(`usher:${eventId}:registered`);

    // No Wire event emitted yet
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);
  });
});

// ─── continuation ─────────────────────────────────────────────────────────────

describe("continuation", () => {
  it("enqueues a browser_action_outbox row on approved gate re-invocation", async () => {
    const testEnv = makeEnv();
    const eventId = "continuation-evt-001";
    const gateId = "gate-continuation-001";
    await seedEvent(testEnv.DB, eventId);
    await seedApprovedGate(testEnv.DB, gateId, eventId);

    const params: RegisterParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      gateId,
      _codexFields: TEST_CODEX_FIELDS,
    };

    const result = await runRegister(testEnv, params, "2026-06-08");

    expect(result.status).toBe("browser_action_enqueued");

    // browser_action_outbox row should exist
    const outboxRow = await testEnv.DB.prepare(
      "SELECT agent, action_type, gate_id, target_url, status FROM browser_action_outbox WHERE gate_id = ?",
    )
      .bind(gateId)
      .first<{ agent: string; action_type: string; gate_id: string; target_url: string; status: string }>();

    expect(outboxRow?.agent).toBe("Usher");
    expect(outboxRow?.action_type).toBe("event_fill_submit");
    expect(outboxRow?.gate_id).toBe(gateId);
    expect(outboxRow?.target_url).toBe("https://event.example.com/test");
    expect(outboxRow?.status).toBe("pending");

    // fields should contain name + email, not passwords
    const fieldsRow = await testEnv.DB.prepare(
      "SELECT fields FROM browser_action_outbox WHERE gate_id = ?",
    )
      .bind(gateId)
      .first<{ fields: string }>();
    const fields = JSON.parse(fieldsRow?.fields ?? "{}") as Record<string, unknown>;
    expect(fields.name).toBe("Daniel Chahine");
    expect(fields.email).toBe("chahinedaniel0@gmail.com");
    // Must not contain password/2FA-style fields
    expect(fields.password).toBeUndefined();

    // No Wire event (not registered yet — daemon hasn't run)
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);
  });
});

// ─── p1-self-flag ─────────────────────────────────────────────────────────────

describe("p1-self-flag", () => {
  it("emits P1 flag and does NOT enqueue browser action when gate is NOT approved", async () => {
    const testEnv = makeEnv();
    const eventId = "p1-flag-evt-001";
    const gateId = "gate-pending-001";
    await seedEvent(testEnv.DB, eventId);
    await seedPendingGate(testEnv.DB, gateId, eventId);

    const params: RegisterParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      gateId, // continuation with PENDING gate (not approved!)
      _codexFields: TEST_CODEX_FIELDS,
    };

    // Should NOT throw — it self-flags and returns
    const result = await runRegister(testEnv, params, "2026-06-08");

    // P1 flag emitted via INCIDENTS
    const incidents = testEnv.INCIDENTS as unknown as { flagCalls: Array<{ severity: string; kind: string }> };
    const p1Flags = incidents.flagCalls.filter((c) => c.severity === "P1");
    expect(p1Flags.length).toBeGreaterThan(0);
    expect(p1Flags[0]!.kind).toContain("usher:registration_attempted_without_confirmation");

    // No browser_action_outbox row should have been inserted
    const outboxRows = await testEnv.DB.prepare(
      "SELECT COUNT(*) as cnt FROM browser_action_outbox WHERE gate_id = ?",
    )
      .bind(gateId)
      .first<{ cnt: number }>();
    expect(outboxRows?.cnt).toBe(0);

    // No Wire event
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);
  });

  it("emits P1 flag when gateId does not exist in gate_pending", async () => {
    const testEnv = makeEnv();
    const eventId = "p1-flag-evt-002";
    const gateId = "nonexistent-gate-id";
    await seedEvent(testEnv.DB, eventId);
    // Do NOT seed a gate row

    const params: RegisterParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      gateId,
      _codexFields: TEST_CODEX_FIELDS,
    };

    await runRegister(testEnv, params, "2026-06-08");

    const incidents = testEnv.INCIDENTS as unknown as { flagCalls: Array<{ severity: string }> };
    const p1Flags = incidents.flagCalls.filter((c) => c.severity === "P1");
    expect(p1Flags.length).toBeGreaterThan(0);

    // No browser_action_outbox row
    const outboxRows = await testEnv.DB.prepare(
      "SELECT COUNT(*) as cnt FROM browser_action_outbox WHERE gate_id = ?",
    )
      .bind(gateId)
      .first<{ cnt: number }>();
    expect(outboxRows?.cnt).toBe(0);
  });
});

// ─── captcha ──────────────────────────────────────────────────────────────────

describe("captcha", () => {
  it("emits P3 flag and performs ZERO side effects on captcha hard stop", async () => {
    const testEnv = makeEnv();
    const eventId = "captcha-evt-001";
    await seedEvent(testEnv.DB, eventId, { status: "relevant" });

    const mockCalendar: CalendarTools = {
      createEvent: vi.fn(async () => ({ eventId: "should-not-be-called" })),
    };

    const params: OutcomeParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      outcome: {
        status: "hard_stop",
        hard_stop_reason: "captcha",
      },
      _calendarTools: mockCalendar,
    };

    const result = await runOutcome(testEnv, params, "2026-06-08");

    expect(result.status).toBe("outcome_handled");

    // P3 flag emitted
    const incidents = testEnv.INCIDENTS as unknown as { flagCalls: Array<{ severity: string; kind: string }> };
    const p3Flags = incidents.flagCalls.filter((c) => c.severity === "P3");
    expect(p3Flags.length).toBeGreaterThan(0);
    expect(p3Flags[0]!.kind).toContain("captcha");

    // ZERO side effects: no Calendar add
    expect(mockCalendar.createEvent).not.toHaveBeenCalled();

    // No Wire event
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);

    // events.status NOT changed to 'registered'
    const eventRow = await testEnv.DB.prepare("SELECT status FROM events WHERE id = ?")
      .bind(eventId)
      .first<{ status: string }>();
    expect(eventRow?.status).not.toBe("registered");
  });
});

// ─── payment ──────────────────────────────────────────────────────────────────

describe("payment", () => {
  it("emits P2 flag and performs ZERO side effects on payment hard stop", async () => {
    const testEnv = makeEnv();
    const eventId = "payment-evt-001";
    await seedEvent(testEnv.DB, eventId, { status: "relevant" });

    const mockCalendar: CalendarTools = {
      createEvent: vi.fn(async () => ({ eventId: "should-not-be-called" })),
    };

    const params: OutcomeParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      outcome: {
        status: "hard_stop",
        hard_stop_reason: "payment",
      },
      _calendarTools: mockCalendar,
    };

    const result = await runOutcome(testEnv, params, "2026-06-08");

    expect(result.status).toBe("outcome_handled");

    // P2 flag (payment → P2, not P3)
    const incidents = testEnv.INCIDENTS as unknown as { flagCalls: Array<{ severity: string; kind: string }> };
    const p2Flags = incidents.flagCalls.filter((c) => c.severity === "P2");
    expect(p2Flags.length).toBeGreaterThan(0);
    expect(p2Flags[0]!.kind).toContain("payment");

    // ZERO side effects: no Calendar add
    expect(mockCalendar.createEvent).not.toHaveBeenCalled();

    // No Wire event
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);

    // events.status NOT 'registered'
    const eventRow = await testEnv.DB.prepare("SELECT status FROM events WHERE id = ?")
      .bind(eventId)
      .first<{ status: string }>();
    expect(eventRow?.status).not.toBe("registered");
  });
});

// ─── sold-out ─────────────────────────────────────────────────────────────────

describe("sold-out", () => {
  it("emits P3 flag and performs ZERO side effects on sold_out hard stop", async () => {
    const testEnv = makeEnv();
    const eventId = "sold-out-evt-001";
    await seedEvent(testEnv.DB, eventId, { status: "relevant" });

    const mockCalendar: CalendarTools = {
      createEvent: vi.fn(async () => ({ eventId: "should-not-be-called" })),
    };

    const params: OutcomeParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      outcome: {
        status: "hard_stop",
        hard_stop_reason: "sold_out",
      },
      _calendarTools: mockCalendar,
    };

    const result = await runOutcome(testEnv, params, "2026-06-08");

    expect(result.status).toBe("outcome_handled");

    // P3 flag for sold_out
    const incidents = testEnv.INCIDENTS as unknown as { flagCalls: Array<{ severity: string; kind: string }> };
    const p3Flags = incidents.flagCalls.filter((c) => c.severity === "P3");
    expect(p3Flags.length).toBeGreaterThan(0);

    // ZERO side effects
    expect(mockCalendar.createEvent).not.toHaveBeenCalled();
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);
  });
});

// ─── no-confirmation ──────────────────────────────────────────────────────────

describe("no-confirmation", () => {
  it("emits P2 flag and is NOT registered when confirmation_number is empty", async () => {
    const testEnv = makeEnv();
    const eventId = "no-conf-evt-001";
    await seedEvent(testEnv.DB, eventId, { status: "relevant" });

    const mockCalendar: CalendarTools = {
      createEvent: vi.fn(async () => ({ eventId: "should-not-be-called" })),
    };

    const params: OutcomeParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      outcome: {
        status: "success",
        confirmation_number: "",  // empty!
      },
      _calendarTools: mockCalendar,
    };

    const result = await runOutcome(testEnv, params, "2026-06-08");

    expect(result.status).toBe("outcome_handled");

    // P2 flag for empty confirmation
    const incidents = testEnv.INCIDENTS as unknown as { flagCalls: Array<{ severity: string; kind: string }> };
    const p2Flags = incidents.flagCalls.filter((c) => c.severity === "P2");
    expect(p2Flags.length).toBeGreaterThan(0);

    // No Calendar add
    expect(mockCalendar.createEvent).not.toHaveBeenCalled();

    // No Wire event
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);

    // events.status NOT 'registered'
    const eventRow = await testEnv.DB.prepare("SELECT status FROM events WHERE id = ?")
      .bind(eventId)
      .first<{ status: string }>();
    expect(eventRow?.status).not.toBe("registered");
  });

  it("also handles undefined confirmation_number as no-confirmation", async () => {
    const testEnv = makeEnv();
    const eventId = "no-conf-evt-002";
    await seedEvent(testEnv.DB, eventId, { status: "relevant" });

    const mockCalendar: CalendarTools = {
      createEvent: vi.fn(async () => ({ eventId: "should-not-be-called" })),
    };

    const params: OutcomeParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      outcome: {
        status: "success",
        // confirmation_number not set
      },
      _calendarTools: mockCalendar,
    };

    await runOutcome(testEnv, params, "2026-06-08");

    // No Calendar add
    expect(mockCalendar.createEvent).not.toHaveBeenCalled();

    // No Wire event
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);
  });
});

// ─── Wire-contract ────────────────────────────────────────────────────────────

describe("Wire-contract", () => {
  it("emits exact Pattern 7 Wire event after non-empty confirmation number", async () => {
    const testEnv = makeEnv();
    const eventId = "wire-contract-evt-001";
    await seedEvent(testEnv.DB, eventId, { title: "AWS Summit Toronto 2026" });
    await seedAuthorizedCompletion(testEnv.DB, "gate-wire-contract-001", eventId);

    const mockCalendar: CalendarTools = {
      createEvent: vi.fn(async () => ({ eventId: "cal-event-123" })),
    };

    const params: OutcomeParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      outcome: {
        status: "success",
        confirmation_number: "CONF-ABC-123",
      },
      _calendarTools: mockCalendar,
      _eventRow: {
        id: eventId,
        title: "AWS Summit Toronto 2026",
        start: "2026-09-15T09:00:00-04:00",
        end: "2026-09-15T17:00:00-04:00",
        location: "Toronto, ON",
        url: "https://event.example.com/test",
        status: "relevant",
      },
    };

    const result = await runOutcome(testEnv, params, "2026-06-08");

    expect(result.status).toBe("outcome_handled");
    expect(result.calendarEventId).toBe("cal-event-123");

    // Wire event emitted exactly once
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(1);

    // Pattern 7 exact shape
    const wireEvent = wire.wireEvents[0] as Record<string, unknown>;
    expect(wireEvent.agent).toBe("Usher");
    expect(wireEvent.type).toBe("event.registered");
    expect(wireEvent.entity).toBe("events");
    expect(wireEvent.op).toBe("increment");
    expect(wireEvent.idempotencyKey).toBe(`usher:${eventId}:registered`);

    // Payload shape
    const payload = wireEvent.payload as Record<string, unknown>;
    expect(payload.metric).toBe("events-registered");
    expect(payload.by).toBe(1);
    expect(payload.event).toBe("AWS Summit Toronto 2026");
    expect(payload.confirmation).toBe("CONF-ABC-123");
  });

  it("emits Wire event AFTER Calendar add and status update (never optimistic)", async () => {
    const testEnv = makeEnv();
    const eventId = "wire-order-evt-001";
    await seedEvent(testEnv.DB, eventId);
    await seedAuthorizedCompletion(testEnv.DB, "gate-wire-order-001", eventId);

    // Track order of operations
    const ops: string[] = [];

    const mockCalendar: CalendarTools = {
      createEvent: vi.fn(async () => {
        ops.push("calendar_add");
        return { eventId: "cal-123" };
      }),
    };

    // Intercept the wire send to track its position
    const base = testEnv.WIRE as unknown as { send: (msg: unknown) => Promise<void>; wireEvents: unknown[] };
    const originalSend = base.send.bind(base);
    base.send = vi.fn(async (msg: unknown) => {
      ops.push("wire_send");
      base.wireEvents.push(msg);
      await originalSend(msg);
    });

    const params: OutcomeParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      outcome: {
        status: "success",
        confirmation_number: "CONF-XYZ-789",
      },
      _calendarTools: mockCalendar,
    };

    await runOutcome(testEnv, params, "2026-06-08");

    // Calendar add MUST come before Wire send (Pitfall 6)
    const calIdx = ops.indexOf("calendar_add");
    const wireIdx = ops.indexOf("wire_send");
    expect(calIdx).toBeGreaterThanOrEqual(0);
    expect(wireIdx).toBeGreaterThan(calIdx);

    // Status updated to 'registered' before Wire
    const statusRow = await testEnv.DB.prepare("SELECT status FROM events WHERE id = ?")
      .bind(eventId)
      .first<{ status: string }>();
    expect(statusRow?.status).toBe("registered");
  });

  it("Wire idempotencyKey is exactly usher:<eventId>:registered (no crypto.randomUUID)", async () => {
    const testEnv = makeEnv();
    const eventId = "idem-key-evt-001";
    await seedEvent(testEnv.DB, eventId);
    await seedAuthorizedCompletion(testEnv.DB, "gate-idem-key-001", eventId);

    const mockCalendar: CalendarTools = {
      createEvent: vi.fn(async () => ({ eventId: "cal-idem" })),
    };

    const params: OutcomeParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      outcome: {
        status: "success",
        confirmation_number: "CONF-IDEM-001",
      },
      _calendarTools: mockCalendar,
    };

    await runOutcome(testEnv, params, "2026-06-08");

    const wire = testEnv.WIRE as unknown as { wireEvents: Array<{ idempotencyKey: string }> };
    expect(wire.wireEvents[0]!.idempotencyKey).toBe(`usher:${eventId}:registered`);
  });
});

// ─── replay ───────────────────────────────────────────────────────────────────

describe("replay", () => {
  it("short-circuits on second register call (idempotency key exists)", async () => {
    const testEnv = makeEnv();
    const eventId = "replay-evt-001";
    await seedEvent(testEnv.DB, eventId);

    // Simulate first registration by inserting the idempotency key
    await seedIdempotencyKey(testEnv.DB, `usher:${eventId}:registered`);

    const params: RegisterParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      _codexFields: TEST_CODEX_FIELDS,
    };

    // Second call: should be a no-op
    const result = await runRegister(testEnv, params, "2026-06-08");

    expect(result.status).toBe("already_registered");

    // No new gate rows
    const gateRows = await testEnv.DB.prepare(
      "SELECT COUNT(*) as cnt FROM gate_pending WHERE idempotency_key = ?",
    )
      .bind(`usher:${eventId}:registered`)
      .first<{ cnt: number }>();
    expect(gateRows?.cnt).toBe(0);

    // No Wire event
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);
  });

  it("second outcome call for same event is a no-op (stable key deduped via short-circuit)", async () => {
    const testEnv = makeEnv();
    const eventId = "replay-outcome-evt-001";
    await seedEvent(testEnv.DB, eventId);

    // Simulate already-registered
    await seedIdempotencyKey(testEnv.DB, `usher:${eventId}:registered`);

    // Register call on already-registered → short-circuits immediately
    const params: RegisterParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      _codexFields: TEST_CODEX_FIELDS,
    };

    const result = await runRegister(testEnv, params, "2026-06-08");
    expect(result.status).toBe("already_registered");

    // Wire events: 0 (no counter bump on replay)
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);
  });
});

// ─── security-hardening: gate-replay / RPC-authorization / outcome idempotency ──

describe("security-hardening", () => {
  it("onOutcome with a fabricated confirmation but NO approved+completed action → P1, zero side effects (T-04-30)", async () => {
    const testEnv = makeEnv();
    const eventId = "unauth-outcome-evt-001";
    await seedEvent(testEnv.DB, eventId);
    // Deliberately seed NO approved gate and NO done browser_action_outbox row.

    const mockCalendar: CalendarTools = {
      createEvent: vi.fn(async () => ({ eventId: "should-not-be-called" })),
    };

    const result = await runOutcome(
      testEnv,
      {
        eventId,
        eventUrl: "https://event.example.com/test",
        outcome: { status: "success", confirmation_number: "FORGED-123" },
        _calendarTools: mockCalendar,
      },
      "2026-06-08",
    );

    // Discriminated failure status — never a success-shaped value
    expect(result.status).toBe("gate_not_approved");

    // P1 self-flag for the unauthorized outcome
    const incidents = testEnv.INCIDENTS as unknown as { flagCalls: Array<{ severity: string; kind: string }> };
    const p1Flags = incidents.flagCalls.filter((c) => c.severity === "P1");
    expect(p1Flags.length).toBeGreaterThan(0);
    expect(p1Flags[0]!.kind).toContain("usher:outcome_without_authorized_action");

    // ZERO side effects: no Calendar add, no Wire, status not registered
    expect(mockCalendar.createEvent).not.toHaveBeenCalled();
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(0);
    const eventRow = await testEnv.DB.prepare("SELECT status FROM events WHERE id = ?")
      .bind(eventId)
      .first<{ status: string }>();
    expect(eventRow?.status).not.toBe("registered");
  });

  it("replayed onOutcome for the same event is a no-op — no second Calendar add or counter (T-04-31)", async () => {
    const testEnv = makeEnv();
    const eventId = "replay-outcome-evt-100";
    await seedEvent(testEnv.DB, eventId);
    await seedAuthorizedCompletion(testEnv.DB, "gate-replay-outcome-100", eventId);

    let calAdds = 0;
    const mockCalendar: CalendarTools = {
      createEvent: vi.fn(async () => {
        calAdds += 1;
        return { eventId: `cal-${calAdds}` };
      }),
    };

    const params: OutcomeParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      outcome: { status: "success", confirmation_number: "CONF-REPLAY-100" },
      _calendarTools: mockCalendar,
    };

    const first = await runOutcome(testEnv, params, "2026-06-08");
    const second = await runOutcome(testEnv, params, "2026-06-08");

    expect(first.status).toBe("outcome_handled");
    expect(second.status).toBe("already_handled");

    // Exactly ONE Calendar add and ONE Wire event across both calls
    expect(calAdds).toBe(1);
    const wire = testEnv.WIRE as unknown as { wireEvents: unknown[] };
    expect(wire.wireEvents).toHaveLength(1);
  });

  it("replayed approved continuation does NOT enqueue a second browser action (gate-replay, T-04-29)", async () => {
    const testEnv = makeEnv();
    const eventId = "replay-continuation-evt-100";
    const gateId = "gate-replay-continuation-100";
    await seedEvent(testEnv.DB, eventId);
    await seedApprovedGate(testEnv.DB, gateId, eventId);

    const params: RegisterParams = {
      eventId,
      eventUrl: "https://event.example.com/test",
      gateId,
      _codexFields: TEST_CODEX_FIELDS,
    };

    const first = await runRegister(testEnv, params, "2026-06-08");
    const second = await runRegister(testEnv, params, "2026-06-08");

    expect(first.status).toBe("browser_action_enqueued");
    expect(second.status).toBe("already_enqueued");

    // Exactly ONE browser_action_outbox row for this gate
    const outboxCount = await testEnv.DB.prepare(
      "SELECT COUNT(*) as cnt FROM browser_action_outbox WHERE gate_id = ?",
    )
      .bind(gateId)
      .first<{ cnt: number }>();
    expect(outboxCount?.cnt).toBe(1);
  });
});

// ─── Hard-stop severity table completeness ────────────────────────────────────

describe("hard-stop-severity-table", () => {
  it("covers all expected hard-stop reasons with correct severities", () => {
    expect(HARD_STOP_SEVERITY["captcha"]).toBe("P3");
    expect(HARD_STOP_SEVERITY["payment"]).toBe("P2");
    expect(HARD_STOP_SEVERITY["sold_out"]).toBe("P3");
    expect(HARD_STOP_SEVERITY["login_wall"]).toBe("P3");
    expect(HARD_STOP_SEVERITY["tos_block"]).toBe("P2");
    expect(HARD_STOP_SEVERITY["no_confirmation"]).toBe("P2");
  });
});
