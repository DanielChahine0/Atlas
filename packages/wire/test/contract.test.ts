import { describe, it, expect, vi } from "vitest";
import { WireEvent, send, WIRE_MAX_BYTES, WireEventTooLargeError } from "../src/index.js";

// The mandatory Wire-contract test (CLAUDE.md Definition of Done #1): proves the §6.4
// shape + structured idempotencyKey, and that the producer helper parses before it sends.

describe("WireEvent §6.4 contract", () => {
  const validIncrement = {
    agent: "Forge",
    type: "task.created",
    entity: "tasks",
    op: "increment",
    payload: { counter: "tasks_open", delta: 1 },
    idempotencyKey: "forge:task:2026-05-31:abc",
  };

  it("parses a valid increment event without throwing", () => {
    expect(() => WireEvent.parse(validIncrement)).not.toThrow();
    const evt = WireEvent.parse(validIncrement);
    expect(evt.op).toBe("increment");
  });

  it("requires a STRUCTURED idempotencyKey (forge:task:<date>:<hash> shape)", () => {
    const evt = WireEvent.parse(validIncrement);
    // structured + date-derived, never crypto.randomUUID()
    expect(evt.idempotencyKey).toMatch(/^forge:task:\d{4}-\d{2}-\d{2}:/);
  });

  it("accepts all three canonical ops", () => {
    for (const op of ["increment", "upsert", "append"] as const) {
      expect(() => WireEvent.parse({ ...validIncrement, op })).not.toThrow();
    }
  });

  it("rejects an op outside the enum (e.g. delete)", () => {
    expect(() => WireEvent.parse({ ...validIncrement, op: "delete" })).toThrow();
  });

  it("rejects an empty-string idempotencyKey", () => {
    expect(() => WireEvent.parse({ ...validIncrement, idempotencyKey: "" })).toThrow();
  });

  it("rejects an event missing `agent`", () => {
    const { agent: _agent, ...noAgent } = validIncrement;
    expect(() => WireEvent.parse(noAgent)).toThrow();
  });
});

describe("send() producer helper", () => {
  const validEvent = {
    agent: "Atlas",
    type: "noop.tick",
    entity: "spine",
    op: "append" as const,
    payload: { note: "phase-0 smoke" },
    idempotencyKey: "atlas:noop:2026-06-04",
  };

  it("calls env.WIRE.send exactly once with the parsed event for a valid event", async () => {
    const WIRE = { send: vi.fn().mockResolvedValue(undefined) };
    await send({ WIRE } as never, validEvent);
    expect(WIRE.send).toHaveBeenCalledTimes(1);
    expect(WIRE.send).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "Atlas", op: "append", idempotencyKey: "atlas:noop:2026-06-04" }),
    );
  });

  it("throws (parse) and does NOT call WIRE.send for a malformed event", async () => {
    const WIRE = { send: vi.fn().mockResolvedValue(undefined) };
    const malformed = { ...validEvent, op: "delete" };
    await expect(send({ WIRE } as never, malformed as never)).rejects.toThrow();
    expect(WIRE.send).not.toHaveBeenCalled();
  });
});

describe("send() enforces the 128 KB Wire cap (W11)", () => {
  it("throws a typed WireEventTooLargeError naming the limit — never silently truncating or sending", async () => {
    const WIRE = { send: vi.fn().mockResolvedValue(undefined) };
    // Build an event whose encoded JSON clears the 128 KB cap (string > WIRE_MAX_BYTES).
    const oversized = {
      agent: "Atlas",
      type: "noop.tick",
      entity: "spine",
      op: "append" as const,
      payload: { blob: "x".repeat(WIRE_MAX_BYTES + 1) },
      idempotencyKey: "atlas:noop:2026-06-04",
    };

    const err = await send({ WIRE } as never, oversized).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WireEventTooLargeError);
    const tooLarge = err as WireEventTooLargeError;
    expect(tooLarge.maxBytes).toBe(WIRE_MAX_BYTES);
    expect(tooLarge.byteLength).toBeGreaterThan(WIRE_MAX_BYTES);
    expect(tooLarge.message).toContain("128 KB");
    // No silent truncation: the oversized event NEVER reaches the Queue.
    expect(WIRE.send).not.toHaveBeenCalled();
  });

  it("sends a normal (sub-cap) event fine", async () => {
    const WIRE = { send: vi.fn().mockResolvedValue(undefined) };
    const normal = {
      agent: "Atlas",
      type: "noop.tick",
      entity: "spine",
      op: "append" as const,
      payload: { note: "phase-0 smoke" },
      idempotencyKey: "atlas:noop:2026-06-04",
    };
    await send({ WIRE } as never, normal);
    expect(WIRE.send).toHaveBeenCalledTimes(1);
  });

  it("allows an event right at the boundary (≤ cap) and rejects one byte over", async () => {
    const WIRE = { send: vi.fn().mockResolvedValue(undefined) };
    // Probe the envelope overhead, then size payload so total === WIRE_MAX_BYTES exactly.
    const base = {
      agent: "Atlas",
      type: "noop.tick",
      entity: "spine",
      op: "append" as const,
      payload: { blob: "" },
      idempotencyKey: "atlas:noop:2026-06-04",
    };
    const overhead = new TextEncoder().encode(JSON.stringify(base)).byteLength;
    const atCap = { ...base, payload: { blob: "x".repeat(WIRE_MAX_BYTES - overhead) } };
    expect(new TextEncoder().encode(JSON.stringify(atCap)).byteLength).toBe(WIRE_MAX_BYTES);
    await expect(send({ WIRE } as never, atCap)).resolves.toBeUndefined();
    expect(WIRE.send).toHaveBeenCalledTimes(1);

    const overCap = { ...base, payload: { blob: "x".repeat(WIRE_MAX_BYTES - overhead + 1) } };
    await expect(send({ WIRE } as never, overCap)).rejects.toBeInstanceOf(WireEventTooLargeError);
    expect(WIRE.send).toHaveBeenCalledTimes(1); // still one — the over-cap event was rejected
  });
});
