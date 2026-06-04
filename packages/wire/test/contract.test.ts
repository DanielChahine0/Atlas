import { describe, it, expect, vi } from "vitest";
import { WireEvent, send } from "../src/index.js";

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
