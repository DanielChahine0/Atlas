/**
 * index.ts — Gate lifecycle: openGate / getGate / decideGate / sweepExpired (D4-04).
 *
 * Implementation: Task 3.
 * This file is a placeholder that will be implemented in Task 3.
 */

export type { GateOptions, GateRecord, GatePendingRow } from "./schema.js";
export { sha256, timingSafeEqual } from "./auth.js";
export { buildConfirmPush } from "./push.js";
export {
  renderConfirmPage,
  renderOutcomePage,
  renderExpiredPage,
  authHtmlResponse,
  authResponse,
  isSameOrigin,
  AUTH_SECURITY_HEADERS,
} from "./render.js";

// Task 3 will implement these:
export async function openGate(..._args: unknown[]): Promise<never> {
  throw new Error("openGate not yet implemented — see Task 3");
}

export async function getGate(..._args: unknown[]): Promise<null> {
  throw new Error("getGate not yet implemented — see Task 3");
}

export async function decideGate(..._args: unknown[]): Promise<void> {
  throw new Error("decideGate not yet implemented — see Task 3");
}

export async function sweepExpired(..._args: unknown[]): Promise<number> {
  throw new Error("sweepExpired not yet implemented — see Task 3");
}
