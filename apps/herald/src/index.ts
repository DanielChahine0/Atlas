/**
 * Herald (apps/herald) — the daily email digest. Morning-chain stage 2 (08:00 budget gate).
 *
 * Herald reads Filer's labeled threads in the 24h window, buckets them into the five
 * owner-requested sections, redacts security mail, synthesizes a digest body, creates a
 * Gmail DRAFT to the owner (NEVER sent), and emits a `digest` Wire event for the Vault
 * morning-glance. Scopes: `gmail.readonly` + `gmail.compose` ONLY — no label, no send, no
 * delete (there is no gmail_send tool; Pillar 2 by construction).
 *
 * The non-negotiable invariant: 2FA codes / reset links / login URLs NEVER reach the output.
 * Snippets are stripped pre-synthesis; the OUTPUT-side guardrail blocks the draft + raises P2
 * if a secret survives. D1-01: keep the draft AND emit the event. D1-02: daily every weekday,
 * no Friday special-casing.
 *
 * Shape: a `WorkerEntrypoint` (the `herald-daily` Workflow-step RPC target). No cron of its
 * own (it runs as the Workflow step).
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { send } from "@atlas/wire";
import type { WireEvent } from "@atlas/wire";
import { localDate } from "@atlas/shared";
import type { Env as SharedEnv } from "@atlas/shared";
import { bucketThreads, sectionCounts, SECTIONS, type DigestThread } from "./bucket.js";
import { renderDigestBody, draftSubject } from "./digest.js";
import { guardDigestOutput } from "./guardrail.js";

/** Herald's env surface. */
export type Env = SharedEnv;

/** The owner's mailbox — the draft recipient (NEVER sent). */
export const OWNER_ADDRESS = "chahinedaniel0@gmail.com";

/**
 * The Gmail tool surface Herald drives (through mcp-google). Injected so the daily pass is
 * unit-testable without a live network. There is deliberately NO send method — Herald can
 * only create a DRAFT (Pillar 2 by construction).
 */
export interface HeraldGmailTools {
  /** Create a DRAFT to the owner; returns the draft id. NEVER sends. */
  createDraft(to: string, subject: string, body: string): Promise<string>;
}

/** The result the daily pass returns to the Workflow step. */
export interface DailyResult {
  /** False when the output guardrail blocked the draft on a leak. */
  drafted: boolean;
  draftId?: string;
  counts: Record<string, number>;
  /** The thread refs Forge reuses (Action Required set). */
  actionRequiredRefs: string[];
  blocked?: boolean;
}

/** Build the canonical §6.4 digest Wire event. */
export function buildDigestEvent(
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
      mode: "daily",
      runDate: date,
      counts,
      topActionRequired,
      draftId: draftId ?? null,
    },
    idempotencyKey: `herald:daily:${date}`,
  };
}

/**
 * Run the daily digest. PURE of network via injected `tools`:
 *   bucket → render (snippets pre-stripped) → output guardrail → create draft (if clean)
 *   → emit the digest event. On a guardrail trip: no draft, P2 raised, event still emitted
 *   with draftId:null so the Vault glance is observable (the leak is the flagged incident).
 */
export async function runDaily(
  env: Env,
  date: string,
  threads: DigestThread[],
  tools?: HeraldGmailTools,
): Promise<DailyResult> {
  const buckets = bucketThreads(threads);
  const counts = sectionCounts(buckets);
  const actionRequiredRefs = buckets["Action Required"].map((t) => t.threadId);

  const body = renderDigestBody(date, buckets);
  const guard = await guardDigestOutput(env, body);

  let draftId: string | undefined;
  let drafted = false;
  if (!guard.blocked && tools) {
    draftId = await tools.createDraft(OWNER_ADDRESS, draftSubject(date), guard.text);
    drafted = true;
  }

  await send(env, buildDigestEvent(date, counts, actionRequiredRefs.slice(0, 3), draftId));

  return { drafted, draftId, counts, actionRequiredRefs, blocked: guard.blocked };
}

export class Herald extends WorkerEntrypoint<Env> {
  /**
   * The `herald-daily` Workflow-step RPC target. Reads Filer's labeled threads (passed in
   * as `labels` by the chain; the live Gmail read wires in with OAuth), runs the daily
   * digest, and returns the digest refs so Forge reuses them.
   */
  async daily(params?: {
    date?: string;
    threads?: DigestThread[];
    tools?: HeraldGmailTools;
  }): Promise<DailyResult> {
    const date = params?.date ?? localDate(this.env);
    const threads = params?.threads ?? [];
    return await runDaily(this.env, date, threads, params?.tools);
  }
}

export { SECTIONS };

export default {
  // Herald has no cron in Phase 1 (it runs as the herald-daily Workflow step). The default
  // export exists for wrangler's main entry; fetch is unused.
  fetch(): Response {
    return new Response("Herald runs as the herald-daily Workflow step.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
