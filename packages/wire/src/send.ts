import { WireEvent } from "./contract.js";

/**
 * The hard Cloudflare Queues per-message size cap (CLAUDE.md: "Wire message cap is 128 KB").
 * We enforce it at the producer boundary so an oversized payload fails LOUDLY here with a
 * clear, named error — NOT as an opaque Queue rejection downstream. We measure the full
 * encoded JSON (the bytes the Queue actually carries), not just `payload`, since the §6.4
 * envelope (agent/type/entity/op/idempotencyKey) also counts toward the limit.
 */
export const WIRE_MAX_BYTES = 128 * 1024;

/**
 * Thrown when a parsed Wire event's encoded size exceeds {@link WIRE_MAX_BYTES}. A typed
 * error (not a bare string) so callers can `instanceof`-discriminate the size failure from
 * a zod parse failure. We NEVER silently truncate — a dropped/garbled event is worse than a
 * loud failure the emitter can see and split.
 */
export class WireEventTooLargeError extends Error {
  readonly byteLength: number;
  readonly maxBytes: number;
  constructor(byteLength: number, maxBytes: number) {
    super(
      `Wire event is ${byteLength} bytes, exceeding the ${maxBytes}-byte (128 KB) ` +
        `atlas-wire message cap. Split the payload or store the blob in R2 and reference it.`,
    );
    this.name = "WireEventTooLargeError";
    this.byteLength = byteLength;
    this.maxBytes = maxBytes;
  }
}

/**
 * The canonical Wire PRODUCER helper. Every agent except Steward emits via `send`.
 *
 * `WireEvent.parse(event)` runs FIRST — a malformed event is rejected at the producer
 * boundary (it THROWS) before it can ever reach the at-least-once `atlas-wire` Queue.
 * This is the first belt of the malformed-event defense (T-00-21); the consumer's
 * malformed→ack+P3 path in 00-04 is the second belt.
 *
 * After parse, the encoded size is checked against the 128 KB Queue cap — an oversized event
 * throws {@link WireEventTooLargeError} BEFORE the Queue send (never a silent truncation; an
 * opaque Queue rejection downstream is harder to diagnose than this named, sized error).
 *
 * The Queue producer binding is `WIRE` (CLAUDE.md canonical binding table). We type only
 * the surface we use (`{ WIRE: Queue<WireEvent> }`) so any Worker's full `Env` satisfies it.
 */
export async function send(
  env: { WIRE: Queue<WireEvent> },
  event: WireEvent,
): Promise<void> {
  const parsed = WireEvent.parse(event);
  const byteLength = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
  if (byteLength > WIRE_MAX_BYTES) {
    throw new WireEventTooLargeError(byteLength, WIRE_MAX_BYTES);
  }
  await env.WIRE.send(parsed);
}
