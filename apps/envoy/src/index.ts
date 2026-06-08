/**
 * Envoy (apps/envoy) — on-demand personal-brand publisher (OUTWARD-02).
 *
 * Flow:
 *   1. publish({ projectName }) — initial call from Atlas:
 *      a. Derive projectSlug = slugify(projectName)
 *      b. Short-circuit if idempotency_keys has key='envoy:<slug>' → already_published
 *      c. Read Codex → draft four literal artifacts (LinkedIn, GitHub README, X, portfolio)
 *         via claudeFor(env,"Envoy") (Sonnet tier, AI Gateway — never direct api.anthropic.com)
 *      d. openGate(env, { agent:'Envoy', action:'brand.publish', target:slug,
 *                          artifact:JSON, idempotencyKey:'envoy:<slug>',
 *                          expiresInMs:7d from CONFIG, confirmBaseUrl:GATE_BASE_URL,
 *                          scopeUsed:'github.write' })
 *         passing NTFY_TOPIC + NTFY_TOKEN through in env (so openGate can dispatch push)
 *      e. Return { status:'gate_opened', gateId }
 *
 *   2. onApproved({ gateId, projectSlug, approvedTargets, editedArtifact }) — gate re-invoke:
 *      a. SECURITY GUARD 1 (RPC Authorization): assert gate_pending.status='approved' for
 *         gateId — no approved gate row → P1 self-flag + abort, return gate_not_approved
 *      b. SECURITY GUARD 2 (Gate-Replay Single-Shot): atomically claim
 *         INSERT OR IGNORE INTO idempotency_keys key='envoy:<slug>:<target>:published'
 *         per approved target — meta.changes===0 on replay → skip that target
 *      c. Publish ONLY targets in approvedTargets (per-target, skipped → no action):
 *         - github_readme or portfolio: call github.ts → mcp-github tools (agent completes)
 *         - linkedin or x: enqueue browser_action_outbox prefill (owner clicks Post)
 *      d. Partial fan-out: any failure → P2 with EXACT succeeded/failed targets listed
 *      e. Wire event: AFTER all approved targets attempted, send() Brand counter increment
 *         idempotencyKey:'envoy:<slug>' (Steward dedup; separate from per-target locks)
 *
 * SECURITY GUARD 3 (Distinct Idempotency Keys):
 *   - Wire key 'envoy:<slug>' → Steward's counter ledger (never reused as a local lock)
 *   - Per-target lock 'envoy:<slug>:<target>:published' → local single-shot guard
 *   - These are DISTINCT keys — reusing the Wire key as a local lock would cause Steward
 *     to treat the increment as a replay (meta.changes===0) and skip the counter bump.
 *
 * Pillar 1: NO queues.consumers on atlas-wire — Wire PRODUCER only.
 * Pillar 2: Gate BEFORE any irreversible publish; owner confirms per-target.
 * Pillar 5: Stable idempotencyKey 'envoy:<slug>' — never crypto.randomUUID().
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { send } from "@atlas/wire";
import { flag, localDate } from "@atlas/shared";
import type { RawIncident } from "@atlas/shared";
import { openGate } from "@atlas/gate";
import type { GateOptions } from "@atlas/gate";
import { read as readCodex } from "@atlas/codex";
import { draftArtifacts, slugify } from "./draft.js";
import { commitReadme, openPortfolioPR } from "./github.js";
import type { McpGitHubBinding } from "./github.js";
import { enqueuePrefill, PLATFORM_URLS } from "./browser.js";

// ─── Env type ──────────────────────────────────────────────────────────────────

/** SecretsStoreSecret-compatible interface (accept null/undefined from test stubs). */
interface SecretBinding {
  get(): Promise<string | null | undefined>;
}

/**
 * Envoy's env surface. Includes NTFY_TOPIC/NTFY_TOKEN so they are passed through to
 * openGate() which dispatches the confirm push (04-01). Envoy never reads them directly.
 */
export interface Env {
  /** D1 atlas-db — idempotency_keys, gate_pending, browser_action_outbox, audit_log. */
  DB: D1Database;
  /** Wire PRODUCER — Brand counters increment. */
  WIRE: Queue<unknown>;
  /** Incidents PRODUCER — for flag() calls. */
  INCIDENTS: Queue<RawIncident>;
  /** KV config knobs — gates.timeout_envoy_ms (default 604800000 = 7d), envoy.* knobs. */
  CONFIG: KVNamespace;
  /** Workers AI gateway — for claudeFor(env,"Envoy") Codex-driven artifact drafting. */
  AI?: Fetcher;
  /** Confirm page base URL (plaintext [vars], NOT a secret). */
  GATE_BASE_URL?: string;
  /** NTFY_TOPIC — Secrets Store binding; passed to openGate for the confirm push. */
  NTFY_TOPIC?: SecretBinding;
  /** NTFY_TOKEN — Secrets Store binding; passed to openGate for the confirm push. */
  NTFY_TOKEN?: SecretBinding;
  /** GATE service binding to apps/gate (confirm page + browser_action_outbox transport). */
  GATE?: {
    fetch(request: Request): Promise<Response>;
  };
  /** MCP_GITHUB service binding (github_put_file, github_create_branch, github_open_pr). */
  MCP_GITHUB?: McpGitHubBinding;
  /** Index signature required for claudeFor/modelFor env compatibility. */
  [key: string]: unknown;
}

// ─── Result types ──────────────────────────────────────────────────────────────

export type EnvoyStatus =
  | "already_published"
  | "gate_opened"
  | "published"
  | "partial_published"
  | "gate_not_approved";

export interface EnvoyResult {
  status: EnvoyStatus;
  gateId?: string;
  succeededTargets?: string[];
  failedTargets?: string[];
}

// ─── ULID generator (inline — same as packages/gate/src/index.ts, no new dep) ─

const CROCKFORD_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
  const now = Date.now();
  let ms = now;
  const tChars: string[] = new Array(10);
  for (let i = 9; i >= 0; i--) {
    tChars[i] = CROCKFORD_CHARS[ms & 0x1f]!;
    ms = Math.floor(ms / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(10));
  let bits = BigInt(0);
  for (const byte of rand) {
    bits = (bits << 8n) | BigInt(byte);
  }
  const rChars: string[] = new Array(16);
  for (let i = 15; i >= 0; i--) {
    rChars[i] = CROCKFORD_CHARS[Number(bits & 0x1fn)]!;
    bits >>= 5n;
  }
  return tChars.join("") + rChars.join("");
}

// ─── runPublish ───────────────────────────────────────────────────────────────

/**
 * runPublish — the core initial publish logic (testable, injected env).
 *
 * Flow: short-circuit → Codex read → draft artifacts → openGate → return gate_opened.
 */
export async function runPublish(
  env: Env,
  params: {
    projectName: string;
    /** Injected for tests — skips real Codex read. */
    _codex?: Awaited<ReturnType<typeof readCodex>>;
    /** Injected for tests — skips real drafting. */
    _drafts?: Array<{ platform: string; draft: string }>;
    /** Injected for tests — overrides gate open. */
    _openGate?: (opts: GateOptions) => Promise<{ id: string }>;
  },
  date: string,
): Promise<EnvoyResult> {
  const { projectName, _codex, _drafts, _openGate } = params;
  const projectSlug = slugify(projectName);
  const wireKey = `envoy:${projectSlug}`;

  // ── Already-published short-circuit (D4-15) ──────────────────────────────────
  // Check idempotency_keys table FIRST — if the Wire event was already emitted,
  // the project was fully published; return immediately.
  const existing = await env.DB.prepare(
    "SELECT 1 FROM idempotency_keys WHERE key = ?",
  )
    .bind(wireKey)
    .first();
  if (existing) {
    return { status: "already_published" };
  }

  // ── Read Codex + draft artifacts ─────────────────────────────────────────────
  let targets: Array<{ platform: string; draft: string }>;
  if (_drafts) {
    targets = _drafts;
  } else {
    // Read Codex — requires drive.readonly access token from KV (go-live gate)
    // For pre-go-live: use a stub codex structure if CONFIG token is missing
    let codex: Awaited<ReturnType<typeof readCodex>>;
    if (_codex) {
      codex = _codex;
    } else {
      // At go-live: pass drive.readonly access token from KV here
      // Pre-go-live: skip real Codex read and use draft placeholder
      codex = {
        identity: { name: "Daniel Chahine" },
        education: [],
        work: [],
        skills: {},
        projects: [],
        bios: { short: "Software engineer and builder." },
        socials: { linkedin: "https://linkedin.com/in/danielchahine", github: "https://github.com/danielchahine", x: "@danielchahine" },
        raw: "",
      };
    }
    targets = await draftArtifacts(env, codex, projectName, projectSlug);
  }

  // Build the gate artifact — all four drafts as a JSON array
  const artifact = JSON.stringify({
    projectName,
    projectSlug,
    targets: targets.map((t) => ({ platform: t.platform, draft: t.draft })),
  });

  // ── Read gate timeout from CONFIG (default 7d) ───────────────────────────────
  const timeoutRaw = await env.CONFIG.get("gates.timeout_envoy_ms");
  const expiresInMs = timeoutRaw ? parseInt(timeoutRaw, 10) : 604800000; // 7 days

  const gateBaseUrl = env.GATE_BASE_URL ?? "https://gate.atlas.workers.dev";

  const gateOpts: GateOptions = {
    agent: "Envoy",
    action: "brand.publish",
    target: projectSlug,
    artifact,
    idempotencyKey: wireKey,
    expiresInMs,
    confirmBaseUrl: gateBaseUrl,
    scopeUsed: "github.write",
  };

  // openGate: writes gate_pending row + pending audit row atomically, THEN dispatches
  // the ntfy confirm push (best-effort, non-fatal). NTFY_TOPIC and NTFY_TOKEN are passed
  // through via this.env (Envoy's env carries them from the wrangler.jsonc binding).
  const gate = _openGate
    ? await _openGate(gateOpts)
    : await openGate(env, gateOpts);

  return { status: "gate_opened", gateId: gate.id };
}

// ─── runOnApproved ────────────────────────────────────────────────────────────

/**
 * runOnApproved — handles the gate-approved re-invocation from apps/gate.
 *
 * Three security guards applied (mirrors apps/usher/src/index.ts hardened pattern):
 *   Guard 1: RPC Authorization — assert gate_pending.status='approved' first
 *   Guard 2: Gate-Replay Single-Shot — per-target INSERT OR IGNORE lock
 *   Guard 3: Distinct idempotency keys — Wire key != per-target lock keys
 */
export async function runOnApproved(
  env: Env,
  params: {
    gateId: string;
    projectSlug: string;
    approvedTargets: string[];
    editedArtifact?: string;
    /** Injected for tests — mock MCP_GITHUB. */
    _mcpGitHub?: McpGitHubBinding;
  },
  date: string,
): Promise<EnvoyResult> {
  const { gateId, projectSlug, approvedTargets, editedArtifact, _mcpGitHub } = params;
  const wireKey = `envoy:${projectSlug}`;

  // ── SECURITY GUARD 1: RPC Authorization ──────────────────────────────────────
  // Assert gate_pending.status='approved' BEFORE any publish action (T-04-36).
  // A re-invoke without an approved gate row → P1 self-flag + abort (no publish).
  const gateRow = await env.DB.prepare(
    "SELECT status FROM gate_pending WHERE id = ?",
  )
    .bind(gateId)
    .first<{ status: string }>();

  if (!gateRow || gateRow.status !== "approved") {
    await flag(
      env,
      "P1",
      `Envoy: publish attempted without approved gate (gateId=${gateId})`,
      `Gate status: ${gateRow?.status ?? "not found"}. projectSlug=${projectSlug}`,
      {
        sourceAgent: "Envoy",
        kind: "envoy:publish_attempted_without_confirmation",
        runId: date,
      },
    );
    // Abort — no GitHub commit/PR, no browser enqueue, no counter. Discriminated failure.
    return { status: "gate_not_approved" };
  }

  // ── Parse the (possibly edited) artifact ────────────────────────────────────
  // The edited_artifact from the gate confirm page overrides the original drafts.
  let artifactTargets: Array<{ platform: string; draft: string }> = [];
  if (editedArtifact) {
    try {
      const parsed = JSON.parse(editedArtifact) as { targets?: Array<{ platform: string; draft: string }> };
      artifactTargets = parsed.targets ?? [];
    } catch {
      // If parse fails, we proceed with empty drafts (the approved targets list still drives publish)
    }
  }
  if (artifactTargets.length === 0) {
    // Fallback: fetch from gate_pending artifact
    const artifactRow = await env.DB.prepare(
      "SELECT artifact FROM gate_pending WHERE id = ?",
    )
      .bind(gateId)
      .first<{ artifact: string }>();
    if (artifactRow?.artifact) {
      try {
        const parsed = JSON.parse(artifactRow.artifact) as { targets?: Array<{ platform: string; draft: string }> };
        artifactTargets = parsed.targets ?? [];
      } catch {
        artifactTargets = [];
      }
    }
  }

  // Build a platform→draft lookup
  const draftByPlatform = new Map<string, string>(
    artifactTargets.map((t) => [t.platform, t.draft]),
  );

  // ── Read CONFIG knobs for GitHub repos (D4-14) ────────────────────────────────
  const [profileRepo, portfolioRepo, portfolioPath, portfolioBranch] = await Promise.all([
    env.CONFIG.get("envoy.profile_repo"),
    env.CONFIG.get("envoy.portfolio_repo"),
    env.CONFIG.get("envoy.portfolio_path"),
    env.CONFIG.get("envoy.portfolio_base_branch"),
  ]);

  const succeededTargets: string[] = [];
  const failedTargets: string[] = [];

  const mcpGitHub = _mcpGitHub ?? env.MCP_GITHUB;

  // ── Publish ONLY approved targets (per-target, skipped → no action) ───────────
  for (const target of approvedTargets) {
    // SECURITY GUARD 2: Gate-Replay Single-Shot per approved target
    // INSERT OR IGNORE a per-target lock to prevent double-publish on replay.
    // Key is DISTINCT from the Wire key (Guard 3: different keys for different purposes).
    const targetLockKey = `envoy:${projectSlug}:${target}:published`;
    const lockResult = await env.DB.prepare(
      "INSERT OR IGNORE INTO idempotency_keys (key, agent, type, entity, op, applied_at) VALUES (?, 'Envoy', 'brand.publish', ?, 'append', ?)",
    )
      .bind(targetLockKey, target, Date.now())
      .run();

    if (lockResult.meta.changes === 0) {
      // Already published this target (approval replay) — skip silently.
      succeededTargets.push(target); // count as succeeded (was already done)
      continue;
    }

    // Publish this target
    let targetOk = false;
    let targetDetail = "";

    try {
      if (target === "github_readme") {
        // Agent completes: commit README section via mcp-github (D4-10)
        if (!mcpGitHub) {
          targetDetail = "MCP_GITHUB binding not available";
        } else if (!profileRepo) {
          targetDetail = "envoy.profile_repo not set in CONFIG (D4-14)";
        } else {
          const [owner, repo] = splitRepo(profileRepo);
          const readmeDraft = draftByPlatform.get("github_readme") ?? "";
          const result = await commitReadme(mcpGitHub, {
            owner,
            repo,
            path: "README.md",
            content: readmeDraft,
            message: `Add ${projectSlug} to profile README`,
          });
          targetOk = result.ok;
          targetDetail = result.detail;
        }
      } else if (target === "portfolio") {
        // Agent completes: create branch + put file + open PR (D4-10)
        if (!mcpGitHub) {
          targetDetail = "MCP_GITHUB binding not available";
        } else if (!portfolioRepo) {
          targetDetail = "envoy.portfolio_repo not set in CONFIG (D4-14)";
        } else {
          const [owner, repo] = splitRepo(portfolioRepo);
          const portfolioDraft = draftByPlatform.get("portfolio") ?? "";
          const filePath = portfolioPath
            ? `${portfolioPath}/${projectSlug}.md`
            : `projects/${projectSlug}.md`;
          const result = await openPortfolioPR(mcpGitHub, {
            owner,
            repo,
            slug: projectSlug,
            filePath,
            fileContent: portfolioDraft,
            prTitle: `Add ${projectSlug} portfolio entry`,
            prBody: `Auto-generated portfolio entry for ${projectSlug} via Envoy.`,
            baseBranch: portfolioBranch ?? "main",
          });
          targetOk = result.ok;
          targetDetail = result.detail;
          // PR conflict / 4xx → P3 for this target
          if (!result.ok) {
            await flag(
              env,
              "P3",
              `Envoy: portfolio PR failed for ${projectSlug}`,
              targetDetail,
              { sourceAgent: "Envoy", kind: "envoy:portfolio_pr_failed", runId: date },
            );
          }
        }
      } else if (target === "linkedin") {
        // Owner clicks Post: enqueue linkedin_prefill (D4-08, never auto-post)
        const linkedinDraft = draftByPlatform.get("linkedin") ?? "";
        const result = await enqueuePrefill(
          { DB: env.DB },
          "linkedin",
          gateId,
          linkedinDraft,
          PLATFORM_URLS.linkedin,
        );
        targetOk = result.ok;
        targetDetail = result.detail;
        // DOM/selector block → abort target, keep draft, P2 (D4-13)
        // Note: the actual block is detected by the daemon; here we just enqueue.
        // If enqueue itself fails, that is a D1 error — report as targetDetail.
      } else if (target === "x") {
        // Owner clicks Post: enqueue x_prefill (D4-08, never auto-post)
        const xDraft = draftByPlatform.get("x") ?? "";
        const result = await enqueuePrefill(
          { DB: env.DB },
          "x",
          gateId,
          xDraft,
          PLATFORM_URLS.x,
        );
        targetOk = result.ok;
        targetDetail = result.detail;
      } else {
        targetDetail = `Unknown target platform: ${target}`;
      }
    } catch (err) {
      targetOk = false;
      targetDetail = `Unexpected error publishing ${target}: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (targetOk) {
      succeededTargets.push(target);
    } else {
      failedTargets.push(target);
      // Rollback the per-target lock so a future retry can attempt this target again
      // (only if the target genuinely failed — replay guard still holds via idempotencyKey)
      await env.DB.prepare(
        "DELETE FROM idempotency_keys WHERE key = ?",
      )
        .bind(targetLockKey)
        .run()
        .catch(() => {}); // best-effort rollback
    }
  }

  // ── Partial fan-out: P2 if any approved target failed ────────────────────────
  if (failedTargets.length > 0) {
    await flag(
      env,
      "P2",
      `Envoy: partial fan-out for ${projectSlug} — ${failedTargets.length} target(s) failed`,
      `Succeeded: [${succeededTargets.join(", ")}] | Failed: [${failedTargets.join(", ")}]`,
      {
        sourceAgent: "Envoy",
        kind: "envoy:partial_fanout",
        runId: date,
      },
    );
  }

  // ── Wire event: emit AFTER publish, only if at least one target succeeded ─────
  // GUARD 3: Wire idempotencyKey 'envoy:<slug>' is the Steward ledger key — DISTINCT
  // from the per-target lock keys above. Steward INSERT OR IGNORE dedup → meta.changes===0
  // on replay → no double-count (D4-15).
  if (succeededTargets.length > 0) {
    // Count only successfully published browser targets (those enqueued as prefill)
    const publishedBrowserTargets = succeededTargets.filter(
      (t) => t === "linkedin" || t === "x",
    );

    await send(env, {
      agent: "Envoy",
      type: "brand.project_published",
      entity: projectSlug,
      op: "increment",
      payload: {
        projects_published: 1,
        posts_shipped: publishedBrowserTargets.length,
        targets: approvedTargets,
      },
      idempotencyKey: wireKey,
    });
  }

  const allSucceeded = failedTargets.length === 0;
  return {
    status: allSucceeded ? "published" : "partial_published",
    succeededTargets,
    failedTargets,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Split "owner/repo" into [owner, repo]. Defaults to ["danielchahine", input] if no slash. */
function splitRepo(repoString: string): [string, string] {
  const parts = repoString.split("/");
  if (parts.length >= 2) return [parts[0]!, parts.slice(1).join("/")];
  return ["danielchahine", repoString];
}

// ─── WorkerEntrypoint ─────────────────────────────────────────────────────────

/**
 * Envoy WorkerEntrypoint — on-demand personal-brand publisher.
 *
 * Invoked by Atlas via service binding (initial call) and by apps/gate (approved re-invoke).
 * Methods: publish() (initial) + onApproved() (gate-approved continuation).
 */
export class Envoy extends WorkerEntrypoint<Env> {
  /**
   * publish({ projectName }):
   *   Fans one intent ("I started/shipped <project>") into four literal Codex-sourced
   *   drafts and opens ONE ~7d gate with per-target approve/edit/skip.
   *   Returns { status:'gate_opened', gateId } — gate delivers the confirm push via
   *   NTFY_TOPIC/NTFY_TOKEN (passed through to openGate).
   *
   * Short-circuits if the Wire idempotency key 'envoy:<slug>' already exists (D4-15).
   * No separate ntfy push-send in Envoy — the send lives only in openGate (04-01).
   */
  async publish(params: { projectName: string }): Promise<EnvoyResult> {
    const date = localDate(this.env);
    try {
      return await runPublish(this.env, params, date);
    } catch (err) {
      await flag(
        this.env,
        "P2",
        `Envoy publish() failed: ${params.projectName}`,
        String(err),
        { sourceAgent: "Envoy", kind: "envoy_failed", runId: date },
      );
      throw err;
    }
  }

  /**
   * onApproved({ gateId, projectSlug, approvedTargets, editedArtifact }):
   *   Gate-approved continuation re-invoked by apps/gate after the owner approves.
   *   Publishes ONLY the approved subset of targets.
   *   Three security guards applied (gate-replay single-shot, RPC authorization, distinct keys).
   */
  async onApproved(params: {
    gateId: string;
    projectSlug: string;
    approvedTargets: string[];
    editedArtifact?: string;
  }): Promise<EnvoyResult> {
    const date = localDate(this.env);
    try {
      return await runOnApproved(this.env, params, date);
    } catch (err) {
      await flag(
        this.env,
        "P2",
        `Envoy onApproved() failed: ${params.projectSlug}`,
        String(err),
        { sourceAgent: "Envoy", kind: "envoy_failed", runId: date },
      );
      throw err;
    }
  }
}

// ─── Default export (satisfies ExportedHandler) ───────────────────────────────

export default {
  // Envoy has no own cron — Atlas drives it via service binding.
  fetch(): Response {
    return new Response("Envoy runs via Atlas service binding.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
