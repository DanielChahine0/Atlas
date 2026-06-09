# Phase 5: Meta / Polish — Pattern Map

**Mapped:** 2026-06-09
**Files analyzed:** 14 new/modified files
**Analogs found:** 14 / 14

---

## File Classification

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---------------------|------|-----------|----------------|---------------|
| `apps/librarian/src/index.ts` | controller (fetch handler) | request-response | `apps/mcp-obsidian-bridge/src/index.ts` | exact |
| `apps/librarian/src/auth.ts` | middleware (Bearer gate) | request-response | `apps/mcp-obsidian-bridge/src/auth.ts` + `packages/gate/src/auth.ts` | exact |
| `apps/librarian/src/derive.ts` | service (AI derivation) | request-response | `packages/model/src/claude.ts` (claudeFor pattern) | role-match |
| `apps/librarian/src/dedupe.ts` | utility (similarity check) | CRUD (D1 read) | `packages/steward-core/src/apply.ts` (D1 positional-? reads) | partial |
| `apps/librarian/src/env.ts` | config | — | `packages/shared/src/env.ts` | exact |
| `apps/librarian/wrangler.jsonc` | config | — | `apps/mcp-obsidian-bridge/wrangler.jsonc` | exact |
| `apps/librarian/package.json` | config | — | `apps/flagger/package.json` | exact |
| `apps/librarian/vitest.config.ts` | config (test) | — | `apps/flagger/vitest.config.ts` | exact |
| `apps/librarian/test/apply-migrations.ts` | test helper | — | `packages/gate/test/apply-migrations.ts` | exact |
| `apps/librarian/test/wire-contract.test.ts` | test (Wire shape) | — | `apps/steward/test/replay.test.ts` + `apps/flagger/test/routing.test.ts` | role-match |
| `apps/librarian/test/replay.test.ts` | test (replay invariant) | — | `apps/steward/test/replay.test.ts` | exact |
| `apps/librarian/test/failure.test.ts` | test (failure paths) | — | `apps/flagger/test/ack-auth.test.ts` + `apps/flagger/test/routing.test.ts` | role-match |
| `packages/steward-core/src/op-mapping.ts` | service (op→REST mapping) | CRUD | self (targeted addition) | self-modification |
| `packages/model/src/claude.ts` | service (model factory) | request-response | self (TIER_MAP addition) | self-modification |
| `migrations/0008_prompts.sql` | migration | CRUD | `migrations/0003_tasks.sql` | exact |
| `.claude/commands/switchboard.md` | config (slash-command) | — | `.claude/commands/wire-event.md` + `.claude/commands/new-agent.md` | exact |
| `.claude/registry/mcp-registry.json` | config (tracked JSON) | — | no prior analog (new artifact class) | no analog |

---

## Pattern Assignments

### `apps/librarian/src/index.ts` (controller, request-response)

**Analog:** `apps/mcp-obsidian-bridge/src/index.ts`

**Imports pattern** (lines 1–26 of analog):
```typescript
import { send } from "@atlas/wire";
import { flag, localDate } from "@atlas/shared";
import type { Env } from "./env.js";
import { bearerGate, unauthorized } from "./auth.js";
import { deriveRecord } from "./derive.js";
import { dedupeLookup } from "./dedupe.js";
```

**Core fetch-handler pattern** (lines 39–62 of analog — adapt to `POST /prompt/save`):
```typescript
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
```

**Key structural rules:**
- `satisfies ExportedHandler<Env>` (NOT `: ExportedHandler<Env>`) on the default export.
- Only one inbound path (`/prompt/save`). All other paths return 404 — narrow surface.
- Method check before auth check (405 before 401 is conventional; auth before body parse).

---

### `apps/librarian/src/auth.ts` (middleware, request-response)

**Analog:** `apps/mcp-obsidian-bridge/src/auth.ts` (lines 1–66) — use as structural template.
**Import:** `timingSafeEqual` from `packages/gate/src/auth.ts` (lines 18–38) — do NOT re-implement.

**`packages/gate/src/auth.ts` export** (lines 18–38 — the function to import, not re-implement):
```typescript
// packages/gate/src/auth.ts lines 18–38
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  try {
    const enc = new TextEncoder();
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey(
      "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const da = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
    const db = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
    let diff = 0;
    for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
    return diff === 0;
  } catch {
    return false;  // Fail-closed
  }
}
```

**Bearer-gate pattern to copy** (from `apps/mcp-obsidian-bridge/src/auth.ts` lines 11–66):
```typescript
// apps/librarian/src/auth.ts — adapt from mcp-obsidian-bridge/src/auth.ts
import { timingSafeEqual } from "@atlas/gate";  // import, never re-implement

export interface LibrarianAuthEnv {
  ATLAS_LIBRARIAN_TOKEN?: SecretsStoreSecret;  // new sibling secret, not ATLAS_BRIDGE_TOKEN
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

export async function authorizeSave(request: Request, env: LibrarianAuthEnv): Promise<boolean> {
  const expected = await env.ATLAS_LIBRARIAN_TOKEN?.get();
  if (!expected) return false;  // fail-closed: no secret configured ⇒ no access
  const presented = bearer(request);
  if (!presented) return false;
  return await timingSafeEqual(presented, expected);
}

export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
  });
}
```

**Security invariant:** `timingSafeEqual` from `packages/gate/src/auth.ts` is length-independent (HMAC both sides under a fresh key). Never use `===` or `crypto.timingSafeEqual` (not available in Workers). Fail-closed: return `false` on any error or missing binding.

---

### `apps/librarian/src/derive.ts` (service, request-response)

**Analog:** `packages/model/src/claude.ts` — the `claudeFor` usage pattern (lines 194–242).

**claudeFor call pattern** (lines 194–242 of analog):
```typescript
// packages/model/src/claude.ts — claudeFor returns AgentClaude
export async function claudeFor(agent: string, env: ModelEnv): Promise<AgentClaude> { ... }

// Usage in derive.ts:
import { claudeFor } from "@atlas/model";

export async function deriveRecord(
  promptText: string,
  env: Env,
): Promise<{ title: string; tags: string[]; slug: string }> {
  const claude = await claudeFor("librarian", env);
  const resp = await claude.messages.create({
    max_tokens: 128,
    messages: [{
      role: "user",
      content: `Output ONLY JSON: {"title":"<≤6 words>","tags":["tag1","tag2","tag3"]}. No explanation.\n\nPrompt:\n${promptText.slice(0, 2000)}`,
    }],
  }) as { content: Array<{ type: string; text: string }> };
  const text = resp.content.find(b => b.type === "text")?.text ?? "{}";
  const parsed = JSON.parse(text) as { title?: string; tags?: string[] };
  const title = (parsed.title ?? promptText.split(/\s+/).slice(0, 6).join(" ")).slice(0, 80);
  const tags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [];
  const slug = title.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return { title, tags, slug };
}
```

**Key rule:** `claudeFor("librarian", env)` requires `"librarian"` to be in `TIER_MAP` (see `packages/model/src/claude.ts` lines 26–35). Add it before using it. Model ID: `"claude-haiku-4-5"`.

---

### `apps/librarian/src/dedupe.ts` (utility, CRUD)

**Analog:** `packages/steward-core/src/apply.ts` — D1 positional-`?` pattern (lines 92–132).

**D1 positional-`?` read pattern** (from `packages/steward-core/src/apply.ts` lines 92–101):
```typescript
// D1 positional ? only — no named params (:slug, ?1, etc.)
// From apply.ts — adapt for dedupe SELECT:

const rows = await db.prepare(
  "SELECT slug, full_prompt FROM prompts WHERE tool = ? ORDER BY last_used DESC LIMIT 100"
).bind(tool).all<{ slug: string; full_prompt: string }>();
```

**Jaccard dedupe structure** (RESEARCH.md Pattern 3 — deterministic, no model):
```typescript
function normalise(text: string): string {
  return text.trim().toLowerCase()
    .replace(/\s+/g, " ")
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

// Returns: { match: "bump" | "borderline" | "new", slug?: string, score?: number }
export async function dedupeLookup(db: D1Database, text: string, tool: string, threshold: number, border: number) { ... }
```

**KV config read pattern** (from `packages/model/src/claude.ts` lines 86–88 — same pattern for dedupe thresholds):
```typescript
const override = await env.CONFIG.get("librarian.dedupe_threshold");
const threshold = override ? Number(override) : 0.75;
```

---

### `apps/librarian/src/env.ts` (config)

**Analog:** `packages/shared/src/env.ts` (lines 1–71) — extend `Env` with Librarian-specific bindings.

**Pattern** (from `packages/shared/src/env.ts` lines 22–71):
```typescript
// apps/librarian/src/env.ts — narrow the shared Env surface for Librarian
import type { Env as SharedEnv } from "@atlas/shared";

export interface Env extends SharedEnv {
  // Librarian Bearer secret — new sibling to ATLAS_BRIDGE_TOKEN (Pitfall 4)
  ATLAS_LIBRARIAN_TOKEN?: SecretsStoreSecret;
  // WIRE, DB, CONFIG, INCIDENTS inherited from SharedEnv
  // AI-Gateway bindings (ANTHROPIC_API_KEY, CF_AIG_TOKEN, AIG_ACCOUNT_ID, AIG_GATEWAY_ID)
  // inherited from SharedEnv for claudeFor("librarian", env)
}
```

---

### `apps/librarian/wrangler.jsonc` (config)

**Analog:** `apps/mcp-obsidian-bridge/wrangler.jsonc` (lines 1–50) — HTTP-only Worker, no crons, no DO.

**Pattern to copy and adapt:**
```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "librarian",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-25",
  "compatibility_flags": ["nodejs_compat"],

  // PRODUCER ONLY — no consumers block (Pillar 1; CI guard-wire-consumer.js will fail
  // if atlas-wire appears in consumers). Librarian emits to atlas-wire and atlas-incidents.
  "queues": {
    "producers": [
      { "binding": "WIRE",      "queue": "atlas-wire" },
      { "binding": "INCIDENTS", "queue": "atlas-incidents" }
    ]
    // NO "consumers" block — Pillar 1 hard gate
  },

  "d1_databases": [{
    "binding": "DB",
    "database_name": "atlas-db",
    "database_id": "<atlas-db-id>",
    "migrations_dir": "../../migrations"
  }],

  "kv_namespaces": [{ "binding": "CONFIG", "id": "<config-kv-id>" }],

  "secrets_store_secrets": [{
    "binding": "ATLAS_LIBRARIAN_TOKEN",
    "store_id": "<atlas-store-id>",
    "secret_name": "atlas-librarian-token"
  },
  { "binding": "ANTHROPIC_API_KEY", "store_id": "<atlas-store-id>", "secret_name": "anthropic-api-key" },
  { "binding": "CF_AIG_TOKEN",      "store_id": "<atlas-store-id>", "secret_name": "cf-aig-token" }],

  "vars": {
    "AIG_ACCOUNT_ID": "<account-id>",
    "AIG_GATEWAY_ID": "atlas-highvolume"  // Haiku → high-volume gateway
  },

  "observability": { "enabled": true },

  "env": {
    "staging": { "triggers": { "crons": [] } }
  }
}
```

---

### `apps/librarian/package.json` (config)

**Analog:** `apps/flagger/package.json` (lines 1–24) — exact structure, swap name/deps.

```json
{
  "name": "@atlas/librarian",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "build": "wrangler deploy --dry-run --outdir dist",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@atlas/gate":   "workspace:*",
    "@atlas/model":  "workspace:*",
    "@atlas/shared": "workspace:*",
    "@atlas/wire":   "workspace:*"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.16.13",
    "@cloudflare/workers-types": "^4.20260425.0",
    "vitest": "^4.1.8"
  }
}
```

---

### `apps/librarian/vitest.config.ts` (test config)

**Analog:** `apps/flagger/vitest.config.ts` (lines 1–18) — copy exactly, update comment.

```typescript
// apps/librarian/vitest.config.ts — copy of apps/flagger/vitest.config.ts
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Librarian tests run in real workerd (TZ=UTC). Apply all migrations including 0008.
const migrations = await readD1Migrations("../../migrations");

export default defineConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    provide: { migrations },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { compatibilityFlags: ["nodejs_compat"] },
    }),
  ],
});
```

Also need `apps/librarian/wrangler.test.jsonc` — mirror of `wrangler.jsonc` without remote IDs (same pattern as `apps/flagger/wrangler.test.jsonc` lines 1–39).

---

### `apps/librarian/test/apply-migrations.ts` (test helper)

**Analog:** `packages/gate/test/apply-migrations.ts` (lines 1–19) — copy verbatim (identical to `apps/flagger/test/apply-migrations.ts`).

```typescript
import { beforeAll, inject } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";

declare module "vitest" {
  interface ProvidedContext { migrations: D1Migration[]; }
}

const migrations = inject("migrations");

beforeAll(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await applyD1Migrations(db, migrations);
});
```

---

### `apps/librarian/test/wire-contract.test.ts` (test, Wire shape)

**Analog:** `apps/steward/test/replay.test.ts` (lines 1–83) + `apps/flagger/test/routing.test.ts` (lines 24–98 for `fakeBatch`/`makeTestEnv` helpers).

**Pattern — Wire event assertions:**
```typescript
// Copy the spy-env + fakeBatch skeleton from apps/flagger/test/routing.test.ts lines 47-98
// Key assertions for Librarian wire-contract test:

import { WireEvent } from "@atlas/wire";

it("emits a §6.4-valid Wire event with op:upsert and structured idempotencyKey", async () => {
  // ... call handleSave with a valid prompt POST ...
  const emitted = wireEvents[0]!;

  // §6.4 schema validation (the only definition in packages/wire/src/contract.ts)
  expect(() => WireEvent.parse(emitted)).not.toThrow();

  expect(emitted.agent).toBe("librarian");
  expect(emitted.type).toBe("prompt.save");
  expect(emitted.entity).toBe("prompt");
  expect(emitted.op).toBe("upsert");

  // idempotencyKey: stable structured form "librarian:<slug>:save" (first save)
  expect(emitted.idempotencyKey).toMatch(/^librarian:[a-z0-9-]+:save$/);

  // fullNote payload convention (Steward render path)
  expect(emitted.payload.fullNote).toBe(true);
  expect(String(emitted.payload.notePath)).toMatch(/^Prompts\//);
});
```

---

### `apps/librarian/test/replay.test.ts` (test, replay invariant)

**Analog:** `apps/steward/test/replay.test.ts` (lines 1–83) — exact structural copy, swap agent + event shape.

**Pattern** (from `apps/steward/test/replay.test.ts` lines 19–83):
```typescript
// Use StewardWriter.apply() from apps/steward/src/steward.ts — same DO, same apply() method
const STEWARD_LOCK = (env as unknown as { STEWARD_LOCK: DurableObjectNamespace<StewardWriter> }).STEWARD_LOCK;

it("replaying a Librarian upsert event is a no-op (applied:false, no second vault_outbox row)", async () => {
  const steward = STEWARD_LOCK.getByName("vault");
  const evt: WireEvent = {
    agent: "librarian",
    type: "prompt.save",
    entity: "prompt",
    op: "upsert",
    payload: {
      fullNote: true,
      notePath: "Prompts/test-prompt.md",
      noteBody: "---\ntitle: Test Prompt\n---\n\nContent.",
    },
    idempotencyKey: "librarian:test-prompt:save",
  };

  expect(await steward.apply(evt)).toEqual({ applied: true });
  expect(await steward.apply(evt)).toEqual({ applied: false }); // replay → skipped
});
```

**Note:** This test requires the `op-mapping.ts` extension (fullNote branch + PUT in SAFE_METHODS) to be merged first, or the test will throw on `toOutboxIntent`.

---

### `apps/librarian/test/failure.test.ts` (test, failure paths + Bearer gate)

**Analog:** `apps/flagger/test/ack-auth.test.ts` (lines 1–60 for Bearer gate structure) + `apps/flagger/test/routing.test.ts` (lines 254–292 for malformed → P4 path).

**Bearer gate failure pattern** (from `apps/flagger/test/ack-auth.test.ts` lines 29–55):
```typescript
function makeAuthEnv(opts: { tokenSeeded?: boolean; token?: string } = {}) {
  return {
    ATLAS_LIBRARIAN_TOKEN: opts.tokenSeeded !== false
      ? { get: vi.fn(async () => opts.token ?? CORRECT_TOKEN) }
      : { get: vi.fn(async () => null) },
    INCIDENTS: { send: vi.fn(async () => {}) },
    WIRE: { send: vi.fn(async () => {}) },
    // ... CONFIG, DB stubs
  };
}

it("missing Authorization header → 401", async () => {
  const env = makeAuthEnv();
  const req = new Request("https://librarian.workers.dev/prompt/save", { method: "POST" });
  const resp = await librarian.fetch(req, env as unknown as Env);
  expect(resp.status).toBe(401);
});

it("missing ATLAS_LIBRARIAN_TOKEN binding → 401 (fail-closed)", async () => {
  const env = makeAuthEnv({ tokenSeeded: false });
  // ...expect 401
});

it("empty prompt text → P4 flag emitted, no Wire event", async () => {
  const incidents: RawIncident[] = [];
  const wireEvents: WireEvent[] = [];
  // ... call with empty body, assert flag(env, "P4", ...) → incidents.length === 1
  // assert wireEvents.length === 0
});

it("borderline dedupe → P4 flag emitted, keep-separate (second Wire event for new slug)", async () => { ... });
```

---

### `packages/steward-core/src/op-mapping.ts` (service — targeted addition)

**Self-modification — two precise changes only.** Read the current file (lines 1–125) before editing.

**Change 1 — add `"PUT"` to `SAFE_METHODS`** (line 39 of current file):
```typescript
// BEFORE (line 39):
export const SAFE_METHODS = ["PATCH", "POST"] as const;

// AFTER:
export const SAFE_METHODS = ["PATCH", "POST", "PUT"] as const;
```

**Change 2 — add `fullNote` sub-branch at the TOP of the `upsert` case** (before line 70):
```typescript
case "upsert": {
  // ── NEW: full-note PUT (Librarian Prompts/<slug>.md) ──────────────────────
  if (e.payload.fullNote === true) {
    const notePath = String(e.payload.notePath ?? e.entity);
    // Safety constraint (Pitfall 1): only allow Prompts/ prefix — never overwrite
    // critical Dashboard views. Fail loud (NonRetryableError → ack + P3) not silent.
    if (!notePath.startsWith("Prompts/")) {
      throw new NonRetryableError(
        `fullNote upsert requires notePath starting with "Prompts/"; got "${notePath}"`,
      );
    }
    return {
      idem: e.idempotencyKey,
      path: `/vault/${notePath}`,
      method: "PUT" as SafeMethod,  // after adding "PUT" to SAFE_METHODS
      headers: JSON.stringify({
        "Content-Type": "text/markdown",
        "X-Atlas-Idem": e.idempotencyKey,
      }),
      body: String(e.payload.noteBody ?? ""),
    };
  }
  // ── EXISTING: frontmatter-field upsert (unchanged) ────────────────────────
  const note = String(e.payload.note ?? e.entity);
  // ... rest of existing upsert case unchanged ...
}
```

**Import to add** (at top of file — `NonRetryableError` is already used in `apply.ts`):
```typescript
import { NonRetryableError } from "cloudflare:workflows";
```

**Daemon note:** `daemon/src/drain.ts` line 55 already has `const ALLOWED_METHODS = new Set(["PATCH", "PUT", "POST"])`. No daemon change needed.

---

### `packages/model/src/claude.ts` (service — TIER_MAP addition)

**Self-modification — one line only.** Current `TIER_MAP` (lines 26–35):
```typescript
// BEFORE — "librarian" missing, falls through to DEFAULT_MODEL (Sonnet = 4x cost)
const TIER_MAP: Record<string, string> = {
  atlas: "claude-opus-4-8",
  compass: "claude-opus-4-8",
  archivist: "claude-opus-4-8",
  forge: "claude-sonnet-4-6",
  herald: "claude-sonnet-4-6",
  scout: "claude-sonnet-4-6",
  headhunter: "claude-sonnet-4-6",
  filer: "claude-haiku-4-5",
};

// AFTER — add one entry:
  librarian: "claude-haiku-4-5",   // title/tags derivation: Haiku, high-volume gateway
```

---

### `migrations/0008_prompts.sql` (migration)

**Analog:** `migrations/0003_tasks.sql` (lines 1–55) — exact header/comment style + DDL pattern.

**Pattern to copy** (from `migrations/0003_tasks.sql`):
```sql
-- migrations/0008_prompts.sql
--
-- Atlas D1 prompt library (system-of-record for Librarian's dedupe lookup).
-- D1 is authoritative (Pillar 4); the Vault Prompts/<slug>.md notes are rendered
-- projections written by Steward on receipt of the Wire upsert.
--
-- HARD RULES (same as 0001/0003):
--   * D1 supports anonymous positional `?` params ONLY at the call site.
--   * No per-edit history (D-04 chose overwrite); append-only forever (D-05).
--   * tags stored as JSON TEXT (not a separate table) — personal use, ≤500 rows/tool.

CREATE TABLE IF NOT EXISTS prompts (
  slug        TEXT PRIMARY KEY,
  tool        TEXT NOT NULL DEFAULT 'Claude',
  full_prompt TEXT NOT NULL,
  title       TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',   -- JSON array as TEXT
  created     TEXT NOT NULL,                -- ISO-8601 owner-local
  last_used   TEXT NOT NULL,                -- ISO-8601 owner-local
  uses        INTEGER NOT NULL DEFAULT 1
);

-- Scoped dedupe scan: SELECT slug, full_prompt FROM prompts WHERE tool = ?
CREATE INDEX IF NOT EXISTS idx_prompts_tool ON prompts(tool);
```

---

### `.claude/commands/switchboard.md` (slash-command)

**Analog:** `.claude/commands/wire-event.md` (lines 1–25) + `.claude/commands/new-agent.md` (lines 1–30) — copy YAML frontmatter structure exactly.

**YAML frontmatter pattern** (from `.claude/commands/wire-event.md` lines 1–6 and `cf-docs.md` lines 1–5):
```markdown
---
description: Given a goal, run the 6-step Switchboard algorithm and return a ranked toolset recommendation (MCP servers + exact tools + scopes + executing agent + confirmation-gate flag). Gaps → Flagger. Design-time only — never executes tools or writes anything.
argument-hint: <natural-language goal, e.g. "post a LinkedIn update about my new blog post">
allowed-tools: Read, Glob, mcp__context7__resolve-library-id, mcp__context7__query-docs, WebSearch
model: inherit
---
```

**Command body pattern** (from `.claude/commands/new-agent.md` lines 8–30 — first-read-then-act structure):
```markdown
Run the Switchboard 6-step algorithm for goal: **$ARGUMENTS**

First read the source of truth:
- `.claude/registry/mcp-registry.json` — machine-readable MCP registry (servers → capabilities → tools → scopes → owning agent)
- `docs/10-switchboard.md` — the 6-step selection algorithm + selection heuristics + worked example
- `docs/agents/switchboard.md` — recommendation JSON shape + Config table
- `codex.md` (if present) — Codex identity/account facts (OAuth scopes already granted)

Then execute the 6 steps from docs/10-switchboard.md:
1. Intent parse...
[...]

Return the toolset recommendation JSON. On gap: output the gap as structured JSON with severity annotation per docs/08-flagger.md §8. Do NOT write to any file or call any write tool.
```

**Key rules from analog commands:**
- `allowed-tools` must be READ-ONLY only: `Read, Glob, mcp__context7__*, WebSearch`. Never `Write`, `Edit`, `Bash`.
- Command body uses `$ARGUMENTS` (not `$1`) for the argument.
- Start with "First read the source of truth" before acting.

---

### `.claude/registry/mcp-registry.json` (tracked JSON)

**No analog** — new artifact class in this repo. Structure from RESEARCH.md Pattern 8 / docs/10-switchboard.md REGISTRY table:
```json
{
  "version": "1",
  "servers": [
    {
      "name": "<server-name>",
      "best_at": ["capability-tag-1", "capability-tag-2"],
      "tools": ["tool_name_1", "tool_name_2"],
      "owning_agents": ["Agent1", "Agent2"],
      "scopes": ["oauth.scope"],
      "health": "connected"
    }
  ],
  "side_effect_verbs": ["post", "register", "pay", "delete", "submit", "send"],
  "ranking_weights": {
    "specificity_over_generality": 1.0,
    "read_before_write": 1.0,
    "health_penalty": 0.5
  }
}
```

Populate from `docs/10-switchboard.md` REGISTRY table and `docs/06-hosting-cloudflare-mcp.md`.

---

## Shared Patterns

### Bearer Gate (auth)
**Source:** `packages/gate/src/auth.ts` lines 18–38 (`timingSafeEqual`) + `apps/mcp-obsidian-bridge/src/auth.ts` lines 52–58 (`authorizeBridge` structure)
**Apply to:** `apps/librarian/src/auth.ts`
```typescript
// Import — never re-implement:
import { timingSafeEqual } from "@atlas/gate";

// Gate function shape (fail-closed on every error path):
export async function authorizeSave(request: Request, env: LibrarianAuthEnv): Promise<boolean> {
  const expected = await env.ATLAS_LIBRARIAN_TOKEN?.get();
  if (!expected) return false;
  const presented = bearer(request);
  if (!presented) return false;
  return await timingSafeEqual(presented, expected);
}
```

### Wire Event Emission
**Source:** `packages/wire/src/send.ts` lines 47–57; `packages/wire/src/contract.ts` lines 26–35
**Apply to:** `apps/librarian/src/index.ts`
```typescript
import { send } from "@atlas/wire";

await send(env, {
  agent: "librarian",
  type: "prompt.save",
  entity: "prompt",
  op: "upsert",
  payload: { fullNote: true, notePath: `Prompts/${slug}.md`, noteBody: "..." },
  idempotencyKey: `librarian:${slug}:save`,  // first save (stable)
  // OR: `librarian:${slug}:save:${localDate(env)}` for a dedupe bump
});
// send() validates schema + enforces 128KB cap before Queue.send()
```

### Flagger Emit
**Source:** `packages/shared/src/flag.ts` lines 93–112
**Apply to:** `apps/librarian/src/index.ts` (all failure and borderline paths)
```typescript
import { flag, localDate } from "@atlas/shared";

// Empty prompt:
await flag(env, "P4", "Librarian: empty prompt capture — nothing saved", undefined,
  { sourceAgent: "Librarian", kind: "empty_capture" });

// Borderline dedupe:
await flag(env, "P4", "Librarian: borderline duplicate detected",
  `slug=${existingSlug}, score=${score.toFixed(2)}`,
  { sourceAgent: "Librarian", kind: "dedupe_borderline",
    suggestedAction: "Review the two prompts and merge if appropriate." });

// Gateway error: claudeFor handles this automatically via flagGatewayError (model/src/claude.ts line 256)
// — no additional flag() call needed for claudeFor errors.
```

### Owner-local Date
**Source:** `packages/shared/src/flag.ts` lines 9–11
**Apply to:** `apps/librarian/src/index.ts` (created/last_used timestamps + bump idempotency key suffix)
```typescript
import { localDate } from "@atlas/shared";

// workerd forces TZ=UTC — use this helper for owner-local YYYY-MM-DD:
const date = localDate(env);  // "2026-06-09" (America/Toronto)
```

### Structured Idempotency Key
**Source:** `packages/wire/src/contract.ts` lines 18–22 (rule comment) + `apps/steward/test/replay.test.ts` lines 24–36 (key shapes)
**Apply to:** `apps/librarian/src/index.ts`
- First save: `librarian:<slug>:save` — stable, replay is ledger no-op at any age
- Dedupe bump: `librarian:<slug>:save:<YYYY-MM-DD>` — one `uses` increment per slug per owner-local day
- Never `crypto.randomUUID()` on the keyed path

### D1 Positional `?` Params
**Source:** `packages/steward-core/src/apply.ts` lines 94–118 (all bind() calls use positional `?`)
**Apply to:** `apps/librarian/src/dedupe.ts`, `apps/librarian/src/index.ts` (any D1 statement)
```typescript
// D1 supports positional ? ONLY — never :named or ?1 forms
const rows = await db.prepare(
  "SELECT slug, full_prompt FROM prompts WHERE tool = ? ORDER BY last_used DESC LIMIT 100"
).bind(tool).all<{ slug: string; full_prompt: string }>();

await db.prepare(
  "INSERT INTO prompts(slug, tool, full_prompt, title, tags, created, last_used, uses) VALUES (?,?,?,?,?,?,?,?)"
).bind(slug, tool, fullPrompt, title, JSON.stringify(tags), created, lastUsed, 1).run();
```

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `.claude/registry/mcp-registry.json` | config (tracked JSON) | — | No existing tracked JSON registries in this repo; new artifact class. Structure from `docs/10-switchboard.md` REGISTRY table. |

---

## Critical Integration Order

The RESEARCH.md "Primary recommendation" (§Summary) maps directly to dependency order. The planner MUST sequence these waves:

1. **Wave 0 (unblocks everything):**
   - `packages/steward-core/src/op-mapping.ts` — add `"PUT"` + `fullNote` branch
   - `packages/model/src/claude.ts` — add `librarian: "claude-haiku-4-5"` to TIER_MAP
   - `migrations/0008_prompts.sql` — prompts table

2. **Wave 1 (Librarian core):**
   - `apps/librarian/src/auth.ts`, `env.ts`, `dedupe.ts`, `derive.ts`, `index.ts`
   - `apps/librarian/wrangler.jsonc`, `wrangler.test.jsonc`, `package.json`, `vitest.config.ts`

3. **Wave 2 (Librarian tests):**
   - `apps/librarian/test/apply-migrations.ts`, `wire-contract.test.ts`, `replay.test.ts`, `failure.test.ts`
   - `packages/steward-core` op-mapping unit tests (new: `packages/steward-core/test/op-mapping.test.ts`)

4. **Wave 3 (Switchboard):**
   - `.claude/registry/mcp-registry.json`
   - `.claude/commands/switchboard.md`
   - `docs/10-switchboard.md` annotation pass (process doc formalization — no new file)

---

## Metadata

**Analog search scope:** `apps/`, `packages/`, `migrations/`, `.claude/commands/`
**Files scanned:** 22 source files read in full; 2 read with targeted offset
**Pattern extraction date:** 2026-06-09
