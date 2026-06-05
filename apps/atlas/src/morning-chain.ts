/**
 * MorningChain — the strictly-sequential morning pipeline as ONE durable Cloudflare Workflow
 * (CORE-01). ONE 07:45 cron creates ONE instance (id morning-<date>); this Workflow runs the
 * five agents as `await`-ed start-after-success steps:
 *
 *   filer-sweep → (08:00) herald-daily → (08:15) forge-morning → (08:20) sundial-sync →
 *   (08:30) compass-plan
 *
 * The Workflow gives the properties five racing crons cannot:
 *   - `await` ⇒ START-AFTER-SUCCESS: a step runs only after the prior step returned.
 *   - step memoization ⇒ RESUME-ON-FAILURE: a kill mid-forge-morning resumes AT forge-morning
 *     (filer-sweep/herald-daily are memoized, not re-invoked).
 *   - an exhausted-retry step errors the instance ⇒ HALT-DOWNSTREAM: Sundial/Compass never run
 *     on stale data; the upstream side effects (Filer labels, Herald draft) stand.
 *   - instance id morning-<date> ⇒ RE-FIRE IS A NO-OP.
 *
 * On a halt (a step's terminal failure), exactly ONE `chain.halted` P2 is emitted toward Flagger
 * (idempotencyKey morning-halt:<date>:<step>) — never a silent drop.
 *
 * CLAUDE.md gotcha: `NonRetryableError` imports from `cloudflare:workflows` (a DIFFERENT module
 * than WorkflowEntrypoint/WorkflowStep from `cloudflare:workers`). Do NOT mutate event.payload
 * inside a step (reverts on replay) — return state and pass it forward.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { flag } from "@atlas/shared";
import type { AtlasEnv } from "./env.js";
import { invokeAgent, type AgentCodename } from "./invoke-agent.js";
import { localTime } from "./localtime.js";

/** The Workflow params (the instance is created with these). */
export interface MorningChainParams {
  /** Owner-local YYYY-MM-DD (the idempotency anchor; the instance id is morning-<date>). */
  date: string;
  /** Owner timezone for the DST-safe budget gates. */
  tz: string;
}

/** Per-step retry/timeout policy (KV-overridable later; the build-plan §3 starting policy). */
const STEP_CONFIG = {
  filer: { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
  other: { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
} as const;

/** The five steps in order, with the codename + the owner-local budget-gate time. */
const STEPS: { name: string; codename: AgentCodename; gate: string | null }[] = [
  { name: "filer-sweep", codename: "filer", gate: null }, // runs immediately at chain start
  { name: "herald-daily", codename: "herald", gate: "08:00" },
  { name: "forge-morning", codename: "forge", gate: "08:15" },
  { name: "sundial-sync", codename: "sundial", gate: "08:20" },
  { name: "compass-plan", codename: "compass", gate: "08:30" },
];

/**
 * A step's memoized result. The agent return is JSON-encoded to a flat `string` so the
 * Workflow memoization type is trivially serializable (avoids the recursive Rpc.Serializable
 * constraint blowing up on a deep JSON value type — TS2589). The next step decodes the carried
 * blob it needs; in Phase 1 the steps are independent passes, so the prior result is passed
 * forward as context, never structurally consumed.
 */
interface StepResult {
  /** The prior step's agent return, JSON-encoded (or "null"). */
  resultJson: string;
}

export class MorningChain extends WorkflowEntrypoint<AtlasEnv, MorningChainParams> {
  override async run(event: Readonly<WorkflowEvent<MorningChainParams>>, step: WorkflowStep): Promise<void> {
    const { date, tz } = event.payload;

    // The state passed forward between steps (never mutate event.payload — it reverts on replay).
    // `carry` accumulates each completed step's JSON-encoded result keyed by codename.
    const carry: Record<string, string> = { date };

    for (const s of STEPS) {
      // Per-step budget gate (DST-safe owner-local wall-clock; NOT a UTC cron). The first step
      // (filer-sweep) has no gate — it runs at chain start.
      if (s.gate) {
        await step.sleepUntil(`budget-${s.codename}`, localTime(date, s.gate, tz));
      }

      const cfg = s.codename === "filer" ? STEP_CONFIG.filer : STEP_CONFIG.other;
      const carrySnapshot: Record<string, string> = { ...carry };
      try {
        const result = await step.do<StepResult>(s.name, cfg, async () => {
          // Pass the prior steps' returns forward as this step's input (state forward, never
          // mutate event.payload). invokeAgent dispatches over the agent's service binding.
          const out = await invokeAgent(this.env, s.codename, { ...carrySnapshot, date });
          return { resultJson: JSON.stringify(out ?? null) };
        });
        // Memoized step return becomes part of the next step's input context.
        carry[s.codename] = result.resultJson;
      } catch (err) {
        // HALT-DOWNSTREAM: this step exhausted its retries (or threw a terminal
        // NonRetryableError). Sundial/Compass after a failed Forge never run on stale data.
        // Emit EXACTLY ONE chain.halted P2 toward Flagger, then rethrow so the instance errors
        // (its terminal state is observable in `wrangler workflows instances describe`).
        await this.emitHalt(date, s.name, err);
        throw err;
      }
    }
  }

  /**
   * Emit the single chain.halted P2 incident. The flag() helper derives a STRUCTURED, stable
   * idempotency key from (severity, title, detail) so a replayed halt re-upserts ONE board row
   * (never a duplicate). The detail names the halted step + a neutral error summary (never a
   * secret).
   */
  private async emitHalt(date: string, stepName: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await flag(
      this.env,
      "P2",
      "chain.halted",
      `MorningChain ${date} halted at ${stepName}: ${message}. Downstream steps did not run (no planning on stale data); upstream side effects stand.`,
      { sourceAgent: "Atlas", suggestedAction: `Investigate ${stepName}; re-fire morning-${date} once fixed (a re-fire is a no-op for completed steps).` },
    );
  }
}
