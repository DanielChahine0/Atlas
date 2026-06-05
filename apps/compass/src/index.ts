/**
 * Compass (apps/compass) — the daily planner and LAST chain stage. Stage 5 (08:30).
 *
 * Compass reads open tasks (D1 via @atlas/tasks) + today's calendar (read-only) + Codex prefs,
 * scores tasks, builds a free/busy grid, bin-packs a time-blocked plan with a top-3, handles
 * overcommitment with a visible "⚠ Couldn't fit today" list + a P3 (surface, never drop), and
 * emits a `day_plan` event (op:upsert — REPLACES the Today note, never appends). Scope:
 * `calendar.readonly` ONLY — Compass NEVER writes/moves a calendar event (one-writer rule).
 *
 * Cost (D1-05): the Opus effort is resolved from CONFIG `compass.effort`, default "medium",
 * never "high" hardcoded.
 *
 * Shape: a `WorkerEntrypoint` (the `compass-plan` Workflow-step RPC target) + an independent
 * 21:00 EDT `preview` cron.
 */

import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
import { send } from "@atlas/wire";
import type { WireEvent } from "@atlas/wire";
import { flag, localDate } from "@atlas/shared";
import type { Env as SharedEnv } from "@atlas/shared";
import { readOpenTasks, type TaskRow } from "@atlas/tasks";
import { buildPlan, demandMinutes, freeMinutes, buildGrid, resolveEffort, type DayPlan } from "./plan.js";
import type { BusyInterval, GridParams } from "./grid.js";

/** Compass's env surface. */
export interface Env extends SharedEnv {
  COMPASS_STATE?: DurableObjectNamespace;
}

/** Per-run state DO (run bookkeeping). */
export class CompassState extends DurableObject<Env> {
  async recordRun(date: string, plan: DayPlan): Promise<void> {
    await this.ctx.storage.put(`plan:${date}`, {
      blocks: plan.blocks.length,
      couldntFit: plan.couldntFit.length,
    });
  }
}

/** The result the plan pass returns to the Workflow step. */
export interface PlanResult {
  plan: DayPlan;
  effort: string;
  overcommitted: boolean;
}

/** Build the canonical §6.4 day_plan Wire event (op:upsert — REPLACES the Today note). */
export function buildDayPlanEvent(date: string, mode: string, plan: DayPlan): WireEvent {
  return {
    agent: "Compass",
    type: "day_plan",
    entity: "Today",
    op: "upsert",
    payload: {
      date,
      mode,
      top3: plan.top3,
      blocks: plan.blocks,
      couldnt_fit: plan.couldntFit,
      at_risk: plan.couldntFit.filter((c) => c.atRisk),
    },
    idempotencyKey: `compass:plan:${date}`,
  };
}

/**
 * Run the plan. Reads open tasks, builds the grid, bin-packs, handles overcommitment
 * (visible Couldn't-fit + P3 when an at-risk item overflows), resolves the Opus effort
 * (medium default, KV-overridable — D1-05), and emits the day_plan event. Network-pure via
 * injected `tasksOverride`/`events`. Compass NEVER writes the calendar.
 */
export async function runPlan(
  env: Env,
  date: string,
  mode: string,
  options: {
    tasks?: TaskRow[];
    events?: BusyInterval[];
    gridParams?: GridParams;
  } = {},
): Promise<PlanResult> {
  const db = (env as unknown as { DB?: D1Database }).DB;
  const tasks = options.tasks ?? (db ? await readOpenTasks(db) : []);
  const events = options.events ?? [];

  const plan = buildPlan(tasks, events, date, options.gridParams);

  // Overcommitment: demand > free → P3 (surface, never drop). Computed deterministically.
  if (plan.overcommitted) {
    const demand = demandMinutes(tasks);
    const free = freeMinutes(buildGrid(events, options.gridParams));
    const atRiskCount = plan.couldntFit.filter((c) => c.atRisk).length;
    await flag(
      env,
      "P3",
      "compass day is overcommitted",
      `Demand ${demand}m exceeds free ${free}m; ${plan.couldntFit.length} task(s) could not fit today (${atRiskCount} at-risk). They are surfaced under "⚠ Couldn't fit today" — never dropped.`,
      {
        sourceAgent: "Compass",
        suggestedAction: "Defer a lower-priority item or extend working hours.",
      },
    );
  }

  // D1-05: resolve the Opus effort (medium default; never high hardcoded). The live model
  // call passes this; here we resolve + surface it so the cost knob is observable.
  const effort = await resolveEffort(env);

  await send(env, buildDayPlanEvent(date, mode, plan));
  return { plan, effort, overcommitted: plan.overcommitted };
}

export class Compass extends WorkerEntrypoint<Env> {
  /**
   * The `compass-plan` Workflow-step RPC target. Reads open tasks + today's calendar
   * (read-only) and produces the day plan. Tests inject tasks/events; the live model +
   * calendar read wire in with OAuth. Degrade-don't-skip: if Sundial is unfinished, plan
   * against the last-known calendar (the caller passes whatever events it has).
   */
  async plan(params?: {
    date?: string;
    tasks?: TaskRow[];
    calendar?: BusyInterval[];
    gridParams?: GridParams;
  }): Promise<PlanResult> {
    const date = params?.date ?? localDate(this.env);
    return await runPlan(this.env, date, "morning", {
      tasks: params?.tasks,
      events: params?.calendar,
      gridParams: params?.gridParams,
    });
  }
}

export default {
  /**
   * The independent 21:00 EDT preview cron — a next-day glance (separate from the morning
   * chain's compass-plan step). The live model + calendar read wire in with OAuth; here we
   * run the plan against whatever D1 tasks exist (events default to none until wired).
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const date = localDate(env);
    await runPlan(env, date, "preview");
  },
} satisfies ExportedHandler<Env>;
