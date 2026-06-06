---
phase: 03-capture-local
plan: "05"
subsystem: echo-capture-pipeline
tags: [swift, core-audio, whisperkit, fluidaudio, consent, websocket, eventkit]
dependency_graph:
  requires: ["03-04", "03-02", "03-03"]
  provides: ["Echo native capture pipeline — AudioTap + TranscriptionPipeline + ConsentGate + EchoSession"]
  affects: ["03-06", "archivist"]
tech_stack:
  added:
    - CoreAudio AudioHardwareCreateProcessTap (macOS 14.2+)
    - EventKit EKEventStore (fullAccess)
    - URLSessionWebSocketTask (outbound WS client)
  patterns:
    - Two-channel diarization prior (mic=Owner deterministic, loopback=FluidAudio)
    - ConsentGate IDLE/ARMED/ACTIVE state machine (physical consent gate)
    - Silent-zeros RMS watchdog (destroy+recreate BOTH tap AND aggregate device)
    - Reconnect-to-same-session WS (stable session ID per meeting)
key_files:
  created:
    - capture/Sources/Echo/AudioTap.swift
    - capture/Sources/Echo/TranscriptionPipeline.swift
    - capture/Sources/Echo/ConsentGate.swift
    - capture/Sources/Echo/CalendarMonitor.swift
    - capture/Sources/Echo/EchoSession.swift
    - capture/Sources/Echo/EchoController.swift
    - capture/Tests/EchoTests/AudioWatchdogTests.swift
    - capture/Tests/EchoTests/ConsentGateTests.swift
    - capture/Tests/EchoTests/TranscriptContractTests.swift
  modified:
    - capture/Sources/App/AppDelegate.swift
    - capture/Package.swift
decisions:
  - "isVideoConference EKEvent property does not exist in EventKit SDK — replaced with URL/notes pattern matching for Zoom/Meet/Teams/Webex conferencing links (Rule 1 bug fix)"
  - "arm() UI hooks run outside stateQueue.sync — added didArm flag to gate UI callbacks on actual state transition (Rule 1 bug fix)"
  - "Cloud WS route is an open dependency — apps/echo/src/index.ts has no route to EchoSession DO yet; EchoSession.open() constructs the correct URL and will work once cloud adds the authenticated /echo/ws route with authenticateCapture() guard"
metrics:
  completed: "2026-06-06"
  tasks: 2
  files: 11
---

# Phase 3 Plan 05: Echo Native Capture Pipeline Summary

Two-channel CoreAudio process-tap + WhisperKit STT + FluidAudio diarization + physical consent gate + outbound WS EchoSession client wired end-to-end inside the 03-04 shell. 64 tests green, 0 failures.

## What Was Built

### Task 1 — AudioTap + TranscriptionPipeline + AudioWatchdogTests

**`capture/Sources/Echo/AudioTap.swift`** — Core Audio process-tap loopback (macOS 14.2+).
- `CATapDescription(stereoGlobalTapButExcludeProcesses: [])` + `isPrivate = true` private aggregate device.
- IOProc with correct 5-parameter `AudioDeviceIOBlock` signature.
- Silent-zeros RMS watchdog: if `computeRMS() < 1e-7` for > 500ms while output running, tears down AND recreates BOTH the Process Tap AND the Aggregate Device atomically (Pitfall 1 invariant).
- Pure testable functions: `computeRMS()`, `rmsThresholdFired()` — no hardware required.
- `@available(macOS 14.2, *)` on tap creation methods; `#available` runtime guards in public API.
- P3 incident emitted on each watchdog fire via `IncidentRelay.shared`.

**`capture/Sources/Echo/TranscriptionPipeline.swift`** — On-device STT + diarization.
- Two-channel diarization prior (D3-06): mic channel → hardcoded "Owner" (deterministic); loopback channel → FluidAudio `performCompleteDiarization()` batch API.
- WhisperKit `transcribe(audioArray: [Float])` for both channels.
- Format helpers: `downmixToMono()`, `resample()` (linear interpolation), `toMono16k()` — all pure functions.
- Low-confidence splits (qualityScore < 0.6): KEPT as "Speaker N" + P4 incident (T-03-05-06 — never silently dropped).
- `TranscriptSegment` struct matches 03-02 cloud contract exactly: `speaker, text, start_ts, end_ts, confidence, idx`.

**`capture/Tests/EchoTests/AudioWatchdogTests.swift`** — 16 pure-logic tests.
- `computeRMS`: empty buffer, all-zero, known amplitude, single sample.
- `rmsThresholdFired`: fires on 600ms zeros output-running; NOT on 400ms; NOT when output stopped; NOT on RMS above threshold; boundary at 500.0ms; custom threshold parameters.
- `downmixToMono`, `resample` helpers.
- All 16 pass with no real audio hardware.

**`capture/Package.swift`** — Echo library target (WhisperKit + FluidAudio deps) + EchoTests XCTest target added.

Commit: `35e03da`

### Task 2 — ConsentGate + CalendarMonitor + EchoSession + EchoController + AppDelegate

**`capture/Sources/Echo/ConsentGate.swift`** — IDLE → ARMED → ACTIVE state machine.
- ARMED: shows menubar indicator + consent prompt. WS physically unreachable. No audio buffered.
- ACTIVE: only reachable via `confirm()`. `onActivate` callback fires — this is the sole gate for `EchoSession.open()` and `AudioTap.start()`.
- Decline: `onActivate` NEVER fires; nothing persisted; P3 incident emitted; state → idle.
- `ConsentGateUIHook` struct (injected, no AppKit dependency) — fully testable without NSApplication.
- `didArm` flag ensures UI callbacks only fire on actual state transitions (not on repeated `arm()` calls).

**`capture/Sources/Echo/CalendarMonitor.swift`** — EventKit calendar monitor.
- `EKEventStore.requestFullAccessToEvents()` on macOS 14+.
- Video-conference detection: URL/notes pattern matching for Zoom, Google Meet, Teams, Webex, Chime, Whereby.
- `#atlas-audio-active` note tag for manual arm.
- 60-second polling timer + `EKEventStoreChangedNotification` observer.
- Arm window: 5 minutes before event start; catches mid-event daemon startup.

**`capture/Sources/Echo/EchoSession.swift`** — Outbound WebSocket client.
- Session ID: `echo-<ISO-8601-timestamp>` (stable per meeting, D3-08).
- WS upgrade: `wss://<host>/echo/ws?session_id=<id>` with `Authorization: Bearer <token>` from Keychain.
- Reconnect-to-same-session: exponential backoff (1s/2s/4s/8s/16s), up to 5 attempts; P2 on persistent failure.
- 15-minute heartbeat ping to keep WS alive during silent meeting segments.
- `finalize()`: emits `transcript.ready` Wire event with `idempotencyKey: "echo:<sessionID>:ready"`, presign-uploads transcript JSON; raw audio upload ONLY if `audioDisposition == "r2-approved"` (privacy default: skip).
- `send(_:)`: real-time segment push + local buffer for finalize.

**`capture/Sources/Echo/EchoController.swift`** — Wiring layer.
- CalendarMonitor → ConsentGate.arm() → (consent) → EchoSession.open() + AudioTap.start() + TranscriptionPipeline.prepare().
- AudioTap delegate → pipeline ingestion.
- Pipeline delegate → EchoSession.send() (live push).
- Watchdog fired → `transcriptIncomplete = true` → P3 incident on finalize.
- `confirmConsent()` / `declineConsent()` entry points for AppDelegate.

**`capture/Sources/App/AppDelegate.swift`** — Real Echo integration (replaced stubs).
- Builds `ConsentGateUIHook` driving menubar icon (idle/armed/active states).
- Presents `NSAlert` consent prompt; routes decision to `EchoController.confirmConsent()` / `declineConsent()`.
- `echoController.startMonitoring()` on launch; `echoController.stop()` on terminate.

**`capture/Tests/EchoTests/ConsentGateTests.swift`** — 17 tests.
- All state transitions verified.
- Critical: `testDecline_onActivate_isNeverFired` — proves WS cannot open on decline.
- `testPreConsentCapture_impossible_byConstruction` — proves ARMED state cannot trigger capture.
- All 17 pass.

**`capture/Tests/EchoTests/TranscriptContractTests.swift`** — 12 tests.
- `idempotencyKey` format: `echo:<session_id>:ready` (D3-08).
- TranscriptSegment JSON keys match 03-02 cloud contract exactly (6 keys).
- Codable round-trip, idx ordering, EchoSession ID prefix.
- Low-confidence threshold constant == 0.6 (T-03-05-06).
- All 12 pass.

Commit: `8b47285`

## Test Results

```
Executed 64 tests, with 0 failures (0 unexpected)
  AudioWatchdogTests:     16 tests — 0 failures
  ConsentGateTests:       17 tests — 0 failures
  TranscriptContractTests: 12 tests — 0 failures
  SharedTests (prior):    19 tests — 0 failures
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `EKEvent.isVideoConference` does not exist in EventKit**
- **Found during:** Task 2 — `swift build` error
- **Issue:** EventKit's `EKEvent` type has no `isVideoConference` property on macOS. The plan referenced this as an "EventKit-native flag" but it is not in the SDK.
- **Fix:** Replaced with URL/notes pattern matching for common video conferencing URLs (Zoom, Google Meet, Teams, Webex, Chime, Whereby). Added `hasVideoConferenceURL(_:)` private method.
- **Files modified:** `capture/Sources/Echo/CalendarMonitor.swift`
- **Commit:** `8b47285`

**2. [Rule 1 - Bug] `arm()` UI hooks fired even on repeated calls (no-op path)**
- **Found during:** Task 2 — `testArm_whenAlreadyArmed_isNoOp` failed (armCount == 2, expected 1)
- **Issue:** The `guard _state == .idle else { return }` early-returned from the `stateQueue.sync {}` closure but NOT from the outer `arm()` function. The UI callbacks (`showArmedIndicator`, `showConsentPrompt`) were unconditionally called after the sync block.
- **Fix:** Added `didArm` flag inside the sync block; outer code guarded on `didArm`.
- **Files modified:** `capture/Sources/Echo/ConsentGate.swift`
- **Commit:** `8b47285`

## Cloud WS Route (Open Dependency)

`apps/echo/src/index.ts` currently routes ONLY `/health` and `/echo/presign`. There is NO public WebSocket route to the `EchoSession` DO yet.

`EchoSession.open()` constructs the correct URL: `wss://<host>/echo/ws?session_id=<id>` and presents `Authorization: Bearer <token>` via `authenticateCapture()`. The cloud route must be added to `apps/echo/src/index.ts` BEFORE this endpoint goes live.

**Security invariant:** When that route is added, it MUST call `authenticateCapture(request, env)` from `apps/echo/src/auth.ts` (constant-time bearer verify, fail-closed 401) BEFORE forwarding the WS upgrade to the EchoSession DO. Exposing the DO unauthenticated is a hard pillar violation.

This is the single remaining gap between the local daemon (complete) and the cloud backend. Tracked for 03-06 or a dedicated cloud-side micro-plan.

## Known Stubs

**`EchoSession.uploadRawAudio()`** — obtains presign URL for `audio/raw/<sessionID>/audio.caf` but the raw audio byte stream is not wired through (the actual CAF data would come from an AVAudioEngine recorder in EchoController). The presign URL acquisition is correct; the PUT call is a deferred wiring task for when AVAudioEngine mic recording is added (not in scope for 03-05 which focused on the loopback tap and pipeline). Default behavior (no upload) is privacy-correct.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: open-ws-route | apps/echo/src/index.ts | Cloud WS route to EchoSession DO does not exist yet — when added, must require `authenticateCapture()` before forwarding upgrade (documented above). |
| threat_flag: keychain-token-absent | capture/Sources/Echo/EchoSession.swift | If bearer token missing from Keychain, WS open silently fails with a P2 incident; does not block consent UI (by design — D3-02 go-live gate). |

## Self-Check: PASSED

All 9 created files found on disk. Both task commits verified in git log.
- `35e03da` — feat(03-05): two-channel audio tap + WhisperKit/FluidAudio pipeline + watchdog tests
- `8b47285` — feat(03-05): consent gate, calendar monitor, EchoSession WS client, controller wiring
