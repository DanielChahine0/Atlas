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
import type { Env as SharedEnv, RawIncident } from "@atlas/shared";
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
import type { ForgeLock } from "./lock.js";

/** Forge's env surface. */
export interface Env extends Omit<SharedEnv, "INCIDENTS"> {
  // Typed namespace so the stub from getByName() exposes the DO's withLock() RPC method.
  FORGE_LOCK?: DurableObjectNamespace<ForgeLock>;
  /** INCIDENTS producer (atlas-incidents): Forge enqueues RawIncidents via flag() (D2-05). */
  INCIDENTS: Queue<RawIncident>;
}

/** The result of the morning pass (returned to the Workflow step). */
export interface MorningResult {
  inserted: number;
  merged: number;
  skipped: number;
  phishing: number;
  taskIds: string[];
}

/**
 * Derive a stable task id from the dedupe key (so a re-run re-derives the SAME id).
 *
 * Uses the FULL 256-bit digest, NOT a 16-hex (64-bit) prefix: a truncated prefix can
 * PK-collide on `tasks.id` independently of the `dedupe_key` UNIQUE constraint (two distinct
 * dedupe keys sharing a 64-bit prefix → same id), which would throw inside the Workflow step.
 * Do NOT add ON CONFLICT(id) to absorb it — an id-collision winner row carries a DIFFERENT
 * dedupe_key, so swallowing the conflict corrupts data. Full-key only keeps id↔dedupe_key 1:1.
 */
export function taskIdFor(key: string): string {
  return `task-${key}`;
}

/** Map a Due/* label off a candidate thread (for deadline inference). */
function dueLabelOf(t: CandidateThread): string | null {
  return t.labels.find((l) => l.startsWith("Due/")) ?? null;
}

/**
 * A stable content hash of the merge-relevant task state (priority + due). Two merges that
 * land the SAME (priority, due) produce the SAME hash (a true replay → same key → Steward
 * dedups); a genuine change (priority bump / earlier due) produces a DISTINCT hash → a new
 * ledger entry that Steward applies (NEW-F3). Pure & deterministic — no time/salt.
 */
export async function contentHashOf(priority: string | null, due: string | null): Promise<string> {
  const material = `${priority ?? ""}\u0000${due ?? ""}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the canonical §6.4 per-task Wire event (op:increment on insert, upsert on merge).
 *
 * INSERT (op:increment) is keyed on the task id — the task id IS its idempotency anchor.
 * MERGE (op:upsert) MUST carry CHANGE IDENTITY in its key (NEW-F3): the insert and a later
 * merge would otherwise share `idempotencyKey === taskId`, so Steward (which dedups
 * permanently on idempotencyKey) drops every merge — a real priority bump / earlier due never
 * reaches the Vault projection (Pillar 4 D1↔Vault divergence). Pass `mergeKey` (a content
 * hash of the merged priority+due) so each distinct merged state gets its own ledger entry
 * while a true replay (same state) still dedups.
 */
export function buildTaskEvent(
  taskId: string,
  action: UpsertAction,
  mergeKey?: string,
): WireEvent {
  const op = action === "inserted" ? "increment" : "upsert";
  const idempotencyKey =
    action === "inserted" ? taskId : `task:${taskId}:${mergeKey ?? taskId}`;
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
    idempotencyKey,
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
): Promise<{ action: UpsertAction | "skip" | "phishing"; id?: string; mergeKey?: string }> {
  if (isPhishing(t)) {
    await flag(
      env,
      "P2",
      "forge skipped a phishing-suspect thread",
      "A ⚠ Phishing-Suspect thread was not extracted into a task (the owner is never nudged to act on a phish).",
      { sourceAgent: "Forge", kind: "phishing_skipped" },
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
    // EXPLICIT wins: when the email stated a due date / EOD verbatim, the extractor parsed
    // it and inferDeadline returns due_kind "explicit" (NEW-F1 — previously this branch was
    // dead because ExtractedTask carried no explicit fields).
    explicitDue: extracted.explicitDue ?? null,
    eod: extracted.eod ?? false,
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
  // A merge carries CHANGE IDENTITY (NEW-F3): hash the priority + due this run contributes.
  // A replay of the same run hashes identically (Steward dedups the upsert); a real change
  // (priority bump / earlier due) hashes differently → a distinct, applied ledger entry.
  const mergeKey =
    res.action === "merged" ? await contentHashOf(extracted.priority, due) : undefined;
  return { action: res.action, id: res.id, mergeKey };
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
    const acc: { action: UpsertAction | "skip" | "phishing"; id?: string; mergeKey?: string }[] =
      [];
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
        await send(env, buildTaskEvent(o.id, "merged", o.mergeKey));
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
    // CR-01: actually ENGAGE the ForgeLock DO around the dedupe+write critical section.
    // FORGE_LOCK is optional-typed (absent in some test/dev wiring); when present, address it
    // by run date so all of a date's task writes serialize through one instance, and run the
    // upsert batch inside its blockConcurrencyWhile. When absent, fall back to the identity
    // runner (the Wire send() calls already sit OUTSIDE the locked section — the for-loop in
    // runMorning runs after runUnderLock returns — so this does not widen the lock).
    const lock = this.env.FORGE_LOCK;
    const runUnderLock = lock
      ? <T>(fn: () => Promise<T>) => lock.getByName(today).withLock(fn)
      : undefined;
    return await runMorning(
      this.env,
      db,
      today,
      candidates,
      extractor,
      runUnderLock ?? ((fn) => fn()),
    );
  }
}

export default {
  // Forge has no cron in Phase 1 (it runs as the forge-morning Workflow step).
  fetch(): Response {
    return new Response("Forge runs as the forge-morning Workflow step.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
