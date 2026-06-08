/**
 * apps/envoy/src/draft.ts
 *
 * Reads the Codex and drafts FOUR literal artifacts from it for brand publishing:
 *   1. LinkedIn experience/project copy (max ~1500 chars, no hashtags in body)
 *   2. GitHub profile README section (markdown, ≤300 chars blurb + badges optional)
 *   3. X post (≤280 chars, 1-2 hashtags max)
 *   4. Portfolio entry (markdown card for the portfolio repo)
 *
 * ALL drafts are Codex-sourced (identity, bios, socials, projects, work, voice sections).
 * Claude routes through the AI Gateway via claudeFor(env,"Envoy") — Sonnet tier (CLAUDE.md).
 * No direct api.anthropic.com call.
 *
 * Per-platform formatting follows docs/agents/envoy.md:
 *   LinkedIn: first person, past tense for completed, present for ongoing; 3-5 bullet highlights
 *   GitHub:   heading + short blurb + tech-stack line (from Codex projects.tags)
 *   X:        punchy, <280 chars, 1-2 relevant hashtags at end, no @mentions
 *   Portfolio: markdown card with name, blurb, tech stack, repo/demo links
 *
 * Security: 2FA codes / password-reset links / login URLs NEVER appear in drafts —
 * all content is sourced from the Codex brand sections, not email bodies.
 */

import { claudeFor, modelFor } from "@atlas/model";
import type { Codex } from "@atlas/codex";
import type { RawIncident } from "@atlas/shared";

// ─── TargetDraft ─────────────────────────────────────────────────────────────

/** One per-platform draft (platform + literal text). */
export interface TargetDraft {
  platform: "linkedin" | "github_readme" | "x" | "portfolio";
  /** Literal post/commit text ready for Envoy to present to the owner for approve/edit. */
  draft: string;
}

// ─── Env surface (what draft.ts needs — must match ModelEnv from @atlas/model) ─

/** Minimal env surface for draft.ts — must include all fields claudeFor() needs. */
export interface DraftEnv {
  CONFIG: KVNamespace;
  AI?: Fetcher;
  INCIDENTS?: Queue<RawIncident>;
  ANTHROPIC_API_KEY?: { get(): Promise<string | null | undefined> };
  CF_AIG_TOKEN?: { get(): Promise<string | null | undefined> };
  AIG_ACCOUNT_ID?: string;
  AIG_GATEWAY_ID?: string;
  [key: string]: unknown;
}

// ─── slugify ─────────────────────────────────────────────────────────────────

/**
 * Converts a project name to a stable slug (lowercase, hyphens, no specials).
 * e.g. "My Cool Project" → "my-cool-project"
 * This is the CANONICAL slugify used for idempotency keys — never crypto.randomUUID().
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── draftArtifacts ──────────────────────────────────────────────────────────

/**
 * Read the Codex and draft all four literal brand artifacts for a given project.
 * Returns TargetDraft[] — one entry per target platform.
 *
 * This function is testable: inject a mock AI binding to avoid real Claude calls in tests.
 * The drafts are returned verbatim for the gate artifact (owner approves/edits before publish).
 *
 * @param env         - Envoy's env (AI + CONFIG + model bindings)
 * @param codex       - The parsed Codex (identity, bios, socials, projects, work, voice)
 * @param projectName - The project name (e.g. "My Cool Project")
 * @param projectSlug - The project slug (e.g. "my-cool-project") — for idempotency
 */
export async function draftArtifacts(
  env: DraftEnv,
  codex: Codex,
  projectName: string,
  projectSlug: string,
): Promise<TargetDraft[]> {
  const claude = await claudeFor("Envoy", env as Parameters<typeof claudeFor>[1]);
  const resolvedModel = await modelFor("Envoy", env as Parameters<typeof modelFor>[1]);

  // Build a rich system prompt from the Codex brand sections
  const identity = codex.identity as Record<string, unknown>;
  const bios = codex.bios as Record<string, unknown>;
  const socials = codex.socials as Record<string, unknown>;
  const projects = codex.projects as Array<Record<string, unknown>>;
  const work = codex.work as Array<Record<string, unknown>>;

  // Find this specific project in the Codex (by name or slug match)
  const projectEntry = projects.find(
    (p) =>
      String(p.name ?? "").toLowerCase() === projectName.toLowerCase() ||
      slugify(String(p.name ?? "")) === projectSlug,
  );

  const ownerName = String(identity.name ?? identity.full_name ?? "Daniel Chahine");
  const shortBio = String(bios.short ?? bios.one_liner ?? "");
  const linkedinUrl = String(socials.linkedin ?? "");
  const githubUrl = String(socials.github ?? "");
  const xHandle = String(socials.x ?? socials.twitter ?? "");

  const projectBlurb = projectEntry
    ? String(projectEntry.blurb ?? projectEntry.description ?? "")
    : "";
  const projectTags = projectEntry
    ? ((projectEntry.tags as string[]) ?? []).join(", ")
    : "";
  const projectRepo = projectEntry ? String(projectEntry.repo ?? "") : "";
  const projectDemo = projectEntry ? String(projectEntry.demo ?? "") : "";

  // Recentmost work experience for context
  const latestRole = work[0]
    ? `${String((work[0] as Record<string, unknown>).title ?? "")} at ${String((work[0] as Record<string, unknown>).company ?? "")}`
    : "";

  const systemPrompt = `You are drafting LITERAL brand-copy artifacts for ${ownerName} to publish on personal branding channels.
ALL content must be sourced from the provided Codex facts — no fabrication.
Owner: ${ownerName}
Short bio: ${shortBio}
Latest role: ${latestRole}
LinkedIn: ${linkedinUrl}
GitHub: ${githubUrl}
X handle: ${xHandle}

SECURITY RULE: NEVER include 2FA codes, password-reset links, login URLs, or any authentication material in any draft.
Only include public brand information from the Codex.`;

  const userPrompt = `Draft FOUR separate brand artifacts for the project "${projectName}" (slug: ${projectSlug}).

Project details from Codex:
- Blurb: ${projectBlurb || "(not in Codex yet — infer from project name)"}
- Tech stack: ${projectTags || "(not specified)"}
- Repo URL: ${projectRepo || "(not specified)"}
- Demo URL: ${projectDemo || "(not specified)"}

Required format — respond ONLY with a JSON object with exactly these four keys:

{
  "linkedin": "<LinkedIn experience/project update — first person, past tense for shipped, present for ongoing. 3-5 bullet highlights using • bullet char. Max 1500 chars. No hashtags in body. End with a 1-line summary. No @mentions.>",
  "github_readme": "<GitHub profile README section — markdown. One ## heading with project name, 1-2 sentence blurb (from Codex), tech stack badges or inline list. Max 300 chars for the blurb paragraph.>",
  "x": "<X post — punchy, <280 chars total including spaces. 1-2 relevant hashtags at the END only. No @mentions other than owner's own handle if desired. Starts with a strong opening hook.>",
  "portfolio": "<Portfolio entry markdown card — ## heading, blurb paragraph (2-3 sentences), **Tech:** stack line, **Repo:** link (if available), **Demo:** link (if available). Concise and scannable.>"
}

Return ONLY the JSON object — no surrounding text, no markdown fences.`;

  const response = await claude.messages.create({
    model: resolvedModel,
    max_tokens: 2048,
    messages: [{ role: "user", content: userPrompt }],
    system: systemPrompt,
  });

  // Extract text content
  const message = response as { content: Array<{ type: string; text?: string }> };
  const textBlock = message.content.find((b) => b.type === "text");
  const rawText = textBlock?.text?.trim() ?? "{}";

  // Parse the JSON response
  let draftsObj: Record<string, string> = {};
  try {
    // Strip markdown fences if present (defensive)
    const cleaned = rawText.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "");
    draftsObj = JSON.parse(cleaned) as Record<string, string>;
  } catch {
    // Fallback: use empty strings (gate will still open; owner will see blank drafts)
    draftsObj = {
      linkedin: `[Draft unavailable — please describe your ${projectName} experience here]`,
      github_readme: `## ${projectName}\n\n[Add your project description here]\n`,
      x: `Shipped ${projectName}! [Add details here]`,
      portfolio: `## ${projectName}\n\n[Add project details here]\n`,
    };
  }

  const targets: TargetDraft[] = [
    { platform: "linkedin", draft: String(draftsObj.linkedin ?? "") },
    { platform: "github_readme", draft: String(draftsObj.github_readme ?? "") },
    { platform: "x", draft: String(draftsObj.x ?? "") },
    { platform: "portfolio", draft: String(draftsObj.portfolio ?? "") },
  ];

  return targets;
}
