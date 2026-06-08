import { describe, it, expect, vi } from "vitest";
import {
  loadBrowserConfig,
  pollOnce,
  ackOutcome,
  drainOnce,
  drainLoop,
  type BrowserDrainConfig,
  type BrowserDrainDeps,
} from "../src/browser-drain.ts";
import type { BrowserActionWorkItem, BrowserActionOutcome } from "../../packages/gate/src/schema.ts";

// browser-drain — daemon unit tests (OUTBOUND-only, no real Chromium, no real cloud)
//
// Proves:
//   - loadBrowserConfig loads from env and fails loud on missing ATLAS_BRIDGE_URL,
//     ATLAS_BRIDGE_TOKEN, or ATLAS_BROWSER_PROFILE (never defaults the profile path)
//   - pollOnce GETs /browser/poll with Bearer token, returns items
//   - drainOnce is SERIAL (for...of, never Promise.all): order preserved
//   - ackOutcome is called AFTER the action attempt (ack-after-attempt)
//   - one item erroring in runBrowserAction does NOT abort the batch — it is acked
//     with {status:'error'} and the loop continues
//   - drainLoop backs off on empty polls and on iteration errors

const cfg: BrowserDrainConfig = {
  bridgeBaseUrl: "https://bridge.example.workers.dev",
  bridgeToken: "test-token",
  browserProfilePath: "/tmp/test-profile",
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

function makeItem(id: string, action_type: BrowserActionWorkItem["action_type"] = "event_fill_submit"): BrowserActionWorkItem {
  return {
    id,
    agent: "Usher",
    action_type,
    fields: JSON.stringify({ name: "Daniel", email: "test@example.com" }),
    gate_id: `gate-${id}`,
    target_url: `https://example.com/register/${id}`,
  };
}

function successOutcome(id: string): BrowserActionOutcome {
  return { id, status: "success", confirmation_number: "CONF-123" };
}

// ─── loadBrowserConfig ────────────────────────────────────────────────────────

describe("loadBrowserConfig", () => {
  it("loads all three required env vars", () => {
    const c = loadBrowserConfig({
      ATLAS_BRIDGE_URL: "https://bridge.example.workers.dev",
      ATLAS_BRIDGE_TOKEN: "tok",
      ATLAS_BROWSER_PROFILE: "/home/user/.atlas/browser-profile",
    });
    expect(c.bridgeBaseUrl).toBe("https://bridge.example.workers.dev");
    expect(c.bridgeToken).toBe("tok");
    expect(c.browserProfilePath).toBe("/home/user/.atlas/browser-profile");
  });

  it("uses default backoff when ATLAS_DRAIN_BACKOFF_MS is unset", () => {
    const c = loadBrowserConfig({
      ATLAS_BRIDGE_URL: "https://bridge.example.workers.dev",
      ATLAS_BRIDGE_TOKEN: "tok",
      ATLAS_BROWSER_PROFILE: "/tmp/profile",
    });
    expect(c.backoffMs).toBe(5000);
  });

  it("throws loud when ATLAS_BRIDGE_URL is missing", () => {
    expect(() =>
      loadBrowserConfig({ ATLAS_BRIDGE_TOKEN: "tok", ATLAS_BROWSER_PROFILE: "/tmp/p" }),
    ).toThrow(/ATLAS_BRIDGE_URL/);
  });

  it("throws loud when ATLAS_BRIDGE_TOKEN is missing", () => {
    expect(() =>
      loadBrowserConfig({ ATLAS_BRIDGE_URL: "https://b", ATLAS_BROWSER_PROFILE: "/tmp/p" }),
    ).toThrow(/ATLAS_BRIDGE_TOKEN/);
  });

  it("throws loud when ATLAS_BROWSER_PROFILE is missing (never defaults the path)", () => {
    expect(() =>
      loadBrowserConfig({ ATLAS_BRIDGE_URL: "https://b", ATLAS_BRIDGE_TOKEN: "tok" }),
    ).toThrow(/ATLAS_BROWSER_PROFILE/);
  });
});

// ─── pollOnce ────────────────────────────────────────────────────────────────

describe("pollOnce", () => {
  it("GETs /browser/poll with Bearer token and returns items", async () => {
    const item = makeItem("a");
    const fetchCloud = vi.fn(async () => fakeResponse(true, { items: [item] }));
    const deps: BrowserDrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      runBrowserAction: vi.fn(),
    };

    const items = await pollOnce(cfg, deps);
    expect(items.map((i) => i.id)).toEqual(["a"]);

    const [url, init] = fetchCloud.mock.calls[0]!;
    expect(url).toBe("https://bridge.example.workers.dev/browser/poll");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer test-token",
    );
  });

  it("returns empty array when no items are pending", async () => {
    const fetchCloud = vi.fn(async () => fakeResponse(true, { items: [] }));
    const deps: BrowserDrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      runBrowserAction: vi.fn(),
    };
    const items = await pollOnce(cfg, deps);
    expect(items).toEqual([]);
  });

  it("throws on a non-2xx poll (loop backs off, items stay pending)", async () => {
    const fetchCloud = vi.fn(async () => fakeResponse(false, {}, 503));
    const deps: BrowserDrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      runBrowserAction: vi.fn(),
    };
    await expect(pollOnce(cfg, deps)).rejects.toThrow(/poll failed: 503/);
  });
});

// ─── ackOutcome ──────────────────────────────────────────────────────────────

describe("ackOutcome", () => {
  it("POSTs /browser/ack with id + outcome + Bearer token", async () => {
    const fetchCloud = vi.fn(async () => fakeResponse(true, { acked: true }));
    const deps: BrowserDrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      runBrowserAction: vi.fn(),
    };
    const outcome: BrowserActionOutcome = { id: "item-1", status: "success", confirmation_number: "CONF-999" };
    await ackOutcome("item-1", outcome, cfg, deps);

    const [url, init] = fetchCloud.mock.calls[0]!;
    expect(url).toBe("https://bridge.example.workers.dev/browser/ack");
    const i = init as { method: string; headers: Record<string, string>; body: string };
    expect(i.method).toBe("POST");
    expect(i.headers.Authorization).toBe("Bearer test-token");
    expect(JSON.parse(i.body)).toEqual({ id: "item-1", outcome });
  });
});

// ─── drainOnce — serial drain, ack-after-attempt ─────────────────────────────

describe("drainOnce (serial drain, ack-after-attempt)", () => {
  it("processes items SERIALLY — order preserved (never Promise.all)", async () => {
    const order: string[] = [];
    const itemA = makeItem("a");
    const itemB = makeItem("b");

    const runBrowserAction = vi.fn(async (item: BrowserActionWorkItem) => {
      order.push(`run:${item.id}`);
      return successOutcome(item.id);
    });

    const fetchCloud = vi.fn(async (url: string, init?: unknown) => {
      if (url.endsWith("/browser/poll"))
        return fakeResponse(true, { items: [itemA, itemB] });
      if (url.endsWith("/browser/ack")) {
        const body = JSON.parse((init as { body: string }).body) as { id: string };
        order.push(`ack:${body.id}`);
        return fakeResponse(true, { acked: true });
      }
      return fakeResponse(false, {}, 404);
    });

    const deps: BrowserDrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      runBrowserAction,
    };

    const count = await drainOnce(cfg, deps);
    expect(count).toBe(2);
    // Serial: a must complete (run + ack) before b starts
    expect(order.indexOf("run:a")).toBeLessThan(order.indexOf("run:b"));
  });

  it("acks AFTER the action attempt (ack-after-attempt guarantee)", async () => {
    const order: string[] = [];
    const item = makeItem("x");

    const runBrowserAction = vi.fn(async () => {
      order.push("run:x");
      return successOutcome("x");
    });

    const fetchCloud = vi.fn(async (url: string) => {
      if (url.endsWith("/browser/poll")) return fakeResponse(true, { items: [item] });
      if (url.endsWith("/browser/ack")) {
        order.push("ack:x");
        return fakeResponse(true, { acked: true });
      }
      return fakeResponse(false, {}, 404);
    });

    await drainOnce(cfg, { fetchCloud: fetchCloud as unknown as typeof fetch, runBrowserAction });
    expect(order).toEqual(["run:x", "ack:x"]);
  });

  it("one item erroring does NOT abort the batch — it is acked with error outcome and loop continues", async () => {
    const item1 = makeItem("good1");
    const item2 = makeItem("fail");
    const item3 = makeItem("good3");
    const ackedIds: string[] = [];

    const runBrowserAction = vi.fn(async (item: BrowserActionWorkItem) => {
      if (item.id === "fail") throw new Error("browser exploded");
      return successOutcome(item.id);
    });

    const fetchCloud = vi.fn(async (url: string) => {
      if (url.endsWith("/browser/poll"))
        return fakeResponse(true, { items: [item1, item2, item3] });
      if (url.endsWith("/browser/ack")) {
        // We need to capture the body passed in call args, not closure vars
        return fakeResponse(true, { acked: true });
      }
      return fakeResponse(false, {}, 404);
    });

    const ackCallBodies: Array<{ id: string; outcome: BrowserActionOutcome }> = [];
    const wrappedFetch = vi.fn(async (url: string, init?: unknown) => {
      const result = await fetchCloud(url, init);
      if ((url as string).endsWith("/browser/ack")) {
        const body = JSON.parse((init as { body: string }).body) as { id: string; outcome: BrowserActionOutcome };
        ackCallBodies.push(body);
        ackedIds.push(body.id);
      }
      return result;
    });

    const count = await drainOnce(cfg, {
      fetchCloud: wrappedFetch as unknown as typeof fetch,
      runBrowserAction,
    });

    // All 3 items were attempted
    expect(count).toBe(3);
    // All 3 were acked
    expect(ackedIds).toContain("good1");
    expect(ackedIds).toContain("fail");
    expect(ackedIds).toContain("good3");
    // The failing item was acked with status:'error'
    const failAck = ackCallBodies.find((b) => b.id === "fail");
    expect(failAck?.outcome.status).toBe("error");
  });

  it("returns 0 on an empty poll", async () => {
    const fetchCloud = vi.fn(async () => fakeResponse(true, { items: [] }));
    const deps: BrowserDrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      runBrowserAction: vi.fn(),
    };
    expect(await drainOnce(cfg, deps)).toBe(0);
  });
});

// ─── drainLoop ────────────────────────────────────────────────────────────────

describe("drainLoop", () => {
  it("sleeps on an empty poll (single iteration, no spin)", async () => {
    const sleep = vi.fn(async () => {});
    const fetchCloud = vi.fn(async () => fakeResponse(true, { items: [] }));
    const deps: BrowserDrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      runBrowserAction: vi.fn(),
    };
    await drainLoop(cfg, deps, { runForever: false, sleep });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("backs off (does not throw) when a poll iteration errors", async () => {
    const sleep = vi.fn(async () => {});
    const fetchCloud = vi.fn(async () => {
      throw new Error("network down");
    });
    const deps: BrowserDrainDeps = {
      fetchCloud: fetchCloud as unknown as typeof fetch,
      runBrowserAction: vi.fn(),
    };
    await expect(drainLoop(cfg, deps, { runForever: false, sleep })).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
