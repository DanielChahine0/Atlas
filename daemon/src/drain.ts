/**
 * Atlas daemon — the OUTBOUND-ONLY Obsidian bridge drainer (SPINE-05).
 *
 * This is a LOCAL macOS process (launchd LaunchAgent com.atlas.bridge), NOT a Worker —
 * it lives OUTSIDE apps/ (CLAUDE.md repo-layout note). The laptop has ZERO inbound port;
 * the daemon authenticates OUTBOUND and PULLS work:
 *
 *   loop:
 *     1. long-poll  GET  {bridge}/bridge/poll   (Authorization: Bearer ATLAS_BRIDGE_TOKEN)
 *     2. for each returned intent: execute it against the Obsidian Local REST API v3 at
 *        https://127.0.0.1:27124 using the intent's method/path/headers/body
 *        (PATCH for increment/upsert, PUT for view rebuild, POST for append — NEVER DELETE)
 *     3. on success: POST {bridge}/bridge/ack { idem }   (OUTBOUND)
 *     4. on a bridge- OR Obsidian-unreachable error: back off and leave the intent PENDING
 *        (the cloud raises Flagger P2 on exhaustion — never silently drop; T-00-37)
 *
 * SECURITY:
 *   - The self-signed cert is trusted ONLY for the 127.0.0.1 localhost connection
 *     (a node:https.Agent with rejectUnauthorized:false bound to the Obsidian write).
 *     The OUTBOUND cloud calls use the global `fetch` with FULL cert validation (no agent).
 *   - ATLAS_BRIDGE_TOKEN + the Obsidian API key are read from the daemon's ENVIRONMENT
 *     (a git-ignored local config), NEVER from a tracked file. No secret is hard-coded.
 *   - The daemon opens NO listening socket — it only makes outbound requests.
 */

import { Agent, request as httpsRequest } from "node:https";

/** The Obsidian Local REST API v3 base — the plugin listens here on the loopback only. */
export const OBSIDIAN_BASE = "https://127.0.0.1:27124";

/** A drain intent as returned by /bridge/poll (mirrors the cloud DrainIntent shape). */
export interface DrainIntent {
  idem: string;
  path: string;
  method: string;
  /** JSON-encoded header map (the op→REST v3 headers). */
  headers: string;
  /** JSON-encoded body, or null for header-only PATCHes. */
  body: string | null;
}

/** The daemon's runtime config, assembled from the environment (never a tracked file). */
export interface DaemonConfig {
  /** The cloud bridge base URL, e.g. https://mcp-obsidian-bridge.<acct>.workers.dev */
  bridgeBaseUrl: string;
  /** The long-poll bearer — shared with the cloud Secrets Store (owner-seeded). */
  bridgeToken: string;
  /** The Obsidian Local REST API key (owner-copied from the plugin). */
  obsidianApiKey: string;
  /** Poll backoff in ms after an error / empty poll. */
  backoffMs: number;
}

/** The ONLY verbs the daemon is permitted to issue against the Vault (Pillar 2 — no removal). */
const ALLOWED_METHODS = new Set(["PATCH", "PUT", "POST"]);

/**
 * Read the daemon config from the environment. Throws (loud, fail-safe) if a required
 * secret is missing — the daemon NEVER fabricates a token or falls back to a default.
 */
export function loadConfig(env: Record<string, string | undefined>): DaemonConfig {
  const bridgeBaseUrl = env.ATLAS_BRIDGE_URL;
  const bridgeToken = env.ATLAS_BRIDGE_TOKEN;
  const obsidianApiKey = env.OBSIDIAN_API_KEY;
  if (!bridgeBaseUrl) throw new Error("daemon misconfigured: ATLAS_BRIDGE_URL is not set");
  if (!bridgeToken) throw new Error("daemon misconfigured: ATLAS_BRIDGE_TOKEN is not set");
  if (!obsidianApiKey) throw new Error("daemon misconfigured: OBSIDIAN_API_KEY is not set");
  const backoffMs = Number(env.ATLAS_DRAIN_BACKOFF_MS ?? "5000") || 5000;
  return { bridgeBaseUrl, bridgeToken, obsidianApiKey, backoffMs };
}

/** The injectable I/O surface — real implementations below; mocked in the unit test. */
export interface DrainDeps {
  /** OUTBOUND, fully-cert-validated cloud fetch (the global fetch). */
  fetchCloud: typeof fetch;
  /** Execute one intent against the LOCAL Obsidian REST API; resolves on 2xx. */
  writeObsidian: (intent: DrainIntent, cfg: DaemonConfig) => Promise<void>;
}

/**
 * Long-poll the bridge OUTBOUND for pending intents. Fully cert-validated (no agent).
 * Returns the intents array (possibly empty). Throws on a non-2xx / network error so the
 * caller backs off and leaves intents pending.
 */
export async function pollOnce(cfg: DaemonConfig, deps: DrainDeps): Promise<DrainIntent[]> {
  const res = await deps.fetchCloud(`${cfg.bridgeBaseUrl}/bridge/poll`, {
    method: "GET",
    headers: { Authorization: `Bearer ${cfg.bridgeToken}` },
  });
  if (!res.ok) throw new Error(`bridge poll failed: ${res.status}`);
  const body = (await res.json()) as { intents?: DrainIntent[] };
  return body.intents ?? [];
}

/**
 * Ack a drained intent OUTBOUND (fully cert-validated). Called ONLY after a successful
 * Obsidian write, so an unreachable laptop leaves the intent pending (never lost).
 */
export async function ackIntent(idem: string, cfg: DaemonConfig, deps: DrainDeps): Promise<void> {
  const res = await deps.fetchCloud(`${cfg.bridgeBaseUrl}/bridge/ack`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.bridgeToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ idem }),
  });
  if (!res.ok) throw new Error(`bridge ack failed: ${res.status}`);
}

/**
 * Process exactly one poll batch: poll → for each intent, write to Obsidian then ack.
 * A write/ack failure for one intent leaves that intent PENDING (it is not acked) and
 * the error propagates so the loop backs off — the cloud raises Flagger P2 on exhaustion.
 *
 * Returns the number of intents successfully drained-and-acked (0 on an empty poll).
 */
export async function drainOnce(cfg: DaemonConfig, deps: DrainDeps): Promise<number> {
  const intents = await pollOnce(cfg, deps);
  let drained = 0;
  for (const intent of intents) {
    // Pillar 2 belt: refuse any non-allow-listed verb (a removal verb is unreachable
    // by construction from Steward's map, but the daemon re-asserts it locally).
    if (!ALLOWED_METHODS.has(intent.method.toUpperCase())) {
      throw new Error(`refusing non-safe Vault method from bridge intent: ${intent.method}`);
    }
    // Execute against the LOCAL Obsidian REST API (self-signed cert trusted for localhost).
    await deps.writeObsidian(intent, cfg);
    // Only ack AFTER a successful local write — so a failed write keeps the intent pending.
    await ackIntent(intent.idem, cfg, deps);
    drained++;
  }
  return drained;
}

/**
 * The REAL Obsidian writer: PATCH/PUT/POST the Local REST API v3 at 127.0.0.1:27124 over
 * a node:https.Agent that trusts the plugin's self-signed cert FOR THE LOCALHOST
 * CONNECTION ONLY (rejectUnauthorized:false is bound to THIS agent — never the cloud fetch).
 */
export function writeObsidian(intent: DrainIntent, cfg: DaemonConfig): Promise<void> {
  // The self-signed-cert trust is scoped to this localhost agent ONLY.
  const localhostAgent = new Agent({ rejectUnauthorized: false });
  const headerMap = JSON.parse(intent.headers) as Record<string, string>;
  const headers: Record<string, string> = {
    ...headerMap,
    Authorization: `Bearer ${cfg.obsidianApiKey}`,
  };
  const url = `${OBSIDIAN_BASE}${intent.path}`;

  return new Promise<void>((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: intent.method, headers, agent: localhostAgent },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) resolve();
          else reject(new Error(`Obsidian write failed: ${code}`));
        });
      },
    );
    req.on("error", reject);
    if (intent.body !== null) req.write(intent.body);
    req.end();
  });
}

/**
 * The continuous drain loop. OUTBOUND-only; opens no listening socket. On any error it
 * backs off and retries — intents stay pending until drained, so nothing is lost.
 *
 * `runForever=false` (the default in tests) runs a single iteration so the loop is unit-
 * testable without spinning.
 */
export async function drainLoop(
  cfg: DaemonConfig,
  deps: DrainDeps,
  options: { runForever?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  do {
    try {
      const drained = await drainOnce(cfg, deps);
      if (drained === 0) await sleep(cfg.backoffMs);
    } catch (err) {
      // Bridge- or Obsidian-unreachable: back off, leave intents pending (never drop).
      console.warn(`drain iteration error (backing off): ${String(err)}`);
      await sleep(cfg.backoffMs);
    }
  } while (options.runForever);
}

/** Entry point: assemble config + the real I/O deps and run the loop forever. */
export async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const deps: DrainDeps = { fetchCloud: fetch, writeObsidian };
  console.log("atlas-daemon: starting OUTBOUND-only Obsidian bridge drain loop");
  await drainLoop(cfg, deps, { runForever: true });
}

// Run only when invoked directly (node src/drain.ts), not when imported by the test.
if (process.env.ATLAS_DAEMON_AUTOSTART === "1") {
  void main();
}
