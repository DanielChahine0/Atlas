/**
 * Filer classification helpers — the security guard + consistency pass.
 *
 * The Haiku LLM proposes labels per thread (grounded in the taxonomy passed as a cached
 * system block); these PURE functions enforce the non-negotiable invariants on the
 * proposal BEFORE any label is written:
 *
 *   1. SECURITY GUARD — a Type/Security or ⚠ Phishing-Suspect thread is read-and-label
 *      ONLY: it gets NO Needs/* and NO Suggest/* label (the owner is never nudged to act
 *      on a phish), and no code/link is ever reproduced. Bodies are already redacted
 *      server-side by mcp-google; this guard is the second belt.
 *   2. CONSISTENCY PASS — a thread carries EXACTLY one triage tier. Contradictory triage
 *      labels are reconciled: keep the higher-trust (lower-numbered) tier, drop the loser,
 *      and add AI/Uncertain on genuine ambiguity.
 */

/** The canonical triage tiers, strongest (most urgent) first. */
export const TRIAGE_TIERS = [
  "① Action Required",
  "② Action Recommended",
  "③ Awaiting Reply",
  "④ FYI / Read Later",
  "⑤ No Action",
] as const;

const TRIAGE_SET = new Set<string>(TRIAGE_TIERS);

/** True iff a thread is security-sensitive (read-and-label only). */
export function isSecurityOrPhishing(labels: string[]): boolean {
  return labels.includes("Type/Security") || labels.includes("⚠ Phishing-Suspect");
}

/**
 * Apply the SECURITY GUARD: on a Type/Security or ⚠ Phishing-Suspect thread, strip every
 * Needs/* and Suggest/* label (the owner is never nudged to act on a phish). Returns the
 * filtered label set. A non-security thread is returned unchanged.
 */
export function stripActionLabelsForSecurity(labels: string[]): string[] {
  if (!isSecurityOrPhishing(labels)) return labels;
  return labels.filter((l) => !l.startsWith("Needs/") && !l.startsWith("Suggest/"));
}

/**
 * Apply the CONSISTENCY PASS: keep exactly ONE triage tier (the strongest), drop any
 * weaker contradictory tier, and add AI/Uncertain when the proposal was genuinely
 * ambiguous (two or more tiers proposed, OR the caller flags low confidence).
 */
export function reconcileTriage(
  labels: string[],
  opts: { lowConfidence?: boolean } = {},
): string[] {
  const tiers = labels.filter((l) => TRIAGE_SET.has(l));
  const nonTiers = labels.filter((l) => !TRIAGE_SET.has(l));
  const ambiguous = tiers.length > 1 || opts.lowConfidence === true;

  let kept: string[] = nonTiers;
  if (tiers.length > 0) {
    // The strongest tier is the earliest in TRIAGE_TIERS order.
    const strongest = TRIAGE_TIERS.find((t) => tiers.includes(t));
    if (strongest) kept = [strongest, ...nonTiers];
  }
  if (ambiguous && !kept.includes("AI/Uncertain")) {
    kept = [...kept, "AI/Uncertain"];
  }
  return kept;
}

/**
 * The full label finalizer for one thread: security guard, then consistency pass. The
 * AI/Reviewed cursor label is appended LAST by the caller (after the write succeeds) so
 * an interrupted run is retried, not skipped.
 */
export function finalizeLabels(
  proposed: string[],
  opts: { lowConfidence?: boolean } = {},
): string[] {
  const secured = stripActionLabelsForSecurity(proposed);
  return reconcileTriage(secured, opts);
}
