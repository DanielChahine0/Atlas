// apps/echo/src/transcript.ts
//
// Transcript JSON contract types + transcript.ready Wire event builder.
//
// Echo is a Wire PRODUCER only — it emits transcript.ready events; never
// consumes atlas-wire (Pillar 1: Steward is the sole consumer).
//
// The idempotencyKey is STABLE + STRUCTURED: echo:${session_id}:ready
// NEVER crypto.randomUUID() — a replay must re-derive the exact same key.

import type { WireEvent } from "@atlas/wire";

// ─────────────────────────────────────────────────────────────────────────────
// Transcript JSON contract types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single diarized segment streamed from the daemon over the WebSocket.
 * Stored in the EchoSession DO SQLite at `seg:<sessionId>:<idx>`.
 * Idempotent on `idx` — replay-safe (see CLAUDE.md idempotency rules).
 */
export interface TranscriptSegment {
  /** Speaker label: "Owner" (mic channel, deterministic) or "Speaker N" (loopback channel). */
  speaker: string;
  /** Transcribed text for this segment. */
  text: string;
  /** Start timestamp in seconds relative to session start. */
  start_ts: number;
  /** End timestamp in seconds relative to session start. */
  end_ts: number;
  /** ASR confidence 0..1. Low-confidence segments are kept but flagged P4. */
  confidence: number;
  /**
   * Monotonically increasing segment index within this session.
   * Used as the DO storage key suffix (`seg:<sessionId>:<idx>`) and as
   * the dedup handle — a replayed segment with the same idx is a no-op.
   */
  idx: number;
}

/**
 * The full diarized transcript for a meeting session.
 * Stored as a JSON blob in R2 at `transcripts/<session_id>.json`.
 * The D1 `meetings` table holds the index row (session_id, consent, keys, etc.).
 */
export interface Transcript {
  /** Stable session identifier: "echo-<ISO-timestamp>". Never a UUID. */
  session_id: string;
  /** Consent disposition recorded by the daemon before the session opened. */
  consent: "granted" | "discarded";
  /**
   * Audio disposition:
   * - "local-only": raw audio stays on device (default per D3-11).
   * - "r2-approved": owner approved R2 upload for this session.
   * - "discarded": no audio retained.
   */
  audio_disposition: "local-only" | "r2-approved" | "discarded";
  /** All diarized segments, ordered ascending by idx. */
  segments: TranscriptSegment[];
  /** Total session duration in seconds. */
  duration_seconds: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// transcript.ready Wire event builder
// ─────────────────────────────────────────────────────────────────────────────

/** Input to buildTranscriptReadyEvent — the fields sent by the daemon after upload. */
export interface TranscriptReadyInput {
  /** Stable session id: "echo-<ISO-timestamp>". */
  session_id: string;
  /** R2 key for the transcript JSON blob (transcripts/<session_id>.json). */
  transcript_r2_key: string;
  /** R2 key for the raw audio blob (audio/raw/<session_id>.opus), or null. */
  audio_r2_key: string | null;
  /** Audio disposition as recorded by the daemon. */
  audio_disposition: "local-only" | "r2-approved" | "discarded";
  /** Total session duration in seconds. */
  duration_seconds: number;
  /** Consent disposition as recorded by the daemon. */
  consent: "granted" | "discarded";
}

/**
 * Build the canonical §6.4 transcript.ready Wire event (SPEC §6.4 / CLAUDE.md Wire contract).
 *
 * Shape (per RESEARCH Pattern 7 + 03-CONTEXT Claude's Discretion):
 * ```json
 * { "agent": "Echo", "type": "transcript.ready", "entity": "session",
 *   "op": "upsert", "payload": { ... }, "idempotencyKey": "echo:<session_id>:ready" }
 * ```
 *
 * Idempotency: `echo:${session_id}:ready` is a stable, structured key — a replay
 * of this event through Steward is a guaranteed no-op (meta.changes === 0, Pillar 5).
 *
 * Usage:
 * ```ts
 * import { send } from "@atlas/wire";
 * const evt = buildTranscriptReadyEvent({ session_id, ... });
 * await send(env, evt);  // NEVER env.WIRE.send() directly
 * ```
 */
export function buildTranscriptReadyEvent(input: TranscriptReadyInput): WireEvent {
  const { session_id, transcript_r2_key, audio_r2_key, audio_disposition, duration_seconds, consent } = input;
  return {
    agent: "Echo",
    type: "transcript.ready",
    entity: "session",
    op: "upsert",
    payload: {
      session_id,
      transcript_r2_key,
      audio_r2_key,
      audio_disposition,
      duration_seconds,
      consent,
    },
    // STABLE + STRUCTURED idempotency key — NEVER crypto.randomUUID()
    // A replay of this key through Steward → meta.changes===0 (Pillar 5).
    idempotencyKey: `echo:${session_id}:ready`,
  };
}
