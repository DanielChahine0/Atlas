/**
 * NoopAgent — the no-op agent SPINE-01 schedules (Phase 0, Plan 03 / Wave 3).
 *
 * This is the D-11 service-binding RPC TARGET: the scheduled() dispatcher in
 * index.ts invokes it via `env.NOOP.tick(...)` over a PRIVATE service binding
 * (Worker-to-Worker RPC, NO public HTTP surface — T-00-31). It exists ONLY to
 * prove the schedule -> invoke leg of SPINE-01: a cron tick reaches the dispatcher,
 * which invokes this agent, which acknowledges, after which the dispatcher routes a
 * message onto the Wire.
 *
 * It performs NO domain work — no Gmail/Calendar/Vault/Codex access, no Wire send.
 * It is a `WorkerEntrypoint` (confirmed agents@0.14.1 / @cloudflare/workers-types
 * @4.20260603.1: `export abstract class WorkerEntrypoint<Env, Props>` from
 * "cloudflare:workers", with arbitrary public methods callable over a service binding
 * as RPC). The binding NOOP -> service "atlas" (a self-binding) is declared in
 * apps/atlas/wrangler.jsonc in Task 4 of this plan.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "@atlas/shared";

/** The acknowledgement the no-op agent returns to the dispatcher. */
export interface NoopAck {
  ok: true;
  at: number;
}

export class NoopAgent extends WorkerEntrypoint<Env> {
  /**
   * The single RPC method (D-11). Returns a small acknowledgement; does NO domain
   * work. The `params` argument is accepted purely to prove argument-passing over
   * the service binding (the dispatcher sends `{ note: "phase-0 smoke" }`).
   */
  async tick(_params?: Record<string, unknown>): Promise<NoopAck> {
    return { ok: true, at: Date.now() };
  }
}
