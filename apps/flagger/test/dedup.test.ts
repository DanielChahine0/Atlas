/**
 * dedup.test.ts — FlaggerState signature-deduplication tests (WEEKLY-02, Plan 02-02 Task 1).
 *
 * Verifies that upsertFlag with the same signature returns ONE flag id with recurrence
 * incremented on the second call, and that getBySignature returns that single row.
 *
 * Also covers L3 gap-closure: resolveFlag/muteFlag mirror status to D1 (same as ackFlag).
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/index.js";
import { FlaggerState } from "../src/state.js";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal Flagger env with a spied INCIDENTS.send for alarm tests. */
function makeEnv(): Env {
  return {
    ...(env as unknown as Env),
    INCIDENTS: {
      send: vi.fn(async () => {}),
    } as unknown as Queue<import("@atlas/shared").RawIncident>,
    FLAGGER_STATE: (env as unknown as Env).FLAGGER_STATE,
  };
}

/** Directly instantiate a FlaggerState DO with injected env for unit tests. */
function makeState(e: Env): FlaggerState {
  const ctx = (env as unknown as { __DO_CONTEXT__?: DurableObjectState }).__DO_CONTEXT__;
  // Use real DO storage from cloudflare:test via getByName
  const stub = e.FLAGGER_STATE.getByName("fleet");
  return stub as unknown as FlaggerState;
}

describe("FlaggerState.upsertFlag — signature-based deduplication", () => {
  it("same signature → one flag id with recurrence incremented on second upsert", async () => {
    const e = makeEnv();
    const state = e.FLAGGER_STATE.getByName("fleet") as unknown as FlaggerState;

    const partial = {
      source_agent: "Forge",
      kind: "model_error",
      severity: "P2" as const,
      trust: 90,
      title: "Forge task extraction failed",
      detail: "timeout",
      status: "open" as const,
    };

    const first = await state.upsertFlag("forge:model_error:abc123", partial);
    expect(first.id).toMatch(/^flg:/);
    expect(first.recurrence).toBe(0);

    const second = await state.upsertFlag("forge:model_error:abc123", partial);
    // Same signature → same id, recurrence bumped
    expect(second.id).toBe(first.id);
    expect(second.recurrence).toBe(1);
  });

  it("different signatures → different flag ids (no cross-contamination)", async () => {
    const e = makeEnv();
    const state = e.FLAGGER_STATE.getByName("fleet") as unknown as FlaggerState;

    // Use different titles so the content hash differs (different content = different flag id)
    const partialA = {
      source_agent: "Herald",
      kind: "model_error",
      severity: "P3" as const,
      trust: 50,
      title: "Herald model error occurred",
      status: "open" as const,
    };
    const partialB = {
      source_agent: "Herald",
      kind: "calendar_sync_failed",
      severity: "P3" as const,
      trust: 50,
      title: "Herald calendar sync failed",
      status: "open" as const,
    };

    const a = await state.upsertFlag("herald:model_error:x1", partialA);
    const b = await state.upsertFlag("herald:calendar_sync_failed:x2", partialB);

    expect(a.id).not.toBe(b.id);
  });

  it("getBySignature returns the existing flag row", async () => {
    const e = makeEnv();
    const state = e.FLAGGER_STATE.getByName("fleet") as unknown as FlaggerState;

    const partial = {
      source_agent: "Sundial",
      kind: "calendar_sync_failed",
      severity: "P2" as const,
      trust: 80,
      title: "Sundial calendar sync failed",
      status: "open" as const,
    };

    const created = await state.upsertFlag("sundial:calendar_sync_failed:x3", partial);
    const fetched = await state.getBySignature("sundial:calendar_sync_failed:x3");

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.title).toBe(partial.title);
  });

  it("ackFlag sets status to 'ack'", async () => {
    const e = makeEnv();
    const state = e.FLAGGER_STATE.getByName("fleet") as unknown as FlaggerState;

    const partial = {
      source_agent: "Forge",
      kind: "chain_halted",
      severity: "P1" as const,
      trust: 100,
      title: "Critical Forge failure",
      status: "open" as const,
    };

    const flag = await state.upsertFlag("forge:chain_halted:x4", partial);
    await state.ackFlag(flag.id);
    const fetched = await state.getBySignature("forge:chain_halted:x4");

    expect(fetched!.status).toBe("ack");
  });

  // L3 gap-closure: resolveFlag and muteFlag must mirror status to D1 (not just DO storage)
  it("L3: resolveFlag mirrors resolved status to D1 flags table", async () => {
    const e = makeEnv();
    const state = e.FLAGGER_STATE.getByName("fleet") as unknown as FlaggerState;

    const partial = {
      source_agent: "Scout",
      kind: "model_error",
      severity: "P3" as const,
      trust: 60,
      title: "Scout model error resolved",
      status: "open" as const,
    };

    const flag = await state.upsertFlag("scout:model_error:l3resolve", partial);
    await state.resolveFlag(flag.id);

    // Verify D1 row reflects resolved status
    const row = await e.DB.prepare("SELECT status FROM flags WHERE id = ?")
      .bind(flag.id)
      .first<{ status: string }>();
    expect(row).not.toBeNull();
    expect(row!.status).toBe("resolved");
  });

  it("L3: muteFlag mirrors muted status to D1 flags table", async () => {
    const e = makeEnv();
    const state = e.FLAGGER_STATE.getByName("fleet") as unknown as FlaggerState;

    const partial = {
      source_agent: "Compass",
      kind: "overcommit",
      severity: "P4" as const,
      trust: 70,
      title: "Compass overcommit muted",
      status: "open" as const,
    };

    const flag = await state.upsertFlag("compass:overcommit:l3mute", partial);
    await state.muteFlag(flag.id);

    // Verify D1 row reflects muted status
    const row = await e.DB.prepare("SELECT status FROM flags WHERE id = ?")
      .bind(flag.id)
      .first<{ status: string }>();
    expect(row).not.toBeNull();
    expect(row!.status).toBe("muted");
  });
});
