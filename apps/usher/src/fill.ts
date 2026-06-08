/**
 * fill.ts — Codex → registration field map for Usher (event_fill_submit).
 *
 * Maps standard registration form labels to Codex-derived field values.
 * This is the SAME mapping Quill uses for autofill (local daemon side).
 * NEVER includes passwords, 2FA codes, or session tokens.
 *
 * Security invariants:
 *   - Fields carry ONLY Codex field values (name, email, phone, demographics/EEO).
 *   - NEVER passwords, session cookies, or 2FA codes (T-04-34).
 *   - The `fields` JSON written to browser_action_outbox is this mapping.
 */

// ─── Codex field types ────────────────────────────────────────────────────────

/** Subset of Codex data relevant to registration form fields. */
export interface CodexRegistrationFields {
  /** Owner's full name (e.g. "Daniel Chahine"). */
  full_name: string;
  /** Owner's email address for registrations. */
  email: string;
  /** Owner's phone number (optional — omit if not set in Codex). */
  phone?: string;
  /** Owner's professional title (e.g. "Software Engineer"). */
  title?: string;
  /** Owner's organization / company (optional). */
  organization?: string;
  /** Owner's LinkedIn URL (optional). */
  linkedin_url?: string;
  /** Owner's city / region (optional). */
  city?: string;
  /** EEO / demographics fields — only included if the form requests them. */
  eeo?: {
    gender?: string;
    ethnicity?: string;
    disability?: string;
    veteran?: string;
  };
}

/** A registration field mapping: label → value to fill. */
export interface RegistrationFields {
  /** The full name field value. */
  name: string;
  /** The email field value. */
  email: string;
  /** The phone number (if available). */
  phone: string | null;
  /** Professional title / role (if available). */
  title: string | null;
  /** Organization / company (if available). */
  organization: string | null;
  /** LinkedIn profile URL (if available). */
  linkedin_url: string | null;
  /** City or region (if available). */
  city: string | null;
  /** EEO fields (if applicable — only populated when the form requests them). */
  eeo: {
    gender: string | null;
    ethnicity: string | null;
    disability: string | null;
    veteran: string | null;
  } | null;
}

// ─── Field mapping function ───────────────────────────────────────────────────

/**
 * Build the registration field mapping from Codex-resolved fields.
 * All sensitive fields (passwords, 2FA, session tokens) are explicitly excluded —
 * this function cannot populate them even if Codex contained them.
 *
 * @param codex  The Codex-resolved registration fields.
 * @returns      A RegistrationFields map for the browser_action_outbox fields JSON.
 */
export function buildRegistrationFields(codex: CodexRegistrationFields): RegistrationFields {
  return {
    name: codex.full_name,
    email: codex.email,
    phone: codex.phone ?? null,
    title: codex.title ?? null,
    organization: codex.organization ?? null,
    linkedin_url: codex.linkedin_url ?? null,
    city: codex.city ?? null,
    eeo: codex.eeo
      ? {
          gender: codex.eeo.gender ?? null,
          ethnicity: codex.eeo.ethnicity ?? null,
          disability: codex.eeo.disability ?? null,
          veteran: codex.eeo.veteran ?? null,
        }
      : null,
  };
}

/**
 * Serialize the registration fields to JSON for storage in browser_action_outbox.
 * Runs a final redaction pass: any string value that contains a 2FA-like code
 * (6–8 consecutive digits not surrounded by other digits) is replaced with an
 * empty string (defense-in-depth, T-04-34).
 *
 * Coverage (after trimming the value):
 *   - Bare codes:    "123456"          → stripped (whole-string match)
 *   - Embedded codes: "code 123456"    → stripped (embedded match)
 *   - Trailing space: "123456 "        → stripped (after trim)
 *   - NOT stripped: "phone: +14165550123" (10-digit phone — bounded by more digits)
 *
 * TRIPWIRE: When stripping fires, `stripped` is set to true in the return value.
 * The caller should flag a P2 incident (defense-in-depth; the structural guarantee
 * is that only known Codex keys are ever serialized into this map). A fired tripwire
 * does NOT abort the registration — it signals an unexpected value in the field set.
 *
 * Returns { json, stripped } where `stripped` is true if any value was blanked.
 * Passwords are NEVER in the Codex registration section, but we guard regardless.
 */
export function serializeFields(fields: RegistrationFields): { json: string; stripped: boolean } {
  // Deep-copy to avoid mutation
  const safe = JSON.parse(JSON.stringify(fields)) as Record<string, unknown>;
  let anyStripped = false;

  // 2FA tripwire: matches 6–8 digits NOT bounded by other digits on either side.
  // Applied after trimming to catch trailing-space variants like "123456 ".
  const CODE_PATTERN = /(?<!\d)\d{6,8}(?!\d)/;

  function stripSensitive(obj: unknown): unknown {
    if (typeof obj === "string") {
      const trimmed = obj.trim();
      if (CODE_PATTERN.test(trimmed)) {
        anyStripped = true;
        return "";
      }
      return obj;
    }
    if (Array.isArray(obj)) return obj.map(stripSensitive);
    if (obj && typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        result[k] = stripSensitive(v);
      }
      return result;
    }
    return obj;
  }

  const stripped = stripSensitive(safe);
  return { json: JSON.stringify(stripped), stripped: anyStripped };
}
