/**
 * state.ts — HeadhunterState Durable Object.
 *
 * Addressed as `env.HEADHUNTER_STATE.getByName("pipeline")` — one name = one instance.
 * Serializes concurrent full() + deadlines() runs on the same window row via
 * `blockConcurrencyWhile`. Follows the exact StewardWriter pattern (steward.ts lines 42-56):
 *   - blockConcurrencyWhile callback NEVER throws (capture inside, re-throw after gate closes)
 *   - error is returned from callback as { ok: false, error } to keep the DO healthy
 *
 * Declaration: `new_sqlite_classes: ["HeadhunterState"]` in wrangler.jsonc migrations.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.js";

/** Valid window status transitions (state machine). */
export type WindowStatus = "upcoming" | "open" | "closing" | "closed";

/** A persisted per-window record in DO storage. */
interface WindowStateRow {
  windowId: string;
  status: WindowStatus;
  lastSeenOpen: string | null;
  updatedAt: number;
}

/**
 * HeadhunterState DO — serializes window status transitions.
 *
 * Uses blockConcurrencyWhile to ensure that if full() and deadlines() are running
 * concurrently (e.g. Atlas fires both at the same millisecond), the window status
 * transitions are serialized — no racing updates to the same window row.
 *
 * DO storage is the source of truth for live window state; D1 is the audit trail.
 */
export class HeadhunterState extends DurableObject<Env> {
  /**
   * Advance a window's status. Serializes via blockConcurrencyWhile.
   * Pattern from StewardWriter: capture error inside the gate, re-throw after.
   *
   * @param windowId  stable window id (e.g. "google:fall-2026:new-grad")
   * @param newStatus  the target status
   * @param lastSeenOpen  optional ISO-8601 date to update last_seen_open
   */
  async advanceWindow(
    windowId: string,
    newStatus: WindowStatus,
    lastSeenOpen?: string,
  ): Promise<void> {
    const outcome = await this.ctx.blockConcurrencyWhile(
      async (): Promise<{ ok: true } | { ok: false; error: unknown }> => {
        try {
          const existing = await this.ctx.storage.get<WindowStateRow>(`win:${windowId}`);
          const now = Date.now();

          // Only advance (never regress) — open→closing→closed is the valid direction
          // If the stored status is "closed", we don't re-open it
          if (existing && !canAdvance(existing.status, newStatus)) {
            // No-op for illegal transitions (closed window stays closed)
            return { ok: true };
          }

          const updated: WindowStateRow = {
            windowId,
            status: newStatus,
            lastSeenOpen: lastSeenOpen ?? existing?.lastSeenOpen ?? null,
            updatedAt: now,
          };

          await this.ctx.storage.put(`win:${windowId}`, updated);
          return { ok: true };
        } catch (error) {
          // CAPTURE inside gate so the DO stays healthy (callback never throws)
          return { ok: false, error };
        }
      },
    );

    // Re-throw AFTER the gate closes — the DO is healthy, caller sees the error
    if (!outcome.ok) throw outcome.error;
  }

  /**
   * Read current window state (outside the lock — reads are safe without serialization).
   */
  async getWindowState(windowId: string): Promise<WindowStateRow | null> {
    return (await this.ctx.storage.get<WindowStateRow>(`win:${windowId}`)) ?? null;
  }
}

/**
 * State machine: valid transitions.
 * upcoming → open → closing → closed
 * No backward transitions allowed.
 */
function canAdvance(current: WindowStatus, next: WindowStatus): boolean {
  const order: Record<WindowStatus, number> = {
    upcoming: 0,
    open: 1,
    closing: 2,
    closed: 3,
  };
  return order[next] > order[current];
}
