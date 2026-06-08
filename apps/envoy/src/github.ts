/**
 * apps/envoy/src/github.ts
 *
 * GitHub publishing via mcp-github service binding (04-02).
 * Two operations:
 *   1. commitReadme()  — commit the README section to the owner's profile repo
 *                        via github_put_file (agent completes — D4-10)
 *   2. openPortfolioPR() — create branch "add-project/<slug>" → put file → open PR
 *                          via github_create_branch + github_put_file + github_open_pr
 *
 * Token containment (T-04-40 / T-00-32): the GitHub App token is minted server-side
 * inside mcp-github and NEVER returned to Envoy. Envoy receives only the operation result.
 *
 * Pillar 2: both operations create reversible artifacts (README commit / draft-by-nature PR).
 * No auto-merge, no auto-close, no delete. Agent completes — owner can push back at will.
 */

// ─── MCP_GITHUB tool result types ────────────────────────────────────────────

/** Minimal success shape returned by github_put_file. */
export interface PutFileResult {
  success: boolean;
  sha?: string;
  message?: string;
}

/** Minimal success shape returned by github_create_branch. */
export interface CreateBranchResult {
  success: boolean;
  branch?: string;
  sha?: string;
  message?: string;
}

/** Minimal success shape returned by github_open_pr. */
export interface OpenPrResult {
  success: boolean;
  pr_url?: string;
  pr_number?: number;
  message?: string;
}

// ─── MCP_GITHUB binding interface ────────────────────────────────────────────

/** The mcp-github service binding surface Envoy calls (04-02 tools). */
export interface McpGitHubBinding {
  /** Commit/update a file in a repo. Requires github.write scope. */
  github_put_file(params: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    branch?: string;
    sha?: string;
  }): Promise<PutFileResult>;

  /** Create a new branch from a base branch. Requires github.write scope. */
  github_create_branch(params: {
    owner: string;
    repo: string;
    branch: string;
    from_branch?: string;
  }): Promise<CreateBranchResult>;

  /** Open a non-draft PR. Requires github.write scope. */
  github_open_pr(params: {
    owner: string;
    repo: string;
    title: string;
    body?: string;
    head: string;
    base: string;
  }): Promise<OpenPrResult>;
}

// ─── GitHubPublishResult ─────────────────────────────────────────────────────

/** Result of a GitHub publish operation. */
export interface GitHubPublishResult {
  /** Whether the operation succeeded. */
  ok: boolean;
  /** Human-readable detail for auditing / P-flag body. */
  detail: string;
  /** For PRs: the URL of the opened PR. */
  prUrl?: string;
}

// ─── commitReadme ─────────────────────────────────────────────────────────────

/**
 * Commit the README section to the owner's GitHub profile repo.
 * Calls mcp-github.github_put_file — the App token is minted server-side, never leaked.
 * On a 4xx / non-success → returns { ok: false } (caller reports P3 for that target).
 */
export async function commitReadme(
  mcpGitHub: McpGitHubBinding,
  params: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    branch?: string;
    sha?: string;
  },
): Promise<GitHubPublishResult> {
  try {
    const result = await mcpGitHub.github_put_file(params);
    if (!result.success) {
      return {
        ok: false,
        detail: `github_put_file returned success=false: ${result.message ?? "unknown error"}`,
      };
    }
    return { ok: true, detail: `README committed (sha=${result.sha ?? "unknown"})` };
  } catch (err) {
    const status = extractStatus(err);
    return {
      ok: false,
      detail: `github_put_file threw: HTTP ${status} — ${safeMessage(err)}`,
    };
  }
}

// ─── openPortfolioPR ─────────────────────────────────────────────────────────

/**
 * Create a portfolio PR via the three-step REST flow (04-02 / RESEARCH.md Pattern 5):
 *   1. github_create_branch("add-project/<slug>") from base branch
 *   2. github_put_file — put the portfolio entry on the new branch
 *   3. github_open_pr — open PR from "add-project/<slug>" → base
 *
 * On a conflict (branch already exists) or any 4xx → returns { ok: false } (caller P3).
 * Token contained in mcp-github (T-04-40).
 */
export async function openPortfolioPR(
  mcpGitHub: McpGitHubBinding,
  params: {
    owner: string;
    repo: string;
    slug: string;
    filePath: string;
    fileContent: string;
    prTitle: string;
    prBody: string;
    baseBranch: string;
  },
): Promise<GitHubPublishResult> {
  const branchName = `add-project/${params.slug}`;

  // Step 1: create the branch
  try {
    const branchResult = await mcpGitHub.github_create_branch({
      owner: params.owner,
      repo: params.repo,
      branch: branchName,
      from_branch: params.baseBranch,
    });
    if (!branchResult.success) {
      return {
        ok: false,
        detail: `github_create_branch failed: ${branchResult.message ?? "unknown error"}`,
      };
    }
  } catch (err) {
    const status = extractStatus(err);
    // 4xx on branch create = conflict or auth; either way this target fails
    return {
      ok: false,
      detail: `github_create_branch threw: HTTP ${status} — ${safeMessage(err)}`,
    };
  }

  // Step 2: put the portfolio file on the new branch
  try {
    const putResult = await mcpGitHub.github_put_file({
      owner: params.owner,
      repo: params.repo,
      path: params.filePath,
      content: params.fileContent,
      message: `Add ${params.slug} to portfolio`,
      branch: branchName,
    });
    if (!putResult.success) {
      return {
        ok: false,
        detail: `github_put_file (on branch) failed: ${putResult.message ?? "unknown error"}`,
      };
    }
  } catch (err) {
    const status = extractStatus(err);
    return {
      ok: false,
      detail: `github_put_file (on branch) threw: HTTP ${status} — ${safeMessage(err)}`,
    };
  }

  // Step 3: open the PR
  try {
    const prResult = await mcpGitHub.github_open_pr({
      owner: params.owner,
      repo: params.repo,
      title: params.prTitle,
      body: params.prBody,
      head: branchName,
      base: params.baseBranch,
    });
    if (!prResult.success) {
      return {
        ok: false,
        detail: `github_open_pr failed: ${prResult.message ?? "unknown error"}`,
      };
    }
    return {
      ok: true,
      detail: `Portfolio PR opened: ${prResult.pr_url ?? "unknown url"} (#${prResult.pr_number ?? "?"})`,
      prUrl: prResult.pr_url,
    };
  } catch (err) {
    const status = extractStatus(err);
    return {
      ok: false,
      detail: `github_open_pr threw: HTTP ${status} — ${safeMessage(err)}`,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract numeric HTTP status from an error object (surface only the status, not the body). */
function extractStatus(err: unknown): number | string {
  if (err && typeof err === "object" && "status" in err) {
    return (err as { status: number }).status;
  }
  return "unknown";
}

/** Safe single-line message (no response body — T-04-40 token containment). */
function safeMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? "error";
  return String(err).split("\n")[0] ?? "error";
}
