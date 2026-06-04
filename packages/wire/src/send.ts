import { WireEvent } from "./contract.js";

/**
 * The canonical Wire PRODUCER helper. Every agent except Steward emits via `send`.
 *
 * `WireEvent.parse(event)` runs FIRST — a malformed event is rejected at the producer
 * boundary (it THROWS) before it can ever reach the at-least-once `atlas-wire` Queue.
 * This is the first belt of the malformed-event defense (T-00-21); the consumer's
 * malformed→ack+P3 path in 00-04 is the second belt.
 *
 * The Queue producer binding is `WIRE` (CLAUDE.md canonical binding table). We type only
 * the surface we use (`{ WIRE: Queue<WireEvent> }`) so any Worker's full `Env` satisfies it.
 */
export async function send(
  env: { WIRE: Queue<WireEvent> },
  event: WireEvent,
): Promise<void> {
  const parsed = WireEvent.parse(event);
  await env.WIRE.send(parsed);
}
