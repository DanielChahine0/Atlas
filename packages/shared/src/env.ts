import type { WireEvent } from "@atlas/wire";

/**
 * Flag/incident severity (SPEC-CANON §8 / docs/08-flagger.md §4). Deterministic by source
 * signal, NEVER LLM-assigned. The Severity union is exactly these four — passing a fifth is
 * a compile error (see flag()).
 */
export type Severity = "P1" | "P2" | "P3" | "P4";

/**
 * The shared Env binding-type surface — the CANONICAL binding names + Cloudflare primitive
 * types from the CLAUDE.md "Canonical conventions" table.
 *
 * NOT every binding is on every Worker. `WIRE`/`DB`/`CONFIG`/`AI` are common; `STEWARD_LOCK`
 * is Steward-only; `OAUTH_KV`/`ATLAS` are Atlas-only. The per-Worker-optional bindings are
 * marked `?` so each Worker can extend/narrow this interface without conflict.
 *
 * Secrets are TYPE declarations referencing bindings only — NO secret VALUE ever appears here
 * (CLAUDE.md security invariant; T-00-24). Secret reads are async: `await env.X.get()`.
 */
export interface Env {
  // ── The Wire (Queue producer; every agent except Steward) ───────────────────────────
  WIRE: Queue<WireEvent>;

  // ── D1 system-of-record — ALL counters + idempotency keys live here, never KV ────────
  DB: D1Database;

  // ── KV: config/flags + the label→color map. NEVER secrets, NEVER counters. ───────────
  CONFIG: KVNamespace;

  // ── KV: OAuth grants/tokens for the inbound provider (Atlas-only; must be a real KV). ─
  OAUTH_KV?: KVNamespace;

  // ── R2: atlas-blobs (audio/exports). ─────────────────────────────────────────────────
  BLOBS?: R2Bucket;

  // ── Workers AI: gateway routing — all Claude via claudeFor(agent, env). ───────────────
  AI?: Ai;

  // ── Durable Objects (PascalCase class = role). ───────────────────────────────────────
  // Steward-only: env.STEWARD_LOCK.getByName("vault") — one name = one instance = the
  // single Vault write lock.
  STEWARD_LOCK?: DurableObjectNamespace;
  // Atlas-only: env.ATLAS.getByName("root").
  ATLAS?: DurableObjectNamespace;

  // ── AI-Gateway / Claude TYPE surface (resolves the 00-07 Env gap — 00-07's modelFor
  //    factory imports these without extending a Wave-2-owned file). ────────────────────
  //
  // Secrets-Store binding TYPES ({ get(): Promise<string> }). These are TYPE declarations
  // ONLY — no Phase-0 wrangler secret binding is required for them (live Claude calls are
  // Phase 1). Marked optional so a Phase-0 Worker that never calls a model still satisfies Env.
  ANTHROPIC_API_KEY?: SecretsStoreSecret;
  CF_AIG_TOKEN?: SecretsStoreSecret;

  // Plaintext [vars] (non-secret) — AI Gateway routing identifiers.
  AIG_ACCOUNT_ID?: string;
  AIG_GATEWAY_ID?: string;

  // Per-agent model tiering keyed BY CODENAME (CLAUDE.md: "per-agent tiering in [vars]/KV,
  // NOT in code"). A template-literal index signature so any MODEL_<CODENAME> key — e.g.
  // MODEL_FILER, MODEL_HERALD, MODEL_ATLAS — is typed `string`. This per-codename
  // MODEL_<CODENAME> form (NOT a per-tier MODEL_OPUS/MODEL_SONNET/MODEL_HAIKU set) is exactly
  // what 00-07's modelFor reads; the [vars] default is overridable by the KV `model:<codename>` key.
  [key: `MODEL_${string}`]: string | undefined;
}
