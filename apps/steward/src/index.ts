/**
 * Steward — the sole Vault writer DO and the SINGLE reader of the Wire (Pillar 1).
 *
 * Phase 0, Plan 04 (Wave 3): the StewardWriter critical section (atomic dedup +
 * conditional absolute counter bump in ONE db.batch() inside
 * blockConcurrencyWhile — steward.ts), the single `atlas-wire` consumer
 * (steward-consumer.ts), and the consumers block in wrangler.jsonc all land here.
 *
 * Phase 2, Plan 07 (D2-11): the Fri-16:30 weekly-review build. The default export becomes a
 * `WorkerEntrypoint` so Atlas can RPC `env.STEWARD.weeklyReviewBuild({date})` over the service
 * binding (no `entrypoint` on the binding → it targets THIS default export). The class STILL
 * carries the single `atlas-wire` `queue()` consumer (delegated verbatim to stewardConsumer) —
 * Steward remains the SOLE consumer of atlas-wire (Pillar 1); no second consumer is introduced.
 * The build compiles the weekly note and emits ONE op:"upsert" Wire event via the existing
 * producer path; Steward's own consumer applies it through applyEvent → vault_outbox, so there
 * is no new Vault writer either.
 *
 * One name = one instance: env.STEWARD_LOCK.getByName("vault") is the single
 * serialized Vault write lock.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { localDate } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import { stewardConsumer, type Env } from "./steward-consumer.js";
import { weeklyReview, type WeeklyReviewInput } from "./weekly-review.js";

export { StewardWriter } from "./steward.js";
export type { Env } from "./steward-consumer.js";

/**
 * The Steward Worker entrypoint. Combines (a) the SINGLE atlas-wire `queue()` consumer
 * (Pillar 1 — delegated to stewardConsumer.queue, unchanged), (b) the no-public-surface
 * `fetch()` stub, and (c) the Phase-2 `weeklyReviewBuild()` RPC method Atlas's Fri-16:30 cron
 * case invokes. A `WorkerEntrypoint` default export can host all three; the service binding
 * with no `entrypoint` resolves RPC calls against this class.
 */
export default class Steward extends WorkerEntrypoint<Env> {
  /**
   * The SOLE atlas-wire consumer (Pillar 1) — delegated verbatim to stewardConsumer.queue so
   * the critical-section / malformed / DLQ behavior is byte-for-byte unchanged. The consumer
   * acks/retries per-message and does not use ctx, so only batch + env are forwarded.
   */
  override async queue(batch: MessageBatch<WireEvent>): Promise<void> {
    await stewardConsumer.queue(batch, this.env);
  }

  /**
   * No public HTTP surface in Phase 0/2 (the outbound bridge endpoints land in 00-08). This
   * stub keeps the Worker buildable + serves a liveness string.
   */
  override async fetch(_request: Request): Promise<Response> {
    return new Response("steward: sole Vault writer + single Wire consumer\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  /**
   * The Fri-16:30 weekly-review build RPC (D2-11). Atlas's standalone cron case calls
   * env.STEWARD.weeklyReviewBuild({date}). Compiles the week's surfaced events + Herald digest
   * + funnel snapshot + open flags into ONE weekly note and writes it through the EXISTING
   * vault path (a single op:"upsert" Wire event Steward's own consumer applies) — no new writer,
   * no new consumer (Pillar 1). Idempotent: re-running for the same date REPLACES the note
   * (stable steward:weekly-review:<date> key; the ledger dedups the second apply).
   *
   * v1 reads an EMPTY week (the live D1/digest/funnel/flags reads wire in at go-live, matching
   * Scout/Headhunter's injectable-data deferral). The note still renders a real quiet-week
   * summary — not a stub. The Atlas leg is fire-and-forget under waitUntil with a catch→flag,
   * so this returns void.
   */
  async weeklyReviewBuild(params?: { date?: string }): Promise<void> {
    const date = params?.date ?? localDate(this.env);
    await weeklyReview(this.env, date, emptyWeek());
  }
}

/**
 * The v1 empty-week inputs (the live reads from D1 events / herald:weekly / funnel counters /
 * open flags wire in at go-live). A genuine quiet-week summary renders from this — NOT a
 * placeholder. Factored out so the live wiring later replaces ONLY this function.
 */
function emptyWeek(): WeeklyReviewInput {
  return {
    events: [],
    heraldDigest: null,
    funnel: { applied: 0, oa: 0, interview: 0, offer: 0, rejection: 0 },
    openFlags: [],
  };
}
