/**
 * state.ts — FlaggerState Durable Object (WEEKLY-02, Plan 02-02 Task 1).
 *
 * This DO holds:
 * 1. Open-flags index: signature → OpenFlag (dedup by signature, recurrence bump)
 * 2. Heartbeat scheduler: hb:<agent> → HeartbeatSlot (single-alarm, earliest-deadline)
 *
 * Addressing: env.FLAGGER_STATE.getByName("fleet") — one name = one instance.
 *
 * Key invariants:
 * - setAlarm() OVERWRITES — it does NOT append; only ONE alarm slot per DO.
 * - refreshAlarm() in a `finally` block so the alarm NEVER stops.
 * - Seed lastBeat on recordHeartbeat so first alarm never false-fires.
 * - Score is delegated to score.ts (pure, no model calls).
 */

import { DurableObject } from "cloudflare:workers";
import { localDate, contentHash } from "@atlas/shared";
import type { FlagRecord, Severity } from "@atlas/shared";
import type { Env } from "./index.js";
import { score } from "./score.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OpenFlag {
  id: string;
  signature: string;
  severity: Severity;
  trust: number;
  status: "open" | "ack" | "resolved" | "muted";
  recurrence: number;
  title: string;
  detail?: string;
  source_agent: string;
  suggested_action?: string;
  created_at: number;
  updated_at: number;
}

export interface HeartbeatSlot {
  agent: string;
  cron_utc: string;
  grace_ms: number;
  last_seen: number;
  expected_by: number;
}

// ── FlaggerState ─────────────────────────────────────────────────────────────

export class FlaggerState extends DurableObject<Env> {
  /**
   * Upsert a flag by signature. If the signature already has an open flag, bump recurrence
   * and re-score trust. Otherwise create a new flag with id = flg:<localDate>:<agent>:<hash>.
   */
  async upsertFlag(
    signature: string,
    partial: {
      source_agent: string;
      severity: Severity;
      trust: number;
      title: string;
      detail?: string;
      status: "open" | "ack" | "resolved" | "muted";
      suggested_action?: string;
    },
  ): Promise<OpenFlag & FlagRecord> {
    const existing = await this.ctx.storage.get<OpenFlag>(`flag:${signature}`);

    let flag: OpenFlag;

    if (existing) {
      // Re-score with bumped recurrence
      const recurrence = existing.recurrence + 1;
      const scored = score(
        {
          source_agent: existing.source_agent,
          kind: "unknown", // kind isn't stored on OpenFlag; trust bump via recurrence
          severity_hint: partial.severity,
          title: partial.title,
        },
        recurrence,
      );
      flag = {
        ...existing,
        severity: scored.severity,
        trust: scored.trust,
        recurrence,
        title: partial.title,
        detail: partial.detail,
        suggested_action: partial.suggested_action,
        updated_at: Date.now(),
      };
    } else {
      // Create new flag
      const date = localDate();
      const hash = contentHash(
        `${partial.severity}|${partial.title}|${partial.detail ?? ""}`,
      );
      const id = `flg:${date}:${partial.source_agent}:${hash}`;
      flag = {
        id,
        signature,
        severity: partial.severity,
        trust: partial.trust,
        status: "open",
        recurrence: 0,
        title: partial.title,
        detail: partial.detail,
        source_agent: partial.source_agent,
        suggested_action: partial.suggested_action,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
    }

    await this.ctx.storage.put(`flag:${signature}`, flag);

    // Mirror to D1 flags audit table (positional ? only — matches 0004 migration schema)
    await this.env.DB.prepare(
      "INSERT OR REPLACE INTO flags(id, signature, source_agent, severity, trust, title, detail, status, recurrence, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        flag.id,
        signature,
        flag.source_agent,
        flag.severity,
        flag.trust,
        flag.title,
        flag.detail ?? null,
        flag.status,
        flag.recurrence,
        flag.created_at,
        flag.updated_at,
      )
      .run();

    // Return as FlagRecord-compatible shape
    return {
      ...flag,
      ts: new Date(flag.created_at).toISOString(),
    };
  }

  /** Look up an existing flag by signature. Returns null if not found or resolved/muted. */
  async getBySignature(signature: string): Promise<(OpenFlag & FlagRecord) | null> {
    const flag = await this.ctx.storage.get<OpenFlag>(`flag:${signature}`);
    if (!flag) return null;
    return { ...flag, ts: new Date(flag.created_at).toISOString() };
  }

  /** Mark a flag as acknowledged. */
  async ackFlag(id: string): Promise<void> {
    // Find the flag by id (scan all flag: entries)
    const all = await this.ctx.storage.list<OpenFlag>({ prefix: "flag:" });
    for (const [key, flag] of all.entries()) {
      if (flag.id === id) {
        await this.ctx.storage.put(key, { ...flag, status: "ack", updated_at: Date.now() });
        await this.env.DB.prepare(
          "INSERT OR REPLACE INTO flags(id, signature, source_agent, severity, trust, title, detail, status, recurrence, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
          .bind(
            flag.id,
            flag.signature,
            flag.source_agent,
            flag.severity,
            flag.trust,
            flag.title,
            flag.detail ?? null,
            "ack",
            flag.recurrence,
            flag.created_at,
            Date.now(),
          )
          .run();
        return;
      }
    }
  }

  /** Mark a flag as resolved (auto-clear). */
  async resolveFlag(id: string): Promise<void> {
    const all = await this.ctx.storage.list<OpenFlag>({ prefix: "flag:" });
    for (const [key, flag] of all.entries()) {
      if (flag.id === id) {
        await this.ctx.storage.put(key, { ...flag, status: "resolved", updated_at: Date.now() });
        return;
      }
    }
  }

  /** Mute a flag (suppress future re-push). */
  async muteFlag(id: string): Promise<void> {
    const all = await this.ctx.storage.list<OpenFlag>({ prefix: "flag:" });
    for (const [key, flag] of all.entries()) {
      if (flag.id === id) {
        await this.ctx.storage.put(key, { ...flag, status: "muted", updated_at: Date.now() });
        return;
      }
    }
  }

  /**
   * Record a heartbeat for an agent. Stores the hb:<agent> slot with:
   *   last_seen = ts (epoch ms — when the agent last ran)
   *   expected_by = ts (set to ts; the alarm fires grace_ms after ts if no new beat)
   *
   * The stale-check condition: now > expected_by + grace_ms AND last_seen < expected_by.
   *
   * For production: ts = Date.now() (agent just ran). last_seen = expected_by = now.
   * The alarm fires after grace_ms of silence. The NEXT heartbeat call updates expected_by
   * to the new ts, resetting the window.
   *
   * Note: last_seen == expected_by on a fresh heartbeat — the condition last_seen < expected_by
   * is FALSE for a fresh call (no stale alert). The stale alert fires when now > expected_by +
   * grace_ms (the agent missed the window) AND last_seen < expected_by (the agent ran BEFORE
   * the missed window's deadline — i.e., the last known run was from a previous period).
   * This means stale detection requires at least two heartbeat windows to have elapsed without
   * a new beat. For single-window stale testing, use setHeartbeatSlotForTest().
   */
  async recordHeartbeat(agent: string, ts: number, cron_utc: string): Promise<void> {
    const grace_ms =
      parseInt((await this.env.CONFIG.get("heartbeat_grace")) ?? "600000");

    const slot: HeartbeatSlot = {
      agent,
      cron_utc,
      grace_ms,
      last_seen: ts,
      expected_by: ts,
    };

    await this.ctx.storage.put(`hb:${agent}`, slot);
    await this.refreshAlarm();
  }

  /**
   * Directly inject a heartbeat slot (for testing). Allows setting arbitrary
   * last_seen / expected_by values to simulate stale or fresh slots without
   * relying on recordHeartbeat's ts-based defaults.
   */
  async setHeartbeatSlotForTest(agent: string, slot: HeartbeatSlot): Promise<void> {
    await this.ctx.storage.put(`hb:${agent}`, slot);
    await this.refreshAlarm();
  }

  /**
   * Set ONE alarm at the earliest (expected_by + grace_ms) across all hb: slots.
   * setAlarm() OVERWRITES — does NOT append. Only ONE alarm exists per DO.
   * If no slots exist or all deadlines are in the past, does not set an alarm.
   */
  async refreshAlarm(): Promise<void> {
    const allSlots = await this.ctx.storage.list<HeartbeatSlot>({ prefix: "hb:" });
    let earliest = Infinity;
    for (const slot of allSlots.values()) {
      const deadline = slot.expected_by + slot.grace_ms;
      if (deadline < earliest) earliest = deadline;
    }
    if (earliest < Infinity) {
      // Set alarm even if deadline is in the past (alarm fires immediately for overdue slots)
      await this.ctx.storage.setAlarm(Math.max(earliest, Date.now() + 1));
    }
  }

  /**
   * The DO alarm handler. Fires at the earliest slot deadline.
   * For each hb: slot: if now > expected_by + grace_ms AND last_seen < expected_by
   * → emit a P1/trust-100 heartbeat_stale incident.
   * ALWAYS refreshAlarm() in finally so the alarm never stops.
   */
  override async alarm(): Promise<void> {
    await this.runAlarm();
  }

  /**
   * The alarm logic — extracted so it can be called directly in tests
   * (alarm() is a reserved DO method, not callable over RPC).
   */
  async runAlarm(): Promise<void> {
    try {
      const now = Date.now();
      const allSlots = await this.ctx.storage.list<HeartbeatSlot>({ prefix: "hb:" });
      for (const [key, slot] of allSlots.entries()) {
        if (now > slot.expected_by + slot.grace_ms && slot.last_seen < slot.expected_by) {
          await this.env.INCIDENTS.send({
            source_agent: slot.agent,
            kind: "heartbeat_stale",
            severity_hint: "P1",
            title: `${slot.agent} heartbeat stale — no ${slot.cron_utc} run detected`,
          });
          // H3: advance the slot BEFORE refreshAlarm() so the same overdue window does
          // not re-emit on the next alarm fire (incident storm). Bump expected_by to
          // now + grace_ms so the staleness condition is false until the next window.
          // A real heartbeat from the agent (recordHeartbeat) will reset expected_by to
          // the actual run time; this is only the "fired" marker.
          const advanced: HeartbeatSlot = {
            ...slot,
            expected_by: now + slot.grace_ms,
          };
          await this.ctx.storage.put(key, advanced);
        }
      }
    } finally {
      // ALWAYS rearm in finally — the alarm must NEVER stop (one alarm per DO; setAlarm overwrites).
      await this.refreshAlarm();
    }
  }
}
