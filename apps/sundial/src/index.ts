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

/** Count deadline tasks due within the next 7 days (for the upcoming-7d glance). */
export function upcoming7d(tasks: TaskRow[], today: string): number {
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();
  const horizon = todayMs + 7 * 24 * 60 * 60 * 1000;
  let n = 0;
  for (const t of tasks) {
    if (!t.due) continue;
    const dueMs = new Date(t.due).getTime();
    if (!Number.isNaN(dueMs) && dueMs <= horizon) n++;
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
