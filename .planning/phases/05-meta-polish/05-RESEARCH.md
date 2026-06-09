# Phase 5: Meta / Polish — Research

**Researched:** 2026-06-09
**Domain:** Librarian (prompt library Worker) + Switchboard (design-time process/skill)
**Confidence:** HIGH (all findings verified against repo source code or canonical docs)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Librarian Worker exposes `POST /prompt/save`; local capture surface POSTs outbound; Bearer token validated constant-time and fail-closed (ATLAS_BRIDGE_TOKEN sibling secret). No menubar hotkey wiring — deferred owner go-live.
- **D-02:** Dedupe is deterministic, no model on the hot path. Token-set/trigram similarity within the `tool` bucket first, against a KV-configurable threshold. Borderline band → keep separate + low-severity/low-trust Flagger pair flag.
- **D-03:** `title` + `tags[]` derived by Haiku via `claudeFor('Librarian', env)` through AI Gateway. `slug` derived once from first title and never re-derived.
- **D-04:** Re-save of existing prompt overwrites `full_prompt` and bumps `uses`/`last_used` — no history.
- **D-05:** Append-only forever — no age-out.
- **D-06:** Switchboard ships as: (a) process doc/runbook, (b) machine-readable MCP registry config (KV/JSON), (c) Claude Code slash-command `/switchboard <goal>`. NOT a deployed Worker.
- **D-07:** Switchboard gap→Flagger via the existing `flag()` / `atlas-incidents` pipeline — producer only, no new consumer. Severity: no-MCP→P3; blocks in-flight→P2; missing scope→P3; ungated outward→P1.
- **Pillar 1:** Steward sole Vault writer. No new `atlas-wire` consumer anywhere in this phase.
- **Wire contract:** `{ agent, type, entity, op, payload, idempotencyKey }`. `op:"upsert"` for the prompt note. Structured stable `idempotencyKey`. Never `crypto.randomUUID()` on the keyed path.
- **Secrets only via bindings.** Constant-time, fail-closed token gates. `Intl`/`America/Toronto` for owner-local time. D1 positional `?` params.
- **Model tiering** via `claudeFor`/`modelFor`, never hardcoded. All Claude via AI Gateway.

### Claude's Discretion

- Exact similarity algorithm (token-set Jaccard vs trigram vs normalized-hash) and default threshold value.
- Whether slug namespace/note folder, default tool, table sort, and dedupe threshold are new CONFIG KV keys vs `[vars]`.
- Where the thin Switchboard gap-emit endpoint physically lives (producer-only, authed).
- Registry config storage shape (KV blob vs tracked JSON read by the command).

### Deferred Ideas (OUT OF SCOPE)

- Cross-tool twins (linking Claude/Canva variants).
- Export/copy-back affordance from table/note.
- Prompt versioning history.
- Retention/age-out.
- Switchboard learning loop.
- Switchboard auto-execute.
- Switchboard registry freshness/health cadence.
- Owner go-live: real menubar hotkey binding + seeding Librarian's Bearer secret.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| META-01 | Librarian captures a prompt, dedupes, surfaces in Vault Prompt library table (Title link · Tags · Tool · Last used), title deep-links to full-prompt note, most-used at top | Verified: exact Wire event shape, record shape, idempotencyKey pattern, Steward render path gap identified, D1 migration needed for dedupe lookup, auth pattern, claudeFor call shape — all documented below |
| META-02 | Switchboard exists as documented design-time routing process (selects minimal MCP server + tools + OAuth scopes, reports gaps to Flagger) — NOT a deployed Worker | Verified: deliverable form (process doc + KV registry + slash-command), registry JSON shape, gap→Flagger path (flag() producer only), /switchboard command conventions, registry storage recommendation — all documented below |
</phase_requirements>

---

## Summary

Phase 5 ships two agents with no morning-chain involvement and no new destructive paths.

**Librarian (META-01)** is a stateless Cloudflare Worker that accepts a `POST /prompt/save` (Bearer-gated, constant-time, fail-closed — mirrors `apps/mcp-obsidian-bridge/src/auth.ts` exactly). It derives a title/tags via Haiku, runs a deterministic dedupe check (token-set Jaccard within the `tool` bucket against a KV-configurable threshold), then emits ONE `op:"upsert"` §6.4 Wire event to Steward. Steward writes the per-prompt note (`Prompts/<slug>.md`) to the Vault; the Prompt library table in `Dashboard/Prompt Library.md` is a Dataview query that auto-renders — no Steward row-write for the table itself.

**Critically:** the existing `toOutboxIntent` `upsert` branch in `packages/steward-core/src/op-mapping.ts` writes a single frontmatter field (`PATCH /vault/<note>.md`, `Operation: replace`, `Target-Type: frontmatter`). Librarian needs a full-note write (`PUT /vault/Prompts/<slug>.md` with front-matter + body). This requires a targeted extension to `op-mapping.ts` (adding a `payload.method: "PUT"` convention to the `upsert` branch and adding `"PUT"` to `SAFE_METHODS`) plus a corresponding update to the daemon's `ALLOWED_METHODS` set. This is the single most impactful integration task and must be Wave 0.

**Switchboard (META-02)** ships no Worker. It is: (a) a process doc that formalizes `docs/10-switchboard.md` as a step-by-step runbook, (b) a tracked JSON file at `.claude/registry/mcp-registry.json` (preferred over KV — see Registry Config Storage decision below), and (c) a Claude Code slash-command at `.claude/commands/switchboard.md`. The gap→Flagger path uses `flag()` from `@atlas/shared` emitting onto `atlas-incidents` — producer only, no new consumer, Pillar 1 unbroken.

**Primary recommendation:** Implement in this order: (1) Steward PUT full-note extension, (2) D1 prompts migration, (3) Librarian Worker + Bearer gate, (4) dedupe algorithm + Haiku derivation, (5) Wire emission + idempotency, (6) process doc + registry JSON, (7) `/switchboard` command.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Bearer-gate inbound HTTP (`POST /prompt/save`) | API / Backend (Librarian Worker) | — | Same tier as mcp-obsidian-bridge poll/ack; fail-closed auth at the Worker edge |
| Prompt text normalization + dedupe | API / Backend (Librarian Worker) | — | Purely computational; no client involvement; D1 read for existing prompts |
| Title/tags derivation (Haiku) | API / Backend (Librarian Worker) | — | Model call via AI Gateway; Workers only |
| Prompt note write (`Prompts/<slug>.md`) | Database / Storage (via Steward → Vault) | — | Steward is sole Vault writer; Librarian emits Wire event only |
| Prompt library table render | CDN / Static (Dataview in Obsidian) | — | Dataview auto-renders from `Prompts/` folder; no active write by Steward |
| D1 prompts store (dedupe lookup) | Database / Storage (D1) | — | D1 is system-of-record; dedupe check reads the prompts table, never KV |
| Switchboard recommendation computation | Design-time / Claude Code skill | — | Runs in Claude Code at design time; not a deployed Worker |
| Gap→Flagger emit | API / Backend (atlas-incidents producer) | — | `flag()` from `@atlas/shared`; Flagger is the sole atlas-incidents consumer |
| MCP registry config | CDN / Static (tracked JSON) | CONFIG KV | Tracked JSON preferred (see below); also seedable into KV for Worker reads |

---

## Standard Stack

### Core (Librarian Worker)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@atlas/wire` | workspace | Wire event emission (`send()`) + `WireEvent` zod schema | Project-canonical; the only definition |
| `@atlas/shared` | workspace | `flag()` / `RawIncident` / `localDate` / `Env` | Project-canonical; all agents use it |
| `@atlas/model` | workspace | `claudeFor('Librarian', env)` for Haiku title/tags | Project-canonical model factory |
| `@atlas/gate` | workspace | `timingSafeEqual` for Bearer gate on `POST /prompt/save` | [VERIFIED: source] Ships in `packages/gate/src/auth.ts`; preferred over duplicating the pattern |
| `zod` | `^3.25 \|\| ^4.0` (resolved 4.4.3) | Input validation on inbound POST body | CLAUDE.md pinned; already a workspace dep |
| `wrangler` | v4.x latest | Worker deployment + D1 migration | CLAUDE.md pinned |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@cloudflare/vitest-pool-workers` | v4 (0.16+) | workerd-backed tests | All Worker tests; `cloudflareTest` pattern from Phase 0 |
| `vitest` | workspace | test runner | All tests |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `packages/gate/src/auth.ts` `timingSafeEqual` | Re-implement in `apps/librarian/src/auth.ts` | Prior phases (flagger, echo, mcp-obsidian-bridge) each duplicated the function. `packages/gate` now exports it — use it directly to avoid a fourth copy and stay consistent with D-01's "reuse existing gate" directive |
| Token-set Jaccard dedupe | Exact-match SHA-256 hash | Exact-match misses near-duplicates (a swapped word, trailing punctuation); the doc spec says "near, not exact." Jaccard is the correct choice per D-02 |
| Tracked JSON registry | CONFIG KV blob | See Registry Config Storage section below |

**Installation:** No new external npm packages — all dependencies are workspace packages already installed. New D1 migration + new Worker only.

---

## Package Legitimacy Audit

> No new external npm packages are introduced in Phase 5. All dependencies are existing workspace packages (`@atlas/wire`, `@atlas/shared`, `@atlas/model`, `@atlas/gate`, `zod`, `wrangler`, `vitest`). No package legitimacy check required.

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

---

## Architecture Patterns

### System Architecture Diagram

```
owner writes a prompt
        │
        │ hotkey (deferred go-live) / mock-POST (current dev)
        ▼
┌──────────────────────────────────────────────┐
│  LOCAL macOS daemon (daemon/ outbound-only)  │
│  POST /prompt/save                           │
│  Authorization: Bearer ATLAS_LIBRARIAN_TOKEN │
└──────────────────────┬───────────────────────┘
                       │ HTTPS outbound only
                       ▼
┌──────────────────────────────────────────────┐
│  apps/librarian Worker                       │
│  1. Bearer gate (timingSafeEqual, fail-close)│
│  2. Parse + validate body (zod)              │
│  3. Normalize prompt text                    │
│  4. D1 read: existing prompts (tool-scoped)  │
│  5. Jaccard dedupe → match / borderline / new│
│  6. Haiku: derive title + tags (claudeFor)   │
│  7. Build slug (first save only)             │
│  8. Build Wire event (op:"upsert")           │
│  9. send(env, event) → WIRE                  │
│  10. flag() on borderline or failure         │
└──────────┬───────────────────────────────────┘
           │ atlas-wire Queue
           ▼
┌──────────────────────────────────────────────┐
│  apps/steward (sole consumer, serial for-of) │
│  StewardWriter DO (blockConcurrencyWhile)    │
│  applyEvent → D1 batch: dedup+counter+outbox │
└──────────┬───────────────────────────────────┘
           │ vault_outbox PENDING intent
           ▼
┌──────────────────────────────────────────────┐
│  daemon drain loop (outbound-only)           │
│  PUT /vault/Prompts/<slug>.md (full note)    │
│  ← Obsidian Local REST API v3 at 127.0.0.1  │
└──────────┬───────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────┐
│  The Vault (Obsidian)                        │
│  Prompts/<slug>.md — full note written       │
│  Dashboard/Prompt Library.md — Dataview auto │
│    renders from Prompts/ folder              │
└──────────────────────────────────────────────┘

failure / borderline-dedupe path:
apps/librarian ──flag()──▶ atlas-incidents Queue ──▶ Flagger (sole consumer)
/switchboard command ──flag()──▶ atlas-incidents (producer only)
```

### Recommended Project Structure

```
apps/librarian/
├── src/
│   ├── index.ts          # fetch handler (POST /prompt/save) + satisfies ExportedHandler<Env>
│   ├── auth.ts           # imports timingSafeEqual from @atlas/gate; bearerGate helper
│   ├── derive.ts         # claudeFor Haiku call: title (≤6w) + tags[]; slug from title
│   ├── dedupe.ts         # normalise() + tokenSetJaccard() + dedupeLookup(D1)
│   └── env.ts            # local Env narrowing (WIRE, DB, CONFIG, INCIDENTS, + Secrets)
├── test/
│   ├── wire-contract.test.ts    # Wire event shape + idempotencyKey structure
│   ├── replay.test.ts           # replay ⇒ meta.changes===0 through Steward
│   └── failure.test.ts          # failure-path: flag severity assertions
├── wrangler.jsonc
└── package.json

.claude/
├── commands/
│   └── switchboard.md    # new: /switchboard <goal> slash-command
└── registry/
    └── mcp-registry.json # new: machine-readable MCP registry config (tracked JSON)

docs/
└── 10-switchboard.md     # already exists; process doc formalization = annotation pass only

migrations/
└── 0008_prompts.sql      # new: prompts table for D1 dedupe lookup
```

### Pattern 1: Bearer Gate (reuse `packages/gate/src/auth.ts`)

**What:** Constant-time HMAC-SHA-256 Bearer token comparison for `POST /prompt/save`. Fail-closed: `false` on any error or missing binding.

**When to use:** Any inbound HTTP endpoint that accepts calls from the local daemon / external caller.

```typescript
// Source: packages/gate/src/auth.ts (verified)
import { timingSafeEqual } from "@atlas/gate";

async function bearerGate(request: Request, env: { ATLAS_LIBRARIAN_TOKEN?: SecretsStoreSecret }): Promise<boolean> {
  const expected = await env.ATLAS_LIBRARIAN_TOKEN?.get();
  if (!expected) return false; // fail-closed: no secret configured ⇒ no access
  const auth = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!match) return false;
  return timingSafeEqual(match[1]!, expected);
}
```

**Note:** `timingSafeEqual` signature from `packages/gate/src/auth.ts`:
```typescript
export async function timingSafeEqual(a: string, b: string): Promise<boolean>
```
HMAC-SHA-256 under a fresh random key each call; length-independent; returns `false` on any crypto error (fail-closed). [VERIFIED: packages/gate/src/auth.ts]

### Pattern 2: Wire Event Emission (Librarian → Steward)

**What:** The canonical `op:"upsert"` event for a new prompt save or a dedupe bump.

**When to use:** After dedupe check; one event per `/prompt/save` call.

```typescript
// Source: docs/agents/librarian.md §"Step 4 — Wire event" (verified against packages/wire/src/contract.ts)
// New save:
await send(env, {
  agent: "librarian",
  type: "prompt.save",
  entity: "prompt",
  op: "upsert",
  payload: {
    // Full note body for Steward's PUT /vault/Prompts/<slug>.md
    fullNote: true,          // NEW payload convention (see Steward render path below)
    notePath: `Prompts/${slug}.md`,
    noteBody: buildNoteMarkdown(record),  // frontmatter YAML + full_prompt body
    title, slug, tags, tool, full_prompt, created, last_used, uses,
  },
  idempotencyKey: `librarian:${slug}:save`,  // stable; first-save
});

// Dedupe bump (re-save of existing prompt):
await send(env, {
  agent: "librarian",
  type: "prompt.save",
  entity: "prompt",
  op: "upsert",
  payload: {
    fullNote: true,
    notePath: `Prompts/${slug}.md`,
    noteBody: buildNoteMarkdown({ ...existingRecord, uses: existingRecord.uses + 1, last_used: now }),
  },
  idempotencyKey: `librarian:${slug}:save:${localDate(env)}`,  // bump key includes date
});
```

**Key:** `librarian:<slug>:save` for first saves; `librarian:<slug>:save:<date>` for bumps. The DATE suffix makes a bump on the same day idempotent but allows a re-save on a new day to bump `uses` again. [VERIFIED: docs/agents/librarian.md example run]

### Pattern 3: Dedupe Algorithm (token-set Jaccard)

**What:** Deterministic, replay-stable, no-model similarity check. Runs within `tool` bucket.

**When to use:** On every `/prompt/save` before deriving title/tags.

```typescript
// Source: reasoning from docs/09-prompt-library.md + D-02 decision [ASSUMED: exact impl]
function normalise(text: string): string {
  return text.trim().toLowerCase()
    .replace(/\s+/g, " ")
    // Strip volatile bits: dates, numbers, URLs (configurable, KV threshold)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "DATE")
    .replace(/https?:\/\/\S+/g, "URL");
}

function tokenSet(text: string): Set<string> {
  return new Set(text.split(/\s+/).filter(t => t.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = [...a].filter(t => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : intersection / union;
}

// D1 lookup: SELECT slug, full_prompt FROM prompts WHERE tool = ? (positional ?)
// Compare jaccard(normalise(incoming), normalise(existing)) per row.
// Result: score >= threshold → bump existing slug
//         borderThreshold <= score < threshold → keep separate + flag P4 pair
//         score < borderThreshold → new record
```

**Default threshold recommendation:** `0.75` (near-identical); borderline band `[0.55, 0.75)`. Both KV keys: `librarian.dedupe_threshold` (default `0.75`) and `librarian.dedupe_border` (default `0.55`). [ASSUMED: exact threshold values — calibrate against real prompts; recommend owner-adjustable via CONFIG KV]

### Pattern 4: `claudeFor` Haiku Call (title + tags derivation)

**What:** One Haiku model call to derive `title` (≤ 6 words) and `tags[]`. Model ID resolved by `modelFor('librarian', env)` → must be in TIER_MAP or KV override.

**When to use:** Only on NEW prompts (not on dedupe bumps where the title/tags already exist).

```typescript
// Source: packages/model/src/claude.ts — claudeFor signature (verified)
const claude = await claudeFor("librarian", env);
const resp = await claude.messages.create({
  max_tokens: 128,
  messages: [{
    role: "user",
    content: `Given this prompt text, output ONLY a JSON object: {"title": "<≤6 words>", "tags": ["tag1","tag2","tag3"]}. No explanation.\n\nPrompt:\n${promptText.slice(0, 2000)}`
  }]
});
```

**Note:** Librarian is not in `TIER_MAP` in `packages/model/src/claude.ts`. MUST add `"librarian": "claude-haiku-4-5"` to `TIER_MAP` as part of Phase 5 (or use `[vars]` MODEL_LIBRARIAN = `claude-haiku-4-5`). The `modelFor` resolution order is: KV `model:librarian` → `[vars] MODEL_LIBRARIAN` → `TIER_MAP["librarian"]` → Sonnet default. Recommendation: add to TIER_MAP so it doesn't silently fall through to Sonnet (which costs 4x more). [VERIFIED: packages/model/src/claude.ts]

### Pattern 5: flag() call (Flagger emit)

**What:** Enqueue a `RawIncident` onto `atlas-incidents`. Producer only. Flagger is the sole consumer.

```typescript
// Source: packages/shared/src/flag.ts (verified)
// flag(env, severity, title, detail?, options?)
// env requires: { INCIDENTS: Queue<RawIncident> }

// borderline dedupe:
await flag(env, "P4", "Librarian: borderline duplicate detected",
  `slug=${existingSlug}, score=${score.toFixed(2)}`,
  { sourceAgent: "Librarian", kind: "dedupe_borderline",
    suggestedAction: "Review the two prompts and merge if appropriate." });

// empty/unreadable capture:
await flag(env, "P4", "Librarian: empty prompt capture — nothing saved", undefined,
  { sourceAgent: "Librarian", kind: "empty_capture" });
```

### Pattern 6: Steward Render Path — Full-Note PUT (ADDITION REQUIRED)

**What:** Librarian needs Steward to write a FULL Obsidian note body (front-matter YAML + `full_prompt` body text) to `Prompts/<slug>.md`. The Obsidian Local REST API v3 uses `PUT /vault/<path>` to create/overwrite a full note.

**Current state (VERIFIED: packages/steward-core/src/op-mapping.ts):**
- `upsert` → `PATCH /vault/<note>.md` with `Operation: replace`, `Target-Type: frontmatter`, `Target: <field>` — writes a SINGLE frontmatter key.
- `SAFE_METHODS = ["PATCH", "POST"]` — `PUT` is NOT currently included.

**Required addition:**
The `op-mapping.ts` comment explicitly documents the extension point: `"An upsert(view) → PUT /vault/Dashboard/Today.md row is added HERE"`. This was always the intended extension mechanism.

Two changes to `packages/steward-core/src/op-mapping.ts`:
1. Add `"PUT"` to `SAFE_METHODS` (Pillar-2 allow-list — `PUT` is an overwrite, not a delete).
2. Add a sub-branch in the `upsert` case: when `payload.fullNote === true`, produce a `PUT /vault/${payload.notePath}` intent with `Content-Type: text/markdown` and `payload.noteBody` as the body.

Corresponding change to `daemon/src/drain.ts`:
- Add `"PUT"` to `ALLOWED_METHODS` set (currently `["PATCH", "PUT", "POST"]` — checking the source, `ALLOWED_METHODS = new Set(["PATCH", "PUT", "POST"])` in drain.ts already includes `"PUT"`. [VERIFIED: daemon/src/drain.ts line 54]. The daemon already allows PUT. Only `SAFE_METHODS` in `op-mapping.ts` needs updating.

**The Prompt library table is NOT written by Steward directly.** `Dashboard/Prompt Library.md` contains a Dataview query over `Prompts/`:
```dataview
TABLE WITHOUT ID file.link AS "Title", tags AS "Tags", tool AS "Tool", last_used AS "Last used"
FROM "Prompts"
SORT uses DESC, last_used DESC
```
This auto-renders whenever Obsidian opens the view. [VERIFIED: docs/05-dashboard.md §6]

**Conclusion:** Steward needs ONE targeted addition: the `fullNote: true` payload convention in `op-mapping.ts` + `"PUT"` added to `SAFE_METHODS`. The Prompt library table view requires no Steward write — Dataview handles it.

### Pattern 7: D1 Prompts Table (new migration)

**What:** The dedupe check requires reading existing prompts (slug + full_prompt + tool). D1 is the system-of-record (Pillar 4); the library cannot live in KV (1 write/s key + lag), R2, or the Vault alone.

**Required migration (`migrations/0008_prompts.sql`):**
```sql
CREATE TABLE IF NOT EXISTS prompts (
  slug       TEXT PRIMARY KEY,
  tool       TEXT NOT NULL DEFAULT 'Claude',
  full_prompt TEXT NOT NULL,
  title      TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',  -- JSON array, stored as TEXT
  created    TEXT NOT NULL,
  last_used  TEXT NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_prompts_tool ON prompts(tool);
```

Librarian reads `prompts WHERE tool = ?` for the dedupe check (positional `?`). Steward does NOT write this table — Librarian writes it directly after the Wire event is emitted successfully (or in the same Worker request before emit). This is NOT a Vault write; it is the D1 system-of-record for dedupe.

**Important:** This does NOT break Pillar 1 (one writer per resource). Pillar 1 says Steward is the sole **Vault** writer. D1 is the system-of-record that agents write to directly. Filer, Forge, Headhunter all write D1 directly. Librarian writes D1's `prompts` table; Steward writes the Vault's `Prompts/<slug>.md` notes. These are different resources.

### Pattern 8: `/switchboard` Claude Code Command

**What:** A Claude Code slash-command at `.claude/commands/switchboard.md` that reads the registry + Codex and returns ranked toolset JSON.

**Convention (verified from `.claude/commands/wire-event.md`, `new-agent.md`, `cf-docs.md`):**
```markdown
---
description: [one-line description]
argument-hint: [goal description]
allowed-tools: Read, Glob, mcp__context7__*, WebSearch
model: inherit
---

[prompt body]
```

**Recommended shape for `/switchboard`:**
```markdown
---
description: Given a goal, run the 6-step Switchboard algorithm and return a ranked toolset recommendation (MCP servers + exact tools + scopes + executing agent + gate flag). Gaps → Flagger. Design-time only — never executes.
argument-hint: <natural-language goal>
allowed-tools: Read, Glob, mcp__context7__resolve-library-id, mcp__context7__query-docs, WebSearch
model: inherit
---
```

The command body:
1. Reads `.claude/registry/mcp-registry.json` (the machine-readable registry).
2. Reads `codex.md` (Codex identity/account facts — read-only).
3. Runs the 6-step algorithm from `docs/10-switchboard.md`.
4. Returns the toolset JSON matching the `docs/agents/switchboard.md` recommendation shape.
5. On gap: calls `flag()` path — but since this is a design-time command (not a Worker), it CANNOT call `flag()` directly. Instead it outputs the gap as structured JSON and instructs the human operator to emit the flag via a thin endpoint if desired (see Gap→Flagger below).

### Anti-Patterns to Avoid

- **Registering `apps/librarian` as a second `atlas-wire` consumer.** Librarian is a PRODUCER only. Only Steward has `queues.consumers`. The Pillar-1 CI guard (`guard-wire-consumer.js`) will fail the build if you add a second consumer. [VERIFIED: .claude/hooks/guard-wire-consumer.js]
- **Using `crypto.randomUUID()` for the Librarian idempotency key.** The key must be stable: `librarian:<slug>:save` (first save) or `librarian:<slug>:save:<date>` (bump). A UUID key would allow double-counting on replay. [VERIFIED: CLAUDE.md, CONTEXT.md]
- **Adding Librarian's Bearer-token comparison with early-return on length.** Must use HMAC both sides under a fresh key — the `timingSafeEqual` from `packages/gate/src/auth.ts` is the only safe option (length-independent). [VERIFIED: packages/gate/src/auth.ts]
- **Writing the Prompt library table directly from Steward.** The table is a Dataview query; Steward writes only the per-prompt notes. Writing the table would conflict with Dataview's live rendering. [VERIFIED: docs/05-dashboard.md §6]
- **Using `payload.delta` for the `uses` counter.** The existing `applyEvent` in `steward-core` uses `payload.delta` for `increment` ops. Librarian's `uses` bump happens in D1's `prompts` table directly (Librarian writes it before emitting the Wire event), NOT via a Steward `increment`. The Wire event is `op:"upsert"` carrying the full note body. [VERIFIED: packages/steward-core/src/apply.ts]
- **Deploying Switchboard as a Worker.** D7 says NOT a deployed Worker. Per `REQUIREMENTS.md` "Out of Scope" table. [VERIFIED: .planning/REQUIREMENTS.md]
- **Generating the slug from a mutable title.** The slug is derived ONCE from the first title and never changed, so `obsidian://` deep links never break. [VERIFIED: docs/agents/librarian.md §"Record shape"]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Constant-time Bearer token comparison | Custom string compare | `timingSafeEqual` from `packages/gate/src/auth.ts` | Side-channel safe; fail-closed; already battle-tested in 4 Workers |
| Wire event emission + validation | Direct `env.WIRE.send({...})` | `send(env, event)` from `@atlas/wire` | Validates schema + enforces 128KB cap; malformed event throws at producer boundary |
| Flagger incident emission | Direct D1 write or Wire upsert | `flag(env, severity, title, detail?, opts?)` from `@atlas/shared` | Single flag-id authority; structured RawIncident; Flagger aggregates all |
| Owner-local date | `new Date().toISOString()` | `localDate(env)` from `@atlas/shared` | workerd forces TZ=UTC; this helper uses `Intl`/`America/Toronto` |
| Model call + AI Gateway routing | `new Anthropic(...)` directly | `claudeFor('librarian', env)` from `@atlas/model` | Routes via AI Gateway; per-agent cost attribution; auto-flags gateway errors; tier via KV |
| Slug generation from title | Custom slugify | `title.trim().toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'')` | Trivially hand-rolled is fine; the critical rule is "derive ONCE, never re-derive" |
| Dataview query for Prompt library table | Steward writing the markdown table directly | Dataview query in `Dashboard/Prompt Library.md` over `Prompts/` | Dataview auto-renders from frontmatter; Steward only writes the notes |

**Key insight:** The hardest correctness property in Librarian is the idempotency invariant: a replayed save must not double-count `uses` or create a second row. The `send()` + `applyEvent` + idempotency ledger pipeline handles this — never try to implement replay-safety outside it.

---

## Key Research Question Resolutions

### 1. Dedupe Algorithm + Threshold (D-02)

**Recommendation: token-set Jaccard at threshold 0.75, borderline band [0.55, 0.75).**

Rationale:
- **Token-set Jaccard** is O(N×M) where N=prompt tokens, M=existing prompts in the tool bucket. Prompt library size is bounded (personal use, 100–500 prompts max). Each comparison is cheap in a Worker (~microseconds).
- It captures the "near, not exact" requirement without requiring a model: a prompt with a swapped word or trailing clause change scores ≥0.75 with the original; entirely different instructions score <0.55.
- It is deterministic and replay-stable (same inputs always yield same Jaccard score).
- `tool`-scoped first: only compare within `e.payload.tool` bucket, reducing false-positive merges across tools.
- **Thresholds are KV-configurable** (`librarian.dedupe_threshold`, `librarian.dedupe_border`) so the owner can tune without a redeploy. [ASSUMED: exact threshold values are starting recommendations — calibrate after real-world use]

### 2. Steward Render Path (definitive answer)

**The existing `op:"upsert"` mapping does NOT cover full-note writes. A targeted extension is required.**

Specifically:
- Current `upsert`: `PATCH /vault/<note>.md` with `Target-Type: frontmatter` + single `Target` field. This can only update ONE frontmatter key. It cannot write a note body.
- Librarian needs: `PUT /vault/Prompts/<slug>.md` with the full Markdown content (YAML front-matter block + blank line + `full_prompt` body text).
- **Extension mechanism:** add `payload.fullNote: true` + `payload.notePath: string` + `payload.noteBody: string` to the `upsert` branch in `packages/steward-core/src/op-mapping.ts`. When `fullNote` is `true`, produce `method: "PUT"`, `path: /vault/${payload.notePath}`, headers with only `Content-Type: text/markdown`. Add `"PUT"` to `SAFE_METHODS`.
- The `daemon/src/drain.ts` `ALLOWED_METHODS` already includes `"PUT"` [VERIFIED: line 54]. Only `op-mapping.ts` needs updating.
- **Prompt library table:** Dataview auto-renders. No Steward write needed for the table itself. [VERIFIED: docs/05-dashboard.md §6]

### 3. /switchboard Skill Shape

**Recommendation: Claude Code slash-command at `.claude/commands/switchboard.md` following the wire-event.md / new-agent.md conventions.**

Key points verified from `.claude/commands/`:
- All commands use YAML front-matter: `description`, `argument-hint`, `allowed-tools`, `model: inherit`.
- `allowed-tools` lists the MCP tools the command may call; use `mcp__context7__*` for library docs per the Switchboard spec.
- The command prompt body is the algorithm to execute, reading `@.claude/registry/mcp-registry.json` and `@codex.md`.
- Since Claude Code commands run in the Claude Code environment (not a Worker), they cannot call `flag()` directly. Switchboard gap reports are output as structured JSON in the response, with instructions for the operator to emit via the incidents pipeline if needed.
- D-07 says "emits a §6.4 incident through the existing incidents pipeline via a thin authed emit reusing the shared `flag()` helper." For a CLI command context, the practical implementation is: the command outputs the gap JSON, and a thin helper or the operator can call an authed endpoint on an existing Worker (e.g., Flagger's own inbound endpoint) to emit the incident. See Gap→Flagger below.

### 4. Registry Config Storage

**Recommendation: tracked JSON file `.claude/registry/mcp-registry.json`.**

Rationale:
- The `/switchboard` command runs in Claude Code (design time), not in a deployed Worker. Claude Code cannot reach CONFIG KV at design time without a Worker intermediary.
- A tracked JSON file is readable by the Claude Code slash-command via `Read` tool with zero runtime dependencies.
- It is version-controlled (changes visible in git diff), auditable, and doesn't require a KV seed step.
- The file mirrors the REGISTRY table in `docs/10-switchboard.md` as a machine-readable structure.
- **For Worker-side reads (if any Worker ever needs registry data):** the file can also be seeded into CONFIG KV as `switchboard.registry` at deployment time — one source of truth, two readers.

```json
// .claude/registry/mcp-registry.json shape
{
  "version": "1",
  "servers": [
    {
      "name": "Gmail",
      "best_at": ["email-read", "email-label", "email-draft"],
      "tools": ["list_labels", "search_threads", "get_thread", "label_thread", "create_draft"],
      "owning_agents": ["Filer", "Herald"],
      "scopes": ["gmail.modify"],
      "health": "connected"
    }
    // ... per docs/10-switchboard.md REGISTRY table
  ],
  "side_effect_verbs": ["post", "register", "pay", "delete", "submit", "send"],
  "ranking_weights": {
    "specificity_over_generality": 1.0,
    "read_before_write": 1.0,
    "health_penalty": 0.5
  }
}
```

[ASSUMED: exact JSON shape — must match the REGISTRY table in docs/10-switchboard.md; the structure above is a reasonable starting point]

### 5. Switchboard Gap→Flagger Emit (D-07)

**Physical location:** The `flag()` call should live in the `/switchboard` command output as instructions, not as a live Worker endpoint.

Full resolution:
- `/switchboard` command is a Claude Code design-time tool. It has no `env.INCIDENTS` binding.
- D-07 says "a thin authed emit reusing the shared `flag()` helper — so gaps land in the Flagger feed." The intent is that gaps are observable, not just console output.
- **Concrete implementation:** When `/switchboard` finds a gap, it (a) outputs the gap JSON with severity annotation in its response, AND (b) if a Worker endpoint is needed for programmatic gap emission, the recommended home is `apps/flagger` (which already exposes a `POST /flag` endpoint used by the heartbeat checker — verified in `apps/flagger/src/index.ts`). The Librarian Worker also has `INCIDENTS` bound and can serve as a thin emit proxy if needed. Neither introduces a second `atlas-wire` consumer (both are producers only).
- **Pillar 1 safety:** `atlas-incidents` already has Flagger as its sole consumer (WEEKLY-02, Phase 2). Any new producer (Librarian Worker, Flagger's own emit, a hypothetical proxy) adds to the producer side only. [VERIFIED: STATE.md Phase 2 decisions]

### 6. Idempotency Keys

Exact structured keys (confirmed from `docs/agents/librarian.md` Example run):
- **New save:** `librarian:<slug>:save` — stable; a re-POST of the exact same prompt on the same day is a no-op (ledger dedup).
- **Dedupe bump (existing slug, different day):** `librarian:<slug>:save:<YYYY-MM-DD>` — allows one `uses` increment per slug per owner-local day. A second bump on the same day is a ledger no-op (replay). Uses `localDate(env)` for the date suffix.
- **Dedupe bump (borderline — keep separate):** new slug derived from the incoming text; key is `librarian:<new-slug>:save`.

Replay invariant: `applyEvent` dedup-checks the `idempotency_keys` table. Same key twice → `meta.changes === 0` → `applied: false` → no double-count, no second note. [VERIFIED: packages/steward-core/src/apply.ts]

### 7. Definition of Done — Three Tests for Librarian

Per CLAUDE.md "Definition of Done — every agent PR ships all three tests":

**Test 1 — Wire-contract test:**
```typescript
// test/wire-contract.test.ts
// Assert: the emitted event shape matches the §6.4 contract (agent, type, entity, op, payload, idempotencyKey)
// Assert: op is "upsert"
// Assert: idempotencyKey matches "librarian:<slug>:save" pattern (stable, structured)
// Assert: payload.fullNote === true; payload.notePath starts with "Prompts/"
// Assert: WireEvent.parse(event) succeeds (no zod error)
```

**Test 2 — Replay test through Steward (requires workerd + applyMigrations):**
```typescript
// test/replay.test.ts
// Apply the same Wire event twice through StewardWriter.apply(e)
// Assert: second apply returns { applied: false }
// Assert: counter (or the relevant entity) is unchanged (meta.changes === 0)
// Assert: vault_outbox has ONE pending row (not two)
```

**Test 3 — Failure-path test:**
```typescript
// test/failure.test.ts
// Empty prompt text → assert flag P4 emitted (kind "empty_capture")
// Borderline dedupe match → assert flag P4 emitted (kind "dedupe_borderline")
// No assert that a new Wire event was emitted (nothing saved on empty)
// Gateway error on claudeFor → assert flag P3 emitted (kind "model_error")
```

---

## Common Pitfalls

### Pitfall 1: Adding "PUT" to SAFE_METHODS breaks the Pillar-2 assertion in op-mapping.ts

**What goes wrong:** `PUT /vault/<note>.md` overwrites the entire note. If the `notePath` is wrong (e.g. `Dashboard/Today.md`), Steward would silently overwrite a critical Vault view.

**Why it happens:** The `fullNote: true` path in `toOutboxIntent` constructs the path from `payload.notePath` — if Librarian sets this incorrectly, Steward's daemon will blindly `PUT` that path.

**How to avoid:** Constrain `payload.notePath` in the `upsert/fullNote` branch to start with `Prompts/`. Add an assertion: `if (!notePath.startsWith("Prompts/")) throw new NonRetryableError(...)`. The check belongs in `toOutboxIntent` (the central mapping), not just in Librarian. [VERIFIED: pattern from NonRetryableError usage in packages/steward-core/src/apply.ts]

**Warning signs:** Any `vault_outbox` row where `method = "PUT"` and `path` does NOT start with `/vault/Prompts/` is a bug.

### Pitfall 2: The Jaccard dedupe reads the D1 prompts table on every POST /prompt/save

**What goes wrong:** If the prompts table grows large (thousands of rows), a full-table scan `SELECT slug, full_prompt FROM prompts WHERE tool = ?` could be slow for a Worker.

**Why it happens:** No pagination; prompts table grows unboundedly (D-05 append-only forever).

**How to avoid:** The `idx_prompts_tool` index limits the scan to within one tool bucket. In practice, a personal prompt library is bounded (~100–500 rows max per tool). If performance is a concern, add a full-text search index or limit the scan to the 100 most recent prompts by `last_used DESC LIMIT 100`. [ASSUMED: 100-500 rows is a reasonable bound for a personal library — flag this if the library grows unexpectedly large]

### Pitfall 3: Slug collision between two prompts with similar titles

**What goes wrong:** Two different prompts derive the same slug (e.g., "Summarize this text" → `summarize-this-text`). The second save overwrites the first note in the Vault.

**Why it happens:** Slug is derived from `title` which is model-generated. Two very different prompts could get the same short title if both are about summarization.

**How to avoid:** After deriving the slug, check D1 for an existing row with that slug but a DIFFERENT `full_prompt`. If found and Jaccard score is below threshold (not a dedupe), append a counter: `summarize-this-text-2`. The idempotency key for the second prompt uses the suffixed slug: `librarian:summarize-this-text-2:save`.

### Pitfall 4: ATLAS_BRIDGE_TOKEN reuse vs. a sibling secret

**What goes wrong:** D-01 says "reuse existing `ATLAS_BRIDGE_TOKEN` OR a sibling secret." Reusing the same token for Librarian and the Obsidian bridge means a token rotation for one breaks the other.

**Why it happens:** Convenience over isolation.

**How to avoid:** Use a new `ATLAS_LIBRARIAN_TOKEN` Secrets Store binding, separate from `ATLAS_BRIDGE_TOKEN`. This follows least-privilege and means a token rotation for one doesn't affect the other. [ASSUMED: the CONTEXT.md says "or a sibling secret" — recommend the sibling approach]

### Pitfall 5: The /switchboard command calling write tools

**What goes wrong:** The Switchboard command has `allowed-tools` including write tools. A user accidentally triggers a write.

**Why it happens:** Liberal allowed-tools specification.

**How to avoid:** `allowed-tools` for `/switchboard` must be READ-ONLY: `Read, Glob, mcp__context7__resolve-library-id, mcp__context7__query-docs, WebSearch`. Never `Write`, `Edit`, `Bash`. Switchboard recommends; it never acts. [VERIFIED: docs/10-switchboard.md §"What it does"]

### Pitfall 6: Second atlas-wire consumer in Librarian's wrangler.jsonc

**What goes wrong:** Adding a `queues.consumers` block for `atlas-wire` in `apps/librarian/wrangler.jsonc` breaks the Pillar-1 CI guard.

**Why it happens:** Copy-paste from an existing Worker that has a consumer block.

**How to avoid:** Librarian's `wrangler.jsonc` must have `queues.producers: [{queue:"atlas-wire", binding:"WIRE"}]` only — no `queues.consumers`. The CI hook at `.claude/hooks/guard-wire-consumer.js` will fail the build if a second consumer is detected. [VERIFIED: .claude/hooks/guard-wire-consumer.js, STATE.md Phase 0 decisions]

---

## Code Examples

### Full Wire event (first save)

```json
{
  "agent": "librarian",
  "type": "prompt.save",
  "entity": "prompt",
  "op": "upsert",
  "payload": {
    "fullNote": true,
    "notePath": "Prompts/make-a-graphic-with-claude.md",
    "noteBody": "---\ntitle: Make a graphic with Claude\ntool: Claude\ntags: [graphic, design, social]\ncreated: 2026-05-29\nlast_used: 2026-05-29\nuses: 1\n---\n\nYou are a senior brand designer. Produce a 1080x1080 ...",
    "title": "Make a graphic with Claude",
    "slug": "make-a-graphic-with-claude",
    "tags": ["graphic", "design", "social"],
    "tool": "Claude",
    "created": "2026-05-29T09:11:00-04:00",
    "last_used": "2026-05-29T09:11:00-04:00",
    "uses": 1
  },
  "idempotencyKey": "librarian:make-a-graphic-with-claude:save"
}
```

### Full Wire event (dedupe bump)

```json
{
  "agent": "librarian",
  "type": "prompt.save",
  "entity": "prompt",
  "op": "upsert",
  "payload": {
    "fullNote": true,
    "notePath": "Prompts/make-a-graphic-with-claude.md",
    "noteBody": "---\ntitle: Make a graphic with Claude\ntool: Claude\ntags: [graphic, design, social]\ncreated: 2026-05-29\nlast_used: 2026-06-09\nuses: 8\n---\n\nYou are a senior brand designer. Produce a 1080x1080 ...",
  },
  "idempotencyKey": "librarian:make-a-graphic-with-claude:save:2026-06-09"
}
```

### toOutboxIntent extension (upsert + fullNote)

```typescript
// In packages/steward-core/src/op-mapping.ts — the ONLY place this mapping lives
// Add "PUT" to SAFE_METHODS:
export const SAFE_METHODS = ["PATCH", "POST", "PUT"] as const;

// In the upsert case, add a sub-branch:
case "upsert": {
  const fullNote = e.payload.fullNote === true;
  if (fullNote) {
    // Full-note write: PUT /vault/<notePath> with the complete note body.
    const notePath = String(e.payload.notePath ?? e.entity);
    // Safety constraint: only allow Prompts/ prefix (never overwrite other views).
    if (!notePath.startsWith("Prompts/")) {
      throw new NonRetryableError(
        `fullNote upsert requires notePath starting with "Prompts/"; got "${notePath}"`
      );
    }
    path = `/vault/${notePath}`;
    method = "PUT";
    headers = { "Content-Type": "text/markdown" };
    body = String(e.payload.noteBody ?? "");
    break;
  }
  // ... existing frontmatter-field upsert branch unchanged
}
```

### Prompt note body builder

```typescript
function buildNoteMarkdown(r: PromptRecord): string {
  const tagsYaml = JSON.stringify(r.tags); // ["graphic","design","social"]
  return [
    "---",
    `title: ${r.title}`,
    `tool: ${r.tool}`,
    `tags: ${tagsYaml}`,
    `created: ${r.created.slice(0, 10)}`,
    `last_used: ${r.last_used.slice(0, 10)}`,
    `uses: ${r.uses}`,
    "---",
    "",
    r.full_prompt,
  ].join("\n");
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `SAFE_METHODS = ["PATCH","POST"]` | Add `"PUT"` for full-note writes | Phase 5 | Unlocks Librarian; also enables future Today.md full-rebuild (mentioned in op-mapping.ts comment) |
| No `prompts` D1 table | `migrations/0008_prompts.sql` | Phase 5 | Enables deterministic dedupe without a model call |
| Librarian not in TIER_MAP | Add `"librarian": "claude-haiku-4-5"` to TIER_MAP | Phase 5 | Prevents silent fallthrough to Sonnet for title/tags derivation |

**Deprecated / outdated in this context:**
- Using `apps/mcp-obsidian-bridge/src/auth.ts`'s inline `timingSafeEqual` as a copy-paste source. Prefer importing from `packages/gate/src/auth.ts` which already exports `timingSafeEqual`. The bridge has its own copy for historical reasons; don't extend that pattern.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Jaccard threshold defaults of 0.75 (near-identical) and 0.55 (borderline) | Dedupe algorithm | Wrong threshold may cause over-merging (too high) or under-merging (too low); impact is cosmetic — the owner sees fewer or more "near-identical" prompts. Config KV mitigates: owner can adjust without a redeploy. |
| A2 | Personal prompt library stays ≤500 rows per tool bucket; full-table scan per save is acceptable | D1 prompts table | If the library grows to thousands of rows, a full-scan dedupe becomes slow; mitigation: add `LIMIT 100 ORDER BY last_used DESC` to the query |
| A3 | `ATLAS_LIBRARIAN_TOKEN` is a new Secrets Store secret (not reusing `ATLAS_BRIDGE_TOKEN`) | Bearer gate | If reusing ATLAS_BRIDGE_TOKEN: token rotation couples Librarian and the Obsidian bridge. Low risk but poor isolation. |
| A4 | `/switchboard` gap reports are output as structured JSON in the Claude Code response, not auto-emitted to atlas-incidents | Switchboard gap→Flagger | If D-07 requires automatic flag emission from the command: the command would need a Worker proxy. This seems an unnecessary complexity for a design-time tool. |
| A5 | `"PUT"` added to `SAFE_METHODS` is safe because `PUT` is a create/overwrite (not delete) | Steward render path | `PUT` overwrites the whole note — if the `notePath` constraint (`Prompts/` prefix) is implemented correctly, this is safe. If the constraint is missing, a bad `notePath` could overwrite a critical Vault note. The constraint is part of the implementation, not an assumption. |
| A6 | The Dataview query in `Dashboard/Prompt Library.md` is pre-existing or will be written as a one-time manual setup by the owner | Prompt library table | If Steward is expected to write the Dataview query block itself, an additional append/upsert Wire event would be needed to seed `Dashboard/Prompt Library.md`. However, `docs/05-dashboard.md §6` documents the Dataview query as a design-time template, not a runtime write. |

---

## Open Questions (RESOLVED)

> All three resolved during planning (Phase 5 plans 05-01..05-04). Retained for the decision trail.

1. **ATLAS_LIBRARIAN_TOKEN vs ATLAS_BRIDGE_TOKEN reuse**
   - What we know: D-01 says "reuse existing ATLAS_BRIDGE_TOKEN or a sibling secret."
   - What's unclear: The phrasing allows either. From a security/isolation standpoint, a sibling secret is better.
   - Recommendation: Use `ATLAS_LIBRARIAN_TOKEN` (a new sibling secret, same Secrets Store, same pattern as `ATLAS_BRIDGE_TOKEN`). Requires an owner go-live step to seed.
   - **RESOLVED:** Use a new `ATLAS_LIBRARIAN_TOKEN` sibling secret (token-rotation isolation). Implemented in 05-02 (Bearer gate) + tracked as an owner go-live seed step.

2. **`Dashboard/Prompt Library.md` initial seeding**
   - What we know: The Dataview query block needs to exist in the file before the table renders. Steward does not currently write this file.
   - What's unclear: Is this a manual one-time owner setup (consistent with how `Dashboard/Flagger.md` was set up), or should Librarian emit a Wire event to create it on first save?
   - Recommendation: Treat it as a one-time owner setup (add it to the go-live checklist alongside the menubar hotkey binding). Document the Dataview query in the process doc.
   - **RESOLVED:** Manual one-time owner setup (consistent with other dashboard views); the Dataview query is documented in the 05-04 Switchboard/runbook deliverable and the go-live checklist. No runtime Steward write to seed it.

3. **`payload.noteBody` size vs. 128 KB Wire cap**
   - What we know: Wire messages cap at 128 KB (enforced by `send()` in `packages/wire/src/send.ts`). A very long prompt + YAML front-matter could approach this.
   - What's unclear: Typical prompt lengths. Most prompts are 100–2000 words (400–8000 bytes). The 128 KB cap is generous.
   - Recommendation: Add a soft 50KB limit in Librarian's inbound validation (reject + P3 flag if `full_prompt.length > 50000`). Document in the Config table.
   - **RESOLVED:** Soft 50KB limit on `full_prompt` in Librarian inbound validation (reject + P3 flag), implemented in 05-02. Keeps the emitted event well under the 128KB Queue cap.

---

## Environment Availability

> No new external dependencies required. All tools already verified in earlier phases.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| D1 (`atlas-db`) | Librarian dedupe table + Steward ledger | ✓ (Phase 0) | — | — |
| CONFIG KV | Dedupe threshold, default tool, note folder | ✓ (Phase 0) | — | `[vars]` defaults |
| WIRE Queue (`atlas-wire`) | Librarian → Steward event bus | ✓ (Phase 0) | — | — |
| INCIDENTS Queue (`atlas-incidents`) | Librarian + Switchboard gap flags | ✓ (Phase 2) | — | — |
| `@atlas/gate` `timingSafeEqual` | Bearer gate on POST /prompt/save | ✓ (Phase 4) | workspace | — |
| AI Gateway (Haiku tier) | title/tags derivation | ✓ (owner-gated Phase 1) | — | Fall back to a simpler title from first 6 words of the prompt |
| Obsidian Local REST API v3 | Final note write (via daemon drain) | ✓ (owner-gated Phase 0) | — | Note stays pending in vault_outbox until bridge is live |

**Missing dependencies with no fallback:** none (all are either provisioned or gracefully degrade).

---

## Validation Architecture

> `workflow.nyquist_validation: true` in `.planning/config.json` — this section is required.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest + `@cloudflare/vitest-pool-workers` v4 |
| Config file | `apps/librarian/vitest.config.ts` (to be created — see Wave 0 Gaps) |
| Quick run command | `pnpm --filter librarian test` |
| Full suite command | `pnpm test` (all workspaces) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| META-01 | Wire event shape is §6.4-valid with `op:"upsert"`, correct `idempotencyKey` | unit | `pnpm --filter librarian test wire-contract` | ❌ Wave 0 |
| META-01 | Replay of same Wire event → `meta.changes === 0`, no second D1 row, no second vault_outbox row | unit (workerd) | `pnpm --filter librarian test replay` | ❌ Wave 0 |
| META-01 | Empty prompt → P4 flag emitted, no Wire event | unit | `pnpm --filter librarian test failure` | ❌ Wave 0 |
| META-01 | Borderline dedupe → P4 flag emitted, keep-separate behavior | unit | `pnpm --filter librarian test failure` | ❌ Wave 0 |
| META-01 | Bearer gate rejects wrong/missing token with 401 | unit | `pnpm --filter librarian test failure` | ❌ Wave 0 |
| META-01 | `toOutboxIntent` with `fullNote:true` produces `PUT /vault/Prompts/<slug>.md` | unit (steward-core) | `pnpm --filter @atlas/steward-core test` | ❌ Wave 0 |
| META-01 | `toOutboxIntent` with `fullNote:true` and `notePath` NOT starting with `Prompts/` throws `NonRetryableError` | unit (steward-core) | `pnpm --filter @atlas/steward-core test` | ❌ Wave 0 |
| META-02 | `/switchboard` command file exists and contains valid YAML front-matter + algorithm body | manual | inspect `.claude/commands/switchboard.md` | ❌ Wave 0 |
| META-02 | `.claude/registry/mcp-registry.json` validates against expected schema | unit (Node) | `pnpm --filter @atlas/registry test` (or inline) | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm --filter librarian test`
- **Per wave merge:** `pnpm test` (full suite)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `apps/librarian/vitest.config.ts` — Vitest workerd config (copy from apps/flagger or apps/echo pattern)
- [ ] `apps/librarian/test/wire-contract.test.ts` — covers META-01 Wire shape
- [ ] `apps/librarian/test/replay.test.ts` — covers META-01 replay invariant (needs `apply-migrations.ts` helper)
- [ ] `apps/librarian/test/failure.test.ts` — covers META-01 failure paths + Bearer gate
- [ ] `apps/librarian/test/apply-migrations.ts` — shared D1 migration runner (copy pattern from `packages/gate/test/apply-migrations.ts`)
- [ ] `packages/steward-core/src/op-mapping.test.ts` (or update existing op-mapping tests) — covers PUT full-note branch

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Bearer token via `timingSafeEqual` (HMAC-SHA-256, fail-closed); `ATLAS_LIBRARIAN_TOKEN` via Secrets Store async binding |
| V3 Session Management | no | Stateless HTTP endpoint; no session |
| V4 Access Control | yes | Token gate on POST /prompt/save; fail-closed on missing binding |
| V5 Input Validation | yes | `zod` for inbound POST body; 50KB soft limit on `full_prompt` |
| V6 Cryptography | yes | HMAC-SHA-256 via Web Crypto API (not hand-rolled) |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Timing-side-channel on Bearer comparison | Information Disclosure | `timingSafeEqual` from `packages/gate/src/auth.ts` (HMAC both sides under fresh key) |
| Oversized prompt body (DoS / 128KB Queue cap) | Denial of Service | 50KB soft limit in Librarian input validation; `WireEventTooLargeError` thrown by `send()` before Queue |
| `notePath` injection (write arbitrary Vault path) | Tampering | Constraint in `toOutboxIntent`: `notePath` must start with `Prompts/`; `NonRetryableError` otherwise |
| Token value in logs or audit_log | Information Disclosure | Token is never logged; `audit_log.scope_used` = empty string for Librarian (no OAuth scope); Bearer value never written to any D1 row |
| `full_prompt` containing secrets (API keys, tokens) | Information Disclosure | The prompt content is owner-written; no automated stripping needed here (unlike Herald's email body). The owner must not save prompts containing secrets — document this in the user-facing runbook. |

---

## Sources

### Primary (HIGH confidence)

- `packages/gate/src/auth.ts` — `timingSafeEqual` export signature (VERIFIED)
- `packages/wire/src/contract.ts` — `WireEvent` zod schema, only definition (VERIFIED)
- `packages/wire/src/send.ts` — `send(env, event)` signature, 128KB cap enforcement (VERIFIED)
- `packages/shared/src/flag.ts` — `flag(env, severity, title, detail?, opts?)` signature; `localDate()` (VERIFIED)
- `packages/shared/src/incident.ts` — `RawIncident` type (VERIFIED)
- `packages/model/src/claude.ts` — `claudeFor(agent, env)` signature; `TIER_MAP`; Librarian missing (VERIFIED)
- `packages/steward-core/src/op-mapping.ts` — `toOutboxIntent`; `SAFE_METHODS = ["PATCH","POST"]`; upsert = PATCH frontmatter field (VERIFIED)
- `packages/steward-core/src/apply.ts` — `applyEvent`; D1 batch; replay invariant (VERIFIED)
- `apps/steward/src/steward-consumer.ts` — single atlas-wire consumer; serial for-of; Pillar 1 (VERIFIED)
- `apps/mcp-obsidian-bridge/src/auth.ts` — Bearer gate pattern reference (VERIFIED)
- `daemon/src/drain.ts` — `ALLOWED_METHODS = new Set(["PATCH","PUT","POST"])` (VERIFIED); PUT already allowed in daemon
- `docs/agents/librarian.md` — canonical Wire event shape; idempotencyKey examples; record shape (VERIFIED)
- `docs/09-prompt-library.md` — dedupe algorithm description; note format; table layout (VERIFIED)
- `docs/10-switchboard.md` — 6-step algorithm; REGISTRY table; gap→Flagger severities (VERIFIED)
- `docs/agents/switchboard.md` — recommendation JSON shape; Config: registry in KV (VERIFIED)
- `docs/05-dashboard.md` §6 — Dataview query for Prompt library table; `Prompts/` folder (VERIFIED)
- `docs/SPEC-CANON.md` §9 — canonical record shape + 4-column table contract (VERIFIED)
- `.claude/commands/wire-event.md`, `new-agent.md`, `cf-docs.md` — command/skill conventions (VERIFIED)
- `.planning/REQUIREMENTS.md` — META-01, META-02 acceptance criteria (VERIFIED)
- `.planning/phases/05-meta-polish/05-CONTEXT.md` — all locked decisions D-01..D-07 (VERIFIED)

### Secondary (MEDIUM confidence)

- `apps/steward/src/steward.ts` — DO `apply()` wraps `applyEvent`; `blockConcurrencyWhile` pattern (VERIFIED)
- `packages/shared/src/env.ts` — `Env` interface; `INCIDENTS?` binding type (VERIFIED)
- `migrations/0001_init_core.sql` — existing D1 schema; no `prompts` table exists (VERIFIED)

### Tertiary (LOW confidence — informing recommendations only)

- Jaccard threshold values (0.75 / 0.55) are [ASSUMED] starting recommendations based on common text similarity practice; not from official docs

---

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — all packages verified from source; no new external deps
- Architecture: HIGH — Steward render path gap verified from `op-mapping.ts`; daemon PUT already allowed verified from `drain.ts`
- Pitfalls: HIGH — sourced from source code and CLAUDE.md conventions; verified against existing implementation
- Dedupe threshold: LOW — assumed starting values; must be calibrated

**Research date:** 2026-06-09
**Valid until:** 2026-07-09 (stable ecosystem; SDK pins move weekly but Phase 5 doesn't add new Cloudflare SDK dependencies)
