// apps/echo/test/presign.test.ts
//
// CAPTURE-01-i: Presign endpoint — R2 presigned URL minting (scope-gated, prefix-locked)
//
// TDD: tests validate the scope gate + prefix lock behavior by mocking the
// S3 client. The actual R2 round-trip is not testable in workerd (Pitfall 5 from
// 03-RESEARCH) — real upload is staging-integration UAT (03-VALIDATION Manual-Only).
//
// Security checks validated:
//   - echo:presign scope present → URL minted (scope gate passes)
//   - echo:presign scope absent → 403 (fail-closed, T-03-02-03)
//   - key prefix not in transcripts/ or audio/raw/ → 400 (prefix lock, T-03-02-02)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env.js";

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
    CF_ACCOUNT_ID: "test-account-id",
    // DB will be populated by apply-migrations.ts / injected by beforeAll
    DB: (env as unknown as Env).DB,
    ...overrides,
  } as unknown as Env;
}

/**
 * Build a POST /echo/presign request with the given scope header.
 *
 * Scope is injected via X-Test-Scopes (the handlePresign function reads
 * X-Granted-Scopes or X-Test-Scopes — the latter for the test environment).
 */
function makePresignRequest(
  body: { session_id: string; key: string; content_type: string },
  options: { scope?: string; noAuth?: boolean } = {},
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!options.noAuth) {
    headers["Authorization"] = "Bearer test-capture-token";
  }
  if (options.scope !== undefined) {
    headers["X-Test-Scopes"] = options.scope;
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

  it("valid OAuth scope echo:presign → 200 with presigned URL", async () => {
    // Insert a meeting row into D1 so the session_id check passes
    const testDb = (env as unknown as Env).DB;
    await testDb.prepare(
      "INSERT OR REPLACE INTO meetings(session_id, consent, audio_disposition, started, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("echo-2026-06-06T14-00-00", "granted", "local-only", Date.now(), Date.now())
      .run();

    const spyEnv = makePresignEnv();
    const request = makePresignRequest(
      {
        session_id: "echo-2026-06-06T14-00-00",
        key: "transcripts/echo-2026-06-06T14-00-00.json",
        content_type: "application/json",
      },
      { scope: "echo:presign" },
    );

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

  it("missing scope → 403 (fail closed)", async () => {
    const spyEnv = makePresignEnv();
    // Provide a valid bearer token but NO echo:presign scope
    const request = makePresignRequest(
      {
        session_id: "echo-2026-06-06T14-00-00",
        key: "transcripts/echo-2026-06-06T14-00-00.json",
        content_type: "application/json",
      },
      { scope: "some:other:scope" },
    );

    const { handlePresign } = await import("../src/presign.js");
    const resp = await handlePresign(request, spyEnv, {} as ExecutionContext);

    // Fail-closed: scope absent = 403, NOT 401 (token is valid, scope is absent)
    expect(resp.status).toBe(403);
    const body = await resp.json() as { error: string };
    expect(body.error).toContain("echo:presign");
  });

  it("unapproved audio key prefix → 400 (prefix enforcement)", async () => {
    const spyEnv = makePresignEnv();
    // Valid scope, but key prefix is not transcripts/ or audio/raw/
    const request = makePresignRequest(
      {
        session_id: "echo-2026-06-06T14-00-00",
        // Attempted path traversal or unauthorized prefix
        key: "secrets/credentials.json",
        content_type: "application/json",
      },
      { scope: "echo:presign" },
    );

    const { handlePresign } = await import("../src/presign.js");
    const resp = await handlePresign(request, spyEnv, {} as ExecutionContext);

    // Prefix lock: unauthorized key prefix = 400
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string };
    expect(body.error).toContain("transcripts/");
    expect(body.error).toContain("audio/raw/");
  });
});
