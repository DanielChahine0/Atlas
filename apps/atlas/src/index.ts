/**
 * Atlas — the orchestrator Worker.
 *
 * Phase 0, Plan 01 (Wave 1): this is the minimal hello-world scaffold so the
 * monorepo builds and typechecks. The scheduled() dispatcher (SPINE-01), the
 * AtlasCoordinator DO + heartbeat, and the Workers OAuthProvider front door
 * (SPINE-04) land in Wave 2 (Plan 02 / 04).
 *
 * Atlas does NO domain work — it schedules, routes, sequences, supervises, and
 * owns the Wire. Every default export uses the `satisfies ExportedHandler<Env>`
 * form (never the older type-annotation form).
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  // Atlas's coordinator DO, addressed as env.ATLAS.getByName("root").
  // MORNING_CHAIN_DO binds the SAME class. Remaining canonical bindings
  // (WIRE, DB, CONFIG, OAUTH_KV, BLOBS, AI) surface here as later waves use them.
  ATLAS: DurableObjectNamespace<AtlasCoordinator>;
  MORNING_CHAIN_DO: DurableObjectNamespace<AtlasCoordinator>;
}

/**
 * AtlasCoordinator — the orchestrator DO (one instance: getByName("root")).
 *
 * Phase 0, Plan 01 (Wave 1): placeholder so the `new_sqlite_classes` migration
 * + ATLAS/MORNING_CHAIN_DO bindings resolve and the monorepo builds. The 5-min
 * alarm() heartbeat (D-10: self-flag P1 if stale) and the cron-dispatch wiring
 * land in Wave 2 (Plan 02). Atlas does NO domain work.
 */
export class AtlasCoordinator extends DurableObject<Env> {
  async ping(): Promise<string> {
    return "atlas: coordinator online (phase 0 skeleton)";
  }
}

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("atlas: spine online (phase 0)\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
