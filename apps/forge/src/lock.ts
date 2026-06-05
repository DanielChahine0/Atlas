/**
 * ForgeLock — the per-run dedupe/idempotency lock Durable Object (SQLite-backed).
 *
 * Forge's dedupe+write critical section must be serialized so two overlapping morning runs
 * cannot both miss the dedupe check and double-insert. This DO runs the upsert batch inside
 * `ctx.blockConcurrencyWhile` (the same Steward-style discipline in CLAUDE.md: the atomic
 * section is held under the lock; nothing slow runs inside it).
 *
 * It is addressed by run date (`env.FORGE_LOCK.getByName(date)`) so all of a date's task
 * writes serialize through one instance. The DO itself does NOT call the model or the Wire —
 * it only runs the supplied write closure under the concurrency gate.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "@atlas/shared";

export class ForgeLock extends DurableObject<Env> {
  /**
   * Run a write closure under the DO's single-threaded concurrency gate. The closure does
   * the dedupe+upsert against D1; holding it in blockConcurrencyWhile serializes concurrent
   * runs so the dedupe check and the insert are atomic with respect to each other.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return await this.ctx.blockConcurrencyWhile(fn);
  }
}
