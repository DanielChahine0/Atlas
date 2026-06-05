/**
 * Herald digest synthesis — buckets → a skimmable digest body.
 *
 * The synthesis pass (Sonnet via claudeFor("herald",env); model overridable via CONFIG
 * `model.synthesize`) writes the prose. BEFORE synthesis, every snippet is stripped of
 * code tokens + reset/login URLs (stripSnippet); Type/Security threads are listed by
 * sender+subject only and ⚠ Phishing-Suspect threads carry a visible warning + NO clickable
 * link. The deterministic fallback renderer below produces a faithful section-ordered body
 * WITHOUT a model (used when no model is wired and as the low-confidence fallback).
 */

import { SECTIONS, type Buckets, type DigestThread } from "./bucket.js";
import { stripSnippet } from "./guardrail.js";

const SECTION_GLYPH: Record<string, string> = {
  Important: "★ IMPORTANT",
  "Action Required": "▲ ACTION REQUIRED",
  "Action Recommended": "△ ACTION RECOMMENDED",
  Advertisement: "✦ ADVERTISEMENT",
  Other: "· OTHER",
};

function isSecurity(t: DigestThread): boolean {
  return t.labels.includes("Type/Security");
}
function isPhishing(t: DigestThread): boolean {
  return t.labels.includes("⚠ Phishing-Suspect");
}

/** Render ONE thread's bullet, security-aware (sender+subject only; no codes/links). */
function renderThread(t: DigestThread): string {
  if (isSecurity(t)) {
    // Sender + subject only; a flat note; never a code or link.
    return `  • ${stripSnippet(t.sender)} — ${stripSnippet(t.subject)}   [security-sensitive; opened in Gmail only]`;
  }
  if (isPhishing(t)) {
    return `  • ⚠ ${stripSnippet(t.sender)} — ${stripSnippet(t.subject)}   [⚠ Phishing-Suspect — do not click; verify in Gmail]`;
  }
  const tags = t.labels.length ? `   [${t.labels.join(" · ")}]` : "";
  return `  • ${stripSnippet(t.subject)} — ${stripSnippet(t.sender)}${tags}`;
}

/**
 * Deterministic digest renderer — produces the section-ordered body with EVERY snippet
 * pre-stripped. This is the fallback when no model is wired and the literal substrate the
 * model pass embellishes. Sections always render in the fixed SECTIONS order.
 */
export function renderDigestBody(date: string, buckets: Buckets): string {
  const lines: string[] = [`Atlas Digest — ${date} (daily)`, ""];
  for (const s of SECTIONS) {
    const threads = buckets[s];
    lines.push(`${SECTION_GLYPH[s] ?? s} (${threads.length})`);
    for (const t of threads) lines.push(renderThread(t));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** The Gmail draft subject for a daily digest. */
export function draftSubject(date: string): string {
  return `Atlas Digest — ${date} (daily)`;
}
