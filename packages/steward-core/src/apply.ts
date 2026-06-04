import type { WireEvent } from "@atlas/wire";
import { toOutboxIntent } from "./op-mapping.js";

/**
 * THE CRUX of the spine (SPINE-02 / Pillar 5): the atomic op→D1 critical section,
 * factored out as a PURE function so it is unit-testable standalone. The
 * `StewardWriter` DO (00-04 Task 2) wraps this in `ctx.blockConcurrencyWhile` —
 * this function holds ONLY the D1 work and knows nothing about the lock.
 *
 * Hard rules (CLAUDE.md gotchas + RESEARCH Pitfalls 3/4):
 *   - dedup-check + counter-bump + ledger-insert run as ONE `db.batch([...])` —
 *     `batch()` is a single atomic transaction. A crash between statements would
 *     double-count, so they cannot be separate `.run()`s.
 *   - D1 takes anonymous positional params ONLY (no named-index / colon forms).
 *   - Counter math is ABSOLUTE (`value = value + ?`), guarded by
 *     `WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ?)` so the
 *     bump fires ONLY when the key was newly inserted this call.
 *   - `batch[0].meta.changes === 0` ⇒ the key already existed ⇒ this is a REPLAY ⇒
 *     return `{ applied: false }` and write nothing else (no double-count, at any
 *     age — the ledger has no TTL, D-08).
 *   - The slow Obsidian write is NOT here. For upsert/append we enqueue a PENDING
 *     `vault_outbox` intent (the daemon PATCHes Obsidian OUTSIDE the lock, 00-08).
 */
export async function applyEvent(
  db: D1Database,
  e: WireEvent,
): Promise<{ applied: boolean }> {
  const now = Date.now();
  const counterEntity = e.payload.counter ?? e.entity;
  const delta = e.payload.delta ?? 1;

  // ── The atomic critical section: ONE batch, two statements ─────────────────
  // (1) INSERT OR IGNORE the idempotency key — its meta.changes is the replay
  //     detector (0 ⇒ key already present ⇒ replay).
  // (2) Conditional ABSOLUTE counter bump, gated on the key being newly inserted.
  const result = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO idempotency_keys(key,agent,type,op,entity,applied_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(e.idempotencyKey, e.agent, e.type, e.op, e.entity, now),
    db
      .prepare(
        `INSERT INTO counters(entity,value) VALUES(?, ?)
         ON CONFLICT(entity) DO UPDATE SET value = value + ?
         WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ?)`,
      )
      .bind(counterEntity, delta, delta, e.idempotencyKey),
  ]);

  // Replay: the key was already in the ledger ⇒ nothing changed ⇒ skip.
  // (batch() returns one result per statement, in order; [0] is the ledger insert.)
  const ledgerResult = result[0];
  if (!ledgerResult || ledgerResult.meta.changes === 0) {
    return { applied: false };
  }

  // ── Post-apply writes (still inside the caller's lock) ─────────────────────
  // Observability: one run_log row per applied event (§5.2 superset).
  await db
    .prepare(
      "INSERT INTO run_log(agent,type,entity,op,result,ts) VALUES(?,?,?,?, 'ok', ?)",
    )
    .bind(e.agent, e.type, e.entity, e.op, now)
    .run();

  // upsert/append enqueue a PENDING vault_outbox intent — the slow Obsidian PATCH
  // happens OUTSIDE the lock, drained by the outbound daemon (00-08). The intent's
  // PK is `idem` (== idempotencyKey), so a replayed enqueue is itself a no-op.
  if (e.op === "upsert" || e.op === "append" || e.op === "increment") {
    const intent = toOutboxIntent(e);
    await db
      .prepare(
        "INSERT OR IGNORE INTO vault_outbox(idem,path,method,headers,body,state,ts) VALUES (?,?,?,?,?, 'pending', ?)",
      )
      .bind(intent.idem, intent.path, intent.method, intent.headers, intent.body, now)
      .run();
  }

  return { applied: true };
}
