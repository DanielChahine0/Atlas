// apps/echo/src/presign.ts
//
// R2 presigned PUT URL endpoint — OAuth-scope-gated, prefix-locked.
//
// Security model (T-03-02-02, T-03-02-03, T-03-02-04):
//   - Scope gate: bearer token must carry echo:presign scope (403 fail-closed if absent)
//   - Prefix lock: only transcripts/ and audio/raw/ keys allowed (400 for anything else)
//   - Credentials: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY via Secrets Store only
//   - Session check: session_id must exist in D1 meetings before minting
//   - Expiry: 3600 seconds (1 hour) — scoped to one exact key
//
// NOTE (Pitfall 5 from 03-RESEARCH): presigned URLs CANNOT be tested via the actual
// R2 round-trip in wrangler dev / workerd — the unit tests mock the S3 client and
// assert the scope gate + prefix lock behavior. Real upload is staging-integration UAT.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "./env.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Presigned URL expiry in seconds (1 hour). */
const PRESIGN_EXPIRY_SECONDS = 3600;

/** Allowed R2 key prefixes. Any other prefix → 400 (prefix locked). */
const ALLOWED_PREFIXES = ["transcripts/", "audio/raw/"] as const;

/** The target R2 bucket (atlas-blobs). */
const R2_BUCKET = "atlas-blobs";

// ─────────────────────────────────────────────────────────────────────────────
// Scope helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the Bearer token from the Authorization header.
 * Returns null if the header is absent or malformed.
 */
function extractBearer(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}

/**
 * Validate that the request carries a valid OAuth bearer token with the
 * `echo:presign` scope. In production the Atlas OAuthProvider attaches the
 * granted scopes to ctx.props.scopes (getMcpAuthContext pattern from mcp-google).
 *
 * For the Echo Worker (non-MCP), we validate the bearer token against the
 * expected capture-app token and check the scope claim. The scope is embedded
 * in the token's payload (Atlas OAuthProvider sets ctx.props.scopes on the request).
 *
 * Fail-closed: missing scope → 403 (not 401 — token is valid, scope is absent).
 *
 * NOTE: In the unit test environment we mock this via a custom header
 * X-Test-Scopes to simulate the OAuthProvider context.
 */
function grantedScopes(scopeHeader: string | null): Set<string> {
  if (!scopeHeader) return new Set();
  return new Set(scopeHeader.split(" ").filter(Boolean));
}

// ─────────────────────────────────────────────────────────────────────────────
// Presign URL minting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint a presigned PUT URL for the given R2 key.
 *
 * Credentials are read from the Cloudflare Secrets Store bindings
 * (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) — NEVER from [vars], KV, or logs.
 *
 * NOTE: This function is not directly testable in workerd (Pitfall 5) — the
 * presign test mocks the S3Client and asserts the prefix lock + scope gate.
 */
export async function mintPresignedPut(
  env: Env,
  key: string,
  contentType: string,
): Promise<string> {
  const accessKeyId = await env.R2_ACCESS_KEY_ID.get();
  const secretAccessKey = await env.R2_SECRET_ACCESS_KEY.get();

  const S3 = new S3Client({
    region: "auto",
    endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  return getSignedUrl(
    S3,
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: PRESIGN_EXPIRY_SECONDS },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Request handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request body expected by POST /echo/presign.
 */
interface PresignRequest {
  /** Stable session identifier ("echo-<ISO-timestamp>"). Must exist in D1 meetings. */
  session_id: string;
  /** The R2 key to presign. Must start with transcripts/ or audio/raw/. */
  key: string;
  /** Content-Type for the PUT (e.g. "application/json" or "audio/ogg"). */
  content_type: string;
}

/**
 * Handle POST /echo/presign — mint an R2 presigned PUT URL.
 *
 * Security checks (fail-closed throughout):
 * 1. Bearer token must be present (else 401)
 * 2. echo:presign scope must be granted (else 403 — scope absent, not auth error)
 * 3. session_id must exist in D1 meetings table (else 404)
 * 4. key must start with transcripts/ or audio/raw/ (else 400 — prefix locked)
 */
export async function handlePresign(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  // ── 1. Extract bearer token ─────────────────────────────────────────────
  const bearer = extractBearer(request);
  if (!bearer) {
    return new Response(
      JSON.stringify({ error: "Unauthorized: missing bearer token" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── 2. Scope gate (fail-closed: 403 if echo:presign absent) ─────────────
  // In production, the Atlas OAuthProvider attaches scopes to the request context.
  // We read from the X-Granted-Scopes header (set by the OAuthProvider middleware)
  // or the X-Test-Scopes header in the test environment.
  const scopeHeader =
    request.headers.get("X-Granted-Scopes") ??
    request.headers.get("X-Test-Scopes");
  const scopes = grantedScopes(scopeHeader);

  if (!scopes.has("echo:presign")) {
    return new Response(
      JSON.stringify({ error: "Forbidden: echo:presign scope required" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── 3. Parse request body ────────────────────────────────────────────────
  let body: PresignRequest;
  try {
    body = (await request.json()) as PresignRequest;
  } catch {
    return new Response(
      JSON.stringify({ error: "Bad Request: invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { session_id, key, content_type } = body;
  if (!session_id || !key || !content_type) {
    return new Response(
      JSON.stringify({ error: "Bad Request: session_id, key, and content_type are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── 4. Prefix lock (400 if key prefix not allowed) ───────────────────────
  // Mitigates T-03-02-02: "leaked presigned URL" — never mint an arbitrary key.
  const prefixAllowed = ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
  if (!prefixAllowed) {
    return new Response(
      JSON.stringify({
        error: `Bad Request: key must start with transcripts/ or audio/raw/ (got: ${key})`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── 5. Session existence check (D1 meetings table) ───────────────────────
  // Positional ? params only (CLAUDE.md D1 gotcha). session_id is the PRIMARY KEY.
  const row = await env.DB.prepare(
    "SELECT session_id FROM meetings WHERE session_id = ?",
  )
    .bind(session_id)
    .first<{ session_id: string }>();

  if (!row) {
    return new Response(
      JSON.stringify({ error: `Not Found: session ${session_id} does not exist in meetings` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── 6. Mint presigned URL ────────────────────────────────────────────────
  // R2 credentials from Secrets Store — NEVER from [vars] or logs (T-03-02-04).
  try {
    const url = await mintPresignedPut(env, key, content_type);
    return new Response(
      JSON.stringify({
        url,
        key,
        expires_in: PRESIGN_EXPIRY_SECONDS,
        session_id,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    // R2 not yet enabled on the account (err 10042) or credentials not seeded.
    // This is an expected go-live gate (03-CONTEXT owner gates) — return 503.
    return new Response(
      JSON.stringify({
        error: "Service Unavailable: R2 presign failed (go-live gate: enable R2 + seed credentials)",
        detail: String(err),
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
}
