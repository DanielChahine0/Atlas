# Librarian (prompt library)

**Purpose:** On demand ("save this prompt"), capture a prompt the moment you write it, store it as its own note with a short title + slug + tags + tool, and surface it in the Vault **Prompt library table** as a one-line title that deep-links to the full prompt — deduped and sorted by what you actually reuse.

> Roster **#16** · Tier 4 (meta/polish — convenience, build last). See [agent roster](../01-agent-roster.md) and [importance tiers](../SPEC-CANON.md) §3. The full feature spec lives in [09-prompt-library.md](../09-prompt-library.md); this is its agent-doc companion — keep the two consistent.

---

## At a glance

| | |
|---|---|
| **Codename** | Librarian |
| **Role** | Prompt library (save prompt → title + deep link) |
| **Runtime** | Cloud (Cloudflare Worker) |
| **Trigger** | **on-demand** (hotkey "save this prompt" / user-initiated; never scheduled) |
| **Inputs** | the raw prompt text, the `tool` it was used with (Claude/Canva/etc.), optional tags |
| **Outputs** | one prompt note (full text + front-matter) + a row in the Vault **Prompt library table** |
| **Dependencies** | **Steward** (sole Vault writer), the **Wire** (queue), the local capture surface (hotkey) |
| **MCPs / tools** | Obsidian MCP bridge (reached **via Steward**); hotkey handled by the local capture surface / menubar app |
| **Writes to** | **Vault** via [Steward](steward.md) — Librarian never writes the Vault directly |
| **Reversible?** | Yes — append/upsert only; no destructive paths, no outward actions |

---

## What it does

The owner writes a lot of prompts during the day — for Claude, for Canva, for whatever tool is in front of them — and wants to **save the good ones** without breaking flow, then see them later as **short titles** with a **link** to the full text on the dashboard (per [SPEC-CANON §9](../SPEC-CANON.md)). Librarian is that capture-and-recall layer:

1. **Capture** a prompt with a single hotkey — no form to fill in.
2. **Store** the full prompt as its own note in the Vault.
3. **Surface** it on the dashboard as a one-line title that **deep-links** to that note.
4. **Dedupe** near-identical prompts so the table stays clean and stats stay honest.
5. **Rank** by `uses` / `last_used` so the prompts you actually reuse float to the top.

Librarian is a **writer-via-Steward** agent: it shapes the record and hands it to [Steward](steward.md) on the [Wire](../02-architecture.md). Per design pillar #1 (one writer per resource), only Steward touches the Vault — Librarian emits, Steward applies. It has **no destructive paths** and takes **no outward/irreversible action**, so unlike [Usher](usher.md) or [Envoy](envoy.md) it needs no confirmation gate.

---

## How it works

### Capture flow ("save this prompt")

```
 ┌──────────────┐   hotkey      ┌────────────┐   event on the Wire    ┌──────────┐   note +     ┌───────────┐
 │ owner writes │  "save this   │            │  { agent:"librarian",  │          │  table row   │           │
 │ a prompt in  │──prompt"─────▶│ Librarian  │──  type:"prompt.save", ▶│ Steward  │──(upsert)───▶│ The Vault │
 │ Claude/Canva │               │ (cloud)    │   op:"upsert", ... }   │ (serial) │              │ (Obsidian)│
 └──────────────┘               └────────────┘                        └──────────┘              └───────────┘
                                      │
                                      └─▶ derive title/slug/tags/tool  →  dedupe check  →  THEN emit the event
```

1. **Trigger.** The owner hits the **"save this prompt"** hotkey (on-demand; not scheduled — listed alongside Usher, Quill, Envoy, Switchboard in [scheduling §10](../03-scheduling.md)). The **local capture surface** grabs the selected/last prompt text and the `tool` context and posts it to Librarian.
2. **Derive the record.** Librarian generates a `title` (≤ 6 words), a `slug`, `tags[]`, and resolves `tool`. `created` and `last_used` are set to now; `uses` starts at `1`. (See [Record shape](#record-shape-canonical-from-spec-9).)
3. **Dedupe.** Librarian checks for a near-identical prompt already in the library (see [Dedupe](#dedupe-of-near-identical-prompts)). On a match it **bumps** that record instead of creating a new one.
4. **Emit.** Librarian sends a Steward event on the Wire — `op: "upsert"` for the prompt note + table row — carrying an `idempotencyKey` so a replayed save can't create a duplicate row or double-count `uses`.
5. **Steward applies.** Steward, the single **serialized** Vault writer (§6.4), creates/updates the note and the **Prompt library table** row. Done — the title now links to the full prompt.

```jsonc
// Step 4 — Wire event to Steward (shape per SPEC-CANON §6.4: { agent, type, entity, op, payload, idempotencyKey })
{
  "agent": "librarian",
  "type": "prompt.save",
  "entity": "prompt",
  "op": "upsert",                              // upsert: new prompt OR bump of an existing slug
  "payload": {
    "title": "Make a graphic with Claude",     // ≤ 6 words
    "slug": "make-a-graphic-with-claude",       // stable note id / deep-link target
    "tags": ["graphic", "design", "social"],
    "tool": "Claude",
    "full_prompt": "You are a senior brand designer. Produce a 1080x1080 ...",
    "created": "2026-05-20T14:02:00-04:00",
    "last_used": "2026-05-29T09:11:00-04:00",
    "uses": 7
  },
  "idempotencyKey": "librarian:make-a-graphic-with-claude:save"  // replay-safe; can't double-count
}
```

### Record shape (canonical, from SPEC §9)

```json
{
  "title": "Make a graphic with Claude",
  "slug": "make-a-graphic-with-claude",
  "tags": ["graphic", "design", "social"],
  "tool": "Claude",
  "full_prompt": "You are a senior brand designer. Produce a 1080x1080 ...",
  "created": "2026-05-20T14:02:00-04:00",
  "last_used": "2026-05-29T09:11:00-04:00",
  "uses": 7
}
```

| Field | Type | Role | Notes |
|---|---|---|---|
| `title` | string | the table's link text | **≤ 6 words.** The only thing shown in the table's link column. |
| `slug` | string | note id / deep-link target | **Stable** — derived once, never re-derived from a mutated `title`, so links never break. |
| `tags[]` | string[] | filtering / grouping | Auto-derived from the prompt; owner can edit later. |
| `tool` | string | which tool the prompt is for | `Claude` / `Canva` / etc. Also the **dedupe scope** (see below). |
| `full_prompt` | string | the prompt body | Lives in the **note body**, never in the table (tables stay skimmable). |
| `created` | ISO-8601 | first save time | Set once. |
| `last_used` | ISO-8601 | most-recent save/reuse | Default table sort key; bumped on every reuse. |
| `uses` | int | reuse count | Starts at `1`; `+= 1` on each dedupe bump. Drives [most-used surfacing](#most-used-surfacing). |

### The note (full prompt)

Each saved prompt becomes **one Vault note keyed by `slug`** (e.g. `prompts/make-a-graphic-with-claude.md`). The note holds the **full prompt** plus the metadata as front-matter:

```markdown
---
title: Make a graphic with Claude
tool: Claude
tags: [graphic, design, social]
created: 2026-05-20
last_used: 2026-05-29
uses: 7
---

You are a senior brand designer. Produce a 1080x1080 social graphic for
"Atlas" — dark background, single accent color, one bold headline, lots of
negative space. Output: layout description + exact hex values + font choices.
```

The table's title cell links straight to this note (see [Deep-linking](#deep-linking-to-the-full-prompt-note)).

---

## The Vault table layout

Lives in the dashboard as the **Prompt library table** view — one of the Vault views in [the dashboard doc](../05-dashboard.md) ([SPEC-CANON §6.2](../SPEC-CANON.md)). Exactly **four columns**, per SPEC §9:

| Title (link) | Tags | Tool | Last used |
|---|---|---|---|

- **Title (link)** — the ≤ 6-word `title`, hyperlinked to the full-prompt note (`slug`).
- **Tags** — `tags[]`, for filtering/grouping.
- **Tool** — `tool` (Claude, Canva, …), so you can scan "what did I use for Canva?".
- **Last used** — `last_used`, the default sort key (most-recent / most-used at top).

The table is **derived state** Steward maintains; Librarian only emits records. Nothing else writes here, consistent with "Steward fetches nothing; it is fed" (§4).

### Example table (3 saved prompts)

| Title (link) | Tags | Tool | Last used |
|---|---|---|---|
| [Make a graphic with Claude](prompts/make-a-graphic-with-claude.md) | graphic, design, social | Claude | 2026-05-29 |
| [Summarize a PDF tersely](prompts/summarize-a-pdf-tersely.md) | summary, research | Claude | 2026-05-27 |
| [Canva carousel from outline](prompts/canva-carousel-from-outline.md) | carousel, social, design | Canva | 2026-05-24 |

The owner's "make a graphic with Claude" prompt is the top row: title links to `prompts/make-a-graphic-with-claude.md`, tagged `graphic, design, social`, tool `Claude`.

---

## Deep-linking to the full prompt note

The title cell links to the note holding `full_prompt`. Two link forms, both targeting `slug`:

- **Relative note link** — `[Make a graphic with Claude](prompts/make-a-graphic-with-claude.md)`. Portable, works in any Markdown renderer and inside the synced Vault. **Preferred for the table.**
- **`obsidian://` deep link** — `obsidian://open?vault=Vault&file=prompts%2Fmake-a-graphic-with-claude`. Opens the exact note in the Obsidian app; useful for push notifications, the menubar app, or links surfaced **outside** the Vault.

Because the link target is `slug` (stable, never the mutable `title`), re-saving or renaming a prompt's title does **not** break existing links.

---

## Dedupe of near-identical prompts

Before emitting a new record, Librarian checks whether a near-identical prompt is already in the library. Goal: the table reflects *distinct* prompts, and reusing one **bumps its stats** instead of spawning a clone.

```
new prompt ─▶ normalize (trim, lowercase, collapse whitespace, strip volatile bits)
           ─▶ similarity vs existing prompts (SAME tool first)
                 ├─ near-identical (≥ threshold) ─▶ BUMP existing: uses += 1, last_used = now
                 │                                   (op:"upsert" on the SAME slug — no new row)
                 ├─ borderline (near threshold)  ─▶ keep separate + flag the pair (low sev/trust)
                 └─ distinct ──────────────────────▶ create new note + new table row
```

- **Scope by `tool` first.** A Claude prompt and a Canva prompt are not dupes even if worded alike — the dedupe similarity check runs *within* a `tool` bucket before anything else.
- **Bump, don't replace.** On a match, `uses += 1` and `last_used = now` against the **existing `slug`**. This is what feeds [most-used surfacing](#most-used-surfacing).
- **Near, not exact.** Small edits (a swapped word, extra whitespace) should still resolve to the same record — that's the point of normalization + similarity rather than exact-match.
- **Idempotent.** The Steward event carries an `idempotencyKey`; a replayed save of the same prompt cannot double-count `uses` or create a second row.
- **Uncertain merges are surfaced, not forced.** If a candidate is borderline, Librarian keeps it **separate** and (optionally) flags the pair to [Flagger](../08-flagger.md) at **P4 Low / low trust** rather than silently merging — consistent with design pillar #2, "Suggest, don't destroy."

---

## Most-used surfacing

The table sorts so the prompts you reuse are at the top:

- **Default sort:** `last_used` descending (recency).
- **Most-used:** secondary sort / pin on `uses` descending, so a frequently reused prompt stays near the top even if not touched today.
- `uses` and `last_used` are maintained by the dedupe **bump** path — every time you re-save an existing prompt, it climbs.

This keeps the high-value prompts (the "make a graphic with Claude" you run weekly) one glance away, and lets stale one-offs sink.

---

## Inputs / Outputs

| | |
|---|---|
| **Inputs** | raw prompt text (from the local capture surface), the `tool` context, optional owner-supplied tags |
| **Reads** | the existing prompt library (for the dedupe similarity check) |
| **Outputs** | a derived record (`title`, `slug`, `tags[]`, `tool`, `full_prompt`, `created`, `last_used`, `uses`) emitted to Steward as a `prompt.save` `upsert` event on the Wire |
| **Side effects** | one note created/updated + one table row created/bumped — **all applied by Steward, never by Librarian** |

Librarian does **not** read [The Codex](../07-source-of-truth-codex.md) (no personal facts needed) and does **not** touch Gmail, Calendar, or any outward system.

---

## Dependencies

- **Steward** — the sole Vault writer; Librarian routes every write through it on the Wire. See [Steward](steward.md) and the fan-in diagram in [§4](../02-architecture.md).
- **The Wire** (Cloudflare Queue) — the event bus that carries the `prompt.save` event to Steward's serialized consumer.
- **The local capture surface / menubar app** — owns the "save this prompt" hotkey and supplies the prompt text + `tool` context. (This is the same surface that hosts [Quill](quill.md)'s autofill hotkey; Librarian's runtime itself is cloud.)
- **Flagger** — receives any borderline-dedupe or write-failure events. See [Flagger](../08-flagger.md).

**Not** dependent on the morning pipeline (Filer→Herald→Forge→Sundial→Compass); Librarian runs purely on demand and touches different state.

---

## Schedule / Triggers

| Trigger | Mode | Notes |
|---|---|---|
| **on-demand** | — | hotkey "save this prompt" / user-initiated. Listed with Usher, Quill, Envoy, Switchboard in [scheduling §10](../03-scheduling.md). |

Librarian is **never** cron-scheduled and is not part of the strictly-sequential morning chain. Each invocation is one save, start to finish.

---

## Failure modes & Flagger hooks

Librarian has **no destructive paths**, so most flags here are informational. Notable events go to [Flagger](../08-flagger.md) with a **severity** and a **trust score** (§8).

| Condition | What Librarian does | Flag | Severity · trust |
|---|---|---|---|
| Capture fires but text is empty / unreadable | abort save; no event emitted | `Librarian: empty prompt capture, nothing saved` | P4 Low / Info · low |
| Ambiguous dedupe (borderline match) | keep separate; surface the pair, don't auto-merge | `Librarian: borderline duplicate of <slug>` | P4 Low / Info · low |
| Steward write fails (Vault locked / sync conflict) | retry via the Wire (serialized consumer); event is idempotent | `Librarian: Steward write failed for <slug>` | P3 Medium (if it persists) · high |
| Duplicate-looking row appears | check `idempotencyKey` + `slug`; a true dup means a key bug | `Librarian: duplicate row for <slug>` | P3 Medium · medium |
| Broken title link (note missing for a row) | `slug` drifted from the note path | `Librarian: dangling link for <slug>` | P3 Medium · high |

Routing per §8: **P3** batches into the dashboard Flagger feed; **P1/P2** would push immediately — but Librarian, being append-only and on-demand, has no realistic P1/P2 path.

---

## Config

| Key | Where | Purpose |
|---|---|---|
| **Hotkey** for "save this prompt" | local capture surface / menubar app | The on-demand trigger. |
| **Default `tool`** | KV | Used when no `tool` is supplied (e.g. `Claude`). |
| **Dedupe similarity threshold** | KV | How close counts as "near-identical"; the borderline band routes to Flagger. |
| **Note folder** | KV | The prompt-note namespace (e.g. `prompts/`) — the `slug` base and deep-link root. |
| **Table sort** | KV | Default `last_used` desc, then `uses` desc. |
| **Vault name** | KV | For building `obsidian://` deep links. |

Per [hosting §7](../06-hosting-cloudflare-mcp.md): Cloudflare **Worker** for compute (cheap, stateless per save), the **Wire** (Queue) to reach Steward, and the **Obsidian MCP bridge** reached *through* Steward — Librarian never holds an Obsidian connection itself.

---

## Example run

```
Owner ▸  (writes a prompt in Claude, then hits the "save this prompt" hotkey)

         "You are a senior brand designer. Produce a 1080x1080 social
          graphic for 'Atlas' — dark background, single accent color,
          one bold headline, lots of negative space. Output: layout
          + exact hex values + font choices."

Librarian ▸ [DERIVE]
            title      → "Make a graphic with Claude"   (≤ 6 words)
            slug       → make-a-graphic-with-claude
            tags       → [graphic, design, social]
            tool       → Claude
            created    → 2026-05-29T09:11-04:00
            last_used  → 2026-05-29T09:11-04:00
            uses       → 1

Librarian ▸ [DEDUPE]  normalize → compare within tool=Claude
            → no near-identical prompt found → NEW record

Librarian ▸ [EMIT]  Wire → Steward
            { agent:"librarian", type:"prompt.save", entity:"prompt",
              op:"upsert", payload:{…}, idempotencyKey:
              "librarian:make-a-graphic-with-claude:save" }

Steward   ▸ [APPLY]  note created → prompts/make-a-graphic-with-claude.md
                     row added to the Prompt library table

Librarian ▸ "Saved 'Make a graphic with Claude' (Claude · graphic,
            design, social). It's in your prompt library."
```

**Reuse — dedupe bump (same prompt, re-saved a week later):**

```
Owner ▸  (re-saves the same graphic prompt, lightly edited)

Librarian ▸ [DEDUPE]  normalize → similarity ≥ threshold vs
            slug=make-a-graphic-with-claude (tool=Claude)  → MATCH

Librarian ▸ [EMIT]  Wire → Steward  (op:"upsert" on the SAME slug)
            payload: { uses: 8, last_used: 2026-06-05T08:40-04:00 }
            idempotencyKey: librarian:make-a-graphic-with-claude:save:2026-06-05

Steward   ▸ [APPLY]  uses 7 → 8, last_used bumped — NO new row.
                     Prompt climbs toward the top of the table.

Librarian ▸ "Bumped 'Make a graphic with Claude' (now used 8×).
            No duplicate created."
```

---

## Open questions

- **Auto-tagging quality.** Generate `tags[]` from the prompt text, or always ask the owner? Lean **auto** with an edit-later affordance.
- **Versioning.** When an existing prompt is edited and re-saved, keep history in the note or just overwrite `full_prompt`? Current default: **overwrite, bump `uses`** (no version log).
- **Cross-tool twins.** Should a Claude prompt and its Canva equivalent ever link as variants of one idea, or stay strictly separate per the tool-scoped dedupe?
- **Export / copy-back.** A "copy full prompt" affordance from the table/note for fast paste-back into the tool — table cell, note button, or both?
- **Retention.** Do unused one-offs ever age out (e.g. `uses == 1` and `last_used` > N months), or is the library append-only forever?

---

**Related:** [Steward](steward.md) (sole Vault writer) · [prompt-library spec](../09-prompt-library.md) · [Flagger](../08-flagger.md) · [the Vault dashboard](../05-dashboard.md) · [scheduling](../03-scheduling.md) · [architecture & the Wire](../02-architecture.md) · [agent roster](../01-agent-roster.md)
