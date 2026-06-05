import { DurableObject } from "cloudflare:workers";
import type { Env } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { applyEvent } from "@atlas/steward-core";

/**
 * StewardWriter — THE CRUX of the spine (SPINE-02 / Pillar 1 + Pillar 5).
 *
 * Addressed ONLY as `env.STEWARD_LOCK.getByName("vault")`: one name = one
 * instance = the single serialized Vault write lock. Never a dynamic / per-request
 * DO name (that would split the writer — RESEARCH Pitfall 4).
 *
 * `apply()` wraps the pure `applyEvent` (the atomic dedup + counter-bump +
 * ledger-insert `db.batch()` from @atlas/steward-core) inside
 * `this.ctx.blockConcurrencyWhile`, so this one DO serializes ALL writes even
 * under concurrent consumer invocations. The slow Obsidian PATCH is NOT in the
 * lock — applyEvent only enqueues a PENDING `vault_outbox` intent; the outbound
 * daemon (00-08) drains it OUTSIDE the lock. An unreachable bridge can never
 * stall the Wire.
 *
 * agents@0.14.1 DO base-class API (confirmed from the installed
 * @cloudflare/workers-types@4.20260603.1 declaration — Open Question 1 closed in
 * 00-03, re-confirmed here): `DurableObject<Env>` is exported from
 * "cloudflare:workers"; `constructor(ctx: DurableObjectState, env: Env)`; the
 * protected base field is `ctx` (NOT `state`), with `this.ctx.blockConcurrencyWhile`
 * and `this.env.DB`.
 */
export class StewardWriter extends DurableObject<Env> {
  /**
   * Apply one §6.4 Wire event atomically + serially. Returns `{applied:false}` on
   * a replay (the idempotency key was already in the ledger ⇒ counter unchanged,
   * meta.changes === 0) and `{applied:true}` on first application.
   *
   * IMPORTANT (C2 / blockConcurrencyWhile): if the callback passed to
   * `blockConcurrencyWhile` THROWS, workerd resets/aborts the Durable Object (the
   * input gate breaks). A deliberate contract-violation throw (e.g. a non-integer
   * delta → NonRetryableError) must NOT brick the single Vault writer. So we CAPTURE
   * any throw from `applyEvent` INSIDE the gate (the callback returns normally) and
   * RE-THROW it AFTER the gate closes — the consumer still sees the same error (and
   * maps a NonRetryableError to ack()+P3), but the DO stays healthy and serialized.
   */
  async apply(e: WireEvent): Promise<{ applied: boolean }> {
    const outcome = await this.ctx.blockConcurrencyWhile(
      async (): Promise<
        { ok: true; value: { applied: boolean } } | { ok: false; error: unknown }
      > => {
        try {
          return { ok: true, value: await applyEvent(this.env.DB, e) };
        } catch (error) {
          // Captured, not thrown — the gate callback resolves normally so the DO is
          // not reset. The atomic db.batch() already rolled back on error.
          return { ok: false, error };
        }
      },
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * Read a counter's absolute value (positional `?`). Used by the replay/serialize
   * tests to assert the post-apply counter (e.g. 1 not 2 after a replay).
   */
  async counter(entity: string): Promise<{ value: number }> {
    const row = await this.env.DB.prepare(
      "SELECT value FROM counters WHERE entity = ?",
    )
      .bind(entity)
      .first<{ value: number }>();
    return { value: row?.value ?? 0 };
  }
}
