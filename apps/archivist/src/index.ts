// apps/archivist/src/index.ts
//
// Archivist Worker entrypoint — cloud Workflow triggered after meeting end.
// Archivist processes a diarized transcript → structures into meeting notes →
// emits one Steward upsert + one Forge action-item per owner action item.

import type { ArchivistEnv } from "./env.js";

// Re-export the ArchivistWorkflow for wrangler to pick up as the Workflow class.
export { ArchivistWorkflow } from "./archivist.js";

// Default fetch handler — Archivist runs as a Workflow; no HTTP surface except health.
export default {
  fetch(): Response {
    return new Response(
      "Archivist runs as a Workflow triggered by Atlas on meeting end.",
      { status: 200 },
    );
  },
} satisfies ExportedHandler<ArchivistEnv>;
