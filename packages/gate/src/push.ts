/**
 * push.ts — Confirm-push payload BUILDER for the gate primitive (D4-04).
 *
 * buildConfirmPush() ONLY builds the NtfyPayload — it does NOT dispatch the push.
 * The SEND lives in openGate() (packages/gate/src/index.ts) — the single chokepoint
 * per D4-04. Keeping the build pure makes it unit-testable without a network mock.
 *
 * Pattern: mirrors apps/flagger/src/push.ts (same ntfy.sh endpoint, same HTTP-action
 * button shape, same redact() guard on title+body before external egress). The key
 * difference is that the gate push uses a 'view' action (not 'http') pointing to the
 * confirm page URL — no inline approve for irreversible actions (D4-01/UI-SPEC).
 *
 * Security invariant: redact() is applied to title + body before returning the payload.
 * The confirm-link URL itself is NOT redacted (it carries the opaque token, not a
 * 2FA code or reset link — the token is a random hex string with no PII).
 */

import { redact } from "@atlas/security";
import type { NtfyPayload } from "./schema.js";

/** Maximum push body length (ntfy.sh recommendation + UI-SPEC § push-body-invariants). */
const MAX_BODY_CHARS = 120;

/**
 * Build the ntfy confirm-push payload for a pending gate.
 *
 * The returned payload carries exactly ONE 'view' action with:
 *   label: "Review & edit"
 *   url:   `${confirmBaseUrl}/confirm?t=${plaintextToken}`
 *   clear: false  — don't dismiss the push; the owner may want to return
 *
 * This function does NOT dispatch the push — the SEND is in openGate().
 */
export function buildConfirmPush(opts: {
  confirmBaseUrl: string;
  plaintextToken: string;
  title: string;
  body: string;
}): NtfyPayload {
  // Apply redact() to title + body before egress (T-04-04: never surface 2FA/reset/login)
  const safeTitle = redact(opts.title);
  let safeBody = redact(opts.body);

  // Cap at 120 chars (UI-SPEC push-body-invariants)
  if (safeBody.length > MAX_BODY_CHARS) {
    safeBody = safeBody.slice(0, MAX_BODY_CHARS - 1) + "…";
  }

  return {
    title: safeTitle,
    message: safeBody,
    priority: 4,
    actions: [
      {
        action: "view",
        label: "Review & edit",
        url: `${opts.confirmBaseUrl}/confirm?t=${opts.plaintextToken}`,
        clear: false,
      },
    ],
  };
}
