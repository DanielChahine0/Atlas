/**
 * Herald week-in-review builder (D2-10) — Friday retrospective over the trailing 7 days.
 *
 * Produces a draft-only (gmail.compose) week-in-review email covering four sections:
 *   - Action Required (still open)
 *   - Waiting On (sent, awaiting reply)
 *   - VIP threads in the window
 *   - Items that slipped (action-required, past-due)
 *
 * Security invariant (identical to daily): every synthesized output passes through
 * guardDigestOutput() BEFORE the draft is created. A leak BLOCKS the draft and raises a P2
 * (kind: "security_leak_blocked"). The weekly mode is NOT exempt.
 *
 * The method emits ONE Wire event: a "digest" event with idempotencyKey `herald:weekly:<date>`
 * (op:"upsert", entity:"email") feeding the 16:30 weekly-review Vault build.
 * On success (draft not blocked), also emits a kind:heartbeat incident (P4).
 */

import type { WireEvent } from "@atlas/wire";
import type { RawIncident } from "@atlas/shared";
import { guardDigestOutput, stripSnippet } from "./guardrail.js";
import { bucketThreads, sectionCounts, SECTIONS, type DigestThread } from "./bucket.js";
import type { Env, HeraldGmailTools } from "./index.js";
import { OWNER_ADDRESS } from "./index.js";

/** The result the weekly pass returns to the WorkerEntrypoint method. */
export interface WeeklyResult {
  /** False when the output guardrail blocked the draft on a leak. */
  drafted: boolean;
  draftId?: string;
  counts: Record<string, number>;
  /** The thread refs in the Action Required bucket for the 7-day window. */
  actionRequiredRefs: string[];
  /** True when a security leak blocked the draft. */
  blocked?: boolean;
}

/** Build the canonical §6.4 weekly digest Wire event. */
export function buildWeeklyDigestEvent(
  date: string,
  counts: Record<string, number>,
  topActionRequired: string[],
  draftId: string | undefined,
): WireEvent {
  return {
    agent: "Herald",
    type: "digest",
    entity: "email",
    op: "upsert",
    payload: {
      mode: "weekly",
      runDate: date,
      counts,
      topActionRequired,
      draftId: draftId ?? null,
    },
    idempotencyKey: `herald:weekly:${date}`,
  };
}

/** The Gmail draft subject for the weekly review. */
export function weeklyDraftSubject(date: string): string {
  return `Atlas Week-in-Review — ${date} (weekly)`;
}

/** Render one thread as a bullet for the weekly review body. */
function renderWeeklyThread(t: DigestThread): string {
  if (t.labels.includes("Type/Security")) {
    return `  • ${stripSnippet(t.sender)} — ${stripSnippet(t.subject)}   [security-sensitive; opened in Gmail only]`;
  }
  if (t.labels.includes("⚠ Phishing-Suspect")) {
    return `  • ⚠ ${stripSnippet(t.sender)} — ${stripSnippet(t.subject)}   [⚠ Phishing-Suspect — do not click; verify in Gmail]`;
  }
  const tags = t.labels.length ? `   [${t.labels.join(" · ")}]` : "";
  return `  • ${stripSnippet(t.subject)} — ${stripSnippet(t.sender)}${tags}`;
}

/** Whether a thread is still "open" action-required (not closed/done). */
function isOpenActionRequired(t: DigestThread): boolean {
  return t.labels.includes("① Action Required") && !t.labels.includes("AI/Done");
}

/** Whether a thread is waiting-on (awaiting a reply from someone else). */
function isWaitingOn(t: DigestThread): boolean {
  return (
    t.labels.includes("Waiting/Sent") ||
    t.labels.includes("② Action Recommended") ||
    t.labels.includes("Waiting/Sent")
  );
}

/** Whether a thread is VIP. */
function isVip(t: DigestThread): boolean {
  return !!(t.vip || t.labels.includes("From/VIP"));
}

/** Whether a thread has slipped (action required but past due or not yet addressed). */
function isSlipped(t: DigestThread): boolean {
  return (
    t.labels.includes("① Action Required") &&
    (t.labels.includes("Due/Today") || t.labels.includes("Due/ThisWeek"))
  );
}

/**
 * Build the week-in-review body covering the 7-day window. Sections:
 *   1. Action Required (still open)
 *   2. Waiting On
 *   3. VIP Threads
 *   4. Items That Slipped
 *
 * Every thread line runs through stripSnippet (pre-synthesis strip, belt 1).
 */
export function renderWeeklyBody(date: string, threads: DigestThread[]): string {
  const actionOpen = threads.filter(isOpenActionRequired);
  const waitingOn = threads.filter(isWaitingOn);
  const vipThreads = threads.filter(isVip);
  const slipped = threads.filter(isSlipped);

  const lines: string[] = [`Atlas Week-in-Review — ${date}`, "7-day window summary", ""];

  lines.push(`▲ ACTION REQUIRED — STILL OPEN (${actionOpen.length})`);
  for (const t of actionOpen) lines.push(renderWeeklyThread(t));
  lines.push("");

  lines.push(`⏳ WAITING ON (${waitingOn.length})`);
  for (const t of waitingOn) lines.push(renderWeeklyThread(t));
  lines.push("");

  lines.push(`★ VIP THREADS (${vipThreads.length})`);
  for (const t of vipThreads) lines.push(renderWeeklyThread(t));
  lines.push("");

  lines.push(`⚠ ITEMS THAT SLIPPED (${slipped.length})`);
  for (const t of slipped) lines.push(renderWeeklyThread(t));
  lines.push("");

  return lines.join("\n").trimEnd();
}

/**
 * Run the weekly week-in-review pass. PURE of network via injected `tools`:
 *   bucket → render (snippets pre-stripped) → output guardrail → create draft (if clean)
 *   → emit heartbeat on success. The Wire digest event is emitted by the
 *   Herald.weekly() WorkerEntrypoint method (in index.ts). On a guardrail trip: no draft,
 *   P2 raised (by guardDigestOutput), no heartbeat.
 *
 * The guardrail is the OUTPUT-side check (belt 2) — identical to the daily pass.
 */
export async function runWeekly(
  env: Env,
  date: string,
  threads: DigestThread[],
  tools?: HeraldGmailTools,
): Promise<WeeklyResult> {
  const buckets = bucketThreads(threads);
  const counts = sectionCounts(buckets);
  const actionRequiredRefs = buckets["Action Required"].map((t) => t.threadId);

  const body = renderWeeklyBody(date, threads);

  // Belt 2: output guardrail — same as daily; weekly is NOT exempt.
  const guard = await guardDigestOutput(env, body);

  let draftId: string | undefined;
  let drafted = false;
  if (!guard.blocked && tools) {
    draftId = await tools.createDraft(OWNER_ADDRESS, weeklyDraftSubject(date), guard.text);
    drafted = true;
  }

  // Heartbeat: emit after a successful (non-blocked) run.
  // Best-effort: a transient queue reject must never convert a successful weekly run into
  // a failure. Optional-chaining: absent binding is a no-op.
  if (!guard.blocked) {
    await env.INCIDENTS?.send({
      source_agent: "Herald",
      kind: "heartbeat",
      severity_hint: "P4",
      title: `Herald heartbeat ${date}`,
      run_id: date,
    } as RawIncident).catch(() => {});
  }

  return { drafted, draftId, counts, actionRequiredRefs, blocked: guard.blocked };
}
