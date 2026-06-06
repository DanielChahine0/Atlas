// apps/echo/test/ws-route.test.ts
//
// CAPTURE-01: /echo/ws route guard — the cloud entry the OUTBOUND capture daemon uses
// to open its per-meeting EchoSession WebSocket. The DO must NEVER be reachable without
// a valid capture token, so the route authenticates BEFORE forwarding the upgrade.
//
// These tests exercise the security-critical GATING paths (401 / 400 / 426) that return
// before any DO forward — the live 101 upgrade is covered by echo-session.test.ts (DO
// fetch directly). Auth is verified server-side against the (mocked) ECHO_CAPTURE_TOKEN;
// no client header grants access.

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";

const VALID_CAPTURE_TOKEN = "test-capture-token";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    ECHO_CAPTURE_TOKEN: { get: vi.fn().mockResolvedValue(VALID_CAPTURE_TOKEN) },
    ...overrides,
  } as unknown as Env;
}

function wsRequest(
  opts: { token?: string; noAuth?: boolean; sessionId?: string | null } = {},
): Request {
  const headers: Record<string, string> = {};
  if (!opts.noAuth) headers["Authorization"] = `Bearer ${opts.token ?? VALID_CAPTURE_TOKEN}`;
  const sid = opts.sessionId === undefined ? "echo-2026-06-06T14-00-00" : opts.sessionId;
  const url =
    sid === null
      ? "https://echo.example.com/echo/ws"
      : `https://echo.example.com/echo/ws?session_id=${encodeURIComponent(sid)}`;
  return new Request(url, { method: "GET", headers });
}

describe("/echo/ws route guard", () => {
  it("missing bearer → 401 (DO never reached)", async () => {
    const resp = await worker.fetch(wsRequest({ noAuth: true }), makeEnv(), {} as ExecutionContext);
    expect(resp.status).toBe(401);
  });

  it("wrong capture token → 401 (constant-time verify, no client-trusted identity)", async () => {
    const resp = await worker.fetch(
      wsRequest({ token: "not-the-real-token" }),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(401);
  });

  it("valid token but missing session_id → 400 (no arbitrary DO addressing)", async () => {
    const resp = await worker.fetch(wsRequest({ sessionId: null }), makeEnv(), {} as ExecutionContext);
    expect(resp.status).toBe(400);
  });

  it("valid token but malformed session_id (UUID / injection) → 400", async () => {
    const resp = await worker.fetch(
      wsRequest({ sessionId: "../../admin" }),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(resp.status).toBe(400);
  });

  it("valid token + valid session_id but not a WebSocket upgrade → 426", async () => {
    // No Upgrade header — a plain HTTP request must not be forwarded to the DO.
    const resp = await worker.fetch(wsRequest(), makeEnv(), {} as ExecutionContext);
    expect(resp.status).toBe(426);
  });
});
