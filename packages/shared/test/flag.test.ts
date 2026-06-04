import { describe, it, expect, vi } from "vitest";
import { WireEvent } from "@atlas/wire";
import { flag, writeRunLog } from "../src/index.js";

describe("flag() — the canonical Flagger-emit helper", () => {
  it("builds an op:'upsert'/entity:'flag' event and emits it via the wire send() helper", async () => {
    const WIRE = { send: vi.fn().mockResolvedValue(undefined) };
    await flag({ WIRE } as never, "P3", "malformed wire event", "bad shape");

    expect(WIRE.send).toHaveBeenCalledTimes(1);
    const event = WIRE.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.type).toBe("flag");
    expect(event.entity).toBe("flag");
    expect(event.op).toBe("upsert");

    const payload = event.payload as Record<string, unknown>;
    expect(payload.severity).toBe("P3");
    expect(payload.title).toBe("malformed wire event");
    expect(payload.status).toBe("open");
    // source_agent === top-level agent (the emitter); defaults to "Atlas".
    expect(payload.source_agent).toBe("Atlas");
    expect(event.agent).toBe(payload.source_agent);
  });

  it("the event flag() builds is a valid §6.4 WireEvent (parses the captured WIRE.send arg)", async () => {
    const WIRE = { send: vi.fn().mockResolvedValue(undefined) };
    await flag({ WIRE } as never, "P2", "steward write failing");
    const event = WIRE.send.mock.calls[0]![0];
    expect(() => WireEvent.parse(event)).not.toThrow();
  });

  it("idempotencyKey === payload.id, a STRUCTURED non-random flg:<date>:<agent>:<hash>", async () => {
    const WIRE = { send: vi.fn().mockResolvedValue(undefined) };
    await flag({ WIRE } as never, "P1", "heartbeat stale", undefined, { sourceAgent: "Atlas" });
    const event = WIRE.send.mock.calls[0]![0] as Record<string, unknown>;
    const payload = event.payload as Record<string, unknown>;
    expect(event.idempotencyKey).toBe(payload.id);
    expect(event.idempotencyKey).toMatch(/^flg:\d{4}-\d{2}-\d{2}:Atlas:/);
  });

  it("is replay-safe: two calls describing the same incident produce the SAME id (one row)", async () => {
    const WIRE = { send: vi.fn().mockResolvedValue(undefined) };
    await flag({ WIRE } as never, "P3", "drift detected", "counter X");
    await flag({ WIRE } as never, "P3", "drift detected", "counter X");
    const id1 = (WIRE.send.mock.calls[0]![0] as Record<string, unknown>).idempotencyKey;
    const id2 = (WIRE.send.mock.calls[1]![0] as Record<string, unknown>).idempotencyKey;
    expect(id1).toBe(id2);
  });

  it("carries the default trust per severity (P1 → 100)", async () => {
    const WIRE = { send: vi.fn().mockResolvedValue(undefined) };
    await flag({ WIRE } as never, "P1", "critical");
    const payload = (WIRE.send.mock.calls[0]![0] as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.trust).toBe(100);
  });
});

describe("writeRunLog() — positional-? run_log helper", () => {
  it("inserts one run_log row via a positional-? prepared statement on env.DB", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const DB = { prepare } as unknown as D1Database;

    await writeRunLog({ DB }, {
      agent: "Filer",
      type: "sweep",
      entity: "email",
      op: "increment",
      rows_read: 42,
      duration_ms: 1200,
      result: "ok",
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    const sql = prepare.mock.calls[0]![0] as string;
    expect(sql).toContain("run_log");
    expect(sql).toContain("duration_ms");
    // positional ? only — no named/numbered params
    expect(sql).not.toMatch(/\?[0-9]|:[a-zA-Z]/);
    expect(run).toHaveBeenCalledTimes(1);
    // ts is appended (9 bind args: 8 columns + ts)
    expect((bind.mock.calls[0] as unknown[]).length).toBe(9);
  });
});
