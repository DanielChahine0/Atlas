/**
 * /bridge/poll — the OUTBOUND-ONLY drain endpoint (SPINE-05).
 *
 * The local macOS daemon long-polls this endpoint with
 * `Authorization: Bearer <ATLAS_BRIDGE_TOKEN>`. On success it returns the claimed
 * vault_outbox intents (the write-intents Steward enqueued inside the lock in 00-04)
 * so the daemon can execute them against the Obsidian Local REST API OUTBOUND. The
 * cloud NEVER reaches the laptop — this is a pull, not a push (the laptop has no
 * inbound port).
 *
 * W14 — CLAIM boundary (concurrency + idempotency). The 0001 outbox had only
 * pending/done, so two overlapping/retried polls SELECTed the SAME pending rows and
 * handed them to the daemon twice → a double-drain duplicates append (POST) feed
 * lines. Poll now ATOMICALLY CLAIMS its batch: a single `UPDATE ... RETURNING`
 * flips a bounded set of claimable rows from their prior state to `'sent'` and
 * stamps `claimed_at`, returning ONLY the rows THIS poll claimed. Because the claim
 * is one SQLite statement, two overlapping polls serialize — they can NEVER return
 * the same row. ack (the separate /bridge/ack call) flips `sent → done`.
 *
 * STALE-CLAIM RECLAIM (never lost — T-00-37): a daemon that claims rows (`sent`)
 * then dies before acking would otherwise strand them forever. So the claimable set
 * is `state = 'pending'` OR a `state = 'sent'` whose `claimed_at` is older than the
 * lease window — a crashed claim is re-delivered, not lost. The daemon's Obsidian
 * write must be idempotent for that redelivery (op-mapping stamps an `X-Atlas-Idem`
 * dedupe header per intent so an append POST does not duplicate a feed line).
 *
 * D1 supports positional `?` params ONLY (no named params).
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
export const POLL_LIMIT = 50;

/**
 * The claim lease window (ms). A `'sent'` row whose `claimed_at` is older than this is
 * treated as abandoned (the daemon died mid-drain) and RE-CLAIMABLE by the next poll.
 * Generous so a slow-but-alive daemon is not double-served; the daemon acks promptly
 * after each successful write, so a healthy claim is short-lived.
 */
export const CLAIM_LEASE_MS = 5 * 60 * 1000; // 5 minutes

export async function handlePoll(request: Request, env: PollEnv): Promise<Response> {
  if (!(await authorizeBridge(request, env))) return unauthorized();

  const now = Date.now();
  const staleCutoff = now - CLAIM_LEASE_MS;

  // ATOMIC claim: one `UPDATE ... RETURNING`. The inner SELECT picks a bounded,
  // oldest-first (FIFO by ts) set of CLAIMABLE rows — fresh `pending` OR a `sent`
  // row whose lease has expired (stale-claim reclaim). The outer UPDATE flips them
  // to `'sent'` and stamps `claimed_at = now`, RETURNING the rows it actually
  // claimed. Two overlapping polls run this as serialized SQLite statements, so a
  // row can be claimed by AT MOST ONE of them. Positional `?` only.
  const result = await env.DB.prepare(
    `UPDATE vault_outbox
        SET state = 'sent', claimed_at = ?
      WHERE idem IN (
              SELECT idem FROM vault_outbox
               WHERE state = 'pending'
                  OR (state = 'sent' AND COALESCE(claimed_at, 0) < ?)
               ORDER BY ts ASC
               LIMIT ?
            )
    RETURNING idem, path, method, headers, body`,
  )
    .bind(now, staleCutoff, POLL_LIMIT)
    .all<DrainIntent>();

  const intents = result.results ?? [];
  return Response.json(
    { intents },
    { headers: { "Cache-Control": "no-store" } },
  );
}
