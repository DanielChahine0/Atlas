/**
 * Atlas daemon — main entry point.
 *
 * Runs both drain loops in ONE process (single launchd LaunchAgent):
 *   1. Obsidian bridge drain (drain.ts) — drains vault_outbox intents
 *   2. Browser-action drain (browser-drain.ts) — drains browser_action_outbox items
 *
 * OUTBOUND ONLY — no server/listen, no inbound port.
 *
 * Single-process invariant (Pitfall 2): only one daemon instance runs at a time,
 * managed by launchd. The browser runner clears any stale Chromium lock on startup
 * inside withBrowserContext.
 *
 * Environment variables required:
 *   ATLAS_BRIDGE_URL      — cloud bridge base URL
 *   ATLAS_BRIDGE_TOKEN    — shared Bearer token for both poll endpoints
 *   OBSIDIAN_API_KEY      — Obsidian Local REST API key
 *   ATLAS_BROWSER_PROFILE — path to the owner's persistent Chromium profile
 */

import { loadConfig, drainLoop as obsidianDrainLoop, writeObsidian } from "./drain.ts";
import { loadBrowserConfig, drainLoop as browserDrainLoop } from "./browser-drain.ts";
import { runBrowserAction, withBrowserContext } from "./browser-runner.ts";

async function main(): Promise<void> {
  // Load configs — both fail loud on missing env vars.
  const obsidianCfg = loadConfig(process.env);
  const browserCfg = loadBrowserConfig(process.env);

  console.log("atlas-daemon: starting OUTBOUND-only drain loops (Obsidian + browser-action)");

  // Start both loops concurrently in ONE process — they run independently and never
  // share state. The browser loop is wrapped in withBrowserContext so the Playwright
  // persistent context is alive for the lifetime of the daemon.
  await Promise.all([
    // Obsidian bridge drain loop
    obsidianDrainLoop(
      obsidianCfg,
      { fetchCloud: fetch, writeObsidian },
      { runForever: true },
    ),

    // Browser-action drain loop — starts a persistent Chromium context (clears stale
    // lock on startup) and runs the drain loop inside it. The context is NOT closed
    // between items (single instance, Pitfall 2).
    withBrowserContext(browserCfg.browserProfilePath, async (_ctx) => {
      await browserDrainLoop(
        browserCfg,
        {
          fetchCloud: fetch,
          // Each call to runBrowserAction opens a new page within the persistent context
          // via the default (no mock page injected). The context is shared across calls
          // through the closure so each item gets a fresh page in the same logged-in session.
          runBrowserAction: (item, cfg) => runBrowserAction(item, cfg),
        },
        { runForever: true },
      );
    }),
  ]);
}

// Run only when invoked directly, not when imported by tests.
if (process.env.ATLAS_DAEMON_AUTOSTART === "1") {
  void main();
}
