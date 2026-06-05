# Phase 2: Weekly Value — Pattern Map

**Mapped:** 2026-06-05
**Files analyzed:** 19 new/modified files
**Analogs found:** 19 / 19

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/scout/src/index.ts` | worker, scheduled agent | request-response + event-driven | `apps/compass/src/index.ts` | exact (scheduled read-and-emit WorkerEntrypoint) |
| `apps/scout/src/sources.ts` | utility, data fetcher | request-response (RSS/HTTP) | `apps/filer/src/index.ts` (GmailTools interface pattern) | role-match |
| `apps/scout/src/score.ts` | utility, transform | transform (relevance scoring) | `apps/compass/src/score.ts` | exact |
| `apps/scout/wrangler.jsonc` | config | — | `apps/compass/wrangler.jsonc` | exact |
| `apps/headhunter/src/index.ts` | worker, scheduled agent | request-response + event-driven | `apps/compass/src/index.ts` | exact (WorkerEntrypoint + scheduled modes) |
| `apps/headhunter/src/windows.ts` | service, state machine | CRUD + transform | `apps/filer/src/index.ts` (runSweep pattern) | role-match |
| `apps/headhunter/src/state.ts` | DO, serialized state | CRUD | `apps/steward/src/steward.ts` (StewardWriter DO + blockConcurrencyWhile) | exact |
| `apps/headhunter/wrangler.jsonc` | config | — | `apps/compass/wrangler.jsonc` + `apps/steward/wrangler.jsonc` (DO + D1) | exact |
| `apps/flagger/src/index.ts` | worker, queue consumer + inbound fetch | event-driven + request-response | `apps/dlq-sink/src/index.ts` (queue consumer) + `apps/mcp-obsidian-bridge/src/index.ts` (token-gated fetch) | exact composite |
| `apps/flagger/src/score.ts` | utility, transform | transform (severity/trust computation) | `apps/compass/src/score.ts` | role-match |
| `apps/flagger/src/push.ts` | utility, outbound call | request-response | `apps/mcp-obsidian-bridge/src/auth.ts` (outbound fetch pattern) | partial-match |
| `apps/flagger/src/state.ts` | DO, alarm scheduling | event-driven + CRUD | `apps/atlas/src/coordinator.ts` (DO alarm + setAlarm/getAlarm) | exact |
| `apps/flagger/wrangler.jsonc` | config | — | `apps/dlq-sink/wrangler.jsonc` (queue consumer) + `apps/steward/wrangler.jsonc` (sole consumer) | exact composite |
| `apps/flagger-watchdog/src/index.ts` | worker, scheduled (single cron) | request-response | `apps/compass/src/index.ts` (scheduled() export) + `apps/atlas/src/index.ts` (dispatcher cron switch) | exact |
| `apps/flagger-watchdog/wrangler.jsonc` | config | — | `apps/dlq-sink/wrangler.jsonc` (minimal producer-only worker) | exact |
| `packages/shared/src/flag.ts` | utility, migration rework | event-driven | `packages/wire/src/send.ts` (Queue.send() pattern) | exact (same producer primitive, new queue) |
| `apps/atlas/src/index.ts` | worker, scheduled dispatcher | event-driven | self (existing switch extension) | self-analog |
| `apps/herald/src/index.ts` | worker, WorkerEntrypoint mode extension | request-response | self (existing daily() method pattern) | self-analog |
| `apps/filer/src/index.ts` | worker, retrofit (incident + heartbeat emit) | request-response | self (existing flag() callsites in scheduled()) | self-analog |

---

## Pattern Assignments

### `apps/scout/src/index.ts` (worker, scheduled agent)

**Analog:** `apps/compass/src/index.ts`

**Imports pattern** (lines 17-23):
```typescript
import { WorkerEntrypoint } from "cloudflare:workers";
import { send } from "@atlas/wire";
import type { WireEvent } from "@atlas/wire";
import { flag, localDate } from "@atlas/shared";
import type { Env as SharedEnv } from "@atlas/shared";
```

**Env interface pattern** (lines 27-29):
```typescript
export interface Env extends SharedEnv {
  // Add Scout-specific optional bindings here: CODEX reader, etc.
}
```

**WorkerEntrypoint RPC method pattern** (lines 134-154):
```typescript
export class Scout extends WorkerEntrypoint<Env> {
  async weekly(params?: { date?: string }): Promise<WeeklyResult> {
    const date = params?.date ?? localDate(this.env);
    return await runWeekly(this.env, date, /* injected sources */);
  }
}
```

**Scheduled export pattern** (lines 168-180):
```typescript
export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const date = localDate(env);
    await runWeekly(env, date);
  },
} satisfies ExportedHandler<Env>;
```

**Wire event build pattern** (lines 59-78, `buildDigestEvent`):
```typescript
export function buildScoutEvent(date: string, events: EventRecord[]): WireEvent {
  return {
    agent: "Scout",
    type: "events.digest",
    entity: "events",
    op: "upsert",
    payload: { date, events, count: events.length },
    idempotencyKey: `scout:digest:${date}`,  // STABLE, structured, date-keyed
  };
}
```

**flag() call pattern** (lines 113-119):
```typescript
await flag(env, "P3", "scout weekly failed", String(err), { sourceAgent: "Scout" });
```

**Owner-local date pattern** (line 9 in `packages/shared/src/flag.ts`):
```typescript
// Use localDate from @atlas/shared — NEVER new Date() directly (workerd TZ=UTC)
const date = localDate(this.env);
// Or inside flag.ts itself:
return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(now);
```

**Landmines:**
- NEVER `crypto.randomUUID()` for the idempotency key — use `scout:digest:<date>` per-event `scout:evt_<date>_<djb2hash(title+start)>`
- Per-event Wire events use `scout:evt_<id>` keys; the digest summary event uses `scout:digest:<date>`
- `localDate()` from `@atlas/shared` — workerd forces TZ=UTC; NEVER `new Date()` string formatting

---

### `apps/scout/src/sources.ts` (utility, data fetcher)

**Analog:** `apps/filer/src/index.ts` (GmailTools interface pattern)

**Injected tools interface pattern** (lines 38-59 in filer/src/index.ts):
```typescript
// Define a ScoutSources interface — injected for testability (no live network in unit tests)
export interface ScoutSources {
  /** Fetch + parse an RSS feed. Returns normalized EventCandidate[]. */
  fetchRss(url: string): Promise<EventCandidate[]>;
  /** Fetch a plain-HTML page and extract events. */
  fetchHtml(url: string): Promise<EventCandidate[]>;
  /** Query Gmail Type/Newsletter + Type/Events (7d window). Uses gmail.readonly. */
  fetchGmailEvents(query: string): Promise<EventCandidate[]>;
}
```

**D2-09 constraint:** Never follow links from email sources. Never read `Type/Security`/`⚠ Phishing-Suspect`. Query: `"label:Type/Newsletter newer_than:7d"` or `"label:Type/Events newer_than:7d"`.

**Landmine:** `rss-parser` and `cheerio` are new deps — add to `apps/scout/package.json` only.

---

### `apps/scout/src/score.ts` (utility, transform)

**Analog:** `apps/compass/src/score.ts`

**Pattern:** Pure function, no I/O, testable in isolation. Takes an `EventCandidate` and Codex skills/projects plus KV keyword list, returns a `number` (0-100). Reading Codex is via `@atlas/codex` `read()` — injected into the caller.

---

### `apps/scout/wrangler.jsonc` (config)

**Analog:** `apps/compass/wrangler.jsonc`

**Copy shape** (full file, lines 1-47):
```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "scout",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-25",
  "compatibility_flags": ["nodejs_compat"],
  "queues": {
    "producers": [
      { "binding": "WIRE", "queue": "atlas-wire" },
      { "binding": "INCIDENTS", "queue": "atlas-incidents" }  // Phase-2 retrofit
    ]
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "atlas-db",
    "database_id": "e7fee76c-2e3d-486e-8a8a-fd1aec6a5af3",
    "migrations_dir": "../../migrations"
  }],
  "kv_namespaces": [{ "binding": "CONFIG", "id": "296ee0ec788542c68bb01a90e46c6cf2" }],
  "ai": { "binding": "AI" },
  "observability": { "enabled": true },
  "env": { "staging": { "triggers": { "crons": [] } } }
}
```

**Landmine:** Scout runs as a WorkerEntrypoint invoked by Atlas via service binding — it does NOT declare its own cron. Atlas's `scheduled()` switch calls `env.SCOUT.weekly(date)`. The `services` binding on `apps/atlas/wrangler.jsonc` must be extended: `{ "binding": "SCOUT", "service": "scout" }`.

---

### `apps/headhunter/src/index.ts` (worker, scheduled agent, two modes)

**Analog:** `apps/compass/src/index.ts` (WorkerEntrypoint + standalone cron shape)

**Two-mode WorkerEntrypoint pattern** (modeled on compass.ts lines 134-154):
```typescript
export class Headhunter extends WorkerEntrypoint<Env> {
  /** Mon 09:00 full scan — boards + window state machine + funnel classify */
  async full(params?: { date?: string }): Promise<FullResult> {
    const date = params?.date ?? localDate(this.env);
    return await runFull(this.env, date);
  }
  /** Daily-light deadlines pass — promote closing windows, emit apply-by tasks */
  async deadlines(params?: { date?: string }): Promise<DeadlineResult> {
    const date = params?.date ?? localDate(this.env);
    return await runDeadlines(this.env, date);
  }
}
```

**Wire event idempotency key pattern** (NEVER random — examples from codebase):
```typescript
// Apply-by task event: headhunter:window:<company>:<cycle>
// Funnel increment: headhunter:funnel:<thread_id>:<stage>
// Tracked-windows summary: headhunter:scan:<date>
idempotencyKey: `headhunter:window:${normalize(company)}:${cycle}`
idempotencyKey: `headhunter:funnel:${threadId}:${stage}`
```

**D1 positional `?` pattern** (from dlq-sink, lines 126-143):
```typescript
await env.DB.prepare(
  "INSERT OR REPLACE INTO windows(id,company,cycle,...) VALUES (?,?,?,?)"
).bind(id, company, cycle, ...).run();
// NEVER named params — D1 supports anonymous positional ? only
```

**Landmine:** Headhunter emits apply-by tasks through Forge's service binding RPC (`env.FORGE.createTask(...)`) — it does NOT write the `tasks` table directly. The `services` binding must include `{ "binding": "FORGE", "service": "forge" }` in `apps/headhunter/wrangler.jsonc`.

---

### `apps/headhunter/src/state.ts` (DO, HeadhunterState)

**Analog:** `apps/steward/src/steward.ts` (StewardWriter DO with `blockConcurrencyWhile`)

**DO class pattern** (lines 1-72 in steward.ts):
```typescript
import { DurableObject } from "cloudflare:workers";
import type { Env } from "@atlas/shared";

export class HeadhunterState extends DurableObject<Env> {
  /**
   * Advance a window's status (upcoming→open→closing→closed). Uses blockConcurrencyWhile
   * so concurrent `full` + `deadlines` runs don't race on the same window row.
   * Addressed as env.HEADHUNTER_STATE.getByName("pipeline").
   */
  async advanceWindow(windowId: string, newStatus: WindowStatus): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<WindowRow>(`win:${windowId}`);
      if (!current) return;
      await this.ctx.storage.put(`win:${windowId}`, { ...current, status: newStatus, updated_at: Date.now() });
    });
  }
}
```

**Migration pattern** (from steward/wrangler.jsonc line 16):
```jsonc
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["HeadhunterState"] }]
// NEVER legacy "new_classes" — use "new_sqlite_classes" (Free-tier eligible)
```

**Landmine:** `blockConcurrencyWhile` callback must NEVER throw — capture errors inside the callback, return them, and re-throw after the gate closes (exact pattern at steward.ts lines 43-55).

---

### `apps/flagger/src/index.ts` (worker, queue consumer + inbound fetch)

**Primary analog — queue consumer:** `apps/dlq-sink/src/index.ts`

**Queue handler pattern** (lines 73-176 in dlq-sink/src/index.ts):
```typescript
export default {
  async queue(batch: MessageBatch<RawIncident>, env: Env): Promise<void> {
    // Update KV last_seen for watchdog FIRST (best-effort — watchdog depends on this)
    await env.CONFIG.put("flagger:last_seen", String(Date.now())).catch(() => {});

    for (const msg of batch.messages) {
      // SERIAL for...of — never Promise.all (single-writer discipline through the DO lock)
      try {
        // Parse + validate; malformed incidents: ack() + P3 to atlas-wire directly
        // (never retry a malformed message)
        const incident = RawIncident.safeParse(msg.body);
        if (!incident.success) {
          await send(env, buildFlagEvent("Flagger", "P3", "malformed incident", ...));
          msg.ack();
          continue;
        }
        // Score, dedupe, route through FlaggerState DO
        const state = env.FLAGGER_STATE.getByName("fleet");
        const flag = await state.upsertFlag(signature, update);
        // P1/P2 → push; P3/P4 → board only
        if (flag.severity === "P1" || flag.severity === "P2") {
          await pushFlag(env, flag, ackUrl).catch(() => {}); // push failure → board fallback (D2-03)
        }
        // Emit canonical upsert to atlas-wire → Steward → Vault board
        await send(env, buildFlagWireEvent(flag));
        msg.ack();
      } catch (err) {
        console.error("flagger: incident processing failed", msg.id, err);
        msg.retry({ delaySeconds: 30 });
      }
    }
  },

  // Token-gated inbound ack route (D2-02) — the ONLY inbound surface in Phase 2
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ack" && request.method === "POST") {
      // Constant-time token comparison — copy from apps/mcp-obsidian-bridge/src/auth.ts
      const token = await env.ACK_TOKEN?.get();
      if (!token) return new Response("Unauthorized", { status: 401 });
      const auth = request.headers.get("Authorization") ?? "";
      if (!(await timingSafeEqual(auth, `Bearer ${token}`))) {
        return new Response("Unauthorized", { status: 401 });
      }
      const { id } = await request.json() as { id: string };
      const state = env.FLAGGER_STATE.getByName("fleet");
      await state.ackFlag(id);
      return new Response("OK");
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

**Inbound token auth pattern** — copy from `apps/mcp-obsidian-bridge/src/auth.ts` lines 22-58:
```typescript
// Constant-time string equality (length-independent — timing-safe)
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const da = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}
```

**Pillar 1 landmine:** Flagger consumes `atlas-incidents` (NOT `atlas-wire`). The Flagger Worker's `wrangler.jsonc` consumers block MUST say `"queue": "atlas-incidents"`. The `guard-wire-consumer.js` hook will hard-fail if `atlas-wire` appears in consumers.

**Env interface for Flagger:**
```typescript
import type { Env as SharedEnv } from "@atlas/shared";
import type { FlaggerState } from "./state.js";

export interface Env extends SharedEnv {
  INCIDENTS: Queue<RawIncident>;       // consumer binding
  FLAGGER_STATE: DurableObjectNamespace<FlaggerState>;
  ACK_TOKEN?: SecretsStoreSecret;
  NTFY_TOPIC?: SecretsStoreSecret;
  NTFY_TOKEN?: SecretsStoreSecret;
}
```

---

### `apps/flagger/src/state.ts` (DO, FlaggerState with alarm scheduling)

**Analog:** `apps/atlas/src/coordinator.ts` (AtlasCoordinator — DO alarm + setAlarm/getAlarm)

**DO alarm pattern** (lines 40-107 in coordinator.ts):
```typescript
import { DurableObject } from "cloudflare:workers";

export class FlaggerState extends DurableObject<Env> {
  // Single alarm pattern — ONE alarm slot, store per-slot deadlines
  async refreshAlarm(): Promise<void> {
    // Find earliest (expected_by + grace_ms) across all hb: slots
    const allSlots = await this.ctx.storage.list<HeartbeatSlot>({ prefix: "hb:" });
    let earliest = Infinity;
    for (const slot of allSlots.values()) {
      const deadline = slot.expected_by + slot.grace_ms;
      if (deadline < earliest) earliest = deadline;
    }
    if (earliest < Infinity && earliest > Date.now()) {
      await this.ctx.storage.setAlarm(earliest);
    }
  }

  override async alarm(): Promise<void> {
    try {
      // Check all slots; fire stale-heartbeat incidents for misses
      const now = Date.now();
      const allSlots = await this.ctx.storage.list<HeartbeatSlot>({ prefix: "hb:" });
      for (const [, slot] of allSlots.entries()) {
        if (now > slot.expected_by + slot.grace_ms && slot.last_seen < slot.expected_by) {
          await this.env.INCIDENTS.send({
            source_agent: slot.agent,
            kind: "heartbeat_stale",
            severity_hint: "P1",
            title: `${slot.agent} heartbeat stale`,
          });
        }
      }
    } finally {
      // ALWAYS rearm in finally — alarm must never stop (coordinator.ts line 101-105)
      await this.refreshAlarm();
    }
  }
}
```

**Key alarm invariants** (from coordinator.ts):
- `setAlarm()` OVERWRITES — it does NOT append. ONE alarm slot per DO.
- `finally` block always reschedules — the alarm must never stop.
- Seed `lastBeat` on arm so the first `alarm()` never false-fires a P1 (coordinator.ts line 55-58).
- `getAlarm()` returns `number | null` — check for null before skipping arm.

---

### `apps/flagger/src/push.ts` (utility, outbound ntfy.sh call)

**Analog:** `apps/mcp-obsidian-bridge/src/auth.ts` (outbound fetch + Secrets Store async reads)

**Secrets Store async read pattern** (auth.ts line 53):
```typescript
// Secrets Store bindings are OBJECTS with async get() — NEVER use as a plain string
const token = await env.ATLAS_BRIDGE_TOKEN?.get();
if (!token) return false; // fail-closed: no token configured → no access
```

**Outbound fetch pattern:**
```typescript
export async function pushFlag(env: FlaggerEnv, flag: FlagRecord, ackUrl: string): Promise<void> {
  const topic = await env.NTFY_TOPIC?.get();
  const token = await env.NTFY_TOKEN?.get();
  if (!topic) return; // push gated off if secret not seeded
  // ... POST to https://ntfy.sh/
}
// push failure is non-fatal — flag still lands on board (D2-03 fallback)
// Always catch and log, never throw out of the queue handler
```

**Landmine:** `NTFY_TOPIC` is a `SecretsStoreSecret` — `await env.NTFY_TOPIC.get()` not `env.NTFY_TOPIC`. TypeScript will catch this if the type is declared correctly.

---

### `apps/flagger/wrangler.jsonc` (config)

**Analog:** `apps/dlq-sink/wrangler.jsonc` (sole queue consumer) + `apps/steward/wrangler.jsonc` (DO binding)

**Copy + adapt** (from dlq-sink lines 29-40, steward lines 13-16):
```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "flagger",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-25",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "FLAGGER_STATE", "class_name": "FlaggerState" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FlaggerState"] }],
  "queues": {
    "producers": [{ "binding": "WIRE", "queue": "atlas-wire" }],
    // INCIDENTS producer is also needed (Flagger re-emits its own heartbeat)
    "consumers": [{
      "queue": "atlas-incidents",       // NOT atlas-wire (Pillar 1)
      "max_batch_size": 25,
      "max_batch_timeout": 5,
      "max_retries": 3,
      "max_concurrency": 1,
      "dead_letter_queue": "atlas-incidents-dlq"
    }]
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "atlas-db",
    "database_id": "e7fee76c-2e3d-486e-8a8a-fd1aec6a5af3",
    "migrations_dir": "../../migrations"
  }],
  "kv_namespaces": [{ "binding": "CONFIG", "id": "296ee0ec788542c68bb01a90e46c6cf2" }],
  "secrets_store_secrets": [
    { "binding": "NTFY_TOPIC", "store_id": "<atlas-store-id>", "secret_name": "ntfy-topic" },
    { "binding": "NTFY_TOKEN", "store_id": "<atlas-store-id>", "secret_name": "ntfy-token" },
    { "binding": "ACK_TOKEN", "store_id": "<atlas-store-id>", "secret_name": "ack-token" }
  ],
  "observability": { "enabled": true },
  "env": { "staging": { "triggers": { "crons": [] } } }
}
```

---

### `apps/flagger-watchdog/src/index.ts` (worker, single cron)

**Analog:** `apps/compass/src/index.ts` (scheduled() only, no WorkerEntrypoint) + `apps/atlas/src/index.ts` (dispatcher pattern)

**Minimal single-cron Worker pattern** (compass lines 168-180):
```typescript
export default {
  async scheduled(_controller: ScheduledController, env: WatchdogEnv, _ctx: ExecutionContext): Promise<void> {
    const threshold = parseInt(await env.CONFIG.get("selfwatch_threshold") ?? "900000"); // 15m default
    const lastSeenStr = await env.CONFIG.get("flagger:last_seen");
    const lastSeen = lastSeenStr ? parseInt(lastSeenStr) : 0;
    const age = Date.now() - lastSeen;

    if (age > threshold) {
      // Bypass atlas-incidents — Flagger may be dead; emit DIRECTLY to atlas-wire
      await send(env, {
        agent: "Flagger",
        type: "flag",
        entity: "flag",
        op: "upsert",
        payload: {
          id: `flg:${localDate()}:Flagger:watchdog`,
          source_agent: "Flagger",
          severity: "P1",
          trust: 100,
          title: "Flagger may be down — no heartbeat",
          detail: `Last seen ${Math.round(age / 60000)} min ago`,
          status: "open",
        },
        idempotencyKey: `flg:${localDate()}:Flagger:watchdog`,
      });
      // Also attempt ntfy push directly (belt-and-suspenders)
    }
  },
} satisfies ExportedHandler<WatchdogEnv>;
```

**`satisfies ExportedHandler<Env>`** — NEVER the older `: ExportedHandler<Env>` annotation (CLAUDE.md).

**Landmine:** This is a SEPARATE Worker with its own `wrangler.jsonc` (D2-08) — the one alert path that doesn't depend on Flagger being alive. It emits DIRECTLY to `atlas-wire` (not `atlas-incidents`) because Flagger is the incident queue consumer and may be dead. This does NOT violate Pillar 1 — any producer can write to `atlas-wire`; the constraint is only on consumers.

---

### `apps/flagger-watchdog/wrangler.jsonc` (config)

**Analog:** `apps/dlq-sink/wrangler.jsonc` (minimal producer-only Worker)

**Copy + adapt** (dlq-sink lines 1-68):
```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "flagger-watchdog",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-25",
  "compatibility_flags": ["nodejs_compat"],
  "queues": {
    "producers": [{ "binding": "WIRE", "queue": "atlas-wire" }]
    // Also needs NTFY_TOPIC + NTFY_TOKEN for direct push belt-and-suspenders
  },
  "kv_namespaces": [{ "binding": "CONFIG", "id": "296ee0ec788542c68bb01a90e46c6cf2" }],
  "secrets_store_secrets": [
    { "binding": "NTFY_TOPIC", "store_id": "<atlas-store-id>", "secret_name": "ntfy-topic" },
    { "binding": "NTFY_TOKEN", "store_id": "<atlas-store-id>", "secret_name": "ntfy-token" }
  ],
  "triggers": { "crons": ["*/5 * * * *"] },  // every 5 min; checks if > 15m stale
  "observability": { "enabled": true },
  "env": { "staging": { "triggers": { "crons": [] } } }
}
```

---

### `packages/shared/src/flag.ts` (utility, D2-05 rework)

**Analog:** self (current file) + `packages/wire/src/send.ts` (Queue.send() pattern)

**Current implementation** (full file at `/Users/danielchahine/Desktop/Programs/Atlas/packages/shared/src/flag.ts`):
- Lines 1-109: current `flag()` emits finished `FlagRecord` to `WIRE`.

**Target implementation** (D2-05):
```typescript
import type { Severity } from "./env.js";

export interface RawIncident {
  source_agent: string;
  kind: string;           // "api_error" | "heartbeat" | "malformed_event" | "model_error" | etc.
  severity_hint: Severity;
  title: string;
  detail?: string;
  run_id?: string;        // correlate cascade via shared run_id
}

export interface FlagOptions {
  sourceAgent?: string;
  suggestedAction?: string;
  kind?: string;         // NEW: required for migration (defaults to "unknown")
  runId?: string;        // NEW: optional cascade correlation
}

// KEEP FlagRecord exported — it is now Flagger's OUTPUT shape, not the emit shape
export interface FlagRecord { /* unchanged */ }

export async function flag(
  env: { INCIDENTS: Queue<RawIncident> },  // CHANGED: WIRE → INCIDENTS
  severity: Severity,
  title: string,
  detail?: string,
  options: FlagOptions = {},
): Promise<void> {
  const incident: RawIncident = {
    source_agent: options.sourceAgent ?? "Atlas",
    kind: options.kind ?? "unknown",
    severity_hint: severity,
    title,
    detail,
    run_id: options.runId,
  };
  await env.INCIDENTS.send(incident);
}
```

**Env type update** (`packages/shared/src/env.ts`):
```typescript
// ADD INCIDENTS binding — optional so Phase-0 Workers not yet retrofitted still compile
INCIDENTS?: Queue<RawIncident>;
```

**Migration surface (all callers, from RESEARCH.md verified grep):**
| File | Current call | kind tag to add |
|---|---|---|
| `apps/dlq-sink/src/index.ts` | `flag(env, severity, title, detail, { sourceAgent })` | `kind: "dlq_dead_letter"` |
| `packages/model/src/claude.ts` (3 sites) | `flag(env, "P3", ...)` | `kind: "model_error"` |
| `apps/steward/src/steward-consumer.ts` (2 sites) | `flag(env, "P3", "malformed wire event", ...)` | `kind: "malformed_event"` / `kind: "steward_write_fail"` |
| `apps/atlas/src/coordinator.ts` | `flag(env, "P1", ...)` | `kind: "heartbeat_stale"` |
| `apps/atlas/src/morning-chain.ts` | `flag(env, "P2", ...)` | `kind: "chain_halted"` |
| `apps/atlas/src/index.ts` | `flag(env, "P2", ...)` | `kind: "workflow_create_failed"` |
| `apps/herald/src/guardrail.ts` | `flag(env, "P2", ...)` | `kind: "security_leak_blocked"` |
| `apps/forge/src/index.ts` | `flag(env, ...)` | `kind: "phishing_skipped"` / per call |
| `apps/sundial/src/reconcile.ts` (2 sites) | `flag(env, ...)` | `kind: "calendar_sync_failed"` / per call |
| `apps/compass/src/index.ts` | `flag(env, "P3", ...)` | `kind: "overcommit"` |
| `apps/filer/src/index.ts` | `flag(env, "P3", ...)` | `kind: "watch_renewal_due"` |

**Landmine:** Tests that assert on the old `flag()` output shape (Wire event with `op:"upsert"`, `entity:"flag"`, `payload.id`) must be updated to assert on `RawIncident` shape on the `INCIDENTS` queue. The `contentHash` / `DEFAULT_TRUST` helpers move to Flagger's `score.ts` — do NOT leave them in `flag.ts`.

---

### `apps/atlas/src/index.ts` (dispatcher extension, Phase-2 cron cases)

**Analog:** self — extend the existing `switch (controller.cron)` block

**Current switch** (lines 111-175) has cases `"45 11 * * 1-5"`, `"45 12 * * 1-5"`, `"45 12 * * *"`.

**New cases to add** (lines 175+ insertion point, after existing cases):
```typescript
// Headhunter daily-light (09:00 ET) — Mon–Fri
case "0 13 * * *":   // EDT form (UTC-4, active June–Nov)
case "0 14 * * *": { // EST form (UTC-5, active Nov–Mar)
  const date = localDate(env);
  _ctx.waitUntil(
    env.HEADHUNTER.deadlines({ date }).catch(async (err: unknown) => {
      await flag(env, "P2", "headhunter.deadlines.failed", String(err), {
        kind: "chain_halted", sourceAgent: "Atlas",
      }).catch(() => {});
    }),
  );
  break;
}
// Headhunter full (Mon 09:00 ET only)
case "0 13 * * 1":
case "0 14 * * 1": {
  const date = localDate(env);
  _ctx.waitUntil(
    env.HEADHUNTER.full({ date }).catch(async (err: unknown) => {
      await flag(env, "P2", "headhunter.full.failed", String(err), {
        kind: "chain_halted", sourceAgent: "Atlas",
      }).catch(() => {});
    }),
  );
  break;
}
// Fri 16:00 ET — Scout weekly + Herald weekly (Promise.allSettled, not Promise.all)
case "0 20 * * 5":   // EDT form
case "0 21 * * 5": { // EST form
  const date = localDate(env);
  _ctx.waitUntil(
    Promise.allSettled([
      env.SCOUT.weekly({ date }).catch(async (err: unknown) => {
        await flag(env, "P2", "scout.weekly.failed", String(err), { sourceAgent: "Atlas", kind: "chain_halted" }).catch(() => {});
        return null;
      }),
      env.HERALD.weekly({ date }).catch(async (err: unknown) => {
        await flag(env, "P2", "herald.weekly.failed", String(err), { sourceAgent: "Atlas", kind: "chain_halted" }).catch(() => {});
        return null;
      }),
    ]),
  );
  break;
}
// Fri 16:30 ET — weekly-review build
case "30 20 * * 5":
case "30 21 * * 5": {
  const date = localDate(env);
  _ctx.waitUntil(
    env.STEWARD.weeklyReviewBuild({ date }).catch(async (err: unknown) => {
      await flag(env, "P2", "weekly-review-build.failed", String(err), { sourceAgent: "Atlas", kind: "chain_halted" }).catch(() => {});
    }),
  );
  break;
}
```

**`wrangler.jsonc` triggers extension** — add to existing `"triggers"` block:
```jsonc
"triggers": { "crons": [
  "45 11 * * 1-5",   // 07:45 ET MorningChain (EDT)
  "0 13 * * *",      // 09:00 ET Headhunter daily-light (EDT)
  "0 13 * * 1",      // Mon 09:00 ET Headhunter full (EDT)
  "0 20 * * 5",      // Fri 16:00 ET Scout+Herald (EDT)
  "30 20 * * 5"      // Fri 16:30 ET weekly-review build (EDT)
]}
```

**`services` extension** — add to existing `"services"` array:
```jsonc
{ "binding": "SCOUT",       "service": "scout" },
{ "binding": "HEADHUNTER",  "service": "headhunter" }
```

**Landmine (DST):** Current date is June 2026 = EDT (UTC-4). The correct UTC form is `0 20 * * 5` for Fri 16:00 ET. The EST form `0 21 * * 5` fires at 17:00 ET in summer. Use the EDT form now; hand-edit at the Nov DST boundary. Annotate BOTH forms as cases in the switch so a future hand-edit only changes `wrangler.jsonc` crons, not the switch.

**Landmine (Promise.all vs allSettled):** Use `Promise.allSettled()` for Friday fan-in — if Scout fails, Herald's successful result must NOT be discarded.

**Landmine (cron count):** Atlas currently has 1 cron (`45 11 * * 1-5`). Adding 4 more = 5 total on the Atlas Worker. If Free plan limit is 3, Paid upgrade is required (Assumption A1 in RESEARCH.md). Planner must include a `checkpoint:verify-cron-limit` task.

---

### `apps/herald/src/index.ts` (mode extension — weekly mode)

**Analog:** self — extend by adding `weekly()` method alongside `daily()`

**Pattern from existing `daily()` method** (lines 109-124):
```typescript
export class Herald extends WorkerEntrypoint<Env> {
  // Existing: async daily(...) → DailyResult

  // NEW: async weekly(params?) → WeeklyResult
  async weekly(params?: { date?: string; threads?: DigestThread[]; tools?: HeraldGmailTools }): Promise<WeeklyResult> {
    const date = params?.date ?? localDate(this.env);
    const threads = params?.threads ?? [];
    return await runWeekly(this.env, date, threads, params?.tools);
  }
}
```

**Weekly Wire event idempotency key pattern** (modeled on `herald:daily:<date>` at line 75):
```typescript
idempotencyKey: `herald:weekly:${date}`
```

**Redaction guardrail reuse** — same `guardDigestOutput()` from `herald/src/guardrail.ts` line 33 applies; same redaction path. The weekly mode is NOT exempt from the non-negotiable security invariant.

**Landmine:** The weekly mode emits TWO events:
1. A `digest` Wire event (`herald:weekly:<date>`) feeding the 16:30 Vault build — `op: "upsert"`, `entity: "email"`, same Steward path.
2. A Gmail DRAFT (7-day review) — still `tools.createDraft(...)`, no send (same `HeraldGmailTools` interface reused).

---

### `apps/filer/src/index.ts` (retrofit — incident + heartbeat emits)

**Analog:** self — the `scheduled()` handler already calls `flag()` at lines 165-171

**Heartbeat emit pattern** (modeled on `apps/atlas/src/coordinator.ts` `beat()` + `flag()` shape):
```typescript
// In Filer's sweep() WorkerEntrypoint method (after the sweep completes):
await env.INCIDENTS?.send({
  source_agent: "Filer",
  kind: "heartbeat",
  severity_hint: "P4",  // heartbeat = informational
  title: `Filer sweep heartbeat ${date}`,
  run_id: date,
});
```

**Existing `flag()` call migration** (filer/src/index.ts line 165):
```typescript
// BEFORE:
await flag(env, "P3", "filer users.watch renewal due", ..., { sourceAgent: "Filer" });
// AFTER (D2-05):
await flag(env, "P3", "filer users.watch renewal due", ..., { sourceAgent: "Filer", kind: "watch_renewal_due" });
// The env must now expose INCIDENTS binding (not just WIRE)
```

**`Job/*` sub-state signals for Headhunter funnel (D2-13):** Filer's existing taxonomy already handles `Type/Job`. The retrofit confirms/extends `Job/*` sub-labels (e.g. `Job/OA`, `Job/Interview`, `Job/Offer`, `Job/Rejected`) — these are classification outputs Filer writes to Gmail threads that Headhunter reads back via `gmail.readonly` query on labeled threads.

---

## Shared Patterns

### Pattern: Queue Producer `send()` helper

**Source:** `packages/wire/src/send.ts` — the `send()` producer helper  
**Apply to:** All new agents (`apps/scout`, `apps/headhunter`, `apps/flagger`) for Wire events

```typescript
// packages/wire/src/send.ts lines 47-57
import { send } from "@atlas/wire";
// ALWAYS use send() — NOT env.WIRE.send() directly — it validates the §6.4 schema first
await send(env, {
  agent: "Scout",       // the emitter's codename (canonical string from CLAUDE.md)
  type: "events.digest",
  entity: "events",
  op: "upsert",
  payload: { /* ... */ },
  idempotencyKey: `scout:digest:${date}`,  // STRUCTURED + STABLE — never crypto.randomUUID()
});
```

### Pattern: Structured Idempotency Keys

**Source:** `apps/filer/src/index.ts` line 123, `apps/herald/src/index.ts` line 75, `apps/compass/src/index.ts` line 77  
**Apply to:** Every Wire event in every new/modified agent

```typescript
// Pattern: <agent>:<type>:<date>[:<discriminator>]
idempotencyKey: `filer:sweep:${date}`            // Filer
idempotencyKey: `herald:daily:${date}`           // Herald daily
idempotencyKey: `herald:weekly:${date}`          // Herald weekly (NEW)
idempotencyKey: `scout:digest:${date}`           // Scout (NEW)
idempotencyKey: `scout:evt_${date}_${hash}`      // per-event (NEW)
idempotencyKey: `headhunter:window:${co}:${cy}`  // Headhunter window task (NEW)
idempotencyKey: `headhunter:funnel:${tid}:${st}` // Headhunter funnel (NEW)
idempotencyKey: `headhunter:scan:${date}`        // Headhunter scan summary (NEW)
```

### Pattern: Owner-local Date (TZ=UTC gotcha)

**Source:** `packages/shared/src/flag.ts` lines 9-11, `apps/atlas/src/index.ts` lines 65-67  
**Apply to:** Every new Worker, every `localDate()` call

```typescript
// CORRECT — from @atlas/shared
import { localDate } from "@atlas/shared";
const date = localDate(env);  // "YYYY-MM-DD" in America/Toronto

// CORRECT if called without env (e.g. inside flag.ts)
new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date())

// WRONG — workerd forces TZ=UTC; new Date() is UTC even on the laptop
new Date().toISOString().slice(0, 10)  // DO NOT USE
```

### Pattern: DO Class Declaration + `new_sqlite_classes`

**Source:** `apps/steward/wrangler.jsonc` lines 13-16, `apps/atlas/wrangler.jsonc` lines 14-19  
**Apply to:** `apps/flagger/wrangler.jsonc` (FlaggerState), `apps/headhunter/wrangler.jsonc` (HeadhunterState)

```jsonc
"durable_objects": {
  "bindings": [{ "name": "FLAGGER_STATE", "class_name": "FlaggerState" }]
},
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["FlaggerState"] }]
// NEVER legacy "new_classes" — always "new_sqlite_classes" (Free-tier eligible)
```

### Pattern: `satisfies ExportedHandler<Env>`

**Source:** Every existing Worker default export  
**Apply to:** Every new Worker default export

```typescript
export default {
  async scheduled(...) { ... },
  async queue(...) { ... },   // Flagger only
  async fetch(...) { ... },   // Flagger only (ack endpoint)
} satisfies ExportedHandler<Env>;
// NEVER : ExportedHandler<Env> (the older annotation — CLAUDE.md non-negotiable)
```

### Pattern: `blockConcurrencyWhile` — error capture inside gate

**Source:** `apps/steward/src/steward.ts` lines 42-56  
**Apply to:** `apps/headhunter/src/state.ts`, `apps/flagger/src/state.ts`

```typescript
// CRITICAL: callback must NOT throw — capture inside, re-throw after gate closes
const outcome = await this.ctx.blockConcurrencyWhile(async () => {
  try {
    return { ok: true, value: await doWork() };
  } catch (error) {
    return { ok: false, error };  // return normally — DO stays healthy
  }
});
if (!outcome.ok) throw outcome.error;  // re-throw AFTER gate
```

### Pattern: Serial `for…of` in queue handlers

**Source:** `apps/dlq-sink/src/index.ts` lines 79-176, `apps/steward/src/steward-consumer.ts` lines 50-106  
**Apply to:** `apps/flagger/src/index.ts` queue handler

```typescript
for (const msg of batch.messages) {
  // SERIAL — never Promise.all (maintains single-writer discipline through DO lock)
  try {
    // ... process
    msg.ack();
  } catch {
    msg.retry({ delaySeconds: 30 });
  }
}
```

### Pattern: Token-gated inbound endpoint (constant-time comparison)

**Source:** `apps/mcp-obsidian-bridge/src/auth.ts` lines 22-58  
**Apply to:** `apps/flagger/src/index.ts` ack endpoint (D2-02)

The full `timingSafeEqual()` function from `apps/mcp-obsidian-bridge/src/auth.ts` lines 22-37 is the canonical implementation — copy it verbatim into `apps/flagger/src/auth.ts` (or inline). Key points:
- HMAC-SHA-256 with a fresh random key each call (not `crypto.timingSafeEqual` — not available in Workers)
- Fail-closed: missing binding → `false` → 401
- Separate `ACK_TOKEN` from `NTFY_TOKEN`

### Pattern: D1 positional `?` binds only

**Source:** `apps/dlq-sink/src/index.ts` lines 126-143  
**Apply to:** `apps/headhunter/src/windows.ts`, `apps/flagger/src/state.ts` (if using D1)

```typescript
// CORRECT — positional ? only
await env.DB.prepare("INSERT INTO windows(id,company,cycle) VALUES (?,?,?)")
  .bind(id, company, cycle)
  .run();

// WRONG — D1 does NOT support named params
await env.DB.prepare("INSERT INTO windows(id) VALUES (:id)").bind({ id }).run();
```

---

## No Analog Found

All Phase-2 files have close analogs in the existing codebase. No file requires research-only pattern reference.

However, two capabilities are **net-new** (no existing codebase analog, use RESEARCH.md patterns):

| Capability | File | Reason | Pattern Source |
|---|---|---|---|
| ntfy.sh POST | `apps/flagger/src/push.ts` | No existing outbound HTTP push in codebase; bridge is poll/ack not push | RESEARCH.md Pattern 4 + docs.ntfy.sh/publish/ |
| RSS + HTML parsing | `apps/scout/src/sources.ts` | No existing RSS/HTML parsing; `rss-parser` + `cheerio` are new deps | RESEARCH.md Pattern 7 |

---

## Metadata

**Analog search scope:** `apps/` (11 apps), `packages/` (6 packages)  
**Files scanned:** 26 source files + 4 wrangler.jsonc configs  
**Pattern extraction date:** 2026-06-05

**DST note (active June 2026 = EDT, UTC-4):** All new cron strings in Atlas's `wrangler.jsonc` must use the EDT form (e.g. `"0 20 * * 5"` for Fri 16:00 ET). Both EDT and EST forms should be cases in the `switch` for forward-compatibility. Hand-edit `wrangler.jsonc` at the Nov DST boundary; use `/cron-utc` to verify.

**Cron count warning (Assumption A1):** Atlas Worker will have 5 crons after Phase 2 additions. Free plan historically limits 3 per Worker. Planner must include a `checkpoint:verify-cron-limit` task before the Atlas cron extension task.
