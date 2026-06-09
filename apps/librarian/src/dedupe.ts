/**
 * dedupe.ts — Deterministic prompt deduplication within a tool bucket (D-02).
 *
 * No model on this path — token-set Jaccard similarity within the `tool` bucket,
 * with KV-configurable thresholds. Deterministic and replay-stable.
 *
 * Algorithm:
 *   1. normalise()  — strip volatile bits (dates, URLs, extra whitespace, casing)
 *   2. tokenSet()   — split on whitespace, drop tokens ≤2 chars
 *   3. jaccard()    — intersection / union over the normalised token sets
 *   4. score >= threshold           → "bump"       (existing slug, same prompt)
 *      border    <= score < threshold → "borderline" (might be duplicate; keep separate + flag)
 *      score     < border            → "new"        (new prompt)
 *
 * Thresholds are KV-tunable (librarian.dedupe_threshold / librarian.dedupe_border)
 * with defaults 0.75 / 0.55. Live-tunable without redeploy.
 *
 * D1 query: SELECT slug, full_prompt FROM prompts WHERE tool = ? ORDER BY last_used DESC LIMIT 100
 * Positional ? only (CLAUDE.md: no named params). Scoped to the tool bucket to
 * avoid cross-tool false positives (a Canva prompt and a Claude prompt can be identical text).
 */

/** Remove volatile bits from prompt text before similarity comparison. */
export function normalise(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "DATE") // ISO dates
    .replace(/https?:\/\/\S+/g, "URL"); // URLs
}

/** Build a token set: split on whitespace, drop tokens with ≤2 chars. */
export function tokenSet(text: string): Set<string> {
  return new Set(text.split(/\s+/).filter((t) => t.length > 2));
}

/**
 * Jaccard similarity between two token sets.
 * Returns 1 if both sets are empty (both empty prompts are "the same").
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((t) => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : intersection / union;
}

/** The result of a dedupe lookup against the tool bucket. */
export type DedupeResult =
  | { match: "bump"; slug: string; score: number }
  | { match: "borderline"; slug: string; score: number }
  | { match: "new" };

/**
 * Check if the incoming `text` is a near-duplicate of any existing prompt in the
 * tool bucket. Reads up to 100 most-recently-used prompts for the given `tool`.
 *
 * Returns:
 *   { match: "bump",       slug, score } — score >= threshold (re-save the same prompt)
 *   { match: "borderline", slug, score } — border <= score < threshold (suspicious; keep separate + flag)
 *   { match: "new"               }       — score < border (new prompt)
 *
 * Thresholds are read from CONFIG KV with `Number(...)` coercion; defaults 0.75 / 0.55.
 * Tool is positional-? bound (CLAUDE.md: no named params).
 */
export async function dedupeLookup(
  db: D1Database,
  text: string,
  tool: string,
  threshold: number,
  border: number,
): Promise<DedupeResult> {
  const rows = await db
    .prepare(
      "SELECT slug, full_prompt FROM prompts WHERE tool = ? ORDER BY last_used DESC LIMIT 100",
    )
    .bind(tool)
    .all<{ slug: string; full_prompt: string }>();

  const normIncoming = normalise(text);
  const tokensIncoming = tokenSet(normIncoming);

  let bestSlug: string | undefined;
  let bestScore = 0;

  for (const row of rows.results) {
    const normExisting = normalise(row.full_prompt);
    const tokensExisting = tokenSet(normExisting);
    const score = jaccard(tokensIncoming, tokensExisting);
    if (score > bestScore) {
      bestScore = score;
      bestSlug = row.slug;
    }
  }

  if (bestSlug !== undefined && bestScore >= threshold) {
    return { match: "bump", slug: bestSlug, score: bestScore };
  }
  if (bestSlug !== undefined && bestScore >= border) {
    return { match: "borderline", slug: bestSlug, score: bestScore };
  }
  return { match: "new" };
}
