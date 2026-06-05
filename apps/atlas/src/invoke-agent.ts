/**
 * invokeAgent — the service-binding RPC transport for the morning chain (Phase-0 D-11).
 *
 * Each MorningChain step invokes its agent over a PRIVATE Worker-to-Worker service binding
 * (env.FILER/HERALD/FORGE/SUNDIAL/COMPASS) — no public HTTP. This mirrors the Phase-0 NOOP
 * self-binding shape (env.NOOP.tick(params)); here the codename selects the binding and its
 * RPC method (sweep/daily/morning/sync/plan).
 *
 * The transport is intentionally thin: it dispatches, returns the agent's result, and lets the
 * Workflow step own retries/timeout. It NEVER mutates the params (the Workflow passes the prior
 * step's return forward; mutating it would revert on replay — CLAUDE.md gotcha).
 */

import type { AtlasEnv } from "./env.js";

/** The five morning-chain agent codenames (lowercase = the binding key). */
export type AgentCodename = "filer" | "herald" | "forge" | "sundial" | "compass";

/** The RPC method each agent's WorkerEntrypoint exposes (its chain-step target). */
const AGENT_METHOD: Record<AgentCodename, string> = {
  filer: "sweep",
  herald: "daily",
  forge: "morning",
  sundial: "sync",
  compass: "plan",
};

/** The env binding key for each agent (UPPERCASE codename). */
const AGENT_BINDING: Record<AgentCodename, keyof AtlasEnv> = {
  filer: "FILER",
  herald: "HERALD",
  forge: "FORGE",
  sundial: "SUNDIAL",
  compass: "COMPASS",
};

/**
 * Invoke a morning-chain agent over its service binding and return its result. Throws if the
 * binding is missing (an unprovisioned agent is a hard wiring error, surfaced loudly so the
 * Workflow step retries/halts rather than silently skipping a stage).
 */
export async function invokeAgent(
  env: AtlasEnv,
  codename: AgentCodename,
  params: Record<string, unknown>,
): Promise<unknown> {
  const bindingKey = AGENT_BINDING[codename];
  const binding = env[bindingKey] as unknown as Record<string, (p: unknown) => Promise<unknown>>;
  if (!binding) {
    throw new Error(
      `invokeAgent: service binding ${String(bindingKey)} for agent "${codename}" is not configured`,
    );
  }
  const method = AGENT_METHOD[codename];
  const fn = binding[method];
  if (typeof fn !== "function") {
    throw new Error(`invokeAgent: agent "${codename}" exposes no "${method}" RPC method`);
  }
  return await fn(params);
}
