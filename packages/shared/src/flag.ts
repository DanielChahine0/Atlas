import { WireEvent, send } from "@atlas/wire";
import type { Severity } from "./env.js";

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
 */
const DEFAULT_TRUST: Record<Severity, number> = {
  P1: 100,
  P2: 95,
  P3: 50,
  P4: 70,
};

/**
 * A small, stable, NON-random content hash (djb2). The flag `id` MUST be structured + stable
 * — never a random UUID — so two calls describing the same incident produce the SAME id
 * ⇒ a replay re-upserts ONE row (no duplicate board row; Pillar 5 / T-00-23).
 */
function contentHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** The canonical flag record (SPEC-CANON §8 / docs/08-flagger.md §4). */
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
}

/**
 * Emit the canonical Flagger Wire event for a P1..P4 incident.
 *
 * Canonical signature (GLOBAL DECISION 2 — matches the build-plan callsite
 * `flag(env, "P3", "malformed wire event", e)`; NEVER kind/reason/message/context/payload
 * param names). Builds the FULL flag record, then emits the canonical §6.4 event:
 *
 *   { agent: <emitter>, type: "flag", entity: "flag", op: "upsert",
 *     payload: <full flag record>, idempotencyKey: flag.id }
 *
 * — NOT the stale build-plan pre-Flagger stub (which used an increment op on a "flagger"
 * entity). A flag is a STABLE ROW keyed by `id`, mutated in place (open → ack → resolved)
 * ⇒ the upsert op. Routes through the @atlas/wire `send()` helper (parse-then-send) so
 * flag()'s output is always §6.4-valid; never enqueues onto the raw Queue binding directly.
 */
export async function flag(
  env: { WIRE: Queue<WireEvent> },
  severity: Severity,
  title: string,
  detail?: string,
  options: FlagOptions = {},
): Promise<void> {
  const sourceAgent = options.sourceAgent ?? "Atlas";
  const date = localDate(env);
  // STRUCTURED id: flg:<localDate>:<source_agent>:<contentHash(severity+title+detail)>.
  // Stable for the same incident ⇒ replay-safe (idempotencyKey === id).
  const id = `flg:${date}:${sourceAgent}:${contentHash(`${severity}|${title}|${detail ?? ""}`)}`;

  const record: FlagRecord = {
    id,
    ts: new Date().toISOString(),
    source_agent: sourceAgent,
    severity,
    trust: DEFAULT_TRUST[severity],
    title,
    detail,
    suggested_action: options.suggestedAction,
    status: "open",
  };

  const event: WireEvent = {
    agent: sourceAgent,
    type: "flag",
    entity: "flag",
    op: "upsert",
    payload: record as unknown as Record<string, unknown>,
    idempotencyKey: id,
  };

  await send(env, event);
}
