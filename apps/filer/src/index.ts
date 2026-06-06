/**
 * Filer (apps/filer) — the Gmail labeler. The first stage of the morning chain.
 *
 * Filer holds `gmail.modify` ONLY (labels; NO delete/archive path is reachable — that
 * needs the never-granted full https://mail.google.com/ scope). It is idempotent via the
 * `AI/Reviewed` cursor label: the 07:45 sweep queries `newer_than:2d -label:AI/Reviewed`,
 * so a re-run over already-reviewed threads issues 0 new label writes. It NEVER surfaces a
 * 2FA code / reset link / login URL (bodies are redacted server-side by mcp-google and the
 * security guard in classify.ts strips action labels off a phish).
 *
 * Pillar 1: Filer is a Wire PRODUCER only. It emits `filer:sweep:<date>` and never consumes
 * atlas-wire. The continuous-push path (history.list driven by FilerCursor) is built but
 * flag-gated OFF (CONFIG `filer.push_enabled` = false) until D1-06 gateway ceilings exist.
 *
 * Shape: a `WorkerEntrypoint` (the `filer-sweep` Workflow-step RPC target, D-11) +
 * a `scheduled()` handler for the 06:00 users.watch renewal cron.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { send } from "@atlas/wire";
import type { WireEvent } from "@atlas/wire";
import { flag, localDate } from "@atlas/shared";
import type { Env as SharedEnv, RawIncident } from "@atlas/shared";
import { diffTaxonomy } from "./taxonomy.js";
import { finalizeLabels, isSecurityOrPhishing } from "./classify.js";

export { FilerCursor } from "./cursor.js";

/** Filer's env surface. */
export interface Env extends Omit<SharedEnv, "INCIDENTS"> {
  FILER_CURSOR?: DurableObjectNamespace;
  /** INCIDENTS producer (atlas-incidents): Filer enqueues RawIncidents via flag() (D2-05). */
  INCIDENTS: Queue<RawIncident>;
}

/** The CONFIG flag gating the continuous-push path (D1-06). Default OFF. */
export const PUSH_ENABLED_KEY = "filer.push_enabled";

/** One Gmail thread as the sweep sees it (already redacted by mcp-google on the body). */
export interface ThreadSummary {
  threadId: string;
  /** Labels currently on the thread (so we can compute a DELTA and skip AI/Reviewed). */
  labels: string[];
  /** The model-proposed labels for this thread (classification result). */
  proposed: string[];
  /** True when the classifier was not confident → add AI/Uncertain. */
  lowConfidence?: boolean;
}

/**
 * The Gmail tool surface Filer drives (through mcp-google). Injected so the sweep is
 * unit-testable without a live network. There is deliberately NO delete/archive/trash
 * method — the destructive path is unreachable by construction (Pillar 2).
 */
export interface GmailTools {
  listLabels(): Promise<string[]>;
  createLabel(name: string, parent: string | null, color: string): Promise<void>;
  searchThreads(query: string): Promise<ThreadSummary[]>;
  /** Apply a DELTA of labels to a thread (add only; the only permitted mutation). */
  labelThread(threadId: string, addLabels: string[]): Promise<void>;
}

/** The summary the sweep returns to the Workflow step (and into the Wire payload). */
export interface SweepSummary {
  labeled: number;
  uncertain: number;
  phishing: number;
}

/**
 * Run the Filer sweep over a window of threads. PURE of network via the injected `tools`:
 *   1. bootstrap the taxonomy (diff existing labels → create parent-before-child),
 *   2. query `newer_than:2d -label:AI/Reviewed` (skip already-reviewed threads → idempotent),
 *   3. per thread: finalize labels (security guard + consistency pass),
 *   4. write the DELTA, then append AI/Reviewed LAST (so an interrupted run retries).
 */
export async function runSweep(tools: GmailTools): Promise<SweepSummary> {
  // (1) Taxonomy bootstrap — create only the missing labels, parent before child.
  const existing = await tools.listLabels();
  for (const l of diffTaxonomy(existing)) {
    await tools.createLabel(l.name, l.parent, l.color);
  }

  // (2) The idempotency query — the -label:AI/Reviewed clause is the skip mechanism.
  const threads = await tools.searchThreads("newer_than:2d -label:AI/Reviewed");

  let labeled = 0;
  let uncertain = 0;
  let phishing = 0;

  for (const t of threads) {
    // Defensive: an already-reviewed thread is skipped even if the query returned it.
    if (t.labels.includes("AI/Reviewed")) continue;

    // (3) Finalize: security guard (strip Needs/Suggest on a phish) + triage consistency.
    const finalized = finalizeLabels(t.proposed, { lowConfidence: t.lowConfidence });
    if (isSecurityOrPhishing(finalized)) phishing++;
    if (finalized.includes("AI/Uncertain")) uncertain++;

    // (4) Write the DELTA (labels not already on the thread), then AI/Reviewed LAST.
    const delta = finalized.filter((l) => !t.labels.includes(l));
    if (delta.length > 0) await tools.labelThread(t.threadId, delta);
    await tools.labelThread(t.threadId, ["AI/Reviewed"]);
    labeled++;
  }

  return { labeled, uncertain, phishing };
}

/** Build the canonical §6.4 sweep.done Wire event for a given date + summary. */
export function buildSweepEvent(date: string, summary: SweepSummary): WireEvent {
  return {
    agent: "Filer",
    type: "sweep.done",
    entity: "email",
    op: "increment",
    payload: {
      counter: "emails_labeled",
      delta: summary.labeled,
      labeled: summary.labeled,
      uncertain: summary.uncertain,
      phishing: summary.phishing,
    },
    idempotencyKey: `filer:sweep:${date}`,
  };
}

export class Filer extends WorkerEntrypoint<Env> {
  /**
   * The `filer-sweep` Workflow-step RPC target. Runs the sweep (the live Gmail tools are
   * wired in the Workflow step / a live build; tests inject `tools`), then emits the
   * canonical `filer:sweep:<date>` event to Steward. Returns the summary for the next step.
   * Emits a kind:heartbeat incident on every successful run (D2-07).
   */
  async sweep(params?: { date?: string; tools?: GmailTools }): Promise<SweepSummary> {
    const date = params?.date ?? localDate(this.env);
    let summary: SweepSummary;
    if (!params?.tools) {
      // No live Gmail tools wired yet (the live binding lands with the Workflow step /
      // owner-provisioned OAuth). Emit a zero-summary so the chain step is still
      // observable and replay-safe; never fabricate label writes.
      summary = { labeled: 0, uncertain: 0, phishing: 0 };
      await send(this.env, buildSweepEvent(date, summary));
    } else {
      summary = await runSweep(params.tools);
      await send(this.env, buildSweepEvent(date, summary));
    }
    // Heartbeat: inform FlaggerState's alarm scheduler this slot ran successfully (D2-07).
    // Best-effort: a transient queue reject must NEVER convert a successful sweep into a
    // failure or halt the MorningChain. Optional-chaining: absent binding is a no-op.
    await this.env.INCIDENTS?.send({
      source_agent: "Filer",
      kind: "heartbeat",
      severity_hint: "P4",
      title: `Filer heartbeat ${date}`,
      run_id: date,
    }).catch(() => {});
    return summary;
  }
}

export default {
  /**
   * The 06:00 users.watch renewal cron (the only Filer cron; the 07:45 sweep is a Workflow
   * step, not a Filer cron). The live users.watch renewal lands with owner-provisioned
   * OAuth; here we record the path and raise a P3 if a watch has lapsed. The continuous
   * push path is gated OFF until D1-06 (CONFIG filer.push_enabled).
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const pushEnabled = (await env.CONFIG.get(PUSH_ENABLED_KEY)) === "true";
    if (!pushEnabled) {
      // Push path gated off (D1-06). The 07:45 sweep step still covers the inbox; nothing
      // to renew while push is disabled. No-op (never enable push by default).
      return;
    }
    // Push enabled: a lapsed watch is a P3 (renew the users.watch; advance FilerCursor).
    // The live history.list/watch wiring lands with OAuth — flag the lapse path here so it
    // is observable the moment push goes live.
    await flag(
      env,
      "P3",
      "filer users.watch renewal due",
      "The 06:00 watch-renewal cron fired; renew users.watch and advance FilerCursor.historyId.",
      { sourceAgent: "Filer", kind: "watch_renewal_due" },
    );
  },
} satisfies ExportedHandler<Env>;
