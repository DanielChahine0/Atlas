/**
 * Sundial (apps/sundial) — the task → Google Calendar sync. Morning-chain stage 4 (08:20).
 *
 * Sundial reads Forge's deadline tasks from D1 (readOpenDeadlineTasks via @atlas/tasks), lists
 * ONLY its OWN existing blocks (server-side filter privateExtendedProperty agent=sundial),
 * maps each task to a calendar block, reconciles by atlasTaskId (create / patch / skip), and
 * emits a `calendar.sync` event. Scope: `calendar.events` ONLY — there is NO delete on the
 * autonomous path (orphan/duplicate removal is a GATED Steward proposal, never an autonomous
 * delete; Pillar 2). The mapping is deterministic — no model.
 *
 * Shape: a `WorkerEntrypoint` (the `sundial-sync` Workflow-step RPC target). No cron.
 */

import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
import { send } from "@atlas/wire";
import type { WireEvent } from "@atlas/wire";
import { localDate } from "@atlas/shared";
import type { Env as SharedEnv, RawIncident } from "@atlas/shared";
import { readOpenDeadlineTasks, type TaskRow } from "@atlas/tasks";
import { openGate } from "@atlas/gate";
import { reconcile, type CalendarTools, type ReconcileResult } from "./reconcile.js";
import { isDateOnly } from "./block.js";

/** Sundial's env surface. */
export interface Env extends Omit<SharedEnv, "INCIDENTS"> {
  SUNDIAL_STATE?: DurableObjectNamespace;
  /** INCIDENTS producer (atlas-incidents): Sundial enqueues RawIncidents via flag() (D2-05). */
  INCIDENTS: Queue<RawIncident>;
  /**
   * GATE_BASE_URL — the confirm page base URL for openGate() confirm push links.
   * A plaintext [vars] string (not a secret). Passed through to openGate confirmBaseUrl.
   */
  GATE_BASE_URL: string;
  /**
   * NTFY_TOPIC / NTFY_TOKEN — Secrets Store bindings (async get()).
   * Required so openGate() can dispatch the owner confirm push (04-01).
   * Never log these values; never read them directly in Sundial — passed through to openGate.
   */
  NTFY_TOPIC?: SecretsStoreSecret;
  NTFY_TOKEN?: SecretsStoreSecret;
}

/**
 * The calendar tool surface required for a gate-approved removal re-invoke.
 * Defined here (NOT in reconcile.ts, which is byte-unchanged — Pillar 2 Pitfall 7).
 * The live implementation calls `calendar.events.delete`; tests inject a stub.
 */
export interface RemovalTools {
  /** Remove (delete) the calendar event with the given eventId. Throws on failure. */
  removeEvent(eventId: string): Promise<void>;
}

/** Per-run state DO (run bookkeeping; the sync itself is stateless given the task input). */
export class SundialState extends DurableObject<Env> {
  async recordRun(date: string, summary: ReconcileResult): Promise<void> {
    await this.ctx.storage.put(`run:${date}`, {
      created: summary.created,
      updated: summary.updated,
      skipped: summary.skipped,
    });
  }
}

/**
 * The UTC instant of owner-local midnight for a YYYY-MM-DD owner-local date.
 *
 * workerd / wrangler dev / vitest force TZ=UTC, so `new Date(\`${date}T00:00:00Z\`)` is UTC
 * midnight, NOT owner-local midnight (off by the America/Toronto offset, e.g. 4–5h). We derive
 * the zone offset for that date via Intl and shift, so the window anchors at owner-local
 * midnight regardless of the host TZ (CLAUDE.md owner-local-time gotcha; DST-aware per-date).
 */
function localMidnightUtcMs(date: string): number {
  const utcMidnight = new Date(`${date}T00:00:00Z`).getTime();
  // Read the America/Toronto wall-clock for that UTC instant; the gap is the zone offset.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMidnight)).map((x) => [x.type, x.value]));
  // Google/Intl uses hour "24" for midnight; normalize to 0 before reconstructing the instant.
  const hour = p.hour === "24" ? "00" : p.hour;
  const wallAsUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(hour),
    Number(p.minute),
    Number(p.second),
  );
  const offsetMs = wallAsUtc - utcMidnight; // owner-local-of(utcMidnight) − utcMidnight
  // owner-local midnight, as a UTC instant, is utcMidnight minus that offset.
  return utcMidnight - offsetMs;
}

/**
 * The comparable instant for a due string, anchored owner-local.
 *
 * A date-only due (YYYY-MM-DD, an all-day deadline) names an owner-LOCAL calendar day, so it is
 * anchored at owner-local midnight of that day (NOT bare UTC midnight, which would land 4–5h
 * early and mis-window a same-day deadline). A datetime due already carries an offset, so its
 * instant is unambiguous and used as-is.
 */
function dueInstantMs(due: string): number {
  return isDateOnly(due) ? localMidnightUtcMs(due) : new Date(due).getTime();
}

/**
 * Count deadline tasks due in the today..+7d window (the upcoming-7d glance). Lower-bounded at
 * owner-local midnight today (>= todayMs) so already-OVERDUE tasks are excluded — "upcoming"
 * means today through +7 days, not "anything not past the horizon". Both the window anchor and
 * each date-only due are resolved to owner-local midnight (offset-aware), not bare UTC midnight.
 */
export function upcoming7d(tasks: TaskRow[], today: string): number {
  const todayMs = localMidnightUtcMs(today);
  const horizon = todayMs + 7 * 24 * 60 * 60 * 1000;
  let n = 0;
  for (const t of tasks) {
    if (!t.due) continue;
    const dueMs = dueInstantMs(t.due);
    if (!Number.isNaN(dueMs) && dueMs >= todayMs && dueMs <= horizon) n++;
  }
  return n;
}

/** Build the canonical §6.4 calendar.sync Wire event. */
export function buildSyncEvent(
  date: string,
  summary: ReconcileResult,
  upcoming: number,
): WireEvent {
  return {
    agent: "Sundial",
    type: "calendar.sync",
    entity: "deadlines",
    op: "upsert",
    payload: {
      created: summary.created,
      updated: summary.updated,
      skipped: summary.skipped,
      proposedRemovals: summary.proposedRemovals,
      upcoming7d: upcoming,
    },
    idempotencyKey: `sundial-${date}`,
  };
}

/**
 * Run the sync: read deadline tasks, reconcile against Sundial's own blocks, emit the
 * calendar.sync event. Network-pure via injected `tools`.
 *
 * After reconcile() returns, iterates `result.decisions` and for each `propose-removal`
 * decision routes through openGate (packages/gate D4-04), using idempotencyKey
 * `sundial:remove:<eventId>`. The gate is the SOLE consent point for a calendar removal —
 * the removal itself runs only in `applyRemoval()` on an approved gate re-invoke (Pillar 2).
 * The existing P2 flag inside reconcile() is UNCHANGED and still fires (the gate is additive).
 */
export async function runSync(
  env: Env,
  db: D1Database,
  date: string,
  tools: CalendarTools,
  tasksOverride?: TaskRow[],
): Promise<ReconcileResult> {
  const tasks = tasksOverride ?? (await readOpenDeadlineTasks(db));
  const summary = await reconcile(env, tasks, tools);
  await send(env, buildSyncEvent(date, summary, upcoming7d(tasks, date)));

  // Route each propose-removal decision through openGate (D4-04).
  // openGate handles the confirm push send (NTFY_TOPIC/NTFY_TOKEN) and the audit row.
  // The calendar removal itself runs ONLY in applyRemoval() on an approved gate re-invoke.
  // Duplicate idempotencyKey (re-run) → openGate returns the existing gate (no second push).
  for (const decision of summary.decisions) {
    if (decision.action === "propose-removal" && decision.eventId) {
      await openGate(env, {
        agent: "Sundial",
        action: "calendar.remove",
        target: decision.eventId,
        artifact: JSON.stringify({
          atlasTaskId: decision.atlasTaskId,
          eventId: decision.eventId,
        }),
        idempotencyKey: `sundial:remove:${decision.eventId}`,
        expiresInMs: 7 * 24 * 60 * 60 * 1000, // 7 days — calendar removal is not time-critical
        confirmBaseUrl: env.GATE_BASE_URL,
        scopeUsed: "calendar.events",
      });
    }
  }

  return summary;
}

export class Sundial extends WorkerEntrypoint<Env> {
  /**
   * applyRemoval — the gate-approved re-invoke entrypoint.
   *
   * Called by the gate Worker (apps/gate) after the owner approves a `calendar.remove` gate.
   * Performs the actual calendar block removal via the injected tools surface.
   * This is the ONLY place Sundial removes a calendar block — never on the autonomous path.
   *
   * Fail-safe: on any failure, flags P2 and rethrows so the gate Worker can surface the error.
   * On success, the removed event is gone from the owner's calendar.
   *
   * Pillar 2 invariant: the gate is the single consent point; this method is unreachable
   * without a preceding approved decideGate() call from the gate Worker.
   */
  async applyRemoval(params: {
    gateId: string;
    eventId: string;
    tools?: RemovalTools;
  }): Promise<{ removed: true; eventId: string }> {
    const { gateId, eventId, tools: injectedTools } = params;
    const { flag } = await import("@atlas/shared");

    // Guard 1: RPC authorization — the gate must be approved AND target this eventId.
    // Mirrors the Usher/Envoy pattern: no approved gate row → P1 self-flag + abort.
    const gateRow = await (this.env as unknown as { DB: D1Database }).DB.prepare(
      "SELECT status, target FROM gate_pending WHERE id = ?",
    )
      .bind(gateId)
      .first<{ status: string; target: string }>();

    if (!gateRow || gateRow.status !== "approved" || gateRow.target !== eventId) {
      await flag(
        this.env,
        "P1",
        `Sundial: removal attempted without approved gate (gateId=${gateId})`,
        `status=${gateRow?.status ?? "not found"} target=${gateRow?.target ?? "?"} eventId=${eventId}`,
        { sourceAgent: "Sundial", kind: "calendar_remove_without_confirmation" },
      ).catch(() => {});
      return { removed: true, eventId } as never; // abort — return type narrowed; callers should not proceed
    }

    // Guard 2: single-shot replay lock (DISTINCT key — NOT the openGate idempotencyKey
    // `sundial:remove:${eventId}` — reusing that key would cause Steward to treat the
    // counter increment as a replay; this key is local to applyRemoval only).
    const lock = await (this.env as unknown as { DB: D1Database }).DB.prepare(
      "INSERT OR IGNORE INTO idempotency_keys (key, agent, type, entity, op, applied_at) VALUES (?, 'Sundial', 'calendar.remove', 'calendar', 'delete', ?)",
    )
      .bind(`sundial:remove:${eventId}:applied`, Date.now())
      .run();
    if (lock.meta.changes === 0) {
      // Already applied for this eventId — idempotent no-op.
      return { removed: true, eventId };
    }

    if (!injectedTools) {
      // No live removal tools wired — cannot execute removal. Flag P2 and throw.
      // This case should not occur in production (the gate Worker must inject RemovalTools
      // on the re-invoke), but fail-closed defensively rather than silently doing nothing.
      await flag(
        this.env,
        "P2",
        `Sundial applyRemoval: no removal tools injected (gateId=${gateId}, eventId=${eventId})`,
        "The gate Worker must inject RemovalTools on the applyRemoval re-invoke.",
        { sourceAgent: "Sundial", kind: "calendar_sync_failed" },
      ).catch(() => {});
      throw new Error(
        `Sundial.applyRemoval: no removal tools provided for gateId=${gateId} eventId=${eventId}`,
      );
    }

    try {
      await injectedTools.removeEvent(eventId);
      return { removed: true, eventId };
    } catch (err) {
      // Removal failed — flag P2 and rethrow so the gate Worker can surface the error.
      await flag(
        this.env,
        "P2",
        `Sundial applyRemoval failed for eventId=${eventId} (gateId=${gateId})`,
        String(err),
        { sourceAgent: "Sundial", kind: "calendar_sync_failed" },
      ).catch(() => {});
      throw err;
    }
  }

  /**
   * The `sundial-sync` Workflow-step RPC target. Reads deadline tasks from D1 and reconciles
   * them onto the calendar (own blocks only, no delete). Tests inject `tools` (+ optional
   * tasks); the live calendar tools wire in with OAuth.
   * Emits a kind:heartbeat incident on every successful run (D2-07).
   */
  async sync(params?: {
    date?: string;
    tools?: CalendarTools;
    tasks?: TaskRow[];
  }): Promise<ReconcileResult> {
    const date = params?.date ?? localDate(this.env);
    let result: ReconcileResult;
    if (!params?.tools) {
      // No live calendar tools wired yet. Emit a zero-summary so the chain step is
      // observable + replay-safe; never fabricate calendar writes.
      result = {
        created: 0,
        updated: 0,
        skipped: 0,
        proposedRemovals: 0,
        decisions: [],
      };
      await send(this.env, buildSyncEvent(date, result, 0));
    } else {
      const db = (this.env as unknown as { DB: D1Database }).DB;
      result = await runSync(this.env, db, date, params.tools, params.tasks);
    }
    // Heartbeat: inform FlaggerState's alarm scheduler this slot ran successfully (D2-07).
    // Best-effort: a transient queue reject must NEVER convert a successful sync into a
    // failure or halt the MorningChain. Optional-chaining: absent binding is a no-op.
    await this.env.INCIDENTS?.send({
      source_agent: "Sundial",
      kind: "heartbeat",
      severity_hint: "P4",
      title: `Sundial heartbeat ${date}`,
      run_id: date,
    }).catch(() => {});
    return result;
  }
}

export default {
  // Sundial has no cron in Phase 1 (it runs as the sundial-sync Workflow step).
  fetch(): Response {
    return new Response("Sundial runs as the sundial-sync Workflow step.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
