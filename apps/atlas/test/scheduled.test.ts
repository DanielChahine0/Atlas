import { describe, it, expect, vi } from "vitest";
import { WireEvent } from "@atlas/wire";
import worker, { type Env } from "../src/index.js";

// SPINE-01 / Wire-contract test (CLAUDE.md Definition of Done #1).
//
// Drives the scheduled() dispatcher for the 07:45-ET Filer-sweep cron and asserts the
// end-to-end SPINE-01 leg: a cron tick invokes the no-op agent over the service binding
// (D-11), THEN routes EXACTLY ONE canonical §6.4 event onto the Wire whose shape validates
// against the 00-02 WireEvent zod schema (agent "Atlas", op "append", structured
// idempotencyKey atlas:noop:<YYYY-MM-DD>).
//
// Capture mechanism: spy env.WIRE.send + env.NOOP.tick on a synthetic Env (the pattern
// the 00-02 wire send() test establishes — packages/wire/test/contract.test.ts). This is
// fully deterministic in workerd and lets us assert BOTH the emitted shape AND the
// tick-before-send call order. The pool forces TZ=UTC, so we assert the idempotencyKey's
// structured regex shape, never a specific calendar date.

const FILER_SWEEP_CRON = "45 12 * * *"; // EST form of 07:45 ET (D-06)

function makeController(cron: string): ScheduledController {
  return {
    cron,
    scheduledTime: Date.now(),
    noRetry() {},
  } as ScheduledController;
}

function makeCtx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as ExecutionContext;
}

describe("Atlas scheduled() dispatcher — SPINE-01", () => {
  it("invokes the no-op agent (D-11) BEFORE routing onto the Wire, exactly once", async () => {
    const callOrder: string[] = [];
    const tick = vi.fn(async () => {
      callOrder.push("tick");
      return { ok: true as const, at: Date.now() };
    });
    const sentEvents: unknown[] = [];
    const wireSend = vi.fn(async (e: unknown) => {
      callOrder.push("send");
      sentEvents.push(e);
    });

    const env = {
      NOOP: { tick },
      WIRE: { send: wireSend },
    } as unknown as Env;

    await worker.scheduled!(makeController(FILER_SWEEP_CRON), env, makeCtx());

    // The no-op agent ran exactly once, and BEFORE the Wire send (D-11 schedule->invoke leg).
    expect(tick).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["tick", "send"]);

    // Exactly one event reached the Wire.
    expect(wireSend).toHaveBeenCalledTimes(1);
    expect(sentEvents).toHaveLength(1);
  });

  it("routes a canonical §6.4 event that validates against the 00-02 WireEvent schema", async () => {
    let captured: unknown;
    const env = {
      NOOP: { tick: vi.fn(async () => ({ ok: true as const, at: Date.now() })) },
      WIRE: { send: vi.fn(async (e: unknown) => { captured = e; }) },
    } as unknown as Env;

    await worker.scheduled!(makeController(FILER_SWEEP_CRON), env, makeCtx());

    // Wire-contract test: the emitted event parses cleanly against the single §6.4 schema.
    const parsed = WireEvent.parse(captured);
    expect(parsed.agent).toBe("Atlas");
    expect(parsed.op).toBe("append");
    expect(parsed.type).toBe("noop.tick");
    expect(parsed.entity).toBe("spine");
    // Structured, date-derived idempotency key — NOT a random per-run UUID.
    expect(parsed.idempotencyKey).toMatch(/^atlas:noop:\d{4}-\d{2}-\d{2}$/);
  });

  it("does nothing for an unknown cron (dispatcher routes ONLY known crons, T-00-32)", async () => {
    const tick = vi.fn(async () => ({ ok: true as const, at: Date.now() }));
    const wireSend = vi.fn(async () => {});
    const env = { NOOP: { tick }, WIRE: { send: wireSend } } as unknown as Env;

    await worker.scheduled!(makeController("0 0 * * *"), env, makeCtx());

    expect(tick).not.toHaveBeenCalled();
    expect(wireSend).not.toHaveBeenCalled();
  });
});
