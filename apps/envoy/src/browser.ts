/**
 * apps/envoy/src/browser.ts
 *
 * Enqueues linkedin_prefill / x_prefill browser_action_outbox items for the
 * daemon's browser runner (04-04). The daemon pre-fills the composer and LEAVES IT
 * for the OWNER to click Post — Envoy NEVER auto-submits (D4-08, Pillar 2).
 *
 * Security:
 *   - T-04-36: no auto-post code path. Only enqueue_prefill actions.
 *   - T-04-41: fields JSON carries only Codex brand copy (name, blurb, text).
 *              NO passwords, NO 2FA codes, NO security tokens, NO email bodies.
 *   - Positional ? params only (D1 rule).
 *
 * The outbox row is later claimed by the daemon via GET /browser/poll → the runner
 * fills the form → owner clicks Post. The daemon acks via POST /browser/ack.
 */

// ─── ULID generator (inline — same as packages/gate/src/index.ts, no new dep) ─

const CROCKFORD_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
  const now = Date.now();
  let ms = now;
  const tChars: string[] = new Array(10);
  for (let i = 9; i >= 0; i--) {
    tChars[i] = CROCKFORD_CHARS[ms & 0x1f]!;
    ms = Math.floor(ms / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(10));
  let bits = BigInt(0);
  for (const byte of rand) {
    bits = (bits << 8n) | BigInt(byte);
  }
  const rChars: string[] = new Array(16);
  for (let i = 15; i >= 0; i--) {
    rChars[i] = CROCKFORD_CHARS[Number(bits & 0x1fn)]!;
    bits >>= 5n;
  }
  return tChars.join("") + rChars.join("");
}

// ─── Env surface (minimal — DB only) ─────────────────────────────────────────

export interface BrowserEnv {
  DB: D1Database;
}

// ─── EnqueueResult ────────────────────────────────────────────────────────────

export interface EnqueueResult {
  ok: boolean;
  workItemId?: string;
  detail: string;
}

// ─── enqueuePrefill ───────────────────────────────────────────────────────────

/**
 * Enqueue a linkedin_prefill or x_prefill browser_action_outbox row.
 *
 * The daemon will:
 *   1. Poll GET /browser/poll → claim the item
 *   2. runBrowserAction() → goto composer URL → fill fields → STOP (no submit)
 *   3. The owner sees the pre-filled composer and clicks Post themselves (D4-08)
 *   4. Ack POST /browser/ack with outcome { status: "success" | "error" }
 *
 * @param env        - DB binding (D1)
 * @param platform   - "linkedin" | "x"
 * @param gateId     - The gate row ID (FK → gate_pending.id, app-enforced)
 * @param draftText  - The literal (possibly edited) draft text from the gate artifact
 * @param targetUrl  - The platform composer URL (hardcoded per platform)
 */
export async function enqueuePrefill(
  env: BrowserEnv,
  platform: "linkedin" | "x",
  gateId: string,
  draftText: string,
  targetUrl: string,
): Promise<EnqueueResult> {
  const actionType = platform === "linkedin" ? "linkedin_prefill" : "x_prefill";
  const workItemId = ulid();

  // Compose fields JSON — ONLY brand copy, NEVER credentials (T-04-41).
  // The draft text is the literal artifact the owner will see pre-filled.
  // Redact any accidental security-sensitive patterns (defense in depth).
  const safeText = redactSensitive(draftText);
  const fieldsJson = JSON.stringify({ text: safeText });

  try {
    await env.DB.prepare(
      `INSERT INTO browser_action_outbox (id, agent, action_type, fields, gate_id, target_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
      .bind(workItemId, "Envoy", actionType, fieldsJson, gateId, targetUrl, Date.now())
      .run();

    return {
      ok: true,
      workItemId,
      detail: `${actionType} enqueued (id=${workItemId})`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `Failed to enqueue ${actionType}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Platform URLs ────────────────────────────────────────────────────────────

/** Standard platform composer URLs for pre-fill. These are public URLs, not secrets. */
export const PLATFORM_URLS: Record<"linkedin" | "x", string> = {
  linkedin: "https://www.linkedin.com/feed/",
  x: "https://x.com/compose/tweet",
};

// ─── redactSensitive ─────────────────────────────────────────────────────────

/**
 * Defense-in-depth redaction: strip any text that looks like a 2FA code, URL with
 * "reset", "login", "verify", "token", or "auth" in the path, or an OAuth token.
 * This mirrors the Herald digest-builder guardrail (CLAUDE.md security invariant).
 *
 * Caveat: legitimate marketing URLs containing these words may be stripped.
 * That is intentional — fail-closed is the correct posture for irreversible posts.
 */
function redactSensitive(text: string): string {
  return text
    // Strip 6-8 digit numeric codes that look like 2FA (aggressive but fail-closed)
    // Only in a context that looks like "code: 123456" or "OTP: 654321"
    .replace(/\b(?:code|otp|pin|2fa|token)\s*[:=]?\s*\d{4,8}\b/gi, "[REDACTED]")
    // Strip URLs containing reset/login/verify/auth/token in the path
    .replace(/https?:\/\/[^\s]*(?:reset|login|verify|auth|token)[^\s]*/gi, "[REDACTED]")
    // Strip anything that looks like a Bearer token or API key
    .replace(/\b(?:Bearer|sk-|ghs_|ghp_)[A-Za-z0-9_.-]+/g, "[REDACTED]");
}
