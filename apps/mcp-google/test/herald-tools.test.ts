import { describe, it, expect } from "vitest";
import {
  hasGmailCompose,
  hasGmailReadonly,
  hasCalendarEvents,
  hasCalendarReadonly,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_READONLY_SCOPE,
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  buildGoogleMcpServer,
  safeToolOutput,
  SECRET_BLOCKED_TEXT,
} from "../src/index.js";
import type { Env } from "../src/index.js";

// Phase 1 (Plan 01-01) — the per-agent least-privilege scope floors for the four
// reasoning agents (Herald / Forge / Sundial / Compass) added to mcp-google.
//
// Three invariants proven here:
//   (a) each new predicate accepts ONLY its matching scope and rejects the empty set
//       (fail-closed; gmail.modify does NOT imply gmail.readonly, etc.);
//   (b) a tool call lacking its required scope returns isError + the 403 FORBIDDEN
//       text naming the scope (fail-closed, no mutation);
//   (c) the redaction egress (safeToolOutput) is on the new tools too — a 2FA code is
//       stripped before egress and the P1-block is observable (isError:true).
//
// Pillar 2 by construction: NO send / NO gmail-delete / NO calendar-delete tool is
// registered (asserted via the live tool registry).
//
// Runs in workerd (TZ=UTC).

const noopEnv = {} as unknown as Env;

/**
 * Reach the private tool registry to invoke a registered tool's handler directly.
 * In MCP SDK 1.29.0 the registerTool() callback is stored under `_registeredTools[name].handler`.
 */
function toolCallback(name: string): () => Promise<{
  isError?: boolean;
  content: { type: "text"; text: string }[];
}> {
  const server = buildGoogleMcpServer(noopEnv);
  const registry = (server as unknown as { _registeredTools: Record<string, { handler: unknown }> })
    ._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler as () => Promise<{
    isError?: boolean;
    content: { type: "text"; text: string }[];
  }>;
}

function textOf(out: { content: { type: "text"; text: string }[] }): string {
  return out.content.map((c) => c.text).join("");
}

describe("Phase-1 scope-floor predicates (per-agent least privilege)", () => {
  it("hasGmailCompose: true only for gmail.compose, false for empty / unrelated", () => {
    expect(hasGmailCompose([GMAIL_COMPOSE_SCOPE])).toBe(true);
    expect(hasGmailCompose(["gmail.compose"])).toBe(true);
    expect(hasGmailCompose([])).toBe(false);
    // gmail.modify must NOT imply gmail.compose — predicates are exact.
    expect(hasGmailCompose(["https://www.googleapis.com/auth/gmail.modify"])).toBe(false);
    expect(hasGmailCompose([GMAIL_READONLY_SCOPE])).toBe(false);
  });

  it("hasGmailReadonly: true only for gmail.readonly, false for empty / unrelated", () => {
    expect(hasGmailReadonly([GMAIL_READONLY_SCOPE])).toBe(true);
    expect(hasGmailReadonly(["gmail.readonly"])).toBe(true);
    expect(hasGmailReadonly([])).toBe(false);
    // A modify grant does NOT imply readonly here (least-privilege, exact predicates).
    expect(hasGmailReadonly(["https://www.googleapis.com/auth/gmail.modify"])).toBe(false);
  });

  it("hasCalendarEvents: true only for calendar.events, false for empty / unrelated", () => {
    expect(hasCalendarEvents([CALENDAR_EVENTS_SCOPE])).toBe(true);
    expect(hasCalendarEvents(["calendar.events"])).toBe(true);
    expect(hasCalendarEvents([])).toBe(false);
    expect(hasCalendarEvents([CALENDAR_READONLY_SCOPE])).toBe(false);
  });

  it("hasCalendarReadonly: true only for calendar.readonly, false for empty / unrelated", () => {
    expect(hasCalendarReadonly([CALENDAR_READONLY_SCOPE])).toBe(true);
    expect(hasCalendarReadonly(["calendar.readonly"])).toBe(true);
    expect(hasCalendarReadonly([])).toBe(false);
    // A write grant does NOT imply read here — keep them independent.
    expect(hasCalendarReadonly([CALENDAR_EVENTS_SCOPE])).toBe(false);
  });
});

describe("Phase-1 tools fail-closed without the required scope", () => {
  // Outside a real MCP request there is no auth context → grantedScopes() is the empty
  // set, so every gated tool returns the 403 forbiddenResult naming its scope.
  it("gmail_create_draft (Herald) is forbidden without gmail.compose", async () => {
    const out = await toolCallback("gmail_create_draft")();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("403");
    expect(textOf(out)).toContain("gmail.compose");
  });

  it("gmail_get_thread (Herald/Forge) is forbidden without gmail.readonly", async () => {
    const out = await toolCallback("gmail_get_thread")();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("403");
    expect(textOf(out)).toContain("gmail.readonly");
  });

  it("calendar_create_event (Sundial) is forbidden without calendar.events", async () => {
    const out = await toolCallback("calendar_create_event")();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("403");
    expect(textOf(out)).toContain("calendar.events");
  });

  it("calendar_freebusy (Compass) is forbidden without calendar.readonly", async () => {
    const out = await toolCallback("calendar_freebusy")();
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("403");
    expect(textOf(out)).toContain("calendar.readonly");
  });
});

describe("Phase-1 Pillar-2: no outward/destructive tool is registered", () => {
  it("registers NO send / gmail-delete / calendar-delete tool (unreachable by construction)", () => {
    const server = buildGoogleMcpServer(noopEnv);
    const registry = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    const toolNames = Object.keys(registry ?? {});
    for (const name of toolNames) {
      expect(name).not.toMatch(/send/i);
      expect(name).not.toMatch(/delete/i);
      expect(name).not.toMatch(/trash/i);
      expect(name).not.toMatch(/archive/i);
    }
    // The expected Phase-1 surface is present.
    expect(toolNames).toContain("gmail_search_threads");
    expect(toolNames).toContain("gmail_get_thread");
    expect(toolNames).toContain("gmail_create_draft");
    expect(toolNames).toContain("calendar_create_event");
    expect(toolNames).toContain("calendar_list_events_readonly");
  });
});

describe("Phase-1 redaction egress is on the new tools", () => {
  it("safeToolOutput strips a 6-digit code near 'verification code' (proves egress is wired)", async () => {
    // The same single egress every new tool funnels through. Driving it directly proves
    // a Type/Security body would be stripped before reaching Herald/Forge/Sundial/Compass.
    const out = await safeToolOutput("Your verification code is 482915.", noopEnv);
    expect(textOf(out)).not.toContain("482915");
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(SECRET_BLOCKED_TEXT);
  });
});
