import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GithubMcp, type GitHubProps, type Env } from "../src/index.js";

// W15 — a mintToken() throw inside a github_* tool must return a STRUCTURED isError
// result, not crash the MCP request. Before the fix, the tool body called
// `await this.mintToken(...)` with no try/catch, so a missing GH_APP_INSTALLATION_ID
// (or a GitHub non-2xx) threw straight out of the tool handler → the request crashed.
//
// We drive the REAL registered tool: build a GithubMcp instance (over the prototype so
// no DurableObject state is needed), set its server/props/env, run init() to register
// the production tool handlers, then call the tool over a linked in-memory transport.
// The token is never surfaced (mintToken returns void) and the error message is a
// fixed generic string — no internal detail leaks.

/** Build a GithubMcp whose private mintToken throws, with the given props/env. */
async function connectAgent(opts: {
  props: GitHubProps;
  env: Partial<Env>;
  mintThrows?: Error;
}): Promise<Client> {
  const server = new McpServer({ name: "test-github", version: "0.0.0" });
  // Construct over the prototype: init() only touches this.server/props/env + the
  // private hasScope/mintToken/mintError — no DO storage is exercised here. We cast
  // through `unknown` to a plain mutable shape because `mintToken` is private on the
  // class (an intersection with GithubMcp collapses to `never`).
  const agent = Object.create(GithubMcp.prototype) as unknown as {
    server: McpServer;
    props: GitHubProps;
    env: Partial<Env>;
    mintToken: (o: unknown) => Promise<void>;
    init: () => Promise<void>;
  };
  agent.server = server;
  agent.props = opts.props;
  agent.env = opts.env;
  if (opts.mintThrows) {
    // Simulate a mint failure (e.g. a GitHub non-2xx) deterministically.
    const thrown = opts.mintThrows;
    agent.mintToken = async () => {
      throw thrown;
    };
  }

  await agent.init();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

const READ_PROPS: GitHubProps = { ownerId: "owner", scopes: ["github.read", "github.write"] };

describe("W15 — mintToken failure returns isError, not a crash", () => {
  it("missing GH_APP_INSTALLATION_ID → github_list_repos returns isError (no crash)", async () => {
    // Real mintToken path: env has NO installation id, so mintToken throws.
    const client = await connectAgent({ props: READ_PROPS, env: {} });

    const res = (await client.callTool({ name: "github_list_repos", arguments: {} })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };

    expect(res.isError).toBe(true);
    // A clean, generic error — never the underlying config detail or a real token.
    // (The generic message legitimately contains the word "token"; we assert the
    // sensitive specifics never leak: the env-var name and the ghs_ token prefix.)
    expect(res.content[0]!.text).toMatch(/could not be minted/i);
    expect(JSON.stringify(res)).not.toMatch(/GH_APP_INSTALLATION_ID|ghs_/i);
  });

  it("a GitHub non-2xx (mint throw) → github_put_file returns isError (no crash)", async () => {
    const client = await connectAgent({
      props: READ_PROPS,
      env: { GH_APP_INSTALLATION_ID: "12345" },
      mintThrows: new Error("GitHub installation token mint failed: 403"),
    });

    const res = (await client.callTool({ name: "github_put_file", arguments: {} })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/could not be minted/i);
    // The upstream status / internal detail does NOT leak to the client.
    expect(JSON.stringify(res)).not.toMatch(/403|ghs_/);
  });

  it("an out-of-scope call still returns the 403 isError (regression guard)", async () => {
    const client = await connectAgent({
      props: { ownerId: "owner", scopes: [] },
      env: { GH_APP_INSTALLATION_ID: "12345" },
    });
    const res = (await client.callTool({ name: "github_list_repos", arguments: {} })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/403 Forbidden/);
  });
});
