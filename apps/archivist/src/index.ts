// apps/archivist/src/index.ts
//
// Archivist Worker entrypoint — cloud Workflow triggered after meeting end.
// Archivist processes a diarized transcript → structures into meeting notes →
// emits one Steward upsert + one Forge action-item per owner action item.
//
// Feature implementation lands in Plan 03-04 (full Workflow body).
// This shell establishes the Worker entrypoint + ArchivistWorkflow export.

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ArchivistEnv } from "./env.js";

// ArchivistWorkflow payload — session_id is the stable structured key linking
// the meeting session to the D1 meetings row + R2 transcript blob.
export type ArchivistPayload = { session_id: string };

// ─────────────────────────────────────────────────────────────────────────────
// ArchivistWorkflow — WorkflowEntrypoint triggered after a meeting ends.
//
// Triggered by Atlas as:
//   env.ARCHIVIST_WF.create({
//     id: `archivist-${session_id}`,
//     params: { session_id },
//   });
//
// Steps (implementation in Plan 03-04):
//   1. fetch-transcript — read from R2 transcripts/<session_id>.json; consent check
//   2. fetch-context   — read Codex work context + prior meeting notes
//   3. structure-notes — Opus pass to produce structured meeting note (D5: explicit effort)
//   4. emit-steward    — Wire upsert to Steward (meeting.note, idempotencyKey: archivist:<sid>:note)
//   5. emit-action-items — Wire upsert per owner action item (archivist:<series>:<date>:ai-NN)
// ─────────────────────────────────────────────────────────────────────────────
export class ArchivistWorkflow extends WorkflowEntrypoint<
  ArchivistEnv,
  ArchivistPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<ArchivistPayload>>,
    _step: WorkflowStep,
  ): Promise<void> {
    // Stub — full Workflow orchestration in Plan 03-04.
    // session_id is the stable key (never mutate event.payload inside a step).
    const { session_id } = event.payload;
    void session_id; // referenced to satisfy linter; used in full implementation
  }
}

// Default fetch handler — Archivist runs as a Workflow; no HTTP surface except health.
export default {
  fetch(): Response {
    return new Response(
      "Archivist runs as a Workflow triggered by Atlas on meeting end.",
      { status: 200 },
    );
  },
} satisfies ExportedHandler<ArchivistEnv>;
