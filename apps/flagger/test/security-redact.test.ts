/**
 * security-redact.test.ts — M3/M4 gap-closure tests for Flagger (Phase 2, gap-pass 2).
 *
 * M3: flag.title is redacted via @atlas/security redact() before being included in the
 *     ntfy POST body (external egress).
 * M4: a malformed body containing a code/login-URL is redacted in the emitted flag detail
 *     via buildMalformedFlagEvent.
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/index.js";
import type { RawIncident } from "@atlas/shared";
import type { WireEvent } from "@atlas/wire";
import flaggerDefault from "../src/index.js";
import { pushFlag } from "../src/push.js";
import type { FlagRecord } from "@atlas/shared";

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeBatch(body: unknown, opts: { id?: string } = {}) {
  const ack = vi.fn();
  const retry = vi.fn();
  const msg = {
    id: opts.id ?? "sec-msg-1",
    timestamp: new Date(),
    attempts: 1,
    body,
    ack,
    retry,
  };
  return {
    batch: {
      queue: "atlas-incidents",
      messages: [msg],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    },
    ack,
    retry,
  };
}

function makeTestEnv(opts: { pushEnabled?: boolean; ntfyTopicSet?: boolean } = {}): Env & { _wireEvents: WireEvent[] } {
  const wireEvents: WireEvent[] = [];
  const wireSend = vi.fn(async (event: WireEvent) => {
    wireEvents.push(event);
  });
  const incidentsSend = vi.fn(async () => {});
  const configData: Record<string, string> = {};
  if (opts.pushEnabled) {
    configData["flagger.push_enabled"] = "true";
  }

  const e: Env = {
    ...(env as unknown as Env),
    WIRE: { send: wireSend } as unknown as Queue<WireEvent>,
    INCIDENTS: { send: incidentsSend } as unknown as Queue<RawIncident>,
    FLAGGER_STATE: (env as unknown as Env).FLAGGER_STATE,
    CONFIG: {
      get: vi.fn(async (key: string) => configData[key] ?? null),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: "" })),
      getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
    } as unknown as KVNamespace,
    NTFY_TOPIC: {
      get: vi.fn(async () => opts.ntfyTopicSet ? "test-topic" : null),
    } as unknown as SecretsStoreSecret,
    NTFY_TOKEN: { get: vi.fn(async () => "test-token") } as unknown as SecretsStoreSecret,
    ACK_TOKEN: { get: vi.fn(async () => "test-ack") } as unknown as SecretsStoreSecret,
  } as unknown as Env;

  return Object.assign(e, { _wireEvents: wireEvents });
}

// ── M3 tests ─────────────────────────────────────────────────────────────────

describe("M3 — ntfy push redacts flag.title before external egress", () => {
  it("flag.title containing a login URL is masked in the ntfy POST body", async () => {
    // We call pushFlag directly so pushEnabled/WIRE don't matter; ntfyTopicSet must be true
    const e = makeTestEnv({ pushEnabled: false, ntfyTopicSet: true });

    // A flag with a login URL in the title
    const flag: FlagRecord = {
      id: "flg:2026-06-05:Forge:abc",
      ts: new Date().toISOString(),
      source_agent: "Forge",
      severity: "P1",
      trust: 95,
      title: "Alert: https://accounts.google.com/signin/abc123 was detected",
      status: "open",
    };

    const ntfyBodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      ntfyBodies.push(JSON.parse(init?.body as string));
      return new Response("OK");
    });
    vi.stubGlobal("fetch", fetchMock);

    await pushFlag(e, flag, "https://flagger.example.com/ack");

    vi.unstubAllGlobals();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = ntfyBodies[0] as { message?: string };
    // The title (used as "message" in ntfy payload) must NOT contain the login URL
    expect(body.message).not.toContain("accounts.google.com/signin");
    // It must contain the redaction marker
    expect(body.message).toContain("[REDACTED]");
  });

  it("flag.title containing a 2FA code is masked in the ntfy POST body", async () => {
    const e = makeTestEnv({ pushEnabled: false, ntfyTopicSet: true });

    const flag: FlagRecord = {
      id: "flg:2026-06-05:Herald:def",
      ts: new Date().toISOString(),
      source_agent: "Herald",
      severity: "P2",
      trust: 90,
      title: "Your verification code is 482913",
      status: "open",
    };

    const ntfyBodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      ntfyBodies.push(JSON.parse(init?.body as string));
      return new Response("OK");
    });
    vi.stubGlobal("fetch", fetchMock);

    await pushFlag(e, flag, "https://flagger.example.com/ack");

    vi.unstubAllGlobals();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = ntfyBodies[0] as { message?: string };
    expect(body.message).not.toContain("482913");
    expect(body.message).toContain("[REDACTED]");
  });
});

// ── M4 tests ─────────────────────────────────────────────────────────────────

describe("M4 — malformed incident detail is redacted before WIRE emit", () => {
  it("malformed body containing a login URL is redacted in the emitted flag detail", async () => {
    const e = makeTestEnv();
    const wireEvents = e._wireEvents;

    // A malformed body (fails RawIncidentSchema) with a login URL in a field
    const malformedBody = {
      source_agent: "Forge",
      kind: "chain_halted",
      // severity_hint is missing → fails schema
      title: "https://accounts.google.com/reset/abc123def456 was triggered",
    };

    const { batch } = fakeBatch(malformedBody, { id: "mal-sec-1" });
    await flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e);

    expect(wireEvents.length).toBeGreaterThanOrEqual(1);
    const malformedFlag = wireEvents.find(
      (ev) => ev.entity === "flag" && ev.op === "upsert",
    );
    expect(malformedFlag).toBeDefined();

    const detail = (malformedFlag?.payload as { detail?: string })?.detail ?? "";
    // The login URL must NOT appear unredacted in the flag detail
    expect(detail).not.toContain("accounts.google.com/reset");
    // The redaction marker must be present
    expect(detail).toContain("[REDACTED]");
  });

  it("malformed body containing a 2FA code is redacted in the emitted flag detail", async () => {
    const e = makeTestEnv();
    const wireEvents = e._wireEvents;

    const malformedBody = {
      // severity_hint is missing → fails schema
      source_agent: "Scout",
      kind: "something",
      title: "verification code 839201 was observed",
    };

    const { batch } = fakeBatch(malformedBody, { id: "mal-sec-2" });
    await flaggerDefault.queue(batch as unknown as MessageBatch<RawIncident>, e);

    const malformedFlag = wireEvents.find(
      (ev) => ev.entity === "flag" && ev.op === "upsert",
    );
    expect(malformedFlag).toBeDefined();
    const detail = (malformedFlag?.payload as { detail?: string })?.detail ?? "";
    expect(detail).not.toContain("839201");
    expect(detail).toContain("[REDACTED]");
  });
});
