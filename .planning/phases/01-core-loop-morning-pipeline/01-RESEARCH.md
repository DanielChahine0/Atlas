# Phase 1: Core Loop / Morning Pipeline — Research

**Researched:** 2026-06-05
**Phase goal:** Deliver the strictly-sequential morning chain Filer → Herald → Forge → Sundial → Compass as ONE Cloudflare Workflow off a single 07:45 cron, feeding Steward → the Vault.
**Primary build reference:** `docs/13-build-plan.md §3` (per-agent task breakdown + Morning Workflow wiring). `docs/SPEC-CANON.md` wins all conflicts.

> This phase is **frontend-free**. The only "UI" is Obsidian markdown that Steward (Phase 0, unchanged) renders from Wire events; `docs/05-dashboard.md` is the rendering contract. No web UI, no UI-SPEC.

---

## Summary

Phase 0 already shipped the spine: the Atlas Worker (`scheduled()` dispatcher + OAuthProvider front door), the `atlas-wire` Queue + DLQ, the `StewardWriter` DO (sole serialized Vault writer + sole consumer), D1 (`0001_init_core.sql`: idempotency_keys / counters / run_log / audit_log / vault_outbox), the `mcp-google` MCP (Filer label tools + `safeToolOutput()` redaction egress + scope-floor enforcement), and the shared packages (`@atlas/wire`, `@atlas/model` `claudeFor`/`modelFor`, `@atlas/codex`, `@atlas/shared` `flag`/`runlog`/`localDate`, `@atlas/steward-core`).

Phase 1 adds **five new stateless agent Workers** (`apps/filer|herald|forge|sundial|compass`), **one D1 migration** (`tasks`/`subtasks` + `idx_tasks_dedupe`), **new MCP tools** on `mcp-google` (Herald draft+read, Forge read, Sundial `calendar.events`, Compass `calendar.readonly`), and **the `MorningChain` Workflow** bound to the Atlas Worker plus the 07:45 cron case in the dispatcher. **No new Vault writer** — Steward stays the sole `atlas-wire` consumer (Pillar 1; a second consumer is a hard CI failure).

The single biggest decision (already locked in CONTEXT D1 + build-plan §3): **one cron kicks one Workflow with five `await`ed `step.do` steps**, NOT five racing crons. `await` gives start-after-success; step memoization gives resume-on-failure; an exhausted-retry step `errored`s the instance and halts downstream; `instance.id = morning-${date}` is the idempotency handle (re-fire = no-op).

---

## Architectural Responsibility Map

Each capability is owned by exactly one tier. Plan tasks MUST place work in the owning tier (the plan-checker enforces this; security-sensitive misplacements are blockers).

| Capability | Owning tier | Why / boundary |
|---|---|---|
| Schedule the morning run (WHEN) | Atlas `scheduled()` dispatcher cron case `45 11 * * 1-5` | Cron is the trigger only; it creates the Workflow instance and returns. |
| Durable sequencing (HOW), retry/timeout, halt-downstream, resume | `MorningChain` Workflow (bound `MORNING_CHAIN`, class `MorningChain extends WorkflowEntrypoint`, on the Atlas Worker) | `await`ed `step.do`; `step.sleepUntil` budget gates; `NonRetryableError` from `cloudflare:workflows`. |
| Per-step agent invocation transport | `invokeAgent(env, "<codename>", params)` over **service-binding RPC** (Phase-0 D-11, same shape as `env.NOOP.tick`) | Worker-to-Worker RPC, no public HTTP; each agent is a `WorkerEntrypoint`. |
| Gmail **labels** (the only Gmail mutation) | Filer (`apps/filer`) via `mcp-google` `gmail.modify` scope | No delete/archive tool registered; delete path needs never-granted `mail.google.com/`. |
| Gmail **read + draft-create** (no send, no modify) | Herald (`apps/herald`) via `mcp-google` `gmail.readonly` + `gmail.compose` | Herald never labels, never sends. |
| Task/subtask system-of-record + dedupe + counters | Forge (`apps/forge`) → **D1** (`tasks`/`subtasks`, `idx_tasks_dedupe`) | NEVER KV (1 write/s/key + 60s lag). DO lock around the dedupe critical section. |
| Calendar **event create/update** (deadline blocks) | Sundial (`apps/sundial`) via `mcp-google` `calendar.events` | No `delete_event` on the autonomous path; reconcile by `atlasTaskId` extendedProperty. |
| Calendar **read-only** + day-plan synthesis | Compass (`apps/compass`) via `mcp-google` `calendar.readonly` + D1 read | Compass NEVER writes the calendar (one-writer rule; Sundial/Usher own it). |
| Server-side secret redaction (2FA/reset/login) | `mcp-google` `safeToolOutput()` (Phase 0, unchanged) + Herald digest-builder guardrail (new) + CI test | Defense-in-depth; a prompt instruction alone is NOT sufficient. |
| Apply Wire events → D1 + Vault projection | Steward (Phase 0, **unchanged**) | Sole consumer, sole Vault writer; idempotent dedup on `idempotencyKey`. |
| Emit Wire events | every Phase-1 agent via `@atlas/wire` `send(env, event)` | Never hand-build the envelope; `send()` parses-then-sends. |

---

## Standard stack & analog files (build against these — do NOT hand-roll)

| New code | Closest existing analog (read first) | What to reuse |
|---|---|---|
| `apps/filer/src/*` (WorkerEntrypoint + sweep) | `apps/atlas/src/noop-agent.ts` (RPC entrypoint shape), `apps/mcp-google/src/index.ts` (tool/scope pattern) | `WorkerEntrypoint<Env>` + a public `run`/`sweep` RPC method; call `mcp-google` label tools. |
| `apps/herald|forge|sundial|compass/src/*` | same as above + `packages/model/src/claude.ts` (`claudeFor`), `packages/codex/src/codex.ts` (`read`/`codexSystemBlock`) | per-agent Claude via `claudeFor(agent, env)`; Codex context as a cached `system` block. |
| `MorningChain` Workflow | build-plan §3 wiring snippet (lines 913-949); `apps/atlas/src/index.ts` dispatcher switch | `WorkflowEntrypoint`/`WorkflowStep` from `cloudflare:workers`; `NonRetryableError` from `cloudflare:workflows` (different module — CLAUDE.md gotcha). |
| Wire emit (all agents) | `packages/shared/src/flag.ts` (a `send()` caller), `apps/atlas/src/index.ts` `send(...)` call | `import { send } from "@atlas/wire"`; canonical §6.4 envelope; structured idempotencyKey. |
| New MCP tools (Herald/Forge/Sundial/Compass) | `apps/mcp-google/src/index.ts` (`registerTool` + `grantedScopes()`/scope-floor + `safeToolOutput`) | one scope-floor predicate per scope; every output funnels `safeToolOutput()`. |
| `tasks`/`subtasks` migration | `migrations/0001_init_core.sql` | positional `?` only; idempotency keys forever; counters absolute. |
| Steward event payloads | `apps/steward/src/*` + `packages/steward-core/src/{apply,op-mapping}.ts` | `increment` payload `{counter, delta}`; `upsert` payload `{note, field, ...}`. Steward is unchanged — Phase 1 just emits events it already handles. |
| The three required tests per agent | `apps/steward/test/replay.test.ts`, `apps/mcp-google/test/{scope,redact}.test.ts` | Wire-contract test, replay-through-Steward test (`meta.changes===0`), failure-path Flagger-severity test (CLAUDE.md Definition of Done). |

**Pinned versions (CLAUDE.md — verified surface in Phase-0 code):** `agents@^0.14.x` (needs `compatibility_flags:["nodejs_compat"]`), `@modelcontextprotocol/sdk@1.29.0` (`registerTool()`), `@anthropic-ai/sdk` latest, `zod@^3.25||^4.0` (use `z.record(z.string(), z.unknown())` — the 2-arg form), `wrangler` v4.x, `compatibility_date: 2026-04-25`. Model ids: Filer→`claude-haiku-4-5`, Herald/Forge→`claude-sonnet-4-6`, Compass→`claude-opus-4-8`. Sundial uses NO model (deterministic mapping).

---

## Per-agent task breakdown (from build-plan §3 — authoritative)

### Filer (`apps/filer`) — Gmail labeler, `gmail.modify` ONLY
- Workflow step `filer-sweep` (kicked by 07:45 cron); continuous Gmail-push path; 06:00 `users.watch` renewal cron.
- Tasks: (1) bootstrap taxonomy (diff vs `docs/04`, `create_label` parent-before-child, palette-valid colors); (2) continuous push (`users.watch`→Pub/Sub→`history.list`→debounced enqueue→advance `FilerCursor.historyId`; 404→sweep fallback) — **gated on D1-06 gateway ceilings before going live**; (3) 06:00 watch renewal (P3 if stale); (4) 07:45 sweep (`search_threads("newer_than:2d -label:AI/Reviewed")`→classify(Haiku)→phishing/security guard→consistency/confidence check→`label_thread` delta only→append `AI/Reviewed` last); (5) emit `{type:"sweep.done", op:"increment", idempotencyKey:"filer:sweep:<date>"}`, return labeled summary.
- Invariants: labels-only (no delete tool bound); idempotent skip on `AI/Reviewed` (always added last); no contradictory triage labels; NEVER surface 2FA/reset/login (`Type/Security` + `⚠ Phishing-Suspect` read-and-label only, no `Needs/*`/`Suggest/*` on a phish); Gmail backoff-with-jitter on 429 AND 403 rateLimitExceeded.

### Herald (`apps/herald`) — daily digest, read + draft only
- Workflow step `herald-daily`, `step.sleepUntil(08:00)`, runs on `filer-sweep` success. **Daily only Mon-Fri, no Friday special-casing (D1-02); weekly is Phase 2.**
- Tasks: (1) pull labeled threads in 24h window (DO state holds last-run ts; window math via `Intl`/`America/Toronto`); (2) bucket into the five owner sections in order: Important · Action Required · Action Recommended · Advertisement · Other (`Type/Newsletter`→Other, only `Type/Promotion`→Advertisement); (3) **redact security mail** then rank (`Due/Today`→`Due/ThisWeek`→`From/VIP`→rest); (4) synthesize body, **create Gmail draft** to `chahinedaniel0@gmail.com` (subject `Atlas Digest — <day> (daily)`), never send; (5) emit `{type:"digest", op:"upsert", idempotencyKey:"herald:daily:<date>"}` + return digest/thread-refs (Forge reuses). **Keep the Gmail draft (D1-01)** plus the digest event for the Vault morning-glance.
- Security guardrail (non-negotiable, SPEC §5.8/§12): `Type/Security` listed by sender+subject only; strip code-tokens (`\b\d{4,8}\b` near code/OTP/verification) + reset/login URLs **before** synthesis output; `⚠ Phishing-Suspect` under Other with a visible warning + no clickable link; if the redaction regex trips on the **output**, **block the draft** + raise P2 High. Reuses `@atlas/security` `redact`/`containsSecret`.

### Forge (`apps/forge`) — task & subtask extractor → D1
- Workflow step `forge-morning`, runs on `herald-daily` success.
- Tasks: (1) gather+filter `① Action Required` threads with a `Needs/*`/`Due/*` label (drop `④ FYI`/`⑤ No Action`); (2) extract (Sonnet) `{title, subtasks[], priority}` (short imperative titles); (3) deadline inference → `due`+`due_kind` (explicit|inferred|none; `Due/ThisWeek`→Fri 17:00, `Job/OA`→+5d, "EOD"→23:59 owner-local; past-due kept + `priority≥P2` + P3); (4) dedupe via `dedupe_key = sha256(thread+normalizedTitle+dueDate)` against D1 unique `idx_tasks_dedupe` (same-source hit→no-op; other-channel hit→merge union subtasks/earliest due/max priority/`upsert`; miss→insert+`increment`; `locked_by_owner`→short-circuit); (5) write inside the DO lock, emit one event per new/changed task `{type:"task", op:"increment"|"upsert", idempotencyKey:<task id>}`.
- Invariants: creates tasks only (never Gmail/Vault/registration); **security skip** (never copy a 2FA code/reset link into a title/subtask; a `⚠ Phishing-Suspect` thread → do not extract, raise P2 High); D1 not KV; never mutate `event.payload` inside the step (return state forward).

### Sundial (`apps/sundial`) — task → Google Calendar deadline blocks
- Workflow step `sundial-sync`, runs on `forge-morning` success; on-demand re-fire is idempotent. **No model.**
- Tasks: (1) read deadline tasks from D1 (`due IS NOT NULL AND status='open'`; undated→skip); (2) list the window once (`events.list(primary, timeMin=now, timeMax=now+60d, singleEvents:true, privateExtendedProperty:["agent=sundial"])` — reads only its own blocks); (3) map→block (date-only→all-day end **exclusive**; datetime→timed ending at `due`; stamp `extendedProperties.private={atlasTaskId, agent:"sundial", syncedDue, contentHash}`); (4) reconcile per task keyed on `atlasTaskId` (no match→`create_event`; `contentHash` drift→`events.patch` re-asserting the full reminder set; identical→skip); (5) emit `{type:"calendar.sync", op:"upsert", idempotencyKey:"sundial-<date>"}`.
- Invariants: no autonomous delete (orphan blocks → gated proposed-removal via Steward); never touch foreign events; idempotent reminders (re-assert full overrides, `useDefault:false`, ≤5, `minutes≥0`); insert-race guard (list-before-create; dup `atlasTaskId`→keep earliest, propose removal gated, flag P2).

### Compass (`apps/compass`) — daily planner (last stage)
- Workflow step `compass-plan`, runs on `sundial-sync` success (08:30); independent `preview` cron `0 1 * * *` EDT (21:00 owner-local).
- Tasks: (1) read tasks + calendar; score by deadline distance + triage tier + `From/VIP` bump + `Needs/*` (overdue never buried); (2) build free/busy grid from Codex working hours (default 09:00-18:00) minus events, `meeting_buffer_min`(10), `min_block_min`(25); (3) merge: bin-pack ranked tasks into earliest fitting gaps; (4) overcommitment check (`demand>free`→pack by priority, overflow→visible "⚠ Couldn't fit today", mark `Due/Today`/`Due/Expired` at-risk, raise P3 high-trust + `suggested_action`; never reschedule a calendar event); (5) render+emit `{type:"day_plan", op:"upsert", idempotencyKey:"compass:plan:<date>"}`.
- **Opus `effort`=`medium`, KV-overridable via `compass.effort` (D1-05)** — never ship `high` as the daily default. Invariants: read-only on calendar; degrade-don't-skip (if Sundial unfinished, plan against last-known calendar, flag P3, mark plan stale); deterministic idempotency (`compass:plan:<date>` upserts, never appends).

### Morning Workflow wiring (the crux)
- `wrangler.jsonc` additions to the Atlas Worker: `"workflows":[{name:"atlas-morning-chain", binding:"MORNING_CHAIN", class_name:"MorningChain"}]` + `"triggers":{"crons":["45 11 * * 1-5"]}` (EDT; re-derive at DST boundary — staging keeps `crons:[]`).
- Dispatcher case `45 11 * * 1-5`: derive owner-local `date` via `Intl`, `env.MORNING_CHAIN.create({id:\`morning-${date}\`, params:{date, tz:"America/Toronto"}})`.
- Workflow: five `await`ed `step.do` calls with `step.sleepUntil` budget gates (08:00/08:15/08:20/08:30 via a DST-safe `localTime(date,"HH:MM",tz)` helper). Retry policy: Filer `limit:5`, others `limit:3`, all `timeout:"10 minutes"` (KV-overridable per Claude's-discretion). Each step calls `invokeAgent` and passes the prior step's return forward (never mutate `event.payload`).
- Halt→Flagger: an `errored`/halted instance emits `{agent:"Atlas", type:"chain.halted", op:"increment", payload:{step,attempt,error}, idempotencyKey:"morning-halt:<date>:<step>"}` at **P2 High** via `flag()`. A missed cron is NOT auto-replayed — idempotency lets the next run catch up.
- Emit-to-Steward table (build-plan §3): Filer `sweep.done`/`increment`/`filer:sweep:<date>`; Herald `digest`/`upsert`/`herald:daily:<date>`; Forge `task`/`increment`|`upsert`/`<task id>`; Sundial `calendar.sync`/`upsert`/`sundial-<date>`; Compass `day_plan`/`upsert`/`compass:plan:<date>`.

---

## Measurement & go-live commitments (CONTEXT decisions — must be planned)

- **D1-03** — One-week pre-launch baseline (committed owner gate before M1 go-live). Plan a lightweight capture artifact (a Vault checklist note Steward can render, or a markdown template under `Dashboard/`) for logging current inbox-triage + day-planning minutes ~5 working days. "Baseline captured" is a go-live gate.
- **D1-04** — Daily ~1-min "did Atlas miss anything?" review (committed). Make logging a miss frictionless — a one-tap "missed" affordance in the morning glance (`Dashboard/Home.md`); ground truth for the ≥95% action-required-caught metric.
- **D1-06** — Conservative AI Gateway ceilings (`atlas-reasoning`≈$20/mo, `atlas-highvolume`≈$10/mo) set in the Cloudflare dashboard **before Filer's continuous push goes live**. This is an **owner checkpoint** (caps can't be set from code); the push path (Filer task 2) must not go live until the caps exist. The 07:45 sweep step (chain-critical) ships first and is not gated on this.
- **D1-07** — Morning-chain success-rate = rolling 30 days (instrumentation note for the run-log view; no separate counter math in Phase 1 beyond recording each run).

---

## Validation Architecture (Nyquist — every task carries an automated verify)

Tests run in real `workerd` via Vitest + `@cloudflare/vitest-pool-workers` (CLAUDE.md). `TZ` is forced to UTC — derive owner-local dates via `Intl`. Each agent PR ships the **three Definition-of-Done tests**:

1. **Wire-contract test** — the emitted event matches the §6.4 shape and carries the exact structured `idempotencyKey` (e.g. `filer:sweep:<date>`). Fast unit test (`<1s`).
2. **Replay-through-Steward test** — apply the event twice through the real `StewardWriter` DO; assert `meta.changes===0` / counter unchanged on replay (model on `apps/steward/test/replay.test.ts`).
3. **Failure-path test** — assert the correct Flagger severity (e.g. Herald redaction-trip → P2; Forge phishing thread → P2; Filer stale watch → P3; chain halt → P2).

Cross-cutting validation:
- **Workflow crux test** — a forced Forge failure leaves Filer labels + Herald draft intact, halts before Sundial/Compass, emits one `chain.halted` P2; same-date re-fire is a no-op (instance-id collision); killing mid-`forge-morning` resumes at Forge (Filer/Herald memoized). Drive via `wrangler workflows` locally; assert step memoization + terminal status in a Vitest workflow test.
- **Security CI backstop** — a digest-builder unit test proving 2FA codes / reset links / login URLs never reach Herald's output (CLAUDE.md CI invariant), layered on the existing `mcp-google` `redact` test.
- **Single-consumer CI gate** — exactly one `atlas-wire` consumer (Steward); a Phase-1 agent that accidentally declares a `queues.consumers` block on `atlas-wire` fails the build.

Feedback latency: unit/integration tests target `<30s`; no full E2E browser suite (frontend-free). No watch-mode flags in `<automated>` commands.

---

## Common pitfalls (CLAUDE.md gotchas that bite this phase)

- `new Date()` is UTC in `workerd` — derive owner-local time via `Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto'})`. Already centralized in `@atlas/shared` `localDate`.
- `NonRetryableError` imports from `cloudflare:workflows`, NOT `cloudflare:workers`.
- Do NOT mutate `event.payload` inside a `step.do` (reverts on replay) — return state and pass it forward.
- Cron Triggers are UTC-only, no DST; hand-edit the `45 11`/`45 12` line at each DST boundary; in-Workflow waits use `step.sleepUntil` (DST-safe).
- D1 anonymous positional `?` only (no named params); counter math is absolute inside Steward's atomic `batch()`; Forge state is D1, never KV.
- `claude-opus-4-8` defaults `effort` to `high` — Compass sets `medium` explicitly (D1-05).
- Google OAuth: a granted scope does NOT authorize silent execution — but Phase-1 chain actions (label/draft/calendar-block) are the *suggest* side and are not owner-gated; only destructive/outward actions gate (none in Phase 1). Sundial's orphan-removal proposal IS gated.
- Wire message cap 128 KB — `send()` enforces it; keep digest/thread payloads to refs, not full bodies.

---

## Open Questions (RESOLVED)

1. **Herald output surface — draft vs Vault-glance-only?** — RESOLVED (D1-01): keep the Gmail draft AND emit the `digest` event for the Vault morning-glance. Do not build a second full Vault digest note.
2. **Friday special-casing in Phase 1?** — RESOLVED (D1-02): no. Daily digest runs every weekday unconditionally; the Friday weekly review is Phase 2.
3. **Compass Opus effort for the daily pass?** — RESOLVED (D1-05): `medium`, surfaced as KV `compass.effort`; never ship `high` as the daily default.
4. **Per-step retry/timeout policy?** — RESOLVED (Claude's-discretion per CONTEXT, build-plan starting policy): Filer `limit:5`, others `limit:3`, all `timeout:"10 minutes"`, all KV-overridable.
5. **`invokeAgent` transport?** — RESOLVED (Phase-0 D-11): service-binding RPC (same shape as `env.NOOP.tick`); step return shapes fixed at build time.
6. **Is the continuous Gmail push in Phase-1 scope?** — RESOLVED: yes (build-plan §3 Filer task 2), but gated on D1-06 (gateway ceilings set) before it goes live; the 07:45 sweep ships first as the chain-critical path.
7. **Does Phase 1 change Steward or add a Vault writer?** — RESOLVED: no. Steward stays the sole `atlas-wire` consumer and sole Vault writer; Phase 1 only emits events Steward already handles.
8. **Success-rate window?** — RESOLVED (D1-07): rolling 30 days.

---

## Package Legitimacy Audit

No new third-party npm packages are introduced in Phase 1. All dependencies (`agents`, `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `zod`, `jose`) were installed and audited in Phase 0 and are pinned in CLAUDE.md / the existing `package.json`. New code imports only Phase-0 workspace packages (`@atlas/*`) and already-present Cloudflare/SDK modules. No package-install tasks → no `[ASSUMED]`/`[SUS]`/`[SLOP]` packages, no legitimacy checkpoints required.
