# Phase 3: Capture (Local) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-06
**Phase:** 3-Capture (Local)
**Areas discussed:** Daemon shell & language, Echo capture stack, Quill form coverage, Consent & recording UX

---

## Daemon shell & language

### Strategy (D3-01)
| Option | Description | Selected |
|--------|-------------|----------|
| Native Swift app + keep Node bridge | New Swift menubar app owns Echo/Quill native surfaces + its own outbound poll/drain reusing the same auth/outbox pattern; Node Obsidian bridge stays a separate launchd agent. Two outbound-only agents. | ✓ |
| One native Swift app (absorb bridge) | Single Swift app, porting drain.ts to Swift URLSession. One process, but throws away the 17-test Node drainer. | |
| Node brain + native helper CLIs | Keep Node orchestrator, spawn Swift helper binaries over stdio. Preserves TS plumbing but adds IPC + a native-UI gap. | |

**User's choice:** Native Swift app + keep Node bridge.

### Daemon auth (D3-02)
| Option | Description | Selected |
|--------|-------------|----------|
| Separate OAuth clients (least-privilege) | Capture app = own client (Echo/Quill scopes only); bridge keeps vault-drain-only client. One extra token to seed. | ✓ |
| One shared daemon client | Both agents share one token with union of scopes. Simpler, wider blast radius. | |
| You decide | Defer to research/planning. | |

**User's choice:** Separate OAuth clients (least-privilege).

### Signing (D3-03)
| Option | Description | Selected |
|--------|-------------|----------|
| Developer ID + notarize | $99/yr Apple account; TCC grants persist across rebuilds; correct prompts. | ✓ |
| Ad-hoc / self-signed local | Free; TCC grants can reset each rebuild → constant re-granting. | |
| Stable ad-hoc identity | Persistent self-signed cert so grants mostly persist; free, no Gatekeeper story. | |

**User's choice:** Developer ID + notarize.

---

## Echo capture stack

### System-audio loopback (D3-04)
| Option | Description | Selected |
|--------|-------------|----------|
| Core Audio process taps | AudioHardwareCreateProcessTap (macOS 14.4+) → aggregate device; no driver install; NSAudioCaptureUsageDescription audio prompt. | ✓ |
| ScreenCaptureKit audio | macOS 13+; no install but requires the mismatched Screen Recording permission. | |
| Virtual audio device | BlackHole/Loopback; rock-solid but driver install + routing + multi-output friction. | |

**User's choice:** Core Audio process taps.

### On-device STT engine (D3-05)
| Option | Description | Selected |
|--------|-------------|----------|
| WhisperKit | CoreML Whisper (large-v3-turbo) on ANE; accuracy lead + model control + OS portability; ships a managed model. | ✓ |
| Apple SpeechTranscriber | macOS 26 built-in; zero model mgmt, ~55% faster, competitive accuracy; closed model, OS-26-only. | |
| FluidAudio (Parakeet) unified | One SDK for ASR + diarization; tighter integration but Parakeet less battle-tested for meetings. | |

**User's choice:** WhisperKit. (Apple SpeechTranscriber kept as a documented fallback.)

### Diarization depth (D3-06)
| Option | Description | Selected |
|--------|-------------|----------|
| Two-channel + FluidAudio splitting | Mic anchors Owner (free) + FluidAudio splits multiple remote speakers on the loopback; low-conf → P4 flag + Archivist correct-speakers. | ✓ |
| Two-channel only (defer multi-remote) | Owner + single Remote bucket; simplest, weaker on group calls. | |
| You decide | Defer the depth/library to research. | |

**User's choice:** Two-channel + FluidAudio splitting.

---

## Quill form coverage

### Read strategy (D3-07)
| Option | Description | Selected |
|--------|-------------|----------|
| AX + OCR only (extension deferred) | Spec's AX-first + on-device OCR; proves the privacy boundary first; browser-extension DOM bridge becomes a fast-follow. | ✓ |
| AX + OCR + browser-extension bridge | Add a Chrome/Safari DOM bridge now (reliable on ATS sites) — second build + install + new capture surface. | |
| You decide | Defer read-strategy scope to research. | |

**User's choice:** AX + OCR only (extension deferred).

### Voice / free-text fields (D3-08)
| Option | Description | Selected |
|--------|-------------|----------|
| Local Codex snippet insert | Paste relevant Codex bio/voice snippet (deterministic, no model), flag low-confidence; owner finishes. Fully local. | ✓ |
| Leave blank for owner | Fill only deterministic fields; free-text left empty. Most conservative. | |
| Scoped cloud draft (no screen) | Cloud LLM call using only prompt + Codex voice notes; richer drafts but adds a cloud dependency. | |

**User's choice:** Local Codex snippet insert.

### EEO + multi-page defaults (D3-09)
| Option | Description | Selected |
|--------|-------------|----------|
| Keep spec defaults | autofill_eeo=false; refuse secrets (P2); re-scan AX tree per wizard step. | ✓ |
| EEO on by default | autofill_eeo=true — fill demographics from Codex when present. Riskier. | |
| Discuss these | Talk through EEO / multi-page in more detail. | |

**User's choice:** Keep spec defaults.

---

## Consent & recording UX

### Consent posture (D3-10)
| Option | Description | Selected |
|--------|-------------|----------|
| Owner-confirm + announce helper | consent.require=true always; owner clicks Start; one-click "may be recorded" notice the owner reads aloud + logs it was shown; decline → discarded + P3. | ✓ |
| Owner-confirm only | consent.require=true; owner clicks Start; no announce helper. | |
| Per-jurisdiction auto-strictness | Flip strictness by locale; over-engineered for v1. | |

**User's choice:** Owner-confirm + announce helper. (Per-jurisdiction deferred.)

### Arming (D3-11)
| Option | Description | Selected |
|--------|-------------|----------|
| Calendar + audio-active auto-arm | trigger.mode=calendar+audio; arm + prompt on either; capture nothing until Start; DO/WebSocket opens only after consent. | ✓ |
| Calendar-only auto-arm | Arm only for known calendar meetings; misses ad-hoc calls. | |
| Manual start only | Owner starts each session; max control but easy to forget. | |

**User's choice:** Calendar + audio-active auto-arm.

### Live UI surface (D3-12)
| Option | Description | Selected |
|--------|-------------|----------|
| Indicator + controls only | Non-dismissable indicator + pause/stop + consent prompt; transcript reviewed after as the Vault note. | ✓ |
| Indicator + live transcript window | Also a live scrolling speaker-tagged transcript; extra UI on the highest-risk surface. | |
| You decide | Defer live-UI scope to research. | |

**User's choice:** Indicator + controls only. (Live-transcript window deferred.)

---

## Claude's Discretion

- Transcript-store shape (R2 `transcripts/` blob + D1 pointer/index).
- How "transcript ready" reaches Archivist (Wire producer event vs dedicated endpoint) + the Archivist Workflow durable step decomposition.
- Echo calendar-awareness source — local EventKit vs cloud-pushed upcoming meetings in the poll response.
- Echo event-driven heartbeat slot + "meeting-with-no-transcript" detection (Flagger integration).
- Presigned R2 upload URL minting (which Worker, scoped to the capture client) — daemon uploads direct.
- `EchoSession` DO shape (acceptWebSocket Hibernation, setWebSocketAutoResponse, serializeAttachment, reconnect-finalize-from-buffer).
- Exact model pins (WhisperKit size, FluidAudio versions, Vision-framework OCR for Quill).
- Archivist tunables (series-matching aggressiveness, prior_notes_window=3, template_id, action_item_confidence=0.6, emit_others_actions=false).
- OS-permission onboarding/first-run grant sequence.

## Deferred Ideas

- Quill browser-extension DOM bridge for ATS web forms (fast-follow).
- Per-jurisdiction consent auto-strictness.
- Echo live-transcript window UI.
- Apple SpeechAnalyzer/SpeechTranscriber as STT engine (fallback to WhisperKit).
- Archivist mid-meeting provisional notes.
- Archivist "things others owe me" view (emit_others_actions).
