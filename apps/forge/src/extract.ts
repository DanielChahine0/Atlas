/**
 * Forge extraction — turn an ① Action Required thread into {title, subtasks[], priority}.
 *
 * The Sonnet pass writes the structured fields (short imperative title — "Submit Shopify OA",
 * not "RE: your online assessment"). These PURE helpers enforce the SECURITY SKIP and the
 * candidate filter BEFORE/AROUND the model so a 2FA code / reset link never becomes a task
 * field and a phishing thread is never extracted.
 */

import { containsSecret } from "@atlas/security";

/** A candidate thread Forge considers extracting (digest refs from Herald). */
export interface CandidateThread {
  threadId: string;
  subject: string;
  /** The thread's labels (set by Filer). */
  labels: string[];
  /** A short snippet of the actionable content (already redacted server-side by mcp-google). */
  snippet: string;
}

/** The structured task the extractor produces (pre-deadline). */
export interface ExtractedTask {
  title: string;
  subtasks: string[];
  priority: string; // P1..P4
  /**
   * An EXPLICIT due date the email *states verbatim*, parsed to an ISO-8601 string
   * (date-only "2026-06-02" or a full owner-local datetime). `null`/absent ⇒ the email
   * states no explicit deadline (do NOT invent one). When set, this wins over every
   * inferred Due/* label (deadline.ts `inferDeadline` → due_kind "explicit").
   * Backward compatible: optional, defaults to null.
   */
  explicitDue?: string | null;
  /**
   * True iff the email states "EOD" / "end of day" (without a specific clock time).
   * Drives the 23:59 owner-local time when combined with the stated date. Optional.
   */
  eod?: boolean;
}

const has = (t: CandidateThread, label: string): boolean => t.labels.includes(label);
const hasPrefix = (t: CandidateThread, prefix: string): boolean =>
  t.labels.some((l) => l.startsWith(prefix));

/** True iff a thread is the ① Action Required set carrying a Needs/* or Due/* qualifier. */
export function isActionRequired(t: CandidateThread): boolean {
  return has(t, "① Action Required") && (hasPrefix(t, "Needs/") || hasPrefix(t, "Due/"));
}

/** True iff a thread is a phishing suspect (do NOT extract; raise P2). */
export function isPhishing(t: CandidateThread): boolean {
  return has(t, "⚠ Phishing-Suspect");
}

/**
 * SECURITY SKIP: an item whose only actionable content is a 2FA code / reset link is dropped
 * (Filer's Type/Security handling stands). True ⇒ SKIP this thread (do not extract a task).
 * A Type/Security thread is always skipped; any other thread whose snippet's entire signal is
 * a secret (and carries no Needs/* verb) is also skipped.
 */
export function shouldSecuritySkip(t: CandidateThread): boolean {
  if (has(t, "Type/Security")) return true;
  // If the snippet contains a secret AND there is no concrete Needs/* action verb, the only
  // actionable content is the code/link → skip.
  if (containsSecret(t.snippet) && !hasPrefix(t, "Needs/")) return true;
  return false;
}

/**
 * Guard an extracted task: assert no field carries a secret. If the model echoed a code/link
 * into a title or subtask, scrub the offending field to empty rather than persist it. Returns
 * the sanitized task (titles/subtasks containing a secret are dropped).
 */
export function sanitizeExtracted(task: ExtractedTask): ExtractedTask {
  const safeTitle = containsSecret(task.title) ? "" : task.title;
  const safeSubtasks = task.subtasks.filter((s) => !containsSecret(s));
  // explicitDue / eod are structural deadline signals, not free-text the model could smuggle
  // a secret into — carry them through unchanged (a parsed ISO date / boolean).
  return {
    title: safeTitle,
    subtasks: safeSubtasks,
    priority: task.priority,
    explicitDue: task.explicitDue ?? null,
    eod: task.eod ?? false,
  };
}

/**
 * The model-call surface (injected so extraction is unit-testable without a network).
 *
 * The Sonnet output schema MUST return `{ title, subtasks[], priority, explicitDue?, eod? }`.
 * The model sets `explicitDue` to a parsed ISO-8601 date (e.g. "2026-06-02") ONLY when the
 * email states a concrete due date verbatim, and `eod:true` ONLY when it says "EOD" / "end of
 * day" — it must NEVER invent a date the email does not state (an absent deadline ⇒ both
 * omitted/null, so deadline inference falls back to the Due/* label rules).
 */
export interface Extractor {
  extract(thread: CandidateThread): Promise<ExtractedTask>;
}
