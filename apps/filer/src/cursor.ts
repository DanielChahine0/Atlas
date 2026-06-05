/**
 * FilerCursor — the per-account Gmail cursor Durable Object (SQLite-backed).
 *
 * Holds the continuous-push state: the Gmail `historyId` (the watermark history.list
 * advances from) and the `users.watch` expiration. Addressed by account
 * (`env.FILER_CURSOR.getByName(account)`), so one account = one cursor = one watermark.
 *
 * Pillar 1: this DO reads/writes ONLY its own storage. It never consumes atlas-wire and
 * never writes the Vault/Gmail. The continuous-push path that drives it is flag-gated off
 * (CONFIG `filer.push_enabled` = false) until D1-06 gateway ceilings are set; the 07:45
 * sweep does not need the cursor (it queries `newer_than:2d -label:AI/Reviewed`).
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "@atlas/shared";

/** The persisted cursor state for one Gmail account. */
export interface CursorState {
  /** The Gmail history watermark history.list advances from (string per the API). */
  historyId: string | null;
  /** Epoch-ms when the current users.watch expires (renew before this). */
  watchExpiration: number | null;
}

export class FilerCursor extends DurableObject<Env> {
  /** Read the current cursor state (defaults when never set). */
  async get(): Promise<CursorState> {
    const historyId = (await this.ctx.storage.get<string>("historyId")) ?? null;
    const watchExpiration = (await this.ctx.storage.get<number>("watchExpiration")) ?? null;
    return { historyId, watchExpiration };
  }

  /** Advance the history watermark (history.list / watch start returns the new id). */
  async setHistoryId(historyId: string): Promise<void> {
    await this.ctx.storage.put("historyId", historyId);
  }

  /** Record the watch expiration so the 06:00 renewal cron knows when to re-arm. */
  async setWatchExpiration(epochMs: number): Promise<void> {
    await this.ctx.storage.put("watchExpiration", epochMs);
  }
}
