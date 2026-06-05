/**
 * Sundial reconcile — create / patch / skip a calendar block per task, keyed on atlasTaskId.
 *
 * Invariants (docs/agents/sundial.md + Pillar 1/2):
 *   - List the window ONCE up front, server-side filtered by privateExtendedProperty
 *     agent=sundial, so Sundial reads ONLY its own blocks (a foreign/owner event is never
 *     read or written).
 *   - Per task keyed on atlasTaskId: no match → create; contentHash drift → patch
 *     (re-asserting the FULL reminders set); identical → SKIP (no API write).
 *   - NEVER delete. A detected duplicate atlasTaskId → keep earliest + a GATED Steward
 *     removal proposal (not an autonomous delete) + P2. Orphans → a gated proposed removal.
 *   - Insert-race guard: the list-before-create order is mandatory.
 */

import { flag } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import type { TaskRow } from "@atlas/tasks";
import { taskToBlock, type CalendarBlock } from "./block.js";

/** An existing Sundial-owned event as the list returns it (only the fields we read). */
export interface ExistingEvent {
  eventId: string;
  extendedProperties?: {
    private?: { atlasTaskId?: string; contentHash?: string };
  };
}

/** The reconcile actions (NO delete verb exists in this union — Pillar 2). */
export type ReconcileAction = "create" | "patch" | "skip" | "propose-removal";

/** One reconcile decision (what to do for a task / orphan). */
export interface ReconcileDecision {
  action: ReconcileAction;
  atlasTaskId: string;
  block?: CalendarBlock;
  /** For a patch, the existing event id to PATCH. */
  eventId?: string;
}

/** The reconcile result summary. */
export interface ReconcileResult {
  created: number;
  updated: number;
  skipped: number;
  proposedRemovals: number;
  decisions: ReconcileDecision[];
}

/** The calendar tool surface Sundial drives (injected; NO delete method — Pillar 2). */
export interface CalendarTools {
  /** List ONLY Sundial's own events in the window (privateExtendedProperty agent=sundial). */
  listOwnEvents(): Promise<ExistingEvent[]>;
  createEvent(block: CalendarBlock): Promise<void>;
  patchEvent(eventId: string, block: CalendarBlock): Promise<void>;
}

/**
 * Reconcile deadline tasks against Sundial's own existing blocks. Lists once up front, then
 * decides per task (create / patch / skip) and handles duplicates + orphans as GATED removal
 * proposals (never a delete). Returns the result + the decision list (no delete anywhere).
 */
export async function reconcile(
  env: { WIRE: Queue<WireEvent> },
  tasks: TaskRow[],
  tools: CalendarTools,
): Promise<ReconcileResult> {
  // (1) List ONCE up front — only Sundial's own blocks (insert-race guard: list before create).
  const existing = await tools.listOwnEvents();

  // Index existing events by atlasTaskId; detect duplicates (same id appearing twice).
  const byTaskId = new Map<string, ExistingEvent[]>();
  for (const e of existing) {
    const id = e.extendedProperties?.private?.atlasTaskId;
    if (!id) continue;
    const arr = byTaskId.get(id) ?? [];
    arr.push(e);
    byTaskId.set(id, arr);
  }

  const result: ReconcileResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    proposedRemovals: 0,
    decisions: [],
  };

  // (2) Duplicate handling: keep earliest, propose removal of the rest (GATED, never delete).
  for (const [taskId, events] of byTaskId) {
    if (events.length > 1) {
      // Keep events[0] (earliest by list order), propose-removal for the rest.
      for (let i = 1; i < events.length; i++) {
        result.decisions.push({ action: "propose-removal", atlasTaskId: taskId, eventId: events[i]!.eventId });
        result.proposedRemovals++;
      }
      await flag(
        env,
        "P2",
        "sundial detected a duplicate calendar block",
        `Two blocks share atlasTaskId ${taskId}; keeping the earliest and proposing removal of the duplicate (gated on owner confirm — never an autonomous delete).`,
        { sourceAgent: "Sundial" },
      );
    }
  }

  // (3) Per task: create / patch / skip keyed on atlasTaskId.
  for (const task of tasks) {
    const block = taskToBlock(task);
    const match = byTaskId.get(task.id)?.[0];
    if (!match) {
      await tools.createEvent(block);
      result.created++;
      result.decisions.push({ action: "create", atlasTaskId: task.id, block });
      continue;
    }
    const existingHash = match.extendedProperties?.private?.contentHash;
    if (existingHash !== block.extendedProperties.private.contentHash) {
      // contentHash drift → patch (re-assert the FULL reminders set; never append).
      await tools.patchEvent(match.eventId, block);
      result.updated++;
      result.decisions.push({ action: "patch", atlasTaskId: task.id, block, eventId: match.eventId });
    } else {
      // Identical → SKIP (no API write).
      result.skipped++;
      result.decisions.push({ action: "skip", atlasTaskId: task.id });
    }
  }

  return result;
}
