/**
 * Steward — the sole Vault writer DO and the lone reader of the Wire.
 *
 * Phase 0, Plan 01 (Wave 1): this is the wrangler.jsonc-backed SKELETON only.
 * The StewardWriter critical section (atomic dedup + conditional counter bump
 * in ONE DB.batch() inside blockConcurrencyWhile), the bus-reader handler, the
 * DLQ handler, and the outbound bridge endpoints all land in Wave 2 (Plan 04).
 *
 * One name = one instance: env.STEWARD_LOCK.getByName("vault") is the single
 * serialized Vault write lock (Pillar 1).
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  STEWARD_LOCK: DurableObjectNamespace<StewardWriter>;
  // DB / CONFIG / WIRE surface in Wave 2 when the write path is implemented.
}

/**
 * Placeholder DO so the `new_sqlite_classes` migration + STEWARD_LOCK binding
 * resolve and the monorepo builds. The real atomic `apply()` lands in Plan 04.
 */
export class StewardWriter extends DurableObject<Env> {
  async ping(): Promise<string> {
    return "steward: write lock online (phase 0 skeleton)";
  }
}

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("steward: skeleton (phase 0)\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
