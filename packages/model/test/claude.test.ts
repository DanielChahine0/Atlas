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

  it("does NOT flag a 2xx/non-HTTP throw — only a genuine non-2xx Gateway response", async () => {
    const { env, send } = makeEnv();
    const c = await claudeFor("forge", env);
    const plainError = new Error("network blip"); // no HTTP status
    vi.spyOn(c.client.messages, "create").mockRejectedValue(plainError as never);

    await expect(
      c.messages.create({ max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBe(plainError);
    expect(send).not.toHaveBeenCalled();
  });
});
