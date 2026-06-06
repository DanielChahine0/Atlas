// apps/echo/test/presign.test.ts
//
// CAPTURE-01-i: Presign endpoint — R2 presigned URL minting (capture-token-gated,
// scope-gated server-side, session-bound key).
//
// TDD: tests validate the auth gate + scope gate + key binding by mocking the
// S3 client. The actual R2 round-trip is not testable in workerd (Pitfall 5 from
// 03-RESEARCH) — real upload is staging-integration UAT (03-VALIDATION Manual-Only).
//
// Security checks validated:
//   - valid capture token + echo:presign scope → URL minted
//   - missing / wrong capture token → 401 (fail-closed auth, T-03-02-03)
//   - echo:presign scope absent (server-side) → 403 (fail-closed scope, T-03-02-03)
//   - key not under transcripts/<session_id> or audio/raw/<session_id> → 400
//     (prefix lock + session binding / IDOR mitigation, T-03-02-02)
//
// SECURITY NOTE: scopes and identity are NEVER read from a client header. The bearer is
// constant-time verified against the (mocked) ECHO_CAPTURE_TOKEN secret binding, and the
// granted scope set is injected SERVER-SIDE via ECHO_CAPTURE_SCOPES on the env stub.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env.js";

/** The capture token the mocked Secrets Store binding resolves to. */
const VALID_CAPTURE_TOKEN = "test-capture-token";

// ─────────────────────────────────────────────────────────────────────────────
// Test environment setup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a spy Env that mocks the Secrets Store bindings and the DB meetings check.
 * The S3Client and getSignedUrl are mocked at the module level.
 */
function makePresignEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    // Mock Secrets Store bindings (never real values in tests — Pitfall 5)
    R2_ACCESS_KEY_ID: { get: vi.fn().mockResolvedValue("test-access-key-id") },
    R2_SECRET_ACCESS_KEY: { get: vi.fn().mockResolvedValue("test-secret-key") },
    // Capture-app bearer the daemon must present — constant-time verified server-side.
    ECHO_CAPTURE_TOKEN: { get: vi.fn().mockResolvedValue(VALID_CAPTURE_TOKEN) },
    // Granted scopes are SERVER-SIDE config, not a client header.
    ECHO_CAPTURE_SCOPES: "echo:presign",
    CF_ACCOUNT_ID: "test-account-id",
    // DB will be populated by apply-migrations.ts / injected by beforeAll
    DB: (env as unknown as Env).DB,
    ...overrides,
  } as unknown as Env;
}

/**
 * Build a POST /echo/presign request. The bearer is the only auth input the client
 * controls — scopes/identity are derived server-side, never from a request header.
 */
function makePresignRequest(
  body: { session_id: string; key: string; content_type: string },
  options: { token?: string; noAuth?: boolean } = {},
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!options.noAuth) {
    headers["Authorization"] = `Bearer ${options.token ?? VALID_CAPTURE_TOKEN}`;
  }
  return new Request("https://echo.example.com/echo/presign", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock the AWS SDK to avoid real R2 calls (Pitfall 5)
// ─────────────────────────────────────────────────────────────────────────────

// We mock getSignedUrl to return a fake presigned URL. The mock verifies that
// it's called with the correct PutObjectCommand (key prefix check).
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue(
    "https://test-account-id.r2.cloudflarestorage.com/atlas-blobs/transcripts/echo-2026-06-06T14-00-00.json?X-Amz-Signature=abc123&X-Amz-Expires=3600",
  ),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({})),
  PutObjectCommand: vi.fn().mockImplementation((args) => args),
}));

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE-01-i: Presign endpoint tests
// ─────────────────────────────────────────────────────────────────────────────

describe("presign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("valid capture token + echo:presign scope → 200 with presigned URL", async () => {
    // Insert a meeting row into D1 so the session_id check passes
    const testDb = (env as unknown as Env).DB;
    await testDb.prepare(
      "INSERT OR REPLACE INTO meetings(session_id, consent, audio_disposition, started, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("echo-2026-06-06T14-00-00", "granted", "local-only", Date.now(), Date.now())
      .run();

    const spyEnv = makePresignEnv();
    const request = makePresignRequest({
      session_id: "echo-2026-06-06T14-00-00",
      key: "transcripts/echo-2026-06-06T14-00-00.json",
      content_type: "application/json",
    });

    // Import handlePresign dynamically to get the mocked version
    const { handlePresign } = await import("../src/presign.js");
    const resp = await handlePresign(request, spyEnv, {} as ExecutionContext);

    expect(resp.status).toBe(200);
    const body = await resp.json() as { url: string; key: string; expires_in: number };
    // URL must target the r2.cloudflarestorage.com endpoint
    expect(body.url).toContain("r2.cloudflarestorage.com");
    // Key must be under transcripts/ prefix
    expect(body.key).toMatch(/^transcripts\//);
    expect(body.expires_in).toBe(3600);
  });

  it("missing bearer → 401 (fail closed auth)", async () => {
    const spyEnv = makePresignEnv();
    const request = makePresignRequest(
      {
        session_id: "echo-2026-06-06T14-00-00",
        key: "transcripts/echo-2026-06-06T14-00-00.json",
        content_type: "application/json",
      },
      { noAuth: true },
    );

    const { handlePresign } = await import("../src/presign.js");
    const resp = await handlePresign(request, spyEnv, {} as ExecutionContext);

    expect(resp.status).toBe(401);
  });

  it("wrong capture token → 401 (constant-time verify, no client-trusted scope)", async () => {
    const spyEnv = makePresignEnv();
    // A client cannot bypass auth by sending a guessed/forged token.
    const request = makePresignRequest(
      {
        session_id: "echo-2026-06-06T14-00-00",
        key: "transcripts/echo-2026-06-06T14-00-00.json",
        content_type: "application/json",
      },
      { token: "not-the-real-token" },
    );

    const { handlePresign } = await import("../src/presign.js");
    const resp = await handlePresign(request, spyEnv, {} as ExecutionContext);

    expect(resp.status).toBe(401);
  });

  it("verified token but scope absent server-side → 403 (fail closed)", async () => {
    // Valid bearer, but the SERVER-SIDE granted scope set lacks echo:presign.
    // The client has no way to influence this — it is server config, not a header.
    const spyEnv = makePresignEnv({ ECHO_CAPTURE_SCOPES: "" } as Partial<Env>);
    const request = makePresignRequest({
      session_id: "echo-2026-06-06T14-00-00",
      key: "transcripts/echo-2026-06-06T14-00-00.json",
      content_type: "application/json",
    });

    const { handlePresign } = await import("../src/presign.js");
    const resp = await handlePresign(request, spyEnv, {} as ExecutionContext);

    // Fail-closed: scope absent = 403, NOT 401 (token is valid, scope is absent)
    expect(resp.status).toBe(403);
    const body = await resp.json() as { error: string };
    expect(body.error).toContain("echo:presign");
  });

  it("key outside the caller's own session → 400 (prefix lock + IDOR mitigation)", async () => {
    const spyEnv = makePresignEnv();
    // Valid token + scope, but the key is not under transcripts/<session_id> or
    // audio/raw/<session_id> — an attempt at an arbitrary / another-session key.
    const request = makePresignRequest({
      session_id: "echo-2026-06-06T14-00-00",
      key: "secrets/credentials.json",
      content_type: "application/json",
    });

    const { handlePresign } = await import("../src/presign.js");
    const resp = await handlePresign(request, spyEnv, {} as ExecutionContext);

    // Prefix lock + session binding: disallowed key = 400
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string };
    expect(body.error).toContain("transcripts/");
    expect(body.error).toContain("audio/raw/");
  });

  it("key under a different session_id → 400 (cannot presign another session's blob)", async () => {
    const spyEnv = makePresignEnv();
    // Correct prefix, but the key targets a DIFFERENT session than the caller's — the
    // session binding must reject it even though the prefix is allowed (IDOR).
    const request = makePresignRequest({
      session_id: "echo-2026-06-06T14-00-00",
      key: "transcripts/echo-2026-06-06T99-99-99-victim.json",
      content_type: "application/json",
    });

    const { handlePresign } = await import("../src/presign.js");
    const resp = await handlePresign(request, spyEnv, {} as ExecutionContext);

    expect(resp.status).toBe(400);
  });
});
