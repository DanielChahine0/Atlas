/**
 * AtlasCoordinator — the orchestrator Durable Object (Phase 0, Plan 03 / Wave 3).
 *
 * Atlas does NO domain work: it schedules, routes, sequences, and SUPERVISES.
 * This DO is the supervision half — a self-monitoring heartbeat. It is addressed
 * as `env.ATLAS.getByName("root")` (CLAUDE.md canonical convention: one name = one
 * instance = one lock; two getByName("root") calls resolve to the SAME DO).
 *
 * D-10 (heartbeat self-monitor): a 1-minute alarm() cadence. If no heartbeat has
 * landed within the 5-minute staleness window, the DO raises a P1 incident toward
 * Flagger over the Wire (a stuck orchestrator surfaces an incident instead of
 * silently halting). alarm() ALWAYS reschedules itself at the end so the heartbeat
 * can never stop (one alarm per DO — setting a new time overwrites; no alarm storm).
 *
 * Pillar 1 (producer-only): this DO emits onto the Wire (via the @atlas/shared
 * flag() helper, which routes through the @atlas/wire parse-then-send producer) and
 * reads its OWN storage. It NEVER writes the Vault/Gmail/Codex and NEVER consumes
 * atlas-wire (Steward is the sole consumer).
 *
 * --- API confirmation (agents@0.14.1 / @cloudflare/workers-types@4.20260603.1) ---
 *   `DurableObject<Env>` is exported from "cloudflare:workers".
 *   constructor(ctx: DurableObjectState, env: Env) — the protected base field is `ctx`
 *   (NOT `state`), with `this.ctx.storage` (DurableObjectStorage): put(key,val) /
 *   get<T>(key) -> Promise<T|undefined> / getAlarm() -> Promise<number|null> /
 *   setAlarm(scheduledTime: number|Date). The handler is `alarm?(alarmInfo?)`.
 *   Confirmed by reading the installed type declaration (experimental/index.d.ts
 *   lines 15161 + 748) — the build-plan T4 snippet matches the installed API verbatim.
 */

import { DurableObject } from "cloudflare:workers";
import { flag } from "@atlas/shared";
import type { Env } from "@atlas/shared";

/** 1-minute alarm cadence (the heartbeat self-monitor tick). */
const HEARTBEAT_CADENCE_MS = 60_000;

/** D-10: the heartbeat staleness window. Stale beyond this -> P1 to Flagger. */
const STALENESS_WINDOW_MS = 5 * 60_000;

export class AtlasCoordinator extends DurableObject<Env> {
  /** Record a liveness beat — the orchestrator pulse the alarm() watches for. */
  async beat(): Promise<void> {
    await this.ctx.storage.put("lastBeat", Date.now());
  }

  /**
   * Arm the self-monitor: schedule the first alarm only if one isn't already set
   * (one alarm per DO). Idempotent — safe to call on every orchestrator startup.
   *
   * C6 (cold-start false-fire): SEED `lastBeat` to now when arming a fresh DO so the
   * first alarm() does NOT read a missing beat as "infinitely stale" and emit a spurious
   * P1. We seed only when no beat exists yet (never clobber a real, more-recent beat from
   * a concurrent arm — benign under DO single-threading, but correct regardless).
   */
  async startHeartbeat(): Promise<void> {
    if ((await this.ctx.storage.get<number>("lastBeat")) == null) {
      await this.ctx.storage.put("lastBeat", Date.now());
    }
    if ((await this.ctx.storage.getAlarm()) == null) {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_CADENCE_MS);
    }
  }

  /**
   * The 1-minute self-monitor. If the last beat is older than the 5-minute
   * staleness window (D-10), raise a P1 incident toward Flagger via flag(), then
   * ALWAYS reschedule the next alarm so the heartbeat never stops.
   */
  override async alarm(): Promise<void> {
    try {
      // C6 (cold-start false-fire): a MISSING lastBeat means the supervisor just started
      // and no beat has landed yet — treat that as "not stale" (NOT epoch 0 = infinitely
      // stale). startHeartbeat() also seeds lastBeat on arm; this is belt-and-suspenders for
      // any path that reached an alarm without an arm. A real overdue beat still fires P1.
      const lastBeat = await this.ctx.storage.get<number>("lastBeat");
      if (lastBeat != null && Date.now() - lastBeat > STALENESS_WINDOW_MS) {
        // Escalate to Flagger over the Wire — NEVER by writing the Vault directly.
        // flag() builds the full flag record and emits the canonical Flagger event
        // (op "upsert" / entity "flag" / idempotencyKey === the structured flag id),
        // so a replay re-upserts the same board row (no duplicate row). The owner-local
        // date in that id is derived via Intl/America/Toronto inside flag() (TZ=UTC
        // gotcha); we surface the same owner-local date in the detail for observability.
        const localDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Toronto",
        }).format(new Date());
        // C7 (heartbeat must never stop): the flag() emit is BEST-EFFORT. A throwing
        // flag()/WIRE.send must NOT be able to kill supervision — swallow it here so the
        // finally-block reschedule below always runs. (A lost staleness flag is recoverable
        // on the next tick; a stopped heartbeat is not.)
        try {
          await flag(
            this.env,
            "P1",
            "orchestrator heartbeat stale",
            `No Atlas heartbeat within the ${STALENESS_WINDOW_MS / 60_000}-minute staleness window (D-10) as of ${localDate}; the orchestrator may be stuck.`,
          );
        } catch {
          // best-effort: never let a flag emit failure stop the heartbeat (C7).
        }
      }
    } finally {
      // C7: reschedule in `finally` so the next alarm is ALWAYS armed, regardless of any
      // throw above — the heartbeat can never stop (one alarm per DO; setting a new time
      // overwrites, so no alarm storm).
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_CADENCE_MS);
    }
  }
}
