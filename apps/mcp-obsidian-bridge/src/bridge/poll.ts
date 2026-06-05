/**
 * /bridge/poll — the OUTBOUND-ONLY drain endpoint (SPINE-05).
 *
 * The local macOS daemon long-polls this endpoint with
 * `Authorization: Bearer <ATLAS_BRIDGE_TOKEN>`. On success it returns the PENDING
 * vault_outbox intents (the write-intents Steward enqueued inside the lock in 00-04)
 * so the daemon can execute them against the Obsidian Local REST API OUTBOUND. The
 * cloud NEVER reaches the laptop — this is a pull, not a push (the laptop has no
 * inbound port).
 *
 * D1 supports positional `?` params ONLY (no named params). We SELECT a bounded batch
 * of `state = 'pending'` rows. Marking-done is the SEPARATE /bridge/ack call (the
 * daemon acks only after a successful Obsidian write), so an unreachable laptop leaves
 * the intent pending — it is never lost (T-00-37).
 */

import { authorizeBridge, unauthorized, type BridgeAuthEnv } from "../auth.js";

export interface PollEnv extends BridgeAuthEnv {
  DB: D1Database;
}

/** A drain intent the daemon executes against Obsidian Local REST v3. */
export interface DrainIntent {
  idem: string;
  path: string;
  method: string;
  /** JSON-encoded header map (the op→REST v3 headers; Operation/Target-Type/...). */
  headers: string;
  /** JSON-encoded body (the §6.4 payload). May be null for header-only PATCHes. */
  body: string | null;
}

/** Bound the drain batch so one poll never returns an unbounded result set. */
const POLL_LIMIT = 50;

export async function handlePoll(request: Request, env: PollEnv): Promise<Response> {
  if (!(await authorizeBridge(request, env))) return unauthorized();

  // Positional `?` only. Oldest-first (FIFO by ts) so the Vault reflects write order.
  const result = await env.DB.prepare(
    "SELECT idem, path, method, headers, body FROM vault_outbox WHERE state = ? ORDER BY ts ASC LIMIT ?",
  )
    .bind("pending", POLL_LIMIT)
    .all<DrainIntent>();

  const intents = result.results ?? [];
  return Response.json(
    { intents },
    { headers: { "Cache-Control": "no-store" } },
  );
}
