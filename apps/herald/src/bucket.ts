/**
 * Herald bucketing — map Filer's labels onto the owner's FIVE digest sections, in order.
 *
 * The five sections are FIXED and ORDERED (docs/agents/herald.md §"requested subsections"):
 *   [Important, Action Required, Action Recommended, Advertisement, Other]
 * — never reordered. The mapping is deterministic (label-literal); the model only writes
 * prose, never decides the bucket. D1-02: daily every weekday, NO Friday special-casing.
 *
 * Key rules (docs/04 §5.8): Type/Newsletter → Other (a reading queue, NOT advertising);
 * ONLY Type/Promotion → Advertisement. A ⚠ Phishing-Suspect thread lands in Other (with a
 * visible warning, handled by the digest renderer) — never Important/Action.
 */

/** The five sections, in the FIXED owner-requested order. */
export const SECTIONS = [
  "Important",
  "Action Required",
  "Action Recommended",
  "Advertisement",
  "Other",
] as const;

export type Section = (typeof SECTIONS)[number];

/** One thread as Herald sees it (labels set by Filer + light metadata). */
export interface DigestThread {
  threadId: string;
  sender: string;
  subject: string;
  labels: string[];
  /** True if the Codex marks the sender VIP (bumps into Important). */
  vip?: boolean;
}

/** The bucketed digest: each section → its threads, in rank order. */
export type Buckets = Record<Section, DigestThread[]>;

const has = (t: DigestThread, label: string): boolean => t.labels.includes(label);
const hasPrefix = (t: DigestThread, prefix: string): boolean =>
  t.labels.some((l) => l.startsWith(prefix));

/** The high-signal Type/Job + Finance/School set that qualifies for Important. */
function isHighSignal(t: DigestThread): boolean {
  return (
    has(t, "Job/Interview") ||
    has(t, "Job/Offer") ||
    has(t, "Job/OA") ||
    has(t, "Finance/Bill") ||
    has(t, "School/Deadline")
  );
}

/** Decide a thread's single section (label-literal, deterministic). */
export function sectionFor(t: DigestThread): Section {
  // Important: VIP sender, or an awaiting-reply VIP thread, or a high-signal job/finance item.
  if (t.vip || has(t, "From/VIP") || isHighSignal(t)) return "Important";
  // Action Required: the ① tier (its Needs/Due qualifiers ride along in the bucket).
  if (has(t, "① Action Required")) return "Action Required";
  // Action Recommended: the ② tier.
  if (has(t, "② Action Recommended")) return "Action Recommended";
  // Advertisement: ONLY Type/Promotion (Newsletter is NOT an ad).
  if (has(t, "Type/Promotion")) return "Advertisement";
  // Everything else (④ FYI, ⑤ No Action, Type/Newsletter, Type/Social, From/Automated,
  // ⚠ Phishing-Suspect, Type/Security) → Other.
  return "Other";
}

/** Rank within a section: Due/Today → Due/ThisWeek → From/VIP → rest. */
function rankKey(t: DigestThread): number {
  if (has(t, "Due/Today")) return 0;
  if (has(t, "Due/ThisWeek")) return 1;
  if (t.vip || has(t, "From/VIP")) return 2;
  return 3;
}

/**
 * Bucket a thread set into the five sections (in fixed order), each section internally
 * ranked. Returns a Buckets record whose key-iteration order is the SECTIONS order.
 */
export function bucketThreads(threads: DigestThread[]): Buckets {
  const buckets = {} as Buckets;
  for (const s of SECTIONS) buckets[s] = [];
  for (const t of threads) buckets[sectionFor(t)].push(t);
  for (const s of SECTIONS) {
    buckets[s].sort((a, b) => rankKey(a) - rankKey(b));
  }
  return buckets;
}

/** Per-section counts for the digest payload (in section order). */
export function sectionCounts(buckets: Buckets): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of SECTIONS) counts[s] = buckets[s].length;
  return counts;
}
