import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParams } from "@anthropic-ai/sdk/resources/messages";
import { flag, type Env } from "@atlas/shared";

// ─────────────────────────────────────────────────────────────────────────────
// The AI-Gateway model-access spine — claudeFor(agent, env) / modelFor(agent, env).
//
// EVERY Claude call routes through the dedicated Cloudflare AI Gateway Anthropic endpoint
// (`.../{account}/{gateway}/anthropic`) — NEVER the direct Anthropic API host (CLAUDE.md
// model-spine invariant; T-00-74). Per-agent model tiering is read from CONFIG (KV
// `model:<codename>` override → `[vars]` `MODEL_<CODENAME>` default → the CLAUDE.md tiering
// map fallback), NOT hardcoded — re-tunable without a redeploy (D-05). A non-2xx Gateway
// response raises a Flagger flag via `flag(env, "P3", …)` (degraded model access is
// non-fatal), which enqueues a RawIncident (kind "model_error") onto atlas-incidents (D2-05).
// Flagger is the sole consumer and routes it to the Vault board — never a silent failure.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical per-agent model tiering map (CLAUDE.md "Model tiering" — the source of
 * truth, replicated EXACTLY). Keyed by lowercase codename. ONLY dateless pinned 4.x ids:
 *   Opus   claude-opus-4-8   → Atlas, Compass, Archivist
 *   Sonnet claude-sonnet-4-6 → Forge, Herald, Scout, Headhunter (full)
 *   Haiku  claude-haiku-4-5  → Filer (continuous + sweep), Headhunter (board-scan)
 * Never a retired evergreen id (the `…-4-<8-digit-date>` form is grep-gated to zero).
 */
const TIER_MAP: Record<string, string> = {
  atlas: "claude-opus-4-8",
  compass: "claude-opus-4-8",
  archivist: "claude-opus-4-8",
  forge: "claude-sonnet-4-6",
  herald: "claude-sonnet-4-6",
  scout: "claude-sonnet-4-6",
  headhunter: "claude-sonnet-4-6",
  filer: "claude-haiku-4-5",
  librarian: "claude-haiku-4-5",  // title/tags derivation: Haiku, high-volume gateway (D-05)
};

/** The Sonnet default for any agent not explicitly tiered (mid-cost, safe middle ground). */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * The allowlist of valid, currently-pinned dateless 4.x ids (CLAUDE.md MODEL table). A
 * resolved id from KV / [vars] is accepted ONLY if it is one of these — so the docstring's
 * "always a valid 4.x id, never retired" holds even for a misconfigured operator value
 * (W18). A retired `claude-*-4-<8-digit-date>` id, an unknown family, or any garbage value
 * is REJECTED and the resolution falls back to the tier-map default.
 */
const VALID_MODEL_IDS: ReadonlySet<string> = new Set([
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);

/** True iff `id` is an accepted, currently-pinned model id (allowlist membership). */
function isValidModelId(id: string): boolean {
  return VALID_MODEL_IDS.has(id);
}

/** Normalize an agent codename to its canonical lowercase key (CLAUDE.md: Wire agent = codename). */
function codename(agent: string): string {
  return agent.trim().toLowerCase();
}

/**
 * Resolve the model id for an agent — CONFIG-driven, NOT hardcoded (D-05 re-tier without
 * redeploy). Resolution order:
 *   1. KV `model:<codename>` override (e.g. `await env.CONFIG.get("model:filer")`),
 *   2. `[vars]` `MODEL_<CODENAME>` default (e.g. env.MODEL_FILER),
 *   3. the CLAUDE.md tiering map fallback,
 *   4. the Sonnet default.
 *
 * Each operator-supplied candidate (1, 2) is validated against the dateless-4.x allowlist
 * (W18): a misconfigured value (a retired `-4-<date>` id, an unknown family, garbage) is
 * REJECTED — we do NOT return it verbatim — and resolution falls through to the tier-map
 * default, with a best-effort P3 flag when a WIRE binding is present. The tier-map / Sonnet
 * defaults (3, 4) are allowlisted constants and never need validation. The returned id is
 * therefore ALWAYS one of the valid 4.x ids — never a retired dated id.
 */
export async function modelFor(
  agent: string,
  env: Pick<Env, "CONFIG"> & Record<string, unknown>,
): Promise<string> {
  const name = codename(agent);
  const fallback = TIER_MAP[name] ?? DEFAULT_MODEL;

  // 1. KV override (the operator can re-tier any agent live).
  const override = await env.CONFIG.get(`model:${name}`);
  if (override) {
    if (isValidModelId(override)) return override;
    await flagBadModelId(env, name, "KV model override", override, fallback);
    return fallback;
  }

  // 2. [vars] MODEL_<CODENAME> default (per-codename, NOT a per-tier set).
  const varKey = `MODEL_${name.toUpperCase()}`;
  const varDefault = env[varKey];
  if (typeof varDefault === "string" && varDefault !== "") {
    if (isValidModelId(varDefault)) return varDefault;
    await flagBadModelId(env, name, `[vars] ${varKey}`, varDefault, fallback);
    return fallback;
  }

  // 3. CLAUDE.md tiering map → 4. Sonnet default (both allowlisted constants).
  return fallback;
}

/**
 * Best-effort P3 flag for a rejected (misconfigured) model id. Non-fatal: model resolution
 * always proceeds with the allowlisted fallback regardless. We only emit when a WIRE binding
 * is present (modelFor's env surface does not type WIRE, but claudeFor's ModelEnv does), and
 * we swallow any emit failure — a degraded telemetry path must never break model resolution.
 */
async function flagBadModelId(
  env: Record<string, unknown>,
  agent: string,
  source: string,
  badId: string,
  fallback: string,
): Promise<void> {
  const incidents = env["INCIDENTS"];
  if (!isQueueLike(incidents)) return;
  try {
    await flag(
      { INCIDENTS: incidents as NonNullable<Env["INCIDENTS"]> },
      "P3",
      `Invalid model id configured for ${agent}`,
      `${source} resolved "${badId}", which is not an allowlisted 4.x id; ` +
        `fell back to "${fallback}".`,
      { sourceAgent: "Model", kind: "model_error", suggestedAction: "Fix the KV/[vars] model id (use a pinned 4.x id)." },
    );
  } catch {
    // Telemetry is best-effort — never let a flag failure break model resolution.
  }
}

/** Narrow an unknown binding to the Queue producer surface flag()/send() need. */
function isQueueLike(v: unknown): v is { send: (...args: unknown[]) => unknown } {
  return !!v && typeof (v as { send?: unknown }).send === "function";
}

/** The AI-Gateway base host (CLAUDE.md / build-plan T14). NEVER the direct Anthropic host. */
const GATEWAY_HOST = "https://gateway.ai.cloudflare.com/v1";

/**
 * Build the dedicated AI-Gateway Anthropic endpoint for this account+gateway:
 *   https://gateway.ai.cloudflare.com/v1/{AIG_ACCOUNT_ID}/{AIG_GATEWAY_ID}/anthropic
 * (build-plan T14 per-agent endpoint; the direct Anthropic host is never used.)
 */
export function gatewayBaseURL(accountId: string, gatewayId: string): string {
  return `${GATEWAY_HOST}/${accountId}/${gatewayId}/anthropic`;
}

/** The minimal Env surface claudeFor needs (the model/AI-Gateway TYPE surface from 00-02). */
type ModelEnv = Pick<
  Env,
  "INCIDENTS" | "CONFIG" | "ANTHROPIC_API_KEY" | "CF_AIG_TOKEN" | "AIG_ACCOUNT_ID" | "AIG_GATEWAY_ID"
> &
  Record<string, unknown>;

/**
 * A Claude client bound to one agent, routed through the AI Gateway. Every reasoning call
 * uses `messages.create`, which wraps the underlying SDK call so a non-2xx Gateway response
 * raises a Flagger P3 flag (then rethrows). `model` is omittable per-call — it defaults to
 * the agent's resolved tier.
 */
export interface AgentClaude {
  /** The agent codename this client is bound to (== the cf-aig-metadata agent). */
  readonly agent: string;
  /** The resolved model id for this agent (KV→[vars]→map). */
  readonly model: string;
  /** The underlying @anthropic-ai/sdk client (baseURL = the AI Gateway endpoint). */
  readonly client: Anthropic;
  /** Create a message; a non-2xx Gateway response is flagged (P3) then rethrown. */
  messages: {
    create(
      params: Omit<MessageCreateParams, "model"> & { model?: string },
    ): Promise<unknown>;
  };
}

/**
 * Construct an agent-bound Claude client routed through the AI Gateway.
 *
 * - `baseURL` is the gateway Anthropic endpoint (never the direct Anthropic host).
 * - `apiKey` is read from the Secrets-Store `ANTHROPIC_API_KEY` binding (async `.get()`).
 * - the Authenticated-Gateway token (`cf-aig-authorization: Bearer <CF_AIG_TOKEN>`) means a
 *   leaked Anthropic key alone cannot bill the account (T-00-74).
 * - `cf-aig-metadata: {"agent":"<codename>"}` is set ONCE in the factory (per-agent cost
 *   attribution in Gateway logs).
 * - a non-2xx Gateway response → `flag(env, "P3", …)` then rethrow (T-00-75).
 *
 * Phase 0 only BUILDS the factory; the first live call is Phase 1 (the gateway + Anthropic
 * key are owner-provisioned in 00-06). Constructing the client requires no live network.
 */
export async function claudeFor(agent: string, env: ModelEnv): Promise<AgentClaude> {
  const name = codename(agent);
  const accountId = env.AIG_ACCOUNT_ID ?? "";
  const gatewayId = env.AIG_GATEWAY_ID ?? "";
  // Fail fast on an unprovisioned gateway (I30): an empty account/gateway id silently builds
  // a malformed baseURL (`.../v1///anthropic`) that only surfaces as a runtime 404 on the
  // first live call. Throw a clear, actionable error at construction time instead.
  if (accountId === "" || gatewayId === "") {
    throw new Error(
      "AI Gateway is not provisioned: AIG_ACCOUNT_ID and AIG_GATEWAY_ID must be set in " +
        "[vars] (see CLAUDE.md — AIG_ACCOUNT_ID/AIG_GATEWAY_ID are plaintext non-secret vars). " +
        `Got AIG_ACCOUNT_ID="${accountId}", AIG_GATEWAY_ID="${gatewayId}".`,
    );
  }
  const baseURL = gatewayBaseURL(accountId, gatewayId);

  // Secrets are async-read bindings (await .get()); never read from [vars] (T-00-73).
  const apiKey = (await env.ANTHROPIC_API_KEY?.get()) ?? "";
  const aigToken = (await env.CF_AIG_TOKEN?.get()) ?? "";

  const client = new Anthropic({
    apiKey,
    baseURL,
    defaultHeaders: {
      // Authenticated Gateway — the gateway rejects a call lacking this token.
      "cf-aig-authorization": `Bearer ${aigToken}`,
      // Cost attribution per agent — set ONCE in the factory.
      "cf-aig-metadata": JSON.stringify({ agent: name }),
    },
  });

  const model = await modelFor(name, env);

  return {
    agent: name,
    model,
    client,
    messages: {
      async create(params) {
        try {
          return await client.messages.create({ model, ...params } as MessageCreateParams);
        } catch (err) {
          await flagGatewayError(env, name, err);
          throw err;
        }
      },
    },
  };
}

/**
 * On a degraded-Gateway throw, raise a Flagger P3 flag (degraded model access is non-fatal).
 * `flag()` (D2-05) enqueues a RawIncident (kind "model_error") onto atlas-incidents; Flagger
 * is the sole consumer and routes it to the Vault board (never a silent failure). Two degraded
 * classes are flagged:
 *   1. a genuine non-2xx HTTP response (an `APIError` carrying a numeric `status`), and
 *   2. a connection/timeout failure reaching the Gateway (`APIConnectionError` and its
 *      `APIConnectionTimeoutError` subclass) — these carry `status===undefined`, so the
 *      old numeric-only check NEVER flagged them and degraded gateway access was silent
 *      (W19).
 * Genuine non-error paths (a 2xx, a plain non-SDK throw) stay quiet; the caller rethrows.
 */
async function flagGatewayError(
  env: { INCIDENTS?: Env["INCIDENTS"] },
  agent: string,
  err: unknown,
): Promise<void> {
  if (!env.INCIDENTS) return; // INCIDENTS not yet bound — telemetry best-effort
  // 2. Connection / timeout failure — the Gateway was unreachable (no HTTP status at all).
  if (err instanceof Anthropic.APIConnectionError) {
    const timeout = err instanceof Anthropic.APIConnectionTimeoutError;
    const detail = err instanceof Error ? err.message : String(err);
    await flag(
      { INCIDENTS: env.INCIDENTS },
      "P3",
      `Model gateway unreachable for ${agent}${timeout ? " (timeout)" : ""}`,
      detail,
      { sourceAgent: "Model", kind: "model_error", suggestedAction: "Check AI Gateway reachability / network." },
    );
    return;
  }

  // 1. Non-2xx HTTP response from the Gateway.
  const status = errorStatus(err);
  if (status === undefined || (status >= 200 && status < 300)) {
    // Not a degraded-gateway signal — nothing to flag here (the caller still rethrows).
    return;
  }
  const detail = err instanceof Error ? err.message : String(err);
  await flag(
    { INCIDENTS: env.INCIDENTS },
    "P3",
    `Model gateway returned ${status} for ${agent}`,
    detail,
    { sourceAgent: "Model", kind: "model_error", suggestedAction: "Check AI Gateway / Anthropic key + budget." },
  );
}

/** Extract an HTTP status from an @anthropic-ai/sdk APIError-shaped throw (non-2xx detection). */
function errorStatus(err: unknown): number | undefined {
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    return err.status;
  }
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}
