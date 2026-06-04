import type { WireEvent } from "@atlas/wire";

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

/** The ONLY HTTP verbs Steward is ever permitted to enqueue (Pillar 2). */
const SAFE_METHODS = ["PATCH", "POST"] as const;
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
  // an accidental future edit that introduced one would throw here.
  if (!SAFE_METHODS.includes(method)) {
    throw new Error(`refusing non-safe outbound method: ${method}`);
  }

  return {
    idem: e.idempotencyKey,
    path,
    method,
    headers: JSON.stringify(headers),
    body: JSON.stringify(e.payload),
  };
}
