import { z } from "zod";

/**
 * The single canonical §6.4 Wire event schema (SPEC-CANON §6.4 / docs/13-build-plan.md §5.1).
 *
 * THIS IS THE ONLY DEFINITION OF THE WIRE SHAPE IN THE REPO. Every producer (Atlas in
 * 00-03, every Phase-1+ agent) and the sole consumer (Steward, 00-04) import `WireEvent`
 * from `@atlas/wire`. Never re-declare this object/enum anywhere else — the build-plan
 * acceptance #6 CI gate greps that `op: z.enum(["increment", "upsert", "append"])` appears
 * in exactly one file (this one).
 *
 *   op semantics (CLAUDE.md Wire contract):
 *     increment → counters / metrics   (absolute math in D1; replay-safe via the ledger)
 *     upsert    → stable-row views     (kanban, CRM, flag rows — last-writer-wins)
 *     append    → feeds                (Flagger feed, run-log, quick-capture)
 *
 *   idempotencyKey MUST be STABLE + STRUCTURED (e.g. `forge:task:<date>:<hash>`),
 *   NEVER `crypto.randomUUID()` for scheduled work — a replay must re-derive the same key.
 *
 * NOTE (zod-4 API): the build-plan/PATTERNS snippet shows `z.record(z.unknown())` (the
 * zod-3 single-arg form). zod 4 (the resolved version, 4.4.3) requires the explicit
 * key+value form `z.record(z.string(), z.unknown())` or strict TS errors with
 * "Expected 2-3 arguments, but got 1". The inferred type is identical
 * (`Record<string, unknown>`). See 00-02-SUMMARY deviation [Rule 3].
 */
export const WireEvent = z.object({
  agent: z.string(),
  type: z.string(),
  entity: z.string(),
  op: z.enum(["increment", "upsert", "append"]),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1),
});

export type WireEvent = z.infer<typeof WireEvent>;
