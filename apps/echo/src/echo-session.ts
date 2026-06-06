// apps/echo/src/echo-session.ts
//
// EchoSession — per-meeting Durable Object (WebSocket Hibernation).
//
// One DO instance per meeting, addressed as:
//   env.ECHO_SESSION.getByName("echo-<ISO-timestamp>")
//
// The DO uses the Cloudflare WebSocket Hibernation API (ctx.acceptWebSocket, NOT
// ws.accept()) so it can be evicted between messages without losing state. Segment
// state lives in the DO SQLite storage (seg:<sessionId>:<idx> keys), which persists
// across hibernation wakeups. The finalization flag lives at finalized:<sessionId>.
//
// CRITICAL (CLAUDE.md / 03-PATTERNS anti-patterns):
//   - NEVER ws.accept() — that pins the DO in memory (breaks Hibernation).
//   - ALWAYS this.ctx.acceptWebSocket(server, [sessionId]) to register Hibernation.
//   - Segments are stored idempotent on idx — replay-safe (Pillar 5).
//   - The DO/WS opens ONLY AFTER consent on the daemon side (D3-11 / Pitfall 3).
//   - No Wire consumer here — Echo is a producer only (Pillar 1).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import type { TranscriptSegment } from "./transcript.js";

// ─────────────────────────────────────────────────────────────────────────────
// EchoSession Durable Object
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EchoSession — per-meeting Durable Object using the WebSocket Hibernation API.
 *
 * DO SQLite key layout:
 *   `seg:<sessionId>:<idx>` → TranscriptSegment (idempotent on idx)
 *   `finalized:<sessionId>` → epoch ms timestamp (terminal signal)
 *
 * Addressed as `env.ECHO_SESSION.getByName("echo-<ISO-timestamp>")`.
 * Reconnecting via the SAME name resumes from stored segments (no loss).
 */
export class EchoSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Auto-reply to ping/pong WITHOUT waking the DO from hibernation.
    // compatibility_date >= 2026-04-25 satisfies web_socket_auto_reply_to_close.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  /**
   * Upgrade an HTTP request to a hibernating WebSocket.
   *
   * The session_id is derived from the ?session_id query parameter. It MUST be
   * a stable "echo-<ISO-timestamp>" string — never a UUID.
   *
   * Returns HTTP 101 with the client WebSocket. The server-side socket is
   * registered with ctx.acceptWebSocket() — this enables Hibernation (the DO
   * can be evicted between messages; webSocketMessage will wake it).
   *
   * The sessionId is persisted via serializeAttachment so it survives
   * hibernation wakeup (16 KB limit on the attachment; session_id is tiny).
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session_id");
    if (!sessionId) {
      return new Response("Missing session_id query parameter", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // acceptWebSocket() enables Hibernation: the DO can be evicted between messages.
    // Tags = [sessionId] allows getWebSockets(sessionId) on reconnect inspection.
    this.ctx.acceptWebSocket(server, [sessionId]);

    // serializeAttachment survives hibernation wakeup (loaded on next message).
    server.serializeAttachment({ sessionId });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Receive a segment from the daemon.
   *
   * The message payload is a JSON-serialized TranscriptSegment. Segments are
   * stored idempotent on idx — a replay of the same idx is a no-op (Pillar 5).
   *
   * Storage key: `seg:<sessionId>:<idx>`
   * This key format lets getSessionSegments() list + sort by idx via prefix scan.
   */
  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const { sessionId } = ws.deserializeAttachment() as { sessionId: string };
    const segment = JSON.parse(message as string) as TranscriptSegment;
    // Idempotent on segment index — replay-safe (Pillar 5).
    // If the same idx arrives twice (e.g. retry), storage.put() is idempotent.
    await this.ctx.storage.put(`seg:${sessionId}:${segment.idx}`, segment);
  }

  /**
   * Handle a WebSocket close from the daemon.
   *
   * compatibility_date >= 2026-04-07 enables web_socket_auto_reply_to_close, so
   * we still call ws.close() to be explicit. Persisting `finalized:<sessionId>`
   * marks the session as terminal — a new WS to a finalized session has no further
   * effect on the frozen transcript (mitigates T-03-02-01).
   */
  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    const { sessionId } = ws.deserializeAttachment() as { sessionId: string };
    // Persist finalization before closing — ensures the terminal state is durable
    // even if the DO is evicted immediately after.
    await this.ctx.storage.put(`finalized:${sessionId}`, Date.now());
    // Explicitly close (auto-reply handles the protocol close frame, but we also
    // close to be explicit about the server side).
    try {
      ws.close(code, reason);
    } catch {
      // The socket may already be closed; ignore the error.
    }
  }

  /**
   * Handle a WebSocket error.
   * Log and persist an error marker so monitoring can detect ungraceful closes.
   */
  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const attachment = ws.deserializeAttachment() as { sessionId?: string } | null;
    const sessionId = attachment?.sessionId ?? "unknown";
    // Persist the error timestamp so the operator can detect ungraceful closes.
    await this.ctx.storage.put(
      `error:${sessionId}:${Date.now()}`,
      String(error),
    );
    try {
      ws.close(1011, "internal error");
    } catch {
      // Socket may already be gone.
    }
  }

  /**
   * Return all stored segments for a session, ordered ascending by idx.
   *
   * This is the "resume from buffer" method — called by finalize logic to
   * build the complete transcript from stored segments (reconnect-safe: same
   * getByName = same DO instance = same storage).
   *
   * @param sessionId - The stable session identifier ("echo-<ISO-timestamp>").
   * @returns Ordered array of TranscriptSegment (ascending by idx).
   */
  async getSessionSegments(sessionId: string): Promise<TranscriptSegment[]> {
    const map = await this.ctx.storage.list<TranscriptSegment>({
      prefix: `seg:${sessionId}:`,
    });
    // storage.list returns a Map<string, value> ordered by key lexicographically.
    // Keys are `seg:<sessionId>:<idx>` — sort numerically by idx for correct order.
    const segments = Array.from(map.values());
    segments.sort((a, b) => a.idx - b.idx);
    return segments;
  }

  /**
   * Check if a session has been finalized (terminal signal received).
   *
   * @param sessionId - The stable session identifier.
   * @returns The finalization epoch ms, or null if not yet finalized.
   */
  async isFinalized(sessionId: string): Promise<number | null> {
    return (await this.ctx.storage.get<number>(`finalized:${sessionId}`)) ?? null;
  }
}
