/**
 * index.test.ts — Integration tests for the gate lifecycle (Task 3).
 *
 * All tests run in real workerd against the 0007_gate.sql schema (applied via the
 * test harness in test/apply-migrations.ts + vitest.config.ts).
 *
 * Test groups:
 *   --grep audit-log  — dual audit_log rows per gated action (pending + terminal)
 *   --grep expire     — sweepExpired transitions pending rows to 'expired'
 *   --grep fail-closed — decideGate throws on D1 failure; double-decide is a no-op
 *   --grep race       — approve-vs-expire mutual exclusion + sweep idempotency
 *   --grep push       — openGate ntfy send, failure, and unseeded NTFY_TOPIC paths
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { openGate, getGate, decideGate, sweepExpired } from "./index.js";
import { sha256 } from "./auth.js";
import type { GateOptions, GatePendingRow } from "./schema.js";

// ─── Env surfaces ─────────────────────────────────────────────────────────────

function makeOpenEnv(overrides: {
  ntfyTopic?: string | null;
  ntfyToken?: string | null;
} = {}): {
  DB: D1Database;
  INCIDENTS: Queue<unknown>;
  NTFY_TOPIC: { get(): Promise<string | null> };
  NTFY_TOKEN: { get(): Promise<string | null> };
} {
  const testEnv = env as unknown as { DB: D1Database; INCIDENTS: Queue<unknown> };
  return {
    DB: testEnv.DB,
    INCIDENTS: testEnv.INCIDENTS,
    NTFY_TOPIC: { get: async () => overrides.ntfyTopic ?? null },
    NTFY_TOKEN: { get: async () => overrides.ntfyToken ?? null },
  };
}

function makeDecideEnv(): { DB: D1Database; INCIDENTS: Queue<unknown> } {
  return env as unknown as { DB: D1Database; INCIDENTS: Queue<unknown> };
}

function makeCaptureEnv(): {
  db: D1Database;
  incidents: Array<{ severity_hint: string; kind: string }>;
  env: { DB: D1Database; INCIDENTS: Queue<unknown> };
} {
  const db = (env as unknown as { DB: D1Database }).DB;
  const incidents: Array<{ severity_hint: string; kind: string }> = [];
  return {
    db,
    incidents,
    env: {
      DB: db,
      INCIDENTS: {
        send: async (msg: unknown) => {
          incidents.push(msg as { severity_hint: string; kind: string });
        },
      } as unknown as Queue<unknown>,
    },
  };
}

// ─── Base gate options ────────────────────────────────────────────────────────

let _counter = 0;
function makeOpts(overrides: Partial<GateOptions> = {}): GateOptions {
  _counter++;
  return {
    agent: "Usher",
    action: "event.register",
    target: `test-target-${_counter}-${Date.now()}`,
    artifact: '{"event":"MLconf 2026","price":"Free"}',
    idempotencyKey: `usher:test:${_counter}:${Date.now()}:${Math.random()}`,
    expiresInMs: 86_400_000,
    confirmBaseUrl: "https://gate.example.com",
    scopeUsed: "calendar.events",
    ...overrides,
  };
}

// ─── Audit log query helpers ──────────────────────────────────────────────────

async function getAuditRows(
  db: D1Database,
  target: string,
): Promise<Array<{ id: string; decision: string; outcome: string; gated: number; agent: string }>> {
  const result = await db
    .prepare("SELECT * FROM audit_log WHERE target = ? AND gated = 1 ORDER BY ts ASC")
    .bind(target)
    .all<{ id: string; decision: string; outcome: string; gated: number; agent: string }>();
  return result.results;
}

async function getGateByIdRow(
  db: D1Database,
  id: string,
): Promise<{ id: string; status: string; decision: string; token_hash: string } | null> {
  return db
    .prepare("SELECT * FROM gate_pending WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string; decision: string; token_hash: string }>();
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── TEST: audit-log ─────────────────────────────────────────────────────────

describe("audit-log — dual audit rows per gated action", () => {
  it("openGate writes exactly ONE pending audit_log row", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const target = `audit-open-${Date.now()}`;
    await openGate(makeOpenEnv(), makeOpts({ target }));

    const rows = await getAuditRows(db, target);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("pending");
    expect(rows[0]?.outcome).toBe("pending");
    expect(rows[0]?.gated).toBe(1);
  });

  it("decideGate(approve) writes TWO audit rows total: pending + approved", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const target = `audit-approve-${Date.now()}`;
    const record = await openGate(makeOpenEnv(), makeOpts({ target }));
    const tokenHash = await sha256(record.plaintextToken);
    const row = await getGate({ DB: db }, tokenHash);
    expect(row).not.toBeNull();
    await decideGate(makeDecideEnv(), row!, "approve", null);

    const rows = await getAuditRows(db, target);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.decision).toBe("pending");
    expect(rows[1]?.decision).toBe("approved");
    expect(rows[1]?.outcome).toBe("ok");
  });

  it("decideGate(reject) writes TWO audit rows total: pending + rejected", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const target = `audit-reject-${Date.now()}`;
    const record = await openGate(makeOpenEnv(), makeOpts({ target }));
    const tokenHash = await sha256(record.plaintextToken);
    const row = await getGate({ DB: db }, tokenHash);
    expect(row).not.toBeNull();
    await decideGate(makeDecideEnv(), row!, "reject", null);

    const rows = await getAuditRows(db, target);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.decision).toBe("pending");
    expect(rows[1]?.decision).toBe("rejected");
  });

  it("both audit rows share the same target and agent", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const target = `audit-shared-${Date.now()}`;
    const record = await openGate(makeOpenEnv(), makeOpts({ target, agent: "Envoy" }));
    const tokenHash = await sha256(record.plaintextToken);
    const row = await getGate({ DB: db }, tokenHash);
    await decideGate(makeDecideEnv(), row!, "approve", null);

    const rows = await getAuditRows(db, target);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.agent).toBe("Envoy");
    expect(rows[1]?.agent).toBe("Envoy");
  });
});

// ─── TEST: expire ─────────────────────────────────────────────────────────────

describe("expire — sweepExpired transitions pending rows past expires_at", () => {
  it("sweepExpired transitions a past-due pending gate to 'expired' and returns count=1", async () => {
    const { db, incidents, env: cEnv } = makeCaptureEnv();
    const target = `expire-basic-${Date.now()}`;
    await openGate({ ...makeOpenEnv(), ...cEnv }, makeOpts({ target, expiresInMs: -1 }));

    const count = await sweepExpired(cEnv);
    expect(count).toBeGreaterThanOrEqual(1);

    const auditRows = await getAuditRows(db, target);
    expect(auditRows).toHaveLength(2);
    expect(auditRows[1]?.decision).toBe("expired");
    expect(auditRows[1]?.outcome).toBe("ok");
  });

  it("sweepExpired transitions the gate_pending status to 'expired'", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const target = `expire-status-${Date.now()}`;
    const record = await openGate(makeOpenEnv(), makeOpts({ target, expiresInMs: -1 }));

    await sweepExpired(makeDecideEnv());

    const gateRow = await db
      .prepare("SELECT status, decision FROM gate_pending WHERE id = ?")
      .bind(record.id)
      .first<{ status: string; decision: string }>();
    expect(gateRow?.status).toBe("expired");
    expect(gateRow?.decision).toBe("expired");
  });

  it("sweepExpired emits a P3 gate_expired flag onto INCIDENTS", async () => {
    const { incidents, env: cEnv } = makeCaptureEnv();
    const target = `expire-flag-${Date.now()}`;
    await openGate({ ...makeOpenEnv(), ...cEnv }, makeOpts({ target, expiresInMs: -1 }));

    await sweepExpired(cEnv);

    const p3 = incidents.filter((i) => i.severity_hint === "P3" && i.kind === "gate_expired");
    expect(p3.length).toBeGreaterThanOrEqual(1);
  });

  it("sweepExpired does NOT touch gates with future expires_at", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const target = `expire-future-${Date.now()}`;
    const record = await openGate(makeOpenEnv(), makeOpts({ target, expiresInMs: 86_400_000 }));

    await sweepExpired(makeDecideEnv());

    const gateRow = await db
      .prepare("SELECT status FROM gate_pending WHERE id = ?")
      .bind(record.id)
      .first<{ status: string }>();
    expect(gateRow?.status).toBe("pending"); // untouched
  });
});

// ─── TEST: fail-closed ────────────────────────────────────────────────────────

describe("fail-closed — decideGate rethrows on error; double-decide is no-op", () => {
  it("double-decide: second decideGate call is a no-op (no second terminal audit row)", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const target = `double-decide-${Date.now()}`;
    const record = await openGate(makeOpenEnv(), makeOpts({ target }));
    const tokenHash = await sha256(record.plaintextToken);
    const row = await getGate({ DB: db }, tokenHash);
    expect(row).not.toBeNull();

    // First decide
    await decideGate(makeDecideEnv(), row!, "approve", null);
    const rowsAfterFirst = await getAuditRows(db, target);
    expect(rowsAfterFirst).toHaveLength(2); // pending + approved

    // Second decide (same row, now status='approved')
    await decideGate(makeDecideEnv(), row!, "reject", null); // no-op

    const rowsAfterSecond = await getAuditRows(db, target);
    expect(rowsAfterSecond).toHaveLength(2); // still 2, no third audit row
    expect(rowsAfterSecond[1]?.decision).toBe("approved"); // original decision unchanged
  });

  it("gate status stays 'approved' after a second decideGate call", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const target = `double-decide-status-${Date.now()}`;
    const record = await openGate(makeOpenEnv(), makeOpts({ target }));
    const tokenHash = await sha256(record.plaintextToken);
    const row = await getGate({ DB: db }, tokenHash);

    await decideGate(makeDecideEnv(), row!, "approve", null);
    await decideGate(makeDecideEnv(), row!, "reject", null); // no-op

    const gateRow = await getGateByIdRow(db, record.id);
    expect(gateRow?.status).toBe("approved");
    expect(gateRow?.decision).toBe("approved");
  });

  it("WR-03: decideGate returns true on a real transition, false on already-decided (no-op)", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const target = `wr03-bool-${Date.now()}`;
    const record = await openGate(makeOpenEnv(), makeOpts({ target }));
    const tokenHash = await sha256(record.plaintextToken);
    const row = await getGate({ DB: db }, tokenHash);
    expect(row).not.toBeNull();

    // First decide: should return true (status transitioned pending → approved)
    const firstResult = await decideGate(makeDecideEnv(), row!, "approve", null);
    expect(firstResult).toBe(true);

    // Second decide on the same row (now status='approved'): should return false (no-op)
    const secondResult = await decideGate(makeDecideEnv(), row!, "reject", null);
    expect(secondResult).toBe(false);

    // Gate remains 'approved' (second decide was a no-op)
    const gateRow = await getGateByIdRow(db, record.id);
    expect(gateRow?.status).toBe("approved");
  });

  it("decideGate rethrows when the D1 statement throws (fail-closed)", async () => {
    const badEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => { throw new Error("simulated D1 error"); },
          }),
        }),
      } as unknown as D1Database,
      INCIDENTS: (env as unknown as { INCIDENTS: Queue<unknown> }).INCIDENTS,
    };

    const fakeRow: GatePendingRow = {
      id: "fake-id-fail-closed",
      agent: "Usher",
      action: "event.register",
      target: "fail-closed-target",
      artifact: "{}",
      edited_artifact: null,
      status: "pending",
      decision: "pending",
      scope_used: "calendar.events",
      idempotency_key: "fake-idem",
      token_hash: "fake-hash",
      expires_at: Date.now() + 86400000,
      flag_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    await expect(decideGate(badEnv, fakeRow, "approve", null)).rejects.toThrow(
      "simulated D1 error",
    );
  });
});

// ─── TEST: race ───────────────────────────────────────────────────────────────

describe("race — approve-vs-expire mutual exclusion + sweep idempotency", () => {
  it("(i) approved gate stays 'approved' after sweepExpired; exactly ONE terminal audit row", async () => {
    const { db, incidents, env: cEnv } = makeCaptureEnv();
    const target = `race-approve-sweep-${Date.now()}`;

    // Gate past deadline (expiresInMs=-1) — simulates the race window
    const record = await openGate({ ...makeOpenEnv(), ...cEnv }, makeOpts({ target, expiresInMs: -1 }));
    const tokenHash = await sha256(record.plaintextToken);
    const row = await getGate({ DB: db }, tokenHash);

    // Approve BEFORE sweep
    await decideGate(cEnv, row!, "approve", null);

    const gateBeforeSweep = await db
      .prepare("SELECT status FROM gate_pending WHERE id = ?")
      .bind(record.id)
      .first<{ status: string }>();
    expect(gateBeforeSweep?.status).toBe("approved");

    const incidentsBefore = incidents.length;

    // Run sweep — should skip this gate (status='approved', not 'pending')
    await sweepExpired(cEnv);

    // Gate must still be 'approved', not 'expired'
    const gateAfterSweep = await db
      .prepare("SELECT status FROM gate_pending WHERE id = ?")
      .bind(record.id)
      .first<{ status: string }>();
    expect(gateAfterSweep?.status).toBe("approved"); // NOT 'expired'

    // Exactly ONE terminal audit row (approved), not two
    const auditRows = await getAuditRows(db, target);
    const terminalRows = auditRows.filter((r) => r.decision !== "pending");
    expect(terminalRows).toHaveLength(1);
    expect(terminalRows[0]?.decision).toBe("approved");

    // No P3 gate_expired flag emitted for this gate's target
    const newIncidents = incidents.slice(incidentsBefore);
    const p3 = newIncidents.filter((i) => i.severity_hint === "P3" && i.kind === "gate_expired");
    expect(p3.length).toBe(0);
  });

  it("(ii) sweepExpired is idempotent: second sweep transitions 0 rows; no second audit row or P3", async () => {
    const { db, incidents, env: cEnv } = makeCaptureEnv();
    const target = `race-idempotent-${Date.now()}`;

    await openGate({ ...makeOpenEnv(), ...cEnv }, makeOpts({ target, expiresInMs: -1 }));

    // First sweep: transitions 1 row
    const count1 = await sweepExpired(cEnv);
    expect(count1).toBeGreaterThanOrEqual(1);

    const auditAfterFirst = await getAuditRows(db, target);
    expect(auditAfterFirst).toHaveLength(2); // pending + expired
    const p3CountAfterFirst = incidents.filter(
      (i) => i.severity_hint === "P3" && i.kind === "gate_expired",
    ).length;

    // Second sweep: gate is now status='expired', UPDATE matches 0 rows
    const incidentsLenBefore2nd = incidents.length;
    await sweepExpired(cEnv);

    const auditAfterSecond = await getAuditRows(db, target);
    expect(auditAfterSecond).toHaveLength(2); // still exactly 2, no third row

    // No new P3 from the second sweep
    const newP3 = incidents
      .slice(incidentsLenBefore2nd)
      .filter((i) => i.severity_hint === "P3" && i.kind === "gate_expired");
    expect(newP3.length).toBe(0);

    // Suppress unused warning
    expect(p3CountAfterFirst).toBeGreaterThanOrEqual(1); // at least 1 P3 from first sweep
  });

  it("approved gate has exactly ONE terminal audit row after sweep (no double-terminal-state)", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const target = `race-single-terminal-${Date.now()}`;
    const record = await openGate(makeOpenEnv(), makeOpts({ target, expiresInMs: -1 }));
    const tokenHash = await sha256(record.plaintextToken);
    const row = await getGate({ DB: db }, tokenHash);

    await decideGate(makeDecideEnv(), row!, "approve", null);
    await sweepExpired(makeDecideEnv()); // no-op for this gate

    const auditRows = await getAuditRows(db, target);
    const terminalRows = auditRows.filter((r) => r.decision !== "pending");
    expect(terminalRows).toHaveLength(1);
    expect(terminalRows[0]?.decision).toBe("approved");
  });
});

// ─── TEST: push ───────────────────────────────────────────────────────────────

describe("push — openGate ntfy send paths", () => {
  it("(a) openGate fetch()es ntfy exactly once with the correct URL and confirm link in body", async () => {
    const fetchCalls: Array<{ url: string; body: string }> = [];
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, body: String(init?.body ?? "") });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const opts = makeOpts({ target: "push-send-test" });
    const record = await openGate(
      makeOpenEnv({ ntfyTopic: "atlas-confirms", ntfyToken: "test-ntfy-token" }),
      opts,
    );

    // fetch() called exactly once
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = fetchCalls[0]!;
    expect(call.url).toBe("https://ntfy.sh/");

    // Body carries `topic` and a confirm-link action
    const body = JSON.parse(call.body) as {
      topic: string;
      actions: Array<{ url: string }>;
    };
    expect(body.topic).toBe("atlas-confirms");

    const actionUrl = body.actions?.[0]?.url;
    expect(actionUrl).toBe(`${opts.confirmBaseUrl}/confirm?t=${record.plaintextToken}`);

    // plaintextToken is non-empty (freshly written row)
    expect(record.plaintextToken).toBeTruthy();
    expect(record.plaintextToken.length).toBe(64); // 32-byte hex
  });

  it("(b-throw) push throws: openGate does NOT throw, returns GateRecord, P2 emitted", async () => {
    const { db, incidents, env: cEnv } = makeCaptureEnv();
    const mockFetch = vi.fn(async () => { throw new Error("network failure"); });
    vi.stubGlobal("fetch", mockFetch);

    const openEnv = {
      ...cEnv,
      NTFY_TOPIC: { get: async () => "atlas-confirms" as string | null },
      NTFY_TOKEN: { get: async () => "test-token" as string | null },
    };

    const opts = makeOpts({ target: "push-throw-test" });

    // openGate must NOT throw
    const record = await openGate(openEnv, opts);

    expect(record).toBeDefined();
    expect(record.id).toBeTruthy();
    expect(record.status).toBe("pending");

    // Gate row persists in D1
    const gateRow = await getGateByIdRow(db, record.id);
    expect(gateRow).not.toBeNull();
    expect(gateRow?.status).toBe("pending");

    // P2 gate_push_failed emitted
    const p2 = incidents.filter((i) => i.severity_hint === "P2" && i.kind === "gate_push_failed");
    expect(p2.length).toBeGreaterThanOrEqual(1);
  });

  it("(b-nonok) push returns non-ok: openGate does NOT throw, returns GateRecord, P2 emitted", async () => {
    const { db, incidents, env: cEnv } = makeCaptureEnv();
    const mockFetch = vi.fn(async () => new Response("Service Unavailable", { status: 503 }));
    vi.stubGlobal("fetch", mockFetch);

    const openEnv = {
      ...cEnv,
      NTFY_TOPIC: { get: async () => "atlas-confirms" as string | null },
      NTFY_TOKEN: { get: async () => "test-token" as string | null },
    };

    const opts = makeOpts({ target: "push-nonok-test" });
    const record = await openGate(openEnv, opts);

    expect(record.id).toBeTruthy();

    const gateRow = await getGateByIdRow(db, record.id);
    expect(gateRow).not.toBeNull();

    const p2 = incidents.filter((i) => i.severity_hint === "P2" && i.kind === "gate_push_failed");
    expect(p2.length).toBeGreaterThanOrEqual(1);
  });

  it("(c) unseeded NTFY_TOPIC: no fetch call, gate row still written, no P2 flag", async () => {
    const { db, incidents, env: cEnv } = makeCaptureEnv();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const openEnv = {
      ...cEnv,
      NTFY_TOPIC: { get: async () => null as string | null },
      NTFY_TOKEN: { get: async () => null as string | null },
    };

    const opts = makeOpts({ target: "push-unseeded-test" });
    const record = await openGate(openEnv, opts);

    // fetch() must NOT be called when NTFY_TOPIC is null
    expect(fetchSpy).not.toHaveBeenCalled();

    // Gate row must still exist
    const gateRow = await getGateByIdRow(db, record.id);
    expect(gateRow).not.toBeNull();
    expect(gateRow?.status).toBe("pending");

    // No P2 gate_push_failed
    const p2 = incidents.filter((i) => i.severity_hint === "P2" && i.kind === "gate_push_failed");
    expect(p2.length).toBe(0);
  });

  it("duplicate openGate (same idempotencyKey) does NOT send a second push", async () => {
    const fetchCalls: string[] = [];
    const mockFetch = vi.fn(async (url: string) => {
      fetchCalls.push(url);
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const idem = `dedup-push-${Date.now()}-${Math.random()}`;
    const opts = makeOpts({ idempotencyKey: idem });

    await openGate(makeOpenEnv({ ntfyTopic: "atlas-confirms" }), opts);
    const countAfterFirst = fetchCalls.length;

    await openGate(makeOpenEnv({ ntfyTopic: "atlas-confirms" }), opts);
    const countAfterSecond = fetchCalls.length;

    expect(countAfterSecond).toBe(countAfterFirst); // no second push
  });
});

// ─── Supplemental: openGate basics ───────────────────────────────────────────

describe("openGate / getGate — basic lifecycle", () => {
  it("returns a GateRecord with a 64-char plaintextToken", async () => {
    const record = await openGate(makeOpenEnv(), makeOpts());
    expect(record.id).toBeTruthy();
    expect(record.status).toBe("pending");
    expect(record.plaintextToken).toHaveLength(64);
  });

  it("stores the SHA-256 token_hash, not the plaintext token", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const record = await openGate(makeOpenEnv(), makeOpts());
    const expectedHash = await sha256(record.plaintextToken);
    const gateRow = await db
      .prepare("SELECT token_hash FROM gate_pending WHERE id = ?")
      .bind(record.id)
      .first<{ token_hash: string }>();
    expect(gateRow?.token_hash).toBe(expectedHash);
    expect(gateRow?.token_hash).not.toBe(record.plaintextToken);
  });

  it("getGate returns the pending row by token_hash", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const record = await openGate(makeOpenEnv(), makeOpts());
    const tokenHash = await sha256(record.plaintextToken);
    const row = await getGate({ DB: db }, tokenHash);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(record.id);
    expect(row?.status).toBe("pending");
  });

  it("getGate returns null for a wrong token hash", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    await openGate(makeOpenEnv(), makeOpts());
    const row = await getGate({ DB: db }, "wrong-hash-value");
    expect(row).toBeNull();
  });

  it("duplicate openGate with same idempotencyKey returns existing gate (exactly 1 row in D1)", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const idem = `dedup-${Date.now()}-${Math.random()}`;
    const opts = makeOpts({ idempotencyKey: idem });

    await openGate(makeOpenEnv(), opts);
    const countBefore = await db
      .prepare("SELECT COUNT(*) as cnt FROM gate_pending WHERE idempotency_key = ?")
      .bind(idem)
      .first<{ cnt: number }>();

    await openGate(makeOpenEnv(), opts);
    const countAfter = await db
      .prepare("SELECT COUNT(*) as cnt FROM gate_pending WHERE idempotency_key = ?")
      .bind(idem)
      .first<{ cnt: number }>();

    expect(countBefore?.cnt).toBe(1);
    expect(countAfter?.cnt).toBe(1); // not 2
  });
});
