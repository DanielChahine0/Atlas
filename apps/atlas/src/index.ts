/**
 * Atlas — the orchestrator Worker (Phase 0; Plan 03 dispatcher + Plan 06 OAuth front door).
 *
 * The default export is the inbound Workers OAuthProvider FRONT DOOR (SPINE-04), COMPOSED
 * with the Wave-3 SPINE-01 `scheduled()` dispatcher:
 *
 *   - `fetch`     -> the OAuthProvider (the owner authorizes once at `/authorize`; the local
 *                    daemon + each MCP client present access tokens at `/mcp/` `/api/`).
 *   - `scheduled` -> the Wave-3 dispatcher: a cron tick invokes the no-op agent over a private
 *                    service-binding RPC (D-11), THEN routes a canonical §6.4 event onto the
 *                    Wire (ROADMAP Phase-0 Success Criterion 1).
 *
 * The OAuthProvider class only implements `fetch` (it has NO `scheduled` method — confirmed in
 * the 0.7.2 `.d.ts`), so composition is a wrapper object that delegates `fetch` to the provider
 * instance and keeps Atlas's own `scheduled` handler. The provider injects `env.OAUTH_PROVIDER`
 * (the OAuthHelpers) into both the default + api handlers.
 *
 * Atlas does NO domain work — it schedules, routes, sequences, supervises, and owns the Wire.
 * It is a Wire PRODUCER ONLY (Pillar 1): no consumer block, never writes the Vault/Gmail/Codex.
 * Steward is the sole atlas-wire consumer.
 *
 * Every default export uses `satisfies ExportedHandler<Env>` (never the older
 * `: ExportedHandler<Env>` annotation).
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { send } from "@atlas/wire";
import type { AtlasEnv } from "./env.js";
import { consentHandler } from "./auth/consent.js";
import { AtlasApiHandler } from "./auth/api-handler.js";
import { SCOPES_SUPPORTED } from "./auth/scopes.js";
import { ensureSeededClients, type ClientSeedEnv } from "./auth/clients.js";

// Re-export the AtlasCoordinator DO from the MAIN entry so the
// `new_sqlite_classes: ["AtlasCoordinator"]` migration in wrangler.jsonc resolves.
export { AtlasCoordinator } from "./coordinator.js";
// Export the no-op agent so wrangler.jsonc's services `entrypoint: "NoopAgent"`
// self-binding (00-03 Task 4) resolves against this Worker.
export { NoopAgent } from "./noop-agent.js";
// Export the API handler so the OAuthProvider's `apiHandler` (a WorkerEntrypoint class)
// resolves as a Worker entrypoint.
export { AtlasApiHandler } from "./auth/api-handler.js";

// Re-export the canonical local Env (defined in ./env.ts to avoid a circular import with the
// OAuth handlers). `AtlasEnv` is the shared binding surface + NOOP + OAUTH_PROVIDER + the three
// OAuth provider secret bindings. Also re-exported as `Env` (the name the 00-03 dispatcher tests
// import) so the rename is non-breaking.
export type { AtlasEnv, AtlasEnv as Env } from "./env.js";

/** Local alias so the dispatcher + composition below read `Env`. */
type Env = AtlasEnv;

/**
 * Derive owner-local YYYY-MM-DD. workerd / wrangler dev / vitest all force TZ=UTC, so
 * `new Date()` is UTC even on the laptop (CLAUDE.md gotcha) — derive owner-local time
 * explicitly via Intl with the America/Toronto zone. Used to build the STABLE, structured,
 * date-derived idempotency key (never a random per-run UUID for scheduled work).
 */
function localDate(_env: Env): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
}

/**
 * The Wave-3 SPINE-01 dispatcher, preserved verbatim. Kept as a standalone handler object so
 * the OAuthProvider composition below can borrow its `scheduled` method while the provider owns
 * `fetch`. Routes ONLY known crons — an unknown cron falls through and does nothing (T-00-32).
 */
const dispatcher = {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    switch (controller.cron) {
      // 07:45 ET Filer-sweep slot, EST form. The EDT form ("45 11 * * *") is documented in
      // docs/03-scheduling.md (00-01). Phase 0 only needs this dispatcher BRANCH to exist; the
      // cron LINES themselves first fire in Phase 1 (so wrangler.jsonc adds no triggers.crons here).
      case "45 12 * * *": {
        // SPINE-01, in order:
        // (1) Invoke the no-op agent over the PRIVATE service binding (D-11) — Worker-to-Worker
        //     RPC, no public HTTP. This is the schedule -> invoke leg.
        await env.NOOP.tick({ note: "phase-0 smoke" });
        // (2) THEN route a canonical §6.4 event onto the Wire via the @atlas/wire parse-then-send
        //     producer. STABLE structured idempotencyKey `atlas:noop:<owner-local-date>` — a
        //     re-fired or missed-then-recovered cron replays as a downstream no-op via Steward's
        //     ledger dedup (T-00-35).
        await send(env, {
          agent: "Atlas",
          type: "noop.tick",
          entity: "spine",
          op: "append",
          payload: { note: "phase-0 smoke" },
          idempotencyKey: `atlas:noop:${localDate(env)}`,
        });
        break;
      }
    }
  },
} satisfies Pick<ExportedHandler<Env>, "scheduled">;

/**
 * The inbound OAuthProvider front door. Backed by the REAL `OAUTH_KV` namespace declared in
 * wrangler.jsonc — startup FAILS without it (the provider needs KV, never D1; T-00-26 accepts
 * fail-closed-on-missing-KV as desired behavior).
 *
 *   - `apiRoute: ['/mcp/', '/api/']`  — authenticated routes (token validated before apiHandler).
 *   - `apiHandler: AtlasApiHandler`   — reads ctx.props { ownerId, scopes } (door-level least
 *                                       privilege; full per-tool 403 lands in mcp-google at 00-08).
 *   - `defaultHandler: consentHandler`— the `/authorize` consent surface; it ENFORCES the scope
 *                                       allow-list (the provider does not) and issues codes.
 *   - `scopesSupported: SCOPES_SUPPORTED` — advertised in RFC-8414 metadata ONLY. The provider
 *                                       does NOT reject/clamp a requested `?scope=` (0.7.2). The
 *                                       FLOOR is ENFORCED in auth/consent.ts against this SAME
 *                                       array (single source of truth — they cannot drift).
 *   - `accessTokenTTL: 3600`          — 1-hour access tokens.
 *
 * NOTE (Round-2 hardening): no `clientRegistrationEndpoint` is configured. Anonymous RFC-7591
 * Dynamic Client Registration (even of a CONFIDENTIAL client with an attacker redirect_uri) is a
 * phishing vector, and `disallowPublicClientRegistration` blocks only PUBLIC clients. Per plan
 * decision D4 (confidential clients via the Workers OAuth Provider, registered out-of-band) the
 * daemon + each MCP client are seeded out-of-band — see auth/clients.ts `ensureSeededClients`,
 * invoked at startup. With the endpoint omitted, the provider returns 404 for `/oauth/register`,
 * so NO unauthenticated party can register any client.
 */
// The provider options as a NAMED const so the out-of-band client seeder (auth/clients.ts) can
// reuse the EXACT same object via getOAuthApi(options, env) — same KV + crypto config.
const providerOptions: OAuthProviderOptions<Env> = {
  apiRoute: ["/mcp/", "/api/"],
  apiHandler: AtlasApiHandler,
  defaultHandler: consentHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  // clientRegistrationEndpoint deliberately OMITTED (Round-2): no anonymous DCR. Clients are
  // seeded out-of-band (D4) via auth/clients.ts.
  scopesSupported: SCOPES_SUPPORTED as string[],
  accessTokenTTL: 3600,
  // Belt-and-suspenders: even if an endpoint were re-added, never allow public clients.
  disallowPublicClientRegistration: true,
};

const provider = new OAuthProvider<Env>(providerOptions);

/** Seed out-of-band clients ONCE per isolate (idempotent; no-op if CLIENT_REGISTRY is unset). */
let clientSeedStarted = false;

/**
 * The composed Atlas default export: the OAuthProvider owns `fetch`; the Wave-3 dispatcher owns
 * `scheduled`. `satisfies ExportedHandler<Env>` (never the `: ExportedHandler<Env>` annotation).
 */
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    // Out-of-band client seeding (D4) — fire once per isolate, off the request critical path.
    if (!clientSeedStarted) {
      clientSeedStarted = true;
      ctx.waitUntil(
        ensureSeededClients(env as ClientSeedEnv, providerOptions).catch(() => {
          // Seeding failure is non-fatal: an unseeded client simply can't authorize (fail-safe).
          clientSeedStarted = false; // allow a retry on the next request
        }),
      );
    }
    return provider.fetch(request, env, ctx);
  },
  scheduled: dispatcher.scheduled,
} satisfies ExportedHandler<Env>;
