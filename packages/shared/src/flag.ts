import type { Severity } from "./env.js";
import type { RawIncident } from "./incident.js";

/**
 * Derive owner-local YYYY-MM-DD. workerd / wrangler dev / vitest all force TZ=UTC, so
 * `new Date()` is UTC even on the laptop (CLAUDE.md gotcha). Derive owner-local time
 * explicitly via Intl with the America/Toronto zone.
 */
export function localDate(_env?: unknown, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(now);
}

/**
 * Default trust per severity (docs/13-build-plan.md severity table + docs/08-flagger.md §3):
 * P1 stale-heartbeat → 100, P2 step-error → 95 (90–100 band), P3 drift → 50 (mid),
 * P4 self-recovered → 70 (high). Recurrence re-scores trust later (Flagger, Phase 2).
 *
 * KEPT: still exported so callers (including the dlq-sink) can reference the default trust
 * per severity. Flagger will also reuse this in its own score.ts (Plan 02-02).
 */
export const DEFAULT_TRUST: Record<Severity, number> = {
  P1: 100,
  P2: 95,
  P3: 50,
  P4: 70,
};

/**
 * A small, stable, NON-random content hash (djb2). KEPT exported: dlq-sink and Flagger
 * use this to build deterministic flag ids and audit rows.
 */
export function contentHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/**
 * The canonical flag record (SPEC-CANON §8 / docs/08-flagger.md §4).
 *
 * KEPT exported: this is now Flagger's OUTPUT shape (the finished record Flagger emits to
 * atlas-wire after scoring/deduping a RawIncident). Callers that reference FlagRecord for
 * the Steward board row shape continue to compile without change.
 */
export interface FlagRecord {
  id: string;
  ts: string;
  source_agent: string;
  severity: Severity;
  trust: number;
  title: string;
  detail?: string;
  suggested_action?: string;
  status: "open" | "ack" | "resolved" | "muted";
}

/** Optional knobs for flag() — defaults cover the common P1..P4 callsites. */
export interface FlagOptions {
  /** Emitting agent codename (== payload.source_agent). Defaults to "Atlas". */
  sourceAgent?: string;
  /** Advisory only — Flagger never executes it. */
  suggestedAction?: string;
  /**
   * Machine-readable incident class tag (D2-05). Used by Flagger for grouping and muting.
   * Defaults to "unknown". Examples: "model_error", "malformed_event", "heartbeat_stale",
   * "chain_halted", "security_leak_blocked", "dlq_dead_letter".
   */
  kind?: string;
  /**
   * Optional run correlation id — passed through as `run_id` on the RawIncident so Flagger
   * can collapse a cascade of related incidents into one (D2-07).
   */
  runId?: string;
}

/**
 * Enqueue a RawIncident onto `atlas-incidents` (D2-05 rework).
 *
 * CHANGED FROM PHASE 0: flag() no longer builds a full FlagRecord or emits a finished
 * §6.4 flag event to atlas-wire. Instead it enqueues a lightweight RawIncident to the
 * dedicated `atlas-incidents` queue. Flagger (Plan 02-02) is the sole consumer of that
 * queue — it scores, dedupes, and emits the canonical FlagRecord to atlas-wire → Steward.
 *
 * This preserves Pillar 1 (Steward remains the sole atlas-wire consumer) by introducing
 * a second queue that agents write to and Flagger aggregates.
 *
 * Canonical signature (GLOBAL DECISION 2 — matches the build-plan callsite
 * `flag(env, "P3", "malformed wire event", e)` — the first four positional params are
 * unchanged so every call site compiles after adding `kind` to the options object).
 */
export async function flag(
  env: { INCIDENTS: Queue<RawIncident> },
  severity: Severity,
  title: string,
  detail?: string,
  options: FlagOptions = {},
): Promise<void> {
  const incident: RawIncident = {
    source_agent: options.sourceAgent ?? "Atlas",
    kind: options.kind ?? "unknown",
    severity_hint: severity,
    title,
    detail,
    suggested_action: options.suggestedAction,
    run_id: options.runId,
  };
  // Omit undefined fields for a cleaner queue payload
  if (incident.detail === undefined) delete incident.detail;
  if (incident.suggested_action === undefined) delete incident.suggested_action;
  if (incident.run_id === undefined) delete incident.run_id;
  await env.INCIDENTS.send(incident);
}
