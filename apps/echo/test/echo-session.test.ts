// apps/echo/test/echo-session.test.ts
//
// CAPTURE-01-a: EchoSession DO — acceptWebSocket + segment accumulation
// CAPTURE-01-b: reconnect-to-same-DO resumes from stored segments
// CAPTURE-01-c: Wire-contract — transcript.ready event shape
// CAPTURE-01-d: replay through Steward → meta.changes===0
//
// TDD RED: these tests import from echo-session.ts and transcript.ts which
// are not yet implemented — they will fail until the GREEN phase (Plan 03-02).

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import { applyEvent } from "@atlas/steward-core";
import type { EchoSession } from "../src/echo-session.js";
import { buildTranscriptReadyEvent } from "../src/transcript.js";

const ECHO_SESSION = (
  env as unknown as { ECHO_SESSION: DurableObjectNamespace<EchoSession> }
).ECHO_SESSION;

const db = (env as unknown as { DB: D1Database }).DB;

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE-01-a: EchoSession DO — acceptWebSocket + segment accumulation
// ─────────────────────────────────────────────────────────────────────────────
describe("echo-session", () => {
  it("acceptWebSocket + serializeAttachment accumulates segments correctly", async () => {
    const SESSION_ID = "echo-2026-06-06T14-00-00";
    const session = ECHO_SESSION.getByName(SESSION_ID);

    // Simulate fetch to upgrade to WebSocket
    const req = new Request("https://echo.example.com/ws?session_id=" + SESSION_ID, {
      headers: { Upgrade: "websocket" },
    });
    const resp = await session.fetch(req);
    expect(resp.status).toBe(101);

    // Get the WebSocket from the response
    const ws = resp.webSocket!;
    expect(ws).toBeDefined();
    ws.accept();

    // Send 3 segments
    const segments = [
      { speaker: "Owner", text: "Hello", start_ts: 0, end_ts: 1.5, confidence: 0.95, idx: 0 },
      { speaker: "Speaker 2", text: "Hi there", start_ts: 1.6, end_ts: 3.0, confidence: 0.88, idx: 1 },
      { speaker: "Owner", text: "Good to meet you", start_ts: 3.1, end_ts: 5.0, confidence: 0.92, idx: 2 },
    ];
    for (const seg of segments) {
      ws.send(JSON.stringify(seg));
    }

    // Allow the DO to process messages
    await new Promise((r) => setTimeout(r, 50));

    // Verify segments are stored via getSessionSegments
    const stored = await session.getSessionSegments(SESSION_ID);
    expect(stored).toHaveLength(3);
    // Ordered by idx ascending
    expect(stored[0]!.idx).toBe(0);
    expect(stored[1]!.idx).toBe(1);
    expect(stored[2]!.idx).toBe(2);
    expect(stored[0]!.speaker).toBe("Owner");
    expect(stored[2]!.text).toBe("Good to meet you");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE-01-b: Reconnect to same DO resumes from stored segments
// ─────────────────────────────────────────────────────────────────────────────
describe("reconnect", () => {
  it("reconnect-to-same-DO (getByName) resumes from stored segments", async () => {
    const SESSION_ID = "echo-2026-06-06T14-30-00";
    const session = ECHO_SESSION.getByName(SESSION_ID);

    // First connection: send 2 segments
    const req1 = new Request("https://echo.example.com/ws?session_id=" + SESSION_ID, {
      headers: { Upgrade: "websocket" },
    });
    const resp1 = await session.fetch(req1);
    expect(resp1.status).toBe(101);
    const ws1 = resp1.webSocket!;
    ws1.accept();

    ws1.send(JSON.stringify({ speaker: "Owner", text: "Segment A", start_ts: 0, end_ts: 1.0, confidence: 0.9, idx: 0 }));
    ws1.send(JSON.stringify({ speaker: "Speaker 2", text: "Segment B", start_ts: 1.1, end_ts: 2.0, confidence: 0.85, idx: 1 }));
    await new Promise((r) => setTimeout(r, 50));

    // Verify 2 segments stored before disconnect
    const before = await session.getSessionSegments(SESSION_ID);
    expect(before).toHaveLength(2);

    // Simulate disconnect — close the WS
    ws1.close(1000, "client disconnect");
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect to the SAME name — SAME DO instance
    const sessionReconnect = ECHO_SESSION.getByName(SESSION_ID);
    const req2 = new Request("https://echo.example.com/ws?session_id=" + SESSION_ID, {
      headers: { Upgrade: "websocket" },
    });
    const resp2 = await sessionReconnect.fetch(req2);
    expect(resp2.status).toBe(101);
    const ws2 = resp2.webSocket!;
    ws2.accept();

    // Send a 3rd segment on the reconnected connection
    ws2.send(JSON.stringify({ speaker: "Owner", text: "Segment C", start_ts: 2.1, end_ts: 3.5, confidence: 0.93, idx: 2 }));
    await new Promise((r) => setTimeout(r, 50));

    // Same getByName = same instance — all 3 segments should be present
    const after = await sessionReconnect.getSessionSegments(SESSION_ID);
    expect(after).toHaveLength(3);
    expect(after[0]!.text).toBe("Segment A");
    expect(after[1]!.text).toBe("Segment B");
    expect(after[2]!.text).toBe("Segment C");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE-01-c: Wire-contract — transcript.ready event shape
// ─────────────────────────────────────────────────────────────────────────────
describe("wire-contract", () => {
  it("emits canonical §6.4 shape with structured idempotencyKey", () => {
    const SESSION_ID = "echo-2026-06-06T14-00-00";
    const evt = buildTranscriptReadyEvent({
      session_id: SESSION_ID,
      transcript_r2_key: "transcripts/echo-2026-06-06T14-00-00.json",
      audio_r2_key: null,
      audio_disposition: "local-only",
      duration_seconds: 300,
      consent: "granted",
    });

    expect(evt.agent).toBe("Echo");
    expect(evt.type).toBe("transcript.ready");
    expect(evt.entity).toBe("session");
    expect(evt.op).toBe("upsert");
    expect(evt.idempotencyKey).toBe(`echo:${SESSION_ID}:ready`);
    expect(evt.payload.session_id).toBe(SESSION_ID);
    expect(evt.payload.consent).toBe("granted");
    // WireEvent.parse must not throw — validates §6.4 shape
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE-01-d: Replay — transcript.ready through Steward is a no-op
// ─────────────────────────────────────────────────────────────────────────────
describe("replay", () => {
  it("replaying transcript.ready Wire event → Steward → meta.changes===0", async () => {
    const SESSION_ID = "echo-2026-06-06T14-00-00";
    const evt = buildTranscriptReadyEvent({
      session_id: SESSION_ID,
      transcript_r2_key: "transcripts/echo-2026-06-06T14-00-00.json",
      audio_r2_key: null,
      audio_disposition: "local-only",
      duration_seconds: 300,
      consent: "granted",
    });

    // First apply — should succeed
    expect(await applyEvent(db, evt)).toEqual({ applied: true });
    // Replay — same idempotencyKey → no-op (meta.changes === 0 → applied: false)
    expect(await applyEvent(db, evt)).toEqual({ applied: false });
    // Third replay — still no-op (ledger has no TTL, Pillar 5)
    expect(await applyEvent(db, evt)).toEqual({ applied: false });
  });
});
