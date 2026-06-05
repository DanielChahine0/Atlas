/**
 * Herald output-side redaction guardrail — the NON-NEGOTIABLE security invariant.
 *
 * Defense-in-depth (CLAUDE.md): the Google MCP strips Type/Security bodies server-side,
 * THIS guardrail catches a leak in the synthesized OUTPUT (P1/P2 block), and a CI unit test
 * backstops it. "A prompt instruction alone is NOT sufficient."
 *
 * The guardrail runs `containsSecret()` over the FINAL synthesized digest text. If it trips,
 * the draft is NOT created, a P2 is raised (with a NEUTRAL detail — never the secret), and a
 * blocked result is returned. On clean output the digest passes through unchanged.
 */

import { redact, containsSecret } from "@atlas/security";
import { flag } from "@atlas/shared";
import type { RawIncident } from "@atlas/shared";

/** The result of the output guardrail. */
export interface GuardrailResult {
  /** True when a secret was detected in the OUTPUT and the draft must be blocked. */
  blocked: boolean;
  /** The text to use downstream (redacted on a block, unchanged when clean). */
  text: string;
}

/**
 * Run the output guardrail over a synthesized digest body. On a leak: raise P2 and return
 * `{ blocked:true, text: redact(body) }` (the caller must NOT create the draft). On clean
 * output: `{ blocked:false, text: body }`.
 *
 * The P2 detail is deliberately NEUTRAL (never the offending secret) — a leak detail that
 * carried the secret would itself be a leak.
 */
export async function guardDigestOutput(
  env: { INCIDENTS: Queue<RawIncident> },
  body: string,
): Promise<GuardrailResult> {
  if (containsSecret(body)) {
    await flag(
      env,
      "P2",
      "herald digest redaction tripped",
      "A secret-shaped token survived into the synthesized digest output; the draft was blocked before creation.",
      { sourceAgent: "Herald", kind: "security_leak_blocked" },
    );
    return { blocked: true, text: redact(body) };
  }
  return { blocked: false, text: body };
}

/**
 * The PRE-synthesis strip applied to a raw snippet before it reaches the model. Type/Security
 * threads are listed by sender+subject only; this strips any code token / reset-or-login URL
 * from a snippet so the model never sees (and so cannot echo) a secret.
 */
export function stripSnippet(snippet: string): string {
  return redact(snippet);
}
