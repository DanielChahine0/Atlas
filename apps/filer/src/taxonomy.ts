/**
 * Filer label taxonomy + bootstrap diff (docs/04-email-taxonomy.md).
 *
 * The bootstrap diff is the IDEMPOTENT label-creation path: list the existing labels once,
 * diff against the canonical taxonomy, and `create_label` ONLY on a real diff —
 * PARENT BEFORE CHILD (a child like `Job/OA` requires its parent `Type/Job` to exist
 * first in Gmail's nested-label model). Colors are chosen from Gmail's FIXED palette;
 * sending an out-of-palette hex returns a Gmail 400, so we only ever emit palette colors.
 *
 * This module is PURE (no network): `diffTaxonomy(existing)` returns the ordered list of
 * labels to create. The live `gmail_list_labels` / `create_label` calls live in index.ts.
 */

/** A canonical label with its (optional) parent and a palette-valid color. */
export interface TaxonomyLabel {
  /** The full nested label name (e.g. "Job/OA"). */
  name: string;
  /** The parent label that MUST exist first (null for a top-level label). */
  parent: string | null;
  /** A Gmail-palette-valid background color hex (see GMAIL_PALETTE). */
  color: string;
}

/**
 * A SUBSET of Gmail's fixed label-color palette (the allowed background hexes). Sending a
 * color outside Gmail's palette returns HTTP 400, so the taxonomy only references these.
 */
export const GMAIL_PALETTE = [
  "#fb4c2f", // red
  "#ffad47", // orange
  "#fad165", // yellow
  "#4a86e8", // blue
  "#999999", // grey
  "#fcda83", // amber
  "#fbe983", // gold
  "#cccccc", // light grey
] as const;

type PaletteColor = (typeof GMAIL_PALETTE)[number];

function lbl(name: string, parent: string | null, color: PaletteColor): TaxonomyLabel {
  return { name, parent, color };
}

/**
 * The canonical taxonomy, ALREADY ORDERED parent-before-child. The bootstrap diff
 * preserves this order so a child is never created before its parent.
 */
export const TAXONOMY: readonly TaxonomyLabel[] = [
  // ── Triage tiers (exactly one per thread) — red→grey by urgency. ──
  lbl("① Action Required", null, "#fb4c2f"),
  lbl("② Action Recommended", null, "#ffad47"),
  lbl("③ Awaiting Reply", null, "#fad165"),
  lbl("④ FYI / Read Later", null, "#4a86e8"),
  lbl("⑤ No Action", null, "#999999"),

  // ── Type/* parents, then their children (PARENT BEFORE CHILD). ──
  lbl("Type/Job", null, "#4a86e8"),
  lbl("Job/Application", "Type/Job", "#4a86e8"),
  lbl("Job/Recruiter", "Type/Job", "#4a86e8"),
  lbl("Job/OA", "Type/Job", "#4a86e8"),
  lbl("Job/Interview", "Type/Job", "#4a86e8"),
  lbl("Job/Offer", "Type/Job", "#4a86e8"),
  lbl("Job/Rejection", "Type/Job", "#999999"),
  lbl("Type/Events", null, "#4a86e8"),
  lbl("Events/Invite", "Type/Events", "#4a86e8"),
  lbl("Events/Confirmed", "Type/Events", "#4a86e8"),
  lbl("Events/Reminder", "Type/Events", "#ffad47"),
  lbl("Type/Finance", null, "#4a86e8"),
  lbl("Finance/Bill", "Type/Finance", "#fb4c2f"),
  lbl("Type/School", null, "#4a86e8"),
  lbl("School/Deadline", "Type/School", "#fb4c2f"),
  lbl("Type/Newsletter", null, "#cccccc"),
  lbl("Type/Promotion", null, "#cccccc"),
  lbl("Type/Social", null, "#cccccc"),
  lbl("Type/Dev", null, "#4a86e8"),
  // Type/Security is read-and-label only; its bodies are redacted server-side.
  lbl("Type/Security", null, "#999999"),
  lbl("Type/Personal", null, "#4a86e8"),

  // ── Needs/* (drives Forge) — shared amber. ──
  lbl("Needs/Reply", null, "#fcda83"),
  lbl("Needs/Pay", null, "#fcda83"),
  lbl("Needs/Register", null, "#fcda83"),
  lbl("Needs/Schedule", null, "#fcda83"),
  lbl("Needs/Upload", null, "#fcda83"),
  lbl("Needs/Sign", null, "#fcda83"),
  lbl("Needs/Decide", null, "#fcda83"),

  // ── Due/* (deadline). ──
  lbl("Due/Today", null, "#fb4c2f"),
  lbl("Due/ThisWeek", null, "#ffad47"),
  lbl("Due/Expired", null, "#999999"),

  // ── From/* (relationship) — VIP changes behavior. ──
  lbl("From/VIP", null, "#fbe983"),
  lbl("From/Automated", null, "#cccccc"),

  // ── Suggest/* (suggestions, never auto-acted). ──
  lbl("Suggest/Keep", null, "#999999"),
  lbl("Suggest/Unsubscribe", null, "#999999"),

  // ── Agent-state (Filer's own bookkeeping). ──
  lbl("AI/Reviewed", null, "#999999"),
  lbl("AI/Uncertain", null, "#fad165"),
  lbl("⚠ Phishing-Suspect", null, "#fb4c2f"),
];

/**
 * Diff the canonical taxonomy against the set of labels that already exist in Gmail.
 * Returns the labels to create, IN parent-before-child order. A label already present
 * (by exact name) is skipped — so a re-run after the first bootstrap creates nothing
 * (idempotent). The returned colors are guaranteed palette-valid.
 */
export function diffTaxonomy(existingNames: Iterable<string>): TaxonomyLabel[] {
  const have = new Set(existingNames);
  // TAXONOMY is already parent-before-child; filter preserves that order.
  return TAXONOMY.filter((l) => !have.has(l.name));
}

/** True iff a color is in the Gmail palette (guard before any create_label). */
export function isPaletteColor(color: string): color is PaletteColor {
  return (GMAIL_PALETTE as readonly string[]).includes(color);
}
