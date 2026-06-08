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
 * Runs a final redaction pass: any value that looks like a password or 2FA code
 * is replaced with an empty string (defense-in-depth, T-04-34).
 *
 * Pattern: 6-digit numeric strings are typically 2FA codes → strip them.
 * Passwords are NEVER in the Codex registration section, but we guard regardless.
 */
export function serializeFields(fields: RegistrationFields): string {
  // Deep-copy to avoid mutation
  const safe = JSON.parse(JSON.stringify(fields)) as Record<string, unknown>;

  // Strip any value that looks like a 2FA code (6–8 digit numeric strings)
  // This is a belt-and-suspenders guard — the Codex section should never contain them.
  function stripSensitive(obj: unknown): unknown {
    if (typeof obj === "string") {
      // 6-8 digit numeric string = likely 2FA code → strip
      if (/^\d{6,8}$/.test(obj)) return "";
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

  return JSON.stringify(stripSensitive(safe));
}
