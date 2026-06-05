import { describe, it, expect, vi } from "vitest";
import {
  loadConfig,
  pollOnce,
  ackIntent,
  drainOnce,
  drainLoop,
  OBSIDIAN_BASE,
  type DaemonConfig,
  type DrainDeps,
  type DrainIntent,
} from "../src/drain.ts";

// SPINE-05 daemon drain-logic unit test — runs in the Node environment with MOCKED
// fetch + a mocked Obsidian writer (no real cloud bridge, no real Obsidian). Proves:
//   - config loads from env and fails loud on a missing secret (no fabricated token)
//   - pollOnce long-polls /bridge/poll OUTBOUND with the Bearer token
//   - drainOnce writes each intent to Obsidian THEN acks /bridge/ack (ack only after write)
//   - a failed Obsidian write leaves the intent UN-acked (pending — never lost)
//   - the Obsidian base is the loopback 127.0.0.1:27124
//   - a non-allow-listed (removal) verb is refused (Pillar 2)

const cfg: DaemonConfig = {
  bridgeBaseUrl: "https://bridge.example.workers.dev",
  bridgeToken: "test-token",
  obsidianApiKey: "test-obsidian-key",
  backoffMs: 1,
};

function fakeResponse(ok: boolean, json: unknown, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

function intent(idem: string, method = "PATCH"): DrainIntent {
  return {
    idem,
    path: "/vault/Counters/metrics.md",
    method,
    headers: JSON.stringify({ Operation: "replace", "Target-Type": "frontmatter" }),
    body: JSON.stringify({ value: 1 }),
  };
}

describe("daemon config", () => {
  it("loads from env", () => {
    const c = loadConfig({
      ATLAS_BRIDGE_URL: "https://b",
      ATLAS_BRIDGE_TOKEN: "t",
      OBSIDIAN_API_KEY: "k",
    });
    expect(c.bridgeBaseUrl).toBe("https://b");
    expect(c.bridgeToken).toBe("t");
    expect(c.obsidianApiKey).toBe("k");
  });

  it("fails loud on a missing token (no fabricated default)", () => {
    expect(() => loadConfig({ ATLAS_BRIDGE_URL: "https://b", OBSIDIAN_API_KEY: "k" })).toThrow(
      /ATLAS_BRIDGE_TOKEN/,
    );
  });
});

describe("daemon pollOnce (OUTBOUND long-poll)", () => {
  it("polls /bridge/poll with the Bearer token and returns intents", async () => {
    const fetchCloud = vi.fn(async () => fakeResponse(true, { intents: [intent("a")] }));
    const deps: DrainDeps = { fetchCloud: fetchCloud as unknown as typeof fetch, writeObsidian: vi.fn() };

    const intents = await pollOnce(cfg, deps);
    expect(intents.map((i) => i.idem)).toEqual(["a"]);

    const [url, init] = fetchCloud.mock.calls[0]!;
    expect(url).toBe("https://bridge.example.workers.dev/bridge/poll");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer test-token",
    );
  });

  it("throws on a non-2xx poll (so the loop backs off, intents stay pending)", async () => {
    const fetchCloud = vi.fn(async () => fakeResponse(false, {}, 503));
    const deps: DrainDeps = { fetchCloud: fetchCloud as unknown as typeof fetch, writeObsidian: vi.fn() };
    await expect(pollOnce(cfg, deps)).rejects.toThrow(/poll failed: 503/);
  });
});

describe("daemon drainOnce (write THEN ack)", () => {
  it("writes each intent to Obsidian then acks it OUTBOUND", async () => {
    const order: string[] = [];
    const writeObsidian = vi.fn(async (i: DrainIntent) => {
      order.push(`write:${i.idem}`);
    });
    const fetchCloud = vi.fn(async (url: string) => {
      if (url.endsWith("/bridge/poll")) return fakeResponse(true, { intents: [intent("x")] });
      if (url.endsWith("/bridge/ack")) {
        order.push("ack:x");
        return fakeResponse(true, { acked: true });
      }
      return fakeResponse(false, {}, 404);
    });
    const deps: DrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      writeObsidian,
    };

    const drained = await drainOnce(cfg, deps);
    expect(drained).toBe(1);
    // The write MUST precede the ack (ack only after a successful local write).
    expect(order).toEqual(["write:x", "ack:x"]);
  });

  it("does NOT ack when the Obsidian write fails (intent stays pending)", async () => {
    const writeObsidian = vi.fn(async () => {
      throw new Error("Obsidian unreachable");
    });
    const ackCalls: string[] = [];
    const fetchCloud = vi.fn(async (url: string) => {
      if (url.endsWith("/bridge/poll")) return fakeResponse(true, { intents: [intent("y")] });
      if (url.endsWith("/bridge/ack")) {
        ackCalls.push("ack");
        return fakeResponse(true, {});
      }
      return fakeResponse(false, {}, 404);
    });
    const deps: DrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      writeObsidian,
    };

    await expect(drainOnce(cfg, deps)).rejects.toThrow(/Obsidian unreachable/);
    // The ack was NEVER sent — the intent remains pending on the cloud (never lost).
    expect(ackCalls).toEqual([]);
  });

  it("refuses a non-allow-listed (removal) verb from a bridge intent (Pillar 2)", async () => {
    const fetchCloud = vi.fn(async () => fakeResponse(true, { intents: [intent("z", "DELETE")] }));
    const writeObsidian = vi.fn();
    const deps: DrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      writeObsidian,
    };
    await expect(drainOnce(cfg, deps)).rejects.toThrow(/non-safe Vault method/);
    expect(writeObsidian).not.toHaveBeenCalled();
  });
});

describe("daemon ackIntent", () => {
  it("POSTs /bridge/ack with the idem and Bearer token", async () => {
    const fetchCloud = vi.fn(async () => fakeResponse(true, { acked: true }));
    const deps: DrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      writeObsidian: vi.fn(),
    };
    await ackIntent("idem-1", cfg, deps);
    const [url, init] = fetchCloud.mock.calls[0]!;
    expect(url).toBe("https://bridge.example.workers.dev/bridge/ack");
    const i = init as { method: string; headers: Record<string, string>; body: string };
    expect(i.method).toBe("POST");
    expect(i.headers.Authorization).toBe("Bearer test-token");
    expect(JSON.parse(i.body)).toEqual({ idem: "idem-1" });
  });
});

describe("daemon drainLoop (single iteration, no spin)", () => {
  it("runs one iteration and sleeps on an empty poll", async () => {
    const sleep = vi.fn(async () => {});
    const fetchCloud = vi.fn(async () => fakeResponse(true, { intents: [] }));
    const deps: DrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      writeObsidian: vi.fn(),
    };
    await drainLoop(cfg, deps, { runForever: false, sleep });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("backs off (does not throw) when a poll iteration errors", async () => {
    const sleep = vi.fn(async () => {});
    const fetchCloud = vi.fn(async () => {
      throw new Error("network down");
    });
    const deps: DrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      writeObsidian: vi.fn(),
    };
    // The loop swallows the error and backs off — it must NOT propagate (never crash).
    await expect(drainLoop(cfg, deps, { runForever: false, sleep })).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe("daemon Obsidian target", () => {
  it("targets the loopback Local REST API v3 base", () => {
    expect(OBSIDIAN_BASE).toBe("https://127.0.0.1:27124");
  });
});
