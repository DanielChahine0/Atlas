/**
 * wire-contract.test.ts — DoD Test 1: Wire-contract shape + structured idempotencyKey.
 *
 * Verifies (per 05-VALIDATION Dimension 8, META-01):
 * - A valid POST /prompt/save emits exactly ONE §6.4 WireEvent to env.WIRE.send.
 * - WireEvent.parse(emitted) does not throw (the single canonical schema in packages/wire).
 * - Literal field values: agent==="librarian", type==="prompt.save", entity==="prompt", op==="upsert".
 * - idempotencyKey matches /^librarian:[a-z0-9-]+:save$/ (first-save stable key).
 * - payload.fullNote===true and String(payload.notePath) matches /^Prompts\//.
 *
 * Pattern: spy-env helpers from apps/flagger/test/routing.test.ts lines 47-98 +
 *          ack-auth.test.ts lines 29-55 (makeAuthEnv / makeRequest shape).
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import type { RawIncident } from "@atlas/shared";
import type { Env } from "../src/env.js";
import librarian from "../src/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const CORRECT_TOKEN = "test-librarian-secret-abc123";

/**
 * Build a spy env with WIRE.send and INCIDENTS.send captured, and a valid (or invalid)
 * ATLAS_LIBRARIAN_TOKEN binding. CONFIG.get returns null for all keys (no KV overrides),
 * which means dedupe thresholds default to 0.75/0.55 and default_tool="Claude".
 * DB comes from the real per-test D1 (apply-migrations.ts seeds it).
 */
function makeSpyEnv(opts: {
  token?: string;
  tokenSeeded?: boolean;
  configOverrides?: Record<string, string>;
} = {}) {
  const wireEvents: WireEvent[] = [];
  const incidents: RawIncident[] = [];

  const configData = opts.configOverrides ?? {};

  const spyEnv: Env = {
    ...(env as unknown as Env),
    WIRE: {
      send: vi.fn(async (event: WireEvent) => {
        wireEvents.push(event);
      }),
    } as unknown as Queue<WireEvent>,
    INCIDENTS: {
      send: vi.fn(async (incident: RawIncident) => {
        incidents.push(incident);
      }),
    } as unknown as Queue<RawIncident>,
    CONFIG: {
      get: vi.fn(async (key: string) => configData[key] ?? null),
      put: vi.fn(async () => {}),
    } as unknown as KVNamespace,
    ATLAS_LIBRARIAN_TOKEN:
      opts.tokenSeeded !== false
        ? { get: vi.fn(async () => opts.token ?? CORRECT_TOKEN) }
        : { get: vi.fn(async () => null) },
    // claudeFor("librarian", env) is invoked inside handleSave on the "new" path.
    // For wire-contract tests we want the real derive path to run, but since
    // ANTHROPIC_API_KEY is not seeded in the test environment, deriveRecord will
    // throw/fallback to the prompt-derived title. That fallback produces a valid slug
    // so the Wire event is still emitted — good enough to test the contract.
    ANTHROPIC_API_KEY: { get: vi.fn(async () => null) },
    CF_AIG_TOKEN: { get: vi.fn(async () => null) },
  } as unknown as Env;

  return { spyEnv, wireEvents, incidents };
}

/** Build a valid POST /prompt/save request. */
function saveRequest(opts: {
  token?: string;
  body?: Record<string, unknown>;
  noAuth?: boolean;
} = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!opts.noAuth) {
    headers["Authorization"] = `Bearer ${opts.token ?? CORRECT_TOKEN}`;
  }
  return new Request("https://librarian.workers.dev/prompt/save", {
    method: "POST",
    headers,
    body: JSON.stringify(
      opts.body ?? {
        full_prompt:
          "You are a helpful assistant that summarizes code reviews clearly and concisely.",
        tool: "Claude",
      },
    ),
  });
}

// ── Wire-contract tests ───────────────────────────────────────────────────────

// Each test uses a unique prompt to avoid cross-test slug collisions in the shared
// per-test D1 database (tests run sequentially in the same DB within a file).
// A re-save of the same slug takes the bump path (date+content-hash-suffixed key) — using
// unique prompts ensures each test exercises the "new" path with the stable first-save key.

describe("Librarian Wire-contract (DoD Test 1)", () => {
  it("emits exactly ONE §6.4-valid Wire event on a valid new-prompt save", async () => {
    const { spyEnv, wireEvents } = makeSpyEnv();
    const req = saveRequest({
      body: {
        full_prompt:
          "You are a systematic code reviewer focused on identifying security vulnerabilities.",
        tool: "Claude",
      },
    });

    const resp = await librarian.fetch(req, spyEnv);

    // The save succeeded (200 + action:"new")
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { action: string; slug?: string };
    expect(body.action).toBe("new");

    // Exactly one Wire event emitted
    expect(wireEvents).toHaveLength(1);
  });

  it("Wire event passes WireEvent.parse (canonical §6.4 schema)", async () => {
    const { spyEnv, wireEvents } = makeSpyEnv();
    await librarian.fetch(
      saveRequest({
        body: {
          full_prompt:
            "Analyze the given TypeScript function and identify potential null pointer exceptions.",
          tool: "Claude",
        },
      }),
      spyEnv,
    );

    const emitted = wireEvents[0]!;
    expect(() => WireEvent.parse(emitted)).not.toThrow();
  });

  it("Wire event literal field values: agent/type/entity/op", async () => {
    const { spyEnv, wireEvents } = makeSpyEnv();
    await librarian.fetch(
      saveRequest({
        body: {
          full_prompt:
            "Generate a comprehensive unit test suite for the provided JavaScript module.",
          tool: "Claude",
        },
      }),
      spyEnv,
    );

    const emitted = wireEvents[0]!;
    expect(emitted.agent).toBe("librarian");
    expect(emitted.type).toBe("prompt.save");
    expect(emitted.entity).toBe("prompt");
    expect(emitted.op).toBe("upsert");
  });

  it("idempotencyKey matches ^librarian:[a-z0-9-]+:save$ (first-save stable key)", async () => {
    const { spyEnv, wireEvents } = makeSpyEnv();
    await librarian.fetch(
      saveRequest({
        body: {
          full_prompt:
            "Refactor this Python class to use composition instead of inheritance.",
          tool: "Claude",
        },
      }),
      spyEnv,
    );

    const emitted = wireEvents[0]!;
    // First-save key: librarian:<slug>:save (no date suffix — stable forever)
    expect(emitted.idempotencyKey).toMatch(/^librarian:[a-z0-9-]+:save$/);
  });

  it("payload.fullNote===true and notePath starts with Prompts/", async () => {
    const { spyEnv, wireEvents } = makeSpyEnv();
    await librarian.fetch(
      saveRequest({
        body: {
          full_prompt:
            "Extract all TODO comments from the codebase and convert them to structured tickets.",
          tool: "Claude",
        },
      }),
      spyEnv,
    );

    const emitted = wireEvents[0]!;
    expect(emitted.payload.fullNote).toBe(true);
    expect(String(emitted.payload.notePath)).toMatch(/^Prompts\//);
  });

  it("notePath ends with .md and is a single-segment slug (no traversal)", async () => {
    const { spyEnv, wireEvents } = makeSpyEnv();
    await librarian.fetch(
      saveRequest({
        body: {
          full_prompt:
            "Write documentation comments for all public API endpoints in this Express app.",
          tool: "Claude",
        },
      }),
      spyEnv,
    );

    const notePath = String(wireEvents[0]!.payload.notePath);
    // Matches Prompts/<slug>.md where <slug> is safe [A-Za-z0-9._-]*
    expect(notePath).toMatch(/^Prompts\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/);
    expect(notePath.includes("..")).toBe(false);
  });

  it("payload.noteBody is a non-empty string (YAML frontmatter + prompt body)", async () => {
    const { spyEnv, wireEvents } = makeSpyEnv();
    const prompt =
      "Review the database schema for missing indexes on frequently queried columns.";
    await librarian.fetch(
      saveRequest({ body: { full_prompt: prompt, tool: "Claude" } }),
      spyEnv,
    );

    const noteBody = String(wireEvents[0]!.payload.noteBody);
    // Must be a YAML-frontmatter markdown note
    expect(noteBody).toContain("---");
    // Must contain the original prompt somewhere in the body
    expect(noteBody).toContain(prompt);
  });
});
