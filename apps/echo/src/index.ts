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

    // /echo/presign — OAuth-scope-gated R2 presigned URL minting.
    if (url.pathname === "/echo/presign") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handlePresign(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
