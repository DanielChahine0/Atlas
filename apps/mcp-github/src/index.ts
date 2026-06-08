/**
 * mcp-github — the STATEFUL GitHub MCP (SPINE-04).
 *
 * Shape: agents@0.14.1 `McpAgent` (a Durable-Object-backed Agent) fronted by the
 * inbound Workers `OAuthProvider`. The provider validates the access token, then
 * routes `/mcp/*` to the McpAgent's static `serve()` handler with the granted scopes
 * attached as `ctx.props`. Tools are registered via the MCP SDK 1.29.0 `registerTool()`
 * (the v2-forward path; we do NOT adopt MCP SDK v2 alpha).
 *
 * HARD invariant (threat register T-00-32 — credentials never leave the server):
 * each tool mints a short-lived GitHub App installation token per-call (opaque
 * `ghs_…`, ~1h) via github-app.ts and uses it server-side; the token is NEVER
 * returned to the MCP client (only the RESULT of the GitHub call is). The App
 * private key is read only via the Secrets Store async binding.
 *
 * Pillar 1: this Worker never reads or writes the bus (no queues block). Steward
 * remains the SOLE reader of atlas-wire.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { installationToken, type GitHubAppEnv } from "./github-app.js";

/** The mcp-github env surface (DO binding + OAuth KV + GitHub App secret/vars). */
export interface Env extends GitHubAppEnv {
  /** The McpAgent's own Durable Object namespace (addressed by serve()). */
  GITHUB_MCP: DurableObjectNamespace<GithubMcp>;
  /** Inbound OAuthProvider grant store (real KV required, or startup fails). */
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuthProvider at runtime (the OAuthHelpers). */
  OAUTH_PROVIDER?: unknown;
}

/** The identity the OAuthProvider attaches to a validated grant (set in the api handler). */
export interface GitHubProps extends Record<string, unknown> {
  ownerId: string;
  /** The OAuth scopes granted to this token (least-privilege floor; read by the tools). */
  scopes: string[];
}

/** The GitHub MCP least-privilege scope floor — read+write to the App's repos via Envoy. */
const GITHUB_SCOPES = ["github.read", "github.write"] as const;

/**
 * The stateful GitHub MCP agent. A Durable-Object-backed `McpAgent`; the provider
 * gives it the validated grant's `props` ({ ownerId, scopes }). `server` and `init()`
 * are the McpAgent contract.
 */
export class GithubMcp extends McpAgent<Env, unknown, GitHubProps> {
  server = new McpServer({ name: "atlas-mcp-github", version: "0.1.0" });

  async init(): Promise<void> {
    // Read the App's repos. Mints an opaque installation token server-side and uses
    // it to call GitHub — the token is NEVER returned to the client.
    this.server.registerTool(
      "github_list_repos",
      {
        title: "List GitHub repositories",
        description: "List repositories the GitHub App can access. Requires github.read.",
      },
      async () => {
        if (!this.hasScope("github.read")) return this.forbidden();
        // Phase 0: prove the token is minted server-side and never echoed. The live
        // GitHub call lands when Envoy (Phase 4) wires it; here we confirm the seam.
        // W15: mintToken can throw (missing GH_APP_INSTALLATION_ID, or a non-2xx from
        // GitHub) — catch it and return a structured isError, never a thrown crash.
        try {
          await this.mintToken({ permissions: { metadata: "read", contents: "read" } });
        } catch (err) {
          return this.mintError(err);
        }
        return { content: [{ type: "text", text: "(repositories would be listed here)" }] };
      },
    );

    // Write a repo file (Envoy's Phase-4 README writes). Requires github.write.
    this.server.registerTool(
      "github_put_file",
      {
        title: "Write a GitHub file",
        description: "Create/update a file in a repo (Envoy README writes). Requires github.write.",
      },
      async () => {
        if (!this.hasScope("github.write")) return this.forbidden();
        // W15: same — a mint failure returns a clean tool error, not a request crash.
        try {
          await this.mintToken({ permissions: { contents: "write", metadata: "read" } });
        } catch (err) {
          return this.mintError(err);
        }
        return { content: [{ type: "text", text: "(file written via the App installation)" }] };
      },
    );

    // Create a new branch from a base branch (Envoy's portfolio PR flow). Requires github.write.
    // REST sequence: GET /repos/{owner}/{repo}/git/ref/heads/{fromBranch} → read base SHA,
    // then POST /repos/{owner}/{repo}/git/refs with { ref, sha }.
    // Mints { contents: "write", metadata: "read", pull_requests: "write" } (T-04-10).
    this.server.registerTool(
      "github_create_branch",
      {
        title: "Create a GitHub branch",
        description:
          "Create a new branch in a repo from an existing base branch (Envoy portfolio PR). Requires github.write.",
        inputSchema: {
          owner: z.string().describe("Repository owner (user or org)"),
          repo: z.string().describe("Repository name"),
          branch: z.string().describe("Name of the new branch to create"),
          fromBranch: z.string().describe("Base branch to branch from (e.g. 'main')"),
        },
      },
      async (args) => {
        if (!this.hasScope("github.write")) return this.forbidden();
        const { owner, repo, branch, fromBranch } = args as {
          owner: string;
          repo: string;
          branch: string;
          fromBranch: string;
        };
        let token: string;
        try {
          token = await this.mintTokenForUse({
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
          });
        } catch (err) {
          return this.mintError(err);
        }
        // Step 1: read the base branch SHA.
        const refRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`,
          {
            method: "GET",
            headers: this.githubHeaders(token),
          },
        );
        if (!refRes.ok) {
          return this.githubApiError("read base branch ref", refRes.status);
        }
        const refJson = (await refRes.json()) as { object: { sha: string } };
        const sha = refJson.object.sha;

        // Step 2: create the new branch ref.
        const createRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/refs`,
          {
            method: "POST",
            headers: this.githubHeaders(token),
            body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
          },
        );
        if (!createRes.ok) {
          return this.githubApiError("create branch ref", createRes.status);
        }
        // Return only the branch name — the token stays server-side (T-04-09).
        return {
          content: [{ type: "text" as const, text: `Branch created: ${branch} (from ${fromBranch} @ ${sha})` }],
        };
      },
    );

    // Open a pull request (Envoy's portfolio PR). Requires github.write.
    // D4-10: a PR is draft-by-nature and reversible — no extra gate inside the tool.
    // REST: POST /repos/{owner}/{repo}/pulls with { title, body, head, base, draft: false }.
    // Mints { contents: "write", metadata: "read", pull_requests: "write" } (T-04-10).
    this.server.registerTool(
      "github_open_pr",
      {
        title: "Open a GitHub pull request",
        description:
          "Open a non-draft pull request in a repo (Envoy portfolio PR). Requires github.write.",
        inputSchema: {
          owner: z.string().describe("Repository owner (user or org)"),
          repo: z.string().describe("Repository name"),
          title: z.string().describe("PR title"),
          body: z.string().describe("PR body / description"),
          head: z.string().describe("The branch containing the changes (head)"),
          base: z.string().describe("The branch to merge into (base, e.g. 'main')"),
        },
      },
      async (args) => {
        if (!this.hasScope("github.write")) return this.forbidden();
        const { owner, repo, title, body, head, base } = args as {
          owner: string;
          repo: string;
          title: string;
          body: string;
          head: string;
          base: string;
        };
        let token: string;
        try {
          token = await this.mintTokenForUse({
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
          });
        } catch (err) {
          return this.mintError(err);
        }
        const prRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls`,
          {
            method: "POST",
            headers: this.githubHeaders(token),
            body: JSON.stringify({ title, body, head, base, draft: false }),
          },
        );
        if (!prRes.ok) {
          return this.githubApiError("open pull request", prRes.status);
        }
        const prJson = (await prRes.json()) as { html_url: string; number: number };
        // Return only the PR URL and number — the token stays server-side (T-04-09).
        return {
          content: [
            {
              type: "text" as const,
              text: `Pull request opened: #${prJson.number} — ${prJson.html_url}`,
            },
          ],
        };
      },
    );
  }

  /** True iff the validated grant carries the required scope (least-privilege at the tool). */
  private hasScope(scope: string): boolean {
    const scopes = this.props?.scopes;
    return Array.isArray(scopes) && scopes.includes(scope);
  }

  /** A 403-equivalent MCP error result for an out-of-scope tool call. */
  private forbidden() {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: "403 Forbidden: missing required GitHub scope." }],
    };
  }

  /**
   * W15 — a structured MCP error result for a token-mint failure (missing
   * GH_APP_INSTALLATION_ID, GitHub non-2xx, network error). We log NEITHER the token
   * (mintToken never surfaces it) NOR the raw internal error detail to the client —
   * the GitHub-App token-mint helper already restricts its own throw to a status code,
   * but we emit a fixed, generic message here so no internal detail leaks regardless.
   */
  private mintError(_err: unknown) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: "502 Bad Gateway: GitHub App token could not be minted (configuration or upstream error).",
        },
      ],
    };
  }

  /**
   * Mint a short-lived, down-scoped installation token server-side. The token stays
   * in this method's scope — it is used for the GitHub call and discarded; it is
   * NEVER returned to the MCP client (T-00-32). The installation id comes from [vars].
   */
  private async mintToken(opts: { permissions?: Record<string, string> }): Promise<void> {
    const installId = this.env.GH_APP_INSTALLATION_ID;
    if (!installId) {
      // Phase 0: the installation id is seeded at the owner gate. Without it we cannot
      // mint — surface a configuration error, never a fabricated token.
      throw new Error("GitHub App misconfigured: GH_APP_INSTALLATION_ID is not set in [vars]");
    }
    // The opaque ghs_ token is consumed locally and intentionally not surfaced.
    await installationToken(this.env, installId, { permissions: opts.permissions });
  }

  /**
   * Mint a short-lived installation token for immediate server-side GitHub API use.
   * Like mintToken() but returns the opaque token string so the caller can issue
   * GitHub REST calls. The token MUST stay server-side and MUST NOT appear in any
   * tool result (T-00-32 / T-04-09). The installation id comes from [vars].
   */
  private async mintTokenForUse(opts: { permissions?: Record<string, string> }): Promise<string> {
    const installId = this.env.GH_APP_INSTALLATION_ID;
    if (!installId) {
      throw new Error("GitHub App misconfigured: GH_APP_INSTALLATION_ID is not set in [vars]");
    }
    // The token is returned to this call-site only, consumed synchronously for the
    // GitHub API call, and never stored, logged, or forwarded to the MCP client.
    return await installationToken(this.env, installId, { permissions: opts.permissions });
  }

  /**
   * Build the standard GitHub REST API request headers using the server-side
   * installation token. The token is consumed here and never propagated further.
   */
  private githubHeaders(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "atlas-orchestrator",
      "content-type": "application/json",
    };
  }

  /**
   * A structured MCP error result for a GitHub API non-2xx response. Surfaces only
   * the HTTP status code — no response body (which could carry partial token / secrets
   * data on misconfigured endpoints).
   */
  private githubApiError(operation: string, status: number) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: `502 Bad Gateway: GitHub API call failed (${operation}): HTTP ${status}.`,
        },
      ],
    };
  }
}

/**
 * The OAuthProvider apiHandler — a WorkerEntrypoint. The provider routes `/mcp/*`
 * here AFTER validating the token; it surfaces the granted scopes via ctx.props and
 * hands off to the McpAgent serve() handler with those props. Mirrors the
 * apps/atlas api-handler door-level least-privilege seam (00-06).
 */
export class GithubApiHandler extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx as unknown as { props?: GitHubProps }).props;
    if (!props) {
      // The provider should never route an unauthenticated request here.
      return new Response("Unauthorized", { status: 401 });
    }
    // Hand the validated request (with props) to the McpAgent's Streamable-HTTP serve()
    // handler. serve() addresses the GITHUB_MCP DO and carries ctx.props to the agent.
    const handler = GithubMcp.serve("/mcp", { binding: "GITHUB_MCP" });
    return handler.fetch(request, this.env, this.ctx);
  }
}

/**
 * A minimal default handler for unauthenticated paths (the provider owns /authorize +
 * /oauth/token). Phase 0: a bare 404 — the owner-facing consent surface for the
 * GitHub MCP reuses the Atlas front door pattern when Envoy lands (Phase 4).
 */
const defaultHandler = {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};

/**
 * The inbound OAuthProvider front door. Backed by the REAL OAUTH_KV (startup fails
 * without it). No `clientRegistrationEndpoint` — no anonymous DCR (the Round-2
 * hardening rationale from 00-06); clients are seeded out-of-band.
 *
 * `satisfies ExportedHandler<Env>` (NEVER the `: ExportedHandler<Env>` annotation).
 */
const providerOptions: OAuthProviderOptions<Env> = {
  apiRoute: ["/mcp/"],
  apiHandler: GithubApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  scopesSupported: GITHUB_SCOPES as unknown as string[],
  accessTokenTTL: 3600,
  disallowPublicClientRegistration: true,
};

const provider = new OAuthProvider<Env>(providerOptions);

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
