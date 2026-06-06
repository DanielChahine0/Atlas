/**
 * Headhunter (apps/headhunter) — hiring-window + deadline tracker (WEEKLY-01 jobs half).
 *
 * Two modes:
 *   full()      Mon 09:00 ET: scan boards → upsert jobs/windows → advance state machine →
 *               classify Filer Type/Job threads to funnel stages → emit funnel increments +
 *               apply-by tasks via Forge → emit scan summary.
 *   deadlines() daily-light 09:00 ET: promote closing windows, emit apply-by tasks.
 *
 * PILLAR COMPLIANCE:
 *   - Headhunter NEVER writes the tasks table directly (T-02-hh3). All apply-by tasks go
 *     through env.FORGE.createTask (service binding RPC, D2-13/D2-14).
 *   - Headhunter is a Wire PRODUCER only — no consumer block (Pillar 1).
 *   - Low-confidence historical windows → Flagger P3, never a silent task (D2-14).
 *   - Urgency (inside lead_time OR explicit deadline) bypasses fit_floor (D2-14).
 *   - Funnel increments: Headhunter is the single emitter, deduped by (thread,stage) (D2-13).
 *
 * Atlas drives Headhunter via service binding — NO own production cron (Plan 02-07 wires Atlas).
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { send } from "@atlas/wire";
import { flag, localDate } from "@atlas/shared";
import type { Env as SharedEnv, RawIncident } from "@atlas/shared";
import {
  upsertWindow,
  upsertJob,
  decideWindow,
  isUrgent,
  shouldFlagLowConfidence,
  buildScanSummaryEvent,
  buildFunnelEvent,
  type WindowRow,
  type JobRow,
} from "./windows.js";
import { loadSeedIfEmpty } from "./seed.js";

export { HeadhunterState } from "./state.js";
export type { WindowStatus } from "./state.js";

// ─────────────────────────────────────────────────────────────────────────────
// Env
// ─────────────────────────────────────────────────────────────────────────────

/** Headhunter's env surface. */
export interface Env extends Omit<SharedEnv, "INCIDENTS"> {
  /** INCIDENTS producer (atlas-incidents): Headhunter enqueues RawIncidents via flag(). */
  INCIDENTS: Queue<RawIncident>;
  /** HeadhunterState DO — addressed as env.HEADHUNTER_STATE.getByName("pipeline"). */
  HEADHUNTER_STATE?: DurableObjectNamespace;
  /**
   * Forge service binding — apply-by tasks go through Forge's existing createTask
   * dedupe path (D2-13/D2-14). NEVER write the tasks table directly.
   */
  FORGE?: {
    createTask(
      task: {
        title: string;
        due: string | null;
        due_kind: "explicit" | "inferred";
        source_agent: string;
        thread: null;
        priority: string;
      },
      opts: { idempotencyKey: string; runId: string },
    ): Promise<{ id: string } | null>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export interface FullResult {
  date: string;
  scanned: number;
  tasks: number;
  flagged: number;
}

export interface DeadlineResult {
  date: string;
  promoted: number;
  tasks: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Funnel stage classification (D2-13)
// ─────────────────────────────────────────────────────────────────────────────

/** Maps Filer Job/* sub-labels to canonical funnel stages. */
export type FunnelStage = "oa" | "interview" | "offer" | "rejected" | "applied";

const LABEL_TO_STAGE: Record<string, FunnelStage> = {
  "Job/OA": "oa",
  "Job/Interview": "interview",
  "Job/Offer": "offer",
  "Job/Rejected": "rejected",
  "Job/Applied": "applied",
};

export interface ThreadStage {
  threadId: string;
  stage: FunnelStage;
}

/**
 * Classify a list of Filer Type/Job thread labels into funnel stages.
 * Returns one (threadId, stage) pair per thread that has a recognised stage label.
 * Headhunter is the SINGLE emitter of funnel increments (D2-13).
 */
export function classifyFunnelStages(
  threads: Array<{ threadId: string; labels: string[] }>,
): ThreadStage[] {
  const result: ThreadStage[] = [];
  for (const { threadId, labels } of threads) {
    for (const label of labels) {
      const stage = LABEL_TO_STAGE[label];
      if (stage) {
        result.push({ threadId, stage });
        break; // one stage per thread (highest-stage label wins in practice)
      }
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core run functions
// ─────────────────────────────────────────────────────────────────────────────

/** Default config knobs (overridable via KV). */
const DEFAULT_LEAD_TIME_DAYS = 21;
const DEFAULT_FIT_FLOOR = 0.4;

/**
 * runFull — the Mon 09:00 full scan.
 * Reads the windows from D1 (seeded if empty), evaluates decisions, emits apply-by tasks
 * via Forge, emits funnel increments, emits scan summary.
 *
 * @param env  Headhunter env (injected; testable)
 * @param date  owner-local date string (YYYY-MM-DD)
 * @param windows  optional override (for tests; live = read from D1 seed)
 * @param funnelThreads  optional Filer Type/Job threads (for funnel classification)
 */
export async function runFull(
  env: Env,
  date: string,
  windows?: WindowRow[],
  funnelThreads?: Array<{ threadId: string; labels: string[] }>,
): Promise<FullResult> {
  // Load seed if owner hasn't configured a custom watchlist
  if (!windows) {
    await loadSeedIfEmpty(env);
  }

  // Read the lead_time and fit_floor from KV (with defaults)
  const [leadTimeRaw, fitFloorRaw] = await Promise.all([
    env.CONFIG.get("headhunter/lead_time_days"),
    env.CONFIG.get("headhunter/fit_floor"),
  ]);
  const leadTimeDays = leadTimeRaw ? parseInt(leadTimeRaw, 10) : DEFAULT_LEAD_TIME_DAYS;
  const fitFloor = fitFloorRaw ? parseFloat(fitFloorRaw) : DEFAULT_FIT_FLOOR;

  // Read open windows from D1 (or use the injected override for tests)
  let openWindows: WindowRow[];
  if (windows) {
    openWindows = windows;
  } else {
    const { results } = await env.DB.prepare(
      // H5 fix: include deadline and fit_score so decideWindow can apply fit-floor
      // and explicit-deadline urgency override from D1 data (not just injected rows).
      "SELECT id,company,cycle,role_class,opens_est,closes_est,confidence,source,status,last_seen_open,created_at,updated_at,deadline,fit_score FROM windows WHERE status != ?",
    )
      .bind("closed")
      .all<WindowRow>();
    openWindows = results;
  }

  let taskCount = 0;
  let flaggedCount = 0;

  // Process each window
  for (const win of openWindows) {
    if (shouldFlagLowConfidence({ confidence: win.confidence, source: win.source })) {
      // Low-confidence historical window → Flagger P3, NOT a task (D2-14)
      await flag(
        env,
        "P3",
        `Low-confidence window: ${win.company} ${win.cycle}`,
        `closes_est ${win.closes_est} is historical-only (confidence ${win.confidence})`,
        { sourceAgent: "Headhunter", kind: "low_confidence_window", runId: date },
      );
      flaggedCount++;
      continue;
    }

    const decision = decideWindow(win, { leadTimeDays, fitFloor, date });
    if (decision === null) continue;

    // Create apply-by task via Forge (NEVER write tasks table directly — T-02-hh3)
    if (env.FORGE) {
      try {
        await env.FORGE.createTask(
          {
            title: decision.title,
            due: decision.due,
            due_kind: decision.due_kind,
            source_agent: "Headhunter",
            thread: null,
            priority: decision.priority,
          },
          { idempotencyKey: decision.idempotencyKey, runId: date },
        );
        taskCount++;
      } catch (err) {
        await flag(env, "P2", `Headhunter: Forge task creation failed for ${win.company}`, String(err), {
          sourceAgent: "Headhunter",
          kind: "headhunter_forge_task_failed",
          runId: date,
        });
      }
    }
  }

  // Classify funnel stages and emit increments (single-emitter, D2-13)
  if (funnelThreads && funnelThreads.length > 0) {
    const stages = classifyFunnelStages(funnelThreads);
    for (const { threadId, stage } of stages) {
      await send(env, buildFunnelEvent(threadId, stage));
    }
  }

  // Emit scan summary (idempotencyKey: headhunter:scan:<date>)
  await send(env, buildScanSummaryEvent(date, openWindows.length, taskCount));

  // Heartbeat (D2-07). Best-effort: a transient queue reject must NEVER convert a successful
  // full scan into a failure. Optional-chaining: absent binding is a no-op.
  await env.INCIDENTS?.send({
    source_agent: "Headhunter",
    kind: "heartbeat",
    severity_hint: "P4",
    title: `Headhunter full heartbeat ${date}`,
    run_id: date,
  }).catch(() => {});

  return { date, scanned: openWindows.length, tasks: taskCount, flagged: flaggedCount };
}

/**
 * runDeadlines — the daily-light pass.
 * Promotes windows whose closes_est is within lead_time and emits apply-by tasks.
 */
export async function runDeadlines(
  env: Env,
  date: string,
  windows?: WindowRow[],
): Promise<DeadlineResult> {
  const leadTimeRaw = await env.CONFIG.get("headhunter/lead_time_days");
  const leadTimeDays = leadTimeRaw ? parseInt(leadTimeRaw, 10) : DEFAULT_LEAD_TIME_DAYS;
  const fitFloorRaw = await env.CONFIG.get("headhunter/fit_floor");
  const fitFloor = fitFloorRaw ? parseFloat(fitFloorRaw) : DEFAULT_FIT_FLOOR;

  let openWindows: WindowRow[];
  if (windows) {
    openWindows = windows;
  } else {
    const { results } = await env.DB.prepare(
      // H5 fix: include deadline and fit_score (same fix as runFull SELECT above).
      "SELECT id,company,cycle,role_class,opens_est,closes_est,confidence,source,status,last_seen_open,created_at,updated_at,deadline,fit_score FROM windows WHERE status != ?",
    )
      .bind("closed")
      .all<WindowRow>();
    openWindows = results;
  }

  let taskCount = 0;
  let promotedCount = 0;

  for (const win of openWindows) {
    if (shouldFlagLowConfidence({ confidence: win.confidence, source: win.source })) {
      continue; // full() handles low-confidence flagging; deadlines skips
    }

    const decision = decideWindow(win, { leadTimeDays, fitFloor, date });
    if (decision === null) continue;

    // Promote to "closing" status if in lead time.
    // M8 fix: monotonic guard — only advance upcoming→open→closing, never regress.
    // The status order is: upcoming < open < closing < closed.
    // I2 fix: isUrgent is a static import (moved to top-level) — no dynamic import.
    const STATUS_ORDER: Record<string, number> = { upcoming: 0, open: 1, closing: 2, closed: 3 };
    const CLOSING_ORDER = 2; // STATUS_ORDER["closing"]
    const canAdvanceToClosing =
      win.status !== "closing" &&
      win.status !== "closed" &&
      (STATUS_ORDER[win.status] ?? 0) < CLOSING_ORDER;
    if (isUrgent(win.closes_est, win.deadline, leadTimeDays, date) && canAdvanceToClosing) {
      await upsertWindow(env.DB, { ...win, status: "closing", updated_at: Date.now() });
      promotedCount++;
    }

    // Create apply-by task via Forge
    if (env.FORGE) {
      try {
        await env.FORGE.createTask(
          {
            title: decision.title,
            due: decision.due,
            due_kind: decision.due_kind,
            source_agent: "Headhunter",
            thread: null,
            priority: decision.priority,
          },
          { idempotencyKey: decision.idempotencyKey, runId: date },
        );
        taskCount++;
      } catch (err) {
        await flag(env, "P2", `Headhunter: deadline task creation failed for ${win.company}`, String(err), {
          sourceAgent: "Headhunter",
          kind: "headhunter_failed",
          runId: date,
        });
      }
    }
  }

  // Heartbeat. Best-effort: a transient queue reject must NEVER convert a successful
  // deadlines pass into a failure. Optional-chaining: absent binding is a no-op.
  await env.INCIDENTS?.send({
    source_agent: "Headhunter",
    kind: "heartbeat",
    severity_hint: "P4",
    title: `Headhunter deadlines heartbeat ${date}`,
    run_id: date,
  }).catch(() => {});

  return { date, promoted: promotedCount, tasks: taskCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkerEntrypoint (service binding RPC target)
// ─────────────────────────────────────────────────────────────────────────────

export class Headhunter extends WorkerEntrypoint<Env> {
  /**
   * Mon 09:00 full scan — boards + window state machine + funnel classify.
   * Invoked by Atlas via service binding (Plan 02-07).
   */
  async full(params?: {
    date?: string;
    windows?: WindowRow[];
    funnelThreads?: Array<{ threadId: string; labels: string[] }>;
  }): Promise<FullResult> {
    const date = params?.date ?? localDate(this.env);
    try {
      return await runFull(this.env, date, params?.windows, params?.funnelThreads);
    } catch (err) {
      await flag(this.env, "P2", `Headhunter full() failed: ${date}`, String(err), {
        sourceAgent: "Headhunter",
        kind: "headhunter_failed",
        runId: date,
      });
      throw err;
    }
  }

  /**
   * Daily-light deadlines pass — promote closing windows, emit apply-by tasks.
   * Invoked by Atlas via service binding (Plan 02-07).
   */
  async deadlines(params?: {
    date?: string;
    windows?: WindowRow[];
  }): Promise<DeadlineResult> {
    const date = params?.date ?? localDate(this.env);
    try {
      return await runDeadlines(this.env, date, params?.windows);
    } catch (err) {
      await flag(this.env, "P2", `Headhunter deadlines() failed: ${date}`, String(err), {
        sourceAgent: "Headhunter",
        kind: "headhunter_failed",
        runId: date,
      });
      throw err;
    }
  }
}

export default {
  // Headhunter has no own cron in Phase 2 — Atlas drives it via service binding (Plan 02-07).
  fetch(): Response {
    return new Response("Headhunter runs via Atlas service binding.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
