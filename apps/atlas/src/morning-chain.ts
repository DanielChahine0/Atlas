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
 *
 * Measurement affordance (D1-04): the compass-plan step's `day_plan` event drives the §6.3
 * morning-glance (Dashboard/Home.md top-3). The daily ~1-min "did Atlas miss anything?" review
 * is logged by the OWNER as a line under a "Misses" section in that note — never by an agent.
 * See GO-LIVE-CHECKLIST.md (Gate 2) for the affordance + the three go-live gates.
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

/**
 * The orchestration body, factored OUT of the class so it is unit-testable with a fake `step`
 * + injected agent bindings (constructing a WorkflowEntrypoint directly is unsupported in the
 * test pool). The class `run()` is a thin delegate to this. `step` is typed to the subset the
 * chain uses (do + sleepUntil) so a fake harness satisfies it.
 */
export async function runMorningChain(
  env: AtlasEnv,
  event: Readonly<WorkflowEvent<MorningChainParams>>,
  step: Pick<WorkflowStep, "do" | "sleepUntil">,
): Promise<void> {
  const { date, tz } = event.payload;

  // The state passed forward between steps (never mutate event.payload — it reverts on replay).
  // `carry` accumulates each completed step's JSON-encoded result keyed by codename.
  const carry: Record<string, string> = { date };

  for (const s of STEPS) {
    // Per-step budget gate (DST-safe owner-local wall-clock; NOT a UTC cron). The first step
    // (filer-sweep) has no gate — it runs at chain start. A past gate (sleepUntil to a past
    // instant — e.g. a cron that fired late, or this step's wall-clock target has already
    // passed) resolves IMMEDIATELY BY DESIGN: the chain fails forward (proceed now), it NEVER
    // waits to the next day to "catch" a missed target time (WR-04).
    if (s.gate) {
      await step.sleepUntil(`budget-${s.codename}`, localTime(date, s.gate, tz));
    }

    const cfg = s.codename === "filer" ? STEP_CONFIG.filer : STEP_CONFIG.other;
    const carrySnapshot: Record<string, string> = { ...carry };
    try {
      const result = await step.do<StepResult>(s.name, cfg, async () => {
        // Pass the prior steps' returns forward as this step's input (state forward, never
        // mutate event.payload). invokeAgent dispatches over the agent's service binding.
        const out = await invokeAgent(env, s.codename, { ...carrySnapshot, date });
        return { resultJson: JSON.stringify(out ?? null) };
      });
      // Memoized step return becomes part of the next step's input context.
      carry[s.codename] = result.resultJson;
    } catch (err) {
      // HALT-DOWNSTREAM: this step exhausted its retries (or threw a terminal NonRetryableError).
      // Sundial/Compass after a failed Forge never run on stale data. Emit EXACTLY ONE
      // chain.halted P2 toward Flagger, then rethrow so the instance errors (its terminal state
      // is observable in `wrangler workflows instances describe`).
      //
      // The emission is MEMOIZED in its own `step.do(`halt-<step>`, …)` so it fires EXACTLY ONCE
      // per instance even across Workflow replays (the catch block re-executes on every replay;
      // an un-memoized emit would re-send → a duplicate board row). emitHalt is best-effort: it
      // swallows its OWN failure internally so it can never mask the real cause — we ALWAYS
      // rethrow the original `err` so the instance terminates errored with the true reason.
      const message = err instanceof Error ? err.message : String(err);
      await step.do(`halt-${s.name}`, async () => {
        await emitHalt(env, date, s.name, message);
        return null;
      });
      throw err;
    }
  }
}

/**
 * Emit the single chain.halted P2 incident. The flag() helper derives a STRUCTURED, stable
 * idempotency key from (severity, title, detail). To honour the "exactly ONE chain.halted P2"
 * guarantee, the KEYED inputs (title + detail) MUST be a pure function of (date, stepName) — the
 * resulting flag id is the stable `morning-halt:<date>:<step>` identity. The VOLATILE error
 * `message` (which can differ across retries) is carried in the NON-keyed `suggestedAction` field
 * ONLY, so it never perturbs the id (a different message would otherwise mint a second board row).
 *
 * Best-effort: a failure in the emit itself is swallowed here so it can NEVER mask the original
 * step error — the caller ALWAYS rethrows the original `err` after this returns.
 */
export async function emitHalt(
  env: AtlasEnv,
  date: string,
  stepName: string,
  message: string,
): Promise<void> {
  try {
    await flag(
      env,
      "P2",
      "chain.halted",
      // STABLE detail — a pure function of (date, stepName); NO volatile err.message here.
      `MorningChain ${date} halted at ${stepName}. Downstream steps did not run (no planning on stale data); upstream side effects stand.`,
      {
        sourceAgent: "Atlas",
        kind: "chain_halted",
        // The volatile error summary lives ONLY in the non-keyed suggestedAction (never a secret).
        suggestedAction: `Investigate ${stepName} (error: ${message}); re-fire morning-${date} once fixed (a re-fire is a no-op for completed steps).`,
      },
    );
  } catch {
    // The emit is best-effort: never let a Flagger/Wire failure mask the real step error. The
    // caller rethrows the original cause; the instance still terminates errored.
  }
}

export class MorningChain extends WorkflowEntrypoint<AtlasEnv, MorningChainParams> {
  override async run(event: Readonly<WorkflowEvent<MorningChainParams>>, step: WorkflowStep): Promise<void> {
    await runMorningChain(this.env, event, step);
  }
}
