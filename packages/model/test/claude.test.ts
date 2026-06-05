import { describe, it, expect, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { claudeFor, modelFor, gatewayBaseURL } from "../src/index.js";

const VALID_IDS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"] as const;

/**
 * A stub Env exposing the model/AI-Gateway surface. `kv` seeds KV `model:<codename>`
 * overrides; `vars` seeds [vars] MODEL_<CODENAME> defaults. WIRE is a vi.fn() so we can
 * assert exactly one canonical Flagger event is emitted on the error path.
 */
function makeEnv(
  opts: { kv?: Record<string, string>; vars?: Record<string, string> } = {},
) {
  const kv = opts.kv ?? {};
  const send = vi.fn().mockResolvedValue(undefined);
  return {
    env: {
      WIRE: { send },
      CONFIG: { get: vi.fn(async (k: string) => kv[k] ?? null) },
      ANTHROPIC_API_KEY: { get: vi.fn(async () => "sk-ant-fake") },
      CF_AIG_TOKEN: { get: vi.fn(async () => "cf-aig-fake") },
      AIG_ACCOUNT_ID: "acct-123",
      AIG_GATEWAY_ID: "atlas-reasoning",
      ...(opts.vars ?? {}),
    } as never,
    send,
  };
}

describe("modelFor — tiering is config-driven, not hardcoded", () => {
  it("resolves the CLAUDE.md tiering map: compass→opus, forge→sonnet, filer→haiku", async () => {
    const { env } = makeEnv();
    expect(await modelFor("compass", env)).toBe("claude-opus-4-8");
    expect(await modelFor("forge", env)).toBe("claude-sonnet-4-6");
    expect(await modelFor("filer", env)).toBe("claude-haiku-4-5");
  });

  it("prefers a [vars] MODEL_<CODENAME> default over the map", async () => {
    const { env } = makeEnv({ vars: { MODEL_FILER: "claude-sonnet-4-6" } });
    expect(await modelFor("filer", env)).toBe("claude-sonnet-4-6");
  });

  it("a KV model:<codename> override re-tiers an agent WITHOUT a code change (D-05)", async () => {
    const { env } = makeEnv({
      kv: { "model:filer": "claude-sonnet-4-6" },
      vars: { MODEL_FILER: "claude-haiku-4-5" }, // override beats the [vars] default
    });
    expect(await modelFor("filer", env)).toBe("claude-sonnet-4-6");
  });

  it("is case-insensitive on the codename (Wire agent field is the codename)", async () => {
    const { env } = makeEnv();
    expect(await modelFor("Compass", env)).toBe("claude-opus-4-8");
    expect(await modelFor("FILER", env)).toBe("claude-haiku-4-5");
  });

  it("returns only valid 4.x ids — never a retired dated id", async () => {
    const { env } = makeEnv();
    for (const agent of ["atlas", "compass", "archivist", "forge", "herald", "scout", "headhunter", "filer"]) {
      const id = await modelFor(agent, env);
      expect(VALID_IDS).toContain(id as (typeof VALID_IDS)[number]);
      expect(id).not.toMatch(/-4-\d{8}$/); // no claude-*-4-YYYYMMDD retired form
    }
  });
});

describe("modelFor — rejects a misconfigured id and falls back to the tier default (W18)", () => {
  it("rejects a RETIRED dated KV override → falls back to the tier id (not returned verbatim)", async () => {
    const { env, send } = makeEnv({ kv: { "model:filer": "claude-haiku-4-20250514" } });
    const id = await modelFor("filer", env);
    expect(id).toBe("claude-haiku-4-5"); // the allowlisted tier-map default, NOT the bad id
    expect(id).not.toBe("claude-haiku-4-20250514");
    // Best-effort P3 flag for the misconfig.
    expect(send).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0]![0] as Record<string, unknown>;
    expect((event.payload as Record<string, unknown>).severity).toBe("P3");
  });

  it("rejects a GARBAGE / unknown-family KV override → falls back", async () => {
    const { env } = makeEnv({ kv: { "model:compass": "gpt-4o" } });
    expect(await modelFor("compass", env)).toBe("claude-opus-4-8");
  });

  it("rejects a misconfigured [vars] MODEL_<CODENAME> default → falls back", async () => {
    const { env } = makeEnv({ vars: { MODEL_FORGE: "claude-sonnet-4-20250101" } });
    expect(await modelFor("forge", env)).toBe("claude-sonnet-4-6");
  });

  it("an unknown agent with a garbage override falls back to the Sonnet default", async () => {
    const { env } = makeEnv({ kv: { "model:nobody": "not-a-model" } });
    expect(await modelFor("nobody", env)).toBe("claude-sonnet-4-6");
  });
});

describe("claudeFor — fails fast on an unprovisioned AI Gateway (I30)", () => {
  it("throws a clear construction-time error when AIG_GATEWAY_ID is empty (not a silent malformed URL)", async () => {
    const { env } = makeEnv({ vars: { AIG_GATEWAY_ID: "" } });
    await expect(claudeFor("filer", env)).rejects.toThrow(/AIG_ACCOUNT_ID and AIG_GATEWAY_ID/);
  });

  it("throws when AIG_ACCOUNT_ID is empty", async () => {
    const { env } = makeEnv({ vars: { AIG_ACCOUNT_ID: "" } });
    await expect(claudeFor("filer", env)).rejects.toThrow(/not provisioned/);
  });
});

describe("claudeFor — routes through the AI Gateway, never api.anthropic.com", () => {
  it("builds a client whose baseURL is the gateway Anthropic endpoint (not the direct host)", async () => {
    const { env } = makeEnv();
    const c = await claudeFor("filer", env);
    const expected = gatewayBaseURL("acct-123", "atlas-reasoning");
    expect(expected).toBe("https://gateway.ai.cloudflare.com/v1/acct-123/atlas-reasoning/anthropic");
    expect(c.client.baseURL).toContain("/acct-123/atlas-reasoning/anthropic");
    expect(c.client.baseURL).not.toContain("api.anthropic.com");
  });

  it("sets the cf-aig-metadata header naming the agent (cost attribution, set once)", async () => {
    const { env } = makeEnv();
    const c = await claudeFor("compass", env);
    // Build a request (no network) and inspect the headers the SDK attaches.
    const { req } = await c.client.buildRequest({
      method: "post",
      path: "/v1/messages",
      body: { model: c.model, max_tokens: 1, messages: [] },
    } as never);
    const headers = req.headers;
    const meta = headers.get("cf-aig-metadata");
    expect(meta).toBeTruthy();
    expect(JSON.parse(meta as string)).toEqual({ agent: "compass" });
    expect(headers.get("cf-aig-authorization")).toBe("Bearer cf-aig-fake");
  });

  it("binds the resolved model for the agent (filer → haiku)", async () => {
    const { env } = makeEnv();
    const c = await claudeFor("filer", env);
    expect(c.model).toBe("claude-haiku-4-5");
  });
});

describe("claudeFor — a non-2xx Gateway response raises a Flagger P3 flag", () => {
  it("emits exactly one canonical op:'upsert'/entity:'flag' event with a structured key, then rethrows", async () => {
    const { env, send } = makeEnv();
    const c = await claudeFor("forge", env);

    // Stub the underlying SDK call to throw a non-2xx APIError (gateway returned 500).
    const apiError = new Anthropic.APIError(
      500,
      { type: "error", error: { type: "api_error", message: "gateway boom" } },
      "gateway boom",
      new Headers(),
    );
    vi.spyOn(c.client.messages, "create").mockRejectedValue(apiError as never);

    await expect(
      c.messages.create({ max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBe(apiError);

    // Exactly one canonical Flagger Wire event.
    expect(send).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.op).toBe("upsert");
    expect(event.entity).toBe("flag");
    const payload = event.payload as Record<string, unknown>;
    expect(payload.severity).toBe("P3");
    // Structured, NON-random idempotencyKey === the flag id (flg:<date>:<agent>:<hash>).
    expect(event.idempotencyKey).toBe(payload.id);
    expect(event.idempotencyKey).toMatch(/^flg:\d{4}-\d{2}-\d{2}:Model:/);
  });

  it("does NOT flag a 2xx/non-SDK throw — a plain Error stays quiet", async () => {
    const { env, send } = makeEnv();
    const c = await claudeFor("forge", env);
    const plainError = new Error("network blip"); // not an SDK error, no HTTP status
    vi.spyOn(c.client.messages, "create").mockRejectedValue(plainError as never);

    await expect(
      c.messages.create({ max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBe(plainError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("claudeFor — connection/timeout failures are flagged P3, not silent (W19)", () => {
  it("flags a P3 'gateway unreachable' on an APIConnectionError (status===undefined)", async () => {
    const { env, send } = makeEnv();
    const c = await claudeFor("forge", env);
    const connErr = new Anthropic.APIConnectionError({ message: "fetch failed" });
    expect((connErr as { status?: unknown }).status).toBeUndefined(); // the silent-path trigger
    vi.spyOn(c.client.messages, "create").mockRejectedValue(connErr as never);

    await expect(
      c.messages.create({ max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBe(connErr);

    expect(send).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0]![0] as Record<string, unknown>;
    const payload = event.payload as Record<string, unknown>;
    expect(payload.severity).toBe("P3");
    expect(payload.title).toMatch(/unreachable/i);
    expect(event.idempotencyKey).toBe(payload.id);
  });

  it("flags a P3 (timeout variant) on an APIConnectionTimeoutError", async () => {
    const { env, send } = makeEnv();
    const c = await claudeFor("herald", env);
    const timeoutErr = new Anthropic.APIConnectionTimeoutError({ message: "timed out" });
    vi.spyOn(c.client.messages, "create").mockRejectedValue(timeoutErr as never);

    await expect(
      c.messages.create({ max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBe(timeoutErr);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = (send.mock.calls[0]![0] as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.severity).toBe("P3");
    expect(payload.title).toMatch(/timeout/i);
  });
});
