# Phase 3: Capture (Local) — Research

**Researched:** 2026-06-06
**Domain:** Native macOS Swift daemon (Echo + Quill) + Cloudflare cloud components (EchoSession DO, Archivist Workflow, presign Worker)
**Confidence:** HIGH (cloud side — all Cloudflare APIs verified via Context7 + official docs); MEDIUM-HIGH (Swift native stack — verified via GitHub official repos + Apple dev docs; some platform specifics ASSUMED)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D3-01**: New native Swift menubar app (SwiftUI/AppKit, launchd) for Echo + Quill. The Node Obsidian-bridge stays a separate untouched launchd agent. Reuse OAuth-bearer + Keychain + outbox PATTERN; do not port Node code.
- **D3-02**: Separate OAuth client per agent (capture app gets its own least-privilege client registered with the Atlas OAuthProvider).
- **D3-03**: Developer ID-signed + notarized (TCC grants persist across rebuilds).
- **D3-04**: System-audio loopback via Core Audio process taps (`AudioHardwareCreateProcessTap`, macOS 14.4+). NO virtual device. Gated by `NSAudioCaptureUsageDescription` prompt.
- **D3-05**: On-device STT = WhisperKit (CoreML Whisper, up to `large-v3-turbo`). Apple SpeechAnalyzer is documented fallback.
- **D3-06**: Diarization = two-channel prior (mic = Owner deterministically) + FluidAudio `LSEENDDiarizer` on the loopback channel for multi-remote splitting. Low-confidence splits kept + flagged P4.
- **D3-07**: Quill v1 = Accessibility (AX-first) + on-device OCR (`VNRecognizeTextRequest`) fallback only. Browser-extension DOM bridge deferred.
- **D3-08**: Quill free-text fields = local Codex snippet insert (NO cloud LLM ever sees the screen).
- **D3-09**: Quill defaults — `autofill_eeo=false`, refuse secrets with P2 flag, re-scan AX tree per wizard step, `confirm_before_submit=true` LOCKED.
- **D3-10**: `consent.require=true` always + owner-confirm Start + logged "announce" helper. Decline → `consent:"discarded"`, nothing persisted, P3 logged.
- **D3-11**: Echo auto-arms on calendar+audio-active but captures NOTHING until Start. `EchoSession` DO + WebSocket opens ONLY AFTER consent.
- **D3-12**: v1 live UI = non-dismissable indicator + pause/stop + consent prompt only. Live transcript window deferred.

### Claude's Discretion

- **Transcript-store shape**: R2 `transcripts/` blob (no expiry) + D1 pointer/index row — exact schema + session→note linkage.
- **"Transcript ready" transport**: Echo (Wire producer) emits trigger after upload; cloud kicks Archivist Workflow. Exact transport + step decomposition.
- **Echo calendar-awareness source**: local EventKit vs cloud-pushed. Lean EventKit.
- **Echo heartbeat / stale-detection**: event-driven Echo; how heartbeat integrates with FlaggerState.
- **Presigned R2 upload**: which Worker mints the presigned PUT URL; daemon uploads DIRECT.
- **EchoSession DO shape**: `acceptWebSocket()` Hibernation, `setWebSocketAutoResponse`, `serializeAttachment`, reconnect-to-same-getByName finalize-from-buffer.
- **Exact model pins**: WhisperKit model size; FluidAudio version; Quill OCR engine.
- **OS-permission onboarding flow ordering**.

### Deferred Ideas (OUT OF SCOPE)

- Quill browser-extension DOM bridge
- Per-jurisdiction consent auto-strictness
- Echo live-transcript window
- Apple SpeechAnalyzer/SpeechTranscriber as primary STT engine
- Archivist mid-meeting provisional notes
- Archivist "things others owe me" view
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CAPTURE-01 | Echo captures audio in a local macOS daemon (DO + WebSocket live stream) → diarized transcript → Archivist structures context-aware meeting notes (action items, cross-meeting threading) → Steward → Vault; per-session consent captured before Echo records; raw audio uploads via presigned URL direct from daemon (expires 7 days, `audio/raw/` only). | Research covers: EchoSession DO WebSocket Hibernation API; Core Audio process taps; WhisperKit v1.0.0 + FluidAudio v0.15.x; transcript JSON contract; Archivist Workflow durable step decomposition; R2 presigned PUT URL pattern; Wire event shapes; D3-01..D3-12 locked decisions. |
| CAPTURE-02 | Quill autofills on-screen forms from the Codex (Accessibility API + OCR fallback), hotkey-triggered, never autonomous, confirming before submit, never writing the Codex back; outputs never leave the device except as owner-approved derived artifacts. | Research covers: AXUIElement + `AXUIElementSetAttributeValue` for AX read/inject; Vision `VNRecognizeTextRequest` for OCR fallback; review panel pattern; Codex local read-only copy freshness; Flagger incident path for Quill. |
</phase_requirements>

---

## Summary

Phase 3 is Atlas's first local macOS runtime — a native Swift menubar app that must build the privacy boundary (outbound-only, no inbound port, on-device processing, R2 prefix-split expiry) before any feature. The phase splits cleanly into two axes: **local Swift daemon** (Echo + Quill, Developer-ID signed, launchd) and **cloud extensions** (EchoSession Durable Object, Archivist Workflow, a presign Worker, a new OAuth client). The privacy boundary — Echo audio and Quill screen never leave the device except as approved derived artifacts — is enforced mechanically by design, not by promise.

The two biggest technical risks are (1) the Core Audio process-tap long-session stability issue (silent zeros after extended uptime — requires a destroy-and-recreate workaround) and (2) WhisperKit's migration to the `argmax-oss-swift` monorepo at v1.0.0 (May 2026), which changes the Swift Package URL. The cloud side (EchoSession DO, Archivist Workflow, R2 presigning) maps cleanly onto existing Cloudflare primitives already used in Phases 0–2.

The Obsidian bridge daemon (`daemon/src/drain.ts`) is **left entirely untouched** per D3-01. The new Swift capture app is a parallel, independent launchd agent that reuses the authentication and outbox *pattern* (OAuth bearer token in the macOS Keychain, outbound-only long-poll, no inbound port) without porting any Node code.

**Primary recommendation:** Build the privacy boundary and daemon shell first (Task 1 in the plan), prove no-inbound-port and outbound auth before any audio or screen feature is added. Then layer Echo capture pipeline, Archivist Workflow, R2 presigning, and Quill in separate plan waves.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Audio capture (mic + loopback) | Local macOS daemon | — | Physical machine's audio subsystem; cannot run on Cloudflare |
| On-device STT + diarization | Local macOS daemon | — | Neural Engine / CoreML; raw audio must not leave device |
| Consent gate + recording indicator | Local macOS daemon | — | UI is on the physical machine; consent must be captured locally |
| Live segment streaming | Local daemon → Cloud DO | EchoSession DO | Daemon streams outbound WS; DO holds durable per-session state |
| Transcript finalization + storage | Local daemon (write transcript) → R2 | D1 (index row) | Daemon uploads transcript blob to R2 via presigned URL |
| Audio blob upload (gated) | Local daemon → R2 (direct, presigned) | — | Direct upload — never proxied through a Worker |
| Presigned URL minting | Cloud Worker (new `apps/echo-presign` or added to `apps/atlas`) | — | Worker has R2 binding + OAuth context; daemon has no R2 credentials |
| "Transcript ready" trigger | Local daemon → Wire (via outbound channel) | — | Echo is a Wire producer; emits the trigger event after R2 upload |
| Meeting notes structuring | Cloud (Archivist Workflow) | — | Opus pass, Codex read, series threading — all cloud-safe operations |
| Vault write (notes + counters) | Steward only (unchanged) | — | Pillar 1: one writer; Archivist emits Wire events, never writes directly |
| Action item task creation | Forge (via Wire event) | — | Same path as Headhunter in Phase 2; `Forge.createTask` RPC exists |
| Screen reading + field mapping | Local macOS daemon | — | AX tree + OCR; screen content must stay local |
| Form field injection | Local macOS daemon | — | `AXUIElementSetAttributeValue`; write into local form only |
| Quill review panel | Local macOS daemon | — | SwiftUI panel; no cloud round-trip in the fill loop |
| Flagger incident forwarding | Local daemon → `atlas-incidents` (via outbound channel) | Flagger cloud | Daemon emits RawIncident; Flagger scores and routes |
| Calendar awareness (Echo arm) | Local macOS daemon (EventKit) | — | EventKit reads Calendar.app locally; no cloud round-trip |

---

## Standard Stack

### Core — Cloud (TypeScript Workers)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `cloudflare:workers` (`DurableObject`, `WorkflowEntrypoint`, `WorkflowStep`, `WorkflowEvent`) | N/A (runtime built-in) | EchoSession DO + Archivist Workflow | Already used in all prior phases; proven pattern |
| `cloudflare:workflows` (`NonRetryableError`) | N/A (runtime built-in) | Archivist Workflow non-retryable step failures | Separate import from `cloudflare:workers` — critical import distinction |
| `@aws-sdk/client-s3` | `3.1063.0` | S3Client for R2 presigned URL generation | [VERIFIED: npm registry] — AWS SDK v3, well-established; slopcheck [OK] |
| `@aws-sdk/s3-request-presigner` | `3.1063.0` | `getSignedUrl` + `PutObjectCommand` for presigning | [VERIFIED: npm registry] — paired with client-s3; slopcheck [OK] |
| `@atlas/wire` | workspace | WireEvent contract + `send()` helper | Internal — already canonical across all phases |
| `@atlas/shared` | workspace | `flag()` → `atlas-incidents`, `localDate()`, `FlagRecord` | Internal — already canonical across all phases |
| `@atlas/model` | workspace | `claudeFor("archivist", env)` → Opus via AI Gateway | Internal — Archivist → Opus via KV tiering |
| `@atlas/codex` | workspace | Read-only Codex reader for Archivist context | Internal — already proven in Phase 0 |

### Core — Local Native (Swift)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `argmax-oss-swift` (WhisperKit product) | `v1.0.0` (May 2026) | On-device ASR / STT | [VERIFIED: github.com/argmaxinc/argmax-oss-swift] — WhisperKit migrated to monorepo at v1.0.0; `large-v3-turbo` model available |
| `FluidAudio` | `v0.15.1` (Jun 2026) | Speaker diarization (LSEENDDiarizer for loopback channel) | [VERIFIED: github.com/FluidInference/FluidAudio] — latest stable; Swift SPM |
| CoreAudio (`AudioHardwareCreateProcessTap`) | macOS 14.4+ built-in | System-audio loopback tap | [CITED: developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps] — OS API, macOS 14.4+ required; owner is on macOS 26/Darwin 25.4 |
| EventKit (`EKEventStore`) | macOS built-in | Local calendar awareness for Echo arming | [VERIFIED: developer.apple.com/documentation/eventkit/accessing-calendar-using-eventkit-and-eventkitui] — reads synced Calendar.app; no cloud round-trip |
| Vision (`VNRecognizeTextRequest`) | macOS built-in | On-device OCR fallback for Quill | [VERIFIED: developer.apple.com/documentation/vision/vnrecognizetextrequest] — fully on-device |
| ApplicationServices (`AXUIElement`) | macOS built-in | Accessibility tree read + value injection for Quill | [VERIFIED: developer.apple.com/documentation/applicationservices/axuielement] |
| Security Keychain | macOS built-in | OAuth token storage in daemon | [ASSUMED] — standard macOS pattern; `SecItemAdd`/`SecItemCopyMatching` |
| AppKit / SwiftUI | macOS built-in | Menubar app (`NSStatusItem`), recording indicator, consent prompt, Quill review panel | [ASSUMED] — standard macOS menubar app pattern; `LSUIElement=true` in Info.plist |
| launchd (plist) | macOS built-in | `KeepAlive`, `RunAtLoad` daemon lifecycle | [VERIFIED: launchd.info] — proven pattern already used in `daemon/com.atlas.bridge.plist` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `aws4fetch` | `1.0.20` | Lightweight AWS Signature V4 alternative for R2 presign | [VERIFIED: npm registry]; slopcheck [OK] — lighter than full AWS SDK if binary size is a concern; the full `@aws-sdk` path is standard |
| `argmax-oss-swift` (`SpeakerKit` product) | `v1.0.0` | Argmax's own speaker identification kit (bundled in monorepo) | Available alongside WhisperKit but **FluidAudio is the locked choice (D3-06)**; document as alternative only |

**Installation (cloud Worker additions):**

```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner --filter @atlas/echo-session
# OR for the presign worker — add to whichever Worker mints presigned URLs
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner --filter @atlas/atlas
```

**Swift Package Manager (capture daemon `Package.swift`):**

```swift
// Package.swift for the Swift capture daemon
.package(url: "https://github.com/argmaxinc/argmax-oss-swift", from: "1.0.0"),
.package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.1"),
```

> **Version note (WhisperKit):** WhisperKit migrated from `https://github.com/argmaxinc/WhisperKit` (the legacy repo) to the `argmax-oss-swift` monorepo at v1.0.0 (2026-05-01). The new package URL is `https://github.com/argmaxinc/argmax-oss-swift`. Product name in Package.swift is `"WhisperKit"`. The legacy repo URL no longer has releases.

---

## Package Legitimacy Audit

> Cloud-side Node packages only. Swift packages are from official Apple Developer/GitHub repos; no npm ecosystem risk.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `@aws-sdk/s3-request-presigner` | npm | ~4 yrs | Very high | github.com/aws/aws-sdk-js-v3 | [OK] | Approved |
| `@aws-sdk/client-s3` | npm | ~4 yrs | Very high | github.com/aws/aws-sdk-js-v3 | [OK] | Approved |
| `aws4fetch` | npm | ~6 yrs | High | github.com/mhart/aws4fetch | [OK] | Approved — supporting alternative |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

No postinstall scripts found on any of the above packages.

---

## Architecture Patterns

### System Architecture Diagram

```
  ┌──────────────── macOS (local) ─────────────────────────────────────────────────┐
  │                                                                                  │
  │  [mic input]  ──▶ AudioHardwareCreateProcessTap                                 │
  │  [sys output] ──▶ (loopback, separate channel)  ──▶ WhisperKit STT              │
  │                                                        │                        │
  │  consent gate ◀── non-dismissable indicator            ▼                        │
  │  owner clicks Start ──────────────────────────── FluidAudio LSEENDDiarizer      │
  │                                                   (loopback channel only)       │
  │                                                        │                        │
  │                                         segments: {speaker,text,ts,confidence}  │
  │                                                        │                        │
  │  EventKit ──▶ EKEventStore (calendar arm)              ▼                        │
  │                                           WS outbound ──▶ EchoSession DO        │
  │                                                                │  (Hibernation) │
  │  On meeting end:                                               │                │
  │    transcript JSON ──▶ presigned PUT URL ──▶ R2 transcripts/  │                │
  │    (audio blob, gated) ──▶ presigned PUT URL ──▶ R2 audio/raw/│                │
  │    Wire event "transcript.ready" outbound ──▶                  │                │
  │                                                                │                │
  │  [Quill hotkey] ──▶ AXUIElement tree read                      │                │
  │    ──▶ VNRecognizeTextRequest (OCR fallback)                   │                │
  │    ──▶ local Codex copy ──▶ field mapping                      │                │
  │    ──▶ SwiftUI review panel ──▶ AXUIElementSetAttributeValue   │                │
  │         (fill only — NEVER submit)                             │                │
  │                                                                │                │
  └────────────────────────────────────────────────────────────────┼────────────────┘
                                                                   │
  ┌──────────────── Cloudflare Cloud ──────────────────────────────▼────────────────┐
  │                                                                                  │
  │  EchoSession DO (getByName("echo-<timestamp>"))                                  │
  │    ctx.acceptWebSocket() → webSocketMessage() accumulates segments               │
  │    setWebSocketAutoResponse("ping","pong")                                       │
  │    serializeAttachment({sessionId}) for reconnect                               │
  │    On close/finalize: session state persisted in DO SQLite                      │
  │                                                                                  │
  │  Atlas OAuthProvider ──▶ capture client (D3-02 least-privilege scopes)           │
  │    Scope: echo:ws  echo:presign  quill:incidents  codex:read                    │
  │                                                                                  │
  │  Presign Worker (apps/atlas or dedicated) ──▶ R2 presigned PUT URL              │
  │    @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner                           │
  │    S3Client endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com             │
  │    Bucket: atlas-blobs; key prefix: transcripts/<session_id>.json               │
  │    Bucket: atlas-blobs; key prefix: audio/raw/<session_id>.opus                 │
  │    expiresIn: 3600 (presign valid 1h for daemon upload)                         │
  │                                                                                  │
  │  Wire ("transcript.ready" event) ──▶ Flagger ──▶ Atlas triggers Archivist      │
  │                                                                                  │
  │  Archivist Workflow (WorkflowEntrypoint)                                         │
  │    step 1: fetch transcript from R2                                              │
  │    step 2: load prior N notes (Meeting-notes index via Steward/Obsidian MCP)    │
  │    step 3: load Codex context (claudeFor("archivist",env) preamble)             │
  │    step 4: one Opus pass → structure notes (effort: "low"|"medium", NOT high)   │
  │    step 5: extract owner action items                                            │
  │    step 6: emit Wire upsert to Steward (note + meeting counters)                │
  │    step 7: emit Wire upsert per owner action item to Forge                      │
  │    Idempotent on session_id; NonRetryableError from cloudflare:workflows        │
  │                                                                                  │
  │  Steward (unchanged) ──▶ vault_outbox ──▶ Obsidian bridge ──▶ The Vault         │
  │  Forge (unchanged) ──▶ D1 tasks table ──▶ Sundial ──▶ Google Calendar          │
  │  Flagger (unchanged) ──▶ incident scoring + routing                             │
  │                                                                                  │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
atlas/
├─ apps/
│  ├─ echo/                     # Cloud side: EchoSession DO + WebSocket Hibernation
│  │  ├─ src/
│  │  │  ├─ echo-session.ts     # DurableObject class EchoSession
│  │  │  ├─ presign.ts          # R2 presigned URL endpoint (Worker fetch handler)
│  │  │  └─ index.ts            # default export + DO migration
│  │  └─ wrangler.jsonc         # BLOBS R2 + WIRE producer + INCIDENTS queue
│  └─ archivist/                # Cloud Workflow: meeting notes structuring
│     ├─ src/
│     │  ├─ archivist.ts        # WorkflowEntrypoint class ArchivistWorkflow
│     │  └─ index.ts            # default export + workflow binding
│     └─ wrangler.jsonc         # DB + WIRE + INCIDENTS + AI + MODEL_ARCHIVIST
│
└─ capture/                     # Swift native daemon (OUTSIDE apps/ — not a Worker)
   ├─ Package.swift              # SPM: argmax-oss-swift + FluidAudio
   ├─ Sources/
   │  ├─ App/
   │  │  ├─ CaptureApp.swift    # @main, NSApplicationDelegateAdaptor, LSUIElement
   │  │  └─ AppDelegate.swift   # NSStatusItem, menubar indicator
   │  ├─ Echo/
   │  │  ├─ AudioTap.swift      # CATapDescription, AudioHardwareCreateProcessTap,
   │  │  │                      # aggregate device, IOProc, long-session watchdog
   │  │  ├─ TranscriptionPipeline.swift  # WhisperKit streaming + FluidAudio LSEENDDiarizer
   │  │  ├─ EchoSession.swift   # WebSocket outbound connection to EchoSession DO
   │  │  ├─ ConsentGate.swift   # UI: non-dismissable indicator, consent prompt, arm/disarm
   │  │  └─ CalendarMonitor.swift  # EventKit EKEventStore calendar awareness
   │  ├─ Quill/
   │  │  ├─ ScreenReader.swift  # AXUIElement tree + VNRecognizeTextRequest OCR fallback
   │  │  ├─ CodexMapper.swift   # local Codex copy read + field-label → Codex field map
   │  │  └─ ReviewPanel.swift   # SwiftUI confirm-before-fill panel (never submits)
   │  └─ Shared/
   │     ├─ Auth.swift          # OAuth bearer token outbound; Keychain store/retrieve
   │     ├─ OutboxChannel.swift # outbound poll/ack pattern (mirrors drain.ts pattern)
   │     └─ IncidentRelay.swift # Flagger incident emit over outbound channel
   ├─ com.atlas.capture.plist   # launchd: KeepAlive, RunAtLoad, NO inbound port
   └─ entitlements/
      └─ Atlas-Capture.entitlements  # com.apple.security.device.audio-input
```

### Pattern 1: EchoSession Durable Object with WebSocket Hibernation

**What:** A per-meeting SQLite-backed DO addressed by `getByName("echo-<ISO-timestamp>")`. Accepts the outbound WebSocket from the daemon; uses `serializeAttachment` so the `sessionId` survives hibernation wakeups. Auto-responds to pings without waking the DO.

**When to use:** Any time the local daemon streams segments to the cloud. One DO per meeting session.

```typescript
// Source: https://developers.cloudflare.com/durable-objects/best-practices/websockets
import { DurableObject } from "cloudflare:workers";

export class EchoSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Auto-reply to ping/pong WITHOUT waking the DO from hibernation
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    // Upgrade to WebSocket — called by the daemon's outbound WS open
    const { 0: client, 1: server } = new WebSocketPair();
    const sessionId = new URL(request.url).searchParams.get("session_id") ?? "";
    // acceptWebSocket() enables Hibernation: DO can be evicted between messages
    // Tags = [sessionId] for getWebSockets(sessionId) filtering on reconnect
    this.ctx.acceptWebSocket(server, [sessionId]);
    // Attach sessionId so webSocketMessage() sees it after hibernation wakeup
    server.serializeAttachment({ sessionId });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const { sessionId } = ws.deserializeAttachment() as { sessionId: string };
    const segment = JSON.parse(message as string);
    // Append to session buffer in DO SQLite (idempotent on segment index)
    await this.ctx.storage.put(`seg:${sessionId}:${segment.idx}`, segment);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // compatibility_date >= 2026-04-07 auto-replies to Close frames
    ws.close(code, reason);
    // Trigger finalization: write transcript blob path to storage
    const { sessionId } = ws.deserializeAttachment() as { sessionId: string };
    await this.ctx.storage.put(`finalized:${sessionId}`, Date.now());
  }
}
```

**Reconnect-to-same-DO pattern:** The daemon reconnects via `getByName("echo-<timestamp>")` — same name = same DO instance. `getWebSockets([sessionId])` returns existing connections; if empty, a new WS is opened and segments resume from the local buffer.

### Pattern 2: R2 Presigned PUT URL from a Worker

**What:** A Worker-side endpoint that validates the capture app's OAuth token, then returns a time-limited presigned PUT URL for direct daemon upload to R2 `audio/raw/` or `transcripts/`. The daemon uploads directly — the Worker is NOT in the data path.

**When to use:** For every approved audio blob upload and every transcript upload. R2 credentials never leave the cloud. The daemon has no R2 binding.

```typescript
// Source: https://developers.cloudflare.com/r2/examples/aws-sdk-js-v3/
// Verified: getSignedUrl via @aws-sdk/s3-request-presigner 3.1063.0
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

async function mintPresignedPut(
  env: Env,
  key: string,    // e.g. "transcripts/echo-2026-06-06T14-00.json"
  contentType: string,
  expiresIn = 3600,
): Promise<string> {
  const S3 = new S3Client({
    region: "auto",
    endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: await env.R2_ACCESS_KEY_ID.get(),
      secretAccessKey: await env.R2_SECRET_ACCESS_KEY.get(),
    },
  });
  return getSignedUrl(
    S3,
    new PutObjectCommand({ Bucket: "atlas-blobs", Key: key, ContentType: contentType }),
    { expiresIn },
  );
}
// LIMITATION: cannot test presigned URLs via `wrangler dev` (local R2 emulation
// does not support the S3 compatible presign endpoint). Deploy to staging to verify.
```

**Secrets handling:** `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are R2 API token credentials (created in the Cloudflare dashboard per-bucket). They live in the Cloudflare Secrets Store, never in `[vars]`.

### Pattern 3: Archivist as a WorkflowEntrypoint

**What:** A durable multi-step Workflow triggered by Atlas after Echo emits "transcript.ready". Idempotent on `session_id` — re-run never duplicates notes or tasks.

**When to use:** Every meeting end. `NonRetryableError` (from `cloudflare:workflows`) for consent:"discarded" transcripts or malformed JSON — no retry needed.

```typescript
// Source: https://developers.cloudflare.com/workflows/build/workers-api
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows"; // DIFFERENT import path

export class ArchivistWorkflow extends WorkflowEntrypoint<Env, { session_id: string }> {
  async run(event: WorkflowEvent<{ session_id: string }>, step: WorkflowStep) {
    const { session_id } = event.payload;

    // Step 1: Fetch transcript (idempotent — returns cached result on re-run)
    const transcript = await step.do("fetch-transcript", async () => {
      const obj = await this.env.BLOBS.get(`transcripts/${session_id}.json`);
      if (!obj) throw new NonRetryableError(`Transcript not found: ${session_id}`);
      const t = await obj.json<Transcript>();
      if (t.consent === "discarded") throw new NonRetryableError("Consent discarded");
      return t;
    });

    // Step 2: Load prior notes (series threading)
    const priorNotes = await step.do("load-prior-notes", async () => {
      // Read Meeting-notes index via Obsidian MCP or D1 index row
      return []; // placeholder — 3 notes per series (prior_notes_window: 3)
    });

    // Step 3: Load Codex context
    const codexContext = await step.do("load-codex", async () => {
      const { read } = await import("@atlas/codex");
      return read(this.env);
    });

    // Step 4: One Opus pass — structure transcript into notes template
    // effort MUST be explicitly set (never default to "high" — D5 cost discipline)
    const note = await step.do("structure-note", { retries: { limit: 2 } }, async () => {
      const claude = claudeFor("archivist", this.env); // Opus via AI Gateway
      // ... call with transcript + priorNotes + codexContext + template
      return structuredNote;
    });

    // Step 5: Emit Steward upsert (note + meeting counters)
    await step.do("emit-steward", async () => {
      await sendWire(this.env, {
        agent: "Archivist", type: "meeting.note", entity: "note",
        op: "upsert", payload: { note, session_id },
        idempotencyKey: `archivist:${session_id}:note`,
      });
      // Counter increments as separate events
      await sendWire(this.env, {
        agent: "Archivist", type: "meeting.count", entity: "meetings-this-week",
        op: "increment", payload: { delta: 1 },
        idempotencyKey: `archivist:${session_id}:count`,
      });
    });

    // Step 6: Emit Forge action items (one per owner-action-item)
    await step.do("emit-action-items", async () => {
      for (let i = 0; i < note.ownerActionItems.length; i++) {
        const item = note.ownerActionItems[i];
        await sendWire(this.env, {
          agent: "Archivist", type: "action-item", entity: "task",
          op: "upsert", payload: { title: item.action, due: item.due,
            source: "meeting", meeting: `${note.series}/${note.date}` },
          idempotencyKey: `archivist:${note.series}:${note.date}:ai-${String(i).padStart(2,"0")}`,
        });
      }
    });
  }
}
```

### Pattern 4: Swift Core Audio Process Tap (Two-Channel Capture)

**What:** `AudioHardwareCreateProcessTap` with `CATapDescription` for system-audio loopback; separate `AVAudioInputNode` for mic. Two channels are kept separate so the diarizer has a deterministic Owner prior.

**Key entitlements and Info.plist keys required:**

```xml
<!-- Info.plist -->
<key>NSAudioCaptureUsageDescription</key>
<string>Atlas Echo captures meeting audio to produce transcripts for your notes.</string>
<!-- Note: NSMicrophoneUsageDescription is for mic input -->
<key>NSMicrophoneUsageDescription</key>
<string>Atlas Echo uses your microphone to capture your speech during meetings.</string>
```

**Known pitfall — long-session silent zeros:** After extended uptime, the IOProc callback fires normally but every PCM sample is 0.0f. Detection: compare buffer RMS against a threshold (< 1e-7 for > 500ms = stale tap). Workaround: **both** the Process Tap AND the Aggregate Device must be destroyed and recreated. Restart of IOProc alone or recreating only the device is unreliable. [CITED: developer.apple.com/forums/thread/825780]

```swift
// Pseudocode (planning-level — not production Swift)
// Source: github.com/insidegui/AudioCap (reference implementation)
func createLoopbackTap() {
    let tapDesc = CATapDescription(stereoGlobal: true) // tap all system output
    // tapDesc.uuid is set automatically
    var tapID: AudioObjectID = kAudioObjectUnknown
    AudioHardwareCreateProcessTap(tapDesc, &tapID)

    // Create aggregate device with the tap
    let aggDevice = try AudioHardwareCreateAggregateDevice([
        kAudioSubTapUIDKey: tapDesc.uuid.uuidString,
        kAudioAggregateDeviceIsPrivateKey: true,
    ])

    // Setup IOProc callback; detect silent zeros
    AudioDeviceCreateIOProcIDWithBlock(aggDevice, nil, queue) { _, _, inData, _, _ in
        let rms = computeRMS(inData)
        if rms < 1e-7 { triggerRecreate() } // long-session watchdog
    }
}
```

### Pattern 5: FluidAudio LSEENDDiarizer on Loopback Channel

**What:** `LSEENDDiarizer` processes the loopback channel only (Owner channel is already labeled). Mic channel gets a hardcoded "Owner" label — no diarization needed on it.

```swift
// Pseudocode — planning-level
// Source: github.com/FluidInference/FluidAudio/blob/main/Documentation/Diarization/GettingStarted.md
let models = try await DiarizerModels.downloadIfNeeded()
let loopbackDiarizer = DiarizerManager() // or LSEENDDiarizer for real-time
loopbackDiarizer.initialize(models: models)

// For each loopback audio chunk (16 kHz mono Float32, min ~3s):
try loopbackDiarizer.addAudio(loopbackChunk, sourceSampleRate: 16_000)
if let update = try loopbackDiarizer.process() {
    for segment in update.finalizedSegments {
        // segment.speakerId = "Speaker 2", "Speaker 3", etc.
        // Low-confidence → flag P4, keep segment as "Speaker N"
        if segment.confidence < 0.6 { emitP4Flag(segment) }
        streamSegmentToEchoSessionDO(speaker: segment.speakerId, ...)
    }
}
// Owner channel: WhisperKit transcribes, always labeled "Owner"
```

**FluidAudio audio requirements:** 16 kHz mono Float32. Must resample from whatever Core Audio delivers (typically 44.1 kHz or 48 kHz PCM). Use `AVAudioConverter`.

### Pattern 6: Quill AX Read + Value Injection

**What:** Query the focused window's accessibility tree; inject confirmed values via `AXUIElementSetAttributeValue`. OCR via `VNRecognizeTextRequest` for canvas/web forms without AX trees.

```swift
// AX read — planning-level
// Source: developer.apple.com/documentation/applicationservices/axuielement
let systemElement = AXUIElementCreateSystemWide()
// Get focused app → focused window → walk tree for AXTextField, AXTextArea, etc.
var fields: [(label: String, element: AXUIElement)] = []

// Value injection (owner confirms in review panel first)
let err = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
// err != .success → report to Flagger P3 "value injection rejected"

// OCR fallback (Vision framework)
// Source: developer.apple.com/documentation/vision/vnrecognizetextrequest
let request = VNRecognizeTextRequest { req, err in
    let observations = req.results as? [VNRecognizedTextObservation]
    // Use boundingBox to associate labels spatially with inputs
}
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: windowCapture)
try handler.perform([request])
```

### Pattern 7: Wire Event Shapes (Echo → Cloud)

**What:** Echo emits two Wire events. Both must conform to the `@atlas/wire` `WireEvent` contract with structured idempotency keys. Echo uses the `atlas-incidents` queue (not atlas-wire) for Flagger incidents — same as all other agents since Phase 2.

```jsonc
// "transcript.ready" event — triggers Archivist Workflow via Atlas dispatch
{
  "agent": "Echo",
  "type": "transcript.ready",
  "entity": "session",
  "op": "upsert",
  "payload": {
    "session_id": "echo-2026-06-06T14-00-03",
    "transcript_r2_key": "transcripts/echo-2026-06-06T14-00-03.json",
    "audio_r2_key": null,        // null unless audio_disposition == "r2-approved"
    "audio_disposition": "local-only",
    "duration_seconds": 2888,
    "consent": "granted"
  },
  "idempotencyKey": "echo:2026-06-06T14-00-03:ready"
}

// Archivist → Steward: meeting note upsert
{
  "agent": "Archivist",
  "type": "meeting.note",
  "entity": "note",
  "op": "upsert",
  "payload": { "session_id": "echo-2026-06-06T14-00-03", /* ...note fields... */ },
  "idempotencyKey": "archivist:echo-2026-06-06T14-00-03:note"
}

// Archivist → Forge: owner action item
{
  "agent": "Archivist",
  "type": "action-item",
  "entity": "task",
  "op": "upsert",
  "payload": { "title": "Send deck", "due": "2026-06-10", "source": "meeting" },
  "idempotencyKey": "archivist:weekly-atlas-sync:2026-06-06:ai-01"
}
```

### Anti-Patterns to Avoid

- **Using `crypto.randomUUID()` for session or meeting idempotency keys:** The session_id must be a stable timestamp (`echo-<ISO-timestamp>`) so replay produces the same key. `randomUUID()` breaks idempotency.
- **Opening EchoSession WS before consent:** The DO/WS MUST open only after the owner clicks Start (D3-11). Arming (indicator + prompt) must be decoupled from capture entirely.
- **Proxying audio upload through a Worker:** The daemon uploads DIRECT to R2 via presigned URL. A Worker in the data path doubles latency and Worker CPU for binary upload. The Worker only mints the URL.
- **Hardcoding `effort: "high"` in Archivist:** Set `effort` explicitly (e.g., `"medium"`) per D5 cost discipline. Never omit it (the default for Opus is `"high"`).
- **Adding a second `atlas-wire` consumer for Echo/Archivist:** Echo is a Wire PRODUCER only. Archivist emits Wire events. Steward remains the SOLE consumer. Any new `queues.consumers` block on `atlas-wire` is a hard CI failure (Pillar 1).
- **Recreating only the Aggregate Device on silent-zeros detection:** Both the Process Tap AND the Aggregate Device must be destroyed and recreated. Partial teardown is unreliable.
- **Storing the capture app's OAuth token in `[vars]` or KV:** Token goes into the macOS Keychain (daemon side) and Cloudflare Secrets Store (cloud side); never in tracked config files.
- **Using `ws.accept()` instead of `ctx.acceptWebSocket()`:** The former does NOT enable Hibernation, keeping the DO in memory continuously. Use `ctx.acceptWebSocket()`.
- **Importing `NonRetryableError` from `cloudflare:workers`:** It is exported from `cloudflare:workflows`. The wrong import causes a runtime error, not a TypeScript error.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Speech-to-text (on-device) | Custom Whisper wrapper or direct CoreML | WhisperKit (argmax-oss-swift) | Model management, streaming, Neural Engine optimization, CoreML graph compilation — hundreds of engineering hours |
| Speaker diarization | Custom speaker clustering | FluidAudio LSEENDDiarizer | WeSpeaker/Pyannote model porting, real-time pipeline, ANE offload — non-trivial ML engineering |
| R2 presigned URL signing | Custom AWS Signature V4 | `@aws-sdk/s3-request-presigner` | AWS SigV4 is complex (canonical request, string-to-sign, signing key derivation); the SDK handles edge cases |
| WebSocket connection management | Custom ping/keepalive loop | `setWebSocketAutoResponse("ping","pong")` | Built-in Cloudflare Hibernation API; waking the DO just for pings wastes memory and billing |
| DO WebSocket state across hibernation | Re-fetch session state on every message | `serializeAttachment` / `deserializeAttachment` | Hibernation wipes in-memory fields; the attachment is the correct durable per-connection store (16 KB limit) |
| OAuth PKCE + token exchange | Custom auth flow | Workers OAuth Provider (already built in Phase 0) | PKCE, CSRF, token rotation — already solved; capture app just registers as a new client |
| On-device OCR | Custom Vision request pipeline | `VNRecognizeTextRequest` | Apple's on-device OCR is state-of-the-art; no external dependency, no privacy risk |
| Long-running task steps | Retry logic + state in a regular Worker | Cloudflare Workflows (`WorkflowEntrypoint`) | Durable execution, automatic retry, memoized step results — prevents re-doing Opus pass on network blip |

**Key insight:** The local capture stack (STT, diarization, OCR) is mature open-source tooling well-adapted to Apple Silicon. The cloud side maps exactly onto primitives already used in Phases 0–2. The only net-new cloud infrastructure is the EchoSession DO and the Archivist Workflow.

---

## Common Pitfalls

### Pitfall 1: Core Audio Silent-Zeros During Long Sessions
**What goes wrong:** After extended uptime (observed 16–44 minutes into a session), `AudioDeviceIOProc` fires normally but every PCM sample is 0.0f while the system produces audible output. All-zero buffers are indistinguishable from legitimate silence.
**Why it happens:** Triggered by sample-rate renegotiation (44.1 kHz ↔ 48 kHz when another app changes output) or Bluetooth device state changes (AirPods sleep/wake). The tap desynchronizes from the aggregate device.
**How to avoid:** Implement an RMS watchdog in the IOProc. If RMS < 1e-7 for > 500 ms of audio that the owner is actively using (check `kAudioProcessPropertyIsRunningOutput`), tear down and recreate BOTH the Process Tap AND the Aggregate Device atomically. Restart of IOProc alone is insufficient.
**Warning signs:** Segments with `"text": ""` and high confidence from WhisperKit during a meeting where participants are visibly speaking. [CITED: developer.apple.com/forums/thread/825780]

### Pitfall 2: WhisperKit Package URL Change (v1.0.0 Migration)
**What goes wrong:** Using the legacy `https://github.com/argmaxinc/WhisperKit` URL in `Package.swift` results in "no releases found" or version conflicts — the legacy repo no longer publishes releases as of v1.0.0.
**Why it happens:** Argmax consolidated WhisperKit, SpeakerKit, and TTSKit into the `argmax-oss-swift` monorepo at v1.0.0 (May 2026).
**How to avoid:** Use `https://github.com/argmaxinc/argmax-oss-swift` from `"1.0.0"`. Target the `"WhisperKit"` product specifically.
**Warning signs:** SPM resolution error "no such module 'WhisperKit'" with the legacy URL. [VERIFIED: github.com/argmaxinc/argmax-oss-swift releases]

### Pitfall 3: EchoSession WS Before Consent
**What goes wrong:** Opening the WebSocket connection to EchoSession DO before the owner confirms consent means audio segments could theoretically be streamed before consent is recorded. This violates D3-11 and the 100%-consent gate.
**Why it happens:** "Arm" (show indicator + prompt) and "capture" are easy to conflate in a single state machine.
**How to avoid:** Echo's state machine must be: IDLE → ARMED (indicator shown, prompt displayed, NO WS open) → ACTIVE (consent confirmed, WS opened, capture starts). The WS creation call is physically gated behind the consent confirmation handler.
**Warning signs:** Any code path where `EchoSession.fetch()` is called before the consent callback fires.

### Pitfall 4: `NonRetryableError` Wrong Import
**What goes wrong:** `import { NonRetryableError } from "cloudflare:workers"` compiles but throws at runtime because `NonRetryableError` is exported from `cloudflare:workflows`, not `cloudflare:workers`.
**Why it happens:** Both modules are Cloudflare built-ins and easy to confuse.
**How to avoid:** Always: `import { NonRetryableError } from "cloudflare:workflows"`. `WorkflowEntrypoint`, `WorkflowStep`, `WorkflowEvent` come from `"cloudflare:workers"`.
**Warning signs:** `TypeError: NonRetryableError is not a constructor` at Workflow step execution time. [VERIFIED: Context7 — developers.cloudflare.com/workflows]

### Pitfall 5: R2 Presigned URLs Not Testable Locally
**What goes wrong:** `wrangler dev` does not support the S3-compatible presign endpoint. Generating presigned URLs locally always fails.
**Why it happens:** The local R2 emulation (Miniflare) does not implement the S3 API presign path.
**How to avoid:** Deploy the presign Worker to a staging environment for any presign URL testing. Use integration tests against the live R2 bucket, not local dev.
**Warning signs:** 400 or 403 errors when calling `getSignedUrl` against `localhost:8787`. [CITED: developers.cloudflare.com/r2/examples/aws-sdk-js-v3/]

### Pitfall 6: FluidAudio Audio Format Requirements
**What goes wrong:** Passing 44.1 kHz stereo Float32 to FluidAudio causes incorrect transcription or crashes. FluidAudio requires **16 kHz mono Float32**.
**Why it happens:** Core Audio delivers audio in the device's native format (usually 44.1 or 48 kHz stereo).
**How to avoid:** Add an `AVAudioConverter` step after the IOProc callback to resample and downmix before feeding FluidAudio.
**Warning signs:** FluidAudio initialization succeeds but diarization output is empty or the SDK throws a format error. [CITED: github.com/FluidInference/FluidAudio README]

### Pitfall 7: Scope Creep into Second atlas-wire Consumer
**What goes wrong:** Archivist emitting Wire events directly from within a queue consumer (if Archivist were mistakenly wired as a consumer) would create a second Wire consumer — a hard CI failure.
**Why it happens:** It's tempting to have Archivist "subscribe" to Echo's ready event via the Wire.
**How to avoid:** Echo's "transcript.ready" Wire event goes to Steward (the only consumer). Steward stores it and Atlas (the orchestrator, via its scheduled or event routing) triggers the Archivist Workflow. Archivist is a **Workflow producer** of Wire events (to Steward + Forge), not a consumer.
**Warning signs:** Any `queues.consumers` block on `atlas-wire` in `apps/archivist/wrangler.jsonc`.

---

## Runtime State Inventory

> This is a greenfield phase (Echo, Quill, Archivist, EchoSession are all NEW). No renaming or migration is involved. However, two runtime states from prior phases are directly relevant:

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | None for Echo/Quill/Archivist (all new) | No migration needed |
| Live service config | Cloudflare R2 account not yet enabled (err 10042, per STATE.md) — `atlas-blobs` bucket create fails | Owner must enable R2 in Dashboard, create `atlas-blobs` bucket, apply `audio/raw/` 7-day lifecycle rule before Echo transcript storage works |
| OS-registered state | `daemon/com.atlas.bridge.plist` already registered as `com.atlas.bridge` launchd agent | Leave UNTOUCHED per D3-01; new capture daemon registers as `com.atlas.capture` (separate label) |
| Secrets/env vars | `atlas-incidents` INCIDENTS queue binding — already provisioned by Phase 2 Flagger; capture app's OAuth token = NEW (must be seeded into Keychain + Secrets Store) | New: `CAPTURE_CLIENT_ID` + `CAPTURE_CLIENT_SECRET` in Secrets Store; `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` in Secrets Store for presign Worker |
| Build artifacts | None relevant | — |

**Nothing found in category "stored data" or "OS-registered state" that requires migration** — Phase 3 is additive-only with respect to existing runtime state.

---

## Claude's Discretion — Resolved Recommendations

### Transcript-Store Shape

**Recommendation:** R2 blob at `transcripts/<session_id>.json` (no expiry, `transcripts/` prefix has no lifecycle rule) + one D1 row in a new `meetings` table:

```sql
-- migration 0005_meetings.sql (new)
CREATE TABLE IF NOT EXISTS meetings (
  session_id     TEXT PRIMARY KEY,              -- "echo-2026-06-06T14-00-03"
  calendar_event TEXT,                          -- null for audio-active
  consent        TEXT NOT NULL,                 -- "granted" | "discarded"
  audio_disposition TEXT NOT NULL,              -- "local-only" | "r2-approved" | "discarded"
  transcript_r2_key TEXT,                       -- null until uploaded
  audio_r2_key   TEXT,                          -- null unless r2-approved
  started        INTEGER NOT NULL,              -- epoch ms
  ended          INTEGER,                       -- null until session ends
  archivist_run  TEXT,                          -- Workflow instance id once triggered
  created_at     INTEGER NOT NULL
);
```

The D1 row is the index (queryable, cheap); the R2 blob is the full artifact (up to a few MB of transcript JSON).

### "Transcript Ready" Transport

**Recommendation:** Echo emits a `WireEvent` with `op:"upsert"`, `entity:"session"`, `type:"transcript.ready"` and `idempotencyKey:"echo:<session_id>:ready"`. This goes to Steward (sole Wire consumer), which stores the session row and enqueues a `vault_outbox` intent. Atlas's `AtlasCoordinator` alarm (or a dedicated Workflow trigger endpoint) detects the new session row and creates an Archivist Workflow instance with `instance_id = archivist-<session_id>` (idempotent — re-trigger = no-op if already exists).

**Alternative considered:** A dedicated HTTP endpoint on Archivist Worker that Echo POSTs to directly. Rejected because it requires a new inbound-facing Worker endpoint and bypasses the Wire's dedup/idempotency guarantees.

### Echo Calendar Awareness

**Recommendation:** EventKit (`EKEventStore`). The owner's Google Calendar is already synced to Calendar.app on the MacBook. EventKit reads it locally — no Google API call, no auth token needed from the daemon. Request `EKAuthorizationStatus.fullAccess` on first run. Watch for `EKEventStoreChangedNotification` for live updates. Calendar events with a `videoConferenceURL` or `hasVideoConference == true` are the primary arm trigger.

**Edge case:** Not all external calendars sync to Calendar.app. If the target calendar is not in EventKit results, the audio-active fallback (D3-11) handles it.

### Echo Heartbeat / Stale Detection

**Recommendation:** Echo emits a heartbeat `WireEvent` with `op:"upsert"`, `entity:"daemon-heartbeat"`, `type:"heartbeat"`, `idempotencyKey:"echo:heartbeat:<date>:<hour>"` every 15 minutes while armed or active (not while idle). FlaggerState (Phase 2 — already built) detects staleness via its existing heartbeat monitoring: if `echo:heartbeat` is not seen for >30 minutes during a known calendar meeting window (can be inferred from the `meeting.start` events on the Wire), emit P3. This integrates with the existing heartbeat detection without requiring new infrastructure.

### Presigned R2 Upload — Which Worker

**Recommendation:** Add a `/echo/presign` endpoint to the **`apps/echo`** Worker (the same Worker that exports `EchoSession`). The endpoint validates the capture app's OAuth bearer token (via the Atlas OAuthProvider scope check), verifies the session exists in D1, then returns a presigned PUT URL. This keeps Echo's cloud surface in one Worker app. The Worker needs: `BLOBS` R2 binding, `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` Secrets Store bindings, `DB` D1 binding.

### EchoSession DO Shape — Resolved

See Pattern 1 above. Key decisions:
- `getByName("echo-<ISO-timestamp>")` — stable, deterministic
- `acceptWebSocket(server, [sessionId])` — tag = sessionId for filtering on reconnect
- `server.serializeAttachment({ sessionId })` — survives hibernation wakeup
- `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` — auto ping/pong without waking DO
- DO SQLite stores `seg:<sessionId>:<idx>` per segment for reconnect-from-buffer
- `compatibility_date >= 2026-04-07` already satisfied by existing `2026-04-25` in wrangler configs

### Exact Model Pins (Claude's Discretion → Recommended)

| Model | Recommended | Rationale |
|-------|-------------|-----------|
| WhisperKit model | `large-v3-turbo` (from argmax-oss-swift v1.0.0) | Best accuracy-for-meetings tradeoff on M-series. 626 MB model file. Set `model: "large-v3-v20240930_626MB"` in WhisperKitConfig. |
| FluidAudio diarizer | `LSEENDDiarizer` (v0.15.1) | Real-time streaming, up to 10 speakers, 100ms frame updates. Correct choice for loopback channel. |
| Quill OCR | `VNRecognizeTextRequest` (Vision framework built-in) | `recognitionLevel: .accurate`, `usesLanguageCorrection: true`. Fully on-device. |

### OS-Permission Onboarding Flow Ordering

**Recommendation (ordering matters — each permission grants access to the next capability):**

1. **Microphone** (`NSMicrophoneUsageDescription`) — first, because it's the simplest prompt and immediately useful (owner mic). On macOS 26, this appears as the standard microphone access dialog.
2. **Audio Capture** (`NSAudioCaptureUsageDescription`) — second, for the loopback tap. This is the "capture audio from other apps" prompt, which is distinct from the microphone prompt.
3. **Accessibility** (System Settings → Privacy & Security → Accessibility) — third, for Quill AX read + value injection. This requires admin authentication to grant.
4. **Screen Recording** (System Settings → Privacy & Security → Screen Recording) — fourth, only for Quill's OCR fallback. Defer this prompt until the owner actually triggers Quill on a form where AX fails — avoid requesting it upfront.
5. **Calendar** (`NSCalendarsFullAccessUsageDescription`) — fifth, for EventKit meeting awareness.

Do NOT request Screen Recording and Audio Capture simultaneously — presenting both at once with a "capture" theme may alarm the owner more than necessary.

---

## Code Examples

### Complete EchoSession DO with Hibernation
```typescript
// Source: https://developers.cloudflare.com/durable-objects/best-practices/websockets
// Source: https://developers.cloudflare.com/durable-objects/api/state (serializeAttachment)
import { DurableObject } from "cloudflare:workers";

export class EchoSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session_id");
    if (!sessionId) return new Response("Missing session_id", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [sessionId]);
    server.serializeAttachment({ sessionId });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const { sessionId } = ws.deserializeAttachment() as { sessionId: string };
    const segment = JSON.parse(message as string) as TranscriptSegment;
    await this.ctx.storage.put(`seg:${sessionId}:${segment.idx}`, segment);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
    const { sessionId } = ws.deserializeAttachment() as { sessionId: string };
    await this.ctx.storage.put(`finalized:${sessionId}`, Date.now());
  }

  /** Called by the presign Worker to retrieve accumulated segments for finalization */
  async getSessionSegments(sessionId: string): Promise<TranscriptSegment[]> {
    const map = await this.ctx.storage.list<TranscriptSegment>({ prefix: `seg:${sessionId}:` });
    return Array.from(map.values()).sort((a, b) => a.idx - b.idx);
  }
}
```

### Archivist Workflow wrangler.jsonc binding
```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "atlas-archivist",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-25",
  "compatibility_flags": ["nodejs_compat"],
  "workflows": [
    { "name": "atlas-archivist", "binding": "ARCHIVIST_WF", "class_name": "ArchivistWorkflow" }
  ],
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": [] }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "atlas-db", "database_id": "<shared-id>" }
  ],
  "queues": {
    "producers": [
      { "binding": "WIRE", "queue": "atlas-wire" },
      { "binding": "INCIDENTS", "queue": "atlas-incidents" }
    ]
  },
  "r2_buckets": [{ "binding": "BLOBS", "bucket_name": "atlas-blobs" }],
  "ai": { "binding": "AI" },
  "vars": {
    "AIG_ACCOUNT_ID": "<account-id>",
    "AIG_GATEWAY_ID": "atlas-reasoning",
    "MODEL_ARCHIVIST": "claude-opus-4-8"
  }
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate WhisperKit Swift Package repo | `argmax-oss-swift` monorepo (WhisperKit + SpeakerKit + TTSKit) | May 2026 (v1.0.0) | Package URL changed; must use new repo URL |
| `ws.accept()` for DO WebSockets | `ctx.acceptWebSocket()` (Hibernation API) | Workers runtime update | Old form keeps DO in memory; new form allows eviction during silence |
| Manual close-frame reply in WebSocket | `web_socket_auto_reply_to_close` (compat_date >= 2026-04-07) | April 2026 | DO no longer needs to call `ws.close()` explicitly on `webSocketClose` |
| ScreenCaptureKit audio for loopback | `AudioHardwareCreateProcessTap` (macOS 14.4+) | macOS 14.4 / 2024 | No screen-recording permission needed for audio-only loopback |
| `new_classes` DO migrations | `new_sqlite_classes` | Wrangler v3 | Old key provisions legacy storage; new key provisions SQLite-backed DO |

**Deprecated/outdated:**

- Legacy `https://github.com/argmaxinc/WhisperKit` package URL: no new releases as of v1.0.0; use `argmax-oss-swift` monorepo.
- `new_classes` in DO migrations: use `new_sqlite_classes` for SQLite-backed DOs (all Atlas DOs use SQLite).
- `import { NonRetryableError } from "cloudflare:workers"`: wrong module — use `cloudflare:workflows`.
- BlackHole / virtual audio devices for loopback: higher friction, driver installation required, poorer consent story. `AudioHardwareCreateProcessTap` is the canonical macOS 14.4+ approach.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | macOS Keychain `SecItemAdd`/`SecItemCopyMatching` is the correct pattern for daemon OAuth token storage | Standard Stack | Low risk — alternative is environment variable in launchd plist (git-ignored); Keychain is more secure and standard for macOS daemons |
| A2 | WhisperKit model identifier is `"large-v3-v20240930_626MB"` within `WhisperKitConfig` | Standard Stack, Code Examples | Medium risk — model naming may differ in v1.0.0 monorepo; verify in `argmax-oss-swift` README / model catalog before implementing |
| A3 | `LSEENDDiarizer` accepts separate mono 16 kHz audio chunks (one per loopback channel) without needing a mixed stereo feed | Architecture Patterns | Medium risk — if the API requires a stereo stream, a different mixing/tagging approach is needed; verify in FluidAudio docs before implementation |
| A4 | EventKit on macOS 26 can read all Google Calendar events synced via Calendar.app with a single `fullAccess` grant | Claude's Discretion | Medium risk — some Google Workspace calendars may not sync fully to Calendar.app; audio-active fallback (D3-11) mitigates this |
| A5 | Apple Developer ID certificate ($99/yr) notarization flow has not changed significantly on macOS 26 (Darwin 25.4) | Standard Stack | Low risk — notarization process is stable; verify entitlements list with `codesign -d --entitlements -` on the built app |
| A6 | `serializeAttachment` on the WebSocket server object persists up to 16 KB of JSON | Architecture Patterns | Low risk — confirmed from Cloudflare docs that 16 KB is the limit; Echo session_id is << 16 KB |
| A7 | Atlas's existing `AtlasCoordinator` alarm can be extended to detect new `transcript.ready` D1 rows and trigger the Archivist Workflow without a dedicated polling mechanism | Claude's Discretion | Medium risk — may require a separate trigger endpoint on the Archivist Worker rather than extending Atlas; investigate DO alarm pattern vs. direct Workflow trigger at plan time |

---

## Open Questions (RESOLVED)

1. **Archivist Workflow trigger mechanism — alarm vs. direct trigger? — RESOLVED**
   - What we know: Echo emits a Wire event → Steward processes it → D1 `meetings` row written. Atlas needs to then kick the Archivist Workflow.
   - Resolution: **Steward triggers the Archivist Workflow via a cross-script `workflows` binding**, calling `env.ARCHIVIST_WF.create({ id: "archivist-<session_id>", params: { session_id } })` from within its existing sole `atlas-wire` consumer (NOT via AtlasCoordinator alarm polling, and NOT via a new RPC trigger endpoint). The cross-script binding is **confirmed supported in Wrangler v4**: the `WorkflowBinding` schema in `node_modules/wrangler/config-schema.json` exposes a `script_name` field ("The script where the Workflow is defined (if it's external to this Worker)"), and the Cloudflare Workflows docs document binding a Workflow defined in another Worker via `script_name` + calling `env.BINDING.create({...})` on it. The exact binding shape on `apps/steward/wrangler.jsonc` (+ `wrangler.test.jsonc`):
     `{ "binding": "ARCHIVIST_WF", "name": "atlas-archivist", "class_name": "ArchivistWorkflow", "script_name": "archivist" }` — `name`/`class_name` match `apps/archivist/wrangler.jsonc`. The instance id `archivist-<session_id>` is itself the idempotency handle (re-fire swallows the benign instance-exists collision → exactly one Workflow instance per session_id, mirroring `morning-<date>` in `apps/atlas/src/morning-chain.ts`). This is a Worker-to-Worker private binding (the same private-RPC trust posture as the D-11 invokeAgent service bindings) — NOT a public HTTP endpoint, NOT a new inbound port, and NOT a second `atlas-wire` consumer (Pillar 1 preserved). Planned in 03-03 Task 2; threat-modeled as T-03-03-06; the per-session-id "exactly one instance" idempotency is unit-tested in 03-03.

2. **Local Codex copy freshness for Quill — RESOLVED**
   - What we know: Quill needs a local read-only copy of the Codex. The Codex lives in Google Drive.
   - Resolution: The capture daemon's outbound poll channel (reusing the drain.ts pattern) fetches a fresh Codex snapshot when armed (the 24h-poll-on-arm approach) and caches it as a JSON file on disk; Quill's fill loop reads ONLY the disk cache — no cloud round-trip and no cloud LLM during Quill operation. Staleness > 48h emits a P4 flag. Planned in 03-04 Task 2 (CodexCache.swift) and consumed in 03-06 Task 2 (CodexMapper reads the local cache only).

3. **R2 not enabled on the account (err 10042) — RESOLVED**
   - What we know: `wrangler r2 bucket create atlas-blobs` fails with CF API err 10042 (per STATE.md). This blocks live Echo transcript/audio storage.
   - Resolution: This is an **owner go-live gate, not a code gate**. The owner enables R2 in the Cloudflare dashboard, creates `atlas-blobs`, and applies the `audio/raw/` 7-day lifecycle rule. All Phase-3 cloud code builds and unit-tests against mocks (R2/Codex/Wire/Forge) WITHOUT R2 being live; presigned-URL behavior is verified on staging at go-live (Pitfall 5 — presign is not testable in `wrangler dev`). No plan change required; tracked as a go-live gate alongside the Xcode toolchain and Apple Developer ID.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Cloudflare R2 (`atlas-blobs`) | Echo transcript storage, audio storage | ✗ | — | No fallback — owner must enable R2 (go-live gate); code can be built and tested without it |
| Xcode + Swift toolchain | Capture daemon build | ✗ | — | No fallback — required for Swift compilation; owner must have Xcode installed |
| Apple Developer ID account ($99/yr) | Notarization (D3-03) | [ASSUMED] ✗ | — | Without it: TCC grants reset on each rebuild (acceptable for initial development, not for go-live) |
| Node v22 (existing) | Cloud Workers tests | ✓ | v22.x | — |
| pnpm workspaces (existing) | monorepo build | ✓ | latest | — |
| `@cloudflare/vitest-pool-workers` (existing) | EchoSession DO + Archivist Workflow tests | ✓ | v4.x | — |
| macOS 14.4+ | `AudioHardwareCreateProcessTap` | ✓ | macOS 26/Darwin 25.4 | No fallback — owner confirmed on macOS 26 |
| `atlas-incidents` queue (existing) | Flagger incident path from daemon | ✓ | Phase 2 built | — |

**Missing dependencies with no fallback (block go-live, not block development):**
- Cloudflare R2 enablement
- Xcode (for building the Swift daemon)
- Apple Developer ID (for notarization)

**Missing dependencies with fallback (do not block initial development):**
- Apple Developer ID: develop with ad-hoc signing, notarize before owner go-live

---

## Validation Architecture

> `nyquist_validation: true` in `.planning/config.json` — this section is required.

### Test Framework

| Property | Value |
|----------|-------|
| Framework (cloud) | Vitest 2.x + `@cloudflare/vitest-pool-workers` v4 (real `workerd` runtime) |
| Framework (Swift) | XCTest (built into Xcode) — for Swift unit tests only |
| Config file (cloud) | `apps/echo/vitest.config.ts`, `apps/archivist/vitest.config.ts` |
| Quick run (cloud) | `pnpm test --filter @atlas/echo @atlas/archivist` |
| Full suite command | `pnpm test` (all 315 existing + new tests) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CAPTURE-01-a | EchoSession DO accepts WS, accumulates segments, finalizes with correct session_id | unit (workerd) | `pnpm test --filter @atlas/echo -- echo-session` | ❌ Wave 0 |
| CAPTURE-01-b | EchoSession reconnect-to-same-DO resumes from stored segments | unit (workerd) | `pnpm test --filter @atlas/echo -- reconnect` | ❌ Wave 0 |
| CAPTURE-01-c | Wire event `transcript.ready` shape is canonical §6.4 (type, agent, idempotencyKey) | unit (workerd) | `pnpm test --filter @atlas/echo -- wire-contract` | ❌ Wave 0 |
| CAPTURE-01-d | Replay of `transcript.ready` Wire event → Steward → `meta.changes === 0` | integration (workerd) | `pnpm test --filter @atlas/echo -- replay` | ❌ Wave 0 |
| CAPTURE-01-e | Archivist Workflow step 4 (Opus pass) sets `effort` explicitly, never omits it | unit (workerd) | `pnpm test --filter @atlas/archivist -- effort-set` | ❌ Wave 0 |
| CAPTURE-01-f | Archivist Workflow emits Steward upsert + per-owner-action-item Forge events with canonical idempotencyKey (`archivist:<series>:<date>:ai-NN`) | unit (workerd) | `pnpm test --filter @atlas/archivist -- wire-contract` | ❌ Wave 0 |
| CAPTURE-01-g | Archivist re-run on same session_id → no duplicate note/task (idempotency) | unit (workerd) | `pnpm test --filter @atlas/archivist -- idempotent` | ❌ Wave 0 |
| CAPTURE-01-h | Archivist: `consent:"discarded"` transcript → `NonRetryableError` (no note produced) | unit (workerd) | `pnpm test --filter @atlas/archivist -- consent-discarded` | ❌ Wave 0 |
| CAPTURE-01-i | Presign Worker: valid OAuth scope → returns 200 with presigned URL; invalid scope → 403 | unit (workerd) | `pnpm test --filter @atlas/echo -- presign` | ❌ Wave 0 |
| CAPTURE-01-j | Failure path: transcript not in R2 → Flagger P2 incident via `atlas-incidents` | unit (workerd) | `pnpm test --filter @atlas/archivist -- failure-path` | ❌ Wave 0 |
| CAPTURE-02 | Quill never submits / never writes Wire/Vault | manual-only | — (Swift app, no workerd test) | n/a |

### Testable vs. Untestable Split

**Testable in `@cloudflare/vitest-pool-workers` (cloud side — in the existing test suite):**

| What | How |
|------|-----|
| EchoSession DO: acceptWebSocket, serializeAttachment, segment accumulation | Instantiate DO in test, send WebSocket messages, verify storage keys |
| EchoSession DO: reconnect-to-same-DO via `getByName` | Create DO, simulate disconnect, reconnect, verify stored segments present |
| Wire event shape from Echo and Archivist | Assert `WireEvent.safeParse(event).success === true`; assert idempotencyKey format |
| Steward replay dedup on Echo/Archivist events | Two identical `sendWire` calls → `meta.changes === 0` (proven pattern from prior phases) |
| Archivist Workflow step decomposition | Mock R2/Codex/Wire; assert step ordering and output shape |
| Archivist Workflow `consent:"discarded"` → NonRetryableError | Assert Workflow instance status = "failed", no Wire events emitted |
| Presign endpoint: OAuth scope enforcement | Mock OAuthProvider context; assert 403 on missing scope |
| Flagger failure-path incidents from Archivist | Assert `INCIDENTS.send` called with correct severity on R2 object-not-found |

**Untestable in workerd (manual/owner UAT only):**

| What | Why | Observable Signal |
|------|-----|-------------------|
| Core Audio process tap capture (Swift) | Requires physical audio devices + macOS runtime | Manual: start Echo in a meeting, verify segments appear in EchoSession DO storage |
| WhisperKit STT accuracy | Requires real audio + Neural Engine | Manual: compare transcript text to actual speech |
| FluidAudio diarization (speaker labeling) | Requires real multi-speaker audio | Manual: verify "Owner" vs "Speaker 2" labeling on a real call |
| Quill AX tree read + value injection | Requires a live macOS UI with a focused form | Manual: invoke Quill hotkey on a real form, verify fields are populated correctly |
| Quill OCR fallback | Requires a non-AX form on screen | Manual: open a PDF form, invoke Quill, verify OCR-detected labels |
| No-inbound-port proof | Requires running daemon | `lsof -i -nP | grep LISTEN` — shows only Obsidian's 127.0.0.1:27124, not the capture app |
| TCC permission persistence across rebuilds | Requires Developer ID signing | Rebuild app, re-launch, verify Microphone permission not re-prompted |
| Consent gate (100% gate) | Requires live UI interaction | Manual UAT: decline consent → verify nothing in D1 `meetings` table |
| Long-session silent-zeros watchdog | Requires extended capture session | Manual UAT: run Echo for 60+ min, verify watchdog teardown-recreate fires and capture resumes |
| R2 direct upload via presigned URL | Requires deployed R2 bucket | Integration test against staging: upload a test transcript blob via presigned URL, verify it appears in R2 |

### Sampling Rate

- **Per task commit:** `pnpm test --filter @atlas/echo @atlas/archivist` (new tests only)
- **Per wave merge:** `pnpm test` (full suite — must stay green at 315+ tests)
- **Phase gate:** Full suite green before `/gsd:verify-work`; manual UAT checklist signed off (consent gate, no-inbound-port, TCC persistence, presigned upload integration)

### Wave 0 Gaps

- [ ] `apps/echo/src/__tests__/echo-session.test.ts` — covers CAPTURE-01-a, -b, -c, -d
- [ ] `apps/echo/src/__tests__/presign.test.ts` — covers CAPTURE-01-i
- [ ] `apps/archivist/src/__tests__/archivist.test.ts` — covers CAPTURE-01-e, -f, -g, -h, -j
- [ ] `apps/echo/vitest.config.ts` — new Worker config
- [ ] `apps/archivist/vitest.config.ts` — new Worker config
- [ ] `migrations/0005_meetings.sql` — D1 `meetings` table for transcript index

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | Workers OAuth Provider (already built Phase 0); capture app registers as least-privilege client per D3-02 |
| V3 Session Management | Yes | EchoSession DO per-meeting `getByName`; `serializeAttachment` for session persistence; WS token validated per request |
| V4 Access Control | Yes | Presign endpoint enforces OAuth scope (`echo:presign`); Archivist reads only own session's transcript; Quill writes only local form fields |
| V5 Input Validation | Yes | `WireEvent.safeParse()` on all Wire events; transcript JSON schema validation before Archivist Opus pass |
| V6 Cryptography | Yes | R2 presign uses AWS SigV4 (handled by SDK); OAuth token in Keychain (hardware-backed on Apple Silicon); never hand-roll signing |

### Privacy-Specific Invariants (SPEC §12)

| Invariant | Enforcement Mechanism |
|-----------|----------------------|
| Raw audio never leaves device except on approval | Audio blob upload is gated by per-session owner approval; upload path physically requires a presigned URL that is only minted when `audio_disposition == "r2-approved"` |
| Screen content never leaves device | Quill: no Wire event, no R2 upload, no cloud call in fill loop; OCR result is ephemeral in-memory |
| Consent before any capture | EchoSession DO/WS created only after consent callback fires (D3-11); D1 `meetings` row written with `consent:"granted"` |
| Daemon has no inbound port | No `Sockets`, `ListenStream`, or `NetworkBindTimeout` in launchd plist; verified with `lsof -i -nP | grep LISTEN` |
| Quill incident flags contain form name + field labels, NEVER screen content or values | IncidentRelay.swift strips values before emitting the RawIncident; code review backstop |
| Secrets (capture OAuth token) never in `[vars]`/KV/Vault/Codex | Keychain (daemon); Secrets Store (cloud); git-ignored `.dev.vars` for local dev |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Capture daemon as inbound attack surface | Elevation of Privilege | No inbound port; outbound-only; `lsof` proof required at go-live |
| Screen content exfiltration via Quill flag | Information Disclosure | Incident payload schema enforced in IncidentRelay.swift; never include values/screenshots |
| Stale EchoSession WS used after meeting ends | Spoofing | DO `webSocketClose` marks session finalized; any new WS to same session after finalization rejected |
| Audio tap silent-zeros leading to incomplete transcript | Tampering (data integrity) | RMS watchdog + P3 Flagger incident on detection; partial transcript flagged as incomplete in notes |
| R2 presigned URL leaked (valid for 1h) | Information Disclosure | URL scoped to exact key; short expiry (3600s); key prefix enforces `transcripts/` or `audio/raw/` only — not arbitrary keys |
| `NonRetryableError` import from wrong module | Denial of Service (Workflow) | TypeScript will NOT catch wrong module import; must be in test assertions |

---

## Sources

### Primary (HIGH confidence)

- Context7 (`/llmstxt/developers_cloudflare_workers_llms-full_txt`) — Durable Objects WebSocket Hibernation API (`acceptWebSocket`, `setWebSocketAutoResponse`, `serializeAttachment`), EchoSession DO patterns
- Context7 (`/websites/developers_cloudflare_workflows`) — `WorkflowEntrypoint`, `step.do`, `NonRetryableError` from `cloudflare:workflows`
- [developers.cloudflare.com/durable-objects/best-practices/websockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets) — Hibernation API best practices, `serializeAttachment` (16 KB limit)
- [developers.cloudflare.com/r2/examples/aws-sdk-js-v3/](https://developers.cloudflare.com/r2/examples/aws-sdk-js-v3/) — Presigned PUT URL pattern with `@aws-sdk/s3-request-presigner`
- [developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps](https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps) — `AudioHardwareCreateProcessTap`, `CATapDescription`
- [developer.apple.com/documentation/vision/vnrecognizetextrequest](https://developer.apple.com/documentation/vision/vnrecognizetextrequest) — Vision OCR
- [developer.apple.com/documentation/applicationservices/axuielement](https://developer.apple.com/documentation/applicationservices/axuielement) — AXUIElement read + inject
- [developer.apple.com/documentation/eventkit/accessing-calendar-using-eventkit-and-eventkitui](https://developer.apple.com/documentation/eventkit/accessing-calendar-using-eventkit-and-eventkitui) — EventKit calendar access

### Secondary (MEDIUM confidence)

- [github.com/argmaxinc/argmax-oss-swift](https://github.com/argmaxinc/argmax-oss-swift) releases — WhisperKit v1.0.0 in `argmax-oss-swift` monorepo (Swift 6, `from: "1.0.0"`)
- [github.com/FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio) README + GettingStarted.md — LSEENDDiarizer API, 16 kHz mono Float32 requirement, v0.15.1
- [github.com/insidegui/AudioCap](https://github.com/insidegui/AudioCap) — Reference implementation for `AudioHardwareCreateProcessTap` + aggregate device pattern; macOS 14.4+
- [developer.apple.com/forums/thread/825780](https://developer.apple.com/forums/thread/825780) — Silent-zeros long-session pitfall + destroy-and-recreate workaround
- npm registry — `@aws-sdk/s3-request-presigner@3.1063.0`, `@aws-sdk/client-s3@3.1063.0`, `aws4fetch@1.0.20` (all slopcheck [OK])

### Tertiary (LOW confidence — marked [ASSUMED] where used)

- Apple Keychain `SecItemAdd`/`SecItemCopyMatching` for daemon OAuth token storage — training knowledge; standard pattern
- WhisperKit model identifier `"large-v3-v20240930_626MB"` — from CLI documentation; verify in v1.0.0 model catalog
- Apple Developer ID notarization unchanged on macOS 26 — assumed based on stable process; verify entitlements

---

## Metadata

**Confidence breakdown:**

- EchoSession DO WebSocket Hibernation: HIGH — verified via Context7 + official CF docs
- Archivist Workflow durable steps + NonRetryableError import: HIGH — verified via Context7
- R2 presigned PUT URL (cloud Worker): HIGH — verified via official R2 docs + slopcheck OK
- WhisperKit v1.0.0 monorepo migration: HIGH — verified via GitHub releases API (v1.0.0 May 2026)
- FluidAudio LSEENDDiarizer API: MEDIUM — verified via GitHub README + GettingStarted.md (v0.15.1 Jun 2026)
- Core Audio process tap + silent-zeros pitfall: MEDIUM — verified via Apple dev docs + Apple forums
- Swift app structure (launchd, Keychain, AX API): MEDIUM — verified via official Apple docs; Swift specifics ASSUMED
- OS-permission onboarding ordering: LOW — no official ordering specified; reasoning-based recommendation

**Research date:** 2026-06-06
**Valid until:** 2026-07-06 (stable cloud APIs: 30 days; SwiftKit/FluidAudio ship ~weekly — re-verify versions before implementing)
