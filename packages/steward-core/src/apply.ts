import type { WireEvent } from "@atlas/wire";
import { NonRetryableError } from "cloudflare:workflows";
import { toOutboxIntent } from "./op-mapping.js";

/**
 * THE CRUX of the spine (SPINE-02 / Pillar 5): the atomic op→D1 critical section,
 * factored out as a PURE function so it is unit-testable standalone. The
 * `StewardWriter` DO (00-04 Task 2) wraps this in `ctx.blockConcurrencyWhile` —
 * this function holds ONLY the D1 work and knows nothing about the lock.
 *
 * Hard rules (CLAUDE.md gotchas + RESEARCH Pitfalls 3/4):
 *   - The ENTIRE first-apply is ONE `db.batch([...])` — `batch()` is a single
 *     atomic transaction. counter-bump + ledger-insert + run_log + vault_outbox
 *     all commit or none do (C1): a crash/throw after a partial sequence of
 *     separate `.run()`s would commit the ledger key (so a retry reads it as a
 *     replay) while SILENTLY dropping the vault_outbox enqueue — permanent data
 *     loss, since Phase 0 has no re-derive. They therefore cannot be separate
 *     `.run()`s; they are statements 2–4 of the same batch.
 *   - D1 takes anonymous positional params ONLY (no named-index / colon forms).
 *   - Counter math is ABSOLUTE (`value = value + ?`), guarded by
 *     `WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ?)` on BOTH
 *     the initial-INSERT path AND the ON-CONFLICT UPDATE path (W9). The
 *     `INSERT ... SELECT ... WHERE NOT EXISTS (...)` makes the first-row insert
 *     itself replay-guarded, so a replay after a counter-row reset/eviction can
 *     never re-seed the row.
 *   - STATEMENT ORDER MATTERS (see below) — the counter bump runs BEFORE the
 *     ledger insert so its `WHERE NOT EXISTS` sees the pre-insert state.
 *   - The ledger INSERT OR IGNORE's `meta.changes === 0` ⇒ the key already
 *     existed ⇒ this is a REPLAY ⇒ return `{ applied: false }` and write nothing
 *     else (no double-count, at any age — the ledger has no TTL, D-08).
 *   - `delta` and `counter` are coerced/validated ONCE at the top (C2/I20): a
 *     non-integer delta is a contract violation (`NonRetryableError` ⇒ the
 *     consumer acks + flags P3, never corrupts the INTEGER column), and
 *     `counterEntity` is `String()`-normalized so the D1 PK and the Vault Target
 *     (op-mapping `String(...)`) can never diverge.
 *   - The slow Obsidian write is NOT here. For every op we enqueue a PENDING
 *     `vault_outbox` intent IN the batch; the daemon PATCHes/POSTs Obsidian
 *     OUTSIDE the lock (00-08), draining the row by its claim state.
 *
 * STATEMENT ORDERING (the fix the serialize/replay tests enforce): the build-plan
 * T5 snippet put the ledger insert FIRST and the counter bump SECOND. That is a
 * double-count BUG — within a single batch SQLite makes an earlier statement's
 * insert visible to a later one, so a bump guarded by `WHERE NOT EXISTS (... key)`
 * placed AFTER the ledger insert would always find the just-inserted key and skip.
 * So every WHERE-NOT-EXISTS-guarded write (counter bump, run_log, outbox) runs
 * BEFORE the ledger insert — each evaluates its guard against the state BEFORE the
 * key is visible — and the ledger INSERT OR IGNORE is the LAST statement, whose
 * `meta.changes` is the replay detector (0 ⇒ key already present ⇒ replay). C1
 * folds run_log + outbox into this SAME batch so first-apply is all-or-nothing; the
 * guards make a replay write nothing new in every table.
 * Order: [counter bump, run_log, vault_outbox, ledger insert]. (Proven by
 * serialize.test.ts: 50 distinct-key applies sum to 50, not 1, and by replay.test.ts
 * + apply-crux.test.ts: a replay leaves every table unchanged.)
 */
export async function applyEvent(
  db: D1Database,
  e: WireEvent,
): Promise<{ applied: boolean }> {
  const now = Date.now();
  // I20: normalize the counter PK once with `String()` so it matches the Vault
  // Target that op-mapping derives via `String(e.payload.counter ?? e.entity)`.
  const counterEntity = String(e.payload.counter ?? e.entity);
  // C2: coerce + validate the delta. `payload.delta` is `unknown`; binding it raw
  // to `value = value + ?` would let a non-numeric/NaN/float delta corrupt the
  // INTEGER column affinity. A bad delta is a contract violation, not a transient
  // failure → NonRetryableError (the consumer maps it to ack() + Flagger P3).
  const delta = Number(e.payload.delta ?? 1);
  if (!Number.isInteger(delta)) {
    throw new NonRetryableError(
      `non-integer counter delta: ${String(e.payload.delta)}`,
    );
  }

  // upsert/append/increment all enqueue an outbox intent; precompute it so the
  // enqueue can ride INSIDE the atomic batch (C1). The intent's PK is `idem`
  // (== idempotencyKey), so a replayed enqueue is itself a no-op.
  const intent = toOutboxIntent(e);

  // ── The atomic critical section: ONE batch, four statements (in THIS order) ──
  // (0) Conditional ABSOLUTE counter bump — both the initial INSERT and the
  //     ON-CONFLICT UPDATE are guarded by the SAME `WHERE NOT EXISTS` replay
  //     check (W9 — the no-conflict INSERT path is no longer unguarded).
  // (1) run_log row (§5.2 superset) — folded in so it is all-or-nothing with the
  //     counter bump (C1), and replay-guarded by the SAME `WHERE NOT EXISTS` check
  //     so a replay writes no spurious run_log row.
  // (2) vault_outbox PENDING enqueue — folded in for the same reason; a retry
  //     after a previous post-batch throw can NEVER see a committed ledger key with
  //     a missing outbox row. `INSERT OR IGNORE` on PK `idem` makes it replay-safe.
  // (3) INSERT OR IGNORE the idempotency key — LAST so statements (0)-(2) evaluate
  //     their guards against the pre-insert state; its meta.changes is the replay
  //     detector (0 ⇒ key already present ⇒ replay).
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO counters(entity,value)
           SELECT ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ?)
         ON CONFLICT(entity) DO UPDATE SET value = value + ?
           WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ?)`,
      )
      .bind(counterEntity, delta, e.idempotencyKey, delta, e.idempotencyKey),
    db
      .prepare(
        `INSERT INTO run_log(agent,type,entity,op,result,ts)
           SELECT ?,?,?,?, 'ok', ?
           WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ?)`,
      )
      .bind(e.agent, e.type, e.entity, e.op, now, e.idempotencyKey),
    db
      .prepare(
        "INSERT OR IGNORE INTO vault_outbox(idem,path,method,headers,body,state,ts) VALUES (?,?,?,?,?, 'pending', ?)",
      )
      .bind(intent.idem, intent.path, intent.method, intent.headers, intent.body, now),
    db
      .prepare(
        "INSERT OR IGNORE INTO idempotency_keys(key,agent,type,op,entity,applied_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(e.idempotencyKey, e.agent, e.type, e.op, e.entity, now),
  ]);

  // Replay: the key was already in the ledger ⇒ nothing changed ⇒ skip.
  // batch() returns one result per statement, in order; the ledger insert is the
  // LAST statement (index 3). The batch is atomic, so on a replay the counter /
  // run_log / vault_outbox statements (0-2) all leave nothing new — there is no
  // post-batch work to skip (C1: nothing runs after the batch).
  const ledgerResult = result[3];
  if (!ledgerResult || ledgerResult.meta.changes === 0) {
    return { applied: false };
  }

  return { applied: true };
}
