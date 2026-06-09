import { z } from "zod";
import type { Severity } from "./env.js";

/**
 * The raw incident schema (D2-05). Agents enqueue a RawIncident onto `atlas-incidents`;
 * Flagger consumes, scores, dedupes, and routes. The emitter provides a hint + kind; Flagger
 * owns the final severity, trust, and all deduplication logic.
 *
 * Fields:
 *   source_agent  — the emitting agent codename (CLAUDE.md canonical name, e.g. "Forge").
 *   kind          — a stable machine-readable tag for the incident class (e.g. "model_error",
 *                   "malformed_event", "heartbeat_stale"). Used by Flagger for grouping and
 *                   muting rules. Defaults to "unknown" when not supplied by the caller.
 *   severity_hint — the emitter's best-effort severity estimate; Flagger may override.
 *   title         — a short, human-readable description (never a secret).
 *   detail        — optional extra context (never a secret).
 *   suggested_action — optional advisory remediation text (never executed by Flagger;
 *                   carried through to the FlagRecord's `suggested_action` on the board).
 *   run_id        — optional run correlation id (e.g. an owner-local date) to collapse
 *                   a cascade of related incidents (D2-07).
 */
export const RawIncidentSchema = z.object({
  source_agent: z.string(),
  kind: z.string(),
  severity_hint: z.enum(["P1", "P2", "P3", "P4"]),
  title: z.string(),
  detail: z.string().optional(),
  suggested_action: z.string().optional(),
  run_id: z.string().optional(),
});

/** The raw incident type — the payload agents enqueue onto `atlas-incidents`. */
export type RawIncident = {
  source_agent: string;
  kind: string;
  severity_hint: Severity;
  title: string;
  detail?: string;
  suggested_action?: string;
  run_id?: string;
};
