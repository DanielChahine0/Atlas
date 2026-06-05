/**
 * /bridge/ack — the OUTBOUND-ONLY ack endpoint (SPINE-05).
 *
 * After the daemon successfully PATCHes/POSTs the Obsidian Local REST API for a
 * drained intent, it calls this endpoint (OUTBOUND) with
 * `Authorization: Bearer <ATLAS_BRIDGE_TOKEN>` and the intent's `idem` to mark the
 * vault_outbox row `state = 'done'`.
 *
 * IDEMPOTENT (T-00-37): marking an already-done or unknown `idem` is a safe no-op —
 * a redelivered/replayed ack does NOT double-apply (the underlying Obsidian write is
 * separately idempotent; this only flips the outbox state). The UPDATE is keyed by
 * the PRIMARY KEY `idem` with a positional `?` (no named params).
 */

import { authorizeBridge, unauthorized, type BridgeAuthEnv } from "../auth.js";

export interface AckEnv extends BridgeAuthEnv {
  DB: D1Database;
}

export async function handleAck(request: Request, env: AckEnv): Promise<Response> {
  if (!(await authorizeBridge(request, env))) return unauthorized();

  let idem: unknown;
  try {
    const parsed = (await request.json()) as { idem?: unknown };
    idem = parsed.idem;
  } catch {
    return new Response("Bad Request: expected JSON { idem }", { status: 400 });
  }
  if (typeof idem !== "string" || idem.length === 0) {
    return new Response("Bad Request: idem must be a non-empty string", { status: 400 });
  }

  // Flip the named row to done ONLY if it is not already done. Positional `?` only.
  // The `AND state != 'done'` guard makes the idempotency observable: an unknown idem
  // OR an already-done row matches no row (meta.changes === 0) — a safe no-op. A
  // redelivered ack therefore does NOT double-apply, and `changed === 0` is the
  // signal that this ack landed on an already-drained intent. (Without the guard,
  // SQLite reports a re-UPDATE to the same value as 1 changed row, masking the no-op.)
  const res = await env.DB.prepare(
    "UPDATE vault_outbox SET state = ? WHERE idem = ? AND state != ?",
  )
    .bind("done", idem, "done")
    .run();

  const changed = res.meta?.changes ?? 0;
  return Response.json(
    { acked: true, idem, changed },
    { headers: { "Cache-Control": "no-store" } },
  );
}
