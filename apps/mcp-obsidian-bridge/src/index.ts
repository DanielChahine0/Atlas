/**
 * mcp-obsidian-bridge — the cloud side of the OUTBOUND-ONLY Obsidian bridge (SPINE-05).
 *
 * Steward (00-04) writes PENDING write-intents into the D1 `vault_outbox` table inside
 * its critical-section lock. This Worker exposes EXACTLY TWO endpoints — `/bridge/poll`
 * and `/bridge/ack` — both gated by `ATLAS_BRIDGE_TOKEN`. The LOCAL macOS daemon drains
 * them OUTBOUND: it long-polls `/bridge/poll`, executes each intent against the Obsidian
 * Local REST API v3 at `https://127.0.0.1:27124`, then `/bridge/ack`s it. The laptop has
 * NO inbound port; the cloud NEVER pushes to it (it can't reach it).
 *
 * The op→REST v3 map is the SINGLE canonical `toOutboxIntent` / `SAFE_METHODS` from
 * `@atlas/steward-core` (GLOBAL DECISION 5) — Steward already produced the intent rows
 * with that map; this Worker re-exports the safe-verb allow-list as data so the daemon
 * knows the only permitted verbs are PATCH/POST (NO DELETE — Pillar 2: Steward never
 * deletes the Vault).
 *
 * Pillar 1: this Worker reads `vault_outbox` from D1, NOT the Wire — no queues block.
 * Steward remains the SOLE reader of atlas-wire.
 *
 * `satisfies ExportedHandler<Env>` (NEVER the `: ExportedHandler<Env>` annotation).
 */

import { SAFE_METHODS } from "@atlas/steward-core";
import { handlePoll, type PollEnv } from "./bridge/poll.js";
import { handleAck, type AckEnv } from "./bridge/ack.js";

/** The bridge env surface: D1 (vault_outbox) + the long-poll bearer token. */
export interface Env extends PollEnv, AckEnv {
  DB: D1Database;
}

/**
 * The ONLY HTTP verbs the daemon is permitted to issue against the Vault, surfaced as
 * data from the single canonical `@atlas/steward-core` allow-list. NO removal verb is
 * present — re-asserting Pillar 2 at the bridge boundary without redefining the map.
 */
export const ALLOWED_VAULT_METHODS: readonly string[] = SAFE_METHODS;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The ONLY two inbound paths. Every other path is 404 — no broader inbound surface
    // (the bridge is a narrow outbound-drain door, not a general API).
    if (url.pathname === "/bridge/poll") {
      // The daemon GETs (or POSTs) to long-poll; accept both for transport flexibility.
      if (request.method !== "GET" && request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handlePoll(request, env);
    }

    if (url.pathname === "/bridge/ack") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handleAck(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
