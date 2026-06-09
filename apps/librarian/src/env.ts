import type { Env as SharedEnv } from "@atlas/shared";

/**
 * Librarian Env — extends the shared binding surface with the Librarian-specific
 * Bearer secret. WIRE, DB, CONFIG, INCIDENTS, and the AI-Gateway bindings
 * (ANTHROPIC_API_KEY, CF_AIG_TOKEN, AIG_ACCOUNT_ID, AIG_GATEWAY_ID) are all
 * inherited from SharedEnv for claudeFor("librarian", env).
 *
 * ATLAS_LIBRARIAN_TOKEN is a NEW sibling Secrets Store binding — NOT ATLAS_BRIDGE_TOKEN
 * (Pitfall 4: separate secrets per separate Worker boundary).
 *
 * Secrets are TYPE declarations ONLY — no secret value ever appears here (T-5-Info).
 * Reads are async: `await env.ATLAS_LIBRARIAN_TOKEN?.get()`.
 */
export interface Env extends SharedEnv {
  /** Librarian Bearer secret — Secrets Store async binding. */
  ATLAS_LIBRARIAN_TOKEN?: SecretsStoreSecret;
}
