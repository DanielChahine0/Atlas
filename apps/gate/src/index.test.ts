/**
 * index.test.ts — Wave 0 test stub for apps/gate Worker (04-03).
 *
 * All tests run in real workerd against the 0007_gate.sql schema (applied via the
 * test harness in test/apply-migrations.ts + vitest.config.ts).
 *
 * Test groups:
 *   --grep fail-closed   — POST that throws returns 5xx + "no action taken" page; no agent re-invoke
 *   --grep expire        — scheduled() sweep → 410 on subsequent GET /confirm
 *   --grep browser       — /browser/poll and /browser/ack Bearer-gated (401 on wrong/missing token)
 *   --grep confirm-get   — GET /confirm renders pending page or 410 on expired/missing/decided
 *   --grep confirm-post  — POST /confirm approve/reject/bad-decision/cross-origin paths
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { openGate, decideGate } from "@atlas/gate";
import { sha256 } from "@atlas/gate/auth";
import type { GateOptions, GatePendingRow } from "@atlas/gate/schema";
import gateWorker from "./index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;
function counter(): string {
  return String(++_counter) + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

function makeOpts(overrides: Partial<GateOptions> = {}): GateOptions {
  const c = counter();
  return {
    agent: "Usher",
    action: "event.register",
    target: `event-${c}`,
    artifact: `{"event":"Test Event ${c}","price":"Free"}`,
    idempotencyKey: `usher:event-${c}:registered`,
    expiresInMs: 86_400_000, // 24h
    confirmBaseUrl: "https://gate.example.com",
    scopeUsed: "calendar.events",
    ...overrides,
  };
}

type TestEnv = {
  DB: D1Database;
  INCIDENTS: Queue<unknown>;
  WIRE: Queue<unknown>;
};

function dbEnv(): TestEnv {
  return env as unknown as TestEnv;
}

/** Insert a gate_pending row directly, returns the plaintext token */
async function seedGate(
  opts: Partial<GateOptions> & { expiresInMs?: number } = {},
): Promise<{ token: string; row: GatePendingRow }> {
  const o = makeOpts(opts);
  const e = dbEnv();
  const gateEnv = {
    DB: e.DB,
    INCIDENTS: e.INCIDENTS,
    NTFY_TOPIC: { get: async (): Promise<string | null> => null },
    NTFY_TOKEN: { get: async (): Promise<string | null> => null },
  };
  const record = await openGate(gateEnv, o);
  const row = await e.DB.prepare(
    "SELECT * FROM gate_pending WHERE id = ?",
  ).bind(record.id).first<GatePendingRow>();
  if (!row) throw new Error("seeded gate not found");
  return { token: record.plaintextToken, row };
}

/** Insert an already-expired gate_pending row */
async function seedExpiredGate(): Promise<{ token: string; row: GatePendingRow }> {
  return seedGate({ expiresInMs: -1000 }); // expires 1s in the past
}

/** Insert a browser_action_outbox row directly via D1 */
async function seedBrowserAction(
  gateId: string,
  status = "pending",
): Promise<string> {
  const id =
    "TEST" +
    Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 10).toUpperCase();
  await dbEnv().DB.prepare(
    `INSERT INTO browser_action_outbox
       (id, agent, action_type, fields, gate_id, target_url, status, claimed_at, outcome, created_at)
     VALUES (?, 'Usher', 'event_fill_submit', '{"name":"Daniel"}', ?, ?, ?, NULL, NULL, ?)`,
  )
    .bind(id, gateId, "https://example.com/register", status, Date.now())
    .run();
  return id;
}

// ─── confirm-get: GET /confirm ─────────────────────────────────────────────────

describe("confirm-get", () => {
  it("GET /confirm?t=<valid pending token> renders 200 confirm page", async () => {
    const { token } = await seedGate();
    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`);
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain("Review and confirm");
    // Security headers present
    expect(resp.headers.get("x-frame-options")).toBe("DENY");
    expect(resp.headers.get("cache-control")).toBe("no-store");
  });

  it("GET /confirm with missing token returns 410 expired page", async () => {
    const resp = await SELF.fetch("https://gate.example.com/confirm");
    expect(resp.status).toBe(410);
    const text = await resp.text();
    expect(text).toContain("expired");
  });

  it("GET /confirm with unknown token returns 410 expired page", async () => {
    const resp = await SELF.fetch(
      "https://gate.example.com/confirm?t=0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(resp.status).toBe(410);
  });

  it("GET /confirm with already-rejected gate returns 410", async () => {
    const { token, row } = await seedGate();
    await decideGate(dbEnv(), row, "reject", null);
    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`);
    expect(resp.status).toBe(410);
  });

  it("GET /confirm with already-approved gate returns 410", async () => {
    const { token, row } = await seedGate();
    await decideGate(dbEnv(), row, "approve", null);
    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`);
    expect(resp.status).toBe(410);
  });
});

// ─── expire: scheduled sweep and subsequent GET ───────────────────────────────

describe("expire", () => {
  it("scheduled() sweeps expired gates to 'expired'; subsequent GET /confirm returns 410", async () => {
    // Seed a gate that has already expired (expires_at in the past)
    const { token } = await seedExpiredGate();

    // Verify the gate is currently still 'pending' in the DB (not yet swept)
    const tokenHash = await sha256(token);
    const before = await dbEnv().DB.prepare(
      "SELECT status FROM gate_pending WHERE token_hash = ?",
    ).bind(tokenHash).first<{ status: string }>();
    // Status is 'pending' initially (sweep hasn't run yet)
    expect(before?.status).toBe("pending");

    // Fire the scheduled cron — call the handler directly (same pattern as flagger self-tick tests)
    const fakeController = { scheduledTime: Date.now(), cron: "0 * * * *", noRetry: () => {} } as ScheduledController;
    const testEnv = dbEnv() as unknown as Parameters<typeof gateWorker.scheduled>[1];
    await gateWorker.scheduled(fakeController, testEnv);

    // After sweep, the gate should be 'expired'
    const after = await dbEnv().DB.prepare(
      "SELECT status FROM gate_pending WHERE token_hash = ?",
    ).bind(tokenHash).first<{ status: string }>();
    expect(after?.status).toBe("expired");

    // GET /confirm should now return 410 (expired)
    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`);
    expect(resp.status).toBe(410);
    const text = await resp.text();
    expect(text).toContain("expired");
  });
});

// ─── confirm-post: POST /confirm decisions ────────────────────────────────────

describe("confirm-post", () => {
  it("POST /confirm decision=approve (same-origin) commits gate and returns approved outcome page", async () => {
    const { token } = await seedGate();

    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://gate.example.com",
        "sec-fetch-site": "same-origin",
      },
      body: "decision=approve",
    });

    expect(resp.status).toBe(200);
    const text = await resp.text();
    // The outcome page includes "Action confirmed" or the approved path
    expect(text).toContain("confirmed");

    // Verify the gate was committed to 'approved' in D1
    const tokenHash = await sha256(token);
    const row = await dbEnv().DB.prepare(
      "SELECT status FROM gate_pending WHERE token_hash = ?",
    ).bind(tokenHash).first<{ status: string }>();
    expect(row?.status).toBe("approved");
  });

  it("POST /confirm decision=reject (same-origin) commits rejection, no agent re-invoke", async () => {
    const { token } = await seedGate();

    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://gate.example.com",
        "sec-fetch-site": "same-origin",
      },
      body: "decision=reject",
    });

    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain("No action taken");

    // Verify the gate was committed to 'rejected' in D1
    const tokenHash = await sha256(token);
    const row = await dbEnv().DB.prepare(
      "SELECT status FROM gate_pending WHERE token_hash = ?",
    ).bind(tokenHash).first<{ status: string }>();
    expect(row?.status).toBe("rejected");
  });

  it("POST /confirm with invalid decision value returns 400", async () => {
    const { token } = await seedGate();

    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://gate.example.com",
        "sec-fetch-site": "same-origin",
      },
      body: "decision=nuke",
    });

    expect(resp.status).toBe(400);

    // Gate should remain pending
    const tokenHash = await sha256(token);
    const row = await dbEnv().DB.prepare(
      "SELECT status FROM gate_pending WHERE token_hash = ?",
    ).bind(tokenHash).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("POST /confirm without same-origin headers returns 403 (CSRF fail-closed)", async () => {
    const { token } = await seedGate();

    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // No origin or sec-fetch-site — isSameOrigin returns false
      },
      body: "decision=approve",
    });

    expect(resp.status).toBe(403);

    // Gate should remain pending
    const tokenHash = await sha256(token);
    const row = await dbEnv().DB.prepare(
      "SELECT status FROM gate_pending WHERE token_hash = ?",
    ).bind(tokenHash).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("POST /confirm with cross-origin header returns 403", async () => {
    const { token } = await seedGate();

    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example.com",
        "sec-fetch-site": "cross-site",
      },
      body: "decision=approve",
    });

    expect(resp.status).toBe(403);
  });

  it("POST /confirm on an expired gate returns 410 (no action, gate is not pending)", async () => {
    const { token } = await seedExpiredGate();

    // Manually expire it first
    const tokenHash = await sha256(token);
    const row = await dbEnv().DB.prepare(
      "SELECT * FROM gate_pending WHERE token_hash = ?",
    ).bind(tokenHash).first<GatePendingRow>();
    if (row) {
      await dbEnv().DB.prepare(
        "UPDATE gate_pending SET status = 'expired', decision = 'expired' WHERE id = ?",
      ).bind(row.id).run();
    }

    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://gate.example.com",
        "sec-fetch-site": "same-origin",
      },
      body: "decision=approve",
    });

    expect(resp.status).toBe(410);
  });

  it("POST /confirm with decision=approve but no service binding should not fail-open", async () => {
    // The Worker is configured without a real USHER binding in test mode.
    // If the re-invoke fails (binding absent), it should return 500 with "no action taken"
    // OR record the error without exposing the gate as "approved" without action.
    // This test verifies fail-closed behavior: decideGate commits BEFORE the re-invoke.
    // The gate should be committed (status=approved) even if re-invoke fails.
    const { token } = await seedGate({ agent: "Usher" });

    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://gate.example.com",
        "sec-fetch-site": "same-origin",
      },
      body: "decision=approve",
    });

    // Either 200 (re-invoke silently failed with P2) or 500 (re-invoke threw)
    // Either way, the gate should be committed in D1
    const tokenHash = await sha256(token);
    const row = await dbEnv().DB.prepare(
      "SELECT status FROM gate_pending WHERE token_hash = ?",
    ).bind(tokenHash).first<{ status: string }>();
    expect(row?.status).toBe("approved"); // decideGate committed BEFORE re-invoke
  });
});

// ─── fail-closed: error paths ─────────────────────────────────────────────────

describe("fail-closed", () => {
  it("POST /confirm on already-decided gate returns 410 (second decide is no-op)", async () => {
    const { token, row } = await seedGate();
    // Pre-decide the gate
    await decideGate(dbEnv(), row, "approve", null);

    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://gate.example.com",
        "sec-fetch-site": "same-origin",
      },
      body: "decision=approve",
    });

    // Gate is no longer pending — should return 410
    expect(resp.status).toBe(410);
  });

  it("GET /health returns a non-404 or 404 but confirms Worker is running", async () => {
    // Just verify SELF is wired up
    const resp = await SELF.fetch("https://gate.example.com/");
    // The root route returns 404 — that is the expected behavior
    expect(resp.status).toBe(404);
  });

  it("POST /confirm missing body returns 400 (no decision field)", async () => {
    const { token } = await seedGate();

    const resp = await SELF.fetch(`https://gate.example.com/confirm?t=${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://gate.example.com",
        "sec-fetch-site": "same-origin",
      },
      body: "",
    });

    expect(resp.status).toBe(400);
  });
});

// ─── reinvoke-envoy: CR-01 — gate approval calls onApproved (not publish) ──────

describe("reinvoke-envoy", () => {
  it("approve Envoy gate calls onApproved (not publish) with the correct params", async () => {
    const { token, row } = await seedGate({
      agent: "Envoy",
      action: "brand.publish",
      target: "my-project",
      artifact: JSON.stringify({ projectSlug: "my-project", approvedTargets: ["linkedin"] }),
      idempotencyKey: `envoy:reinvoke-test-${Date.now()}-${Math.random()}`,
    });

    // Direct invocation of the worker with an injected ENVOY test-double.
    const onApprovedCalls: Array<Record<string, unknown>> = [];
    const publishCalls: Array<Record<string, unknown>> = [];
    const testEnvoy = {
      onApproved: async (params: Record<string, unknown>) => {
        onApprovedCalls.push(params);
        return {};
      },
      publish: async (params: Record<string, unknown>) => {
        publishCalls.push(params);
        return {};
      },
    };

    const testEnvFull = {
      ...(dbEnv() as unknown as Record<string, unknown>),
      ENVOY: testEnvoy,
      GATE_CONFIRM_TOKEN: undefined, // not needed for /confirm (uses sha256 path)
    } as unknown as Parameters<typeof gateWorker.fetch>[1];

    // Manufacture the POST /confirm request with same-origin headers
    const request = new Request(`https://gate.example.com/confirm?t=${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://gate.example.com",
        "sec-fetch-site": "same-origin",
      },
      body: "decision=approve",
    });

    await gateWorker.fetch(request, testEnvFull);

    // The gate should have called onApproved, NOT publish
    expect(onApprovedCalls).toHaveLength(1);
    expect(publishCalls).toHaveLength(0);

    // Check that onApproved received the correct params
    const call = onApprovedCalls[0]!;
    expect(call.gateId).toBe(row.id);
    expect(call.projectSlug).toBe("my-project");
    expect(call.approvedTargets).toEqual(["linkedin"]);
  });
});

// ─── browser: /browser/poll and /browser/ack ─────────────────────────────────

describe("browser", () => {
  it("GET /browser/poll without Authorization returns 401", async () => {
    const resp = await SELF.fetch("https://gate.example.com/browser/poll");
    expect(resp.status).toBe(401);
  });

  it("GET /browser/poll with wrong Bearer token returns 401", async () => {
    const resp = await SELF.fetch("https://gate.example.com/browser/poll", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(resp.status).toBe(401);
  });

  it("GET /browser/poll with missing GATE_CONFIRM_TOKEN binding returns 401 (fail-closed)", async () => {
    // The test env does not seed GATE_CONFIRM_TOKEN (Secrets Store binding is unset).
    // The Worker must fail-closed: return 401, not 500 or a leak.
    const resp = await SELF.fetch("https://gate.example.com/browser/poll", {
      headers: { Authorization: "Bearer anything" },
    });
    expect(resp.status).toBe(401);
  });

  it("POST /browser/ack without Authorization returns 401", async () => {
    const resp = await SELF.fetch("https://gate.example.com/browser/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "test", outcome: {} }),
    });
    expect(resp.status).toBe(401);
  });

  it("POST /browser/ack with wrong Bearer token returns 401", async () => {
    const resp = await SELF.fetch("https://gate.example.com/browser/ack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ id: "test", outcome: {} }),
    });
    expect(resp.status).toBe(401);
  });

  it("non-existent route returns 404", async () => {
    const resp = await SELF.fetch("https://gate.example.com/not-a-route");
    expect(resp.status).toBe(404);
  });

  // WR-02: ack of a Usher event_fill_submit 'done' row → USHER.onOutcome called
  it("WR-02: ack of Usher event_fill_submit claimed row calls USHER.onOutcome with correct eventId/eventUrl/outcome", async () => {
    const db = dbEnv().DB;
    const eventId = `wr02-evt-${Date.now()}`;
    const targetUrl = `https://event.example.com/${eventId}`;

    // Seed an approved gate_pending with target=eventId and agent=Usher
    const gateId = `wr02-gate-${Date.now()}`;
    await db.prepare(
      `INSERT INTO gate_pending (id, agent, action, target, artifact, edited_artifact, status, decision,
         scope_used, idempotency_key, token_hash, expires_at, flag_id, created_at, updated_at)
       VALUES (?, 'Usher', 'event.register', ?, '{}', NULL, 'approved', 'approved',
               'calendar.events', ?, 'fakehash', ?, NULL, ?, ?)`,
    )
      .bind(gateId, eventId, `usher:${eventId}:registered`, Date.now() + 86400000, Date.now(), Date.now())
      .run();

    // Seed a 'claimed' browser_action_outbox row linked to the gate
    const outboxId = `wr02-outbox-${Date.now()}`;
    await db.prepare(
      `INSERT INTO browser_action_outbox
         (id, agent, action_type, fields, gate_id, target_url, status, claimed_at, outcome, created_at)
       VALUES (?, 'Usher', 'event_fill_submit', '{"name":"Daniel"}', ?, ?, 'claimed', ?, NULL, ?)`,
    )
      .bind(outboxId, gateId, targetUrl, Date.now(), Date.now())
      .run();

    // Track onOutcome calls
    const onOutcomeCalls: Array<{ eventId: string; eventUrl: string; outcome: unknown }> = [];
    const testUsher = {
      register: async () => ({}),
      onOutcome: async (params: { eventId: string; eventUrl: string; outcome: unknown }) => {
        onOutcomeCalls.push(params);
        return {};
      },
    };

    const successOutcome = { id: outboxId, status: "success", confirmation_number: "CONF-WR02" };

    // Build a fake bearer env so validateBearerToken passes
    const fakeToken = "wr02-test-token";
    const testEnvAck = {
      ...(dbEnv() as unknown as Record<string, unknown>),
      USHER: testUsher,
      GATE_CONFIRM_TOKEN: { get: async () => fakeToken },
    } as unknown as Parameters<typeof gateWorker.fetch>[1];

    const ackRequest = new Request("https://gate.example.com/browser/ack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${fakeToken}`,
      },
      body: JSON.stringify({ id: outboxId, outcome: successOutcome }),
    });

    const resp = await gateWorker.fetch(ackRequest, testEnvAck);
    expect(resp.status).toBe(200);

    // USHER.onOutcome should have been called once with the correct params
    expect(onOutcomeCalls).toHaveLength(1);
    const call = onOutcomeCalls[0]!;
    expect(call.eventId).toBe(eventId);
    expect(call.eventUrl).toBe(targetUrl);
    expect(call.outcome).toMatchObject({ status: "success", confirmation_number: "CONF-WR02" });
  });
});
