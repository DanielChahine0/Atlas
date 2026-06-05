/**
 * Scout relevance scorer — pure function, no I/O, no imports from env or fetch.
 *
 * Scores an EventCandidate (0-100) against:
 *   - Codex skills/projects  (D2-12)
 *   - A KV keyword list      (scout/interests, also D2-12)
 *
 * Lower-level breakdown (additive, capped at 100):
 *   - Each skill / project that appears in title/description: +15 (max 60)
 *   - Each KV keyword that appears in title/description: +10 (max 40)
 *   - Extra +5 for online events (generally more accessible)
 */

import type { EventCandidate } from "./sources.js";

/**
 * Score an EventCandidate against Codex skills/projects and KV keyword list.
 * Returns an integer in [0, 100]. No I/O — pure deterministic function.
 *
 * @param candidate  The event to score.
 * @param skills     Codex §5 skill names (e.g. ["TypeScript", "Node.js"]).
 * @param projects   Codex §6 project names (e.g. ["Atlas orchestrator"]).
 * @param keywords   KV scout/interests keyword list.
 */
export function relevance(
  candidate: EventCandidate,
  skills: string[],
  projects: string[],
  keywords: string[],
): number {
  const haystack =
    `${candidate.title} ${candidate.description ?? ""} ${candidate.location ?? ""}`.toLowerCase();

  let score = 0;

  // Skills + projects — higher-value matches (Codex-derived, D2-12)
  for (const term of [...skills, ...projects]) {
    if (term.trim().length === 0) continue;
    if (haystack.includes(term.toLowerCase())) {
      score += 15;
    }
  }

  // KV keyword matches — supplementary relevance signal
  for (const kw of keywords) {
    if (kw.trim().length === 0) continue;
    if (haystack.includes(kw.toLowerCase())) {
      score += 10;
    }
  }

  // Online events are generally more accessible (+5 signal boost)
  if (candidate.online) score += 5;

  return Math.min(100, score);
}
