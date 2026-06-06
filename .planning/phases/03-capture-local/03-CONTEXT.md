# Phase 3: Capture (Local) - Context

**Gathered:** 2026-06-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Atlas's **first local runtime** — a macOS daemon that captures audio and screen on the
physical machine and authenticates **outbound** to the proven cloud system. Scope is fixed by
ROADMAP.md → Phase 3 (build-plan §3 "Capture/local", milestones M4 + M5):

```
Echo (local Swift daemon, real-time) ─▶ transcript ─▶ Archivist (cloud Workflow, after meeting)
   mic + system-audio loopback → on-device STT + diarization              │
   EchoSession DO + WebSocket (Hibernation)                               ├─▶ Steward ─▶ Vault (Meeting-notes index + counters)
   raw audio → R2 audio/raw/ (7d) ONLY if owner-approved                  └─▶ Forge (owner action items → tasks)
                                                                                ▲ The Codex (work context, prior meetings)

Quill (local Swift daemon, hotkey) — read screen (AX + on-device OCR) → map labels → Codex →
   fill local form fields → review panel → STOP (never submits, never writes Vault/Wire/Codex)
```

- **Echo (#9)** — local "ears." Taps all active **input** devices (mic = Owner) + a **loopback of
  all output** devices (what the owner hears) as **separate channels**, runs **on-device** STT +
  diarization, streams `{speaker,text,start_ts,end_ts,confidence}` segments over a WebSocket to a
  per-meeting `EchoSession` DO, finalizes a diarized transcript, and hands off to Archivist. Default
  `audio.retain=local-only` — the transcript is the artifact; raw audio is uploaded to R2 only on
  explicit per-session approval. **Consent-gated, with a non-dismissable recording indicator.**
- **Archivist (#10)** — **cloud** Workflow, triggered after a meeting ends. One Opus pass structures
  the transcript into the fixed notes template (attendees / agenda / decisions / action items /
  follow-ups), threads prior meetings in the same series + Codex work context, emits one Steward
  `upsert` (note + meeting counters) and one Forge `action-item` per **owner** action item.
  Idempotent on `session_id` — re-emit never double-writes. Notes land `status: draft`.
- **Quill (#12)** — local screen autofill from the Codex. Hotkey-triggered, AX-first read with an
  on-device OCR fallback, normalizes each field label → Codex field, fills, then **stops at a review
  panel** with per-field confidence. Never clicks Submit/Apply/Send; never writes the Vault/Wire/Codex;
  refuses to autofill secrets. Per D6, Quill ships here (shared local runtime) with **no Echo data
  dependency**.

**Build the privacy boundary first, features second.** Per SPEC §12: Echo audio and Quill screen
**never leave the device except as owner-approved derived artifacts** — enforced mechanically (on-device
processing, no inbound port, R2 prefix-split lifecycle), not promised.

**Locked requirements:** CAPTURE-01 (Echo → Archivist), CAPTURE-02 (Quill) — see
`.planning/REQUIREMENTS.md`. The decisions below settle **how** to build, not **what** — scope is fixed
by ROADMAP.md.

**Gating criteria (must pass before Phase 4 / risky agents are trusted):**
- **Consent capture = 100%** — no Echo session retains a transcript without explicit per-session consent.
- The visible recording indicator is **non-dismissable while live** and proven on a real meeting.
- The daemon has **no inbound listening port** (verified: `lsof -i -nP | grep LISTEN` shows none for
  the capture app; only Obsidian's `127.0.0.1:27124` if the bridge runs on the same box).
- Raw audio/screen demonstrably never leave the device except as the approved derived artifact.
- Echo `WebSocket/DO drops mid-session` reconnects to the **same** `getByName` session DO and finalizes
  from the local buffer without losing the transcript.

</domain>

<decisions>
## Implementation Decisions

> Numbered `D3-NN` (Phase 3), continuing the project decision log (Phase 0 `D-NN`, Phase 1 `D1-NN`,
> Phase 2 `D2-NN`). Status: decided, not locked.

### Daemon shell, language & transport
- **D3-01: New native Swift menubar app for Echo + Quill; the Node Obsidian-bridge stays a separate
  launchd agent.** A SwiftUI/AppKit menubar app (`launchd`, `KeepAlive`/`RunAtLoad`) owns the native
  surfaces — Echo audio capture (Core Audio/CoreMedia), WhisperKit STT, FluidAudio diarization, Quill
  Accessibility read + value injection, on-device OCR, the **non-dismissable recording indicator**, the
  consent prompt, and the **Quill review panel** — plus its own outbound poll/drain that **reuses the
  same OAuth-bearer + macOS-Keychain + outbox pattern** the Phase-0 bridge established. The existing
  `daemon/src/drain.ts` (Obsidian bridge, 17 tests green) is **left untouched** as a second launchd
  agent. Two small, **outbound-only** agents. This satisfies the build-plan's "reuse that auth/outbox
  plumbing; do not invent a second one" (we reuse the *pattern*) without porting working Node code into
  Swift or forcing Echo/Quill's native UI into a process that can't draw it. *Rejected:* one Swift app
  that absorbs/ports the bridge (throws away the tested drainer); Node-brain + native helper CLIs (IPC +
  lifecycle complexity, and still needs a native shell for the menubar indicator + review panel).
- **D3-02: Separate OAuth clients per agent (least-privilege).** The Swift capture app registers as its
  **own** OAuth client with only Echo/Quill scopes (open the `EchoSession` WebSocket, request a transcript
  upload / R2 presign, emit Flagger incidents, read the Codex); the Node bridge keeps its existing
  vault-drain-only client. A leaked capture token cannot touch the Vault outbox and vice-versa — matches
  the least-privilege posture used everywhere else. Adds **one more token** to the Secrets-Store/Keychain
  seed. *Rejected:* one shared "daemon" token with the union of scopes (widens blast radius).
- **D3-03: Developer ID-signed + notarized.** Sign the Swift app with an Apple **Developer ID** cert
  ($99/yr Apple Developer account) and notarize it, so macOS **TCC** grants (Microphone, Screen
  Recording, Accessibility, audio capture) **persist across rebuilds** and the OS prompts read correctly.
  Worth it for the highest-permission app in Atlas, rebuilt often during the phase. *Rejected:* ad-hoc /
  self-signed (TCC grants can reset on each rebuild → constant re-granting on the exact surfaces this
  phase must prove).

### Echo capture stack
- **D3-04: System-audio loopback via Core Audio process taps — no virtual device.** Use
  `AudioHardwareCreateProcessTap` (macOS 14.4+; owner is on macOS 26 / Darwin 25.4) to tap all system
  output into an aggregate device. **No third-party driver install, no routing setup.** Gated by an
  `NSAudioCaptureUsageDescription` *audio-capture* prompt (correct, honest prompt for an audio app — and
  a cleaner consent story than requesting Screen Recording). Owner still hears audio normally. *Rejected:*
  ScreenCaptureKit audio (requires the mismatched/scary Screen-Recording permission + screen-capture
  entitlements Echo doesn't need); virtual audio device / BlackHole (driver install + routing friction +
  needs a multi-output device so the owner still hears the call — worst privacy/consent story).
- **D3-05: On-device STT = WhisperKit.** Argmax's CoreML Whisper port (up to `large-v3-turbo`) on the
  Neural Engine — slight accuracy lead for meetings with crosstalk/accents, model-size control, and OS
  portability. Fully on-device (privacy parity with the alternatives). Cost accepted: ships a managed
  model file and is wall-clock slower than Apple's on short clips. *Considered:* Apple
  SpeechAnalyzer/SpeechTranscriber (macOS-26-native, zero model management, ~55% faster, competitive
  accuracy) — kept as the documented fallback if WhisperKit model management becomes a burden;
  FluidAudio/Parakeet unified ASR (ties STT to the diarizer's roadmap, less battle-tested for varied
  meeting audio).
- **D3-06: Diarization = two-channel prior + FluidAudio multi-remote splitting.** Because mic and
  loopback are captured as **separate channels**, the mic channel **anchors `Owner`** at high confidence
  (free, deterministic). Run **FluidAudio** (Swift-native, CoreML/ANE, real-time speaker diarization) on
  the **loopback** channel to split multiple remote speakers (`Speaker 2`, `Speaker 3`, …). Low-confidence
  splits are kept but flagged **P4** and surfaced for an Archivist **"correct the speakers"** step — never
  silently dropped. Tackles the spec's known weak point now. *Rejected:* two-channel-only with a single
  `Remote` bucket (leaner but weak on group calls — multi-remote splitting would be a later follow-up).

### Quill form coverage & behavior
- **D3-07: Quill v1 = Accessibility (AX-first) + on-device OCR fallback only; browser-extension DOM
  bridge deferred.** Covers native apps + accessibility-friendly web with one capture surface, which
  **proves the local-capture privacy boundary first** (the phase's stated goal). ATS job sites
  (Lever/Greenhouse/Workday/Ashby) get best-effort via AX/OCR in v1; a companion browser-extension DOM
  bridge (far more reliable on React-heavy ATS forms) is a **fast-follow** once the daemon + privacy
  boundary are proven — see Deferred Ideas. *Rejected for v1:* shipping the browser extension now (second
  build + install + a new local capture surface before the boundary is proven).
- **D3-08: Free-text "voice" fields = local Codex snippet insert (no cloud LLM).** For cover letters /
  "Why this role?", Quill pastes the relevant Codex bio/voice-note snippet as a **deterministic** starting
  draft, marks it low-confidence (`✎ review voice`), and the owner finishes it. Preserves Quill's hard
  invariant — **no cloud LLM ever sees the screen, no cloud round-trip in the fill loop** — while still
  saving keystrokes. Matches the spec's "drafted, flagged for review" intent without a generative model.
  *Rejected:* leave-blank-for-owner (does less for the job-app flow); scoped cloud draft from prompt +
  Codex voice notes (introduces a cloud dependency that muddies Quill's pure-local story).
- **D3-09: Hold the Quill spec defaults.** `autofill_eeo = false` (demographics/EEO left blank for the
  owner — often "decline to answer"); **refuse** to autofill secrets (password/SSN/payment) with a **P2**
  flag; on multi-page/wizard forms, **re-scan the AX tree per step** and fill page-by-page. All per
  `docs/agents/quill.md`. `confirm_before_submit = true` is **locked, not user-disablable** — Quill never
  auto-submits.

### Consent & recording UX (the 100%-consent gate)
- **D3-10: `consent.require = true` always + owner-confirm + a logged "announce" helper.** Echo treats
  **two-party consent** as the default posture. Per session the owner must click **Start** to attest
  participants are aware; nothing is retained otherwise. Echo **also** offers a one-click "this call may be
  recorded" notice the owner can read aloud, and **logs that the notice was shown** (a defensible record).
  Declining → `consent: "discarded"`, **nothing persisted**, a **P3** note logged so the run-log shows a
  meeting occurred without content. *Deferred:* per-jurisdiction auto-strictness (locale-driven
  one-party/two-party flip) — over-engineered for a single-owner tool in v1.
- **D3-11: Echo auto-arms on calendar + audio-active; captures nothing until Start.** `trigger.mode =
  calendar+audio`. Echo watches the calendar and detects mic/output device activity; on either it **arms**
  (shows the indicator + consent prompt) but **captures nothing** until the owner confirms. The
  `EchoSession` DO + WebSocket session **opens only after consent**. Best coverage (catches ad-hoc calls)
  with zero silent capture. *Rejected:* calendar-only (misses spontaneous calls); manual-start-only
  (easy to forget — you'd lose meetings; the stale-heartbeat "meeting with no transcript" flag only
  partly backstops it).
- **D3-12: v1 live UI = the non-dismissable indicator + pause/stop controls only.** The owner sees the
  mandatory recording indicator (menubar dot + "Echo is capturing"), pause/stop controls, and the consent
  prompt — nothing more. The diarized transcript is reviewed **after** the meeting as the Vault note
  (Archivist). The DO/WebSocket still streams for durability/finalize. *Deferred:* a live scrolling
  transcript window (nice for spotting mis-diarization live, but extra UI on the highest-risk surface
  before the boundary is proven).

### Claude's Discretion
Left to research/planning, constrained by the canonical refs + `CLAUDE.md` pins:
- **Transcript-store shape** — R2 `transcripts/` blob (no expiry) + a D1 pointer/index row; the exact
  schema and the session→note linkage.
- **How "transcript ready" reaches Archivist** — Echo (a Wire **producer**) emits the trigger over its
  outbound channel after the transcript is uploaded; the cloud kicks the Archivist **Workflow** instance.
  Exact transport (Wire event vs a dedicated cloud endpoint) + the Workflow's durable step decomposition.
- **Echo calendar-awareness source** — local **EventKit** (reads the synced Calendar.app, no cloud
  round-trip) vs cloud-pushed "upcoming meetings" in the daemon's poll response. Lean EventKit unless it
  can't see the right calendars.
- **Echo heartbeat / "meeting-with-no-transcript" detection** — Echo is **event-driven, not cron-scheduled**;
  how the heartbeat slot + stale detection (P3) integrate with `FlaggerState` (Phase 2).
- **Presigned R2 upload** — which Worker mints the presigned PUT URL for approved audio (`audio/raw/`),
  scoped to the capture app's OAuth client; the daemon uploads **direct** (never proxied — D3 / build-plan).
- **`EchoSession` DO shape** — `ctx.acceptWebSocket()` (Hibernation), `setWebSocketAutoResponse("ping","pong")`,
  `serializeAttachment(sessionId)`; reconnect-to-same-`getByName` finalize-from-buffer logic.
- **Exact model pins** — WhisperKit model size (tiny → large-v3-turbo) and FluidAudio model versions;
  the on-device OCR engine for Quill's vision fallback (Vision framework `VNRecognizeTextRequest`).
- **Archivist tunables** — series-matching aggressiveness (conservative: new-series over wrong-series),
  `prior_notes_window` (3), `template_id` (`meeting-note/v1`), `action_item_confidence` (0.6),
  `emit_others_actions` (false).
- **OS-permission onboarding flow** — first-run grant sequence for Microphone, audio-capture
  (`NSAudioCaptureUsageDescription`), Accessibility, and Screen Recording (Quill vision fallback only).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Authoritative design (wins all conflicts)
- `docs/SPEC-CANON.md` — §12 (security/privacy: *local-only sensitive capture* — Echo/Quill never leave
  the device except as owner-approved derived artifacts), §4 (meetings pipeline Echo→Archivist→Steward→Vault;
  Archivist depends on Echo + Codex), §7 (cloud-vs-local split; local agents run a macOS daemon that
  authenticates outbound), §10 (scheduling: event-driven Echo/Archivist, on-demand Quill, Echo runs in
  parallel), §11 (the Codex sections Quill + Archivist read), §6.1/§6.2/§6.3 (Meetings counters,
  Meeting-notes index, People/CRM for attendee resolution). If two docs disagree, this wins.

### How to build Phase 3 (primary build guide)
- `docs/13-build-plan.md` §3 "Phase 3 — Capture / local" — the 5 key tasks (daemon shell; Echo capture
  pipeline; Echo R2 disposition; Archivist handoff; Quill autofill) with **acceptance criteria**, the
  new-tech table (launchd daemon, OS perms, `EchoSession` DO + WebSocket Hibernation, R2 lifecycle
  prefixes, Archivist Workflow), the **enforced privacy boundary**, hard dependencies on earlier phases,
  and the **gating criteria**. **The primary reference.** Also §1 (`compatibility_date` ≥ 2026-04-07 for
  `web_socket_auto_reply_to_close`), the R2 `BLOBS` prefix-split + per-prefix lifecycle, the model tier
  table (Archivist → Opus).

### Per-agent specs (Phase 3)
- `docs/agents/echo.md` — capture pipeline, two-channel diarization prior, the transcript JSON shape
  (`session_id`, `consent`, `audio_disposition`, `segments`), consent & indicator rules, failure modes +
  Flagger severities, config knobs (`capture.*`, `trigger.mode`, `audio.retain`, `stt.model`,
  `diarization.minSpeakers/maxSpeakers`), and the open questions (multi-remote diarization, loopback UX,
  announce-the-other-party, per-jurisdiction defaults, R2 lifecycle) — several **resolved** by D3-04..06,
  D3-10..12.
- `docs/agents/archivist.md` — the fixed notes **template**, cross-meeting **series threading**,
  **action-item extraction** (owner-only → Forge; decision ≠ action item; stated deadlines only; low-conf
  → flag-don't-drop), the Forge `action-item` Wire event + idempotency key
  (`archivist:<series>:<date>:ai-NN`), idempotent emission, config (`prior_notes_window`,
  `action_item_confidence`, `emit_others_actions`, `note_status: draft`), failure modes.
- `docs/agents/quill.md` — AX-first + vision/OCR fallback, the field-label → Codex-field map, the review
  panel, confirm-before-submit (locked), sensitive-field refusal, the privacy guarantees (screen content
  never leaves the device; no Vault/Wire/Codex write), config (`read_strategy`, `confirm_before_submit`,
  `mask_sensitive_in_panel`, `autofill_eeo`, `low_confidence_threshold`), the open questions (browser
  coverage, multi-page forms, voice fields, EEO defaults) — **resolved** by D3-07..09.

### Substrate / cross-cutting
- `docs/06-hosting-cloudflare-mcp.md` §7 — the cloud-vs-local split; the **outbound-only daemon pattern**
  (authenticate outbound, long-poll, drain, ack; **no inbound port**) that D3-01 reuses; the Connect-a-new-MCP
  checklist; Browser-Rendering note.
- `docs/11-security-privacy.md` §12 — the local-capture privacy boundary; per-agent least-privilege scopes
  (Archivist `drive.readonly` for the Codex; the capture app's Echo/Quill scopes); secrets only via
  bindings (the new capture-app OAuth token → Secrets Store / Keychain, never `[vars]`/KV/Vault/Codex);
  the daemon's Flagger channel may name a form + field labels but **never** screen content/filled values.
- `docs/07-source-of-truth-codex.md` §11 — the Codex sections Quill (autofill) + Archivist (context) read;
  read-only to agents; Quill never writes the Codex back.
- `docs/03-scheduling.md` §10 — event-driven `meeting starts → Echo (live)` / `meeting ends → Archivist`;
  `on-demand` Quill; Echo runs in parallel with the morning chain; heartbeat expectations + grace.
- `docs/02-architecture.md` §4 — the meetings pipeline (local → cloud); the single-writer model (Archivist
  writes the Vault **only** through Steward; Echo/Quill never write the Vault).
- `docs/05-dashboard.md` — the **Meetings** counters (`count this week`, `hours in meetings`) and the
  **Meeting-notes index** view Steward maintains from Archivist's `upsert`.

### Project state & conventions
- `.planning/REQUIREMENTS.md` — CAPTURE-01, CAPTURE-02 (locked requirements + acceptance). MUST read.
- `.planning/PROJECT.md` — **D3** (raw Echo audio expires 7d, `audio/raw/` only, presigned URL direct from
  the daemon), **D4** (OAuth-bearer outbound-only daemon transport; heartbeat per poll; stale > grace →
  P1 trust 100), **D5** (Archivist → Opus via AI Gateway, set `effort` explicitly — not high), **D6**
  (Quill ships in Phase 3, no Echo data dependency). These are **carried forward, not re-decided**.
- `.planning/phases/00-spine/00-CONTEXT.md` — the Phase-0 outbound bridge that D3-01 extends (D-05
  one-Worker-per-agent, the `vault_outbox` + `SAFE_METHODS` op→REST map, the OAuth Provider with
  `ctx.props {ownerId, agent, scopes}`).
- `CLAUDE.md` — pins (`agents ^0.14.x` + `nodejs_compat`, `compatibility_date 2026-04-25` for
  `web_socket_auto_reply_to_close`), `BLOBS` R2 prefix rules (`audio/raw/` 7d, `transcripts/`/`exports/`
  persist), DO class = PascalCase (`EchoSession`, `getByName("echo-<timestamp>")`), structured idempotency
  keys (never `crypto.randomUUID()`), the §6.4 Wire contract, model tiering (Archivist → Opus), TZ=UTC
  owner-local-date gotcha, the Definition-of-Done three tests.

### External references (verified 2026-06-06 — re-verify before implementing; these move fast)
- Core Audio process taps — `https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps`
  + the `insidegui/AudioCap` sample (`https://github.com/insidegui/AudioCap`).
- WhisperKit (Argmax) — `https://github.com/argmaxinc/WhisperKit`, `https://www.argmaxinc.com/blog/apple-and-argmax`.
- FluidAudio (Swift speaker diarization + VAD on CoreML/ANE) — `https://github.com/FluidInference/FluidAudio`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (Phase 0/1/2 — built, code-complete)
- **`daemon/` (Node Obsidian bridge)** — `src/drain.ts` + `com.atlas.bridge.plist`: the **proven
  outbound-only pattern** (OAuth-bearer in Keychain, long-poll `/bridge/poll`, POST to local REST, ack
  outbound, no inbound port; 17 tests green). D3-01 **leaves it untouched** as a second launchd agent and
  **reuses its auth/outbox pattern** in the new Swift app — does not port or replace it.
- **`apps/steward` + `packages/steward-core`** — sole `atlas-wire` consumer + sole Vault writer; consumes
  Archivist's `op:"upsert"`/`entity` note + meeting-counter events **unchanged** (idempotent dedup +
  `vault_outbox` already proven). No Steward changes needed for the pipeline topology.
- **`packages/tasks` + `apps/forge`** — Forge's D1 `tasks`/`subtasks` store with `idx_tasks_dedupe` +
  `locked_by_owner`; Archivist emits **owner action items through Forge's path** (the same way Headhunter
  did in Phase 2), not a new store. `Forge.createTask` RPC exists (closed in quick-260606-c24).
- **`packages/codex`** — read-only Codex reader; Archivist (work context) + Quill (field map) read it.
  Quill needs a **local read-only copy** of the Codex (daemon-side) — how it stays fresh is Claude's
  discretion (see Open items).
- **`packages/model`** — `claudeFor(agent,env)`; Archivist → **Opus** resolves here via KV tiering; set
  `effort` explicitly (D5 cost discipline — never hardcode `high`).
- **`packages/wire` + `packages/shared/src/flag.ts`** — the §6.4 `WireEvent` producer + the reworked
  `flag()` → `atlas-incidents` (Phase 2). Echo (a producer) emits "transcript ready" + incidents; Quill
  forwards incidents over its authenticated channel (form + field labels only, never content/values).
- **`apps/atlas`** — the OAuth **Provider** default export (D4) the capture app registers against as a new
  least-privilege client (D3-02); the `scheduled()`/coordination surface. **Archivist** is a **new** cloud
  `WorkflowEntrypoint` triggered on meeting-ends.
- **`BLOBS` R2 binding** — declared-and-ready with the `audio/raw/` 7-day lifecycle + persistent
  `transcripts/`; **but R2 is not yet enabled on the account** (see go-live gate).

### Established Patterns (must conform)
- **One writer per resource (Pillar 1).** Steward stays the sole `atlas-wire` consumer + sole Vault
  writer; Archivist writes the Vault **only** through Steward; Echo/Quill never write the Vault. No new
  `atlas-wire` consumer (a second is a hard CI failure).
- **Suggest, don't destroy (Pillar 2).** Quill never submits; Echo never auto-uploads audio; notes land
  `status: draft`. The 100%-consent gate is the Echo expression of this pillar.
- **Idempotent + structured keys.** `EchoSession` `getByName("echo-<timestamp>")`; transcript handoff +
  Archivist keyed on `session_id`; Forge action items `archivist:<series>:<date>:ai-NN`. Replay leaves
  counters unchanged (`meta.changes === 0`).
- **Outbound-only, no inbound port (Pillar 3 / D4).** Both launchd agents initiate every connection;
  Echo's WebSocket to the `EchoSession` DO and the transcript upload are **outbound**.
- **Owner-local date via `Intl`** (`America/Toronto`), never `new Date()` (workerd TZ=UTC).
- **Definition of Done per agent PR** (CLAUDE.md): a Wire-contract test (shape + structured key), a replay
  test through Steward (`meta.changes === 0`), and a failure-path test asserting the right Flagger severity.

### Integration Points (NEW code this phase)
- **New local app**: a native Swift menubar app (`apps/`-external; lives alongside `daemon/`) hosting Echo
  + Quill, Developer-ID-signed + notarized, its own outbound poll/drain + OAuth client.
- **New cloud Worker**: `apps/archivist` — a `WorkflowEntrypoint` (Opus pass, durable steps), consuming a
  transcript-ready trigger, emitting Steward `upsert` + Forge `action-item` events.
- **New DO**: `EchoSession` (per-meeting, WebSocket Hibernation API) — cloud side of Echo's live stream.
- **New R2 usage**: `transcripts/` (persist) + gated `audio/raw/` (7d) via presigned direct upload.
- **New OAuth client**: the capture app's least-privilege client (D3-02) + its token in the seed.
- **Retrofit**: Echo/Quill incident + (Echo) heartbeat emits into the Phase-2 Flagger pipeline.

</code_context>

<specifics>
## Specific Ideas

- **The separate channels ARE the diarization prior** (D3-06) — mic = Owner, loopback = others — so Echo
  never blindly clusters one mixed waveform for owner-vs-others; FluidAudio only has to split *multiple
  remotes* inside the loopback. Planning should exploit this, not run a single-stream diarizer.
- **Core Audio taps + the audio-capture prompt are part of the consent story** (D3-04) — choosing the
  taps path means the OS prompt the owner sees says "capture audio," which is honest, instead of the
  alarming "Screen Recording" prompt ScreenCaptureKit would force for an audio feature.
- **Quill stays pure-local even for cover letters** (D3-08) — the snippet-insert decision exists
  specifically to avoid sending any screen-adjacent content to a cloud model; the "no cloud LLM sees the
  screen" invariant is the whole reason Quill is trustworthy.
- **Capture nothing until Start** (D3-11) — arming (indicator + prompt) is decoupled from capture; the
  `EchoSession` DO/WebSocket opens only **after** consent, so there is no window where audio is buffered
  pre-consent.

### Owner go-live gates for Phase 3 (cannot be set from code; mirror the Phase-1/2 gate discipline)
- **R2 enablement** — `wrangler r2 bucket create atlas-blobs` currently fails (CF API err 10042, account
  not R2-enabled). Owner enables R2, creates the bucket + the `audio/raw/` 7-day lifecycle rule. **Echo's
  transcript/audio storage is blocked until this is done.**
- **Apple Developer account** ($99/yr) for Developer-ID signing + notarization (D3-03).
- **OS permission grants** — Microphone, audio-capture (`NSAudioCaptureUsageDescription`), Accessibility
  (Quill read+inject), Screen Recording (Quill vision fallback only). All owner-granted OS prompts.
- **Seed the capture app's OAuth client + token** into the Secrets Store / macOS Keychain (D3-02).

</specifics>

<deferred>
## Deferred Ideas

- **Quill browser-extension DOM bridge** for ATS web forms (Lever/Greenhouse/Workday/Ashby) — the reliable
  path for React-heavy job applications. Deferred from v1 (D3-07) to prove the privacy boundary first with
  one capture surface; a **fast-follow**. Local native-messaging/localhost only — page content never leaves
  the device, same rule as the screen.
- **Per-jurisdiction consent auto-strictness** — flip one-party/two-party posture by the owner's/meeting's
  locale (D3-10). Over-engineered for a single-owner tool now; revisit if Echo is used across jurisdictions.
- **Echo live-transcript window** — a real-time scrolling, speaker-tagged transcript view driven by the DO
  WebSocket (D3-12). Nice for spotting mis-diarization live; deferred until the privacy boundary is proven.
- **Apple SpeechAnalyzer/SpeechTranscriber as the STT engine** — the macOS-26-native, zero-model-management
  alternative to WhisperKit (D3-05). Documented fallback if WhisperKit model management/size becomes a
  burden.
- **Archivist mid-meeting provisional notes** — produce a draft from a partial transcript while Echo still
  streams (Archivist open question). Spec says after `meeting ends`; revisit if the owner wants live notes.
- **Archivist "things others owe me" view** — `emit_others_actions`/a lightweight Vault view of other
  attendees' commitments (Archivist open question). Off by default; Atlas only manages the owner's tasks.

None of the above block Phase 3. Discussion stayed within phase scope.

</deferred>

---

*Phase: 3-Capture (Local)*
*Context gathered: 2026-06-06*
