# 06 — Hosting: Cloudflare + MCP

**Purpose:** Map every Atlas hosting and connectivity need to a specific Cloudflare primitive, and define how agents reach the outside world (Gmail, Calendar, Drive, Sheets, GitHub, Obsidian) over remote MCP — including the cloud-vs-local split for **Echo** and **Quill**.

## At a glance

| | |
|---|---|
| **Compute** | Cloudflare **Workers** (stateless agents) + **Durable Objects** (stateful / one DO per agent) |
| **Scheduling** | **Cron Triggers** (the §10 schedule) + **Workflows** (durable multi-step runs) |
| **Event bus** | **Queues** — *the Wire*; serializes all writes into **Steward** |
| **State** | **D1** (tasks/jobs/events/run-log) · **KV** (config/flags) · **R2** (audio blobs, exports) · **DO** (per-agent live state) |
| **Model access** | **Workers AI** + **AI Gateway** (cache, rate-limit, observability); Claude via AI Gateway |
| **Outbound MCP** | Remote MCP servers on Workers (**Cloudflare Agents SDK**) → Google / GitHub / Obsidian |
| **Inbound auth** | **Workers OAuth Provider** (owner authorizes Atlas once) |
| **Secrets** | **Secrets Store** + Wrangler secrets; per-agent least privilege |
| **Local daemon** | **Echo** (audio) + **Quill** (screen) — macOS launchd, pushes up to the cloud |
| **Writes-to** | Cloudflare account resources only; the Vault is written **exclusively** by [Steward](agents/steward.md) |

Related docs: [architecture](02-architecture.md) · [scheduling](03-scheduling.md) · [source-of-truth Codex](07-source-of-truth-codex.md) · [Flagger](08-flagger.md) · [security & privacy](11-security-privacy.md) · [roadmap](12-roadmap.md).

---

## 1. Need → primitive map

Every line of SPEC §7, made concrete. This is the canonical lookup table — start here.

| Need | Cloudflare primitive | Why this one |
|------|----------------------|--------------|
| Run a stateless agent pass (Filer label, Herald digest) | **Worker** | Cheap, per-request, scales to zero |
| Per-agent live state + coordination (one instance per agent) | **Durable Object** | Single-threaded, strongly consistent, addressable by name |
| Echo's live audio stream | **Durable Object + WebSocket** | Long-lived bidirectional connection, sticky to one DO |
| Fire agents on the §10 clock | **Cron Triggers** | Native to Workers; one cron expr per schedule line |
| Durable multi-step pipeline (the morning chain) | **Workflows** | Survives restarts, retries each step, no manual checkpointing |
| The Wire (event bus) + Steward serialization | **Queues** | Single-consumer = serialized writes; built-in retry + DLQ |
| Structured state: tasks, jobs, events, run-log, audit log | **D1** (SQLite) | Relational, queryable, the system-of-record for counters |
| Config, feature flags, label-color map, OAuth state | **KV** | Eventually-consistent, read-hot, low-write |
| Audio blobs (Echo), exports, attachments | **R2** | Object storage, zero egress fees, S3 API |
| Model calls (orchestration, Filer high-volume passes) | **Workers AI** + **AI Gateway** | Gateway adds cache / rate-limit / logs; AI binds models |
| Reach Gmail/Calendar/Drive/Sheets/GitHub/Obsidian as tools | **Remote MCP servers on Workers** (Agents SDK) | One MCP server per provider, hosted at the edge |
| Owner authorizes Atlas to act on their behalf | **Workers OAuth Provider** (inbound) | Atlas becomes an OAuth-protected MCP host |
| Store Google/GitHub tokens, signing keys | **Secrets Store** + Wrangler secrets | Encrypted at rest, per-binding, never in Vault/Codex |
| Audio + screen capture (Echo, Quill) | **Local macOS daemon** (launchd) | Cloudflare has no mic/screen; OS access required |

> **Design pillar enforced here:** *one writer per resource.* Queues' single-consumer guarantee is what makes Steward the sole serialized Vault writer — see [Steward](agents/steward.md) and SPEC §6.4.

---

## 2. Component diagram

```
                                  ┌──────────────────────────────────────────┐
                                  │            CLOUDFLARE ACCOUNT             │
                                  │                                          │
   Cron Triggers (§10) ──────────▶│  ┌────────┐   schedules / routes          │
   07:45 Filer · 08:00 Herald     │  │ ATLAS  │◀──── supervises every agent   │
   08:15 Forge · 08:30 Compass    │  │ (DO)   │                               │
   Mon 09:00 Headhunter …         │  └───┬────┘                               │
                                  │      │ enqueue                            │
                                  │      ▼                                    │
   Gmail push ──▶ Filer Worker ───┼─▶ ┌──────────────┐  the Wire             │
                                  │   │  QUEUES      │  (single consumer)     │
   Herald·Forge·Sundial·Compass ──┼─▶ │  "the Wire"  │──────┐                 │
   Scout·Headhunter·Usher·Envoy ──┼─▶ └──────────────┘      │                 │
   Flagger ───────────────────────┼─────────────────────────┤                 │
                                  │                          ▼                 │
                                  │                   ┌────────────┐           │
                                  │                   │  STEWARD   │ sole      │
                                  │                   │  (DO,      │ serialized│
                                  │                   │  consumer) │ writer    │
                                  │                   └─────┬──────┘           │
                                  │   ┌─────┐ ┌────┐ ┌────┐ │   MCP (Obsidian) │
                                  │   │ D1  │ │ KV │ │ R2 │ │        │         │
                                  │   └─────┘ └────┘ └────┘ │        │         │
                                  │   Workflows (morning chain, durable steps) │
                                  │                         │        │         │
                                  │   ┌─────────────────────┴──────┐ │         │
                                  │   │  Workers AI + AI Gateway   │ │         │
                                  │   │  (Claude: Opus / Sonnet /  │ │         │
                                  │   │   Haiku, cached + logged)  │ │         │
                                  │   └────────────────────────────┘ │         │
                                  │                                  │         │
                                  │   ┌──────────────  REMOTE MCP SERVERS  ───┴──────┐
                                  │   │ Agents SDK on Workers, OAuth-protected      ││
                                  │   │  • Google MCP (Gmail/Cal/Drive/Sheets)      ││
                                  │   │  • GitHub MCP (GitHub App)                  ││
                                  │   │  • Obsidian MCP  ◀── bridges to local Vault ││
                                  │   └──────────┬───────────────┬─────────────────┘│
                                  │              │               │ Secrets Store     │
                                  └──────────────┼───────────────┼───────────────────┘
                                                 │               │
            Workers OAuth Provider (inbound) ◀── owner authorizes once
                                                 │               │
                          ┌──────────────────────┘               │
                          ▼                                       ▼
              ┌───────────────────────┐               ┌───────────────────────┐
              │  Google / GitHub APIs │               │   LOCAL macOS DAEMON  │
              └───────────────────────┘               │   (launchd / menubar) │
                                                       │  • ECHO  (audio I/O)  │
                                                       │  • QUILL (screen)     │
                                                       │  • Obsidian Vault     │
                                                       └───────────┬───────────┘
                                                                   │ transcripts → R2
                                                                   │ results  → the Wire
                                                                   ▼
                                                            (mTLS / OAuth up)
```

---

## 3. Compute: Workers + Durable Objects

- **Stateless passes → Workers.** Agents that take input, call a model/MCP, and emit an event are plain Workers: **Filer** (label a batch), **Herald** (build a digest), **Forge** (extract tasks), **Scout** (events digest). They hold no state between invocations.
- **Stateful agents → one Durable Object instance per agent.** A DO gives each agent a single, consistent, addressable home for live state and coordination locks. **Atlas** (the orchestrator) and **Steward** (the serialized writer) are the primary DOs; any agent needing a lock or in-flight cursor (e.g. Headhunter's board-scan position) gets one.
- **Echo → DO + WebSocket.** [Echo](agents/echo.md) is the exception that also has a cloud half: the local daemon streams audio frames to a Durable Object over a WebSocket so the live transcript has a single sticky home. The DO buffers to **R2** and notifies **Archivist** when the meeting ends.

| Agent | Cloud shape | Notes |
|-------|-------------|-------|
| **Atlas** | DO (always-on supervisor) | Owns schedules + the Wire; routes and sequences |
| **Filer** | Worker | Gmail push + 07:45 sweep; batched, backs off (SPEC §5.8) |
| **Herald** | Worker | `daily` + `weekly` modes, one codebase |
| **Forge** | Worker | After Herald + on-demand |
| **Sundial** | Worker | After Forge → Google Calendar MCP |
| **Compass** | Worker | 08:30 plan + 21:00 preview |
| **Scout** | Worker | Fri 16:00 |
| **Usher** | Worker + browser | On-demand; gated (registration/payment) |
| **Headhunter** | Worker (+ DO cursor) | Mon 09:00 full + daily-light |
| **Echo** | **Local daemon** + cloud DO/WebSocket | Audio never leaves device except approved artifacts |
| **Archivist** | Worker (+ Workflow) | After Echo transcript ready |
| **Steward** | **DO** (queue consumer) | Sole Vault writer, serialized |
| **Quill** | **Local daemon** | Screen autofill; writes the active local document |
| **Envoy** | Worker + browser | On-demand; gated (public posts irreversible) |
| **Switchboard** | Worker | Design-time only; recommendations |
| **Flagger** | Worker | Event-driven from all agents |
| **Librarian** | Worker | On-demand prompt capture |

---

## 4. Scheduling: Cron Triggers + Workflows

**Cron Triggers** fire the §10 schedule. Each schedule line is one cron expression in `wrangler.toml` routed to the right agent. Times in SPEC §10 are owner-local; configure crons in UTC and translate (account for DST), or pin the account TZ.

Representative mapping (full table in [scheduling](03-scheduling.md)):

| §10 line | Trigger | Agent / mode |
|----------|---------|--------------|
| 07:45 daily | cron | **Filer** sweep (pre-Herald) |
| 08:00 daily | cron | **Herald** `daily` |
| 08:15 daily | cron | **Forge** morning |
| 08:20 daily | cron | **Sundial** sync |
| 08:30 daily | cron | **Compass** plan |
| 21:00 daily | cron | **Compass** preview |
| 09:00 daily (light) | cron | **Headhunter** deadlines |
| Mon 09:00 | cron | **Headhunter** full |
| Fri 16:00 | cron | **Scout** weekly + **Herald** `weekly` (parallel) |
| Fri 16:30 | cron | weekly-review build (Steward compiles) |
| continuous | Gmail push | **Filer** event |

**Workflows** run the durable, multi-step pieces so a mid-chain failure resumes instead of restarting:

- **Morning chain** (Filer → Herald → Forge → Sundial → Compass) is **strictly sequential** (start-after-success). A Workflow models each agent as a step with automatic retry; if Sundial fails, the run resumes at Sundial, not at Filer.
- **Archivist** post-meeting processing (fetch transcript → structure notes → emit to Steward) is a short Workflow so a transient MCP error doesn't drop the notes.

> **Cron fires the chain; the Workflow guarantees it completes.** Cron is the *when*, Workflow is the *durably*.

---

## 5. The Wire + Steward serialization (Queues)

The **Wire** is a Cloudflare **Queue**. Every agent that wants the dashboard updated **produces** an event; **Steward** is the **single consumer**.

- **Producers (fan-in):** Usher, Headhunter, Scout, Envoy, Forge, Compass, Flagger (SPEC §4). Steward **fetches nothing** — owner's explicit requirement.
- **Consumer:** Steward, one at a time. Single-consumer concurrency = serialized writes = no Obsidian file conflicts.
- **Event shape** (SPEC §6.4 — copy exactly):

  ```json
  { "agent": "...", "type": "...", "entity": "...",
    "op": "increment | upsert | append",
    "payload": { },
    "idempotencyKey": "..." }
  ```

- **Idempotency:** counters move via `op: "increment"` keyed by `idempotencyKey`, so a Queue redelivery (at-least-once) can't double-count. Steward records seen keys (in **D1**/DO state) and drops replays.
- **Failures:** Queues retry with backoff; poisoned messages land in a **dead-letter queue**, which raises a **Flagger** event (`P2 High`, see [Flagger](08-flagger.md)).

Flag/incident events (SPEC §8) also ride the Wire to reach the Vault feed; `P1/P2` additionally fire a push notification out-of-band.

---

## 6. State: D1 / KV / R2 / Durable Objects

| Store | Holds | Accessed by |
|-------|-------|-------------|
| **D1** (SQLite) | Tasks, jobs funnel, events, run-log, audit log, idempotency keys | Forge, Sundial, Headhunter, Compass, Steward, Flagger |
| **KV** | Config, feature flags, label→color map, OAuth/PKCE state, per-agent toggles | All agents (read-hot) |
| **R2** | Echo audio blobs, exports, large attachments | Echo (DO writes), Archivist, Steward exports |
| **Durable Objects** | Per-agent live state + locks; Echo's live transcript buffer | Atlas, Steward, Echo, any agent needing a lock/cursor |

Rules:
- **D1 is the system-of-record for counters**; the Vault renders a *view* of them. Source numbers reconcile against D1, so the Vault is reproducible.
- **R2 audio is sensitive** (SPEC §12): raw audio is local-first; only the derived transcript/artifact the owner approves is retained in R2, with lifecycle expiry on raw blobs.
- **KV never holds secrets** — those live in Secrets Store (§9).

---

## 7. Model access: Workers AI + AI Gateway

- All model calls route through **AI Gateway** for caching, rate-limiting, retries, and unified logs/observability.
- **Workers AI** binding for on-platform models; **Claude via AI Gateway** for the reasoning-heavy work.
- **Model tiering** (SPEC §7): default to the latest Claude — **Opus** for orchestration/reasoning (Atlas, Compass, Archivist), **Sonnet/Haiku** for cheap high-volume passes (**Filer** labeling, Headhunter board scans). Pick the model per agent in config, not in code.
- **Why the Gateway matters here:** Filer runs continuously on Gmail push; caching identical prompts and capping spend per agent is what keeps a continuous labeler affordable, and the logs feed [Flagger](08-flagger.md) when error rates spike.

---

## 8. Remote MCP servers on Workers (Agents SDK)

Each external provider is a **remote MCP server hosted on a Worker** using the **Cloudflare Agents SDK**. Agents call tools over MCP; the MCP server holds the provider credentials and enforces scope.

### 8.1 Google MCP (Gmail / Calendar / Drive / Sheets) — OAuth2, least privilege

One Google OAuth2 client; **least-privilege scopes** requested per capability (SPEC §12). Map each consumer to the *minimum* scope:

| Capability | Scope | Consumer | Why this is the floor |
|------------|-------|----------|------------------------|
| Read mail + **labels only** | `gmail.modify` | **Filer**, **Herald** | `modify` = read + label; **never** `gmail` full or delete (SPEC §5.8, §12) |
| Read/write calendar events | `calendar.events` | **Sundial**, **Compass**, **Usher** | Event-level, not full calendar admin |
| Read calendar (planning) | `calendar.readonly` | **Compass** (read leg) | Read-only where it only reads |
| Files Atlas creates (exports) | `drive.file` | **Steward** exports, **Archivist** | App-scoped; not whole-Drive `drive` |
| Read specific docs (the Codex) | `drive.readonly` | **Quill**, **Envoy**, **Archivist** | Read-only profile/context |
| Sheets data (trackers) | `spreadsheets` | **Headhunter**, **Steward** | Only if a tracker lives in Sheets |

- **Filer must never get delete/archive scope.** It labels only (SPEC §5.1–§5.8). `gmail.modify` covers labels and explicitly excludes permanent delete.
- **Token storage:** Google refresh/access tokens in **Secrets Store**; per-agent the MCP server narrows to that agent's allowed scope set.
- **Phishing/security mail:** the Google MCP never resolves links and never returns 2FA codes / reset link bodies in tool output (SPEC §5.8) — enforced server-side so no agent can leak them.

### 8.2 GitHub MCP — GitHub App

- Connect via a **GitHub App** (not a personal token): scoped installation permissions, revocable, per-repo.
- Consumers: **Envoy** (brand sync — repos/profile), **Headhunter**/Forge for `Type/Dev` signals if needed.
- Permissions floor: read profile + read repos; **write/post is gated** behind a confirmation (SPEC §12) since Envoy actions are outward-facing.

### 8.3 Obsidian MCP — local bridge

- The Vault lives on the **local machine** (or synced). A **local MCP bridge** exposes the Vault to the cloud; **Steward** is the only client that calls its write tools.
- The bridge runs alongside the local daemon (§10) and authenticates outbound to the cloud — the cloud does not hold an open inbound port to the laptop.
- All Vault writes still funnel through the Wire → Steward → Obsidian MCP, preserving single-writer + serialization even though the file lives locally.

---

## 9. Inbound auth & secrets

- **Workers OAuth Provider** makes Atlas an OAuth-protected MCP host: the owner authorizes Atlas **once**, and remote MCP clients (and the local daemon) present tokens to reach it. This is the front door.
- **Outbound provider credentials** (Google refresh tokens, GitHub App private key/installation tokens) live in **Secrets Store**, bound per-Worker; high-churn or legacy secrets via **Wrangler secrets**.
- **Per-agent least privilege:** each MCP server only mounts the secret + scope set its callers need. Filer's binding cannot reach delete scope; Quill's binding cannot reach Calendar write.
- **Never in the Vault or the Codex** (SPEC §12). The Codex holds personal *facts* for autofill, not credentials.
- **Audit log** of every agent action lands in **D1** and surfaces via [Flagger](08-flagger.md).

---

## 10. Local-daemon split: Echo + Quill

Cloudflare has no microphone and no screen, so two agents run on the physical Mac (SPEC §7, §12):

| | **Echo** (audio) | **Quill** (screen autofill) |
|---|---|---|
| Runtime | **Local** macOS daemon (launchd / menubar) | **Local** macOS daemon |
| Captures | All audio I/O devices → transcript | Active document / form fields on screen |
| Reads | — | **The Codex** (field map: `first name`→Daniel, `last name`→Chahine, …) |
| Cloud half | DO + WebSocket buffer; blobs → **R2**; notify **Archivist** | None required; acts locally |
| Leaves device? | Only the derived transcript the owner approves | Nothing — fills the local document in place |
| Auth | Daemon authenticates **outbound** to the cloud (Workers OAuth Provider) | Same outbound auth for Codex reads |

Principles (SPEC §1, §12):
- **Local-only sensitive capture:** raw audio and screen contents never leave the device except as derived artifacts the owner explicitly approves.
- **Outbound-only:** the daemon dials the cloud; the cloud never opens an inbound connection to the laptop.
- **Echo runs in parallel with everything** (real-time); a daemon crash flags itself to **Flagger** (heartbeat goes stale → `P2`).

---

## 11. Connect a new MCP — checklist

Use this when adding any new external capability. Consult **Switchboard** first (it recommends the right MCP/tools for a need at design time; it does **not** run in the loop).

1. **Pick the primitive.** Cross-reference §1: is this a Worker tool, a DO, a new Queue producer, new D1/KV/R2 state? Most new providers = one new **remote MCP server on a Worker**.
2. **Define least-privilege scope.** Write down the *minimum* scope and which agent(s) consume it (mirror the §8.1 table). Default to read-only.
3. **Provision the credential.** Create the OAuth client / GitHub App / API key; store the secret in **Secrets Store** (never KV, never the Vault/Codex).
4. **Stand up the MCP server.** New Worker using the **Agents SDK**; mount only that agent's secret + scope set. Enforce content rules server-side (e.g. never emit 2FA codes / phishing links per SPEC §5.8).
5. **Wire inbound auth.** Register the server with the **Workers OAuth Provider** so consuming agents authenticate; bind the secret per-Worker.
6. **Gate destructive/outward tools.** Any delete/post/register/pay tool is **draft-and-ask** (SPEC §1 pillar 2, §12) — no silent execution.
7. **Make it idempotent + observable.** Tool side-effects carry an `idempotencyKey`; dashboard effects emit a Wire event (§5 shape); errors raise a **Flagger** event with severity + trust (SPEC §8).
8. **Confirm single-writer.** If it mutates an external resource, exactly **one** agent may write it (SPEC §1 pillar 1). The Vault stays Steward-only.
9. **Schedule it.** Add the Cron Trigger / Workflow step to [scheduling](03-scheduling.md) and the §10 table; respect concurrency rules (morning chain sequential, Steward serialized).
10. **Local vs cloud.** If it needs mic/screen/OS access → it belongs in the **local daemon** (like Echo/Quill), authenticating outbound. Otherwise it's a Worker.

---

## 12. Open questions

- **Cron timezone vs DST:** owner-local §10 times need a DST-aware translation to UTC cron, or a pinned account TZ — pick one and document it.
- **D1 ↔ Vault reconciliation:** if the Vault is edited by hand, do counters re-derive from D1 on the next weekly-review build, or is the Vault authoritative for manual edits?
- **R2 audio retention:** exact lifecycle / expiry window for raw Echo blobs before only the transcript remains.
- **Local daemon transport:** mTLS vs OAuth-bearer for the daemon's outbound channel, and how the heartbeat staleness threshold maps to a Flagger severity.
- **Workers AI vs Anthropic direct:** which agents (if any) use on-platform Workers AI models vs Claude-via-Gateway, and the per-agent cost ceiling enforced at the Gateway.
