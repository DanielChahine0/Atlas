/**
 * mcp-google scope floors — the per-agent LEAST-PRIVILEGE OAuth scope predicates.
 *
 * Extracted from index.ts (Phase 0 held only the gmail.modify floor inline) so the
 * four reasoning agents added in Phase 1 (Herald / Forge / Sundial / Compass) each
 * enforce their EXACT scope floor by construction:
 *
 *   - Filer    → gmail.modify ONLY (labels; never delete/archive — that needs the
 *                never-granted full https://mail.google.com/ scope).
 *   - Herald   → gmail.readonly (read threads) + gmail.compose (create DRAFT only —
 *                NO send tool is registered; NO modify).
 *   - Forge    → gmail.readonly ONLY (read; no draft, no modify).
 *   - Sundial  → calendar.events (create/update/list; NO delete tool registered).
 *   - Compass  → calendar.readonly ONLY (read; never writes the calendar).
 *
 * Hard rule (CLAUDE.md "Least-privilege OAuth per agent"): a granted scope does NOT
 * authorize a broader capability. gmail.modify does NOT imply gmail.readonly here —
 * every predicate tests membership against its OWN exact alias set. A token must carry
 * the specific scope the tool requires (fail-closed: empty grant ⇒ every predicate
 * false ⇒ forbiddenResult()).
 *
 * The full URI form is what the OAuth grant carries; the short form is accepted as an
 * alias for resilience (mirrors the Phase-0 gmail.modify pattern).
 */

import { getMcpAuthContext } from "agents/mcp";

/** Filer's floor — labels only (the Phase-0 surface, moved here unchanged). */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_MODIFY_ALIASES = new Set([GMAIL_MODIFY_SCOPE, "gmail.modify"]);

/** Herald's draft-create floor — DRAFT only, never send (no send tool exists). */
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_COMPOSE_ALIASES = new Set([GMAIL_COMPOSE_SCOPE, "gmail.compose"]);

/** Herald/Forge read floor — read threads/labels, never mutate the inbox. */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_READONLY_ALIASES = new Set([GMAIL_READONLY_SCOPE, "gmail.readonly"]);

/** Sundial's calendar-write floor — create/update/list; NO delete tool registered. */
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_EVENTS_ALIASES = new Set([CALENDAR_EVENTS_SCOPE, "calendar.events"]);

/** Compass's read floor — read free/busy + events, never write the calendar. */
export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const CALENDAR_READONLY_ALIASES = new Set([CALENDAR_READONLY_SCOPE, "calendar.readonly"]);

/**
 * Read the inbound granted scopes from the MCP auth context the OAuthProvider
 * attaches (`ctx.props.scopes`). A missing context / missing scopes array means an
 * unauthenticated or scope-less caller — treated as the empty set (fail-closed).
 */
export function grantedScopes(): string[] {
  const auth = getMcpAuthContext();
  const raw = auth?.props?.["scopes"];
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string");
  }
  return [];
}

/** True iff the granted scopes include the `gmail.modify` floor (in either form). */
export function hasGmailModify(scopes: string[]): boolean {
  return scopes.some((s) => GMAIL_MODIFY_ALIASES.has(s));
}

/** True iff the granted scopes include the `gmail.compose` floor (draft-create). */
export function hasGmailCompose(scopes: string[]): boolean {
  return scopes.some((s) => GMAIL_COMPOSE_ALIASES.has(s));
}

/** True iff the granted scopes include the `gmail.readonly` floor (read threads). */
export function hasGmailReadonly(scopes: string[]): boolean {
  return scopes.some((s) => GMAIL_READONLY_ALIASES.has(s));
}

/** True iff the granted scopes include the `calendar.events` floor (write, no delete). */
export function hasCalendarEvents(scopes: string[]): boolean {
  return scopes.some((s) => CALENDAR_EVENTS_ALIASES.has(s));
}

/** True iff the granted scopes include the `calendar.readonly` floor (read only). */
export function hasCalendarReadonly(scopes: string[]): boolean {
  return scopes.some((s) => CALENDAR_READONLY_ALIASES.has(s));
}

/**
 * The default 403 text (back-compat with the Phase-0 gmail.modify tools). Names the
 * gmail.modify scope so existing scope.test.ts assertions keep passing.
 */
export const FORBIDDEN_TEXT =
  "403 Forbidden: this tool requires the gmail.modify scope, which the presented token does not carry.";

/**
 * A 403-equivalent MCP error result for an out-of-scope tool call. Parameterizable so
 * each Phase-1 tool can NAME the specific scope it required in the message; defaults to
 * the Phase-0 gmail.modify text so existing Filer tools are unchanged.
 */
export function forbiddenResult(requiredScope?: string) {
  const text = requiredScope
    ? `403 Forbidden: this tool requires the ${requiredScope} scope, which the presented token does not carry.`
    : FORBIDDEN_TEXT;
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}
