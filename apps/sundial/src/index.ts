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
import type { Env as SharedEnv } from "@atlas/shared";
import { readOpenDeadlineTasks, type TaskRow } from "@atlas/tasks";
import { reconcile, type CalendarTools, type ReconcileResult } from "./reconcile.js";
import { isDateOnly } from "./block.js";

/** Sundial's env surface. */
export interface Env extends SharedEnv {
  SUNDIAL_STATE?: DurableObjectNamespace;
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
  return summary;
}

export class Sundial extends WorkerEntrypoint<Env> {
  /**
   * The `sundial-sync` Workflow-step RPC target. Reads deadline tasks from D1 and reconciles
   * them onto the calendar (own blocks only, no delete). Tests inject `tools` (+ optional
   * tasks); the live calendar tools wire in with OAuth.
   */
  async sync(params?: {
    date?: string;
    tools?: CalendarTools;
    tasks?: TaskRow[];
  }): Promise<ReconcileResult> {
    const date = params?.date ?? localDate(this.env);
    if (!params?.tools) {
      // No live calendar tools wired yet. Emit a zero-summary so the chain step is
      // observable + replay-safe; never fabricate calendar writes.
      const empty: ReconcileResult = {
        created: 0,
        updated: 0,
        skipped: 0,
        proposedRemovals: 0,
        decisions: [],
      };
      await send(this.env, buildSyncEvent(date, empty, 0));
      return empty;
    }
    const db = (this.env as unknown as { DB: D1Database }).DB;
    return await runSync(this.env, db, date, params.tools, params.tasks);
  }
}

export default {
  // Sundial has no cron in Phase 1 (it runs as the sundial-sync Workflow step).
  fetch(): Response {
    return new Response("Sundial runs as the sundial-sync Workflow step.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
