import type { WireEvent } from "@atlas/wire";
import { NonRetryableError } from "cloudflare:workflows";

/**
 * The SINGLE op→Obsidian-Local-REST-v3 mapping source for the whole repo
 * (GLOBAL DECISION 5). 00-08's outbound Obsidian bridge IMPORTS `toOutboxIntent`
 * from `@atlas/steward-core`; it must NEVER define a second map. Any new op→REST
 * row (e.g. an `upsert(view)` → `PUT /vault/Dashboard/Today.md` row) is added
 * HERE, never duplicated downstream.
 *
 * Mapping (RESEARCH §"op → Obsidian Local REST v3 mapping (T15)", build-plan
 * lines 675-682):
 *   increment → PATCH /vault/Counters/metrics.md   (Operation: replace,
 *               Target-Type: frontmatter; writes the ABSOLUTE value from D1)
 *   upsert    → PATCH /vault/<note>.md             (Create-Target-If-Missing: true)
 *   append    → POST  /vault/Dashboard/Heartbeat.md (Target-Type: heading)
 *
 * SECURITY (Pillar 2 — "Suggest, don't destroy"): Steward NEVER emits a
 * destructive HTTP verb. The three ops map ONLY to PATCH / POST; there is no
 * removal verb anywhere in this map and no branch can produce one. A guard at the
 * bottom asserts the produced method is one of the allow-listed safe verbs — an
 * unmapped op throws rather than silently defaulting to anything outward.
 */

/** The intent row shape persisted to `vault_outbox` (PK `idem`). */
export interface OutboxIntent {
  idem: string;
  path: string;
  method: string;
  headers: string;
  body: string;
}

/**
 * The ONLY HTTP verbs Steward is ever permitted to enqueue (Pillar 2). Exported so the
 * outbound Obsidian bridge (00-08) can assert the no-DELETE invariant against THIS single
 * canonical allow-list rather than redefining it (GLOBAL DECISION 5: the op→REST source
 * lives here, never duplicated downstream). There is no removal verb anywhere in this list.
 */
export const SAFE_METHODS = ["PATCH", "POST", "PUT"] as const;
type SafeMethod = (typeof SAFE_METHODS)[number];

/**
 * Map a §6.4 Wire event to a single outbound Local-REST-v3 intent row.
 *
 * `idem` derives from `e.idempotencyKey` so a replayed enqueue is itself deduped
 * by the `vault_outbox` PRIMARY KEY (`idem`) — a replay inserts the same row, a
 * no-op (Pillar 5). `op:"increment"` writes the ABSOLUTE value (the caller-side
 * D1 batch already derived it; the frontmatter has no atomic +1).
 */
export function toOutboxIntent(e: WireEvent): OutboxIntent {
  let path: string;
  let method: SafeMethod;
  let headers: Record<string, string>;

  switch (e.op) {
    case "increment": {
      // Counters metrics note — replace the frontmatter field with the absolute value.
      const target = String(e.payload.counter ?? e.entity);
      path = "/vault/Counters/metrics.md";
      method = "PATCH";
      headers = {
        "Operation": "replace",
        "Target-Type": "frontmatter",
        "Target": target,
        "Content-Type": "text/markdown",
      };
      break;
    }
    case "upsert": {
      // ── NEW: full-note PUT (Librarian Prompts/<slug>.md) ──────────────────────
      // When payload.fullNote===true the caller intends a whole-file overwrite (PUT),
      // not a frontmatter-field patch. The only allowed destination is the Prompts/
      // subtree — attempting to PUT to Dashboard/, Counters/, or any other path would
      // silently corrupt a view. Fail loud (NonRetryableError → consumer acks + Flagger
      // P3 downstream) instead of writing to a wrong path (Pitfall 1, T-5-Tamper).
      if (e.payload.fullNote === true) {
        const notePath = String(e.payload.notePath ?? "");
        // A bare startsWith("Prompts/") prefix check is bypassable via a traversal
        // segment ("Prompts/../Dashboard/x.md" passes the prefix but escapes the
        // subtree when the URL resolves). Enforce the whole shape instead: exactly
        // ONE filename segment under Prompts/, .md extension, conservative character
        // allowlist (no "/", "\", "%", whitespace, or control chars — kills
        // traversal, encoded traversal, and URL/header injection in one move). The
        // explicit ".." rejection is defense-in-depth on top of the allowlist.
        if (!/^Prompts\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(notePath) || notePath.includes("..")) {
          throw new NonRetryableError(
            `fullNote upsert requires a single-segment "Prompts/<slug>.md" notePath; got "${notePath}"`,
          );
        }
        // A missing/empty noteBody would silently PUT an EMPTY file over an existing
        // note, and a non-string body would write "[object Object]" — both silent and
        // destructive ("suggest, don't destroy"). Fail loud like the bad-path guard.
        if (typeof e.payload.noteBody !== "string" || e.payload.noteBody.length === 0) {
          throw new NonRetryableError(
            `fullNote upsert requires a non-empty string noteBody for "${notePath}"`,
          );
        }
        // Honest typing (no unchecked `as SafeMethod` cast — the annotation makes the
        // compiler verify "PUT" is genuinely in the SAFE_METHODS tuple) + the SAME
        // runtime Pillar-2 belt as the bottom guard: this early return must not be the
        // one branch that can skip the safe-verb assertion.
        const fullNoteMethod: SafeMethod = "PUT";
        if (!SAFE_METHODS.includes(fullNoteMethod)) {
          throw new Error(`refusing non-safe outbound method: ${fullNoteMethod}`);
        }
        // Early return: body is the raw markdown (NOT the whole payload JSON).
        return {
          idem: e.idempotencyKey,
          path: `/vault/${notePath}`,
          method: fullNoteMethod,
          headers: JSON.stringify({
            "Content-Type": "text/markdown",
            "X-Atlas-Idem": e.idempotencyKey,
          }),
          body: e.payload.noteBody, // guarded above: non-empty string
        };
      }
      // ── EXISTING: frontmatter-field upsert (unchanged) ────────────────────────
      // Stable-row view note — last-writer-wins; create the note/field if missing.
      const note = String(e.payload.note ?? e.entity);
      const field = String(e.payload.field ?? e.entity);
      path = `/vault/${note}.md`;
      method = "PATCH";
      headers = {
        "Operation": "replace",
        "Target-Type": "frontmatter",
        "Target": field,
        "Create-Target-If-Missing": "true",
        "Content-Type": "text/markdown",
      };
      break;
    }
    case "append": {
      // Feed/log — append under a heading (never replace).
      path = "/vault/Dashboard/Heartbeat.md";
      method = "POST";
      headers = {
        "Target-Type": "heading",
        "Target": String(e.payload.heading ?? "Run Log"),
        "Content-Type": "text/markdown",
      };
      break;
    }
    default: {
      // The §6.4 op enum is exactly increment|upsert|append. Anything else is a
      // contract violation — fail loud rather than fall through to an outward verb.
      const bad: never = e.op;
      throw new Error(`unmappable op for outbox intent: ${String(bad)}`);
    }
  }

  // Pillar-2 belt: the produced verb MUST be in the safe allow-list. This makes a
  // destructive verb structurally unreachable — no op branch can yield one, and
  // an accidental future edit that introduced one would throw here. (The fullNote
  // early return above carries its own identical belt — no branch bypasses it.)
  if (!SAFE_METHODS.includes(method)) {
    throw new Error(`refusing non-safe outbound method: ${method}`);
  }

  // W14 — per-intent DEDUPE KEY. Every outbound intent carries its stable idem as
  // the `X-Atlas-Idem` header so the append→POST (which Obsidian would otherwise
  // append unconditionally, duplicating a feed line on a redelivery) is idempotent
  // at the write boundary: a reclaimed/redelivered intent carries the SAME idem, so
  // the daemon/Obsidian side can dedupe on it. The vault_outbox PK (idem) dedups the
  // ENQUEUE; this dedups the OUTBOUND WRITE. The header is non-destructive metadata.
  headers["X-Atlas-Idem"] = e.idempotencyKey;

  return {
    idem: e.idempotencyKey,
    path,
    method,
    headers: JSON.stringify(headers),
    body: JSON.stringify(e.payload),
  };
}
