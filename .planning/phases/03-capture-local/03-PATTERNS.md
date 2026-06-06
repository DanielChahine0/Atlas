# Phase 3: Capture (Local) — Pattern Map

**Mapped:** 2026-06-06
**Files analyzed:** 18 new/modified files
**Analogs found:** 13 / 18 (5 have no in-repo analog — Swift-only or new cloud primitives)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/echo/src/echo-session.ts` | DO (WebSocket Hibernation) | streaming | `apps/steward/src/steward.ts` + `apps/forge/src/lock.ts` | role-match (DO shape + blockConcurrencyWhile) |
| `apps/echo/src/presign.ts` | Worker endpoint (OAuth-gated) | request-response | `apps/mcp-obsidian-bridge/src/index.ts` + `apps/mcp-google/src/index.ts` | role-match (token-gated endpoint) |
| `apps/echo/src/index.ts` | Worker entrypoint | request-response | `apps/forge/src/index.ts` | exact (WorkerEntrypoint + DO export + satisfies pattern) |
| `apps/echo/wrangler.jsonc` | config | — | `apps/headhunter/wrangler.jsonc` | exact (DO + WIRE/INCIDENTS producers + BLOBS + DB) |
| `apps/echo/vitest.config.ts` | test config | — | `apps/headhunter/vitest.config.ts` | exact |
| `apps/echo/src/__tests__/echo-session.test.ts` | test | streaming | `apps/steward/test/replay.test.ts` + `apps/steward/test/serialize.test.ts` | role-match (DO test + wire-contract + replay pattern) |
| `apps/echo/src/__tests__/presign.test.ts` | test | request-response | `apps/steward/test/malformed.test.ts` | role-match (spy env, scope enforcement) |
| `apps/archivist/src/archivist.ts` | WorkflowEntrypoint | event-driven | `apps/atlas/src/morning-chain.ts` | exact (WorkflowEntrypoint, step.do, NonRetryableError) |
| `apps/archivist/src/index.ts` | Worker entrypoint | event-driven | `apps/forge/src/index.ts` | exact (WorkerEntrypoint shell, no cron) |
| `apps/archivist/wrangler.jsonc` | config | — | `apps/headhunter/wrangler.jsonc` (+ atlas.wrangler.jsonc workflows block) | role-match |
| `apps/archivist/vitest.config.ts` | test config | — | `apps/headhunter/vitest.config.ts` | exact |
| `apps/archivist/src/__tests__/archivist.test.ts` | test | event-driven | `apps/steward/test/replay.test.ts` + `apps/sundial/test/wire.test.ts` | role-match |
| `migrations/0006_meetings.sql` | migration | — | `migrations/0004_incidents_flagger.sql` | exact (DDL conventions, positional ?, indexes) |
| `capture/com.atlas.capture.plist` | launchd config | — | `daemon/com.atlas.bridge.plist` | exact (KeepAlive, RunAtLoad, no inbound port, log paths) |
| `capture/Sources/Shared/Auth.swift` | auth utility | request-response | `daemon/src/drain.ts` (loadConfig + pollOnce pattern) | partial-match (outbound-only pattern; Swift has no Node analog) |
| `capture/Sources/Shared/OutboxChannel.swift` | polling utility | event-driven | `daemon/src/drain.ts` (drainLoop / drainOnce) | partial-match (poll/drain/ack loop; Swift translation) |
| `capture/Sources/Echo/*` | capture pipeline | streaming | no in-repo analog | no analog — external refs only |
| `capture/Sources/Quill/*` | autofill utility | request-response | no in-repo analog | no analog — external refs only |

---

## Pattern Assignments

### `apps/echo/src/echo-session.ts` (DO, streaming)

**Analog 1:** `apps/steward/src/steward.ts` (DO shape + `blockConcurrencyWhile` error-capture pattern)
**Analog 2:** `apps/forge/src/lock.ts` (minimal DO with one serialized RPC method)

**Imports pattern** (`apps/forge/src/lock.ts` lines 14–15, `apps/steward/src/steward.ts` lines 1–4):
```typescript
import { DurableObject } from "cloudflare:workers";
import type { Env } from "@atlas/shared";
```

**DO class declaration** (`apps/steward/src/steward.ts` line 28):
```typescript
export class EchoSession extends DurableObject<Env> {
```

**Constructor with setWebSocketAutoResponse** (RESEARCH.md Pattern 1, verified against DO API):
```typescript
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  // Auto-reply to ping/pong WITHOUT waking the DO from hibernation.
  // compatibility_date >= 2026-04-25 already satisfies this.
  this.ctx.setWebSocketAutoResponse(
    new WebSocketRequestResponsePair("ping", "pong"),
  );
}
```

**blockConcurrencyWhile error-capture pattern** (`apps/steward/src/steward.ts` lines 42–56):
```typescript
// DO NOT throw inside blockConcurrencyWhile — capture error, re-throw after gate closes
// to keep the DO healthy. This is the canonical StewardWriter pattern.
const outcome = await this.ctx.blockConcurrencyWhile(
  async (): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
    try {
      return { ok: true, value: await doWork() };
    } catch (error) {
      return { ok: false, error };
    }
  },
);
if (!outcome.ok) throw outcome.error;
return outcome.value;
```

**WebSocket Hibernation (acceptWebSocket + serializeAttachment)**:
```typescript
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) return new Response("Missing session_id", { status: 400 });

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  // acceptWebSocket() enables Hibernation: DO can be evicted between messages.
  // Tags = [sessionId] for getWebSockets(sessionId) on reconnect.
  this.ctx.acceptWebSocket(server, [sessionId]);
  // serializeAttachment survives hibernation wakeup (16 KB limit).
  server.serializeAttachment({ sessionId });
  return new Response(null, { status: 101, webSocket: client });
}

async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
  const { sessionId } = ws.deserializeAttachment() as { sessionId: string };
  const segment = JSON.parse(message as string) as TranscriptSegment;
  // Idempotent on segment index — replay-safe.
  await this.ctx.storage.put(`seg:${sessionId}:${segment.idx}`, segment);
}

async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
  // compatibility_date >= 2026-04-07 auto-replies to Close frames.
  ws.close(code, reason);
  const { sessionId } = ws.deserializeAttachment() as { sessionId: string };
  await this.ctx.storage.put(`finalized:${sessionId}`, Date.now());
}
```

**Key differences from Steward/ForgeLock:**
- `EchoSession` is addressed as `getByName("echo-<ISO-timestamp>")` (per-meeting, not per-date or singleton "vault").
- Implements WebSocket Hibernation methods (`fetch`, `webSocketMessage`, `webSocketClose`) that no existing DO has.
- DO SQLite stores `seg:<sessionId>:<idx>` (segment buffer) rather than counters or vault_outbox.
- NEVER use `ws.accept()` — that keeps the DO in memory; always `ctx.acceptWebSocket()`.

---

### `apps/echo/src/presign.ts` (Worker endpoint, request-response)

**Analog:** `apps/mcp-obsidian-bridge/src/index.ts` (narrow token-gated endpoints) + `apps/mcp-google/src/index.ts` (scope enforcement pattern)

**Token-gated endpoint pattern** (`apps/mcp-obsidian-bridge/src/index.ts` lines 39–62):
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/echo/presign") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handlePresign(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

**Scope enforcement pattern** (`apps/mcp-google/src/index.ts` lines 28–30):
```typescript
// Check capture app's OAuth bearer token + required scope before minting URL.
// Fail closed: missing scope = 403 (not 401 — the token is valid, the scope is absent).
// Mirror: grantedScopes(ctx.props.scopes).has("echo:presign") pattern from mcp-google.
```

**Presign URL minting** (RESEARCH.md Pattern 2):
```typescript
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

async function mintPresignedPut(env: Env, key: string, contentType: string): Promise<string> {
  const S3 = new S3Client({
    region: "auto",
    endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: await env.R2_ACCESS_KEY_ID.get(), // Secrets Store binding
      secretAccessKey: await env.R2_SECRET_ACCESS_KEY.get(),
    },
  });
  return getSignedUrl(
    S3,
    new PutObjectCommand({ Bucket: "atlas-blobs", Key: key, ContentType: contentType }),
    { expiresIn: 3600 },
  );
}
// LIMITATION: presigned URLs cannot be tested in wrangler dev — deploy to staging.
```

**Key differences from mcp-obsidian-bridge:**
- Presign endpoint needs `BLOBS` R2 binding, `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` Secrets Store bindings.
- Must also check `DB` D1 (verify session exists before minting URL).
- Key prefixes are `transcripts/<session_id>.json` and `audio/raw/<session_id>.opus` only.

---

### `apps/echo/src/index.ts` (Worker entrypoint, request-response)

**Analog:** `apps/forge/src/index.ts` (WorkerEntrypoint + DO re-export + `satisfies ExportedHandler`)

**Entrypoint pattern** (`apps/forge/src/index.ts` lines 259–381):
```typescript
export { EchoSession } from "./echo-session.js";
export type { Env } from "./env.js";

export class Echo extends WorkerEntrypoint<Env> {
  // RPC methods the Atlas coordinator calls (e.g. to finalize a session).
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Route presign + health check endpoints
  },
} satisfies ExportedHandler<Env>;
```

**`satisfies ExportedHandler<Env>` annotation** — copy exactly, never `: ExportedHandler<Env>`.

---

### `apps/echo/wrangler.jsonc` (config)

**Analog:** `apps/headhunter/wrangler.jsonc` (DO + WIRE/INCIDENTS producers + DB + CONFIG + AI) + `apps/atlas/wrangler.jsonc` (BLOBS R2 binding).

**Complete config pattern** (from `apps/headhunter/wrangler.jsonc` lines 1–64 and `apps/atlas/wrangler.jsonc` line 54):
```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "echo",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-25",
  "compatibility_flags": ["nodejs_compat"],

  // EchoSession DO — per-meeting WebSocket Hibernation.
  // new_sqlite_classes (Free-plan SQLite DO). NEVER legacy new_classes.
  "durable_objects": {
    "bindings": [{ "name": "ECHO_SESSION", "class_name": "EchoSession" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["EchoSession"] }],

  // Pillar 1: Echo is a Wire PRODUCER only. NO queues.consumers block.
  // D2-05: Echo also produces onto atlas-incidents via flag() for incident routing.
  "queues": {
    "producers": [
      { "binding": "WIRE", "queue": "atlas-wire" },
      { "binding": "INCIDENTS", "queue": "atlas-incidents" }
    ]
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "atlas-db",
      "database_id": "e7fee76c-2e3d-486e-8a8a-fd1aec6a5af3",
      "migrations_dir": "../../migrations"
    }
  ],

  "kv_namespaces": [{ "binding": "CONFIG", "id": "296ee0ec788542c68bb01a90e46c6cf2" }],

  // BLOBS R2: audio/raw/ 7d lifecycle + transcripts/ persist (atlas.wrangler.jsonc line 54).
  "r2_buckets": [{ "binding": "BLOBS", "bucket_name": "atlas-blobs" }],

  "ai": { "binding": "AI" },

  // R2 presign credentials (Secrets Store — NEVER in [vars]).
  "secrets_store_secrets": [
    { "binding": "R2_ACCESS_KEY_ID", "store_id": "<atlas-store-id>", "secret_name": "r2-access-key-id" },
    { "binding": "R2_SECRET_ACCESS_KEY", "store_id": "<atlas-store-id>", "secret_name": "r2-secret-access-key" }
  ],

  "vars": {
    "AIG_ACCOUNT_ID": "<set-before-phase-1>",
    "AIG_GATEWAY_ID": "atlas-reasoning"
  },

  "observability": { "enabled": true },

  "env": {
    "staging": { "triggers": { "crons": [] } }
  }
}
```

**Key additions vs headhunter:**
- `r2_buckets` block (from atlas wrangler).
- `secrets_store_secrets` for R2 API credentials.
- No `services` block (Echo does not call other agents via RPC; Atlas calls it).

---

### `apps/echo/vitest.config.ts` (test config)

**Analog:** `apps/headhunter/vitest.config.ts` — copy verbatim, change filter to `@atlas/echo`.

```typescript
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

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

Corresponding `wrangler.test.jsonc` must declare `ECHO_SESSION` DO binding + `WIRE`/`INCIDENTS` producers + `DB`/`BLOBS` bindings (no real Secrets Store IDs in test config — use stub values).

---

### `apps/echo/src/__tests__/echo-session.test.ts` (test)

**Analog:** `apps/steward/test/replay.test.ts` (replay-through-Steward pattern) + `apps/steward/test/serialize.test.ts` (same-name = same-instance pattern).

**Test structure to copy** (`apps/steward/test/replay.test.ts` lines 1–18):
```typescript
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { WireEvent } from "@atlas/wire";
import type { EchoSession } from "../src/echo-session.js";

const ECHO_SESSION = (
  env as unknown as { ECHO_SESSION: DurableObjectNamespace<EchoSession> }
).ECHO_SESSION;

describe("EchoSession DO — WebSocket Hibernation + segment accumulation", () => {
  it("acceptWebSocket + serializeAttachment accumulates segments correctly", async () => {
    // Use getByName with a stable test session_id (never randomUUID)
    const session = ECHO_SESSION.getByName("echo-2026-06-06T14-00-00");
    // ... send WebSocket messages, verify storage keys
  });

  it("reconnect-to-same-DO (getByName) resumes from stored segments", async () => {
    // Same getByName = same instance; stored seg: keys present after reconnect
  });
});
```

**Wire-contract test** (from `apps/sundial/test/wire.test.ts` lines 22–31 pattern):
```typescript
describe("Echo Wire-contract — transcript.ready", () => {
  it("emits canonical §6.4 shape with structured idempotencyKey", () => {
    const evt = buildTranscriptReadyEvent("echo-2026-06-06T14-00-00");
    expect(evt.agent).toBe("Echo");
    expect(evt.type).toBe("transcript.ready");
    expect(evt.op).toBe("upsert");
    expect(evt.idempotencyKey).toBe("echo:2026-06-06T14-00-00:ready");
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });
});
```

**Replay test** (`apps/steward/test/replay.test.ts` lines 19–36 pattern):
```typescript
it("replaying transcript.ready Wire event → Steward → meta.changes===0", async () => {
  const evt = buildTranscriptReadyEvent("echo-2026-06-06T14-00-00");
  expect(await applyEvent(db, evt)).toEqual({ applied: true });
  expect(await applyEvent(db, evt)).toEqual({ applied: false }); // replay no-op
});
```

---

### `apps/echo/src/__tests__/presign.test.ts` (test)

**Analog:** `apps/steward/test/malformed.test.ts` (spy env + scope/auth enforcement assertions).

**Spy env pattern** (`apps/steward/test/malformed.test.ts` lines 36–46):
```typescript
function makeSpyEnv() {
  const incidents: RawIncident[] = [];
  const spyEnv = {
    ...(env as unknown as Env),
    INCIDENTS: {
      send: vi.fn(async (inc: RawIncident) => { incidents.push(inc); }),
    },
  } as unknown as Env;
  return { spyEnv, incidents };
}
```

**Scope enforcement test shape:**
```typescript
it("valid OAuth scope echo:presign → 200 with presigned URL", async () => {
  // Mock OAuthProvider context providing correct scope
  // assert response status 200 + URL starts with r2 endpoint
});

it("missing scope → 403 (fail closed)", async () => {
  // Mock OAuthProvider context with wrong/missing scope
  // assert response status 403
});
```

---

### `apps/archivist/src/archivist.ts` (WorkflowEntrypoint, event-driven)

**Analog:** `apps/atlas/src/morning-chain.ts` (WorkflowEntrypoint, step.do, NonRetryableError import, halt-on-failure).

**Critical imports** (`apps/atlas/src/morning-chain.ts` lines 30–36):
```typescript
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowStep, WorkflowEvent } from "cloudflare:workers";
// NonRetryableError is from cloudflare:WORKFLOWS (NOT cloudflare:workers — critical distinction)
import { NonRetryableError } from "cloudflare:workflows";
import { flag } from "@atlas/shared";
```

**Workflow body factored out for testability** (`apps/atlas/src/morning-chain.ts` lines 78–82):
```typescript
// Factor the orchestration body OUT of the class so it is unit-testable with a fake step.
// The class run() is a thin delegate.
export async function runArchivist(
  env: ArchivistEnv,
  event: Readonly<WorkflowEvent<{ session_id: string }>>,
  step: Pick<WorkflowStep, "do">,
): Promise<void> { ... }

export class ArchivistWorkflow extends WorkflowEntrypoint<ArchivistEnv, { session_id: string }> {
  override async run(event: Readonly<WorkflowEvent<{ session_id: string }>>, step: WorkflowStep): Promise<void> {
    await runArchivist(this.env, event, step);
  }
}
```

**Step-do pattern with retry config** (`apps/atlas/src/morning-chain.ts` lines 99–109):
```typescript
const result = await step.do<StepResult>(
  "fetch-transcript",
  { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
  async () => {
    const obj = await this.env.BLOBS.get(`transcripts/${session_id}.json`);
    if (!obj) throw new NonRetryableError(`Transcript not found: ${session_id}`);
    const t = await obj.json<Transcript>();
    if (t.consent === "discarded") throw new NonRetryableError("Consent discarded");
    return t;
  }
);
// Do NOT mutate event.payload inside a step (reverts on replay) — return and pass state forward.
```

**`claudeFor` with explicit effort** (`packages/model/src/claude.ts` line 26 TIER_MAP + D5):
```typescript
// Archivist resolves to claude-opus-4-8 via TIER_MAP["archivist"] in packages/model.
// NEVER omit effort — Opus defaults to "high". Set explicitly per D5 cost discipline.
const claude = await claudeFor("archivist", this.env);
const response = await claude.messages.create({
  model: await modelFor("archivist", this.env),
  max_tokens: 8192,
  thinking: { type: "enabled", budget_tokens: 0 }, // disable thinking for cost control
  messages: [...],
  // effort: explicitly set, never rely on default
});
```

**Wire emission from a Workflow step** (`apps/atlas/src/morning-chain.ts` emitHalt pattern):
```typescript
await step.do("emit-steward", async () => {
  await send(this.env, {
    agent: "Archivist",
    type: "meeting.note",
    entity: "note",
    op: "upsert",
    payload: { session_id, note: structuredNote },
    idempotencyKey: `archivist:${session_id}:note`,
  });
});

// Forge action items: one per owner action item
await step.do("emit-action-items", async () => {
  for (let i = 0; i < note.ownerActionItems.length; i++) {
    await send(this.env, {
      agent: "Archivist",
      type: "action-item",
      entity: "task",
      op: "upsert",
      payload: { title: note.ownerActionItems[i].action, due: note.ownerActionItems[i].due,
        source: "meeting", meeting: `${note.series}/${note.date}` },
      // Structured key: archivist:<series>:<date>:ai-NN (zero-padded two digits)
      idempotencyKey: `archivist:${note.series}:${note.date}:ai-${String(i).padStart(2, "0")}`,
    });
  }
});
```

**Failure path flag** (`apps/atlas/src/morning-chain.ts` lines 142–166 emitHalt + `packages/shared/src/flag.ts` lines 93–112):
```typescript
await flag(
  env,
  "P2",
  "archivist transcript not found",
  `Session ${session_id} transcript missing from R2 transcripts/ prefix.`,
  { sourceAgent: "Archivist", kind: "transcript_missing", runId: session_id },
);
```

**Key differences from MorningChain:**
- `ArchivistWorkflow` is triggered per-session-end (not a cron). Instance id = `archivist-<session_id>`.
- Steps are sequential but there is no `sleepUntil` — Archivist runs after meeting end, not on a wall-clock schedule.
- Has R2 `BLOBS` binding (reads transcript blob in step 1).
- Emits two kinds of Wire events (Steward upsert + Forge action items).
- `NonRetryableError` for `consent:"discarded"` is the Archivist equivalent of a phishing skip in Forge.

---

### `apps/archivist/src/index.ts` (Worker entrypoint, event-driven)

**Analog:** `apps/forge/src/index.ts` lines 375–380 (no-cron shell):
```typescript
export { ArchivistWorkflow } from "./archivist.js";

export default {
  fetch(): Response {
    return new Response("Archivist runs as a Workflow triggered by Atlas on meeting end.", { status: 200 });
  },
} satisfies ExportedHandler<ArchivistEnv>;
```

---

### `apps/archivist/wrangler.jsonc` (config)

**Analog:** `apps/headhunter/wrangler.jsonc` (base) + `apps/atlas/wrangler.jsonc` (workflows block, lines 94–100 + BLOBS R2).

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "archivist",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-25",
  "compatibility_flags": ["nodejs_compat"],

  // Workflows block — pattern from apps/atlas/wrangler.jsonc lines 94-100.
  "workflows": [
    {
      "name": "atlas-archivist",
      "binding": "ARCHIVIST_WF",
      "class_name": "ArchivistWorkflow"
    }
  ],
  // No DO — Archivist Workflow does not own a stateful DO (uses R2 + Wire).
  // "migrations" with empty new_sqlite_classes required if workflows is present:
  "migrations": [{ "tag": "v1", "new_sqlite_classes": [] }],

  // Pillar 1: Archivist is a Wire PRODUCER only. NO queues.consumers block.
  "queues": {
    "producers": [
      { "binding": "WIRE", "queue": "atlas-wire" },
      { "binding": "INCIDENTS", "queue": "atlas-incidents" }
    ]
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "atlas-db",
      "database_id": "e7fee76c-2e3d-486e-8a8a-fd1aec6a5af3",
      "migrations_dir": "../../migrations"
    }
  ],

  "kv_namespaces": [{ "binding": "CONFIG", "id": "296ee0ec788542c68bb01a90e46c6cf2" }],

  // BLOBS R2: Archivist reads transcript from R2 in step 1.
  "r2_buckets": [{ "binding": "BLOBS", "bucket_name": "atlas-blobs" }],

  "ai": { "binding": "AI" },

  "vars": {
    "AIG_ACCOUNT_ID": "<set-before-phase-1>",
    "AIG_GATEWAY_ID": "atlas-reasoning",
    "MODEL_ARCHIVIST": "claude-opus-4-8"
  },

  "observability": { "enabled": true },

  "env": {
    "staging": { "triggers": { "crons": [] } }
  }
}
```

---

### `apps/archivist/vitest.config.ts` (test config)

**Analog:** `apps/headhunter/vitest.config.ts` — copy verbatim.

---

### `apps/archivist/src/__tests__/archivist.test.ts` (test)

**Analog:** `apps/steward/test/replay.test.ts` + `apps/sundial/test/wire.test.ts`.

**Wire-contract test** (from `apps/sundial/test/wire.test.ts` lines 22–32 pattern):
```typescript
describe("Archivist Wire-contract", () => {
  it("emits canonical §6.4 meeting.note upsert with structured idempotencyKey", () => {
    const evt = buildMeetingNoteEvent("echo-2026-06-06T14-00-00", note);
    expect(evt.agent).toBe("Archivist");
    expect(evt.type).toBe("meeting.note");
    expect(evt.op).toBe("upsert");
    expect(evt.idempotencyKey).toBe("archivist:echo-2026-06-06T14-00-00:note");
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });

  it("action-item idempotencyKey is archivist:<series>:<date>:ai-NN", () => {
    const evt = buildActionItemEvent("weekly-atlas-sync", "2026-06-06", 1);
    expect(evt.idempotencyKey).toBe("archivist:weekly-atlas-sync:2026-06-06:ai-01");
    expect(() => WireEvent.parse(evt)).not.toThrow();
  });
});
```

**Replay test** (`apps/steward/test/replay.test.ts` pattern):
```typescript
it("replaying Archivist upsert → meta.changes===0 (no double note)", async () => {
  const evt = buildMeetingNoteEvent("echo-2026-06-06T14-00-00", note);
  expect(await applyEvent(db, evt)).toEqual({ applied: true });
  expect(await applyEvent(db, evt)).toEqual({ applied: false });
});
```

**Failure-path test** (`apps/steward/test/malformed.test.ts` spy env pattern):
```typescript
it("consent:discarded transcript → NonRetryableError, no Wire events emitted", async () => {
  // Mock BLOBS.get returning consent:"discarded" transcript
  // Assert: WIRE.send never called, INCIDENTS.send called with P2 severity
  // Assert: Workflow instance status = "failed"
});

it("transcript missing from R2 → Flagger P2 via INCIDENTS", async () => {
  // Mock BLOBS.get returning null
  // Assert: INCIDENTS.send called with { severity_hint: "P2", kind: "transcript_missing" }
});
```

**Effort-set test:**
```typescript
it("Opus pass sets effort explicitly (never omits it)", async () => {
  // Spy on claudeFor return value; assert messages.create called with
  // an explicit effort or thinking setting, never relying on the Opus default "high"
});
```

---

### `migrations/0006_meetings.sql` (migration)

**Analog:** `migrations/0004_incidents_flagger.sql` (DDL conventions, header comment, index patterns).

**Header comment pattern** (`migrations/0004_incidents_flagger.sql` lines 1–17):
```sql
-- migrations/0006_meetings.sql
--
-- Atlas D1 Phase-3 table — transcript index for Echo/Archivist pipeline.
-- D1 is authoritative (Pillar 4); transcript blobs live in R2.
--
-- HARD RULES (same as 0001/0004 — see CLAUDE.md gotchas):
--   * D1 supports anonymous positional `?` params ONLY (no named params).
--   * KV is NOT the system-of-record — D1 is.
--   * Idempotency is on session_id (PRIMARY KEY); re-run is INSERT OR REPLACE.
```

**Table DDL pattern** (from RESEARCH.md Claude's Discretion recommendations):
```sql
CREATE TABLE IF NOT EXISTS meetings (
  session_id        TEXT PRIMARY KEY,        -- "echo-2026-06-06T14-00-03"
  calendar_event    TEXT,                    -- null for audio-active arm
  consent           TEXT NOT NULL,           -- "granted" | "discarded"
  audio_disposition TEXT NOT NULL,           -- "local-only" | "r2-approved" | "discarded"
  transcript_r2_key TEXT,                    -- null until uploaded
  audio_r2_key      TEXT,                    -- null unless r2-approved
  started           INTEGER NOT NULL,        -- epoch ms
  ended             INTEGER,                 -- null until session ends
  archivist_run     TEXT,                    -- Workflow instance id once triggered
  created_at        INTEGER NOT NULL         -- epoch ms (Date.now())
);

CREATE INDEX IF NOT EXISTS idx_meetings_consent   ON meetings(consent);
CREATE INDEX IF NOT EXISTS idx_meetings_started   ON meetings(started);
```

**Key differences from 0004:**
- Single table (not four tables).
- `session_id TEXT PRIMARY KEY` — the natural stable key, NOT autoincrement.
- No FK constraints (D1 does not enforce FKs; enforce at app layer — same as 0004 jobs→windows).

---

### `capture/com.atlas.capture.plist` (launchd config)

**Analog:** `daemon/com.atlas.bridge.plist` — exact copy with three changes only.

**Copy pattern** (`daemon/com.atlas.bridge.plist` lines 21–56):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- Change 1: new Label (separate launchd agent from com.atlas.bridge) -->
  <key>Label</key>
  <string>com.atlas.capture</string>

  <!-- Change 2: ProgramArguments points at the Swift binary, not Node -->
  <key>ProgramArguments</key>
  <array>
    <string>/Users/USERNAME/Atlas/capture/.build/release/AtlasCapture</string>
  </array>

  <!-- RunAtLoad + KeepAlive: copy verbatim from com.atlas.bridge.plist lines 38-41 -->
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <!-- NO inbound listener key of any kind — same rule as com.atlas.bridge -->
  <!-- NO Sockets, ListenStream, NetworkBindTimeout -->

  <!-- Change 3: new log paths -->
  <key>StandardOutPath</key>
  <string>/tmp/atlas-capture.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/atlas-capture.err.log</string>

  <!-- SECRETS NOT IN THIS FILE. Token stored in macOS Keychain (not EnvironmentVariables). -->
</dict>
</plist>
```

**Three invariants preserved from com.atlas.bridge.plist:**
1. `KeepAlive` + `RunAtLoad` — always on, restart on exit.
2. Zero inbound-listener keys — no `Sockets`, no `ListenStream`, no `NetworkBindTimeout`.
3. Secrets never in this file — `ATLAS_BRIDGE_TOKEN` is in `EnvironmentVariables` for the Node bridge, but the Swift app reads from the macOS Keychain directly (no `EnvironmentVariables` block needed).

---

### `capture/Sources/Shared/Auth.swift` (auth utility, pattern-only)

**Analog:** `daemon/src/drain.ts` (loadConfig + OAuth bearer outbound pattern, lines 61–70 + 85–93).

**Pattern to replicate in Swift (not a port — Swift translation):**

The `loadConfig` pattern in `daemon/src/drain.ts` (lines 61–70) translates to Swift Keychain reads:
```typescript
// Node (daemon/src/drain.ts lines 61-70) — the pattern:
export function loadConfig(env: Record<string, string | undefined>): DaemonConfig {
  const bridgeToken = env.ATLAS_BRIDGE_TOKEN;
  if (!bridgeToken) throw new Error("daemon misconfigured: ATLAS_BRIDGE_TOKEN is not set");
  return { bridgeBaseUrl, bridgeToken, ... };
}
```

```swift
// Swift equivalent pattern (Auth.swift) — read token from Keychain, not env:
// SecItemCopyMatching(query, &result) → extract as String
// Throw a loud fatal error if the token is missing (fail-safe, never fabricate)
// Store: SecItemAdd(attributes, nil) — called at first OAuth grant
// Never store the token in UserDefaults, plist, or any tracked file
```

The bearer header pattern (`daemon/src/drain.ts` lines 85–93):
```typescript
// Node pollOnce: Authorization: Bearer ${cfg.bridgeToken}
const res = await deps.fetchCloud(`${cfg.bridgeBaseUrl}/bridge/poll`, {
  headers: { Authorization: `Bearer ${cfg.bridgeToken}` },
});
```

```swift
// Swift equivalent: URLRequest + setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
// All outbound URLSession calls use default certificate validation (no local exception)
// The local Obsidian write (127.0.0.1:27124) is NOT in scope for the capture app
```

---

### `capture/Sources/Shared/OutboxChannel.swift` (polling utility, pattern-only)

**Analog:** `daemon/src/drain.ts` (drainOnce + drainLoop, lines 118–193).

**Pattern to replicate in Swift:**

The `drainOnce` pattern (`daemon/src/drain.ts` lines 118–134):
```typescript
// Node: poll → for each intent: execute then ack ONLY after success
export async function drainOnce(cfg, deps): Promise<number> {
  const intents = await pollOnce(cfg, deps);
  let drained = 0;
  for (const intent of intents) {  // SERIAL (for…of, never Promise.all)
    if (!ALLOWED_METHODS.has(intent.method.toUpperCase())) throw new Error(...)
    await deps.writeObsidian(intent, cfg);
    await ackIntent(intent.idem, cfg, deps);  // ack ONLY after successful execute
    drained++;
  }
  return drained;
}
```

```swift
// Swift equivalent in OutboxChannel.swift:
// - URLSession dataTask/async to poll /capture/poll (outbound, HTTPS, full cert validation)
// - Process each returned command SERIALLY (for loop, not async TaskGroup)
// - Execute the command (e.g. open EchoSession WS, trigger Quill) 
// - Only ack after successful execution: POST /capture/ack { idem }
// - On error: back off and leave intent pending (never drop silently)
```

The `drainLoop` pattern (`daemon/src/drain.ts` lines 177–192):
```swift
// Swift: Task { while !cancelled { do { try await drainOnce() } catch { backoff } } }
// KeepAlive in launchd handles process restart; the loop handles transient errors
```

---

## Shared Patterns

### Wire Producer Pattern
**Source:** `packages/wire/src/send.ts` (lines 47–57) + `packages/wire/src/contract.ts` (lines 26–35)
**Apply to:** `apps/echo/src/echo-session.ts`, `apps/archivist/src/archivist.ts`
```typescript
import { send } from "@atlas/wire";
import type { WireEvent } from "@atlas/wire";

// send() validates the §6.4 shape (WireEvent.parse) + checks 128 KB cap before Queue.send.
// Never call env.WIRE.send() directly — always use send(env, event).
await send(env, {
  agent: "Echo",           // codename matches TIER_MAP key and Wire routing
  type: "transcript.ready",
  entity: "session",
  op: "upsert",            // increment=counters, upsert=stable-rows, append=feeds
  payload: { ... },
  idempotencyKey: "echo:2026-06-06T14-00-00:ready",  // NEVER crypto.randomUUID()
});
```

### Flagger flag() Pattern
**Source:** `packages/shared/src/flag.ts` (lines 93–112)
**Apply to:** All cloud Workers in Phase 3
```typescript
import { flag } from "@atlas/shared";

// flag() enqueues to atlas-incidents (NOT atlas-wire — that would violate Pillar 1).
// Flagger (Phase 2) is the sole consumer; it scores and routes to atlas-wire.
await flag(
  env,              // must have INCIDENTS: Queue<RawIncident>
  "P2",             // severity: P1=100 trust, P2=95, P3=50, P4=70
  "archivist transcript not found",
  `Session ${session_id} missing from R2.`,
  { sourceAgent: "Archivist", kind: "transcript_missing", runId: session_id },
);
```

### claudeFor Pattern (Opus, explicit effort)
**Source:** `packages/model/src/claude.ts` (lines 26–36 TIER_MAP, D5 constraint)
**Apply to:** `apps/archivist/src/archivist.ts` only
```typescript
import { claudeFor, modelFor } from "@atlas/model";

// Archivist resolves to claude-opus-4-8 via TIER_MAP["archivist"].
// ALWAYS set effort explicitly. Opus defaults to "high" — never omit it (D5).
const modelId = await modelFor("archivist", env);
// claudeFor returns a configured Anthropic SDK client bound to AI Gateway.
// Route: atlas-reasoning gateway (Opus = reasoning gateway, not highvolume).
```

### localDate (TZ=UTC gotcha)
**Source:** `packages/shared/src/flag.ts` lines 9–11
**Apply to:** all cloud Workers with any date derivation
```typescript
import { localDate } from "@atlas/shared";

// NEVER new Date().toISOString().slice(0,10) — workerd forces TZ=UTC.
// localDate() uses Intl with America/Toronto: returns YYYY-MM-DD in owner-local time.
const today = localDate(env);
```

### DO getByName naming convention
**Source:** `apps/steward/src/steward.ts` line 9 + `apps/headhunter/src/state.ts` lines 44–49
**Apply to:** `apps/echo/src/echo-session.ts`
```typescript
// EchoSession: per-meeting instance. Name = "echo-<ISO-timestamp>" (stable, structured).
// Reconnect to the SAME session by using the SAME name — one name = one instance.
const session = env.ECHO_SESSION.getByName(`echo-${isoTimestamp}`);

// Do NOT use randomUUID() as the DO name — breaks reconnect idempotency.
// Compare: env.STEWARD_LOCK.getByName("vault") = singleton;
//          env.FORGE_LOCK.getByName(date) = per-run;
//          env.ECHO_SESSION.getByName("echo-<ts>") = per-meeting.
```

### `satisfies ExportedHandler<Env>` convention
**Source:** `apps/mcp-obsidian-bridge/src/index.ts` line 62, `apps/forge/src/index.ts` line 380
**Apply to:** All new Worker default exports
```typescript
// ALWAYS satisfies, NEVER : ExportedHandler<Env> (CLAUDE.md non-negotiable).
export default { ... } satisfies ExportedHandler<Env>;
```

### Test apply-migrations setup
**Source:** `apps/headhunter/vitest.config.ts` (injects migrations) — see also steward's `test/apply-migrations.ts`.
**Apply to:** `apps/echo/vitest.config.ts`, `apps/archivist/vitest.config.ts`

Copy `test/apply-migrations.ts` verbatim from `apps/headhunter/test/` (or `apps/steward/test/`) — it calls `applyD1Migrations(env.DB, inject("migrations"))` in `beforeAll`. This pattern is identical across all test-bearing Workers.

---

## No Analog Found — External Reference Only

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `capture/Sources/Echo/AudioTap.swift` | audio capture | streaming | `AudioHardwareCreateProcessTap` + `CATapDescription` + IOProc + RMS watchdog — no macOS audio code exists in repo. External refs: `developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps` + `github.com/insidegui/AudioCap`. |
| `capture/Sources/Echo/TranscriptionPipeline.swift` | STT + diarization | streaming | WhisperKit `argmax-oss-swift` v1.0.0 (new monorepo URL — NOT `argmaxinc/WhisperKit`) + FluidAudio `LSEENDDiarizer` v0.15.1 (16 kHz mono Float32 requirement). External refs: `github.com/argmaxinc/argmax-oss-swift`, `github.com/FluidInference/FluidAudio`. |
| `capture/Sources/Echo/ConsentGate.swift` | UI / consent | event-driven | SwiftUI/AppKit `NSStatusItem` menubar, non-dismissable indicator (`NSStatusItem` with red dot during capture). No Swift UI code in repo. |
| `capture/Sources/Echo/CalendarMonitor.swift` | calendar awareness | event-driven | EventKit `EKEventStore`, `EKAuthorizationStatus.fullAccess`, `EKEventStoreChangedNotification`. External ref: `developer.apple.com/documentation/eventkit`. |
| `capture/Sources/Quill/ScreenReader.swift` | AX + OCR | request-response | `AXUIElementCreateSystemWide` + `AXUIElementSetAttributeValue` + `VNRecognizeTextRequest`. External refs: `developer.apple.com/documentation/applicationservices/axuielement`, `developer.apple.com/documentation/vision/vnrecognizetextrequest`. |
| `capture/Package.swift` | Swift package config | — | SPM format; no Swift packages in repo. WhisperKit URL: `https://github.com/argmaxinc/argmax-oss-swift` from `"1.0.0"`. FluidAudio: `https://github.com/FluidInference/FluidAudio.git` from `"0.15.1"`. |
| `capture/entitlements/Atlas-Capture.entitlements` | signing entitlements | — | Apple entitlement format. Required: `com.apple.security.device.audio-input` (mic) + `com.apple.developer.avfoundation.multitasking-camera-access` may be needed for loopback tap. |

---

## Atlas wrangler.jsonc Change Required

**File:** `apps/atlas/wrangler.jsonc`
**Change:** Add `ARCHIVIST` service binding so Atlas can trigger the Archivist Workflow, and `ECHO_SESSION` DO namespace so Atlas can query session state.

**Pattern:** `apps/atlas/wrangler.jsonc` lines 69–89 (existing services block):
```jsonc
// Add to existing services array:
{ "binding": "ARCHIVIST", "service": "archivist" },
{ "binding": "ECHO_SESSION", "service": "echo" }
```

This follows the exact pattern used for `SCOUT`, `HEADHUNTER`, `STEWARD` in Phase 2.

---

## Metadata

**Analog search scope:** `apps/steward/`, `apps/forge/`, `apps/headhunter/`, `apps/atlas/`, `apps/herald/`, `apps/mcp-google/`, `apps/mcp-obsidian-bridge/`, `daemon/`, `packages/wire/`, `packages/model/`, `packages/shared/`, `migrations/`
**Files scanned:** 28 source files + 5 migration files
**Pattern extraction date:** 2026-06-06

---

## PATTERN MAPPING COMPLETE

**Phase:** 3 — capture-local
**Files classified:** 18
**Analogs found:** 13 / 18

### Coverage
- Files with exact analog: 4 (`vitest.config.ts` ×2, `wrangler.jsonc` shape ×2)
- Files with role-match analog: 9 (all cloud TypeScript files)
- Files with no analog: 5 (Swift-only: AudioTap, TranscriptionPipeline, ConsentGate, CalendarMonitor, Quill/ScreenReader + Package.swift + entitlements)

### Key Patterns Identified
- All cloud DOs use `DurableObject<Env>` + `blockConcurrencyWhile` error-capture pattern (capture error inside gate, re-throw after — never throw inside the callback).
- EchoSession uniquely adds WebSocket Hibernation: `ctx.acceptWebSocket()` + `serializeAttachment` + `setWebSocketAutoResponse("ping","pong")` — no existing DO uses these, but the surrounding DO class structure is identical to StewardWriter/ForgeLock/HeadhunterState.
- ArchivistWorkflow follows MorningChain exactly: factor orchestration body out of the class, use `step.do` with explicit retry config, `NonRetryableError` from `cloudflare:workflows` (NOT `cloudflare:workers`), never mutate `event.payload` inside a step.
- All Wrangler configs: `$schema` + `nodejs_compat` + `compatibility_date 2026-04-25` + `new_sqlite_classes` + WIRE/INCIDENTS producers (no consumers) + `staging: { triggers: { crons: [] } }`.
- `capture/com.atlas.capture.plist` is the only file that copies `daemon/com.atlas.bridge.plist` directly — three substitutions only (Label, ProgramArguments, log paths). Zero inbound listener keys in both.
- Swift daemon auth/poll/ack pattern translates the Node `drain.ts` conceptually: Keychain token storage instead of env var, `URLSession` instead of `node:https`, `for` loop (serial) drain, ack-only-after-write durability.
- `migrations/0006_meetings.sql` follows the 0004 DDL header + `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` conventions exactly.
