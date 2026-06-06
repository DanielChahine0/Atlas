/**
 * ack-auth.test.ts — Token-gated /ack inbound route tests (WEEKLY-02, Plan 02-02 Task 3).
 *
 * T-02-ack (Threat Register): The /ack endpoint is the ONLY inbound surface in Phase 2.
 * An unauthorized caller could flip a flag's status (from open to ack), masking an ongoing incident.
 *
 * Verifies:
 * - POST /ack with no Authorization header → 401, FlaggerState.ackFlag NOT called
 * - POST /ack with a wrong Bearer token → 401, ackFlag NOT called
 * - POST /ack with the correct Bearer token → 200 and ackFlag(id) called once
 * - Missing ACK_TOKEN binding (not seeded) → 401 (fail-closed)
 * - Any non-/ack path or non-POST → 404
 *
 * Security invariant: constant-time compare (HMAC-SHA-256, not ===); fail-closed on missing binding.
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/index.js";
import type { RawIncident } from "@atlas/shared";
import flaggerDefault from "../src/index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const CORRECT_TOKEN = "test-secret-ack-token-xyz789";

/** Build a test env with a configurable ACK_TOKEN binding and spied FlaggerState. */
function makeAuthEnv(opts: { tokenSeeded?: boolean; token?: string } = {}) {
  const ackCalls: string[] = [];

  // Spy on FlaggerState.ackFlag via RPC stub
  const ackFlag = vi.fn(async (id: string) => {
    ackCalls.push(id);
  });

  const e: Env = {
    ...(env as unknown as Env),
    WIRE: {
      send: vi.fn(async () => {}),
    } as unknown as Queue<unknown>,
    INCIDENTS: {
      send: vi.fn(async () => {}),
    } as unknown as Queue<RawIncident>,
    CONFIG: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
    } as unknown as KVNamespace,
    // ACK_TOKEN: either seeded with a value or absent (undefined get())
    ACK_TOKEN: opts.tokenSeeded !== false
      ? { get: vi.fn(async () => opts.token ?? CORRECT_TOKEN) }
      : { get: vi.fn(async () => null) },
    // NTFY_TOPIC/NTFY_TOKEN not needed for ack route tests
    NTFY_TOPIC: { get: vi.fn(async () => null) },
    NTFY_TOKEN: { get: vi.fn(async () => null) },
    // Override FlaggerState to spy on ackFlag
    FLAGGER_STATE: {
      getByName: vi.fn(() => ({
        ackFlag,
        upsertFlag: vi.fn(async () => ({})),
        getBySignature: vi.fn(async () => null),
      })),
    } as unknown as DurableObjectNamespace,
  } as unknown as Env;

  return { env: e, ackFlag, ackCalls };
}

/** Build a POST /ack request with an optional Authorization header. */
function ackRequest(opts: {
  authorization?: string;
  id?: string;
  method?: string;
  path?: string;
} = {}) {
  const url = `https://flagger.workers.dev${opts.path ?? "/ack"}`;
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authorization !== undefined) {
    headers["Authorization"] = opts.authorization;
  }
  return new Request(url, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify({ id: opts.id ?? "flg:2026-06-05:Forge:abc123" }) : undefined,
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("Flagger fetch() — /ack token-gated inbound route (T-02-ack)", () => {
  it("POST /ack with no Authorization header → 401, ackFlag NOT called", async () => {
    const { env: e, ackFlag } = makeAuthEnv();
    const req = ackRequest({ authorization: undefined });

    const resp = await flaggerDefault.fetch(req, e);

    expect(resp.status).toBe(401);
    expect(ackFlag).not.toHaveBeenCalled();
  });

  it("POST /ack with a wrong Bearer token → 401, ackFlag NOT called", async () => {
    const { env: e, ackFlag } = makeAuthEnv();
    const req = ackRequest({ authorization: "Bearer wrong-token-bad-value" });

    const resp = await flaggerDefault.fetch(req, e);

    expect(resp.status).toBe(401);
    expect(ackFlag).not.toHaveBeenCalled();
  });

  it("POST /ack with correct Bearer token → 200, ackFlag(id) called exactly once", async () => {
    const { env: e, ackFlag, ackCalls } = makeAuthEnv();
    const flagId = "flg:2026-06-05:Forge:test123";
    const req = ackRequest({
      authorization: `Bearer ${CORRECT_TOKEN}`,
      id: flagId,
    });

    const resp = await flaggerDefault.fetch(req, e);

    expect(resp.status).toBe(200);
    expect(ackFlag).toHaveBeenCalledTimes(1);
    expect(ackCalls[0]).toBe(flagId);
  });

  it("missing ACK_TOKEN binding (not seeded) → 401, fail-closed", async () => {
    const { env: e, ackFlag } = makeAuthEnv({ tokenSeeded: false });
    const req = ackRequest({ authorization: `Bearer ${CORRECT_TOKEN}` });

    const resp = await flaggerDefault.fetch(req, e);

    // fail-closed: no token configured → 401 regardless of what was presented
    expect(resp.status).toBe(401);
    expect(ackFlag).not.toHaveBeenCalled();
  });

  it("GET /ack → 404 (only POST accepted)", async () => {
    const { env: e } = makeAuthEnv();
    const req = ackRequest({ method: "GET", authorization: `Bearer ${CORRECT_TOKEN}` });

    const resp = await flaggerDefault.fetch(req, e);

    expect(resp.status).toBe(404);
  });

  it("POST /other-path → 404 (only /ack accepted)", async () => {
    const { env: e } = makeAuthEnv();
    const req = ackRequest({ path: "/status", authorization: `Bearer ${CORRECT_TOKEN}` });

    const resp = await flaggerDefault.fetch(req, e);

    expect(resp.status).toBe(404);
  });

  it("POST /ack with empty Authorization header → 401", async () => {
    const { env: e, ackFlag } = makeAuthEnv();
    const req = ackRequest({ authorization: "" });

    const resp = await flaggerDefault.fetch(req, e);

    expect(resp.status).toBe(401);
    expect(ackFlag).not.toHaveBeenCalled();
  });

  it("POST /ack — timing safe: wrong token of different length → 401 (no timing leak)", async () => {
    const { env: e, ackFlag } = makeAuthEnv();
    // Very short token vs the long correct token — HMAC-based compare is length-independent
    const req = ackRequest({ authorization: "Bearer x" });

    const resp = await flaggerDefault.fetch(req, e);

    expect(resp.status).toBe(401);
    expect(ackFlag).not.toHaveBeenCalled();
  });

  // L2 gap-closure: malformed / empty JSON body with a valid token → 400 (not unhandled 500)
  it("L2: POST /ack with valid token but malformed JSON body → 400 (not 500)", async () => {
    const { env: e, ackFlag } = makeAuthEnv();
    const url = "https://flagger.workers.dev/ack";
    const req = new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CORRECT_TOKEN}`,
      },
      body: "not-valid-json{{{",
    });

    const resp = await flaggerDefault.fetch(req, e);

    // L2 fix: must return 400 (not throw / 500)
    expect(resp.status).toBe(400);
    // ackFlag must NOT be called (bad request rejected before DO access)
    expect(ackFlag).not.toHaveBeenCalled();
  });

  it("L2: POST /ack with valid token but empty body → 400", async () => {
    const { env: e, ackFlag } = makeAuthEnv();
    const url = "https://flagger.workers.dev/ack";
    const req = new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CORRECT_TOKEN}`,
      },
      body: "{}",
    });

    const resp = await flaggerDefault.fetch(req, e);

    // Empty body: `id` is missing (undefined), should be rejected with 400
    expect(resp.status).toBe(400);
    expect(ackFlag).not.toHaveBeenCalled();
  });
});
