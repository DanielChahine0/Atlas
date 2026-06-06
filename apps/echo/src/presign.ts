// apps/echo/src/presign.ts
//
// R2 presigned PUT URL endpoint — capture-token-gated, scope-gated, session-bound.
//
// Security model (T-03-02-02, T-03-02-03, T-03-02-04):
//   - Authentication: the presented Bearer is CONSTANT-TIME verified against the seeded
//     ECHO_CAPTURE_TOKEN (Secrets Store) — never trusted from a client-supplied header
//     (401 fail-closed on missing/wrong token). See ./auth.ts (mirrors the Obsidian bridge).
//   - Scope gate: the verified capture client must hold the echo:presign scope, derived
//     SERVER-SIDE (403 fail-closed if absent).
//   - Key binding + prefix lock: the key must start with transcripts/<session_id> or
//     audio/raw/<session_id> — the key is bound to the caller's session so a verified
//     daemon cannot presign a PUT over another session's blob (IDOR), and arbitrary
//     prefixes are refused (400).
//   - Credentials: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY via Secrets Store only
//   - Session check: session_id must exist in D1 meetings before minting
//   - Expiry: 3600 seconds (1 hour) — scoped to one exact key
//
// NOTE (Pitfall 5 from 03-RESEARCH): presigned URLs CANNOT be tested via the actual
// R2 round-trip in wrangler dev / workerd — the unit tests mock the S3 client and
// assert the auth + scope + key-binding behavior. Real upload is staging-integration UAT.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "./env.js";
import {
  authenticateCapture,
  grantedCaptureScopes,
  ECHO_PRESIGN_SCOPE,
} from "./auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Presigned URL expiry in seconds (1 hour). */
const PRESIGN_EXPIRY_SECONDS = 3600;

/**
 * Allowed R2 key prefixes. The minted key must start with one of these IMMEDIATELY
 * followed by the caller's own session_id (`<prefix><session_id>…`), so a verified
 * daemon can only presign blobs under its own session (mitigates IDOR) and only under
 * the two approved prefixes (the "leaked presigned URL" / arbitrary-key mitigation).
 */
const ALLOWED_PREFIXES = ["transcripts/", "audio/raw/"] as const;

/** The target R2 bucket (atlas-blobs). */
const R2_BUCKET = "atlas-blobs";

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
 * 1. Bearer must constant-time match the seeded ECHO_CAPTURE_TOKEN (else 401)
 * 2. echo:presign scope must be granted SERVER-SIDE (else 403 — token valid, scope absent)
 * 3. key must start with transcripts/<session_id> or audio/raw/<session_id> (else 400 —
 *    prefix lock + session binding; a verified daemon cannot presign another session's blob)
 * 4. session_id must exist in D1 meetings table (else 404)
 */
export async function handlePresign(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  // ── 1. Authenticate the capture-app bearer (constant-time vs ECHO_CAPTURE_TOKEN) ──
  // Fail-closed: missing binding, missing bearer, or wrong bearer all → 401. The token
  // is verified cryptographically server-side — NO client-supplied scope/identity header
  // is ever trusted (T-03-02-03; mirrors the Obsidian bridge token gate).
  if (!(await authenticateCapture(request, env))) {
    return new Response(
      JSON.stringify({ error: "Unauthorized: invalid or missing capture token" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  // ── 2. Scope gate (fail-closed: 403 if echo:presign absent) ─────────────
  // Scopes are derived SERVER-SIDE from the verified capture identity (ECHO_CAPTURE_SCOPES),
  // never from the request — a client cannot grant itself a scope.
  const scopes = grantedCaptureScopes(env);
  if (!scopes.has(ECHO_PRESIGN_SCOPE)) {
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

  // ── 4. Prefix lock + session binding (400 if key not under caller's own session) ──
  // Mitigates T-03-02-02 ("leaked / arbitrary presigned URL") AND IDOR: the key must be
  // under transcripts/<session_id> or audio/raw/<session_id>, so a verified daemon can
  // ONLY presign a PUT over its own session's blobs — never an arbitrary key or another
  // session's. The session_id is the D1 PRIMARY KEY, so this is an exact owner binding.
  const keyAllowed = ALLOWED_PREFIXES.some((prefix) =>
    key.startsWith(`${prefix}${session_id}`),
  );
  if (!keyAllowed) {
    return new Response(
      JSON.stringify({
        error:
          "Bad Request: key must be under transcripts/<session_id> or audio/raw/<session_id>",
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
    // Log the full error server-side for observability, but NEVER echo SDK/credential
    // detail back to the client (a presign/AWS-SDK error can carry internal hints).
    console.error("[echo:presign] mintPresignedPut failed", err);
    return new Response(
      JSON.stringify({ error: "Service Unavailable" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
}
