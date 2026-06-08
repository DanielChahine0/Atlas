/**
 * Atlas daemon — the OUTBOUND-ONLY browser-action outbox drainer.
 *
 * This is the second drain channel in the local macOS daemon (alongside drain.ts for
 * the Obsidian bridge). The daemon polls /browser/poll (Bearer-gated, outbound only —
 * NO inbound port) and drains browser_action_outbox items SERIALLY, acking each
 * outcome to /browser/ack AFTER the action attempt (pending never lost).
 *
 * SECURITY:
 *   - OUTBOUND ONLY: no server/listen, no inbound port. Bearer ATLAS_BRIDGE_TOKEN on
 *     every /browser/poll + /browser/ack call.
 *   - NO credential storage: Playwright runs launchPersistentContext against
 *     ATLAS_BROWSER_PROFILE; Atlas never reads/stores/transmits the profile contents,
 *     session tokens, or passwords.
 *   - Serial drain (for...of, never concurrent): one item at a time, in order.
 *   - Ack happens ONLY AFTER the action attempt (pending never lost — same as drain.ts).
 *   - loadBrowserConfig fails LOUD on missing ATLAS_BRIDGE_URL / ATLAS_BRIDGE_TOKEN /
 *     ATLAS_BROWSER_PROFILE — never defaults the profile path.
 *
 * Cloud endpoints served by apps/gate (04-03):
 *   GET  ${bridgeBaseUrl}/browser/poll   Authorization: Bearer <ATLAS_BRIDGE_TOKEN>
 *        → { items: BrowserActionWorkItem[] }
 *   POST ${bridgeBaseUrl}/browser/ack    Bearer + { id, outcome: BrowserActionOutcome }
 */

// Import the canonical work-item + outcome types from @atlas/gate/schema (the single
// source of truth — do NOT redefine them here). The daemon is outside the workspace so
// we use a relative path to the gate package source directly.
import type {
  BrowserActionWorkItem,
  BrowserActionOutcome,
} from "../../packages/gate/src/schema.ts";

export type { BrowserActionWorkItem, BrowserActionOutcome };

/** The daemon's runtime config for the browser-action drain (assembled from env). */
export interface BrowserDrainConfig {
  /** The cloud bridge base URL, e.g. https://gate.<acct>.workers.dev */
  bridgeBaseUrl: string;
  /** The long-poll bearer — same ATLAS_BRIDGE_TOKEN as the Obsidian drain. */
  bridgeToken: string;
  /** Path to the owner's persistent Chromium profile (NEVER a tracked file). */
  browserProfilePath: string;
  /** Poll backoff in ms after an error / empty poll. */
  backoffMs: number;
}

/** The injectable I/O surface — real implementation in browser-runner.ts; mocked in tests. */
export interface BrowserDrainDeps {
  /** OUTBOUND, fully-cert-validated cloud fetch (the global fetch). */
  fetchCloud: typeof fetch;
  /**
   * Execute one browser action (fill, submit, scrape, or prefill-without-submit).
   * Injected at main(); mock injected in tests — no real Chromium in unit tests.
   */
  runBrowserAction: (item: BrowserActionWorkItem, cfg: BrowserDrainConfig) => Promise<BrowserActionOutcome>;
}

/**
 * Read the browser-drain config from the environment. Throws (loud, fail-safe) if a
 * required var is missing — the daemon NEVER fabricates a token or defaults the profile path.
 */
export function loadBrowserConfig(env: Record<string, string | undefined>): BrowserDrainConfig {
  const bridgeBaseUrl = env.ATLAS_BRIDGE_URL;
  const bridgeToken = env.ATLAS_BRIDGE_TOKEN;
  const browserProfilePath = env.ATLAS_BROWSER_PROFILE;
  if (!bridgeBaseUrl) throw new Error("daemon misconfigured: ATLAS_BRIDGE_URL is not set");
  if (!bridgeToken) throw new Error("daemon misconfigured: ATLAS_BRIDGE_TOKEN is not set");
  if (!browserProfilePath)
    throw new Error("daemon misconfigured: ATLAS_BROWSER_PROFILE is not set (never default the path)");
  const backoffMs = Number(env.ATLAS_DRAIN_BACKOFF_MS ?? "5000") || 5000;
  return { bridgeBaseUrl, bridgeToken, browserProfilePath, backoffMs };
}

/**
 * Long-poll the bridge OUTBOUND for pending browser-action items. Fully cert-validated.
 * Returns the items array (possibly empty). Throws on a non-2xx / network error so the
 * caller backs off and leaves items pending.
 */
export async function pollOnce(
  cfg: BrowserDrainConfig,
  deps: BrowserDrainDeps,
): Promise<BrowserActionWorkItem[]> {
  const res = await deps.fetchCloud(`${cfg.bridgeBaseUrl}/browser/poll`, {
    method: "GET",
    headers: { Authorization: `Bearer ${cfg.bridgeToken}` },
  });
  if (!res.ok) throw new Error(`browser poll failed: ${res.status}`);
  const body = (await res.json()) as { items?: BrowserActionWorkItem[] };
  return body.items ?? [];
}

/**
 * Ack a completed browser-action outcome OUTBOUND (fully cert-validated).
 * Called ONLY after the action attempt (success, hard_stop, or error), so pending
 * is never lost — an unreachable cloud leaves the item pending for the next poll.
 */
export async function ackOutcome(
  id: string,
  outcome: BrowserActionOutcome,
  cfg: BrowserDrainConfig,
  deps: BrowserDrainDeps,
): Promise<void> {
  const res = await deps.fetchCloud(`${cfg.bridgeBaseUrl}/browser/ack`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.bridgeToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id, outcome }),
  });
  if (!res.ok) throw new Error(`browser ack failed: ${res.status}`);
}

/**
 * Process exactly one poll batch SERIALLY:
 *   poll → for each item in order: runBrowserAction → ackOutcome.
 *
 * SERIAL (for...of, never concurrent): one item at a time, in order.
 * ACK-AFTER-ATTEMPT: ack happens only after the action attempt, even if the outcome
 * is {status:'error'} — so the cloud always receives a terminal signal.
 * ONE-ITEM-ERROR-CONTINUES: a runBrowserAction throw for one item is caught,
 * converted to {id, status:'error'}, acked, and the loop continues. The remaining
 * items in the batch are still processed.
 *
 * Returns the total count of items processed (and acked) in this batch.
 */
export async function drainOnce(
  cfg: BrowserDrainConfig,
  deps: BrowserDrainDeps,
): Promise<number> {
  const items = await pollOnce(cfg, deps);
  let drained = 0;
  for (const item of items) {
    // Attempt the browser action; catch to convert a throw → error outcome.
    let outcome: BrowserActionOutcome;
    try {
      outcome = await deps.runBrowserAction(item, cfg);
    } catch (err) {
      // One item's failure must not abort the batch — convert to error outcome and ack.
      console.warn(`browser action failed for item ${item.id}: ${String(err)}`);
      outcome = { id: item.id, status: "error" };
    }
    // ACK AFTER the attempt (regardless of outcome status — pending never lost).
    await ackOutcome(item.id, outcome, cfg, deps);
    drained++;
  }
  return drained;
}

/**
 * The continuous browser-drain loop. OUTBOUND-only; opens no listening socket.
 * On any error it backs off and retries — items stay pending until drained.
 *
 * `runForever=false` (the default in tests) runs a single iteration so the loop is
 * unit-testable without spinning.
 */
export async function drainLoop(
  cfg: BrowserDrainConfig,
  deps: BrowserDrainDeps,
  options: { runForever?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  do {
    try {
      const drained = await drainOnce(cfg, deps);
      if (drained === 0) await sleep(cfg.backoffMs);
    } catch (err) {
      // Bridge-unreachable: back off, leave items pending (never drop).
      console.warn(`browser drain iteration error (backing off): ${String(err)}`);
      await sleep(cfg.backoffMs);
    }
  } while (options.runForever);
}
