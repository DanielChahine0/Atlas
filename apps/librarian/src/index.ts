/**
 * Librarian Worker — POST /prompt/save (T-5-Auth, D-01..D-05, META-01).
 *
 * Routes:
 *   POST /prompt/save → handleSave (auth → validate → dedupe → derive → D1 → Wire)
 *   POST <other>      → 405
 *   *    <other>      → 404  (narrow inbound surface)
 *
 * Pillar 1: producer-only (no queues.consumers block). Emits ONE op:"upsert" Wire event
 * per successful save to Steward → Vault Prompts/<slug>.md.
 *
 * `satisfies ExportedHandler<Env>` (NEVER the `: ExportedHandler<Env>` annotation).
 */

import { z } from "zod";
import { send } from "@atlas/wire";
import { contentHash, flag, localDate } from "@atlas/shared";
import type { Env } from "./env.js";
import { authorizeSave, unauthorized } from "./auth.js";
import { dedupeLookup } from "./dedupe.js";
import { deriveRecord, deriveSlug, resolveSlug } from "./derive.js";

// ── Input validation ──────────────────────────────────────────────────────────

const SaveBody = z.object({
  full_prompt: z.string(),
  tool: z.string().optional(),
});

// ── Note body builder ─────────────────────────────────────────────────────────

/**
 * Build the full-note YAML-frontmatter markdown for a prompt.
 * Format: YAML frontmatter (title, tool, tags, created, last_used, uses) + blank line + prompt.
 */
function buildNoteMarkdown(opts: {
  title: string;
  tool: string;
  tags: string[];
  created: string;
  last_used: string;
  uses: number;
  full_prompt: string;
}): string {
  const tagsJson = JSON.stringify(opts.tags);
  return [
    "---",
    `title: ${opts.title}`,
    `tool: ${opts.tool}`,
    `tags: ${tagsJson}`,
    `created: ${opts.created.slice(0, 10)}`,
    `last_used: ${opts.last_used.slice(0, 10)}`,
    `uses: ${opts.uses}`,
    "---",
    "",
    opts.full_prompt,
  ].join("\n");
}

// ── handleSave ────────────────────────────────────────────────────────────────

async function handleSave(request: Request, env: Env): Promise<Response> {
  // Top-level catch (Pillar 5: every notable failure → Flagger): any unexpected throw
  // — a D1 INSERT/UPDATE failure, a Wire send failure (incl. WireEventTooLargeError),
  // a derive bug — must surface as a FLAGGED P3 + structured 500, never a silent 500.
  try {
    return await handleSaveInner(request, env);
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    try {
      await flag(
        env as { INCIDENTS: NonNullable<typeof env.INCIDENTS> },
        "P3",
        "Librarian: save failed",
        detail,
        { sourceAgent: "Librarian", kind: "save_failed" },
      );
    } catch {
      // Telemetry is best-effort — a flag failure must not mask the 500 response.
    }
    return new Response(JSON.stringify({ error: "Save failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function handleSaveInner(request: Request, env: Env): Promise<Response> {
  // (1) Auth before body parse — T-5-Auth fail-closed gate
  if (!(await authorizeSave(request, env))) {
    return unauthorized();
  }

  // (2) Parse + zod-validate body; tool defaults to CONFIG librarian.default_tool → "Claude"
  let body: z.infer<typeof SaveBody>;
  try {
    const raw = await request.json();
    body = SaveBody.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const fullPrompt = body.full_prompt;
  const defaultTool = (await env.CONFIG.get("librarian.default_tool")) ?? "Claude";
  const tool = body.tool ?? defaultTool;

  // (3) Reject empty/whitespace prompt → P4 flag, no Wire event, no D1 write
  if (!fullPrompt.trim()) {
    await flag(
      env as { INCIDENTS: NonNullable<typeof env.INCIDENTS> },
      "P4",
      "Librarian: empty prompt capture — nothing saved",
      undefined,
      { sourceAgent: "Librarian", kind: "empty_capture" },
    );
    return new Response(JSON.stringify({ ok: true, action: "empty_skipped" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // (4) Reject oversized prompt (50KB soft limit — T-5-DoS, well under 128KB Queue cap)
  if (fullPrompt.length > 50_000) {
    await flag(
      env as { INCIDENTS: NonNullable<typeof env.INCIDENTS> },
      "P3",
      "Librarian: oversized prompt capture — nothing saved",
      `length=${fullPrompt.length}`,
      { sourceAgent: "Librarian", kind: "oversized_capture" },
    );
    return new Response(JSON.stringify({ error: "Prompt too large (>50KB)" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Read KV dedupe thresholds (live-tunable, not [vars])
  const thresholdRaw = await env.CONFIG.get("librarian.dedupe_threshold");
  const borderRaw = await env.CONFIG.get("librarian.dedupe_border");
  const threshold = thresholdRaw ? Number(thresholdRaw) : 0.75;
  const border = borderRaw ? Number(borderRaw) : 0.55;

  // (5) Dedupe lookup — deterministic, no model (D-02)
  const dedupeResult = await dedupeLookup(env.DB, fullPrompt, tool, threshold, border);

  const now = localDate(env);

  if (dedupeResult.match === "bump") {
    // (7) Re-save of existing prompt — bump uses/last_used on same slug (D-04)
    const existingSlug = dedupeResult.slug;

    // Read the existing row to preserve title/tags for the note body
    const existing = await env.DB.prepare(
      "SELECT title, tags, created, uses FROM prompts WHERE slug = ?",
    )
      .bind(existingSlug)
      .first<{ title: string; tags: string; created: string; uses: number }>();

    if (!existing) {
      // Row disappeared between dedupe and here (race; treat as new)
      return handleNewPrompt(env, fullPrompt, tool, now);
    }

    const newUses = existing.uses + 1;

    // UPDATE same slug — positional ? only
    await env.DB.prepare(
      "UPDATE prompts SET full_prompt = ?, last_used = ?, uses = ? WHERE slug = ?",
    )
      .bind(fullPrompt, now, newUses, existingSlug)
      .run();

    // Guarded parse: one malformed tags row must not brick every bump of this slug
    let tags: string[];
    try {
      const parsed = JSON.parse(existing.tags) as unknown;
      tags = Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
    } catch {
      tags = [];
    }
    const noteBody = buildNoteMarkdown({
      title: existing.title,
      tool,
      tags,
      created: existing.created,
      last_used: now,
      uses: newUses,
      full_prompt: fullPrompt,
    });

    // Emit ONE upsert — bump idempotencyKey is date+content-hash-suffixed (repo convention:
    // forge:task:<date>:<contentHash>). A true replay (identical noteBody → identical hash)
    // dedupes to a ledger no-op; a same-day re-save with CHANGED content gets a DISTINCT key
    // so the edited note still reaches the Vault (D-04 / T-5-Replay — D1 and the Vault
    // projection must never silently diverge).
    await send(env, {
      agent: "Librarian", // capitalized codename (CLAUDE.md: Wire agent field = the codename)
      type: "prompt.save",
      entity: "prompt",
      op: "upsert",
      payload: {
        fullNote: true,
        notePath: `Prompts/${existingSlug}.md`,
        noteBody,
      },
      idempotencyKey: `librarian:${existingSlug}:save:${now}:${contentHash(noteBody)}`,
    });

    return new Response(JSON.stringify({ slug: existingSlug, action: "bump" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (dedupeResult.match === "borderline") {
    // (6) Borderline → derive slug for incoming prompt FIRST (so the flag names both sides),
    //     then emit P4 pair flag (single call, names both slugs), then keep-separate (new save).
    const existingSlug = dedupeResult.slug;
    const incomingRecord = await deriveRecord(fullPrompt, env);
    // Resolve potential collision before the flag so incoming_slug is the final used slug
    const incomingSlug = await resolveSlug(env.DB, incomingRecord.slug);

    // SINGLE P4 flag naming BOTH slugs — D-02 pair flag (suggest-don't-destroy)
    await flag(
      env as { INCIDENTS: NonNullable<typeof env.INCIDENTS> },
      "P4",
      "Librarian: borderline duplicate detected",
      `existing_slug=${existingSlug}, incoming_slug=${incomingSlug}, score=${dedupeResult.score.toFixed(2)}`,
      {
        sourceAgent: "Librarian",
        kind: "dedupe_borderline",
        suggestedAction: "Review the two prompts and merge if appropriate.",
      },
    );

    // Keep-separate: treat as a NEW prompt (NEVER silently merge — suggest-don't-destroy)
    return handleNewPromptWithDerived(
      env,
      fullPrompt,
      tool,
      now,
      incomingRecord.title,
      incomingRecord.tags,
      incomingSlug,
      /* skipDerive= */ true,
    );
  }

  // (8) New prompt — deriveRecord (Haiku), resolve slug collisions, INSERT, Wire event
  return handleNewPrompt(env, fullPrompt, tool, now);
}

// ── helpers for new-prompt path ───────────────────────────────────────────────

async function handleNewPrompt(
  env: Env,
  fullPrompt: string,
  tool: string,
  now: string,
): Promise<Response> {
  const record = await deriveRecord(fullPrompt, env);
  const slug = await resolveSlug(env.DB, record.slug);
  return handleNewPromptWithDerived(env, fullPrompt, tool, now, record.title, record.tags, slug, true);
}

async function handleNewPromptWithDerived(
  env: Env,
  fullPrompt: string,
  tool: string,
  now: string,
  title: string,
  tags: string[],
  slug: string,
  _skipDerive: boolean,
): Promise<Response> {
  const noteBody = buildNoteMarkdown({
    title,
    tool,
    tags,
    created: now,
    last_used: now,
    uses: 1,
    full_prompt: fullPrompt,
  });

  // INSERT new row — positional ? only (CLAUDE.md)
  await env.DB.prepare(
    "INSERT INTO prompts(slug, tool, full_prompt, title, tags, created, last_used, uses) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(slug, tool, fullPrompt, title, JSON.stringify(tags), now, now, 1)
    .run();

  // Emit ONE upsert — first-save key is stable (no date) so replay at any age = ledger no-op
  await send(env, {
    agent: "Librarian", // capitalized codename (CLAUDE.md: Wire agent field = the codename)
    type: "prompt.save",
    entity: "prompt",
    op: "upsert",
    payload: {
      fullNote: true,
      notePath: `Prompts/${slug}.md`,
      noteBody,
    },
    idempotencyKey: `librarian:${slug}:save`,
  });

  return new Response(JSON.stringify({ slug, action: "new" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── fetch handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/prompt/save") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handleSave(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
