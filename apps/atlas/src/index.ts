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

export interface Env {
  // Canonical bindings are declared in wrangler.jsonc and surfaced here in
  // later waves (WIRE, DB, CONFIG, OAUTH_KV, BLOBS, AI, ATLAS, MORNING_CHAIN_DO).
  // Intentionally empty in Wave 1 — the hello-world handler needs none of them.
}

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("atlas: spine online (phase 0)\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
