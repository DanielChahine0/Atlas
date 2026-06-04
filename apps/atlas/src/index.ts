/**
 * Atlas — the orchestrator Worker (Phase 0, Plan 03 / Wave 3).
 *
 * This replaces the Wave-1 hello-world fetch handler with the SPINE-01 dispatcher:
 * a cron tick reaches scheduled(), which invokes the no-op agent over a private
 * service-binding RPC (D-11), THEN routes a canonical §6.4 event onto the Wire.
 * That is ROADMAP Phase-0 Success Criterion 1 — Atlas's first observable behavior.
 *
 * Atlas does NO domain work — it schedules, routes, sequences, and supervises, and
 * owns the Wire. It is a Wire PRODUCER ONLY (Pillar 1): it declares no consumer block
 * and never writes the Vault/Gmail/Codex. Steward is the sole atlas-wire consumer.
 *
 * Every default export uses `satisfies ExportedHandler<Env>` (never the older
 * `: ExportedHandler<Env>` annotation).
 *
 * NOTE: the Workers inbound-OAuth provider default-export composition (SPINE-04, the
 * inbound front door) is deliberately NOT here — it lands in Plan 00-06, which re-owns
 * this file to compose the inbound-auth front door WITH this dispatcher. Keep the
 * dispatcher cleanly separable; do NOT introduce the inbound-auth provider in this plan.
 */

import { send } from "@atlas/wire";
import type { Env as SharedEnv } from "@atlas/shared";
import type { NoopAgent } from "./noop-agent.js";

// Re-export the AtlasCoordinator DO from the MAIN entry so the
// `new_sqlite_classes: ["AtlasCoordinator"]` migration in wrangler.jsonc resolves.
export { AtlasCoordinator } from "./coordinator.js";
// Export the no-op agent so wrangler.jsonc's services `entrypoint: "NoopAgent"`
// self-binding (Task 4) resolves against this Worker.
export { NoopAgent } from "./noop-agent.js";

/**
 * Atlas's runtime Env: the shared canonical binding surface plus the NOOP
 * service-binding (D-11) the dispatcher invokes. `Service<NoopAgent>` exposes the
 * agent's public RPC methods (here `tick()`) over the private service binding.
 */
export interface Env extends SharedEnv {
  NOOP: Service<NoopAgent>;
}

/**
 * Derive owner-local YYYY-MM-DD. workerd / wrangler dev / vitest all force TZ=UTC, so
 * `new Date()` is UTC even on the laptop (CLAUDE.md gotcha) — derive owner-local time
 * explicitly via Intl with the America/Toronto zone. Used to build the STABLE,
 * structured, date-derived idempotency key (never a random per-run UUID for scheduled work).
 */
function localDate(_env: Env): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    switch (controller.cron) {
      // 07:45 ET Filer-sweep slot, EST form. The EDT form ("45 11 * * *") is documented
      // in docs/03-scheduling.md (00-01). Phase 0 only needs this dispatcher BRANCH to
      // exist; the cron LINES themselves first fire in Phase 1 (so wrangler.jsonc adds no
      // triggers.crons here). The dispatcher routes ONLY known crons — an unknown cron
      // falls through the switch and does nothing (T-00-32).
      case "45 12 * * *": {
        // SPINE-01, in order:
        // (1) Invoke the no-op agent over the PRIVATE service binding (D-11) — Worker-to-
        //     Worker RPC, no public HTTP. This is the schedule -> invoke leg.
        await env.NOOP.tick({ note: "phase-0 smoke" });
        // (2) THEN route a canonical §6.4 event onto the Wire via the @atlas/wire
        //     parse-then-send producer. STABLE structured idempotencyKey
        //     `atlas:noop:<owner-local-date>` — a re-fired or missed-then-recovered cron
        //     replays as a downstream no-op via Steward's ledger dedup (T-00-35).
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
} satisfies ExportedHandler<Env>;
