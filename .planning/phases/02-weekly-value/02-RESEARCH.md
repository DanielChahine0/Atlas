# Phase 2: Weekly Value — Research

**Researched:** 2026-06-05
**Domain:** Cloudflare Workers/Queues/DOs + ntfy.sh push + RSS/Gmail event discovery + D1 hiring-window model
**Confidence:** HIGH (all core findings verified against official docs, canon sources, or living code)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**D2-01:** Push channel = ntfy.sh. P1/P2 flags push via single HTTPS POST from Flagger to a secret ntfy topic; iOS/Android subscribes. One secret to seed. Rejected: Pushover, Telegram.

**D2-02:** Ack via ntfy action button → token-gated Flagger HTTP endpoint. Push carries an "Ack" HTTP action that POSTs to the Flagger Worker, flipping flag to `ack` in `FlaggerState`. Un-ack'd P1 re-pushes every `escalation_window` (default 15m). LLM-judgment flags always wait for owner decision.

**D2-03:** Push is flag-gated (`CONFIG flagger.push_enabled`, default `false`). Seeding ntfy creds + enabling is a Phase-2 go-live gate. Push failure → flag lands on Vault board via Steward; no second push channel.

**D2-04:** New `atlas-incidents` queue — Flagger is its sole consumer; fans into `atlas-wire`. Agents fire raw incidents fire-and-forget onto `atlas-incidents`. Preserves Pillar 1 (Steward stays sole `atlas-wire` consumer). Rejected: Steward-invoked RPC enrichment, RPC-from-emitters.

**D2-05:** Rework `flag()` to enqueue a raw incident `{ source_agent, kind, severity_hint, title, detail, run_id }` onto `atlas-incidents` instead of emitting a finished flag to `atlas-wire`. Every existing caller migrated.

**D2-06:** Emitter hints severity + kind; Flagger owns final severity and ALL trust. Trust bands are evidence-based: caught exception 90–100, stale heartbeat 100, counter check 75–90, LLM hunch 20–45 + recurrence bump + corroboration/degraded-source adjustments.

**D2-07:** Heartbeats ride `atlas-incidents`. `FlaggerState` DO alarms detect misses. Grace = 10m (`heartbeat_grace` KV, default 10m). Missed slot → stale-heartbeat P1, trust 100.

**D2-08:** Separate Cron watchdog Worker (`apps/flagger-watchdog`) catches Flagger's own death. Reads Flagger `last_seen` from KV. Quiet past `selfwatch_threshold` (default 15m) → self-P1.

**D2-09:** Scout v1 = RSS/fetch + Gmail newsletters. No Playwright/Browser Rendering in Phase 2. Sources: RSS feeds, plain HTML/JSON listings, Gmail `Type/Newsletter` + `Type/Events`/`Events/Invite`. Never follows email links; never reads `Type/Security`/`⚠ Phishing-Suspect`.

**D2-10:** weekly-Herald = week-in-review retrospective (7-day window). Draft-only (`gmail.compose`, no send) + digest event feeding 16:30 weekly-review Vault build. Same redaction guardrails as daily. Rejected: mere weekly-windowed daily digest, skipping it.

**D2-11:** Friday concurrency build-plan-locked. Cron `"0 21 * * 5"` (EDT) runs Scout-weekly AND weekly-Herald via `Promise.all`. Cron `"30 21 * * 5"` kicks 16:30 weekly-review build. Standalone crons in Atlas's `scheduled()` switch, NOT morning Workflow steps.

**D2-12:** Interest/fit signal = Codex `skills`/`projects` + KV keyword list (`scout/interests`, `headhunter/targets`). Location from Codex `addresses`. No Codex schema change. Codex is read-only.

**D2-13:** Funnel driven by Filer `Type/Job` threads; Headhunter is the single emitter. Stage classification by Headhunter, deduped by `(thread, stage)`. No double-count.

**D2-14:** Urgency bypasses the fit floor. Any window inside lead-time (default 21d) or explicit deadline always surfaces + tasks even below `fit_floor` (0.4). Low-confidence hiring-window dates route to Flagger P3, not silently to a task.

**D2-15:** Watchlist/boards/cycle = KV config gate + small starter seed (a few well-known programs + `fall-2026`). Real list is owner-curated KV, set before go-live.

### Claude's Discretion

- Exact `atlas-incidents` queue config (max_batch_size/max_concurrency/DLQ)
- Incident event schema
- `FlaggerState` DO shape (open-flags-by-signature, alarm scheduling)
- Cascade grouping (collapse Sundial→Compass cascade via shared `run_id`) and auto-resolve scope
- Mute-rule / `severity_override` KV shapes; `≥70%-actionable` instrumentation
- Scout KV knobs (`min_relevance` 55, `dedupe_window_weeks` 4, `max_per_digest` 15, sparse-week relaxation, optional Calendar conflict pre-check), digest format, `Event` D1 record
- Headhunter window status state-machine (`upcoming→open→closing→closed`), `last_seen_open` advancement, `lead_time_days`/`push_threshold_days`, seen-store fingerprint, model tiering
- Per-Worker cron cap / Free-plan limits (verify before deploy)
- GitHub MCP read-only `Type/Dev` repo signals (optional, gated on Phase-0 GitHub-App gate)

### Deferred Ideas (OUT OF SCOPE)

- JS-rendered event scraping (Luma/Eventbrite via Browser Rendering/Playwright)
- Scout → Usher registration hand-off (Phase 4)
- Second push fallback channel for Flagger
- Codex "interests" section + write flow
- GitHub MCP read-only `Type/Dev` repo signals (optional gate)
- Optional Workers Paid upgrade (verify at deploy)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WEEKLY-01 | Scout produces Friday 16:00 events digest; Headhunter (Mon 09:00 full + daily-light 09:00) creates "apply by X" tasks via Forge and updates job-pipeline kanban counts; low-confidence hiring-window finds route to a flag, not silently to a task | D1 tables, Codex reader, `packages/tasks` dedupe path, `packages/wire` upsert/increment events, cron dispatcher pattern, RSS/fetch patterns |
| WEEKLY-02 | Flagger receives error/incident events from every agent, routes P1/P2 to push immediately and batches P3/P4 into dashboard feed (Vault Flagger board sorted severity then trust), and self-monitors heartbeat staleness | `atlas-incidents` queue topology, `FlaggerState` DO alarm API, ntfy.sh POST contract, watchdog Worker pattern, `flag()` rework migration |
</phase_requirements>

---

## Summary

Phase 2 extends the proven Phase-0/1 plumbing (the Wire, Steward, D1, KV, AI Gateway, OAuth, Filer's labels) with three new cloud Workers and a weekly-cadence value layer. The critical topology change is introducing a **second Cloudflare Queue** (`atlas-incidents`) consumed solely by Flagger, which then produces onto `atlas-wire` — preserving Pillar 1 (Steward remains the only `atlas-wire` consumer). This two-queue design decouples fleet monitoring from the write path: agents fire incidents fire-and-forget without blocking the morning chain, and Flagger scores/routes asynchronously.

The `flag()` rework (D2-05) is the broadest migration surface: 10 call sites across 8 files must be updated from "emit finished flag to `atlas-wire`" to "enqueue raw incident to `atlas-incidents`". This is mechanically straightforward but requires care to keep the 315 green tests passing. Each caller adds a `kind` tag and a `severity_hint`; the final flag record is now Flagger's output, not the caller's.

Scout and Headhunter are read-and-track agents — no writes to Gmail/Calendar/Vault except through Steward. Both rely heavily on existing infrastructure: Scout reuses Google MCP `gmail.readonly`, Codex reader, and the `@atlas/wire` send() helper; Headhunter routes apply-by tasks through the existing `@atlas/tasks` dedupe path.

**Primary recommendation:** Sequence the work as (1) `atlas-incidents` queue + Flagger worker shell + `flag()` rework, (2) Phase-0/1 retrofit of heartbeat/incident emits, (3) Scout + weekly-Herald mode, (4) Headhunter + D1 migrations, (5) Flagger logic + FlaggerState DO + watchdog. This ordering unblocks the retrofit early and lets Flagger receive real events during later steps.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Incident queue consumer (score/dedupe/route) | API / Backend (Flagger Worker) | — | Event-driven; must not couple to Steward's write lock |
| Push notification (P1/P2) | API / Backend (Flagger Worker) | — | Outbound HTTPS POST from Worker to ntfy.sh; no browser |
| Ack inbound endpoint | API / Backend (Flagger Worker) | — | Token-gated HTTP route on same Worker; the only inbound surface in Phase 2 |
| Flagger self-watchdog | API / Backend (separate Worker) | — | Must be independent of the monitored Worker; reads KV `last_seen` |
| Flag state lifecycle (open→ack→resolved→muted) | DO (`FlaggerState`) | D1 audit | DO provides consistent reads/writes + alarm scheduling |
| Heartbeat alarm scheduling | DO (`FlaggerState`) | — | One DO alarm per expected slot; single-threaded consistency |
| Event discovery (Scout) | API / Backend (Scout Worker) | — | Fetches RSS + Gmail via MCP; no Browser Rendering in v1 |
| Interest/fit scoring | API / Backend (Scout/Headhunter Workers) | Codex (read-only) | Relevance scored server-side via model; Codex is read-only reference |
| Hiring-window state machine | DO (`HeadhunterState`) + D1 | — | Per-company/cycle window rows in D1; DO for concurrent update safety |
| Job pipeline funnel counts | D1 (via Steward) | — | Counter events through `atlas-wire` → Steward → D1; no direct write |
| Apply-by task creation | API / Backend (Headhunter → Forge path) | D1 `tasks` | Headhunter emits tasks via Forge's existing D1 dedupe path |
| Weekly Vault build (16:30) | Event bus (atlas-wire → Steward) | — | Steward compiles; triggered as a standalone cron case in Atlas `scheduled()` |

---

## Standard Stack

### Core (all verified against living codebase at HEAD 09518da)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `agents` (Cloudflare Agents SDK) | `^0.14.1` (installed 0.14.1) | McpAgent, DurableObject base | **Requires `nodejs_compat`**; pins MCP SDK 1.29.0 transitively |
| `@modelcontextprotocol/sdk` | `1.29.0` | MCP tool registration (`registerTool()`) | Pinned by `agents`; do NOT bump independently |
| `zod` | `^3.25 \|\| ^4.0` (resolved 4.4.3) | Schema validation for Wire events, incident records | Shared with existing Wire schema |
| `@cloudflare/workers-oauth-provider` | `^0.7.2` (installed) | Inbound OAuth (Atlas front door — no change) | Existing |
| `@anthropic-ai/sdk` | `^0.100.1` | Claude via AI Gateway | Existing; all calls route through `claudeFor(agent,env)` |
| `jose` | `^6.2.3` | GitHub App RS256 JWT (existing) | Existing |

### Supporting (Phase 2 new)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `rss-parser` | `3.13.0` (latest, slopcheck OK) | RSS feed parsing in Worker | Scout source ingestion from RSS feeds |
| `cheerio` | `1.2.0` (latest, slopcheck OK) | Static HTML parsing | Scout: plain-HTML event listings without JS rendering |

**slopcheck results:** `rss-parser` [OK], `cheerio` [OK], `@cloudflare/vitest-pool-workers` [OK], `agents` [OK], `@modelcontextprotocol/sdk` [OK], `@cloudflare/workers-oauth-provider` [OK], `@anthropic-ai/sdk` [OK], `jose` [OK]. `zod@4` (as a standalone package name) was flagged [SLOP] — the correct form is `zod` with range `^3.25 || ^4.0` (already in root package.json). [VERIFIED: npm registry]

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| RSS-only Scout sources | Playwright/Browser Rendering | Deferred per D2-09: adds Browser Rendering infra, ToS risk, captcha handling |
| ntfy.sh for push | Pushover, Telegram | D2-01 locked: ntfy.sh is Cloudflare-native fit, no SDK, self-hostable |
| Separate Flagger watchdog Worker | Atlas coordinator heartbeat | D2-08 locked: watchdog must survive Flagger death; same-process check fails silently |

**Installation (Phase 2 new dependencies only):**
```bash
pnpm add --filter scout rss-parser cheerio
pnpm add --filter headhunter rss-parser
```

**Version verification (run before install):**
```bash
npm view rss-parser version      # 3.13.0 [VERIFIED: npm registry 2026-06-05]
npm view cheerio version         # 1.2.0  [VERIFIED: npm registry 2026-06-05]
```

---

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `rss-parser` | npm | ~8 yrs | High (widely used) | github.com/rbren/rss-parser | [OK] | Approved |
| `cheerio` | npm | ~12 yrs | Very high | github.com/cheeriojs/cheerio | [OK] | Approved |
| `agents` | npm | ~2 yrs | Growing (CF official) | github.com/cloudflare/agents | [OK] | Approved |
| `@modelcontextprotocol/sdk` | npm | ~1 yr | High | github.com/modelcontextprotocol/typescript-sdk | [OK] | Approved |
| `@cloudflare/workers-oauth-provider` | npm | ~1 yr | CF official | github.com/cloudflare/workers-oauth-provider | [OK] | Approved |
| `@anthropic-ai/sdk` | npm | ~2 yrs | High | github.com/anthropic-ai/sdk-python (sister) | [OK] | Approved |
| `jose` | npm | ~8 yrs | Very high | github.com/panva/jose | [OK] | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none (note: `zod@4` as a standalone install name would be SLOP — use the range `^3.25 || ^4.0` already in package.json)
**Packages flagged as suspicious [SUS]:** none

---

## Architecture Patterns

### System Architecture Diagram

```
  Cron "0 21 * * 5" (EDT)
         │
         ▼
  Atlas scheduled() ──Promise.all──▶ Scout.weekly()   ──upsert events──▶ atlas-wire ──▶ Steward ──▶ Vault
                                 └──▶ Herald.weekly()  ──digest event──▶ atlas-wire ──▶ Steward ──▶ Vault
  Cron "30 21 * * 5"
         │
         ▼
  Atlas scheduled() ──▶ weekly-review-build ──▶ atlas-wire ──▶ Steward ──▶ Vault

  Cron "0 14 * * 1" (EDT) Mon full
  Cron "0 14 * * *" (EDT) daily-light
         │
         ▼
  Headhunter ──apply-by tasks──▶ Forge D1 (packages/tasks dedupe) ──▶ atlas-wire ──▶ Steward ──▶ Vault
             └──funnel counts──▶ atlas-wire ──▶ Steward ──▶ Vault

  Every agent (Phase 0/1/2) ──raw incident──▶ atlas-incidents ──▶ Flagger Worker
                                                                         │
                                              FlaggerState DO ◀─── score/dedupe/route ───▶ ntfy.sh (P1/P2)
                                                                         │
                                                                   atlas-wire ──▶ Steward ──▶ Vault (Flagger board)
                                                                         │
                                                                   D1 audit_log

  Cron (flagger-watchdog Worker)
         │
         ▼
  read KV "flagger:last_seen" ──quiet > 15m──▶ ntfy.sh P1 + atlas-wire ──▶ Steward
```

### Recommended Project Structure

```
apps/
├─ flagger/              # Event-driven Flagger Worker + FlaggerState DO
│  ├─ src/index.ts       # queue() handler for atlas-incidents + fetch() for ack route
│  ├─ src/score.ts       # severity/trust computation (deterministic)
│  ├─ src/push.ts        # ntfy.sh POST helper
│  ├─ src/state.ts       # FlaggerState DO (open-flags index, alarm scheduling)
│  └─ wrangler.jsonc     # INCIDENTS consumer; WIRE producer
├─ flagger-watchdog/     # Separate Cron Worker (own wrangler.jsonc, single cron)
│  ├─ src/index.ts       # scheduled() reads KV last_seen, fires if stale
│  └─ wrangler.jsonc
├─ scout/                # Friday weekly event discovery
│  ├─ src/index.ts       # WorkerEntrypoint weekly()
│  ├─ src/sources.ts     # RSS + Gmail newsletter fetch
│  ├─ src/score.ts       # relevance scoring vs Codex
│  └─ wrangler.jsonc
└─ headhunter/           # Hiring-window tracker
   ├─ src/index.ts       # WorkerEntrypoint full() + deadlines()
   ├─ src/windows.ts     # window state machine + funnel classification
   ├─ src/state.ts       # HeadhunterState DO
   └─ wrangler.jsonc
migrations/
└─ 0004_incidents_flagger.sql  # flags, open_flags, events, windows, jobs tables
packages/shared/src/
└─ flag.ts               # REWORKED: enqueue raw incident to atlas-incidents
```

### Pattern 1: atlas-incidents Queue Consumer Config (Flagger)

**What:** Flagger is the sole consumer of `atlas-incidents`. Separate from `atlas-wire` (Steward consumer). Own DLQ `atlas-incidents-dlq`.
**When to use:** New Cloudflare Queue for the incident pipeline; does NOT go on `atlas-wire`.

```jsonc
// apps/flagger/wrangler.jsonc
{
  "name": "flagger",
  "queues": {
    "consumers": [{
      "queue": "atlas-incidents",
      "max_batch_size": 25,
      "max_batch_timeout": 5,
      "max_retries": 3,
      "max_concurrency": 1,
      "dead_letter_queue": "atlas-incidents-dlq"
    }],
    "producers": [
      { "binding": "INCIDENTS", "queue": "atlas-incidents" },
      { "binding": "WIRE",      "queue": "atlas-wire" }
    ]
  }
}
```

**Rationale for `atlas-incidents-dlq` (own DLQ, not reusing `atlas-wire-dlq`):**
- `atlas-wire-dlq` is consumed by `dlq-sink` which calls `flag()` → emits onto `atlas-wire`. An incident that fails Flagger processing is structurally different from a dead Wire event and should not loop through the same sink (risks infinite re-emission).
- Its own DLQ lets the planner add a future sink specific to incident processing failures without modifying the existing `dlq-sink`.
- `max_batch_size 25` handles a burst of incident events (e.g. fleet-wide cascade) without excessive waits. `max_batch_timeout 5s` keeps P1 routing latency low. `max_concurrency 1` preserves serial flag-state processing inside the DO. [CITED: developers.cloudflare.com/workers/llms-full.txt]

**Provision commands:**
```bash
npx wrangler queues create atlas-incidents
npx wrangler queues create atlas-incidents-dlq
```

### Pattern 2: FlaggerState DO Shape + Alarm Scheduling

**What:** DO holds live flag state (open-flags-by-signature index) + per-expected-slot heartbeat alarms. One named singleton `env.FLAGGER_STATE.getByName("fleet")`.
**When to use:** Flagger Worker routes each incident through this DO for dedup + routing decisions.

```typescript
// apps/flagger/src/state.ts (outline)
import { DurableObject } from "cloudflare:workers";

export interface OpenFlag {
  id: string;
  signature: string; // source_agent + kind + normalized fingerprint
  severity: Severity;
  trust: number;
  status: "open" | "ack" | "resolved" | "muted";
  recurrence: number;
  title: string;
  detail?: string;
  created_at: number;
  updated_at: number;
}

export interface HeartbeatSlot {
  agent: string;
  cron_utc: string;      // "45 11 * * 1-5" etc.
  grace_ms: number;      // default 10 * 60 * 1000
  last_seen: number;     // epoch ms of last heartbeat
  expected_by: number;   // next expected deadline (epoch ms); alarm armed to this + grace
}

export class FlaggerState extends DurableObject<Env> {
  // Open flags by signature (stored in DO SQL)
  async upsertFlag(signature: string, update: Partial<OpenFlag>): Promise<OpenFlag> { ... }
  async getBySignature(signature: string): Promise<OpenFlag | null> { ... }
  async ackFlag(id: string): Promise<void> { ... }
  async resolveFlag(id: string): Promise<void> { ... }
  async muteFlag(id: string): Promise<void> { ... }

  // Heartbeat slot tracking + alarm management
  async recordHeartbeat(agent: string, ts: number): Promise<void> {
    // Update last_seen; compute expected_by for next slot; arm DO alarm
    // Pattern from official docs: getAlarm() → if null or needs refresh → setAlarm()
    const next_expected = computeNextSlot(agent, ts);
    const grace = await getGrace(this.env); // KV read, default 10m
    await this.ctx.storage.put(`hb:${agent}`, { last_seen: ts, expected_by: next_expected });
    // DO allows only ONE alarm — use setAlarm() with earliest deadline across all slots
    await this.refreshAlarm();
  }

  async refreshAlarm(): Promise<void> {
    // Find earliest (expected_by + grace_ms) across all registered slots
    // setAlarm(earliestDeadline) — overwrites any existing alarm
    const slots = await this.getAllSlots();
    const earliest = Math.min(...slots.map(s => s.expected_by + s.grace_ms));
    if (earliest < Infinity) await this.ctx.storage.setAlarm(earliest);
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // Check all slots: any where now > expected_by + grace?
    const now = Date.now();
    for (const slot of await this.getAllSlots()) {
      if (now > slot.expected_by + slot.grace_ms && slot.last_seen < slot.expected_by) {
        // Emit stale-heartbeat incident to atlas-incidents
        await emitStaleHeartbeat(this.env, slot.agent);
      }
    }
    // Rearm for next slot
    await this.refreshAlarm();
  }
  // Also: update last_seen KV for watchdog ("flagger:last_seen")
}
```

**IMPORTANT:** A DO has ONE alarm slot. `setAlarm()` overwrites. The pattern is to store per-slot deadlines in DO storage, then arm a single alarm at the earliest deadline. When `alarm()` fires, check all slots and re-arm. [VERIFIED: developers.cloudflare.com/durable-objects/api/base]

**DO alarm API (verified):**
- `this.ctx.storage.setAlarm(Date | number)` — sets/overwrites the single alarm
- `this.ctx.storage.getAlarm()` — returns `number | null`
- `this.ctx.storage.deleteAlarm()` — cancels
- `async alarm(alarmInfo?: AlarmInvocationInfo)` — handler called at-least-once on firing
- `alarmInfo.retryCount` / `alarmInfo.isRetry` — available for retry logic
[CITED: developers.cloudflare.com/workers/llms-full.txt]

### Pattern 3: Reworked `flag()` — Incident Enqueue

**What:** After D2-05, `flag()` enqueues a raw incident to `atlas-incidents` (never emits a finished flag to `atlas-wire` directly). `FlagRecord` becomes Flagger's OUTPUT shape, not the caller's emit shape.

**Current `flag()` signature (from `packages/shared/src/flag.ts`):**
```typescript
export async function flag(
  env: { WIRE: Queue<WireEvent> },
  severity: Severity,
  title: string,
  detail?: string,
  options: FlagOptions = {},
): Promise<void>
```

**Target signature (new raw incident shape):**
```typescript
export interface RawIncident {
  source_agent: string;
  kind: string;           // e.g. "api_error", "heartbeat", "malformed_event", "model_error"
  severity_hint: Severity;
  title: string;
  detail?: string;
  run_id?: string;        // optional: correlate cascade via shared run_id
}

export async function flag(
  env: { INCIDENTS: Queue<RawIncident> },
  severity: Severity,
  title: string,
  detail?: string,
  options: FlagOptions & { kind?: string; runId?: string } = {},
): Promise<void>
```

**Env change:** callers need `INCIDENTS: Queue<RawIncident>` binding instead of `WIRE`. Each Worker's `wrangler.jsonc` must add an `INCIDENTS` producer binding.

**Full caller list (verified by grep):**
| File | Call pattern | Migration notes |
|------|-------------|-----------------|
| `apps/dlq-sink/src/index.ts` | `flag(env, severity, title, detail, { sourceAgent })` | Add `INCIDENTS` binding to wrangler.jsonc; add `kind: "dlq_dead_letter"` |
| `packages/model/src/claude.ts` | `flag(env, "P3", ...)` (3 sites) | Add `INCIDENTS` to shared `Env` type; kind: `"model_error"` |
| `apps/steward/src/steward-consumer.ts` | `flag(env, "P3", "malformed wire event", ...)` (2 sites) | kind: `"malformed_event"` for P3, `"steward_write_fail"` for P2 |
| `apps/atlas/src/coordinator.ts` | `flag(env, "P1", ...)` | kind: `"heartbeat_stale"` |
| `apps/atlas/src/morning-chain.ts` | `flag(env, ...)` | kind: `"chain_halted"` |
| `apps/atlas/src/index.ts` | `flag(env, "P2", ...)` | kind: `"workflow_create_failed"` |
| `apps/herald/src/guardrail.ts` | `flag(env, "P2", ...)` | kind: `"security_leak_blocked"` |
| `apps/forge/src/index.ts` | `flag(env, ...)` | kind per call |
| `apps/sundial/src/reconcile.ts` | `flag(env, ...)` (2 sites) | kind per call |
| `apps/compass/src/index.ts` | `flag(env, ...)` | kind: `"overcommit"` or relevant |
| `apps/filer/src/index.ts` | `flag(env, ...)` | kind per call |

**Key migration invariant:** the callers of `flag()` do NOT own `FlagRecord` id generation anymore. The stable djb2 id is computed by Flagger from the incoming incident (same algorithm). Tests that assert on `flag.id` shape must be updated to assert on incident shape instead.

**The Env type update:**
```typescript
// packages/shared/src/env.ts — add INCIDENTS
export interface Env {
  WIRE: Queue<WireEvent>;
  INCIDENTS?: Queue<RawIncident>; // optional so Phase-0 Workers not yet retrofitted still compile
  DB: D1Database;
  CONFIG: KVNamespace;
  // ... rest unchanged
}
```

### Pattern 4: ntfy.sh Push Integration

**What:** Flagger POSTs to `https://ntfy.sh/<NTFY_TOPIC>` with priority headers and an "Ack" action button. Auth token via Bearer header.
**When to use:** P1/P2 flag routing when `flagger.push_enabled` = true in KV.

```typescript
// apps/flagger/src/push.ts
export async function pushFlag(
  env: FlaggerEnv,
  flag: FlagRecord,
  ackUrl: string,
): Promise<void> {
  const ntfyTopic = await env.NTFY_TOPIC.get();   // Secrets Store binding
  const ntfyToken = await env.NTFY_TOKEN.get();   // Secrets Store binding (optional)

  const priority = flag.severity === "P1" ? 5 : 4; // P1 → urgent(5), P2 → high(4)
  const body = {
    topic: ntfyTopic,
    title: `[${flag.severity}] ${flag.source_agent}`,
    message: flag.title,
    priority,
    tags: [flag.severity.toLowerCase(), flag.source_agent.toLowerCase()],
    actions: [{
      action: "http",
      label: "Ack",
      url: ackUrl,          // e.g. https://flagger.workers.dev/ack
      method: "POST",
      body: JSON.stringify({ id: flag.id }),
      clear: true,          // dismiss notification after ack
    }],
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (ntfyToken) headers["Authorization"] = `Bearer ${ntfyToken}`;

  const resp = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    // Push failure: flag still lands on board via Steward (D2-03 fallback)
    console.error(`ntfy push failed: ${resp.status}`);
  }
}
```

**ntfy.sh contract (verified against docs.ntfy.sh/publish/):**
- POST to `https://ntfy.sh/` (JSON body with `topic` field) OR `https://ntfy.sh/<topic>` (text/plain body)
- Priority: `5`=urgent/max, `4`=high, `3`=default, `2`=low, `1`=min
- Action buttons: `{ action: "http", label: "Ack", url, method, body, clear: true }`
- Auth: `Authorization: Bearer <token>` header
- Topic auth is optional (public topics need no token; private topics use token or Basic auth)

**Secrets for ntfy (Secrets Store):**
```bash
npx wrangler secrets-store secret create <atlas-store-id> --name ntfy-topic  --scopes workers --remote
npx wrangler secrets-store secret create <atlas-store-id> --name ntfy-token  --scopes workers --remote
```
```jsonc
// apps/flagger/wrangler.jsonc
"secrets_store_secrets": [
  { "binding": "NTFY_TOPIC", "store_id": "<atlas-store-id>", "secret_name": "ntfy-topic" },
  { "binding": "NTFY_TOKEN", "store_id": "<atlas-store-id>", "secret_name": "ntfy-token" }
]
```

**Ack endpoint pattern (the only inbound surface in Phase 2):**
```typescript
// apps/flagger/src/index.ts — fetch() handler
if (request.method === "POST" && url.pathname === "/ack") {
  const token = await env.ACK_TOKEN.get(); // Secrets Store binding
  const auth = request.headers.get("Authorization") ?? "";
  // Constant-time comparison (timing-safe)
  if (!timingSafeEqual(auth, `Bearer ${token}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { id } = await request.json() as { id: string };
  const state = env.FLAGGER_STATE.getByName("fleet");
  await state.ackFlag(id);
  return new Response("OK");
}
```

The ntfy action button POSTs with the `Authorization: Bearer <ACK_TOKEN>` header automatically (set in the action definition). `ACK_TOKEN` is a separate secret from `NTFY_TOKEN`.

### Pattern 5: Flagger Watchdog Worker

**What:** Separate Worker (`apps/flagger-watchdog`) with a single cron. Reads `flagger:last_seen` from KV. If stale, fires self-P1 to ntfy.sh AND emits a self-flag to `atlas-wire` (bypasses `atlas-incidents` because Flagger may be dead).
**When to use:** The one case where incident routing can't go through Flagger itself.

```typescript
// apps/flagger-watchdog/src/index.ts
export default {
  async scheduled(controller: ScheduledController, env: WatchdogEnv): Promise<void> {
    const threshold = parseInt(await env.CONFIG.get("selfwatch_threshold") ?? "900000"); // 15m
    const lastSeenStr = await env.CONFIG.get("flagger:last_seen");
    const lastSeen = lastSeenStr ? parseInt(lastSeenStr) : 0;
    const age = Date.now() - lastSeen;

    if (age > threshold) {
      // Bypass atlas-incidents — emit directly to atlas-wire (Steward writes the board)
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
          detail: `Last seen ${Math.round(age / 60000)} min ago (threshold ${threshold / 60000}m)`,
          status: "open",
        },
        idempotencyKey: `flg:${localDate()}:Flagger:watchdog`,
      });
      // Also push directly to ntfy if creds available (belt and suspenders)
      await directPush(env);
    }
  }
} satisfies ExportedHandler<WatchdogEnv>;
```

```jsonc
// apps/flagger-watchdog/wrangler.jsonc — OWN Worker, own cron
{
  "name": "flagger-watchdog",
  "queues": { "producers": [{ "binding": "WIRE", "queue": "atlas-wire" }] },
  "triggers": { "crons": ["*/5 * * * *"] }  // every 5 min; check if > 15m stale
}
```

Note: Watchdog reads `flagger:last_seen` from KV (set by Flagger Worker on each batch processed). KV is appropriate here — it's a single-key heartbeat value, not a counter. `selfwatch_threshold` from KV (default 15m).

### Pattern 6: Standalone Cron Cases in Atlas scheduled()

**What:** Phase 2 adds 4 new cron cases to `apps/atlas/src/index.ts` `dispatcher.scheduled()`. These are standalone, NOT Workflow steps.

**New cron cases to add:**
```typescript
// EST times (UTC-5) — re-derive to EDT (UTC-4) at DST boundary with /cron-utc
case "0 14 * * *":   // 09:00 ET daily-light — Headhunter deadlines
case "0 14 * * 1":   // Mon 09:00 ET — Headhunter full
  _ctx.waitUntil(env.HEADHUNTER.run(mode, date));
  break;

case "0 21 * * 5":   // Fri 16:00 ET — Scout weekly + Herald weekly (EDT form)
case "0 20 * * 5":   // Fri 16:00 ET — EDT form (verify at each DST boundary)
  _ctx.waitUntil(Promise.all([
    env.SCOUT.weekly(date),
    env.HERALD.weekly(date),
  ]).catch(async (err) => {
    await flag(env, "P2", "friday-digest.failed", String(err), { kind: "chain_halted" });
  }));
  break;

case "30 21 * * 5":  // Fri 16:30 ET — weekly-review build (EDT form)
case "30 20 * * 5":  // EDT form
  _ctx.waitUntil(env.STEWARD.weeklyReviewBuild(date));
  break;
```

**New wrangler.jsonc triggers on Atlas (EST forms — re-derive for EDT):**
```jsonc
"triggers": { "crons": [
  "45 12 * * 1-5",  // 07:45 ET MorningChain (EST)
  "0 14 * * *",     // 09:00 ET Headhunter daily-light (EST)
  "0 14 * * 1",     // Mon 09:00 ET Headhunter full (EST)
  "0 21 * * 5",     // Fri 16:00 ET Scout+Herald (EST)
  "30 21 * * 5",    // Fri 16:30 ET weekly-review build (EST)
  "0 2 * * *"       // 21:00 ET Compass preview (EST)
]}
```

**DST table (from `docs/03-scheduling.md` §5):**
| Owner-local ET | EDT (UTC-4) | EST (UTC-5) | Current form (EDT is active June) |
|---|---|---|---|
| 09:00 daily | `0 13 * * *` | `0 14 * * *` | `0 14 * * *` (codebase is EST) |
| Mon 09:00 | `0 13 * * 1` | `0 14 * * 1` | `0 14 * * 1` |
| Fri 16:00 | `0 20 * * 5` | `0 21 * * 5` | `0 21 * * 5` |
| Fri 16:30 | `30 20 * * 5` | `30 21 * * 5` | `30 21 * * 5` |

[CITED: docs/03-scheduling.md §5, docs/13-build-plan.md §1.3 — verified against existing codebase]

**Free plan cron limit:** [ASSUMED] The Cloudflare Workers Free plan has a per-Worker cron limit (historically 3 crons per Worker on Free, more on Paid). Current build-plan §1 documents: "Workers Paid ($5/mo) is an optional headroom upgrade — take it for a higher per-Worker cron cap." Atlas already has `"45 12 * * 1-5"` + `"45 12 * * *"` + `"0 2 * * *"` = 3 crons. Adding 4 more (Phase 2) = 7 crons total. This LIKELY requires Workers Paid. Verify with `wrangler deploy --dry-run` or Cloudflare dashboard before deploying. [ASSUMED — verify at deploy-time]

### Pattern 7: Scout RSS + Gmail Sources

**What:** Scout v1 fetches RSS feeds + plain-HTML listings + Gmail `Type/Newsletter`/`Type/Events` threads. No browser rendering.

```typescript
// RSS feed fetch (rss-parser in Worker)
import Parser from "rss-parser";
const parser = new Parser({ timeout: 10000 });
const feed = await parser.parseURL("https://example.com/events.rss");
// Each item: { title, link, isoDate, contentSnippet }

// Plain HTML fetch (cheerio for static HTML listings)
import * as cheerio from "cheerio";
const resp = await fetch("https://example.com/events", {
  headers: { "User-Agent": "Atlas-Scout/1.0" }
});
const html = await resp.text();
const $ = cheerio.load(html);
// Extract event rows...

// Gmail Type/Newsletter via Google MCP (gmail.readonly)
// Reuses existing mcp-google gmailTools.searchThreads()
// Query: "label:Type/Newsletter newer_than:7d"
// Per D2-09: never follow links in email sources (§5.8)
```

**D1 Event record (new table `events` in migration `0004_...sql`):**
```sql
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,          -- "evt_<date>_<hash>"
  title       TEXT NOT NULL,
  start       TEXT NOT NULL,             -- ISO-8601 owner-local
  end         TEXT,
  location    TEXT,
  online      INTEGER NOT NULL DEFAULT 0,
  url         TEXT,
  source      TEXT,                      -- 'rss', 'gmail-newsletter', 'gmail-invite', etc.
  relevance   INTEGER,                   -- 0-100
  why         TEXT,                      -- one-line rationale
  horizon     TEXT,                      -- 'week' | 'month'
  status      TEXT NOT NULL DEFAULT 'surfaced',  -- surfaced|chosen|handed_off|registered
  digest_date TEXT,                      -- YYYY-MM-DD of first surfacing (dedupe by date)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_start  ON events(start);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
```

**Idempotency key:** `scout:evt_<YYYY-MM-DD>_<title-hash>` — consistent with `scout:evt_<id>` from spec.

**Dedupe logic:** skip events already in `events` table with same `url` OR same `(title, start)` within `dedupe_window_weeks` weeks. Sparse-week relaxation: if fewer than `min_surfaced` events clear `min_relevance`, apply `relaxed_min_relevance` (e.g. 40). [ASSUMED — relaxed threshold value not locked]

### Pattern 8: Headhunter D1 Tables + HeadhunterState DO

**What:** D1 stores the hiring-window model and seen-store. `HeadhunterState` DO serializes concurrent window updates.

```sql
-- migration 0004_... (separate section)
CREATE TABLE IF NOT EXISTS windows (
  id           TEXT PRIMARY KEY,             -- "win_<company>_<cycle>_<role_class>"
  company      TEXT NOT NULL,
  cycle        TEXT NOT NULL,               -- "fall-2026"
  role_class   TEXT NOT NULL,               -- "intern"|"new-grad"|"experienced"
  opens_est    TEXT,                        -- YYYY-MM-DD
  closes_est   TEXT,                        -- YYYY-MM-DD
  confidence   REAL NOT NULL DEFAULT 0.5,   -- 0.0-1.0
  source       TEXT NOT NULL DEFAULT 'historical', -- historical|posting|owner
  status       TEXT NOT NULL DEFAULT 'upcoming',   -- upcoming|open|closing|closed
  last_seen_open TEXT,                      -- YYYY-MM-DD of last scan with live posting
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,          -- fingerprint hash
  company        TEXT NOT NULL,
  title_norm     TEXT NOT NULL,
  location_norm  TEXT,
  cycle          TEXT,
  window_id      TEXT,                      -- FK to windows
  sources        TEXT NOT NULL DEFAULT '[]', -- JSON array of source URLs
  deadline       TEXT,                      -- explicit deadline if found
  fit_score      REAL,                      -- Codex fit 0.0-1.0
  status         TEXT NOT NULL DEFAULT 'seen', -- seen|tasked|applied|oa|interview|offer|rejected
  first_seen     TEXT NOT NULL,             -- YYYY-MM-DD
  last_seen      TEXT NOT NULL              -- YYYY-MM-DD
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_fingerprint ON jobs(id);
CREATE INDEX IF NOT EXISTS idx_jobs_window  ON jobs(window_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
```

**Fingerprint:** `normalize(company) + normalize(title) + location + cycle` — djb2 hash of concatenation. Cross-board same fingerprint = one logical role.

**HeadhunterState DO:** one singleton `env.HEADHUNTER_STATE.getByName("pipeline")`. Serializes window status transitions and last_seen_open advances via `blockConcurrencyWhile`. Not needed for reads (D1 reads are fine outside the DO lock).

**Idempotency keys:**
- Apply-by task via Forge: `headhunter:window:<company>:<cycle>` (window-based) or `headhunter:role:<fingerprint>` (posting-based)
- Pipeline count event: `headhunter:funnel:<thread_id>:<stage>` (deduped by (thread, stage) per D2-13)
- Tracked-windows summary: `headhunter:scan:<date>`

**D2-14 urgency bypass (low-confidence date → P3 flag):**
```typescript
if (window.confidence < 0.4 && window.source === "historical") {
  // Emit P3 flag to atlas-incidents, NOT a task
  await flag(env, "P3", `Low-confidence window: ${window.company} ${window.cycle}`,
    `closes_est ${window.closes_est} is historical-only (confidence ${window.confidence})`,
    { kind: "low_confidence_window", runId });
} else {
  // Create apply-by task via Forge regardless of fit_floor when urgency applies
  await createApplyByTask(env, window, runId);
}
```

### Anti-Patterns to Avoid

- **Emitting a finished FlagRecord from a call site:** D2-05 is explicit — callers emit raw incidents; Flagger builds the record. No caller should construct a `FlagRecord` directly after the rework.
- **Sending to `atlas-wire` from Flagger's incident handler:** Flagger consumes `atlas-incidents` and produces to `atlas-wire`. These are two separate bindings; do NOT accidentally consume `atlas-wire` (guard-wire-consumer.js hook will catch it, but the design intent is to avoid the mistake).
- **Using `crypto.randomUUID()` for incident or flag IDs:** IDs must be deterministic (source_agent + kind + normalized fingerprint → djb2 hash) so replays produce the same ID and Steward dedupes correctly.
- **Putting `NTFY_TOPIC` or `NTFY_TOKEN` in `[vars]`:** Secrets Store only (`await env.NTFY_TOPIC.get()`). Never in KV, Vault, or Codex.
- **Using `Promise.all` inside the Flagger queue handler:** Incidents must be processed serially (for…of, not Promise.all) to maintain the single-writer discipline through the DO lock.
- **Arming one DO alarm per heartbeat slot:** DOs have ONE alarm slot. Arm a single alarm at the earliest (expected_by + grace_ms) deadline across all slots, and check all slots when it fires.
- **Registering two atlas-wire consumers:** The `guard-wire-consumer.js` PreToolUse hook will block this, but double-check: Flagger consumes `atlas-incidents`, NOT `atlas-wire`.
- **Mutating `event.payload` inside a Workflow step:** Not applicable to Phase 2 (standalone crons, not Workflow steps), but still relevant for the MorningChain retrofit (heartbeat emits inside steps should only append, never mutate existing payload).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| RSS feed parsing | Custom XML parser | `rss-parser` npm package | Feed quirks (CDATA, namespaces, encoding) are a known rabbit hole |
| Static HTML scraping | Custom regex | `cheerio` | CSS selector API; battle-tested against varied HTML |
| Push notification delivery | Custom WebSocket or polling | ntfy.sh HTTPS POST | Zero infrastructure; no SDK needed; one secret; self-hostable |
| Dedupe key stability | Date-based or random IDs | djb2 hash of (source_agent + kind + fingerprint) | Matches existing `flag()` and Steward idempotency — the same incident produces the same key on replay |
| DO alarm per-slot scheduling | Multiple DOs (one per slot) | Single FlaggerState DO with one alarm tracking earliest deadline | DOs have ONE alarm slot; multiple DOs would require coordination |
| Flag lifecycle storage | KV | DO SQLite (FlaggerState) | KV is 1 write/s/key + 60s lag — wrong for mutable flag status |
| Heartbeat last_seen tracking for watchdog | D1 | KV | The watchdog reads KV directly; a simple single-key heartbeat IS the right KV use case (not a counter; read-hot, low-write) |
| Job window model | Ad hoc | D1 `windows` + `jobs` tables | Structured queries for closing-window detection and status transition |

**Key insight:** The atlas-incidents → Flagger → atlas-wire topology looks complex but its purpose is clean separation: producers never block on scoring, and Steward never has push I/O in its serial write loop.

---

## Runtime State Inventory

> This is not a rename/refactor phase; no string-replacement migration is needed. However, the `flag()` rework changes the WIRE binding requirement on 10+ callers — that is a code-only migration, not a data migration. No stored data (D1, KV, Vault) holds references to the current `flag()` output schema that would need updating; Steward dedupes by idempotencyKey and a new Phase-2 Flagger-generated id will simply create new flag rows.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Phase-0/1 D1 tables: `idempotency_keys`, `counters`, `run_log`, `audit_log`, `vault_outbox`, `tasks`, `subtasks` — none reference the old `flag()` output schema | No data migration; new migrations add `events`, `windows`, `jobs` tables |
| Live service config | No deployed Workers yet (owner go-live gates pending) | New `atlas-incidents` queue provision required before deploy |
| OS-registered state | None | — |
| Secrets/env vars | Phase-0/1 secrets don't include ntfy creds; new secrets needed: `ntfy-topic`, `ntfy-token`, `ack-token` | Provision in Secrets Store before go-live; go-live gate |
| Build artifacts | No stale artifacts | Wrangler will create new dist/ per new app |

**Nothing found requiring data migration.** Verified by reading D1 schema (`migrations/0001_init_core.sql`, `0002_vault_outbox_claim.sql`, `0003_tasks.sql`).

---

## Common Pitfalls

### Pitfall 1: DO Has ONE Alarm Slot
**What goes wrong:** Planning one alarm per heartbeat-monitored agent (7+ agents) by assuming multiple alarms can be armed.
**Why it happens:** The API says `setAlarm()` — developers assume it appends; it replaces.
**How to avoid:** Store expected-deadline per slot in DO SQLite/storage; compute earliest deadline; arm ONE alarm at that time; check all slots when the alarm fires; rearm.
**Warning signs:** Only the last `setAlarm()` call fires; earlier deadlines are silently lost.

### Pitfall 2: atlas-incidents vs atlas-wire Consumer Confusion
**What goes wrong:** Accidentally declaring Flagger as a consumer of `atlas-wire`, breaking Pillar 1.
**Why it happens:** All existing agents produce to `atlas-wire`; a developer might conflate "subscribes to incidents" with consuming `atlas-wire`.
**How to avoid:** Flagger's `wrangler.jsonc` has `atlas-incidents` in `consumers` and BOTH `atlas-incidents` + `atlas-wire` in `producers`. The guard-wire-consumer.js hook will block a `atlas-wire` consumer declaration, but design intent avoids it.
**Warning signs:** `guard-wire-consumer.js` hook fires; CI check fails.

### Pitfall 3: `flag()` Rework — Tests Assert on FlagRecord Shape
**What goes wrong:** 315 green tests include tests that assert on the output of `flag()` — specifically the Wire event payload shape (`op: "upsert"`, `entity: "flag"`, `payload.id`, etc.). After D2-05, `flag()` emits a raw incident to a new queue; those assertions break.
**Why it happens:** The test contract is tied to the old emit shape.
**How to avoid:** Update test assertions to match the new `RawIncident` shape on the `INCIDENTS` queue. The old Wire-based assertions move to Flagger's output tests. Run `pnpm test` at each step of the migration.
**Warning signs:** `packages/shared/test/flag.test.ts` fails; `apps/dlq-sink/test/dlq.test.ts` fails; `apps/steward/test/malformed.test.ts` fails.

### Pitfall 4: Secrets Store Reads Are Async
**What goes wrong:** `env.NTFY_TOPIC` used as a string instead of `await env.NTFY_TOPIC.get()`.
**Why it happens:** `[vars]` are synchronous strings; Secrets Store bindings are objects with an async `get()` method. The compiler doesn't catch this unless the type is correctly declared.
**How to avoid:** Declare all Secrets Store bindings as `SecretsStoreSecret` in the Env type; the TypeScript compiler will flag direct string usage.
**Warning signs:** `env.NTFY_TOPIC` returns `[object Object]` at runtime; push always fails silently.

### Pitfall 5: Cron Per-Worker Limit on Free Plan
**What goes wrong:** Atlas Worker already has 3 crons from Phase 0/1; Phase 2 adds 4 more (= 7 total). Workers Free plan likely limits crons per Worker (historically 3).
**Why it happens:** Build plan §1 documents Workers Paid as optional, but the limit isn't explicitly verified for this exact count.
**How to avoid:** Run `wrangler deploy --dry-run` with the expanded crons list before deploying; check the error. If the limit is hit, upgrade to Workers Paid ($5/mo) as the build plan suggests as an option.
**Warning signs:** `wrangler deploy` fails with a cron/trigger limit error.

### Pitfall 6: DST Cron Drift
**What goes wrong:** Using the wrong UTC form (EST vs EDT) for the Friday 16:00 / 16:30 crons.
**Why it happens:** Cron Triggers are UTC-only, no DST. The current period (June 2026) is EDT (UTC-4); the EST (UTC-5) form `"0 21 * * 5"` would fire at 17:00 ET in summer. The existing morning-chain cron already had this translated.
**How to avoid:** Use the `docs/03-scheduling.md §5` translation table. Current (EDT): `"0 20 * * 5"` for 16:00, `"30 20 * * 5"` for 16:30. Commit the hand-edit and annotate with the EDT/EST comment. Use `/cron-utc` slash command.
**Warning signs:** Friday digest fires at 17:00 instead of 16:00 in summer months.

### Pitfall 7: `Promise.all` Friday Fan-in — One Failure Blocks the Other
**What goes wrong:** `Promise.all([env.SCOUT.weekly(date), env.HERALD.weekly(date)])` — if Scout fails, Herald's result is lost and vice versa.
**Why it happens:** `Promise.all` rejects on the first failure, potentially losing completed work.
**How to avoid:** Use `Promise.allSettled()` or wrap each in a try/catch so a Scout failure doesn't suppress Herald's successful completion. The build-plan §4 notes: "the 16:30 weekly-review build runs with a partial summary and Flagger notes the gap; it is not blocked indefinitely."
```typescript
const [scoutResult, heraldResult] = await Promise.allSettled([
  env.SCOUT.weekly(date).catch(err => { flag(env, "P2", "scout-weekly.failed", ...); return null; }),
  env.HERALD.weekly(date).catch(err => { flag(env, "P2", "herald-weekly.failed", ...); return null; }),
]);
```

### Pitfall 8: `NonRetryableError` Import Module
**What goes wrong:** Importing `NonRetryableError` from `cloudflare:workers` instead of `cloudflare:workflows`.
**Why it happens:** `WorkflowEntrypoint` comes from `cloudflare:workers`; `NonRetryableError` is from a different module.
**How to avoid:** `import { NonRetryableError } from "cloudflare:workflows"`. Phase 2 doesn't add new Workflow steps (standalone crons), but the morning-chain retrofit may trigger this if new error paths are added.

---

## Code Examples

### Example: Reworked flag() producing RawIncident

```typescript
// Source: packages/shared/src/flag.ts — after D2-05 rework
import type { Severity } from "./env.js";

export interface RawIncident {
  source_agent: string;
  kind: string;
  severity_hint: Severity;
  title: string;
  detail?: string;
  run_id?: string;
}

export interface FlagOptions {
  sourceAgent?: string;
  suggestedAction?: string;
  kind?: string;
  runId?: string;
}

export async function flag(
  env: { INCIDENTS: Queue<RawIncident> },
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

### Example: FlaggerState DO Alarm — Single Alarm for Multiple Slots

```typescript
// Source: Cloudflare DO alarm API pattern (developers.cloudflare.com/durable-objects/api/base)
async refreshAlarm(): Promise<void> {
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

async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
  const now = Date.now();
  const allSlots = await this.ctx.storage.list<HeartbeatSlot>({ prefix: "hb:" });
  for (const [key, slot] of allSlots.entries()) {
    if (now > slot.expected_by + slot.grace_ms && slot.last_seen < slot.expected_by) {
      // Emit stale-heartbeat incident
      await this.env.INCIDENTS.send({
        source_agent: slot.agent,
        kind: "heartbeat_stale",
        severity_hint: "P1",
        title: `${slot.agent} heartbeat stale — no ${slot.cron_label} run`,
      });
    }
  }
  await this.refreshAlarm();
}
```

### Example: Headhunter task emission through Forge path

```typescript
// Source: Headhunter integration with @atlas/tasks dedupe path (packages/tasks)
// Headhunter DOES NOT write the tasks table directly — it emits a WireEvent
// that Forge processes, or calls Forge via service binding.
// The task idempotencyKey matches Forge's existing dedupe: sha256(thread+normalizedTitle+dueDate)

// Preferred: service-binding RPC (D-11 pattern)
await env.FORGE.createTask({
  title: `apply by ${window.closes_est} — ${window.company} ${window.role_class} (${window.cycle})`,
  due: window.closes_est,
  due_kind: window.confidence >= 0.7 ? "explicit" : "inferred",
  source_agent: "Headhunter",
  thread: null, // no email thread source
  priority: urgency === "closing" ? "P1" : "P2",
}, {
  idempotencyKey: `headhunter:window:${window.company}:${window.cycle}`,
  runId: date,
});
```

### Example: ntfy.sh POST with action button (verified against docs.ntfy.sh/publish/)

```typescript
// Source: docs.ntfy.sh/publish/ — verified 2026-06-05
const payload = {
  topic: await env.NTFY_TOPIC.get(),
  title: `[${flag.severity}] ${flag.source_agent}`,
  message: flag.title,
  priority: flag.severity === "P1" ? 5 : 4,
  actions: [{
    action: "http",
    label: "Ack",
    url: `https://flagger.workers.dev/ack`,
    method: "POST",
    headers: { "Authorization": `Bearer ${await env.ACK_TOKEN.get()}` },
    body: JSON.stringify({ id: flag.id }),
    clear: true,
  }],
};
const resp = await fetch("https://ntfy.sh/", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${await env.NTFY_TOKEN.get()}`,
  },
  body: JSON.stringify(payload),
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `flag()` emits finished FlagRecord to `atlas-wire` | `flag()` enqueues raw `RawIncident` to `atlas-incidents` | Phase 2 (this phase) | Decouples emitter from scoring; Flagger owns all trust/severity logic |
| Scout spec mentions Playwright/Browser Rendering | D2-09 defers browser rendering; RSS + plain fetch for Phase 2 | Phase 2 decision | Lower complexity, no ToS risk; defer JS-rendered sources |
| `atlas-wire` as the only queue | Two queues: `atlas-wire` + `atlas-incidents` | Phase 2 | `atlas-incidents` enables fire-and-forget incident reporting without coupling to Steward's write lock |
| heartbeat_grace "5 min" (open owner-judgment) | 10m default (D2-07 resolved) | Phase 2 context | Balances false-alarm rate vs detection latency |

**Deprecated/outdated in context of this phase:**
- `packages/shared/src/flag.ts` current emit-to-wire behavior: replaced by enqueue-to-incidents
- Build-plan §4 note on "heartbeat_grace 5 min (open question)": resolved to 10m by D2-07

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Workers Free plan allows at most 3 crons per Worker; 7 crons (Phase 0/1/2 total) requires Workers Paid | Pattern 6 / Pitfall 5 | Planner must include a `checkpoint:verify-cron-limit` task before deploying Phase 2 crons |
| A2 | The `relaxed_min_relevance` value for Scout sparse-week fill is ~40 (below the default 55) | Pattern 7 / Scout KV knobs | Scout knob not locked in CONTEXT.md; value is illustrative; owner tunes via KV |
| A3 | FlaggerState DO SQLite tables are sufficient for open-flag index (no separate D1 `flags` table needed) | Pattern 2 | If flag volume becomes large, a D1 `flags` table may be preferred; design can migrate later |
| A4 | The watchdog cron `"*/5 * * * *"` (every 5 min) is within per-Worker limits for `flagger-watchdog` (its own Worker with only one cron) | Pattern 5 | Separate Worker = separate cron limit; one cron should always be within Free plan limits |
| A5 | `Promise.allSettled()` is available in the workerd runtime | Pattern 6 | Standard ES2020; workerd compatibility_date 2026-04-25 should include it |

**If this table's assumptions clear:** All other claims in this research were verified against living code, official docs (Cloudflare, ntfy.sh), or canon design documents.

---

## Open Questions

1. **Workers Free plan cron limit (A1)**
   - What we know: Build plan §1 says Paid is optional headroom for "higher per-Worker cron cap"; Atlas currently has 3 crons
   - What's unclear: Exact limit on Free for crons per Worker in 2026
   - Recommendation: Planner must add a `checkpoint:human-verify` task "verify cron limit before adding Phase 2 crons" before the Atlas wrangler.jsonc update task

2. **FlaggerState DO vs D1 `flags` table for flag storage**
   - What we know: DO SQLite is free-form; D1 is the system-of-record; CONTEXT.md left DO shape to discretion
   - What's unclear: Whether flag volume over time warrants D1 queryability (e.g. reporting, bulk queries)
   - Recommendation: Start with DO SQLite for live state (faster, consistent); emit each flag to D1 audit_log (already exists). Migrate to D1 `flags` table if query patterns emerge.

3. **Headhunter → Forge service binding vs direct D1 write**
   - What we know: D2-14 says "emits apply-by tasks through Forge's path"; `packages/tasks` has the dedupe logic; Forge is a separate Worker
   - What's unclear: Whether Headhunter calls Forge via service binding RPC or emits a WireEvent that Forge picks up (both patterns exist)
   - Recommendation: Service binding RPC (D-11 pattern, `env.FORGE.createTask(...)`) — consistent with how the morning chain invokes agents; avoids adding a new event type to atlas-wire that Steward would need to handle

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `wrangler` CLI | Deploy + provision | ✓ | ^4.98.0 | — |
| Node.js LTS | Build toolchain | ✓ | v22.x (assumed from Phase 0/1) | — |
| `atlas-incidents` queue | Flagger consumer | ✗ (not yet provisioned) | — | Must be provisioned before deploy: `wrangler queues create atlas-incidents` |
| `atlas-incidents-dlq` queue | Flagger DLQ | ✗ | — | `wrangler queues create atlas-incidents-dlq` |
| ntfy.sh topic + token | Flagger push | ✗ (owner gate) | — | Push flag-gated off by default (D2-03); board fallback |
| ACK_TOKEN secret | Flagger ack endpoint | ✗ (owner gate) | — | Ack endpoint returns 401 until seeded; ack route must tolerate missing token gracefully |
| Headhunter KV config | Headhunter go-live | ✗ (owner gate D2-15) | — | Starter seed (few well-known programs) in code; real list owner-curated |
| `atlas-db` D1 | New migrations | ✓ (existing) | — | Migrations add to existing DB |

**Missing dependencies blocking go-live (not blocking code development):**
- `atlas-incidents` + `atlas-incidents-dlq` queue creation
- ntfy creds (`ntfy-topic`, `ntfy-token`, `ack-token`) in Secrets Store
- `flagger.push_enabled = true` in KV CONFIG
- Headhunter KV watchlist/boards/cycle (`headhunter/tracked_companies`, `/boards`, `/cycle`)

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x + `@cloudflare/vitest-pool-workers` 0.16.13 |
| Config file | Each app has `vitest.config.ts`; root `vitest.workspace.ts` aggregates |
| Quick run command | `pnpm --filter flagger test` (or per-app) |
| Full suite command | `pnpm test` (all workspaces) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WEEKLY-02 | `flag()` enqueues to `atlas-incidents`, NOT `atlas-wire` | unit | `pnpm --filter @atlas/shared test` | ❌ Wave 0 (update existing flag.test.ts) |
| WEEKLY-02 | Flagger dedupes same incident by signature → one flag row | unit | `pnpm --filter flagger test -- dedup` | ❌ Wave 0 |
| WEEKLY-02 | Flagger P1/P2 → push call; P3/P4 → no push call | unit | `pnpm --filter flagger test -- routing` | ❌ Wave 0 |
| WEEKLY-02 | Flagger self-watchdog kill test: Flagger last_seen stale → self-P1 emitted | integration | `pnpm --filter flagger-watchdog test -- kill` | ❌ Wave 0 (gating criterion) |
| WEEKLY-02 | Replay through Steward: same incident → `meta.changes === 0` | integration | `pnpm --filter steward test -- replay` | ✅ (existing pattern; extend) |
| WEEKLY-02 | FlaggerState DO alarm fires when heartbeat slot stale | unit | `pnpm --filter flagger test -- alarm` | ❌ Wave 0 |
| WEEKLY-01 | Headhunter re-scan idempotent: same window → same task, no counter inflation | integration | `pnpm --filter headhunter test -- idempotent` | ❌ Wave 0 (gating criterion) |
| WEEKLY-01 | Low-confidence window date → P3 flag, NOT a task | unit | `pnpm --filter headhunter test -- low-confidence` | ❌ Wave 0 |
| WEEKLY-01 | Scout re-run same Friday → same event list, no duplicate Steward events | integration | `pnpm --filter scout test -- idempotent` | ❌ Wave 0 |
| WEEKLY-01 | ≥70% flags actionable (non-muted) on noise bar | smoke/manual | Manual review after 1 week of live runs | — |

**Definition-of-Done tests required per agent PR (from CLAUDE.md):**
1. Wire-contract test: shape + structured idempotencyKey for each emitted event
2. Replay test through Steward: `meta.changes === 0`
3. Failure-path test: correct Flagger severity emitted

### Sampling Rate

- **Per task commit:** `pnpm --filter <app> test` (app-scoped)
- **Per wave merge:** `pnpm test` (full suite — currently 315 tests; must stay green)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `packages/shared/test/flag.test.ts` — update to assert `RawIncident` shape on `INCIDENTS` queue (REQ: WEEKLY-02)
- [ ] `apps/flagger/test/dedup.test.ts` — signature dedup test (REQ: WEEKLY-02)
- [ ] `apps/flagger/test/routing.test.ts` — P1/P2 push vs P3/P4 batch routing (REQ: WEEKLY-02)
- [ ] `apps/flagger/test/alarm.test.ts` — DO alarm stale-heartbeat detection (REQ: WEEKLY-02)
- [ ] `apps/flagger-watchdog/test/kill.test.ts` — self-watchdog kill test (gating criterion)
- [ ] `apps/headhunter/test/idempotent.test.ts` — re-scan idempotency (gating criterion)
- [ ] `apps/headhunter/test/low-confidence.test.ts` — low-confidence → flag not task (REQ: WEEKLY-01)
- [ ] `apps/scout/test/idempotent.test.ts` — re-run idempotency (REQ: WEEKLY-01)
- [ ] `apps/dlq-sink/test/dlq.test.ts` — update to new `RawIncident` shape (migration)
- [ ] Per-agent heartbeat emit tests for each Phase-0/1 agent retrofit

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (ack endpoint) | `Authorization: Bearer <ACK_TOKEN>` constant-time comparison |
| V3 Session Management | no | No sessions in Phase 2 |
| V4 Access Control | yes (ack endpoint, push gating) | `flagger.push_enabled` KV gate; token-gated ack route fail-closed |
| V5 Input Validation | yes | `RawIncident` zod schema on queue consumer; ack endpoint body schema |
| V6 Cryptography | no | No new crypto; ntfy token via Secrets Store (not hand-rolled) |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged ack request to flip flag status | Spoofing | `Authorization: Bearer <ACK_TOKEN>` constant-time compare; token in Secrets Store never in `[vars]` |
| Push storm (many agents flag same root cause) | Denial of Service | Dedupe by signature in FlaggerState DO; `run_id` cascade grouping collapses to one flag |
| Incident queue poisoning (malformed incident blocks Flagger) | Tampering | Always `ack()` malformed incidents (never retry); emit P3 to `atlas-wire` directly (bypassing incidents) |
| ntfy topic disclosure | Information Disclosure | Topic name in Secrets Store (never in `[vars]`, KV, Vault, Codex, or logs) |
| Scout email source link-following | Elevation of Privilege | Per D2-09 + §5.8: never follow links from `Type/Newsletter`/`Type/Events` sources; never read `Type/Security`/`⚠ Phishing-Suspect` |
| Headhunter scraping credentials leaking | Information Disclosure | OAuth scopes read-only; no board credentials stored in KV/Vault; all secrets via Secrets Store |

**Security note on ack endpoint:** The ntfy action button's `headers` field can pass the `Authorization: Bearer <ACK_TOKEN>` header directly. This is secure as long as `ACK_TOKEN` is different from `NTFY_TOKEN` and stored in Secrets Store. The Flagger Worker's `fetch()` handler must use constant-time comparison for the token check (timing-safe equals — similar to the existing `ATLAS_BRIDGE_TOKEN` pattern in `mcp-obsidian-bridge`). [CITED: docs/11-security-privacy.md]

---

## Sources

### Primary (HIGH confidence)

- Living code at HEAD `09518da` — `packages/shared/src/flag.ts`, `apps/dlq-sink/src/index.ts`, `apps/atlas/src/index.ts`, `packages/shared/src/env.ts`, `migrations/0001_init_core.sql`, `migrations/0003_tasks.sql`
- `docs/SPEC-CANON.md` §8 (flag lifecycle, severity/trust) — authoritative design
- `docs/13-build-plan.md` §4 (Phase 2 sequencing, cron lines, gating criteria)
- `docs/agents/flagger.md`, `docs/08-flagger.md` — Flagger spec
- `docs/agents/scout.md`, `docs/agents/headhunter.md`, `docs/agents/herald.md` — per-agent specs
- `docs/03-scheduling.md` §5 — UTC/EST/EDT cron translation table
- Context7 `/llmstxt/developers_cloudflare_workers_llms-full_txt` — DO alarm API, Queue consumer config [VERIFIED: Context7]
- `docs.ntfy.sh/publish/` — ntfy.sh HTTP POST contract, action buttons, priority headers [CITED: docs.ntfy.sh/publish/]
- `.planning/phases/02-weekly-value/02-CONTEXT.md` — locked decisions D2-01 through D2-15

### Secondary (MEDIUM confidence)

- npm registry: `rss-parser@3.13.0`, `cheerio@1.2.0` current versions [VERIFIED: npm registry 2026-06-05]
- slopcheck verification: `rss-parser` [OK], `cheerio` [OK], `agents` [OK], all pinned deps [OK]

### Tertiary (LOW confidence — flagged)

- A1 (Assumptions Log): Workers Free plan cron limit per Worker count — not verified against current Cloudflare pricing page; [ASSUMED]

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified against installed package.json (4.4.3 zod, 0.14.1 agents, 0.16.13 vitest-pool-workers), npm registry for new deps, slopcheck all OK
- Architecture: HIGH — derived from SPEC-CANON + living code; all topology decisions locked in CONTEXT.md
- Pitfalls: HIGH — drawn from Phase-0/1 accumulated context (STATE.md decisions log) + Cloudflare DO/Queue official docs
- Ntfy integration: HIGH — verified against official docs.ntfy.sh/publish/ 2026-06-05
- Cron limit: LOW — not verified for current Cloudflare Free plan; flagged as assumption A1

**Research date:** 2026-06-05
**Valid until:** 2026-07-05 (30 days; Cloudflare SDK versions move weekly — re-verify `agents` version before install)
