/**
 * push.ts — ntfy.sh push notification helper for Flagger (WEEKLY-02, Plan 02-02 Task 2).
 *
 * Pushes P1/P2 flags to a private ntfy topic via POST. Push is gate-guarded:
 * if NTFY_TOPIC is not seeded, returns silently (D2-03 board fallback).
 *
 * Push failure is non-fatal — the caller catches errors and the flag still lands
 * on the Vault board via Steward (D2-03 fallback guarantee).
 *
 * Security invariant: NTFY_TOPIC and NTFY_TOKEN are only read via Secrets Store async
 * bindings (await env.NTFY_TOPIC?.get()). They are NEVER in [vars], KV, Vault, or logs.
 */

import type { FlagRecord } from "@atlas/shared";
import type { Env } from "./index.js";

/**
 * Post a P1/P2 flag to ntfy.sh with an HTTP "Ack" action button.
 * Returns silently if NTFY_TOPIC is not configured (push gated off by default).
 * NEVER throws — board fallback is the safety net (D2-03).
 */
export async function pushFlag(env: Env, flag: FlagRecord, ackUrl: string): Promise<void> {
  const topic = await env.NTFY_TOPIC?.get();
  const ntfyToken = await env.NTFY_TOKEN?.get();

  if (!topic) {
    // Push gated off — NTFY_TOPIC not seeded. Flag lands on board via Steward.
    return;
  }

  const ackToken = await env.ACK_TOKEN?.get();

  const payload = {
    topic,
    title: `[${flag.severity}] ${flag.source_agent}`,
    message: flag.title,
    priority: flag.severity === "P1" ? 5 : 4,
    actions: ackToken
      ? [
          {
            action: "http",
            label: "Ack",
            url: ackUrl,
            method: "POST",
            headers: { Authorization: `Bearer ${ackToken}` },
            body: JSON.stringify({ id: flag.id }),
            clear: true,
          },
        ]
      : [],
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (ntfyToken) {
    headers["Authorization"] = `Bearer ${ntfyToken}`;
  }

  const resp = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    console.error("flagger: ntfy push failed", resp.status, await resp.text().catch(() => ""));
    // Non-fatal — caller catches; board fallback (D2-03)
  }
}
