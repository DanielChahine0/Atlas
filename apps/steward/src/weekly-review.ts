/**
 * Steward — the Fri 16:30 weekly-review Vault build (Plan 02-07, D2-11).
 *
 * weeklyReview(env, date) compiles ONE weekly-review note from the week's surfaced Scout
 * events + Herald week-in-review digest + jobs-funnel snapshot + open flags (the
 * docs/05-dashboard.md "Weekly Review.md" section set), and writes it through Steward's
 * EXISTING outbound path: a single `op:"upsert"` Wire event on atlas-wire (via the @atlas/wire
 * producer) that Steward's OWN sole consumer applies via applyEvent → vault_outbox. There is
 * NO new Vault writer and NO new atlas-wire consumer — Steward stays the sole writer + sole
 * reader (Pillar 1). The build only PRODUCES one event; the consume side is unchanged.
 *
 * Idempotency (Pillar 5): the event carries the STABLE, structured, date-keyed
 * `steward:weekly-review:<date>` idempotency key — NEVER crypto.randomUUID() (scheduled work
 * must re-derive the same key on a re-fire). `op:"upsert"` is last-writer-wins, so re-running
 * for the same date REPLACES the weekly note (exactly like compass:plan:<date> replaces Today),
 * and the ledger dedups the second apply to a no-op (meta.changes===0).
 *
 * Testability (matching Scout/Headhunter's injectable-data pattern): the week's inputs are
 * passed in as a `WeeklyReviewInput`. The live wiring (reading the week's events from D1, the
 * herald:weekly digest, the funnel counters, and open flags) lands when the OAuth/read paths
 * clear go-live; v1 compiles whatever inputs the caller supplies (empty = a graceful quiet
 * week). The Atlas Fri-16:30 cron case RPCs Steward.weeklyReviewBuild({date}); the WorkerEntry-
 * point method (src/index.ts) reads the week's state and calls this.
 */

import { send } from "@atlas/wire";
import type { WireEvent } from "@atlas/wire";

/** A surfaced event row (the week's Scout digest — title/start/relevance/url). */
export interface WeeklyReviewEvent {
  title: string;
  start: string;
  relevance: number;
  url?: string;
}

/** The Herald week-in-review digest counts (herald:weekly:<date>, Plan 02-06). */
export interface WeeklyHeraldDigest {
  mode: string;
  actionRequired: number;
  waitingOn: number;
  slipped: number;
  draftId?: string;
}

/** The jobs-funnel snapshot (Headhunter funnel counters, Plan 02-05). */
export interface WeeklyFunnel {
  applied: number;
  oa: number;
  interview: number;
  offer: number;
  rejection: number;
}

/** An open flag row (Flagger, Plan 02-02) — id + severity + title (never a secret). */
export interface WeeklyOpenFlag {
  id: string;
  severity: string;
  title: string;
}

/** The compiled inputs for one weekly-review build. */
export interface WeeklyReviewInput {
  events: WeeklyReviewEvent[];
  heraldDigest: WeeklyHeraldDigest | null;
  funnel: WeeklyFunnel;
  openFlags: WeeklyOpenFlag[];
}

/** The Dashboard note the build targets (docs/05-dashboard.md). */
const WEEKLY_REVIEW_NOTE = "Dashboard/Weekly Review";
/** The frontmatter field the op-mapping upsert replaces (last-writer-wins). */
const WEEKLY_REVIEW_FIELD = "weekly_review";

/**
 * Compile the four weekly-review sections into a single markdown body. Pure (no I/O) so it is
 * unit-testable in isolation. A quiet week still renders a real (non-placeholder) summary — the
 * empty-state lines are genuine "nothing this week" content, NOT a stub.
 */
export function buildWeeklyReviewBody(date: string, input: WeeklyReviewInput): string {
  const lines: string[] = [];
  lines.push(`# Weekly Review — week ending ${date}`);
  lines.push("");

  // ── Section 1: surfaced events (Scout) ──────────────────────────────────────────────
  lines.push("## Events surfaced this week");
  if (input.events.length === 0) {
    lines.push("_No events surfaced this week._");
  } else {
    // Most-relevant first; never follow links — the URL is metadata only.
    const sorted = [...input.events].sort((a, b) => b.relevance - a.relevance);
    for (const e of sorted) {
      const link = e.url ? ` ([details](${e.url}))` : "";
      lines.push(`- **${e.title}** — ${e.start} (relevance ${e.relevance})${link}`);
    }
  }
  lines.push("");

  // ── Section 2: Herald week-in-review digest counts ──────────────────────────────────
  lines.push("## Email — week in review");
  if (input.heraldDigest) {
    const d = input.heraldDigest;
    lines.push(`- Action required (open): ${d.actionRequired}`);
    lines.push(`- Waiting on: ${d.waitingOn}`);
    lines.push(`- Slipped this week: ${d.slipped}`);
    if (d.draftId) lines.push(`- Draft digest: \`${d.draftId}\``);
  } else {
    lines.push("_No Herald week-in-review digest this week._");
  }
  lines.push("");

  // ── Section 3: jobs funnel snapshot (Headhunter) ────────────────────────────────────
  lines.push("## Jobs funnel snapshot");
  const f = input.funnel;
  lines.push(`- Applied: ${f.applied}`);
  lines.push(`- OA: ${f.oa}`);
  lines.push(`- Interview: ${f.interview}`);
  lines.push(`- Offer: ${f.offer}`);
  lines.push(`- Rejection: ${f.rejection}`);
  lines.push("");

  // ── Section 4: open flags (Flagger) ─────────────────────────────────────────────────
  lines.push("## Open flags");
  if (input.openFlags.length === 0) {
    lines.push("_No open flags. Clean week._");
  } else {
    for (const flg of input.openFlags) {
      lines.push(`- [${flg.severity}] ${flg.title} (\`${flg.id}\`)`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Build the canonical §6.4 weekly-review Wire event (op:"upsert" — REPLACE the Weekly Review
 * note, never append). The structured sections ride in `payload` (the Vault renderer reads
 * them); `payload.body` carries the compiled markdown. `note`/`field` route the op-mapping
 * upsert to /vault/Dashboard/Weekly Review.md. The idempotencyKey is STABLE + date-keyed.
 */
export function buildWeeklyReviewEvent(date: string, input: WeeklyReviewInput): WireEvent {
  return {
    agent: "Steward",
    type: "weekly_review",
    entity: WEEKLY_REVIEW_NOTE,
    op: "upsert",
    payload: {
      date,
      note: WEEKLY_REVIEW_NOTE,
      field: WEEKLY_REVIEW_FIELD,
      events: input.events,
      herald: input.heraldDigest,
      funnel: input.funnel,
      open_flags: input.openFlags,
      body: buildWeeklyReviewBody(date, input),
    },
    idempotencyKey: `steward:weekly-review:${date}`,
  };
}

/**
 * Compile + emit the weekly-review build. The ONLY side effect is ONE op:"upsert" Wire event
 * on atlas-wire (via send(), which validates the §6.4 shape at the producer boundary). Steward's
 * own consumer applies it through the existing applyEvent → vault_outbox path — no new writer,
 * no new consumer (Pillar 1). Re-running for the same date emits the same stable key → REPLACE
 * (idempotent).
 */
export async function weeklyReview(
  env: { WIRE: Queue<WireEvent> },
  date: string,
  input: WeeklyReviewInput,
): Promise<void> {
  await send(env, buildWeeklyReviewEvent(date, input));
}
