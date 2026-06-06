// apps/echo/src/index.ts
//
// Echo Worker entrypoint — cloud side of the Echo capture pipeline.
// The EchoSession DO handles WebSocket Hibernation (one DO per meeting).
// The presign endpoint mints R2 presigned PUT URLs for approved audio uploads.
//
// Feature implementation lands in Plan 03-02 (EchoSession DO) and 03-03 (presign).
// This shell establishes the Worker entrypoint + DO export for the test pool.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.js";

// ─────────────────────────────────────────────────────────────────────────────
// EchoSession — per-meeting WebSocket Hibernation DO.
//
// One instance per meeting, addressed as:
//   env.ECHO_SESSION.getByName("echo-<ISO-timestamp>")
//
// DO SQLite stores transcript segments (`seg:<sessionId>:<idx>`) and finalization
// state. Implementation ships in Plan 03-02.
// ─────────────────────────────────────────────────────────────────────────────
export class EchoSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Auto-reply to ping/pong WITHOUT waking the DO from hibernation.
    // compatibility_date >= 2026-04-25 satisfies web_socket_auto_reply_to_close.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  override async fetch(_request: Request): Promise<Response> {
    // Stub — full WebSocket Hibernation implementation in Plan 03-02.
    return new Response("EchoSession stub — feature implementation in 03-02", {
      status: 503,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Echo WorkerEntrypoint — RPC surface for Atlas coordination.
// Atlas calls Echo.finalize(sessionId) after meeting end to trigger handoff.
// Implementation in Plan 03-02.
// ─────────────────────────────────────────────────────────────────────────────
export class Echo extends WorkerEntrypoint<Env> {
  // Stub — RPC methods implemented in Plan 03-02.
}

// Default fetch handler — routes presign + health check endpoints.
// Presign implementation in Plan 03-03.
export default {
  async fetch(
    request: Request,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("Echo is running", { status: 200 });
    }
    // /echo/presign — presign endpoint (Plan 03-03)
    if (url.pathname === "/echo/presign") {
      return new Response("Presign endpoint stub — implementation in 03-03", {
        status: 503,
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
