/**
 * derive.ts — Haiku-backed title/tags derivation + stable slug (D-03).
 *
 * Uses claudeFor("librarian", env) which resolves to claude-haiku-4-5 via the
 * atlas-highvolume AI Gateway (registered in TIER_MAP by 05-01). Title and tags are
 * derived ONCE for new prompts; the slug is derived from the first title and NEVER
 * re-derived (D-03: deep links must not break on re-saves).
 *
 * Gateway errors from claudeFor are auto-flagged P3 inside @atlas/model — no double-flag.
 *
 * Slug constraint (wave1_security_constraint): the notePath written to Steward MUST match
 * /^Prompts\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/ with no ".." anywhere. Librarian's slug
 * generator therefore produces slugs matching [A-Za-z0-9][A-Za-z0-9._-]* — kebab-case
 * lowercase with only [a-z0-9-] chars, which is a strict subset of the allowlist.
 */

import { claudeFor } from "@atlas/model";
import type { Env } from "./env.js";

// TypeScript note: ModelEnv (in @atlas/model) includes `Record<string, unknown>` which
// the concrete Env interface cannot satisfy (no index signature). Use the same cast
// pattern as archivist/envoy (see 01-03/04 precedent):
//   `env as unknown as Parameters<typeof claudeFor>[1]`
// This is safe: claudeFor only reads the specific bindings it needs (INCIDENTS, CONFIG,
// ANTHROPIC_API_KEY, CF_AIG_TOKEN, AIG_ACCOUNT_ID, AIG_GATEWAY_ID) — all present on Env.

/** Derived record for a new prompt. Slug is stable and never re-derived. */
export interface DerivedRecord {
  title: string;
  tags: string[];
  slug: string;
}

/**
 * Derive title (≤6 words), tags (≤5), and a stable slug for a NEW prompt.
 * Calls claudeFor("librarian", env) (Haiku via atlas-highvolume gateway).
 *
 * Slug derivation: `title.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"")`.
 * This produces only [a-z0-9-] chars, which satisfies the Steward path constraint
 * /^Prompts\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.
 *
 * A returned empty slug (e.g. title is all non-alpha) is guarded: falls back to first 6
 * words of the prompt text lowercased and slugified.
 */
export async function deriveRecord(
  promptText: string,
  env: Env,
): Promise<DerivedRecord> {
  // Cast: ModelEnv requires `Record<string,unknown>` (index sig) but Env is a named interface.
  // archivist/envoy use the same `as unknown as Parameters<typeof claudeFor>[1]` pattern.
  const claude = await claudeFor("librarian", env as unknown as Parameters<typeof claudeFor>[1]);

  let title: string;
  let tags: string[];

  try {
    const resp = (await claude.messages.create({
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content:
            `Output ONLY JSON: {"title":"<≤6 words>","tags":["tag1","tag2"]}. No explanation.\n\nPrompt:\n${promptText.slice(0, 2000)}`,
        },
      ],
    })) as { content: Array<{ type: string; text: string }> };

    const text = resp.content.find((b) => b.type === "text")?.text ?? "{}";
    // Strip markdown code fences if present
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { title?: unknown; tags?: unknown };

    // Clamp title to ≤6 words; fallback to first 6 words of prompt
    const rawTitle = typeof parsed.title === "string" ? parsed.title : "";
    const titleWords = rawTitle.trim().split(/\s+/).filter(Boolean);
    title =
      titleWords.length > 0
        ? titleWords.slice(0, 6).join(" ")
        : promptText.trim().split(/\s+/).slice(0, 6).join(" ");

    // Clamp tags to ≤5; only strings
    if (Array.isArray(parsed.tags)) {
      tags = (parsed.tags as unknown[])
        .filter((t): t is string => typeof t === "string")
        .slice(0, 5);
    } else {
      tags = [];
    }
  } catch {
    // On JSON parse error or model call failure: fall back to prompt-derived title
    // (claudeFor's flagGatewayError already filed the P3 flag — no double-flag)
    title = promptText.trim().split(/\s+/).slice(0, 6).join(" ");
    tags = [];
  }

  // Derive slug once — kebab-case lowercase, only [a-z0-9-], satisfies Steward constraint
  const slug = deriveSlug(title) || deriveSlug(promptText);

  return { title, tags, slug };
}

/**
 * Derive a slug from a title string.
 * Output: lowercase, spaces→hyphens, non-[a-z0-9-] stripped, leading/trailing hyphens stripped.
 * Always returns a non-empty string for non-empty input (falls back to "prompt" only if
 * the entire title normalizes to empty).
 */
export function deriveSlug(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, ""); // strip leading/trailing hyphens
  return slug || "prompt";
}

/**
 * Resolve a slug collision by appending -2, -3, … until the slug is free.
 * Checks the D1 prompts table (positional ? only).
 *
 * @param db   D1Database (positional ? only)
 * @param base The initially-derived slug (e.g. "my-prompt")
 * @returns    A slug that does NOT yet exist in the prompts table
 */
export async function resolveSlug(db: D1Database, base: string): Promise<string> {
  // Check if the base slug is free
  const existing = await db
    .prepare("SELECT slug FROM prompts WHERE slug = ?")
    .bind(base)
    .first<{ slug: string }>();

  if (!existing) return base;

  // Collision: try -2, -3, … up to -99 (personal use: ≤500 rows/tool, D-05 append-only)
  for (let suffix = 2; suffix <= 99; suffix++) {
    const candidate = `${base}-${suffix}`;
    const row = await db
      .prepare("SELECT slug FROM prompts WHERE slug = ?")
      .bind(candidate)
      .first<{ slug: string }>();
    if (!row) return candidate;
  }

  // Extremely unlikely for personal use — fall through with a timestamp suffix
  return `${base}-${Date.now()}`;
}
