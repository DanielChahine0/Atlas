/**
 * score.ts — Deterministic severity + trust computation for Flagger (WEEKLY-02, Plan 02-02).
 *
 * Pure function — no I/O, no model calls, testable in isolation.
 * Flagger owns ALL trust computation (D2-06). The emitter provides a severity_hint; Flagger
 * applies CONFIG `severity_overrides` for the final severity (never LLM-assigned).
 *
 * Trust bands (D2-06 evidence tiers):
 *   caught exception  90–100  (kind: "model_error", "chain_halted", etc.)
 *   stale heartbeat   100     (kind: "heartbeat_stale")
 *   counter check     75–90   (kind: "dlq_dead_letter", "steward_write_fail")
 *   LLM hunch         20–45   (kind: "llm_judgment")
 *   default/unknown   50      (any unclassified kind)
 *   recurrence bump   +5 per recurrence (capped at 100)
 */

import type { Severity } from "@atlas/shared";

export interface RawIncidentInput {
  source_agent: string;
  kind: string;
  severity_hint: Severity;
  title: string;
  detail?: string;
}

/** Base trust by incident kind. */
function baseTrust(kind: string): number {
  switch (kind) {
    case "heartbeat_stale":
      return 100;
    case "model_error":
    case "chain_halted":
    case "malformed_event":
    case "security_leak_blocked":
    case "workflow_create_failed":
    case "steward_nonretryable":
    case "watch_renewal_due":
    case "phishing_skipped":
    case "overcommit":
      return 92; // caught exception band (90–100)
    case "dlq_dead_letter":
    case "steward_write_fail":
    case "calendar_sync_failed":
      return 82; // counter check band (75–90)
    case "llm_judgment":
      return 30; // LLM hunch band (20–45)
    default:
      return 50; // unclassified
  }
}

/**
 * Compute the final severity and trust for a RawIncident.
 *
 * - severity: starts from severity_hint; CONFIG severity_overrides can override per kind
 *   (but since this is a pure function, the override check is caller-supplied as the
 *   optional `configOverride` param). Falls back to severity_hint if no override.
 * - trust: baseTrust(kind) + min(recurrence * 5, 20) capped at 100
 *
 * severity is DETERMINISTIC — no model inference, no LLM, no Claude calls.
 */
export function score(
  incident: RawIncidentInput,
  recurrence: number,
  configOverride?: { severity?: Severity },
): { severity: Severity; trust: number } {
  const severity: Severity = configOverride?.severity ?? incident.severity_hint;
  const base = baseTrust(incident.kind);
  const bump = Math.min(recurrence * 5, 20);
  const trust = Math.min(base + bump, 100);
  return { severity, trust };
}
