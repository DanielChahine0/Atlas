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
import type { Env as SharedEnv, RawIncident } from "@atlas/shared";
import { readOpenTasks, type TaskRow } from "@atlas/tasks";
import { buildPlan, demandMinutes, freeMinutes, buildGrid, resolveEffort, type DayPlan } from "./plan.js";
import type { BusyInterval, GridParams } from "./grid.js";

/** Compass's env surface. */
export interface Env extends Omit<SharedEnv, "INCIDENTS"> {
  COMPASS_STATE?: DurableObjectNamespace;
  /** INCIDENTS producer (atlas-incidents): Compass enqueues RawIncidents via flag() (D2-05). */
  INCIDENTS: Queue<RawIncident>;
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

/**
 * The idempotency-key segment for a plan mode (spec failure-table key: `compass:<mode>:<date>`).
 * The morning chain step writes `compass:plan:<date>`; the 21:00 preview writes
 * `compass:preview:<date>`. Distinct segments mean a preview for tomorrow is NOT deduped away
 * against the morning plan for the same target date (they are different rows in the ledger).
 */
function keyModeFor(mode: string): string {
  return mode === "morning" ? "plan" : mode;
}

/** Build the canonical §6.4 day_plan Wire event (op:upsert — REPLACES the Today note). */
export function buildDayPlanEvent(date: string, mode: string, plan: DayPlan): WireEvent {
  // couldnt_fit and at_risk must be DISJOINT — an at-risk overflow item belongs to at_risk only
  // (else the Vault renderer double-lists it). Surface non-at-risk overflow under couldnt_fit.
  const atRisk = plan.couldntFit.filter((c) => c.atRisk);
  const couldntFit = plan.couldntFit.filter((c) => !c.atRisk);
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
      couldnt_fit: couldntFit,
      at_risk: atRisk,
    },
    idempotencyKey: `compass:${keyModeFor(mode)}:${date}`,
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

  // Overcommitment: overflow exists → P3 (surface, never drop). Computed deterministically.
  // plan.overcommitted is bin-pack FRAGMENTATION (couldntFit.length > 0), which can fire even
  // when total demand <= total free; only claim "demand exceeds free" when that is actually true.
  if (plan.overcommitted) {
    const demand = demandMinutes(tasks);
    const free = freeMinutes(buildGrid(events, options.gridParams));
    const overByDemand = demand > free;
    const capacityClause = overByDemand
      ? `Demand ${demand}m exceeds free ${free}m`
      : `Demand ${demand}m fits free ${free}m but fragmentation blocked placement`;
    const atRiskCount = plan.couldntFit.filter((c) => c.atRisk).length;
    await flag(
      env,
      "P3",
      "compass day is overcommitted",
      `${capacityClause}; ${plan.couldntFit.length} task(s) could not be placed today (${atRiskCount} at-risk). They are surfaced under "⚠ Couldn't fit today" — never dropped.`,
      {
        sourceAgent: "Compass",
        kind: "overcommit",
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

/**
 * The owner-local calendar date one day after `date` (YYYY-MM-DD). Operates on the parsed
 * integer Y/M/D components (NOT a bare `new Date()` that workerd would read as UTC), so the
 * +1-day roll is calendar-pure and DST-safe — a date-only string carries no offset to skew.
 */
export function nextOwnerLocalDate(date: string): string {
  const [y, m, d] = date.split("-").map((x) => Number(x));
  // Date.UTC normalizes month/day overflow (e.g. day 31 → next month) deterministically.
  const next = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1));
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(next);
}

export default {
  /**
   * The independent 21:00 EDT preview cron — a next-day glance (separate from the morning
   * chain's compass-plan step). It plans for owner-local TOMORROW (today + 1 day) and writes a
   * distinct `compass:preview:<tomorrow>` key, so it is never deduped against the morning
   * `compass:plan:<date>` step. The live model + calendar read wire in with OAuth; here we run
   * the plan against whatever D1 tasks exist (events default to none until wired).
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const tomorrow = nextOwnerLocalDate(localDate(env));
    await runPlan(env, tomorrow, "preview");
  },
} satisfies ExportedHandler<Env>;
