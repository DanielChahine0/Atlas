import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker, { ALLOWED_VAULT_METHODS } from "../src/index.js";
import { toOutboxIntent, SAFE_METHODS } from "@atlas/steward-core";
import type { WireEvent } from "@atlas/wire";
import type { Env } from "../src/index.js";

// SPINE-05 bridge tests: the outbound-only drain surface.
//   (a) /bridge/poll + /bridge/ack reject a missing / wrong ATLAS_BRIDGE_TOKEN (401)
//   (b) with the correct token: a seeded pending vault_outbox row is returned by poll,
//       ack flips it to done, and a SECOND ack is a no-op (idempotent — no double-apply)
//   (c) the op→REST map (the single @atlas/steward-core source) contains NO DELETE
//       method (Pillar 2: Steward never deletes the Vault)
//
// Runs in workerd (TZ=UTC). The pool gives each test an isolated D1 with the shared
// migrations applied (test/apply-migrations.ts).

const REAL_TOKEN = "test-bridge-token-abc123";

/** A Secrets Store async binding stub: `await env.X.get()` resolves to the given value. */
function secretStub(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

/** The bound D1 from the test env. */
const DB = (env as unknown as { DB: D1Database }).DB;

/** A test env: the real D1 + a stubbed ATLAS_BRIDGE_TOKEN secret binding. */
const testEnv = {
  DB,
  ATLAS_BRIDGE_TOKEN: secretStub(REAL_TOKEN),
} as unknown as Env;

/** Seed a PENDING vault_outbox row (mimics a Steward enqueue). */
async function seedPending(idem: string): Promise<void> {
  await DB.prepare(
    "INSERT OR REPLACE INTO vault_outbox (idem, path, method, headers, body, state, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(idem, "/vault/Counters/metrics.md", "PATCH", "{}", "{}", "pending", Date.now())
    .run();
}

async function rowState(idem: string): Promise<string | null> {
  const row = await DB.prepare("SELECT state FROM vault_outbox WHERE idem = ?")
    .bind(idem)
    .first<{ state: string }>();
  return row?.state ?? null;
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://bridge.atlas.test${path}`, init);
}

beforeEach(async () => {
  // Each test is isolated, but clear defensively so re-seeds don't collide.
  await DB.prepare("DELETE FROM vault_outbox").run();
});

describe("mcp-obsidian-bridge token gate (SPINE-05, T-00-33)", () => {
  it("rejects /bridge/poll with NO Authorization header (401)", async () => {
    const res = await worker.fetch(req("/bridge/poll", { method: "GET" }), testEnv);
    expect(res.status).toBe(401);
  });

  it("rejects /bridge/poll with a WRONG token (401)", async () => {
    const res = await worker.fetch(
      req("/bridge/poll", { method: "GET", headers: { Authorization: "Bearer wrong-token" } }),
      testEnv,
    );
    expect(res.status).toBe(401);
  });

  it("rejects /bridge/ack with NO Authorization header (401)", async () => {
    const res = await worker.fetch(
      req("/bridge/ack", { method: "POST", body: JSON.stringify({ idem: "x" }) }),
      testEnv,
    );
    expect(res.status).toBe(401);
  });

  it("fails closed when ATLAS_BRIDGE_TOKEN is unset (401 even with a Bearer header)", async () => {
    const noTokenEnv = { DB } as unknown as Env;
    const res = await worker.fetch(
      req("/bridge/poll", { method: "GET", headers: { Authorization: "Bearer anything" } }),
      noTokenEnv,
    );
    expect(res.status).toBe(401);
  });
});

describe("mcp-obsidian-bridge poll/ack drain (SPINE-05)", () => {
  it("poll returns a seeded pending row with the correct token", async () => {
    await seedPending("idem-poll-1");
    const res = await worker.fetch(
      req("/bridge/poll", { method: "GET", headers: { Authorization: `Bearer ${REAL_TOKEN}` } }),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intents: { idem: string }[] };
    expect(body.intents.map((i) => i.idem)).toContain("idem-poll-1");
  });

  it("ack flips a pending row to done; a SECOND ack is a no-op (idempotent)", async () => {
    await seedPending("idem-ack-1");
    expect(await rowState("idem-ack-1")).toBe("pending");

    const ack1 = await worker.fetch(
      req("/bridge/ack", {
        method: "POST",
        headers: { Authorization: `Bearer ${REAL_TOKEN}` },
        body: JSON.stringify({ idem: "idem-ack-1" }),
      }),
      testEnv,
    );
    expect(ack1.status).toBe(200);
    const ack1Body = (await ack1.json()) as { changed: number };
    expect(ack1Body.changed).toBe(1);
    expect(await rowState("idem-ack-1")).toBe("done");

    // Second ack: already done ⇒ no rows change ⇒ a safe no-op (no double-apply).
    const ack2 = await worker.fetch(
      req("/bridge/ack", {
        method: "POST",
        headers: { Authorization: `Bearer ${REAL_TOKEN}` },
        body: JSON.stringify({ idem: "idem-ack-1" }),
      }),
      testEnv,
    );
    expect(ack2.status).toBe(200);
    const ack2Body = (await ack2.json()) as { changed: number };
    expect(ack2Body.changed).toBe(0);
    expect(await rowState("idem-ack-1")).toBe("done");
  });

  it("ack of an UNKNOWN idem is a safe no-op (no double-apply, no error)", async () => {
    const res = await worker.fetch(
      req("/bridge/ack", {
        method: "POST",
        headers: { Authorization: `Bearer ${REAL_TOKEN}` },
        body: JSON.stringify({ idem: "never-seeded" }),
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: number };
    expect(body.changed).toBe(0);
  });

  it("a done row is NOT returned by a subsequent poll (only pending drains)", async () => {
    await seedPending("idem-drain-1");
    // Ack it to done.
    await worker.fetch(
      req("/bridge/ack", {
        method: "POST",
        headers: { Authorization: `Bearer ${REAL_TOKEN}` },
        body: JSON.stringify({ idem: "idem-drain-1" }),
      }),
      testEnv,
    );
    const res = await worker.fetch(
      req("/bridge/poll", { method: "GET", headers: { Authorization: `Bearer ${REAL_TOKEN}` } }),
      testEnv,
    );
    const body = (await res.json()) as { intents: { idem: string }[] };
    expect(body.intents.map((i) => i.idem)).not.toContain("idem-drain-1");
  });
});

describe("mcp-obsidian-bridge inbound surface + op→REST safety", () => {
  it("routes ONLY /bridge/poll + /bridge/ack — every other path is 404", async () => {
    for (const path of ["/", "/bridge", "/vault/anything", "/admin", "/bridge/poll/extra"]) {
      const res = await worker.fetch(
        req(path, { method: "GET", headers: { Authorization: `Bearer ${REAL_TOKEN}` } }),
        testEnv,
      );
      expect(res.status).toBe(404);
    }
  });

  it("the canonical op→REST allow-list has NO DELETE method (Pillar 2)", () => {
    // The bridge re-exports the single @atlas/steward-core SAFE_METHODS as data.
    expect(ALLOWED_VAULT_METHODS).toEqual([...SAFE_METHODS]);
    for (const m of ALLOWED_VAULT_METHODS) {
      expect(m).not.toMatch(/delete/i);
    }
    expect(ALLOWED_VAULT_METHODS).not.toContain("DELETE");
  });

  it("toOutboxIntent (the single map) never produces a DELETE for any op", () => {
    const ops: WireEvent["op"][] = ["increment", "upsert", "append"];
    for (const op of ops) {
      const ev: WireEvent = {
        agent: "Filer",
        type: "t",
        entity: "e",
        op,
        payload: {},
        idempotencyKey: `k:${op}`,
      };
      const intent = toOutboxIntent(ev);
      expect(intent.method).not.toMatch(/delete/i);
      expect(SAFE_METHODS as readonly string[]).toContain(intent.method);
    }
  });
});
