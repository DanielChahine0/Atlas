// apps/archivist/src/env.ts
//
// Env type for the Archivist Worker. Declares all Cloudflare bindings used by this Worker.
// Archivist is a WorkflowEntrypoint (Opus pass) triggered after meeting end.
// Model tier: Archivist → claude-opus-4-8 via claudeFor("archivist", env) (D5).

export interface ArchivistEnv {
  // ARCHIVIST_WF — Workflow binding. Atlas triggers ArchivistWorkflow instances
  // after each meeting ends via env.ARCHIVIST_WF.create({ id, params }).
  // Instance id = "archivist-<session_id>" (stable, structured, never randomUUID).
  ARCHIVIST_WF: Workflow;

  // Wire PRODUCER binding (atlas-wire). Archivist produces meeting.note (upsert) +
  // action-item (upsert per owner action item) events.
  // Archivist is a PRODUCER ONLY — NO consumer binding (Pillar 1; a second
  // atlas-wire consumer is a hard CI failure).
  WIRE: Queue;

  // Incidents producer (atlas-incidents). Archivist routes incidents via flag()
  // which enqueues to atlas-incidents (D2-05). Flagger is the sole consumer.
  INCIDENTS: Queue;

  // D1 — system-of-record. Archivist reads the meetings table (0006) to verify
  // consent + session state before processing.
  // Positional ? params only (CLAUDE.md D1 gotcha).
  DB: D1Database;

  // CONFIG KV — model-tier overrides, Archivist knobs (prior_notes_window,
  // action_item_confidence, emit_others_actions, note_status). Never secrets.
  CONFIG: KVNamespace;

  // BLOBS R2 — Archivist reads transcript from R2 (transcripts/<session_id>.json)
  // in step 1 of the Workflow. transcript_r2_key is the pointer stored in D1.
  BLOBS: R2Bucket;

  // Workers AI binding — all Claude routes through claudeFor(agent,env) -> AI Gateway.
  // Archivist uses the atlas-reasoning gateway (Opus = reasoning tier, not highvolume).
  AI: Ai;

  // Forge service binding — Archivist creates owner action items via Forge.createTask RPC.
  // Archivist NEVER writes the tasks table directly (Pillar 1 / T-02-hh3).
  // Same pattern as Headhunter (closed in quick-260606-c24).
  FORGE: Fetcher;

  // PLAINTEXT non-secret vars (CLAUDE.md: model tier in [vars], never in code).
  AIG_ACCOUNT_ID: string;
  AIG_GATEWAY_ID: string;    // "atlas-reasoning" (Opus = reasoning gateway)
  MODEL_ARCHIVIST: string;   // "claude-opus-4-8" (D5: set explicitly in vars, never hardcoded)
}
