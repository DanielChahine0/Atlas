---
phase: 03-capture-local
verified: 2026-06-06T13:50:00Z
status: human_needed
score: 12/12 must-haves verified (code-complete)
overrides_applied: 0
human_verification:
  - test: "Consent gate is 100% enforced in live capture (no pre-consent audio)"
    expected: "Decline consent → nothing persisted; no D1 meetings row; no transcript; P3 logged"
    why_human: "Requires physical macOS runtime, real meeting audio, live UI interaction"
  - test: "Non-dismissable recording indicator visible for full live session"
    expected: "NSStatusItem recording indicator stays visible and non-dismissable throughout live meeting"
    why_human: "Requires live UI verification on a real macOS device"
  - test: "No inbound listening port when daemon is running"
    expected: "`lsof -i -nP | grep LISTEN` shows no port owned by AtlasCapture binary"
    why_human: "Requires running daemon on physical macOS (must be signed and launchctl-loaded)"
  - test: "Core Audio process-tap produces real segments in EchoSession DO"
    expected: "Starting Echo in a real meeting: segments appear in DO storage (speaker, text, start_ts, end_ts)"
    why_human: "Requires physical audio devices + macOS runtime; AudioHardwareCreateProcessTap cannot be simulated"
  - test: "WhisperKit STT accuracy on real audio"
    expected: "Transcript text corresponds to actual speech; WER within acceptable range"
    why_human: "Requires real audio and Neural Engine; no mock can validate this"
  - test: "FluidAudio diarization (Owner vs Speaker 2+)"
    expected: "Loopback channel labeling correct on a real two-speaker call; low-confidence splits flagged P4, not dropped"
    why_human: "Requires real multi-speaker audio and live FluidAudio inference"
  - test: "Long-session silent-zeros watchdog (60+ min)"
    expected: "After 60+ minutes: tap+aggregate-device teardown+recreate fires; P3 emitted; capture resumes"
    why_human: "Requires >60 min real capture session"
  - test: "R2 direct upload via presigned URL (staging integration)"
    expected: "Daemon uploads transcript blob via presigned URL; blob lands in R2 under `transcripts/`"
    why_human: "S3 presign not testable in wrangler dev; requires deployed R2 + seeded R2 credentials"
  - test: "TCC permission persistence across rebuilds"
    expected: "Microphone/audio-capture/Accessibility not re-prompted after rebuild+relaunch (Developer-ID signed binary)"
    why_human: "Requires Apple Developer account + signed binary"
  - test: "Quill AX read + value injection on a real form"
    expected: "Hotkey on a real Greenhouse/Workday form: fields populate from Codex; review panel shows per-field confidence; Quill stops BEFORE Submit"
    why_human: "Requires live AX-accessible form on macOS"
  - test: "Quill OCR fallback on a non-AX form"
    expected: "Open PDF form; invoke Quill; OCR-detected labels appear; fields populated correctly"
    why_human: "Requires non-AX form rendered on screen"
  - test: "Quill refuses secrets and leaves EEO blank on live form"
    expected: "Password/SSN/payment fields: NOT filled, P2 emitted (label only); EEO/demographics fields: blank"
    why_human: "Requires live form with sensitive fields"
  - test: "Raw audio/screen never leaves device except approved artifact"
    expected: "No upload without per-session approval; Quill emits no Wire/R2; incident flags carry form+field labels only, never values"
    why_human: "Privacy boundary proof requires monitoring real network activity during live run"
---

# Phase 3: Capture — Local, Verification Report

**Phase Goal:** Audio capture pipeline (Echo DO + WhisperKit/FluidAudio daemon + Archivist Workflow) and Quill autofill (AX-first, fill-only, Codex-backed), all with enforced privacy boundaries: consent gate, no inbound port, values stripped, submit locked.

**Requirements:** CAPTURE-01 (Echo pipeline), CAPTURE-02 (Quill autofill)

**Verified:** 2026-06-06T13:50:00Z
**Status:** ACHIEVED-WITH-DEFERRALS (code-complete; owner go-live gates and manual UAT pending)
**Re-verification:** No — initial verification

---

## Overall Verdict

**ACHIEVED-WITH-DEFERRALS.** All 12 must-have truths are VERIFIED in the codebase by builds, tests, and code inspection. The codebase fully satisfies CAPTURE-01 and CAPTURE-02 as defined in REQUIREMENTS.md. The 13 human verification items are owner go-live gates and manual UAT explicitly scoped out as non-failures by the context; they gate the live activation, not the code-completeness judgment.

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Pillar 1 preserved: exactly ONE atlas-wire consumer (Steward) | VERIFIED | `grep '"consumers"' apps/*/wrangler.jsonc` → only `apps/steward` (atlas-wire), `apps/flagger` (atlas-incidents), `apps/dlq-sink` (atlas-wire-dlq); Echo + Archivist have 0 consumers |
| 2 | EchoSession DO buffers segments via WebSocket Hibernation; reconnect resumes | VERIFIED | `apps/echo/src/echo-session.ts`: `this.ctx.acceptWebSocket(server, [sessionId])` only; no `ws.accept()` in production code; 4/4 tests green (echo-session, reconnect, wire-contract, replay) |
| 3 | `/echo/presign` is capture-token-gated (constant-time HMAC bearer verify), scope-gated (server-side), prefix-locked, IDOR-mitigated | VERIFIED | `apps/echo/src/auth.ts`: `timingSafeEqual` using HMAC-SHA-256; `apps/echo/src/presign.ts`: scope from `ECHO_CAPTURE_SCOPES` env (never client header); key locked to `transcripts/<session_id>` or `audio/raw/<session_id>`; 5/5 presign tests green (401/401/403/400/400 paths) |
| 4 | `/echo/ws` requires valid capture bearer BEFORE forwarding upgrade to EchoSession DO | VERIFIED | `apps/echo/src/index.ts` lines 65-87: `authenticateCapture()` is called first — DO unreachable on 401; 3/3 ws-route tests green (missing-bearer/wrong-token → 401; missing session_id → 400; no-upgrade → 426) |
| 5 | `transcript.ready` Wire event is canonical §6.4 with stable idempotencyKey; replay is a no-op | VERIFIED | `apps/echo/src/transcript.ts`: `agent:"Echo"`, `type:"transcript.ready"`, `entity:"session"`, `op:"upsert"`, `idempotencyKey:\`echo:${session_id}:ready\`` (no `crypto.randomUUID`); CAPTURE-01-d test: `applyEvent` twice → `{applied:false}` |
| 6 | ArchivistWorkflow: 6 durable steps; consent:discarded → NonRetryableError; missing transcript → P2 + NonRetryableError | VERIFIED | `apps/archivist/src/archivist.ts` (486 lines); `NonRetryableError` from `"cloudflare:workflows"` (correct import, Pitfall 4); 0 `INSERT INTO tasks`; explicit effort `thinking:{type:"enabled",budget_tokens:0}`; 10/10 tests green (effort-set, wire-contract, idempotent, consent-discarded, failure-path, steward-replay×3) |
| 7 | Archivist action items via Forge.createTask RPC; idempotencyKey `archivist:<series>:<date>:ai-NN` | VERIFIED | `apps/archivist/src/archivist.ts` line 390: `forge.createTask(...)` with structured key; no direct D1 tasks write |
| 8 | Steward triggers Archivist Workflow idempotently (cross-script binding, not a second consumer) | VERIFIED | `apps/steward/src/steward-consumer.ts` lines 145-181: `env.ARCHIVIST_WF.create({id:\`archivist-${session_id}\`, params:{session_id}})` with `isInstanceExistsError` swallow; `apps/steward/wrangler.jsonc`: `{binding:"ARCHIVIST_WF", name:"atlas-archivist", class_name:"ArchivistWorkflow", script_name:"archivist"}`; 7/7 archivist-trigger tests green |
| 9 | Capture daemon: no inbound port (zero Sockets/ListenStream/NetworkBindTimeout keys in plist) | VERIFIED | `grep -E "Sockets\|ListenStream\|NetworkBindTimeout" capture/com.atlas.capture.plist` → empty; RunAtLoad + KeepAlive present |
| 10 | Capture daemon: OAuth bearer from macOS Keychain only (SecItem API, never UserDefaults/plist) | VERIFIED | `capture/Sources/Shared/Auth.swift`: 10 `SecItem*` calls; 0 `UserDefaults` references; 7/7 AuthTests green including `testAuth_containsNoSystemPreferenceReference_inSourceCode` |
| 11 | IncidentRelay strips values: RawIncident has no values/screenContent/rawText field by construction | VERIFIED | `capture/Sources/Shared/IncidentRelay.swift`: `RawIncident` struct has `fieldLabels` but zero `fieldValues`/`screenContent`/`rawText`/`filledValue`; `testRawIncident_hasNoValuesField_byConstruction` asserts JSON key absence; 5/5 IncidentRelayTests green |
| 12 | Quill: fill-only (no AXPress/performAction), confirmBeforeSubmit locked true, secrets refused + P2, EEO blank, no cloud LLM in fill loop | VERIFIED | `grep -rn "AXPress\|performAction\|kAXPressAction" capture/Sources/Quill/` → empty; `QuillController.confirmBeforeSubmit: Bool = true` (let, not var); `ReviewPanel.confirmBeforeSubmit` getter always returns true, setter = no-op + P2; `grep -n "URLSession\|URLRequest" CodexMapper.swift` → empty; 42/42 QuillTests green |

**Score: 12/12 truths verified**

---

### Deferred Items

Items not yet met but explicitly out-of-scope as owner go-live gates (per context, not phase failures):

| # | Item | Deferred To | Evidence |
|---|------|-------------|----------|
| 1 | Apple Developer account + Developer-ID signing + notarization | Owner go-live | $99/yr account required; binary must be signed for TCC persistence |
| 2 | launchd plist install (`launchctl load`) | Owner go-live | Requires signed binary at configured path |
| 3 | TCC permission grants (Microphone, audio-capture, Accessibility, Calendar, Screen Recording lazy) | Owner go-live | macOS prompts at first use; cannot be pre-granted from code |
| 4 | OAuth token seeded into Keychain (`Auth.shared.store(token:)`) | Owner go-live (D3-02) | Requires capture OAuth client registration + token exchange |
| 5 | R2 enabled on CF account + R2 credentials seeded to Secrets Store | Owner go-live | `mintPresignedPut` returns 503 until seeded (expected by design) |
| 6 | ECHO_CAPTURE_TOKEN seeded to Secrets Store | Owner go-live | Auth returns 401 until seeded (expected by design) |

---

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `migrations/0006_meetings.sql` | VERIFIED | `CREATE TABLE IF NOT EXISTS meetings`; session_id PRIMARY KEY; consent + audio_disposition NOT NULL; 2 indexes; no DROP/DELETE; no named params |
| `apps/echo/src/echo-session.ts` | VERIFIED | `class EchoSession extends DurableObject<Env>`; `ctx.acceptWebSocket()`; segment buffer; `getSessionSegments()` |
| `apps/echo/src/transcript.ts` | VERIFIED | `buildTranscriptReadyEvent()` with stable `echo:${session_id}:ready` key |
| `apps/echo/src/presign.ts` | VERIFIED | `handlePresign()`: bearer auth → scope gate → prefix lock → session check → URL mint |
| `apps/echo/src/auth.ts` | VERIFIED | `timingSafeEqual` HMAC-SHA-256; `authenticateCapture()`; server-side `grantedCaptureScopes()` |
| `apps/echo/src/index.ts` | VERIFIED | `/echo/ws` auth-before-forward; `/echo/presign`; `satisfies ExportedHandler<Env>`; re-exports `EchoSession` |
| `apps/archivist/src/archivist.ts` | VERIFIED | 6-step `ArchivistWorkflow`; `NonRetryableError` from `"cloudflare:workflows"`; explicit effort; Forge RPC |
| `apps/steward/src/steward-consumer.ts` | VERIFIED | `transcript.ready` trigger; `archivist-${session_id}` instance id; cross-script binding; collision swallowed |
| `capture/Package.swift` | VERIFIED | `argmax-oss-swift` (not legacy URL); `FluidAudio`; macOS 14.4+ |
| `capture/Sources/Shared/Auth.swift` | VERIFIED | SecItem API; `AuthError.tokenMissing` loud fatal |
| `capture/Sources/Shared/OutboxChannel.swift` | VERIFIED | `actor OutboxChannel`; `drainOnce()` serial; ack-after-success; no-ack-on-failure asserted |
| `capture/Sources/Shared/IncidentRelay.swift` | VERIFIED | `RawIncident` has `fieldLabels` only; no values field by construction |
| `capture/Sources/Echo/ConsentGate.swift` | VERIFIED | IDLE→ARMED→ACTIVE; `onActivate` only path to WS open; `testDecline_onActivate_isNeverFired` |
| `capture/Sources/Echo/AudioTap.swift` | VERIFIED | `AudioHardwareCreateProcessTap`; silent-zeros watchdog recreates BOTH tap + aggregate device |
| `capture/Sources/Echo/EchoSession.swift` | VERIFIED | Outbound WS client; `echo-<ISO>` session ID; presign upload for `r2-approved` disposition only |
| `capture/Sources/Echo/EchoController.swift` | VERIFIED | CalendarMonitor→ConsentGate→EchoSession wiring; WS open only in `onActivate` callback |
| `capture/Sources/Quill/CodexMapper.swift` | VERIFIED | Zero URLSession; `isSecretField` → refuse+P2; `isEEOField` → eeoBlank; `isVoiceField` → deterministic snippet |
| `capture/Sources/Quill/ReviewPanel.swift` | VERIFIED | `confirmBeforeSubmit` getter always true; setter = no-op+P2; no Submit button |
| `capture/Sources/Quill/QuillController.swift` | VERIFIED | `let confirmBeforeSubmit = true`; hotkey→read→map→review→inject only in `.injecting` state |
| `capture/com.atlas.capture.plist` | VERIFIED | `com.atlas.capture`; RunAtLoad; KeepAlive; zero inbound-listener keys |

---

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `apps/echo/src/index.ts:/echo/ws` | `EchoSession DO` | `authenticateCapture()` first → `getByName(sessionId).fetch(request)` | VERIFIED |
| `apps/echo/src/presign.ts` | `R2 atlas-blobs` | `S3Client` + `getSignedUrl` + prefix lock `transcripts/<sid>` or `audio/raw/<sid>` | VERIFIED |
| `apps/echo/src/transcript.ts` | `@atlas/wire send()` | `buildTranscriptReadyEvent()` → canonical §6.4 producer | VERIFIED |
| `apps/archivist/src/archivist.ts` | `cloudflare:workflows NonRetryableError` | `import { NonRetryableError } from "cloudflare:workflows"` (correct, not `cloudflare:workers`) | VERIFIED |
| `apps/archivist/src/archivist.ts` | `Forge.createTask RPC` | `env.FORGE.createTask(...)` with structured idempotencyKey | VERIFIED |
| `apps/steward/src/steward-consumer.ts` | `ARCHIVIST_WF.create` | cross-script binding `{script_name:"archivist"}`; `id:\`archivist-${session_id}\`` | VERIFIED |
| `apps/steward/wrangler.jsonc` | `apps/archivist` workflow | `{binding:"ARCHIVIST_WF", name:"atlas-archivist", class_name:"ArchivistWorkflow", script_name:"archivist"}` | VERIFIED |
| `capture/ConsentGate.onActivate` | `capture/EchoSession.open()` | Only path in `EchoController.handleActivation()` after `confirm()` | VERIFIED |
| `capture/OutboxChannel` | macOS Keychain (outbound only) | `Auth.readToken()` → `SecItemCopyMatching`; no inbound socket | VERIFIED |

---

### Security-Invariant Checklist

| Invariant | Status | Evidence (file:line) |
|-----------|--------|---------------------|
| **Pillar 1:** Exactly one `atlas-wire` consumer (Steward) | VERIFIED | `apps/steward/wrangler.jsonc:34` consumers block; Echo + Archivist: 0 consumers |
| **Pillar 2 (presign):** Fail-closed 401 on missing/wrong bearer | VERIFIED | `apps/echo/src/auth.ts:84`: `if (!expected) return false`; `apps/echo/src/presign.ts:119`: 401 |
| **Pillar 2 (presign):** Fail-closed 403 on scope absent (server-side, never client header) | VERIFIED | `apps/echo/src/auth.ts:97`: `grantedCaptureScopes(env)` reads `ECHO_CAPTURE_SCOPES` env var, never request header; `apps/echo/src/presign.ts:136`: 403 |
| **Pillar 2 (ws):** DO unreachable without valid capture token | VERIFIED | `apps/echo/src/index.ts:68`: `authenticateCapture()` before `getByName().fetch()` |
| **Presign IDOR mitigation:** Key bound to `<prefix><session_id>` | VERIFIED | `apps/echo/src/presign.ts:168`: `key.startsWith(\`${prefix}${session_id}\`)` |
| **WebSocket Hibernation:** `ctx.acceptWebSocket()` only, no `ws.accept()` | VERIFIED | `apps/echo/src/echo-session.ts:73`: `this.ctx.acceptWebSocket(server, [sessionId])`; no production `ws.accept()` |
| **Consent gate physical barrier:** WS open only in `onActivate` | VERIFIED | `capture/Sources/Echo/EchoController.swift:112-116`: `session.open()` only inside `onActivate` callback |
| **No inbound port:** launchd plist has zero Sockets/ListenStream/NetworkBindTimeout | VERIFIED | `grep` returns empty; plist has only RunAtLoad + KeepAlive |
| **Keychain-only OAuth token:** no UserDefaults/plist/[vars] | VERIFIED | `capture/Sources/Shared/Auth.swift`: only SecItemCopyMatching/SecItemAdd/SecItemUpdate/SecItemDelete |
| **IncidentRelay values stripped:** RawIncident has no values field by construction | VERIFIED | `capture/Sources/Shared/IncidentRelay.swift`: `fieldLabels` only; structural test asserts JSON key absence |
| **OutboxChannel no-ack-on-failure:** ack called only after successful execute | VERIFIED | `capture/Tests/SharedTests/OutboxChannelTests.swift`: `testDrainOnce_onExecuteFailure_doesNotAck` asserts `ackCalls.count == 0` |
| **Quill fill-only:** no AXPress/performAction/kAXPressAction path | VERIFIED | `grep -rn "AXPress\|performAction\|kAXPressAction" capture/Sources/Quill/` → empty |
| **Quill confirmBeforeSubmit LOCKED true** | VERIFIED | `QuillController`: `let confirmBeforeSubmit: Bool = true`; `ReviewPanel` setter = no-op + P2 |
| **Quill secrets refused + P2:** isSecretField → refuse (label only) | VERIFIED | `CodexMapper.isSecretField()` → `.secretRefused`; 12 SecretRefusalTests; `assertNoValueLeak()` |
| **Quill EEO blank:** autofillEEO locked false | VERIFIED | `CodexMapper.autofillEEO: Bool = false` (let); `isEEOField()` → `.eeoBlank`; 4 EEO tests |
| **Quill no cloud LLM in fill loop:** zero URLSession in CodexMapper | VERIFIED | `grep -n "URLSession\|URLRequest" capture/Sources/Quill/CodexMapper.swift` → empty |
| **Quill no Codex/Vault/Wire write path** | VERIFIED | CodexMapper uses `CodexCacheReadable` (read-only protocol); no Wire/R2 calls anywhere in Quill sources |
| **R2 credentials via Secrets Store only:** never [vars]/KV/tracked file | VERIFIED | `apps/echo/src/presign.ts:68`: `await env.R2_ACCESS_KEY_ID.get()`; wrangler.test.jsonc has no credential values |
| **Archivist action items via Forge RPC only:** no direct tasks INSERT | VERIFIED | `grep -c "INSERT INTO tasks" apps/archivist/src/archivist.ts` = 0 |
| **NonRetryableError from correct module:** `"cloudflare:workflows"` not `"cloudflare:workers"` | VERIFIED | `apps/archivist/src/archivist.ts:26`: `import { NonRetryableError } from "cloudflare:workflows"` |
| **Opus effort set explicitly:** never default "high" (D5) | VERIFIED | `apps/archivist/src/archivist.ts:279`: `thinking: { type: "enabled", budget_tokens: 0 }` |
| **Archivist trigger NOT a second consumer:** cross-script binding only | VERIFIED | `apps/steward/wrangler.jsonc`: single consumer block (atlas-wire); ARCHIVIST_WF is a `workflows` binding, not a `consumers` entry |

---

### Test Results

| Suite | Tests | Pass | Fail | Notes |
|-------|-------|------|------|-------|
| `apps/echo` (TS/workerd) | 15 | 15 | 0 | echo-session(4), presign(5), ws-route(3), replay(3) |
| `apps/archivist` (TS/workerd) | 10 | 10 | 0 | effort-set, wire-contract, idempotent, consent-discarded, failure-path, steward-replay(3) |
| `apps/steward` (TS/workerd) | 33 | 33 | 0 | Includes 7 archivist-trigger tests + malformed/replay/serialize/weekly-review |
| `capture/` SharedTests (Swift/XCTest) | 19 | 19 | 0 | Auth(7), OutboxChannel(7), IncidentRelay(5) |
| `capture/` EchoTests (Swift/XCTest) | 45 | 45 | 0 | AudioWatchdog(16), ConsentGate(17), TranscriptContract(12) |
| `capture/` QuillTests (Swift/XCTest) | 42 | 42 | 0 | CodexMapper(19), SecretRefusal(12), ConfirmBeforeSubmit(11) |
| **Total Phase 3** | **164** | **164** | **0** | |
| **Full monorepo (pnpm test)** | **587** | **587** | **0** | 2 skipped (live OAuth — pre-existing) |
| **Swift build** | — | clean | — | No errors, no warnings |
| **pnpm -r typecheck** | — | clean | — | All packages including echo + archivist |

The `NonRetryableError: non-integer counter delta: not-a-number` message in steward test output is from test C2 (intentional error injection); all 33 steward tests pass.

---

### Anti-Patterns Found

| File | Pattern | Severity | Assessment |
|------|---------|----------|------------|
| `apps/echo/src/presign.ts:503` | Returns 503 when R2 credentials not seeded | INFO | Expected behavior — owner go-live gate; generic error body (no SDK detail leaked) |
| `apps/echo/src/env.ts:54` | `ECHO_CAPTURE_TOKEN?: SecretsStoreBinding` (optional) | INFO | Optional by type because of wrangler.test.jsonc strips it; `authenticateCapture()` returns false when absent (fail-closed) |
| `capture/Sources/Echo/EchoSession.swift` | `uploadRawAudio()` acquires presign URL but PUT body not wired | INFO | Known intended stub; default (no upload) is privacy-correct; noted in 03-05 Known Stubs |

No TBD/FIXME/XXX markers in any Phase 3 source file. No actual stubs serving live user-visible output. The `uploadRawAudio` stub is privacy-correct by omission (no upload = safer default).

---

### Human Verification Required

The following are owner go-live gates and manual UAT items from `03-VALIDATION.md`. All are explicitly listed as Manual-Only by the validation strategy and are correctly deferred.

**1. Consent Gate = 100% (live capture)**
**Test:** Start daemon; detect a meeting; decline consent prompt
**Expected:** Nothing persisted — no D1 `meetings` row, no transcript blob, no WS connection established; P3 incident logged
**Why human:** Requires physical macOS runtime, real meeting detection, live UI interaction

**2. Non-dismissable recording indicator**
**Test:** Start a live Echo session; attempt to dismiss the menubar recording indicator
**Expected:** Indicator stays visible and non-dismissable throughout the entire live session
**Why human:** Requires live macOS UI; NSStatusItem behavior varies by macOS version

**3. No inbound listening port proof**
**Test:** Load the capture daemon via launchctl; run `lsof -i -nP | grep LISTEN`
**Expected:** No port listed for the AtlasCapture binary (only `127.0.0.1:27124` if Obsidian bridge co-located)
**Why human:** Requires running signed daemon (Developer-ID required for TCC + launchctl install)

**4. Core Audio process-tap produces real segments**
**Test:** Start Echo in a real meeting with audio
**Expected:** Segments appear in EchoSession DO storage with speaker labels (Owner + Speaker N), text, timestamps
**Why human:** `AudioHardwareCreateProcessTap` requires physical audio hardware + macOS 14.2+

**5. WhisperKit STT accuracy**
**Test:** Compare transcript text to actual speech on a real recording
**Expected:** WER within acceptable range for a normal voice
**Why human:** Requires Neural Engine + real audio

**6. FluidAudio diarization**
**Test:** Run Echo on a real two-speaker call
**Expected:** Owner (mic) deterministically labeled; Speaker 2+ (loopback) diarized by FluidAudio; low-confidence splits flagged P4, not dropped
**Why human:** Requires real multi-speaker audio + live FluidAudio inference

**7. Long-session silent-zeros watchdog (60+ minutes)**
**Test:** Run Echo for 60+ continuous minutes
**Expected:** Watchdog fires; both AudioTap and aggregate device are torn down and recreated; P3 incident emitted; capture resumes
**Why human:** Cannot simulate 60+ min real session in tests

**8. R2 direct upload via presigned URL (staging integration)**
**Test:** Trigger presign endpoint from the daemon with seeded credentials; verify blob lands in R2
**Expected:** `transcripts/<session_id>.json` appears in the `atlas-blobs` R2 bucket
**Why human:** S3 presign not testable in wrangler dev; requires deployed R2 + seeded R2 credentials

**9. TCC permission persistence across rebuilds**
**Test:** Rebuild binary; relaunch daemon; verify Microphone/Accessibility not re-prompted
**Expected:** TCC grants persist without re-prompting (requires Developer-ID signed binary)
**Why human:** Requires Developer-ID signing ($99/yr Apple Developer account)

**10. Quill AX fill on a real form + no submission**
**Test:** Focus a Greenhouse/Workday job application; press ⌃⌥⌘F; review panel appears; confirm fills; Quill stops before Submit
**Expected:** Fields populated; review panel shows per-field confidence; no submit happens
**Why human:** Requires live AX-accessible form on macOS

**11. Quill OCR fallback on a non-AX form**
**Test:** Open a PDF form; invoke Quill; verify OCR-detected labels
**Expected:** Labels detected via Vision; fields populated from Codex
**Why human:** Requires non-AX form on screen; Vision accuracy varies

**12. Quill refuses secrets and EEO blank (live form)**
**Test:** Open a form with password/SSN fields and EEO checkboxes; invoke Quill
**Expected:** Password/SSN/payment: not filled + P2 emitted (label only); EEO/demographics: blank
**Why human:** Requires live form with sensitive fields; P2 emission needs Keychain token seeded

**13. Raw audio/screen never leaves device except approved artifact**
**Test:** Monitor network during a live Echo session (Wireshark / Charles Proxy)
**Expected:** No audio/screen data uploaded without explicit per-session R2 approval; Quill emits nothing to Wire or R2
**Why human:** Privacy boundary proof requires real network monitoring

---

### Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|---------|
| **CAPTURE-01** | VERIFIED (code-complete, owner-gated for live) | Echo pipeline: DO + WS + presign + transcript.ready; Archivist Workflow 6 steps; Steward trigger; consent gate; all cloud tests green; daemon: consent gate, outbound auth, segment relay, finalize |
| **CAPTURE-02** | VERIFIED (code-complete, owner-gated for live) | Quill: AX-first + OCR fallback + CodexMapper (no network) + ReviewPanel (confirmBeforeSubmit locked) + QuillController (fill-only, no submit path); 42 QuillTests green |

---

### Gaps Summary

**No gaps.** All code-verifiable acceptance criteria are satisfied. The phase goal is achieved in the codebase.

The 13 human verification items are owner go-live gates and manual UAT items that were explicitly planned as out-of-scope for automated verification from the project's inception (see `03-VALIDATION.md` Manual-Only section and the context note in the verification prompt). They require: a physical macOS device, Apple Developer account ($99/yr), TCC grants, Keychain token seeding, live audio hardware, and real form interactions. None of these block the code-completeness determination.

---

_Verified: 2026-06-06T13:50:00Z_
_Verifier: Claude (gsd-verifier)_
