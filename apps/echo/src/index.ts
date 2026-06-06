// apps/echo/src/index.ts
//
// Echo Worker entrypoint — cloud side of the Echo capture pipeline.
// The EchoSession DO handles WebSocket Hibernation (one DO per meeting).
// The presign endpoint mints R2 presigned PUT URLs for approved audio uploads.
//
// Re-exports EchoSession from echo-session.ts so the wrangler DO binding resolves.
// Presign implementation ships in Plan 03-02 (this plan).

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.js";
import { handlePresign } from "./presign.js";
import { authenticateCapture } from "./auth.js";

/**
 * A stable Echo session id is "echo-<ISO-ish timestamp>" — NEVER a UUID (DO addressing
 * is by name = session_id). Guard the value before it reaches getByName so a malformed /
 * injected name cannot address an arbitrary DO.
 */
const SESSION_ID_RE = /^echo-[A-Za-z0-9:_.\-]{1,80}$/;

// ─────────────────────────────────────────────────────────────────────────────
// EchoSession — re-exported so wrangler.jsonc class_name binding resolves.
// Full implementation in apps/echo/src/echo-session.ts
// ─────────────────────────────────────────────────────────────────────────────
export { EchoSession } from "./echo-session.js";

// ─────────────────────────────────────────────────────────────────────────────
// Echo WorkerEntrypoint — RPC surface for Atlas coordination.
// Atlas may call Echo.finalizeSession(sessionId) to initiate transcript handoff.
// ─────────────────────────────────────────────────────────────────────────────
export class Echo extends WorkerEntrypoint<Env> {
  // RPC methods for Atlas to call (e.g. session state queries).
  // The primary finalize flow is event-driven (transcript.ready Wire event).
}

// ─────────────────────────────────────────────────────────────────────────────
// Default fetch handler — routes presign + health check endpoints.
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("Echo is running", { status: 200 });
    }

    // /echo/presign — capture-token-gated R2 presigned URL minting.
    if (url.pathname === "/echo/presign") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handlePresign(request, env, ctx);
    }

    // /echo/ws — the OUTBOUND daemon's WebSocket upgrade into the per-meeting
    // EchoSession DO. The laptop has no inbound port; the daemon initiates this.
    // SECURITY: authenticate the bearer (constant-time vs ECHO_CAPTURE_TOKEN) BEFORE
    // forwarding the upgrade — the DO must NEVER be reachable unauthenticated. Then
    // validate the session_id name and forward the request (the DO reads ?session_id).
    if (url.pathname === "/echo/ws") {
      // Authenticate first — fail closed (401) on missing/wrong/absent token.
      // Every gate below is post-auth and forwards to the DO only as the last step.
      if (!(await authenticateCapture(request, env))) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
        });
      }
      // Validate the session_id before it addresses a DO (no arbitrary/injected name).
      const sessionId = url.searchParams.get("session_id");
      if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
        return new Response("Bad Request: invalid or missing session_id", {
          status: 400,
        });
      }
      // Must be a WebSocket upgrade — reject plain HTTP (426).
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      // Forward the upgrade to the per-meeting DO (addressed by name = session_id).
      return env.ECHO_SESSION.getByName(sessionId).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
