/**
 * Atlas's runtime Env — the local binding surface (Phase 0; Plan 03 + Plan 06).
 *
 * Defined in its OWN module (not index.ts) so the OAuthProvider handlers (auth/consent.ts,
 * auth/api-handler.ts) and the index dispatcher can all import the SAME `AtlasEnv` without a
 * circular import (index.ts imports the handlers; the handlers would otherwise import index.ts).
 *
 * Extends the shared canonical binding surface (`@atlas/shared` `Env`) with:
 *   - `NOOP`           — the D-11 self service-binding the dispatcher invokes.
 *   - `OAUTH_PROVIDER` — injected by the OAuthProvider at runtime into every handler's env.
 *   - the three OAuth provider SECRETS (Secrets Store async bindings) the outbound helpers read.
 *
 * No secret VALUE ever appears here — these are TYPE declarations referencing bindings only
 * (CLAUDE.md security invariant). Secret reads are async: `await env.X.get()`.
 */

import type { Env as SharedEnv, RawIncident } from "@atlas/shared";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { NoopAgent } from "./noop-agent.js";

export interface AtlasEnv extends Omit<SharedEnv, "INCIDENTS"> {
  /** INCIDENTS producer (atlas-incidents): Atlas enqueues RawIncidents via flag() (D2-05). */
  INCIDENTS: Queue<RawIncident>;
  /** The D-11 self service-binding; `Service<NoopAgent>` exposes the agent's public RPC. */
  NOOP: Service<NoopAgent>;

  // ── Phase 1: the five morning-chain agent service bindings (D-11 RPC transport) ──────
  // Each is a Worker-to-Worker service binding to the agent's WorkerEntrypoint (no public
  // HTTP). The MorningChain Workflow's steps invoke them via invokeAgent(env, codename, …).
  // Typed loosely as Service so each agent's RPC method (sweep/daily/morning/sync/plan) is
  // callable without coupling Atlas to each agent's full type. Optional so a Phase-0-shaped
  // env (no agents deployed yet) still satisfies AtlasEnv in unit tests.
  FILER?: Service;
  // HERALD is BOTH a morning-chain binding (invokeAgent calls daily() via an untyped cast)
  // AND a Phase-2 Friday-16:00 binding (the dispatcher calls weekly() directly, typed below).
  // Its type carries the weekly() RPC so the direct call typechecks; the cast path that
  // invokeAgent uses for daily() is unaffected (it casts to a generic record).
  HERALD?: { weekly(params?: { date?: string }): Promise<unknown> };
  FORGE?: Service;
  SUNDIAL?: Service;
  COMPASS?: Service;

  // ── Phase 2 (D2-11): the standalone-cron agent service bindings ──────────────────────
  // Wired so the scheduled() dispatcher's 4 NEW standalone cron cases (Headhunter
  // deadlines-light + full, Friday Scout+Herald, Friday 16:30 weekly-review build) can RPC
  // the agents directly — NOT via the MorningChain Workflow (D2-11: standalone crons, never
  // new Workflow steps). Typed with the MINIMAL RPC method surface each leg calls (the same
  // plain-object-type pattern Headhunter uses for its FORGE binding) so `env.X.method({date})`
  // typechecks without coupling Atlas to each agent's full WorkerEntrypoint type. The
  // `{ date?: string }` param matches every agent's weekly()/full()/deadlines() signature
  // (Plans 02-04/05/06); the return is the agent's own result, which each fire-and-forget leg
  // ignores. Optional so a Phase-0/1-shaped env (these agents not deployed yet) still
  // satisfies AtlasEnv in unit tests; the dispatcher uses `!` since a configured cron implies
  // its binding, and a missing binding throws (surfaced loudly) rather than silently skipping.
  SCOUT?: { weekly(params?: { date?: string }): Promise<unknown> };
  HEADHUNTER?: {
    full(params?: { date?: string }): Promise<unknown>;
    deadlines(params?: { date?: string }): Promise<unknown>;
  };
  STEWARD?: { weeklyReviewBuild(params?: { date?: string }): Promise<unknown> };

  /** The MorningChain Workflow binding (atlas-morning-chain). Optional for Phase-0 tests. */
  MORNING_CHAIN?: Workflow;

  /** Injected by the OAuthProvider at runtime into the default + api handlers' env. */
  OAUTH_PROVIDER: OAuthHelpers;
  /**
   * The OAuthProvider's backing KV (mandatory on Atlas — startup fails without it). The consent
   * surface also uses it to store single-use server-side consent records (consent:<id>) so the
   * canonical authorize request + CSRF token never round-trip through the browser. Required (not
   * optional) here: the consent handler depends on it.
   */
  OAUTH_KV: KVNamespace;
  /** Google confidential client secret — Secrets Store async binding (oauth/google.ts). */
  GOOGLE_CLIENT_SECRET?: SecretsStoreSecret;
  /** Google owner-once refresh token — Secrets Store async binding (oauth/google.ts). */
  GOOGLE_REFRESH_TOKEN?: SecretsStoreSecret;
  /** GitHub App RS256 PKCS8 private key — Secrets Store async binding (oauth/github.ts). */
  GH_APP_PRIVATE_KEY?: SecretsStoreSecret;
  /**
   * Owner authentication token — Secrets Store async binding (post-review hardening). `/login`
   * constant-time-compares the submitted token against this to gate the consent surface.
   * Declared-and-deferred: provisioned at the owner checkpoint (Gate C), NOT now.
   */
  OWNER_AUTH_TOKEN?: SecretsStoreSecret;
  /**
   * Session cookie HMAC signing key — Secrets Store async binding (post-review hardening).
   * Optional: if absent, the session key is HKDF-derived from OWNER_AUTH_TOKEN. Declared-and-
   * deferred: provisioned at the owner checkpoint (Gate C), NOT now.
   */
  SESSION_SIGNING_KEY?: SecretsStoreSecret;
  /**
   * Out-of-band OAuth client registry — a NON-secret [vars] JSON array of
   * { clientId, redirectUris, clientName }, seeded into OAUTH_KV at startup (auth/clients.ts).
   * Round-2 hardening: the provider exposes no anonymous registration endpoint, so clients are
   * seeded here instead. Declared-and-deferred (Gate C); "[]" = no-op.
   */
  CLIENT_REGISTRY?: string;
}
