/**
 * Forge (apps/forge) — the task/subtask extractor. Morning-chain stage 3 (08:15 budget gate).
 *
 * Forge takes Herald's digest items + thread refs, filters the ① Action Required set carrying
 * Needs/* or Due/*, extracts {title, subtasks[], priority} (Sonnet), infers deadlines, dedupes/
 * merges into the D1 tasks store (@atlas/tasks) inside a per-run DO lock, and emits ONE Wire
 * event per new/changed task keyed on the task id. Forge creates tasks ONLY — it never touches
 * Gmail/calendar/Vault directly (gmail.readonly read substrate; events via Steward).
 *
 * Security: an item whose only actionable content is a code/link is SKIPPED; a ⚠ Phishing-
 * Suspect thread is NOT extracted and raises P2. No task field ever carries a secret.
 *
 * Shape: a `WorkerEntrypoint` (the `forge-morning` Workflow-step RPC target). No cron.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { send } from "@atlas/wire";
import type { WireEvent } from "@atlas/wire";
import { flag, localDate } from "@atlas/shared";
import type { Env as SharedEnv } from "@atlas/shared";
import { upsertTask, dedupeKey, normalizeTitle, type TaskInput, type UpsertAction } from "@atlas/tasks";
import {
  isActionRequired,
  isPhishing,
  shouldSecuritySkip,
  sanitizeExtracted,
  type CandidateThread,
  type Extractor,
  type ExtractedTask,
} from "./extract.js";
import { inferDeadline, type DeadlineSignals } from "./deadline.js";

export { ForgeLock } from "./lock.js";

/** Forge's env surface. */
export interface Env extends SharedEnv {
  FORGE_LOCK?: DurableObjectNamespace;
}

/** The result of the morning pass (returned to the Workflow step). */
export interface MorningResult {
  inserted: number;
  merged: number;
  skipped: number;
  phishing: number;
  taskIds: string[];
}

/** Derive a stable task id from the dedupe key (so a re-run re-derives the SAME id). */
export function taskIdFor(key: string): string {
  return `task-${key.slice(0, 16)}`;
}

/** Map a Due/* label off a candidate thread (for deadline inference). */
function dueLabelOf(t: CandidateThread): string | null {
  return t.labels.find((l) => l.startsWith("Due/")) ?? null;
}

/** Build the canonical §6.4 per-task Wire event (op:increment on insert, upsert on merge). */
export function buildTaskEvent(taskId: string, action: UpsertAction): WireEvent {
  const op = action === "inserted" ? "increment" : "upsert";
  return {
    agent: "Forge",
    type: "task",
    entity: taskId,
    op,
    payload: {
      counter: "tasks_open",
      delta: action === "inserted" ? 1 : 0,
      action,
    },
    idempotencyKey: taskId,
  };
}

/**
 * Process one candidate thread end-to-end: security-skip / phishing → P2, else extract,
 * sanitize, infer deadline, build the TaskInput, and upsert it via @atlas/tasks. Returns the
 * upsert action + the persisted id (or a skip/phishing marker). Network-pure via `extractor`.
 */
async function processThread(
  env: Env,
  db: D1Database,
  today: string,
  t: CandidateThread,
  extractor: Extractor,
): Promise<{ action: UpsertAction | "skip" | "phishing"; id?: string }> {
  if (isPhishing(t)) {
    await flag(
      env,
      "P2",
      "forge skipped a phishing-suspect thread",
      "A ⚠ Phishing-Suspect thread was not extracted into a task (the owner is never nudged to act on a phish).",
      { sourceAgent: "Forge" },
    );
    return { action: "phishing" };
  }
  if (shouldSecuritySkip(t)) {
    return { action: "skip" };
  }

  const extracted: ExtractedTask = sanitizeExtracted(await extractor.extract(t));
  if (extracted.title === "") {
    // The model echoed a secret as the only title content and it was scrubbed → nothing to do.
    return { action: "skip" };
  }

  const signals: DeadlineSignals = {
    dueLabel: dueLabelOf(t),
    isOA: t.labels.includes("Job/OA"),
  };
  const { due, due_kind } = inferDeadline(today, signals);

  const normTitle = normalizeTitle(extracted.title);
  const key = await dedupeKey(t.threadId, normTitle, due ?? "");
  const id = taskIdFor(key);

  const task: TaskInput = {
    id,
    dedupe_key: key,
    thread: t.threadId,
    title: extracted.title,
    priority: extracted.priority,
    due,
    due_kind,
    status: "open",
    source_agent: "Forge",
    locked_by_owner: 0,
    subtasks: extracted.subtasks.map((title, i) => ({ id: `${id}-s${i}`, title })),
  };

  const res = await upsertTask(db, task);
  return { action: res.action, id: res.id };
}

/**
 * Run the morning extraction. Gathers candidate threads, filters to the ① Action Required +
 * Needs/Due set, then (inside the DO lock when present) extracts/dedupes/upserts each and
 * emits ONE event per NEW or CHANGED task (a same-source no-op merge emits nothing new).
 */
export async function runMorning(
  env: Env,
  db: D1Database,
  today: string,
  candidates: CandidateThread[],
  extractor: Extractor,
  runUnderLock: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
): Promise<MorningResult> {
  const actionable = candidates.filter(isActionRequired);

  const result: MorningResult = {
    inserted: 0,
    merged: 0,
    skipped: 0,
    phishing: 0,
    taskIds: [],
  };

  // The dedupe+write critical section runs inside the lock (serializes overlapping runs).
  const outcomes = await runUnderLock(async () => {
    const acc: { action: UpsertAction | "skip" | "phishing"; id?: string }[] = [];
    for (const t of actionable) {
      acc.push(await processThread(env, db, today, t, extractor));
    }
    return acc;
  });

  for (const o of outcomes) {
    if (o.action === "phishing") result.phishing++;
    else if (o.action === "skip") result.skipped++;
    else if (o.action === "inserted") {
      result.inserted++;
      if (o.id) {
        result.taskIds.push(o.id);
        await send(env, buildTaskEvent(o.id, "inserted"));
      }
    } else if (o.action === "merged") {
      result.merged++;
      if (o.id) {
        result.taskIds.push(o.id);
        await send(env, buildTaskEvent(o.id, "merged"));
      }
    }
    // "noop" (same-source hit / owner-locked) emits NOTHING new (idempotent re-run).
  }

  return result;
}

export class Forge extends WorkerEntrypoint<Env> {
  /**
   * The `forge-morning` Workflow-step RPC target. Reuses Herald's digest refs (does NOT
   * re-fetch full bodies), extracts deadline-safe tasks into D1, and emits per-task events.
   * Tests inject `extractor` + `candidates`; the live model + Gmail-ref read wire in with the
   * Workflow step. Do NOT mutate event.payload — state is returned forward.
   */
  async morning(params?: {
    date?: string;
    candidates?: CandidateThread[];
    extractor?: Extractor;
  }): Promise<MorningResult> {
    const today = params?.date ?? localDate(this.env);
    const candidates = params?.candidates ?? [];
    const extractor = params?.extractor;
    if (!extractor || candidates.length === 0) {
      // No live model/candidates yet (wired with OAuth + the chain). Return an empty result;
      // never fabricate tasks.
      return { inserted: 0, merged: 0, skipped: 0, phishing: 0, taskIds: [] };
    }
    const db = (this.env as unknown as { DB: D1Database }).DB;
    return await runMorning(this.env, db, today, candidates, extractor);
  }
}

export default {
  // Forge has no cron in Phase 1 (it runs as the forge-morning Workflow step).
  fetch(): Response {
    return new Response("Forge runs as the forge-morning Workflow step.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
