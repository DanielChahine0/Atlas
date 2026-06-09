/**
 * replay.test.ts — DoD Test 2: replay-through-Steward idempotency (meta.changes === 0).
 *
 * Uses `applyEvent(env.DB, evt)` from @atlas/steward-core — the core ledger+op-mapping
 * apply that StewardWriter.apply wraps in a DO's blockConcurrencyWhile. applyEvent needs
 * only the D1 binding (already present via apply-migrations.ts). DO-level serialization is
 * proven in apps/steward/test/replay.test.ts; this test isolates the ledger+op-mapping layer.
 *
 * Analog: apps/forge/test/wire.test.ts lines 32–43 (applyEvent twice → applied:true then false).
 *
 * What this exercises end-to-end:
 * - applyEvent calls toOutboxIntent(e) which routes the fullNote PUT branch (05-01).
 *   If the fullNote branch is missing, toOutboxIntent throws NonRetryableError — a useful
 *   integration signal that the whole META-01 path is broken (05-01 dependency check).
 * - The idempotency_keys ledger dedupes the replay (meta.changes===0 → applied:false).
 * - vault_outbox INSERT OR IGNORE on PK=idem: exactly ONE pending row, never two.
 * - A dedupe-bump key (date+content-hash-suffixed, CR-01) is a DISTINCT ledger entry —
 *   applies true once, writes to the SAME notePath (upsert on same slug, no clone).
 *
 * Verifies:
 * - T-5-Replay: replayed upsert is { applied: false }, one vault_outbox row (no double-count).
 * - META-01 fullNote PUT branch is live in op-mapping (integration signal for 05-01).
 */

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import { applyEvent } from "@atlas/steward-core";
import { contentHash } from "@atlas/shared";
import type { WireEvent as WireEventType } from "@atlas/wire";

// The D1 database is seeded with migrations (0001..0008) by apply-migrations.ts beforeAll.
const db = (env as unknown as { DB: D1Database }).DB;

// ── Canonical test event ──────────────────────────────────────────────────────

/** A §6.4-valid Librarian upsert event for a new prompt. */
function makeLibrarianEvent(overrides: Partial<WireEventType> = {}): WireEventType {
  return {
    agent: "librarian",
    type: "prompt.save",
    entity: "prompt",
    op: "upsert",
    payload: {
      fullNote: true,
      notePath: "Prompts/test-prompt.md",
      noteBody:
        "---\ntitle: Test Prompt\ntool: Claude\ntags: []\ncreated: 2026-06-09\nlast_used: 2026-06-09\nuses: 1\n---\n\nThis is the prompt body.",
    },
    idempotencyKey: "librarian:test-prompt:save",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Librarian replay-through-Steward (DoD Test 2)", () => {
  it("event is §6.4-valid (WireEvent.parse does not throw)", () => {
    expect(() => WireEvent.parse(makeLibrarianEvent())).not.toThrow();
  });

  it("first apply returns { applied: true } (new ledger entry)", async () => {
    const evt = makeLibrarianEvent({
      idempotencyKey: "librarian:test-prompt-apply1:save",
      payload: {
        fullNote: true,
        notePath: "Prompts/test-prompt-apply1.md",
        noteBody: "---\ntitle: T\n---\nBody",
      },
    });
    expect(await applyEvent(db, evt)).toEqual({ applied: true });
  });

  it("second apply of the SAME event returns { applied: false } (replay no-op)", async () => {
    const evt = makeLibrarianEvent({
      idempotencyKey: "librarian:test-prompt-replay:save",
      payload: {
        fullNote: true,
        notePath: "Prompts/test-prompt-replay.md",
        noteBody: "---\ntitle: T\n---\nBody",
      },
    });

    expect(await applyEvent(db, evt)).toEqual({ applied: true });
    // Replay → the ledger key already exists → INSERT OR IGNORE no-ops → applied: false
    expect(await applyEvent(db, evt)).toEqual({ applied: false });
  });

  it("exactly ONE vault_outbox row for the idem after replay (no second write enqueued)", async () => {
    const idem = "librarian:test-prompt-outbox-count:save";
    const evt = makeLibrarianEvent({
      idempotencyKey: idem,
      payload: {
        fullNote: true,
        notePath: "Prompts/test-prompt-outbox-count.md",
        noteBody: "---\ntitle: T\n---\nBody",
      },
    });

    await applyEvent(db, evt); // first apply
    await applyEvent(db, evt); // replay

    const rows = await db
      .prepare("SELECT COUNT(*) AS c FROM vault_outbox WHERE idem = ?")
      .bind(idem)
      .first<{ c: number }>();
    // INSERT OR IGNORE on PK=idem → exactly ONE row, never two
    expect(rows?.c).toBe(1);
  });

  it("vault_outbox row has method=PUT and path=/vault/Prompts/<slug>.md (fullNote PUT branch)", async () => {
    const idem = "librarian:test-prompt-method-check:save";
    const evt = makeLibrarianEvent({
      idempotencyKey: idem,
      payload: {
        fullNote: true,
        notePath: "Prompts/test-prompt-method-check.md",
        noteBody: "---\ntitle: T\n---\nBody",
      },
    });

    await applyEvent(db, evt);

    const row = await db
      .prepare("SELECT method, path FROM vault_outbox WHERE idem = ?")
      .bind(idem)
      .first<{ method: string; path: string }>();

    // Confirms the 05-01 fullNote PUT branch is live in op-mapping
    expect(row?.method).toBe("PUT");
    expect(row?.path).toBe("/vault/Prompts/test-prompt-method-check.md");
  });

  it("replay does NOT create a second vault_outbox row (uses unchanged)", async () => {
    const idem = "librarian:test-prompt-no-second-row:save";
    const evt = makeLibrarianEvent({
      idempotencyKey: idem,
      payload: {
        fullNote: true,
        notePath: "Prompts/test-prompt-no-second-row.md",
        noteBody: "---\ntitle: T\n---\nBody",
      },
    });

    const first = await applyEvent(db, evt);
    const second = await applyEvent(db, evt);

    expect(first).toEqual({ applied: true });
    expect(second).toEqual({ applied: false });

    // Only one row in the outbox, not two
    const count = await db
      .prepare("SELECT COUNT(*) AS c FROM vault_outbox WHERE idem = ?")
      .bind(idem)
      .first<{ c: number }>();
    expect(count?.c).toBe(1);

    // Only one row in the idempotency_keys ledger
    const ledger = await db
      .prepare("SELECT COUNT(*) AS c FROM idempotency_keys WHERE key = ?")
      .bind(idem)
      .first<{ c: number }>();
    expect(ledger?.c).toBe(1);
  });

  it("dedupe-bump event (date+content-hash-suffixed key) is a DISTINCT ledger entry — applies once, upserts the SAME slug (no clone)", async () => {
    // First-save key (stable, no date): the canonical first-apply entry
    const firstSaveKey = "librarian:test-prompt-bump-test:save";
    const notePath = "Prompts/test-prompt-bump-test.md";
    // Bump key mirrors the production shape (CR-01): librarian:<slug>:save:<date>:<contentHash>
    // — a replay of the SAME content dedupes; same-day CHANGED content gets a distinct key.
    const bumpNoteBody =
      "---\ntitle: T\ntool: Claude\ntags: []\ncreated: 2026-06-09\nlast_used: 2026-06-09\nuses: 2\n---\nUpdated body.";
    const bumpKey = `librarian:test-prompt-bump-test:save:2026-06-09:${contentHash(bumpNoteBody)}`;

    const firstSave = makeLibrarianEvent({
      idempotencyKey: firstSaveKey,
      payload: {
        fullNote: true,
        notePath,
        noteBody: "---\ntitle: T\ntool: Claude\ntags: []\ncreated: 2026-06-09\nlast_used: 2026-06-09\nuses: 1\n---\nOriginal body.",
      },
    });

    const bumpSave = makeLibrarianEvent({
      idempotencyKey: bumpKey,
      payload: {
        fullNote: true,
        notePath, // SAME notePath — upsert on same slug, not a clone
        noteBody: bumpNoteBody,
      },
    });

    // First-save applies once
    expect(await applyEvent(db, firstSave)).toEqual({ applied: true });
    expect(await applyEvent(db, firstSave)).toEqual({ applied: false }); // replay = no-op

    // Bump key is DISTINCT from first-save key → applies independently
    expect(await applyEvent(db, bumpSave)).toEqual({ applied: true });
    expect(await applyEvent(db, bumpSave)).toEqual({ applied: false }); // bump replay = no-op

    // Two vault_outbox rows: one for first-save, one for the bump (distinct idem PKs)
    const outboxRows = await db
      .prepare("SELECT idem FROM vault_outbox WHERE idem IN (?, ?)")
      .bind(firstSaveKey, bumpKey)
      .all<{ idem: string }>();
    // Both rows present, each with a distinct idem
    expect(outboxRows.results).toHaveLength(2);

    // Both outbox rows point to the SAME notePath → upsert, not clone
    const outboxPaths = await db
      .prepare("SELECT path FROM vault_outbox WHERE idem IN (?, ?)")
      .bind(firstSaveKey, bumpKey)
      .all<{ path: string }>();
    const uniquePaths = new Set(outboxPaths.results.map((r) => r.path));
    expect(uniquePaths.size).toBe(1); // one unique path = same note, no clone
    expect([...uniquePaths][0]).toBe(`/vault/${notePath}`);

    // Two distinct entries in the idempotency_keys ledger
    const ledgerCount = await db
      .prepare("SELECT COUNT(*) AS c FROM idempotency_keys WHERE key IN (?, ?)")
      .bind(firstSaveKey, bumpKey)
      .first<{ c: number }>();
    expect(ledgerCount?.c).toBe(2);
  });
});
