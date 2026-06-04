/**
 * Steward — the sole Vault writer DO and the SINGLE reader of the Wire (Pillar 1).
 *
 * Phase 0, Plan 04 (Wave 3): the StewardWriter critical section (atomic dedup +
 * conditional absolute counter bump in ONE db.batch() inside
 * blockConcurrencyWhile — steward.ts), the single `atlas-wire` consumer
 * (steward-consumer.ts), and the consumers block in wrangler.jsonc all land here.
 *
 * The Worker default export wires the consumer's `queue()` handler and re-exports
 * `StewardWriter` so wrangler can resolve the `new_sqlite_classes` migration + the
 * STEWARD_LOCK binding.
 *
 * One name = one instance: env.STEWARD_LOCK.getByName("vault") is the single
 * serialized Vault write lock.
 */

import type { WireEvent } from "@atlas/wire";
import { stewardConsumer, type Env } from "./steward-consumer.js";

export { StewardWriter } from "./steward.js";
export type { Env } from "./steward-consumer.js";

export default {
  queue: stewardConsumer.queue,
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Steward has no public HTTP surface in Phase 0 (the outbound bridge endpoints
    // land in 00-08). This stub keeps the Worker buildable.
    return new Response("steward: sole Vault writer + single Wire consumer (phase 0)\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env, WireEvent>;
