---
phase: 03-capture-local
plan: 04
subsystem: capture-daemon
tags: [swift, macos, launchd, keychain, outbound-only, no-inbound-port, privacy-boundary, xctest]
dependency_graph:
  requires: [03-02]
  provides:
    - capture/Package.swift
    - capture/Sources/App/CaptureApp.swift
    - capture/Sources/App/AppDelegate.swift
    - capture/Sources/Shared/Auth.swift
    - capture/Sources/Shared/OutboxChannel.swift
    - capture/Sources/Shared/IncidentRelay.swift
    - capture/Sources/Shared/CodexCache.swift
    - capture/com.atlas.capture.plist
    - capture/entitlements/Atlas-Capture.entitlements
    - capture/Info.plist
    - capture/Tests/SharedTests/AuthTests.swift
    - capture/Tests/SharedTests/OutboxChannelTests.swift
    - capture/Tests/SharedTests/IncidentRelayTests.swift
  affects: [capture/]
tech_stack:
  added:
    - "Swift 6.3.1 executable package (macOS 14.4+)"
    - "argmax-oss-swift from '1.0.0' (WhisperKit product — monorepo URL, NOT legacy argmaxinc/WhisperKit)"
    - "FluidAudio from '0.15.1' (speaker diarization, LSEENDDiarizer)"
    - "macOS Security framework (SecItemAdd/SecItemCopyMatching/SecItemUpdate/SecItemDelete)"
    - "HTTPDataFetcher protocol (URLSession-injectable for testing without subclassing)"
  patterns:
    - "launchd LaunchAgent (KeepAlive/RunAtLoad, ZERO inbound-listener keys)"
    - "Keychain-backed OAuth bearer (SecItem API, never UserDefaults/plist/[vars])"
    - "Swift actor (OutboxChannel) — serial drain loop, ack-only-after-success"
    - "CommandExecutor protocol (injectable for OutboxChannel tests)"
    - "RawIncident struct — fieldLabels only, no values field by construction (T-03-04-03)"
    - "HTTPDataFetcher protocol extension on URLSession (injectable mock, no deprecated subclassing)"
key_files:
  created:
    - capture/Package.swift
    - capture/Sources/App/CaptureApp.swift
    - capture/Sources/App/AppDelegate.swift
    - capture/Sources/Shared/Auth.swift
    - capture/Sources/Shared/OutboxChannel.swift
    - capture/Sources/Shared/IncidentRelay.swift
    - capture/Sources/Shared/CodexCache.swift
    - capture/com.atlas.capture.plist
    - capture/entitlements/Atlas-Capture.entitlements
    - capture/Info.plist
    - capture/Tests/SharedTests/AuthTests.swift
    - capture/Tests/SharedTests/OutboxChannelTests.swift
    - capture/Tests/SharedTests/IncidentRelayTests.swift
  modified: []
decisions:
  - "D-03-04-01: HTTPDataFetcher protocol instead of URLSession subclassing — URLSession.init() is deprecated in macOS 10.15+ and its data(for:) method cannot be cleanly overridden without a protocol; introduced HTTPDataFetcher: Sendable protocol with URLSession conforming via extension, enabling clean injection in OutboxChannelTests without any deprecated APIs"
  - "D-03-04-02: Auth.service + Auth.account internal (not private) — tests need a unique Keychain account per test for isolation; making them internal allows AuthTests to read them via an extension without exposing them publicly"
  - "D-03-04-03: Shared implementations written in Task 1 alongside shell — AppDelegate imports Shared; for Task 1 (swift build) to compile, Auth/OutboxChannel/IncidentRelay/CodexCache must exist; full implementations written in Task 1, Task 2 adds tests and refines the types"
metrics:
  duration: "~35 minutes"
  completed: "2026-06-06"
  tasks: 2
  files_created: 13
  files_modified: 0
---

# Phase 3 Plan 4: Swift Capture-App Shell + Privacy Boundary Summary

**One-liner:** Swift SPM package shell (AtlasCapture, macOS 14.4+) with launchd plist (zero inbound-listener keys), Keychain-only OAuth bearer (Auth.swift), serial ack-after-success drain actor (OutboxChannel.swift), value-stripped IncidentRelay (RawIncident labels-only by construction), local Codex cache, and 19 XCTest privacy-boundary assertions — all green.

## What Was Built

### Task 1: Capture-app shell

**capture/Package.swift** — Swift SPM package:
- Targets: `Shared` library + `AtlasCapture` executable + `SharedTests` XCTest target
- SPM dependencies: `argmax-oss-swift` from `"1.0.0"` (WhisperKit, new monorepo URL — NOT the legacy argmaxinc/WhisperKit URL per Pitfall 2) and `FluidAudio` from `"0.15.1"`
- Platform: macOS 14.4+ (AudioHardwareCreateProcessTap requires 14.4+, D3-04)
- `swift build`: Build complete (327 steps, no warnings after actor-isolation fix)

**capture/Sources/App/CaptureApp.swift** — `@main` struct with `NSApplicationDelegateAdaptor(AppDelegate.self)`. LSUIElement menubar-only app (no Dock icon, no system menu bar). Settings scene is an empty no-op; the real UI is the NSStatusItem.

**capture/Sources/App/AppDelegate.swift** — `NSStatusItem` menubar indicator (stub icon, waveform.circle); wires `Auth.shared` and `OutboxChannel.drainLoop()` at launch; calls `channel.cancel()` (async, via Task) on graceful shutdown. UI surfaces for 03-05 (Echo recording indicator, consent prompt) and 03-06 (Quill review panel) are stub comments.

**capture/com.atlas.capture.plist** — launchd LaunchAgent:
- Label: `com.atlas.capture` (separate from `com.atlas.bridge`)
- ProgramArguments: built Swift binary (placeholder USERNAME)
- `RunAtLoad: true`, `KeepAlive: true`
- **ZERO inbound-listener keys**: no Sockets, no ListenStream, no NetworkBindTimeout (T-03-04-01 by construction — `grep -E "Sockets|ListenStream|NetworkBindTimeout" com.atlas.capture.plist` returns nothing)
- No EnvironmentVariables secret block (token in Keychain, not env var — key difference from com.atlas.bridge)

**capture/entitlements/Atlas-Capture.entitlements** — Developer-ID signing entitlements:
- `com.apple.security.device.audio-input` — microphone input (Echo mic channel)
- `com.apple.developer.audio.multi-channel-capture` — Core Audio process tap for loopback (D3-04; verify exact string at go-live against insidegui/AudioCap + Apple WWDC docs)
- `com.apple.security.hardened-runtime: true` (required for notarization, D3-03)
- App Sandbox: NOT enabled (correct for a privileged launchd agent with process-tap + AX access)

**capture/Info.plist** — LSUIElement=YES; usage description keys:
- `NSMicrophoneUsageDescription` (Echo mic channel)
- `NSAudioCaptureUsageDescription` (Core Audio loopback tap — the correct, honest prompt, not Screen Recording)
- `NSCalendarsFullAccessUsageDescription` (EventKit for calendar-arm, D3-11)
- `NSScreenCaptureUsageDescription`: **intentionally absent** — Quill requests Screen Recording lazily on first OCR use, not upfront at app launch (D3-04 rationale, D3-07)

**Shared implementations (written in Task 1 for compilation, tested in Task 2):**

**Auth.swift** — Keychain-backed OAuth bearer:
- `init(service:account:)` injectable (internal service/account for test isolation)
- `readToken()`: SecItemCopyMatching → extract as String; throws `AuthError.tokenMissing` if absent (loud fatal, never fabricates)
- `store(token:)`: SecItemUpdate (update path) | SecItemAdd (first grant)
- `deleteToken()`: SecItemDelete
- `authorize(_:URLRequest)`: sets `Authorization: Bearer <token>` on outbound requests
- No system-preferences storage, plist, [vars], Vault, or Codex reference (T-03-04-02)

**OutboxChannel.swift** — Outbound poll/drain/ack actor (mirrors daemon/src/drain.ts):
- `HTTPDataFetcher` protocol (URLSession conforms via extension — no deprecated subclassing)
- `CommandExecutor` protocol (injectable for tests)
- `public actor OutboxChannel`: serial `drainOnce()` (for loop, never TaskGroup); `ack(idem:)` called ONLY after successful execute; on failure throws `OutboxChannelError.executeFailed(idem, underlyingError:)` and NEVER calls ack (T-03-04-04)
- `drainLoop()`: exponential backoff (5s → 300s cap); launchd KeepAlive handles process restart

**IncidentRelay.swift** — Value-stripped Flagger incident relay:
- `RawIncident` struct: fields = severity, formName?, fieldLabels, kind, sourceAgent, runId?, note
- **No values field by construction** (T-03-04-03): no `fieldValues`, `screenContent`, `rawText`, `filledValue`, `screenshot`, or `extractedText` field exists — the privacy invariant is structural, not runtime
- `IncidentRelay.emit(_:)` catches auth errors gracefully (missing token = log + return, not crash)

**CodexCache.swift** — Local read-only Codex snapshot for Quill:
- Disk cache at `~/Library/Application Support/com.atlas.capture/codex-cache.json`
- `arm()`: refreshes if missing or >24h stale; starts 24h periodic timer
- Staleness >48h: emits P4 via IncidentRelay (non-blocking)
- `read()`: returns cached Data without any cloud round-trip (zero latency during Quill fill loop)

### Task 2: XCTest privacy-boundary assertions

**AuthTests.swift** (7 tests — all green):
- `testReadToken_whenNotSeeded_throwsTokenMissing` — missing token = loud fatal
- `testStore_thenReadToken_returnsStoredToken` — Keychain round-trip
- `testStore_calledTwice_updatesToken` — SecItemUpdate path
- `testDeleteToken_thenReadToken_throwsTokenMissing` — delete + read = fatal
- `testAuthorize_setsAuthorizationHeader` — `Authorization: Bearer <token>`
- `testAuthorize_whenTokenMissing_throwsTokenMissing` — authorize without token = fatal
- `testAuth_containsNoSystemPreferenceReference_inSourceCode` — structural assertion

**OutboxChannelTests.swift** (7 tests — all green):
- `testDrainOnce_onSuccess_acksAfterExecute` — ack called once after execute succeeds
- **`testDrainOnce_onExecuteFailure_doesNotAck_commandStaysPending`** — T-03-04-04 assertion: `ackCalls.count == 0` when execute fails; command stays pending
- `testDrainOnce_processesCommandsSerially` — FIFO order, 3 commands, 3 acks
- `testDrainOnce_partialFailure_stopsAtFailedCommand` — first acked, second fails → third never executed
- `testDrainOnce_emptyPoll_drainsZero` — 0 acks for empty poll
- `testDrainOnce_pollRequest_isGET` — poll is GET
- `testDrainOnce_missingToken_returnsZero_gracefully` — go-live gate handled (returns 0, no crash)

**IncidentRelayTests.swift** (5 tests — all green):
- **`testRawIncident_hasNoValuesField_byConstruction`** — T-03-04-03 assertion: JSON keys `values`/`fieldValues`/`screenContent`/`rawText`/`filledValue`/`screenshot`/`extractedText` are ALL nil; `severity`/`formName`/`fieldLabels` are present
- `testRawIncident_withNoFormContext_isValidIncident` — auth errors (no form context) are valid
- `testRawIncident_noteDescribesIncident_notFieldContent` — note describes event, not field value
- `testIncidentRelay_emitWithMissingToken_handlesGracefully` — missing token = log + return, not crash
- `testRawIncident_severityValues_areWithinSpec` — P1–P4 round-trip

## Verification Results

- `swift build` in `capture/`: Build complete (327 steps, no errors, no warnings)
- `swift test` in `capture/`: 19/19 passed (AuthTests 7, IncidentRelayTests 5, OutboxChannelTests 7)
- `grep -E "Sockets|ListenStream|NetworkBindTimeout" capture/com.atlas.capture.plist`: (empty — PASS)
- `git diff --stat daemon/`: (empty — daemon untouched, D3-01)
- `grep "argmax-oss-swift" capture/Package.swift`: present
- `grep "argmaxinc/WhisperKit" capture/Package.swift`: (empty — PASS, Pitfall 2 avoided)
- `grep "UserDefaults" capture/Sources/Shared/Auth.swift`: (empty — PASS, T-03-04-02)
- `grep -E "var fieldValues|var screenContent" capture/Sources/Shared/IncidentRelay.swift`: (empty — PASS, T-03-04-03)
- `pnpm test` (full suite): unaffected — capture/ is outside the pnpm workspace globs

## Owner Go-Live Gates (blocked-but-expected — NOT failures)

These are gating criteria for production deployment, not code failures:
- **Apple Developer account + Developer-ID signing** ($99/yr, D3-03): `swift build -c release` produces a signable binary; signing + notarization require the account.
- **Loading the launchd plist** (`launchctl load ~/Library/LaunchAgents/com.atlas.capture.plist`): requires the signed binary at the configured path; not executable until signed.
- **TCC permission grants** (Microphone, audio-capture, Accessibility, Calendar): macOS prompts at first use; cannot be pre-granted from code.
- **Seeding the OAuth token** (`Auth.shared.store(token:)`) into Keychain: requires D3-02 OAuth client registration + token exchange (Secrets Store cloud side ready since 03-02 ECHO_CAPTURE_TOKEN).
- **`lsof -i -nP | grep LISTEN` no-inbound-port proof**: owner runs at install to confirm ZERO ports owned by AtlasCapture (gating criterion, T-03-04-01).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Actor-isolation warning in AppDelegate.applicationWillTerminate**
- **Found during:** Task 1 (swift build output)
- **Issue:** `outboxChannel?.cancel()` in synchronous context calling actor-isolated method — Swift 6 treats this as a warning that flags an implicit async call
- **Fix:** Wrap in `Task { await channel.cancel() }` (correct async call from synchronous context)
- **Files modified:** `capture/Sources/App/AppDelegate.swift`
- **Commit:** 15e63f0

**2. [Rule 2 - Missing critical functionality] HTTPDataFetcher protocol for test injection**
- **Found during:** Task 2 (OutboxChannelTests.swift first draft used URLSession subclassing)
- **Issue:** URLSession.init() deprecated macOS 10.15+; subclassing URLSession for test injection is the deprecated pattern; `data(for:)` cannot be cleanly overridden without protocol
- **Fix:** Introduced `HTTPDataFetcher: Sendable` protocol with `URLSession` conforming via extension; `OutboxChannel`, `IncidentRelay`, `CodexCache` now accept `any HTTPDataFetcher` (injectable); `MockHTTPFetcher` in tests implements the protocol directly (no deprecated subclassing)
- **Files modified:** `capture/Sources/Shared/OutboxChannel.swift`, `IncidentRelay.swift`, `CodexCache.swift`
- **Commit:** cf22165

**3. [Rule 2 - Missing critical functionality] Auth.service + Auth.account internal access**
- **Found during:** Task 2 (AuthTests.swift required per-test Keychain isolation)
- **Issue:** Tests needed `Auth(service:account:)` injectable init for Keychain isolation; service/account were private blocking test extension access
- **Fix:** Changed `private let service/account` to `internal let service/account`; added public `init(service:account:)` as the designated init; `Auth.shared` uses the default production values
- **Files modified:** `capture/Sources/Shared/Auth.swift`
- **Commit:** cf22165

**4. [Rule 3 - Blocking] plist comment contained the forbidden string strings**
- **Found during:** Task 1 acceptance checks (grep for Sockets/ListenStream/NetworkBindTimeout matched a comment)
- **Issue:** The plist comment mentioning "NO Sockets block, NO ListenStream, NO NetworkBindTimeout" caused the acceptance grep to return a false positive
- **Fix:** Reworded comment to avoid the exact strings while preserving the documentation intent
- **Files modified:** `capture/com.atlas.capture.plist`
- **Commit:** 15e63f0

**5. [Rule 3 - Blocking] Same false positive for Package.swift comment (argmaxinc/WhisperKit) and Auth.swift comment (UserDefaults)**
- **Found during:** Task 1 acceptance checks
- **Fix:** Reworded comments in Package.swift and Auth.swift to avoid exact forbidden strings while keeping the documentation intent (warn about the legacy URL and system-preferences storage)
- **Commit:** 15e63f0

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| (all mitigated) | capture/ | T-03-04-01 through T-03-04-05 all mitigated by construction |

**T-03-04-01** (no inbound port): plist has zero inbound-listener keys; `lsof` proof at owner go-live.
**T-03-04-02** (Keychain-only token): Auth.swift uses only SecItem API; no system-preferences storage reference.
**T-03-04-03** (values stripped): RawIncident has no values/screenContent field; IncidentRelayTests asserts JSON shape.
**T-03-04-04** (no-ack-on-failure): OutboxChannelTests asserts `ackCalls.count == 0` when execute fails.
**T-03-04-05** (outbound only): HTTPDataFetcher-based URLSession calls only; no listening socket opened.

No new threat surface beyond what the threat register covers.

## Self-Check: PASSED

- capture/Package.swift: FOUND (argmax-oss-swift from "1.0.0"; FluidAudio from "0.15.1"; macOS .v14)
- capture/Sources/App/CaptureApp.swift: FOUND (@main, NSApplicationDelegateAdaptor)
- capture/Sources/App/AppDelegate.swift: FOUND (NSStatusItem, OutboxChannel.drainLoop)
- capture/Sources/Shared/Auth.swift: FOUND (SecItemCopyMatching, SecItemAdd, AuthError.tokenMissing)
- capture/Sources/Shared/OutboxChannel.swift: FOUND (public actor, HTTPDataFetcher, drainOnce, drainLoop)
- capture/Sources/Shared/IncidentRelay.swift: FOUND (RawIncident struct with fieldLabels, no values field)
- capture/Sources/Shared/CodexCache.swift: FOUND (24h refresh, P4 on 48h staleness, disk cache)
- capture/com.atlas.capture.plist: FOUND (Label=com.atlas.capture, RunAtLoad, KeepAlive, no inbound keys)
- capture/entitlements/Atlas-Capture.entitlements: FOUND (audio-input, hardened-runtime)
- capture/Info.plist: FOUND (LSUIElement=YES, NSMicrophoneUsageDescription, NSAudioCaptureUsageDescription)
- capture/Tests/SharedTests/AuthTests.swift: FOUND (7 tests)
- capture/Tests/SharedTests/OutboxChannelTests.swift: FOUND (7 tests, T-03-04-04 assertion)
- capture/Tests/SharedTests/IncidentRelayTests.swift: FOUND (5 tests, T-03-04-03 assertion)
- Commits 15e63f0 (Task 1), cf22165 (Task 2): FOUND in git log
- `swift build`: Build complete (no errors)
- `swift test`: 19/19 passed
- `git diff --stat daemon/`: empty (daemon untouched, D3-01)
