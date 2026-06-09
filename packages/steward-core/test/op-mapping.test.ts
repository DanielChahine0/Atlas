import { describe, it, expect } from "vitest";
import { toOutboxIntent } from "../src/op-mapping.js";
import type { WireEvent } from "@atlas/wire";
import { NonRetryableError } from "cloudflare:workflows";

/**
 * Unit tests for the op→Obsidian-Local-REST mapping (packages/steward-core/src/op-mapping.ts).
 * Pure-logic tests: no D1, no DO, no network. Runs in real workerd via the steward-core vitest config.
 *
 * Focus: the fullNote PUT branch added in Phase 5 (05-01) for Librarian Prompts/<slug>.md writes.
 */

function wireEvent(overrides: Partial<WireEvent> = {}): WireEvent {
  return {
    agent: "Librarian",
    type: "prompt.save",
    entity: "Prompts/foo.md",
    op: "upsert",
    payload: {},
    idempotencyKey: "librarian:prompt:2026-06-09:abc123",
    ...overrides,
  };
}

describe("toOutboxIntent — fullNote PUT branch", () => {
  // Test 1: happy path — fullNote upsert returns PUT + correct path
  it("fullNote upsert returns method:PUT and path /vault/Prompts/foo.md", () => {
    const evt = wireEvent({
      payload: {
        fullNote: true,
        notePath: "Prompts/foo.md",
        noteBody: "# My Prompt\n\nContent here.",
      },
    });
    const intent = toOutboxIntent(evt);
    expect(intent.method).toBe("PUT");
    expect(intent.path).toBe("/vault/Prompts/foo.md");
  });

  // Test 2: body is raw noteBody markdown, NOT JSON.stringify of the whole payload
  it("fullNote upsert body is the raw noteBody string (not JSON-wrapped payload)", () => {
    const noteBody = "# My Prompt\n\nContent here.";
    const evt = wireEvent({
      payload: {
        fullNote: true,
        notePath: "Prompts/foo.md",
        noteBody,
      },
    });
    const intent = toOutboxIntent(evt);
    expect(intent.body).toBe(noteBody);
    // Must NOT be JSON-wrapped
    expect(() => JSON.parse(intent.body)).toThrow();
  });

  // Test 2 (headers): headers contain Content-Type: text/markdown and X-Atlas-Idem
  it("fullNote upsert headers contain Content-Type text/markdown and X-Atlas-Idem", () => {
    const idem = "librarian:prompt:2026-06-09:abc123";
    const evt = wireEvent({
      idempotencyKey: idem,
      payload: {
        fullNote: true,
        notePath: "Prompts/foo.md",
        noteBody: "# My Prompt",
      },
    });
    const intent = toOutboxIntent(evt);
    const headers = JSON.parse(intent.headers) as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/markdown");
    expect(headers["X-Atlas-Idem"]).toBe(idem);
  });

  // Test 3: non-Prompts/ notePath throws NonRetryableError
  it("fullNote upsert with notePath outside Prompts/ throws NonRetryableError", () => {
    const evt = wireEvent({
      payload: {
        fullNote: true,
        notePath: "Dashboard/Today.md",
        noteBody: "# Not allowed",
      },
    });
    expect(() => toOutboxIntent(evt)).toThrow(NonRetryableError);
  });

  // Test 4: missing/undefined notePath throws NonRetryableError (entity fallback must not bypass constraint)
  it("fullNote upsert with missing notePath throws NonRetryableError", () => {
    const evt = wireEvent({
      entity: "Dashboard/Today.md",  // entity fallback must NOT bypass the Prompts/ constraint
      payload: {
        fullNote: true,
        // notePath intentionally omitted
        noteBody: "# Should fail",
      },
    });
    expect(() => toOutboxIntent(evt)).toThrow(NonRetryableError);
  });

  // Test 5: ordinary upsert WITHOUT fullNote still produces PATCH + Target-Type frontmatter
  it("ordinary upsert (no fullNote) still produces method:PATCH with Target-Type frontmatter", () => {
    const evt = wireEvent({
      payload: {
        note: "Dashboard/Today",
        field: "tasks_count",
      },
    });
    const intent = toOutboxIntent(evt);
    expect(intent.method).toBe("PATCH");
    const headers = JSON.parse(intent.headers) as Record<string, string>;
    expect(headers["Target-Type"]).toBe("frontmatter");
  });
});
