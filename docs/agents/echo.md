# Echo (audio capture)

**Purpose:** A **local** macOS daemon that captures *all* input **and** output audio devices on the laptop — what the owner says *and* what they hear — turns it into a diarized transcript in real time, and hands that transcript off to [Archivist](archivist.md) for structured meeting notes. Local-first, consent-aware, with a visible recording indicator.

> Roster **#9**. Runtime: **Local** (macOS daemon). Trigger: **meeting starts / audio devices active**. Writes to: **transcript store**. See the [agent roster](../01-agent-roster.md) and [scheduling](../03-scheduling.md).

---

## At a glance

| Field | Value |
|-------|-------|
| **Codename** | Echo |
| **Role** | Audio capture (all I/O devices) → transcripts |
| **Runtime** | **Local** — macOS daemon (menubar app / `launchd`), not Cloudflare |
| **Trigger** | Event: **meeting starts** (calendar-aware) **or** audio devices go active (live mode) |
| **Inputs** | System input devices (mic) + system output devices (loopback of what's playing); the owner's Google Calendar (meeting awareness); consent state |
| **Outputs** | Diarized transcript (segments with speaker, text, ts) → **transcript store**; optional audio blob → **R2** *only if the owner approves* |
| **Dependencies** | None upstream. Downstream: [Archivist](archivist.md) consumes the transcript. Reads nothing from [The Codex](../07-source-of-truth-codex.md) itself — Archivist adds the work context. |
| **MCPs / tools** | macOS audio loopback (system audio capture), local STT + diarization model, **Durable Object + WebSocket** for the live stream, R2 (gated). Authenticates to the cloud; pushes transcripts up. |
| **Writes to** | **transcript store** (it does *not* write the Vault; Archivist → [Steward](steward.md) → [The Vault](../06-obsidian-dashboard.md) does that) |
| **Concurrency** | Runs **in parallel with everything** — real-time, local, off the morning chain |

---

## What it does

Echo is the local "ears" of Atlas. It captures the two halves of a conversation that cloud agents can never reach:

1. **Input audio** — every active microphone / input device (what the owner says).
2. **Output audio** — a loopback of every active output device (what the owner hears: the other participants, a video, a call).

It streams both into a local speech-to-text + diarization pipeline, producing a **diarized transcript** (who-said-what, timestamped). When the session ends, Echo finalizes the transcript and hands it to [Archivist](archivist.md), which is the cloud agent that turns it into structured, context-aware meeting notes.

Echo is one of the two agents that **cannot run on Cloudflare** (the other is [Quill](quill.md), screen autofill). It needs the physical machine's audio subsystem, so it lives in a **local macOS daemon** — a menubar app backed by `launchd` — that authenticates to the cloud and pushes results up. See [hosting: Cloudflare + MCP](../06-hosting-cloudflare-mcp.md) for the cloud-vs-local split.

### What it explicitly does NOT do
- It does **not** silently record. A **visible recording indicator** is on whenever capture is live (see Privacy & consent).
- It does **not** ship raw audio to the cloud by default. Audio blobs go to **R2 only with explicit owner approval**; the default artifact is the *transcript*, not the recording.
- It does **not** write to [The Vault](../06-obsidian-dashboard.md). That is [Steward](steward.md)'s job, fed by Archivist.
- It is not always-on listening. It arms on a meeting/audio trigger and disarms when the session ends.

---

## Privacy & consent (read this first)

Echo records human conversation, including the other side of a call. This is the highest-risk capture surface in Atlas alongside Quill, and it is gated accordingly (see [security & privacy](../11-security-privacy.md) §12).

| Concern | Rule in Echo |
|---------|--------------|
| **Two-party-consent law** | Many jurisdictions require **all** parties to consent to recording a conversation. Echo treats two-party consent as the default posture: it surfaces a consent prompt / requires the owner to confirm participants are aware before a transcript is retained, and supports a **"transcript discarded"** outcome where nothing is persisted. |
| **Visible recording indicator** | While any device is being captured, a clear menubar indicator (recording dot + "Echo is capturing") is shown — non-dismissable while live. The macOS orange mic-in-use dot is also present for the input path. No hidden capture, ever. |
| **Local-first processing** | STT + diarization run **on-device**. Audio never leaves the laptop except as the owner-approved artifact. The transcript is the derived artifact that goes up; the raw audio stays local unless explicitly approved to R2. |
| **Audio retention is opt-in** | Default: transcript kept, audio **not** uploaded. The owner can approve uploading the audio blob to **R2** per-session (e.g. to re-run a better model later). This is a per-session confirmation, not a standing grant. |
| **Sensitive content** | Echo inherits the same discretion rules as the rest of Atlas: derived artifacts that may contain finance/medical/security content are flagged and not exposed in shared/exported Vault views (consistent with [email taxonomy](../04-email-taxonomy.md) §5.8 handling). |
| **Pause / kill** | A one-click **pause** and **stop** from the menubar instantly halts capture and disarms the trigger. Owner override always wins. |

> Per [security & privacy](../11-security-privacy.md): *"Local-only sensitive capture: Echo audio and Quill screen never leave the device except as derived artifacts the owner approves."* Echo is built to make that literally true.

---

## How it works

### Trigger → arm
Echo arms in one of two ways:

- **Calendar-aware (preferred):** Echo watches the owner's Google Calendar. When a meeting is starting (a call event, or an event with a video-conf link), it prepares to capture and shows the consent prompt.
- **Audio-device-active (fallback):** If audio input/output devices go active (a call app grabs the mic, a meeting URL opens a stream) outside a known calendar event, Echo notices the device activity and arms in live mode.

This matches the schedule entry: **event: meeting starts → Echo (live) — calendar-aware or audio-device-active trigger (local)** in [scheduling](../03-scheduling.md) §10.

### Capture pipeline

```
 ┌───────────────────────── local macOS daemon (menubar / launchd) ─────────────────────────┐
 │                                                                                            │
 │  INPUT devices (mic)  ─────────┐                                                           │
 │                                ├──▶  mixer / tagger ──▶ on-device STT ──▶ diarization ──┐  │
 │  OUTPUT devices (loopback) ────┘      (per-source channels)                            │  │
 │     = what the owner hears                                                             │  │
 │                                                                                        ▼  │
 │  consent gate ◀── visible recording indicator (live)              diarized segments       │
 │                                                                  { speaker, text, ts }     │
 │                                                                        │                   │
 │                          Durable Object + WebSocket  ◀─── live stream ─┘                   │
 │                          (per-session live state)                                          │
 └────────────────────────────────────────────────────────────────────────────────────┬─────┘
                                                                                        │
                          on approval only                                              │ finalize
                       ┌──────────────▶ R2 (audio blob)                                 ▼
                       │                                                         transcript store
   raw audio ──────────┤  (default: stays local, NOT uploaded)                          │
                       └──────────────▶ (discarded on "transcript discarded")            │ handoff
                                                                                        ▼
                                                                              Archivist (cloud)
```

Step list:

1. **Arm & consent.** Trigger fires → show the recording indicator + consent prompt. The owner confirms (or the session is discarded).
2. **Open devices.** Tap **all active input devices** (mic) and a **loopback of all active output devices** (system audio). Each source is tagged so we know mic vs. loopback vs. which device.
3. **Mix & tag.** Per-source channels are kept distinct (mic ≠ loopback) so the diarizer has a strong prior on "owner" vs "others."
4. **STT (on-device).** Stream audio through a local speech-to-text model. No cloud round-trip for the audio itself.
5. **Diarize.** Assign speaker labels to segments. The mic channel anchors "owner"; output-loopback channels are the remote participants, separated into distinct speakers where the model can.
6. **Live stream.** Segments are pushed over a **WebSocket** to a per-session **Durable Object** that holds live state (so the cloud side, and any live UI, can follow along in real time per [hosting](../06-hosting-cloudflare-mcp.md) §7). This is the *only* per-session live state Echo coordinates through.
7. **Finalize.** When the meeting ends / devices go idle, Echo closes the session, writes the finalized **diarized transcript** to the **transcript store**, and decides audio disposition (keep-local / upload-to-R2-if-approved / discard).
8. **Handoff.** Echo signals [Archivist](archivist.md) that a transcript is ready.

### Diarization detail
- **Two-prior model.** Because input and output are captured as separate channels, Echo doesn't have to blindly cluster one mixed waveform — it knows the mic channel is (almost always) the owner and the loopback channels are everyone else. This makes "owner vs others" highly reliable; splitting *multiple* remote speakers apart is the harder, lower-confidence part.
- **Speaker labels** are provisional codes (`Speaker 1`, `Speaker 2`, …) plus a confident `Owner`. Archivist + [The Codex](../07-source-of-truth-codex.md) context (attendee lists from the calendar event) can later resolve provisional codes to real names — Echo does not need to know who people are.
- **Segments** carry `{ speaker, text, start_ts, end_ts, confidence }`.

### Transcript shape (handed to Archivist)

```json
{
  "session_id": "echo-2026-05-29T14-00-03",
  "source": "echo",
  "trigger": "calendar",            // "calendar" | "audio-active"
  "calendar_event_id": "…",          // null if audio-active with no matched event
  "started": "2026-05-29T14:00:03Z",
  "ended":   "2026-05-29T14:48:11Z",
  "consent": "granted",              // "granted" | "discarded"
  "audio_disposition": "local-only", // "local-only" | "r2-approved" | "discarded"
  "audio_r2_key": null,              // set only when audio_disposition == "r2-approved"
  "devices": {
    "inputs":  ["MacBook Pro Microphone"],
    "outputs": ["MacBook Pro Speakers (loopback)"]
  },
  "speakers": { "Owner": "Daniel", "Speaker 2": null },
  "segments": [
    { "speaker": "Owner",     "text": "Let's start with the roadmap.", "start_ts": 12.4, "end_ts": 15.1, "confidence": 0.94 },
    { "speaker": "Speaker 2", "text": "Sounds good — I'll share my screen.", "start_ts": 15.6, "end_ts": 18.0, "confidence": 0.81 }
  ]
}
```

---

## Handoff to Archivist

Echo produces the transcript; [Archivist](archivist.md) (cloud, runs **after Echo**) turns it into structured meeting notes. This is the **meetings pipeline** (local → cloud) from [architecture](../02-architecture.md) §4:

```
Echo (local daemon, real-time) ─▶ transcript ─▶ Archivist (cloud, after meeting) ─▶ Steward ─▶ Vault
                                                       ▲
                                                  The Codex (work context, past meetings)
```

- Echo writes the **transcript store** and emits a "transcript ready" event; that is the boundary.
- **Archivist** depends on **Echo** (transcript) **+ The Codex** (work context: who attendees are, past meetings, project names). Echo provides the words; Archivist provides the meaning and the structure.
- Echo never touches the Vault. Archivist → [Steward](steward.md) → [The Vault](../06-obsidian-dashboard.md) is the only write path, and Steward (the sole Vault writer) updates the **Meetings** counters (`count this week`, `hours in meetings`) and the **Meeting-notes index** view.

Scheduling: the handoff is the **event: meeting ends → Archivist** entry in [scheduling](../03-scheduling.md) §10.

---

## Inputs / Outputs

| Direction | What |
|-----------|------|
| **In** | All active **input** devices (mic) · loopback of all active **output** devices · Google Calendar (meeting awareness, attendee list) · consent state from the owner |
| **Out** | **Diarized transcript** → transcript store · "transcript ready" event → [Archivist](archivist.md) · *(optional, gated)* audio blob → **R2** · error/incident events → [Flagger](flagger.md) |

---

## Dependencies

- **Upstream:** none. Echo is a leaf source, not a consumer of other agents.
- **Downstream:** [Archivist](archivist.md) consumes the transcript; it in turn feeds [Steward](steward.md) → the Vault.
- **Infra:** macOS audio subsystem (input + output loopback) · on-device STT/diarization model · **Durable Object + WebSocket** for the live session · **R2** (gated, audio only) · cloud auth for the local daemon.
- **Not a dependency on the morning chain.** Echo runs in **parallel with everything** ([scheduling](../03-scheduling.md) §10 concurrency rules); it never blocks or is blocked by Filer→Herald→Forge→Sundial→Compass.

---

## Schedule / Triggers

| Trigger | Mode | Notes |
|---------|------|-------|
| **event: meeting starts** | `live` | Calendar-aware (preferred) or audio-device-active (fallback). Local. |
| **event: meeting ends** | — | Hands the finalized transcript to [Archivist](archivist.md). |

Echo is **not** cron-scheduled and **not** self-scheduled — it is purely event-driven by meeting/audio activity. See [scheduling](../03-scheduling.md) §10.

---

## Failure modes & Flagger hooks

Every notable failure is reported to [Flagger](flagger.md) with a severity and trust/confidence score (see [Flagger](flagger.md) §8). Echo-specific cases:

| Failure | Severity | Flagger detail |
|---------|----------|----------------|
| **No consent / consent withdrawn mid-session** | P3 Medium | Session marked `discarded`; nothing persisted. Logged so the owner sees *that* a meeting happened, not its content. |
| **Output-loopback unavailable** (OS/permission blocks system-audio capture) | P2 High | Only the mic side captured → transcript is one-sided. Flag prompts the owner to grant loopback permission. High trust (deterministic OS error). |
| **Mic permission denied** | P2 High | Cannot capture at all. High trust. |
| **STT confidence low / heavy crosstalk** | P4 Low / Info | Transcript retained but marked low-confidence; lower trust score since it's a model judgment, not a hard error. |
| **Diarization can't split remote speakers** | P4 Low / Info | Falls back to a single `Speaker 2` bucket; flagged low so Archivist/owner can correct. |
| **WebSocket / Durable Object drops mid-session** | P2 High | Echo buffers locally and resumes; if it can't, it finalizes from the local buffer so the transcript isn't lost. |
| **Handoff to Archivist fails** | P2 High | Transcript is safe in the transcript store; the "ready" event is retried (idempotent — replays don't duplicate the note). |
| **R2 upload fails** (when approved) | P3 Medium | Transcript already persisted; only the optional audio blob is affected. |
| **Heartbeat stale** (daemon crashed / laptop asleep during a known meeting) | P3 Medium | Flagger self-monitors heartbeats (§8); a meeting with no transcript gets flagged. |

Idempotency: each session has a stable `session_id`; re-emitting "transcript ready" with the same id must not create a second meeting note (Archivist/Steward dedupe on the id).

---

## Config

| Setting | Default | Notes |
|---------|---------|-------|
| `capture.inputs` | all active | Which input devices to tap. |
| `capture.outputs` | all active | Loopback of output devices. Can be disabled to capture mic-only. |
| `trigger.mode` | `calendar+audio` | `calendar` only, `audio` only, or both. |
| `consent.require` | `true` | Require explicit per-session consent before retaining a transcript (two-party-consent posture). |
| `indicator.visible` | `true` | Non-dismissable recording indicator while live. **Not** recommended to disable. |
| `audio.retain` | `local-only` | `local-only` (default), `prompt-r2` (ask each session), `discard`. Never `auto-upload`. |
| `r2.bucket` | unset | Target R2 bucket for approved audio blobs. |
| `stt.model` | on-device default | Local STT model; chosen for on-device privacy, not cloud accuracy. |
| `diarization.minSpeakers` / `maxSpeakers` | 1 / 8 | Bounds for the diarizer. |
| `daemon.autostart` | `true` | Start under `launchd` at login. |

Secrets (cloud auth tokens for the daemon) live in **Secrets Store / the OS keychain**, never in [The Vault](../06-obsidian-dashboard.md) or [The Codex](../07-source-of-truth-codex.md) ([security & privacy](../11-security-privacy.md) §12).

---

## Example run

> **Scenario:** A 1:1 sync at 14:00 on 2026-05-29.

1. **13:59** — Echo (calendar-aware) sees a calendar event "Roadmap sync" starting. The menubar shows the **recording indicator** going amber and a consent prompt: *"Echo is about to capture this meeting (mic + system audio). Start?"*
2. **14:00** — Owner clicks **Start**. Echo opens the **MacBook Pro Microphone** (input) and a **loopback of MacBook Pro Speakers** (output). The recording dot is live and non-dismissable.
3. **14:00–14:48** — On-device STT streams text; the diarizer tags the mic channel as **Owner** and the loopback as **Speaker 2**. Segments flow over the **WebSocket** to the session's **Durable Object** in real time:
   - `Owner` → "Let's start with the roadmap." (conf 0.94)
   - `Speaker 2` → "Sounds good — I'll share my screen." (conf 0.81)
4. **14:48** — Output devices go idle; the calendar event ends. Echo **finalizes** the transcript, sets `audio_disposition: "local-only"` (owner didn't approve an R2 upload), and writes it to the **transcript store**. The recording indicator goes dark.
5. **14:48** — Echo emits **"transcript ready"** for `session_id: echo-2026-05-29T14-00-03`. **[Archivist](archivist.md)** picks it up, pulls attendee/project context from [The Codex](../07-source-of-truth-codex.md), and produces a structured meeting note.
6. **14:49** — Archivist → [Steward](steward.md) → [The Vault](../06-obsidian-dashboard.md): the **Meeting-notes index** gets the new note, **Meetings** counters increment (`count this week`, `hours in meetings += 0.8h`). Echo's own job is already done.

**Variant — audio-active, no calendar event:** A spontaneous call grabs the mic with no matching event. Echo arms via the **audio-device-active** fallback, sets `trigger: "audio-active"` and `calendar_event_id: null`, and otherwise runs identically.

**Variant — discarded:** Owner declines the consent prompt. Echo logs `consent: "discarded"`, captures nothing, persists nothing, and the session ends. A P3 note may appear in [Flagger](flagger.md) so the run log shows a meeting occurred without content.

---

## Open questions

- **Multi-remote diarization quality.** Separating several remote participants from a single output-loopback stream is the weak point. Worth pairing low-confidence transcripts with a "correct the speakers" step in Archivist.
- **System-audio loopback permission UX.** macOS makes output-device loopback non-trivial (virtual device vs. ScreenCaptureKit audio). Which path gives the cleanest consent story and least setup friction?
- **Consent for the *other* party.** Echo enforces the owner's consent posture, but it can't make remote participants consent. Should Echo surface a standard "this call may be recorded" notice the owner can announce, and log that it was shown?
- **Per-jurisdiction defaults.** Two-party-consent rules vary by region. Should `consent.require` flip automatically based on the owner's (or the meeting's) locale?
- **R2 lifecycle.** If audio is approved to R2, what's the retention/expiry policy, and who can trigger deletion?
