# Prompt Library — Librarian

**Purpose:** Save a good prompt the moment you write it (hotkey "save this prompt") and see it later on the dashboard as a short title with a link to the full text — searchable, deduped, and sorted by what you actually reuse.

## At a glance

| | |
|---|---|
| **Codename** | **Librarian** (prompt library — save prompt → title + deep link) |
| **Trigger** | on-demand (hotkey "save this prompt" / user-initiated) — see [scheduling](03-scheduling.md) |
| **Runtime** | Cloud (Cloudflare Worker) |
| **Inputs** | the raw prompt text, the `tool` it was used with (Claude/Canva/etc.), optional tags |
| **Outputs** | one prompt note (full text) + a row in the Vault **Prompt library table** |
| **Dependencies** | **Steward** (sole Vault writer), the **Wire** (queue) |
| **MCPs / tools** | Obsidian MCP bridge (via Steward); hotkey handled by the local capture surface |
| **Writes to** | Vault (via **Steward**) — Librarian never writes the Vault directly |

> Tier 4 (meta/polish, build last) per [importance tiers](01-agent-roster.md). Librarian is convenience, not on the critical path — but cheap to run and entirely read/summarize/append, so it carries no destructive risk.

---

## What it does

The owner writes a lot of prompts during the day — for Claude, for Canva, for whatever tool is in front of them — and wants to **save the good ones** without breaking flow. Librarian is the capture-and-recall layer:

1. **Capture** a prompt with a single hotkey, no form to fill in.
2. **Store** the full prompt as its own note in the Vault.
3. **Surface** it on the dashboard as a one-line title that **links** to that note.
4. **Dedupe** near-identical prompts so the table stays clean.
5. **Rank** by `uses` / `last_used` so the prompts you actually reuse float to the top.

Librarian is a writer-via-Steward agent: it shapes the record and hands it to **Steward** on the **Wire**. Per the one-writer-per-resource pillar, only [Steward](agents/steward.md) touches the Vault.

---

## How it works

### Capture flow ("save this prompt")

```
 ┌──────────────┐   hotkey      ┌────────────┐   event on the Wire   ┌──────────┐   upsert     ┌───────────┐
 │ owner writes │  "save this   │            │  { agent:"Librarian", │          │  note +      │           │
 │ a prompt in  │──prompt"─────▶│ Librarian  │──  type:"prompt", ───▶│ Steward  │──table row──▶│ The Vault │
 │ Claude/Canva │               │ (cloud)    │   op:"upsert", ... }  │ (serial) │              │ (Obsidian)│
 └──────────────┘               └────────────┘                       └──────────┘              └───────────┘
                                      │
                                      └─▶ dedupe check + title/slug/tag derivation before emitting the event
```

1. **Trigger.** The owner hits the "save this prompt" hotkey (on-demand; not scheduled). The local capture surface grabs the selected/last prompt text and the `tool` context and posts it to Librarian.
2. **Derive the record.** Librarian generates a `title` (≤ 6 words), a `slug`, `tags[]`, and resolves `tool`. `created` and `last_used` are set to now; `uses` starts at 1.
3. **Dedupe.** Librarian checks for a near-identical prompt already in the library (see [Dedupe](#dedupe-of-near-identical-prompts)). If found, it bumps that record instead of creating a new one.
4. **Emit.** Librarian sends a Steward event on the Wire — `op: "upsert"` for the prompt note + table row — carrying an `idempotencyKey` so a replayed save can't create a duplicate row.
5. **Steward applies.** Steward, the single serialized Vault writer, creates/updates the note and the **Prompt library table** row. Done; the title now links to the full prompt.

### Record shape (canonical, from SPEC §9)

```json
{
  "title": "Make a graphic with Claude",   // ≤ 6 words, becomes the table link
  "slug": "make-a-graphic-with-claude",     // stable note id / deep-link target
  "tags": ["graphic", "design", "social"],
  "tool": "Claude",                          // Claude / Canva / etc.
  "full_prompt": "You are a senior brand designer. Produce a 1080x1080 ...",
  "created": "2026-05-20T14:02:00-04:00",
  "last_used": "2026-05-29T09:11:00-04:00",
  "uses": 7
}
```

- **`title`** is the only thing shown in the table's link column — keep it ≤ 6 words.
- **`slug`** is the deep-link target; it must be stable so existing links don't break on re-save.
- **`full_prompt`** lives in the note body, never in the table (tables stay skimmable).
- **`uses` / `last_used`** drive [most-used surfacing](#most-used-surfacing).

### The note (full prompt)

Each saved prompt becomes one Vault note keyed by `slug` (e.g. `prompts/make-a-graphic-with-claude.md`). The note holds the **full prompt** plus the metadata as front-matter:

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

The table's title links straight to this note (relative note link, or `obsidian://` deep link — see [Deep-linking](#deep-linking-to-the-full-prompt-note)).

---

## The Vault table layout

Lives in the dashboard as the **Prompt library table** view (one of the Vault views in [§6.2](06-dashboard-vault.md)). Exactly four columns, per SPEC §9:

| Title (link) | Tags | Tool | Last used |
|---|---|---|---|

- **Title (link)** — the ≤ 6-word `title`, hyperlinked to the full-prompt note (`slug`).
- **Tags** — `tags[]`, for filtering/grouping.
- **Tool** — `tool` (Claude, Canva, …), so you can scan "what did I use for Canva?".
- **Last used** — `last_used`, the default sort key (most-recent / most-used at top).

The table is **derived state** Steward maintains; Librarian only emits records. Nothing else writes here.

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

- **Relative note link** — `[Make a graphic with Claude](prompts/make-a-graphic-with-claude.md)`. Portable, works in any Markdown renderer and inside the synced Vault. Preferred for the table.
- **`obsidian://` deep link** — `obsidian://open?vault=Vault&file=prompts%2Fmake-a-graphic-with-claude`. Opens the exact note in the Obsidian app; useful for push notifications, the menubar app, or links surfaced outside the Vault.

Because the link target is `slug` (stable, never the mutable `title`), re-saving or renaming a prompt's title does **not** break existing links.

---

## Dedupe of near-identical prompts

Before emitting a new record, Librarian checks whether a near-identical prompt is already in the library. Goal: the table reflects *distinct* prompts, and reusing one **bumps its stats** instead of spawning a clone.

```
new prompt ─▶ normalize (trim, lowercase, collapse whitespace, strip volatile bits)
           ─▶ similarity vs existing prompts (same tool first)
                 ├─ near-identical (≥ threshold) ─▶ bump existing: uses += 1, last_used = now
                 │                                   (op:"upsert" on the SAME slug — no new row)
                 └─ distinct ──────────────────────▶ create new note + new table row
```

- **Scope by `tool` first** (a Claude prompt and a Canva prompt are not dupes even if worded alike).
- **Bump, don't replace:** on a match, `uses += 1` and `last_used = now` against the existing `slug`. This is what feeds [most-used surfacing](#most-used-surfacing).
- **Idempotent:** the Steward event carries an `idempotencyKey`; a replayed save of the same prompt cannot double-count `uses` or create a second row.
- **Near, not exact:** small edits (a swapped word, extra whitespace) should still resolve to the same record — that's the point of normalization + similarity rather than exact-match.
- **Uncertain merges are surfaced, not forced.** If a candidate is borderline, Librarian keeps it separate and (optionally) flags the pair to [Flagger](08-flagger.md) at low severity / low trust rather than silently merging — consistent with the "suggest, don't destroy" pillar.

---

## Most-used surfacing

The table sorts so the prompts you reuse are at the top:

- **Default sort:** `last_used` descending (recency).
- **Most-used:** secondary sort / pin on `uses` descending, so a frequently reused prompt stays near the top even if not touched today.
- `uses` and `last_used` are maintained by the dedupe **bump** path — every time you re-save an existing prompt, it climbs.

This keeps the high-value prompts (the "make a graphic with Claude" you run weekly) one glance away, and lets stale one-offs sink.

---

## Failure modes & Flagger hooks

| Failure | Handling | Flagger |
|---|---|---|
| Capture fires but text is empty / unreadable | abort save, no event emitted | P4 Low / Info, low trust |
| Steward write fails (Vault locked / sync conflict) | retry via the Wire (serialized consumer); event is idempotent | P3 Medium if it persists |
| Ambiguous dedupe (borderline match) | keep separate, surface the pair | P4 Low / Info, low trust |
| Duplicate-looking row appears | check `idempotencyKey` + `slug`; a true dup means a key bug | P3 Medium |
| Broken title link (note missing) | `slug` drifted from note path | P3 Medium |

All flags carry a **severity** and a **trust score** per [Flagger](08-flagger.md) §8. Librarian has no destructive paths, so most flags here are informational.

---

## Config

- **Hotkey** for "save this prompt" (bound on the local capture surface / menubar app).
- **Default `tool`** when none is supplied (e.g. `Claude`).
- **Dedupe similarity threshold** (how close counts as "near-identical").
- **Note folder** for prompt notes (e.g. `prompts/`) — the `slug` namespace and deep-link base.
- **Table sort** (default `last_used` desc, then `uses` desc).

---

## Open questions

- **Auto-tagging quality:** generate `tags[]` from the prompt text, or always ask the owner? Lean auto with an edit-later affordance.
- **Versioning:** when an existing prompt is edited and re-saved, keep history in the note or just overwrite `full_prompt`? Current default: overwrite, bump `uses`.
- **Cross-tool dupes:** should a Claude prompt and its Canva twin ever link as variants of one idea?
- **Export:** a "copy full prompt" affordance from the table/note for fast paste-back into the tool.

---

**Related:** [Steward](agents/steward.md) (sole Vault writer) · [Librarian agent doc](agents/librarian.md) · [Flagger](08-flagger.md) · [the Vault dashboard](06-dashboard-vault.md) · [scheduling](03-scheduling.md) · [agent roster](01-agent-roster.md)
