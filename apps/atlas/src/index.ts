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
import { flag } from "@atlas/shared";
import type { AtlasEnv } from "./env.js";
import type { AtlasCoordinator } from "./coordinator.js";
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
// Export the MorningChain Workflow so the `workflows` binding (class_name "MorningChain")
// in wrangler.jsonc resolves against this Worker (CORE-01).
export { MorningChain } from "./morning-chain.js";

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
 * Discriminate a Workflow create() failure: is it the BENIGN "an instance with this id already
 * exists" collision (a same-day re-fire — the desired idempotency no-op), or a REAL error
 * (rate-limit / 5xx / transient) that means the chain never started? The Workflows runtime
 * surfaces the duplicate-id case as an error whose message contains "already exists" (Cloudflare
 * documents createBatch as idempotent on existing ids; single-create throws this collision). We
 * match the message tolerantly (case-insensitive) so only the collision is swallowed; everything
 * else is surfaced (console.error + P2). False-negative bias is intentional: if in doubt, SURFACE.
 */
function isInstanceExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists|instance.*exists|duplicate/i.test(message);
}

/**
 * The Wave-3 SPINE-01 dispatcher, preserved verbatim. Kept as a standalone handler object so
 * the OAuthProvider composition below can borrow its `scheduled` method while the provider owns
 * `fetch`. Routes ONLY known crons — an unknown cron falls through and does nothing (T-00-32).
 */
const dispatcher = {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // C5 (D-10 heartbeat supervision must be LIVE in production): the scheduled() dispatcher is
    // the real runtime path that arms + feeds the self-monitor. EVERY cron tick (known or not) is
    // a liveness signal, so this runs OUTSIDE the cron switch below:
    //   (1) startHeartbeat() — idempotent arm (no-op if the alarm is already set; seeds lastBeat
    //       on a fresh DO so the first alarm() never false-fires a P1, C6).
    //   (2) beat()           — record the pulse the alarm() staleness check watches for.
    // Atlas stays a Wire PRODUCER only: this is a self-RPC to its OWN coordinator DO
    // (env.ATLAS.getByName("root") — one name = one instance), NOT a queue consumer. Best-effort:
    // a heartbeat-arm failure must never block the SPINE-01 dispatch leg below.
    try {
      // The shared Env types ATLAS as the generic (optional) DurableObjectNamespace; narrow to
      // the typed <AtlasCoordinator> form HERE (not in AtlasEnv — an optional `<undefined>`
      // namespace can't be refined via interface extension) so the heartbeat RPC is type-safe.
      const atlas = env.ATLAS as unknown as DurableObjectNamespace<AtlasCoordinator>;
      const coordinator = atlas.getByName("root");
      await coordinator.startHeartbeat();
      await coordinator.beat();
    } catch {
      // Supervision arm/feed is best-effort; never let it regress the dispatch leg.
    }

    switch (controller.cron) {
      // 07:45 ET morning-chain slot — the ONE cron that kicks the MorningChain Workflow
      // (CORE-01). EDT form "45 11 * * 1-5"; EST form "45 12 * * 1-5" (re-derive at DST). A
      // single instance id morning-<owner-local-date> makes a re-fire (or a missed-then-
      // recovered cron) a complete no-op. ctx.waitUntil keeps the dispatch off the tick's
      // critical path; create() is a no-op if the id already exists.
      case "45 11 * * 1-5":
      case "45 12 * * 1-5": {
        const date = localDate(env);
        const chain = env.MORNING_CHAIN;
        if (chain) {
          _ctx.waitUntil(
            chain
              .create({ id: `morning-${date}`, params: { date, tz: "America/Toronto" } })
              .catch(async (err: unknown) => {
                // DISCRIMINATE (NEW-AW3): a same-day re-fire collides on the instance id
                // morning-<date> — that's the BENIGN idempotency no-op (the existing instance
                // owns the run), swallow it silently. ANY OTHER create error (rate-limit / 5xx /
                // transient) is NOT benign: missed crons are never auto-replayed, so swallowing it
                // would let the WHOLE morning pipeline silently never start. Surface it —
                // console.error for logs + a P2 toward Flagger — so a silent whole-day skip becomes
                // observable. The P2 id is stable (date-keyed) so a repeated failure upserts ONE row.
                if (isInstanceExistsError(err)) return;
                const message = err instanceof Error ? err.message : String(err);
                console.error(`MorningChain create failed for morning-${date}: ${message}`);
                await flag(
                  env,
                  "P2",
                  "morning-chain.create-failed",
                  `MorningChain instance morning-${date} failed to start. The morning pipeline did NOT run (missed crons are not auto-replayed).`,
                  {
                    sourceAgent: "Atlas",
                    suggestedAction: `Investigate the Workflow create failure (error: ${message}); manually create morning-${date} to recover today's chain.`,
                  },
                ).catch(() => {
                  // Best-effort: a Flagger/Wire failure must never throw out of waitUntil. The
                  // console.error above still records the create failure.
                });
              }),
          );
        }
        break;
      }
      // 07:45 ET Filer-sweep slot, EST form (Phase-0 SPINE-01 no-op smoke). The EDT form
      // ("45 11 * * *") is documented in docs/03-scheduling.md (00-01).
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
