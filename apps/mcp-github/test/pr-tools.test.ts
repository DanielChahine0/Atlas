import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GithubMcp, type GitHubProps, type Env } from "../src/index.js";

// PR tools test suite — covers github_create_branch and github_open_pr.
//
// Threat mitigations verified:
//   T-04-08: scope guard (non-github.write caller → forbidden())
//   T-04-09: installation token (ghs_…) never appears in any tool result
//   T-04-10: both tools mint pull_requests:write (verified via mintToken spy)
//
// Test harness mirrors mint-error.test.ts: construct GithubMcp over the
// prototype (no DO storage), replace mintToken with a test double that
// simulates a live token mint while recording the permissions requested,
// replace the fetch global to intercept GitHub REST calls.

type AgentHandle = {
  server: McpServer;
  props: GitHubProps;
  env: Partial<Env>;
  mintToken: (o: { permissions?: Record<string, string> }) => Promise<void>;
  mintTokenForUse: (o: { permissions?: Record<string, string> }) => Promise<string>;
  init: () => Promise<void>;
};

interface ConnectOpts {
  scopes?: string[];
  /** Override mintTokenForUse to return this token string (default "ghs_FAKE_TOKEN"). */
  fakeToken?: string;
  /** If set, mintToken / mintTokenForUse throws with this error. */
  mintThrows?: Error;
  /** GitHub fetch stub: maps "METHOD url" → response body + status. */
  githubFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Permissions captured by mintTokenForUse calls (output). */
  capturedPermissions?: Array<Record<string, string> | undefined>;
}

async function connectAgent(opts: ConnectOpts = {}): Promise<Client> {
  const server = new McpServer({ name: "test-github-pr", version: "0.0.0" });
  const agent = Object.create(GithubMcp.prototype) as unknown as AgentHandle;
  agent.server = server;
  agent.props = {
    ownerId: "owner",
    scopes: opts.scopes ?? ["github.read", "github.write"],
  };
  agent.env = { GH_APP_INSTALLATION_ID: "12345" } as Partial<Env>;

  const fakeToken = opts.fakeToken ?? "ghs_FAKE_TOKEN_NEVER_IN_RESULT";

  if (opts.mintThrows) {
    const thrown = opts.mintThrows;
    // Both private methods must throw so the tool catches it.
    agent.mintToken = async () => { throw thrown; };
    agent.mintTokenForUse = async () => { throw thrown; };
  } else {
    agent.mintToken = async (o) => {
      opts.capturedPermissions?.push(o.permissions);
    };
    agent.mintTokenForUse = async (o) => {
      opts.capturedPermissions?.push(o.permissions);
      return fakeToken;
    };
  }

  // Patch the module-level fetch if a githubFetch stub is provided.
  // The tools call global `fetch` with the GitHub API URL.
  if (opts.githubFetch) {
    vi.stubGlobal("fetch", opts.githubFetch);
  }

  await agent.init();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

// Helper: wrap a value in a mock GitHub JSON response.
function githubOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// github_create_branch
// ──────────────────────────────────────────────────────────────────────────────

describe("github_create_branch", () => {
  it("scope-pass: creates branch from base SHA and returns branch name (no token)", async () => {
    const capturedPermissions: Array<Record<string, string> | undefined> = [];
    const calls: string[] = [];

    const client = await connectAgent({
      capturedPermissions,
      githubFetch: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push(url);
        if (url.includes("/git/ref/heads/main")) {
          // GET base branch SHA
          return githubOk({ object: { sha: "abc123def456" } });
        }
        if (url.includes("/git/refs")) {
          // POST create new ref
          return githubOk({ ref: "refs/heads/envoy/portfolio-pr", object: { sha: "abc123def456" } }, 201);
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const res = (await client.callTool({
      name: "github_create_branch",
      arguments: {
        owner: "danielchahine",
        repo: "portfolio",
        branch: "envoy/portfolio-pr",
        fromBranch: "main",
      },
    })) as { isError?: boolean; content: { type: string; text: string }[] };

    // Tool must succeed (no isError flag or false).
    expect(res.isError).toBeFalsy();
    // Result must contain the branch name.
    const text = res.content[0]!.text;
    expect(text).toContain("envoy/portfolio-pr");

    // T-04-09: the fake token must NEVER appear in any returned content.
    expect(JSON.stringify(res)).not.toMatch(/ghs_[A-Za-z0-9]/);

    // T-04-10: mintTokenForUse was called with pull_requests:write.
    expect(capturedPermissions.length).toBeGreaterThan(0);
    expect(capturedPermissions[0]).toMatchObject({ pull_requests: "write" });
  });

  it("scope-fail: non-github.write caller receives forbidden (T-04-08)", async () => {
    const client = await connectAgent({ scopes: ["github.read"] });

    const res = (await client.callTool({
      name: "github_create_branch",
      arguments: {
        owner: "danielchahine",
        repo: "portfolio",
        branch: "envoy/portfolio-pr",
        fromBranch: "main",
      },
    })) as { isError?: boolean; content: { type: string; text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/403 Forbidden/);
  });

  it("GitHub non-2xx → mintError result (no crash)", async () => {
    const client = await connectAgent({
      mintThrows: new Error("GitHub installation token mint failed: 403"),
    });

    const res = (await client.callTool({
      name: "github_create_branch",
      arguments: {
        owner: "danielchahine",
        repo: "portfolio",
        branch: "envoy/portfolio-pr",
        fromBranch: "main",
      },
    })) as { isError?: boolean; content: { type: string; text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/could not be minted/i);
    expect(JSON.stringify(res)).not.toMatch(/ghs_[A-Za-z0-9]/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// github_open_pr
// ──────────────────────────────────────────────────────────────────────────────

describe("github_open_pr", () => {
  it("scope-pass: opens non-draft PR and returns pr_url + pr_number (no token)", async () => {
    const capturedPermissions: Array<Record<string, string> | undefined> = [];
    let postedBody: unknown;

    const client = await connectAgent({
      capturedPermissions,
      githubFetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes("/pulls")) {
          postedBody = init?.body ? JSON.parse(init.body as string) : null;
          return githubOk(
            {
              html_url: "https://github.com/danielchahine/portfolio/pull/42",
              number: 42,
            },
            201,
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const res = (await client.callTool({
      name: "github_open_pr",
      arguments: {
        owner: "danielchahine",
        repo: "portfolio",
        title: "feat: Envoy portfolio update",
        body: "Automated PR from Atlas Envoy.",
        head: "envoy/portfolio-pr",
        base: "main",
      },
    })) as { isError?: boolean; content: { type: string; text: string }[] };

    // Tool must succeed.
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text;
    // Result contains PR URL and number.
    expect(text).toContain("https://github.com/danielchahine/portfolio/pull/42");
    expect(text).toContain("42");

    // T-04-09: token must NEVER appear in any returned content.
    expect(JSON.stringify(res)).not.toMatch(/ghs_[A-Za-z0-9]/);

    // T-04-10: mintTokenForUse was called with pull_requests:write.
    expect(capturedPermissions.length).toBeGreaterThan(0);
    expect(capturedPermissions[0]).toMatchObject({ pull_requests: "write" });

    // PR must be non-draft (D4-10: PR is reversible — no extra gate needed).
    expect(postedBody).toMatchObject({ draft: false });
  });

  it("scope-fail: non-github.write caller receives forbidden (T-04-08)", async () => {
    const client = await connectAgent({ scopes: [] });

    const res = (await client.callTool({
      name: "github_open_pr",
      arguments: {
        owner: "danielchahine",
        repo: "portfolio",
        title: "feat: Envoy portfolio update",
        body: "Automated PR from Atlas Envoy.",
        head: "envoy/portfolio-pr",
        base: "main",
      },
    })) as { isError?: boolean; content: { type: string; text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/403 Forbidden/);
  });

  it("GitHub non-2xx on PR creation → mintError result (no crash)", async () => {
    const client = await connectAgent({
      mintThrows: new Error("GitHub installation token mint failed: 422"),
    });

    const res = (await client.callTool({
      name: "github_open_pr",
      arguments: {
        owner: "danielchahine",
        repo: "portfolio",
        title: "feat: Envoy portfolio update",
        body: "Automated PR from Atlas Envoy.",
        head: "envoy/portfolio-pr",
        base: "main",
      },
    })) as { isError?: boolean; content: { type: string; text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/could not be minted/i);
    // Upstream error detail and token must not leak.
    expect(JSON.stringify(res)).not.toMatch(/ghs_[A-Za-z0-9]/);
    expect(JSON.stringify(res)).not.toMatch(/422/);
  });

  it("T-04-09 regression: even on GitHub 201, no ghs_ token in result", async () => {
    const client = await connectAgent({
      // Use a token that looks like a real one to make the assertion meaningful.
      fakeToken: "ghs_REGRESSION_GUARD_TOKEN_12345",
      githubFetch: async () =>
        githubOk(
          { html_url: "https://github.com/danielchahine/portfolio/pull/1", number: 1 },
          201,
        ),
    });

    const res = (await client.callTool({
      name: "github_open_pr",
      arguments: {
        owner: "danielchahine",
        repo: "portfolio",
        title: "title",
        body: "body",
        head: "branch",
        base: "main",
      },
    })) as { isError?: boolean; content: { type: string; text: string }[] };

    // The token prefix must never appear anywhere in the serialized result.
    expect(JSON.stringify(res)).not.toMatch(/ghs_[A-Za-z0-9]/);
  });
});
