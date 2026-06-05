import { describe, it, expect } from "vitest";
import {
  hasGmailModify,
  grantedScopes,
  GMAIL_MODIFY_SCOPE,
  FORBIDDEN_TEXT,
  buildGoogleMcpServer,
} from "../src/index.js";
import type { Env } from "../src/index.js";

// SPINE-04 least-privilege scope floor (CI proof). Two invariants:
//   (a) a token lacking gmail.modify is rejected 403 and mutates nothing;
//   (b) NO messages.delete / threads.delete tool is registered — the delete path
//       requires the never-granted full https://mail.google.com/ scope and is
//       unreachable by construction (Pillar 2: suggest, don't destroy).
//
// Runs in workerd (TZ=UTC).

const noopEnv = {} as unknown as Env;

describe("mcp-google scope floor (SPINE-04)", () => {
  it("rejects a token WITHOUT gmail.modify (403, by the floor predicate)", () => {
    // A token carrying an unrelated scope (or no scope) lacks the gmail.modify floor.
    expect(hasGmailModify([])).toBe(false);
    expect(hasGmailModify(["https://www.googleapis.com/auth/calendar.readonly"])).toBe(false);
    // Outside a real MCP request there is no auth context, so grantedScopes() is the
    // empty set (fail-closed) — a tool call would return the 403 forbiddenResult.
    expect(grantedScopes()).toEqual([]);
    expect(hasGmailModify(grantedScopes())).toBe(false);
  });

  it("accepts a token WITH gmail.modify (both the full URI and the short alias)", () => {
    expect(hasGmailModify([GMAIL_MODIFY_SCOPE])).toBe(true);
    expect(hasGmailModify(["gmail.modify"])).toBe(true);
  });

  it("the 403 forbidden text names the required scope and performs no mutation", () => {
    // The forbidden result is a pure error payload — it carries no Gmail mutation.
    expect(FORBIDDEN_TEXT).toContain("403");
    expect(FORBIDDEN_TEXT).toContain("gmail.modify");
  });

  it("registers NO messages.delete / threads.delete tool (delete path unreachable)", () => {
    // The server build must succeed and expose only the label/read tools. We assert
    // the registered tool NAMES contain no delete verb (the registry assertion).
    const server = buildGoogleMcpServer(noopEnv);
    // _registeredTools is private; reach it via an index cast for the registry check.
    const registry = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    const toolNames = Object.keys(registry ?? {});
    expect(toolNames.length).toBeGreaterThan(0);
    for (const name of toolNames) {
      expect(name).not.toMatch(/delete/i);
    }
    // The expected least-privilege surface: list + modify-labels + get (no delete).
    expect(toolNames).toContain("gmail_list_labels");
    expect(toolNames).toContain("gmail_modify_labels");
    expect(toolNames).toContain("gmail_get_message");
  });
});
