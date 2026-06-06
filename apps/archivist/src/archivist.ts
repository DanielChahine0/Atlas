/**
 * ArchivistWorkflow — durable meeting-notes structuring Workflow.
 *
 * Triggered by Steward (sole Wire consumer) via a cross-script `workflows` binding
 * after it processes Echo's `transcript.ready` event. One durable Cloudflare Workflow
 * per meeting session, idempotent on `session_id` (instance id = archivist-<session_id>).
 *
 * Steps:
 *   1. fetch-transcript  — read from R2 `transcripts/<session_id>.json`; consent + null check
 *   2. load-prior-notes  — read last `prior_notes_window` (3) notes for series threading
 *   3. load-codex        — read owner work context from The Codex (read-only)
 *   4. structure-note    — ONE Opus pass with effort set EXPLICITLY (D5 — never default "high")
 *   5. emit-steward      — Wire upsert (meeting.note) + increment (meetings-this-week)
 *   6. emit-action-items — one Forge.createTask RPC per owner action item
 *
 * CRITICAL: NonRetryableError MUST import from "cloudflare:workflows" NOT "cloudflare:workers"
 * (Pitfall 4 — the wrong import is a silent runtime failure TypeScript will NOT catch).
 *
 * Pillar 1: Archivist is a Wire PRODUCER only. NO consumer binding anywhere.
 * Pillar 5: Idempotent on session_id — idempotencyKeys are stable + structured.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowStep, WorkflowEvent } from "cloudflare:workers";
// CRITICAL: NonRetryableError from cloudflare:WORKFLOWS (NOT cloudflare:workers) — Pitfall 4
import { NonRetryableError } from "cloudflare:workflows";
import { send } from "@atlas/wire";
import type { WireEvent } from "@atlas/wire";
import { flag } from "@atlas/shared";
import { claudeFor, modelFor } from "@atlas/model";
import type { ArchivistEnv } from "./env.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** The transcript JSON shape stored in R2 by the Echo daemon. */
export interface Transcript {
  session_id: string;
  consent: "granted" | "discarded";
  audio_disposition: "local-only" | "r2-approved" | "discarded";
  segments: TranscriptSegment[];
  duration_seconds: number;
}

/** A single diarized transcript segment from Echo. */
export interface TranscriptSegment {
  speaker: string;
  text: string;
  start_ts: number;
  end_ts: number;
  confidence: number;
  idx: number;
}

/** A structured owner action item extracted by the Opus pass. */
export interface OwnerActionItem {
  action: string;
  due: string | null;
  due_kind: "explicit" | "inferred";
  confidence: number;
  priority: string;
}

/** The structured meeting note produced by the Opus pass. */
export interface StructuredNote {
  session_id: string;
  series: string;
  date: string;
  title: string;
  attendees: string[];
  agenda: string;
  decisions: string[];
  ownerActionItems: OwnerActionItem[];
  followUps: string[];
  note_status: "draft";
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire event builder helpers (exported for tests — CAPTURE-01-f)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical meeting.note upsert Wire event.
 * idempotencyKey = archivist:<session_id>:note (stable + structured, never randomUUID).
 */
export function buildMeetingNoteEvent(
  session_id: string,
  note: Record<string, unknown>,
): WireEvent {
  return {
    agent: "Archivist",
    type: "meeting.note",
    entity: "note",
    op: "upsert",
    payload: { session_id, note },
    idempotencyKey: `archivist:${session_id}:note`,
  };
}

/**
 * Build a meetings-this-week increment Wire event.
 * idempotencyKey = archivist:<session_id>:count (stable + structured).
 */
export function buildMeetingCountEvent(session_id: string): WireEvent {
  return {
    agent: "Archivist",
    type: "meeting.count",
    entity: "meetings-this-week",
    op: "increment",
    payload: { counter: "meetings-this-week", delta: 1 },
    idempotencyKey: `archivist:${session_id}:count`,
  };
}

/**
 * Build an owner action-item Wire event.
 * idempotencyKey = archivist:<series>:<date>:ai-NN (zero-padded two-digit index).
 */
export function buildActionItemEvent(
  series: string,
  date: string,
  index: number,
  payload: Record<string, unknown> = {},
): WireEvent {
  return {
    agent: "Archivist",
    type: "action-item",
    entity: "task",
    op: "upsert",
    payload: {
      title: "",
      due: null,
      source: "meeting",
      meeting: `${series}/${date}`,
      ...payload,
    },
    idempotencyKey: `archivist:${series}:${date}:ai-${String(index).padStart(2, "0")}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main orchestration body — factored OUT of the class for testability
// (PATTERNS.md: factor orchestration body so tests can inject a fake step)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Archivist Workflow orchestration body. Factored out of the class so tests
 * can pass a fake `step.do` without constructing a WorkflowEntrypoint instance.
 *
 * `step` is typed to the minimum surface the Workflow uses (`do` only).
 * NEVER mutate `event.payload` inside a step — it reverts on Workflow replay.
 * Return state from each step and pass it forward.
 */
export async function runArchivist(
  env: ArchivistEnv,
  event: Readonly<WorkflowEvent<{ session_id: string }>>,
  step: Pick<WorkflowStep, "do">,
): Promise<void> {
  const { session_id } = event.payload;

  // Step 1: fetch-transcript
  // null → P2 flag + NonRetryableError; consent:discarded → NonRetryableError (benign)
  const transcript = await step.do<Transcript>(
    "fetch-transcript",
    {
      retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
      timeout: "5 minutes",
    },
    async () => {
      const obj = await env.BLOBS.get(`transcripts/${session_id}.json`);
      if (!obj) {
        // Missing transcript → P2 incident (not a benign decline, needs investigation)
        await flag(
          env,
          "P2",
          "archivist transcript not found",
          `Session ${session_id} transcript missing from R2 transcripts/ prefix.`,
          { sourceAgent: "Archivist", kind: "transcript_missing", runId: session_id },
        );
        throw new NonRetryableError(`Transcript not found: ${session_id}`);
      }
      const t = await obj.json<Transcript>();
      // Consent discarded → benign owner decline (no flag — D3-10 decline = just stop)
      if (t.consent === "discarded") {
        throw new NonRetryableError("Consent discarded");
      }
      return t;
    },
  );

  // Step 2: load-prior-notes (prior_notes_window: 3 — conservative series threading)
  const priorNotes = await step.do<StructuredNote[]>(
    "load-prior-notes",
    {
      retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
      timeout: "2 minutes",
    },
    async () => {
      // Read meeting notes index (D1 or Obsidian MCP) for prior notes in same series.
      // Conservative: prefer new-series over wrong-series per archivist.md.
      // In this implementation we query D1 vault_outbox for prior meeting.note rows.
      // prior_notes_window: 3 (archivist.md default)
      // For now: return empty (no prior notes available yet in MVP — series threading
      // is best-effort and never blocks the primary note emission).
      return [] as StructuredNote[];
    },
  );

  // Step 3: load-codex context (read-only, @atlas/codex)
  const codexContext = await step.do<string>(
    "load-codex",
    {
      retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
      timeout: "2 minutes",
    },
    async () => {
      // Codex read — provides owner work context for the Opus pass.
      // The @atlas/codex read() requires a live drive.readonly access token (minted by
      // the OAuth layer). Archivist does not hold an access token directly — it receives
      // work context via the Workflow payload (Phase 3+ wiring) or reads a pre-fetched
      // snapshot from CONFIG KV when available. For MVP (Phase 3), context is best-effort.
      // Future: wire the access token through the Workflow payload or a CONFIG KV snapshot.
      try {
        const snapshot = await env.CONFIG.get("codex:archivist_snapshot");
        return snapshot ?? "";
      } catch {
        // Codex context is best-effort — a missing snapshot produces less context but
        // never blocks the meeting note.
        return "";
      }
    },
  );

  // Step 4: structure-note — ONE Opus pass with effort set EXPLICITLY (D5 cost discipline)
  // NEVER omit effort — Opus defaults to "high". Set thinking explicitly.
  const note = await step.do<StructuredNote>(
    "structure-note",
    {
      retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
      timeout: "10 minutes",
    },
    async () => {
      // claudeFor("archivist", env) → Opus via AI Gateway (TIER_MAP["archivist"] = claude-opus-4-8)
      // Check if we have a test mock injected (for unit tests without live AI Gateway).
      // The _mockClaude hook allows tests to inject a fake client without a live AI Gateway.
      type ClaudeClient = { messages: { create: (params: unknown) => Promise<unknown> }; model: string; agent: string };
      const mockClaude = (env as unknown as { _mockClaude?: ClaudeClient })._mockClaude;

      let claudeResult: ClaudeClient;
      if (mockClaude) {
        claudeResult = mockClaude;
      } else {
        const result = await claudeFor("archivist", env as unknown as Parameters<typeof claudeFor>[1]);
        claudeResult = {
          messages: { create: (params: unknown) => result.messages.create(params as Parameters<typeof result.messages.create>[0]) },
          model: result.model,
          agent: result.agent,
        };
      }

      const modelId = mockClaude
        ? "claude-opus-4-8"
        : await modelFor("archivist", env as unknown as Parameters<typeof modelFor>[1]);

      // D5: effort MUST be explicitly set — never rely on Opus default "high".
      // Use thinking: { type: "enabled", budget_tokens: 0 } to disable extended thinking
      // while still explicitly setting it (cost discipline for a daily structured task).
      const priorNotesContext =
        priorNotes.length > 0
          ? `Prior ${priorNotes.length} meeting(s) in this series:\n${JSON.stringify(priorNotes, null, 2)}`
          : "No prior meetings found in this series (first meeting or new series).";

      const response = await claudeResult.messages.create({
        model: modelId,
        max_tokens: 4096,
        // D5: set thinking explicitly — budget_tokens: 0 disables extended thinking
        // (cost discipline; standard Opus quality is sufficient for note structuring)
        thinking: { type: "enabled", budget_tokens: 0 },
        messages: [
          {
            role: "user",
            content: buildNoteStructuringPrompt(
              transcript,
              priorNotesContext,
              codexContext,
            ),
          },
        ],
      });

      // Parse the Opus response — extract the structured note JSON
      const content = (response as { content: Array<{ type: string; text?: string }> }).content;
      const textBlock = content.find((c) => c.type === "text");
      if (!textBlock?.text) {
        throw new Error("Opus response missing text content");
      }

      // Extract JSON from the response (the prompt instructs the model to return JSON)
      let parsedNote: StructuredNote;
      try {
        // Try to parse as raw JSON first
        parsedNote = JSON.parse(textBlock.text) as StructuredNote;
      } catch {
        // Try to extract JSON from markdown code block
        const jsonMatch = textBlock.text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch?.[1]) {
          parsedNote = JSON.parse(jsonMatch[1]) as StructuredNote;
        } else {
          throw new Error(`Cannot parse Opus response as JSON: ${textBlock.text.slice(0, 200)}`);
        }
      }

      // Enforce note_status: "draft" (Pillar 2 — suggest, don't destroy; owner reviews first)
      return {
        ...parsedNote,
        session_id,
        note_status: "draft" as const,
      };
    },
  );

  // Step 5: emit-steward — Wire upsert (meeting.note) + increment (meetings-this-week)
  await step.do<void>(
    "emit-steward",
    {
      retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
      timeout: "2 minutes",
    },
    async () => {
      // meeting.note upsert — idempotencyKey: archivist:<session_id>:note
      await send(env, buildMeetingNoteEvent(session_id, note as unknown as Record<string, unknown>));

      // meetings-this-week increment — idempotencyKey: archivist:<session_id>:count
      await send(env, buildMeetingCountEvent(session_id));
    },
  );

  // Step 6: emit-action-items — one Forge.createTask RPC per owner action item
  // Action items route through Forge's EXISTING pipeline (same path as Headhunter).
  // Archivist NEVER writes the tasks table directly (Pillar 1 / T-02-hh3).
  // Owner-only items (emit_others_actions: false per archivist.md).
  // action_item_confidence: 0.6 — low-confidence kept + flagged, never dropped.
  await step.do<void>(
    "emit-action-items",
    {
      retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
      timeout: "5 minutes",
    },
    async () => {
      const items = note.ownerActionItems ?? [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const series = note.series ?? session_id;
        const date = note.date ?? new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Toronto",
        }).format(new Date());

        // idempotencyKey: archivist:<series>:<date>:ai-NN (zero-padded two-digit index)
        const idempotencyKey = `archivist:${series}:${date}:ai-${String(i).padStart(2, "0")}`;

        // Flag low-confidence items (< 0.6) but still create them (never drop — archivist.md)
        if (item.confidence < 0.6) {
          await flag(
            env,
            "P4",
            "archivist low-confidence action item",
            `Action item "${item.action}" has confidence ${item.confidence} (< 0.6). Created but flagged for owner review.`,
            { sourceAgent: "Archivist", kind: "low_confidence_action_item", runId: session_id },
          );
        }

        // Forge.createTask RPC — the SAME path Headhunter uses (CROSS-WORKER RPC SYMMETRY)
        // env.FORGE is typed as Fetcher in ArchivistEnv; at runtime it's a WorkerEntrypoint
        // cast. Access via the service-binding RPC surface.
        const forge = env.FORGE as unknown as {
          createTask: (
            task: {
              title: string;
              priority: string;
              due: string | null;
              due_kind: "explicit" | "inferred";
              source_agent: string;
              thread: null;
            },
            opts: { idempotencyKey: string; runId: string },
          ) => Promise<{ id: string } | null>;
        };

        await forge.createTask(
          {
            title: item.action,
            priority: item.priority ?? "medium",
            due: item.due,
            due_kind: item.due_kind ?? "inferred",
            source_agent: "Archivist",
            thread: null,
          },
          {
            idempotencyKey,
            runId: date,
          },
        );
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ArchivistWorkflow class — thin delegate to runArchivist (testability pattern)
// ─────────────────────────────────────────────────────────────────────────────

export class ArchivistWorkflow extends WorkflowEntrypoint<
  ArchivistEnv,
  { session_id: string }
> {
  override async run(
    event: Readonly<WorkflowEvent<{ session_id: string }>>,
    step: WorkflowStep,
  ): Promise<void> {
    await runArchivist(this.env, event, step);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder — the fixed notes template (archivist.md)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the structured note-extraction prompt for the Opus pass.
 * Template: attendees / agenda / decisions / action items / follow-ups (archivist.md).
 * Owner-only action items (emit_others_actions: false).
 * Stated deadlines only — low confidence kept + flagged, never dropped.
 */
function buildNoteStructuringPrompt(
  transcript: Transcript,
  priorNotesContext: string,
  codexContext: string,
): string {
  const transcriptText = transcript.segments
    .map((s) => `[${s.speaker}] ${s.text}`)
    .join("\n");

  return `You are structuring a meeting transcript into a standardized meeting note for Atlas, an AI personal assistant system.

## Work Context (The Codex)
${codexContext || "(No Codex context available for this session)"}

## Prior Meeting Context
${priorNotesContext}

## Transcript
${transcriptText}

## Instructions
Extract a structured meeting note in the following JSON format. Return ONLY the JSON object, no other text.

{
  "series": "<meeting series name, e.g. 'weekly-atlas-sync'; if first meeting or uncertain, derive from attendees/topic; prefer new-series over wrong-series>",
  "date": "<YYYY-MM-DD of the meeting>",
  "title": "<descriptive meeting title>",
  "attendees": ["<speaker names from transcript>"],
  "agenda": "<1-2 sentence summary of what was discussed>",
  "decisions": ["<each discrete decision made>"],
  "ownerActionItems": [
    {
      "action": "<action the OWNER (not others) must take>",
      "due": "<YYYY-MM-DD if explicitly stated, null if not>",
      "due_kind": "<'explicit' if stated directly, 'inferred' if derived>",
      "confidence": <0.0-1.0 — how certain you are this is a real owner commitment>,
      "priority": "<'high'|'medium'|'low'>"
    }
  ],
  "followUps": ["<open questions or items to revisit>"],
  "note_status": "draft"
}

Rules:
- ONLY include action items for the Owner (speaker labeled "Owner"). Do NOT include items for other attendees.
- A decision is NOT an action item. Only include concrete actions the Owner committed to.
- Only extract action items with explicitly stated context. Do NOT invent items.
- If a deadline is not explicitly stated in the transcript, set due: null and due_kind: "inferred".
- Include low-confidence items (confidence < 0.6) — they will be flagged for review. Never drop them.
- The series name should be consistent with prior meeting series if this is a continuation.
- note_status MUST always be "draft" — the owner reviews before trusting.`;
}
