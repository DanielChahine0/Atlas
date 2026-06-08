/**
 * schema.ts — Zod schemas + D1 row types for the gate primitive (D4-04).
 *
 * GatePendingRow: the D1 row type (snake_case, mirrors 0007_gate.sql columns).
 * GateOptions: caller-provided options for openGate().
 * GateRecord: the return type of openGate() (includes plaintextToken, never persisted).
 * BrowserActionWorkItem / BrowserActionOutcome: the browser-action outbox types.
 */

import { z } from "zod";

// ─── D1 Row types ─────────────────────────────────────────────────────────────

/** The gate_pending D1 row shape (snake_case, matching 0007_gate.sql columns exactly). */
export interface GatePendingRow {
  id: string;
  agent: "Usher" | "Envoy" | "Sundial";
  action: string;
  target: string;
  artifact: string;                // JSON literal
  edited_artifact: string | null;
  status: "pending" | "approved" | "rejected" | "expired";
  decision: "pending" | "approved" | "rejected" | "expired";
  scope_used: string;
  idempotency_key: string;
  token_hash: string;              // SHA-256 hex; never the plaintext
  expires_at: number;              // epoch ms
  flag_id: string | null;
  created_at: number;              // epoch ms
  updated_at: number;              // epoch ms
}

/** The browser_action_outbox D1 row shape. */
export interface BrowserActionOutboxRow {
  id: string;
  agent: "Usher" | "Envoy";
  action_type: "event_fill_submit" | "linkedin_prefill" | "x_prefill";
  fields: string;                  // JSON: Codex field values — NEVER passwords/2FA
  gate_id: string;
  target_url: string;
  status: "pending" | "claimed" | "done" | "failed";
  claimed_at: number | null;
  outcome: string | null;          // JSON BrowserActionOutcome when done/failed
  created_at: number;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

export const GatePendingSchema = z.object({
  id: z.string(),
  agent: z.enum(["Usher", "Envoy", "Sundial"]),
  action: z.string(),
  target: z.string(),
  artifact: z.string(),
  edited_artifact: z.string().nullable(),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  decision: z.enum(["pending", "approved", "rejected", "expired"]),
  scope_used: z.string().default(""),
  idempotency_key: z.string(),
  token_hash: z.string(),
  expires_at: z.number(),
  flag_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

// ─── Caller-facing types ───────────────────────────────────────────────────────

/** Options provided by the caller (Usher / Envoy / Sundial) to openGate(). */
export interface GateOptions {
  agent: "Usher" | "Envoy" | "Sundial";
  action: string;
  target: string;
  artifact: string;
  idempotencyKey: string;
  expiresInMs: number;
  confirmBaseUrl: string;
  scopeUsed: string;
}

/**
 * The record returned from openGate().
 * `plaintextToken` is included ONLY here — it is NEVER persisted to D1.
 * Callers must NOT log or store the plaintextToken.
 */
export interface GateRecord {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  decision: "pending" | "approved" | "rejected" | "expired";
  expires_at: number;
  flag_id: string | null;
  created_at: number;
  plaintextToken: string;          // opaque 32-byte hex; sent in the confirm link
}

// ─── Browser-action outbox ────────────────────────────────────────────────────

/** Work item shape consumed from browser_action_outbox by the local daemon. */
export interface BrowserActionWorkItem {
  id: string;
  agent: "Usher" | "Envoy";
  action_type: "event_fill_submit" | "linkedin_prefill" | "x_prefill";
  fields: string;                  // JSON: Codex field values (name, email, phone)
  gate_id: string;
  target_url: string;
}

/** The outcome the daemon writes back after a browser action completes or hard-stops. */
export interface BrowserActionOutcome {
  id: string;
  status: "success" | "hard_stop" | "error";
  hard_stop_reason?:
    | "captcha"
    | "payment"
    | "sold_out"
    | "login_wall"
    | "tos_block"
    | "no_confirmation";
  confirmation_number?: string;
  screenshot_r2_key?: string;
}

// ─── ntfy push payload type ────────────────────────────────────────────────────

/** ntfy payload shape for pushes from openGate (mirroring flagger/push.ts). */
export interface NtfyPayload {
  title: string;
  message: string;
  priority?: number;
  actions: NtfyAction[];
}

export interface NtfyAction {
  action: "view" | "http";
  label: string;
  url: string;
  clear?: boolean;
}
