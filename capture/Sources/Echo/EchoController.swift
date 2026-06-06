// EchoController.swift — wires CalendarMonitor → ConsentGate → AudioTap/Pipeline → EchoSession
//
// WIRING DIAGRAM:
//   CalendarMonitor detects a video-conference event
//     → ConsentGate.arm(reason:)    [shows indicator + consent prompt; NO capture yet]
//       → owner taps "Start"
//         → ConsentGate.confirm()
//           → onActivate fires
//             → EchoSession.open()  [WS upgrade with bearer auth]
//             → AudioTap.start()    [loopback + mic capture begins]
//             → TranscriptionPipeline.prepare() [WhisperKit + FluidAudio models ready]
//       → owner taps "Not now"
//         → ConsentGate.decline()   [nothing captured, no WS, P3 emitted, state→idle]
//
// PRIVACY (T-03-05-03): The consent gate physically prevents AudioTap.start() and
//   EchoSession.open() from being called before onActivate fires. There is no code path
//   from ARMED state to either of those calls.
//
// SEGMENT RELAY: TranscriptionPipeline.delegate (self) → EchoSession.send(segment) [live push]
//   On finalize: flushMicChannel + flushLoopbackChannel → EchoSession.finalize()
//
// WATCHDOG RELAY: AudioTap.delegate.audioTapWatchdogFired → log + mark transcript incomplete.

import Foundation
import Shared

// MARK: - EchoController

/// Top-level coordinator for the Echo audio capture pipeline.
///
/// Instantiate once in AppDelegate. All Echo state flows through this controller.
public final class EchoController: @unchecked Sendable {

    // MARK: - Components

    private let consentGate: ConsentGate
    private let calendarMonitor: CalendarMonitor
    private let audioTap: AudioTap
    private let pipeline: TranscriptionPipeline

    /// The current active EchoSession. Nil when idle or ARMED (pre-consent).
    private var activeSession: EchoSession?

    // MARK: - State

    private let queue = DispatchQueue(label: "com.atlas.capture.echocontroller")
    private var transcriptIncomplete = false

    // MARK: - Init

    public init(
        consentGate: ConsentGate,
        calendarMonitor: CalendarMonitor,
        audioTap: AudioTap,
        pipeline: TranscriptionPipeline
    ) {
        self.consentGate = consentGate
        self.calendarMonitor = calendarMonitor
        self.audioTap = audioTap
        self.pipeline = pipeline
    }

    // MARK: - Start monitoring

    /// Begin calendar monitoring. Safe to call on launch.
    public func startMonitoring() {
        // Wire CalendarMonitor → ConsentGate.
        calendarMonitor.delegate = self
        calendarMonitor.start()

        // Wire ConsentGate callbacks → capture pipeline.
        consentGate.onActivate = { [weak self] reason in
            self?.activateCapture(sessionReason: reason)
        }
        consentGate.onDecline = { [weak self] in
            self?.handleDecline()
        }

        // Wire AudioTap delegate → pipeline.
        audioTap.delegate = self
        pipeline.delegate = self
    }

    // MARK: - Stop monitoring

    /// Stop monitoring and end any active session.
    public func stop() {
        calendarMonitor.stop()
        endSession()
    }

    // MARK: - Consent forwarding (called by AppDelegate UI layer)

    /// Forward a consent confirmation from the UI to the ConsentGate.
    /// ConsentGate.confirm() transitions ARMED → ACTIVE and fires onActivate.
    public func confirmConsent() {
        consentGate.confirm()
    }

    /// Forward a consent decline from the UI to the ConsentGate.
    /// ConsentGate.decline() transitions ARMED → IDLE and emits a P3 incident.
    public func declineConsent() {
        consentGate.decline()
    }

    // MARK: - Consent: activated (onActivate callback, called ONLY after confirm())

    private func activateCapture(sessionReason: String) {
        queue.async { [weak self] in
            guard let self else { return }

            // Create the EchoSession and open the WS.
            let session = EchoSession()
            session.delegate = self
            self.activeSession = session
            session.open()

            // Start audio capture.
            self.audioTap.start()

            // Prepare the transcription pipeline (model load is async).
            Task {
                do {
                    try await self.pipeline.prepare()
                } catch {
                    let incident = RawIncident(
                        severity: "P2",
                        kind: "echo.pipeline.prepare-failed",
                        sourceAgent: "Echo",
                        note: "TranscriptionPipeline.prepare() failed: \(error.localizedDescription)"
                    )
                    await IncidentRelay.shared.emit(incident)
                }
            }
        }
    }

    // MARK: - Consent: declined

    private func handleDecline() {
        // ConsentGate already emitted the P3 incident and reset state to idle.
        // Nothing to do here — no audio was buffered, no WS was opened.
        queue.async { [weak self] in
            self?.activeSession = nil
        }
    }

    // MARK: - End session (called on meeting end, WS failure, or stop())

    private func endSession() {
        queue.async { [weak self] in
            guard let self else { return }

            self.audioTap.stop()

            guard let session = self.activeSession else { return }
            self.activeSession = nil

            let incomplete = self.transcriptIncomplete
            self.transcriptIncomplete = false

            Task {
                // Flush both channels before finalizing.
                await self.pipeline.flushMicChannel()
                await self.pipeline.flushLoopbackChannel()

                if incomplete {
                    let incident = RawIncident(
                        severity: "P3",
                        kind: "echo.session.transcript-incomplete",
                        sourceAgent: "Echo",
                        runId: session.sessionID,
                        note: "Session transcript is marked incomplete (watchdog fired during session). Archivist will flag for owner review."
                    )
                    await IncidentRelay.shared.emit(incident)
                }

                await session.finalize()
                session.close()
            }

            self.consentGate.end()
        }
    }
}

// MARK: - CalendarMonitorDelegate

extension EchoController: CalendarMonitorDelegate {
    public func calendarMonitor(_ monitor: CalendarMonitor, didDetectEvent title: String) {
        // ARM the consent gate. This shows the indicator + consent prompt.
        // DOES NOT open WS or start audio.
        consentGate.arm(reason: title)
    }
}

// MARK: - AudioTapDelegate

extension EchoController: AudioTapDelegate {
    public func audioTap(_ tap: AudioTap, didReceiveLoopbackSamples samples: [Float], sampleRate: Double) {
        pipeline.ingestLoopbackSamples(samples, sampleRate: sampleRate)
    }

    public func audioTap(_ tap: AudioTap, didReceiveMicSamples samples: [Float], sampleRate: Double) {
        pipeline.ingestMicSamples(samples, sampleRate: sampleRate)
    }

    public func audioTapWatchdogFired(_ tap: AudioTap) {
        queue.async { [weak self] in
            self?.transcriptIncomplete = true
        }
        print("[EchoController] watchdog fired — transcript interval marked incomplete")
    }
}

// MARK: - TranscriptionPipelineDelegate

extension EchoController: TranscriptionPipelineDelegate {
    public func pipeline(_ pipeline: TranscriptionPipeline, didProduceSegment segment: TranscriptSegment) {
        queue.async { [weak self] in
            self?.activeSession?.send(segment)
        }
    }
}

// MARK: - EchoSessionDelegate

extension EchoController: EchoSessionDelegate {
    public func echoSessionDidConnect(_ session: EchoSession) {
        print("[EchoController] WS connected — session \(session.sessionID)")
    }

    public func echoSessionDidDisconnect(_ session: EchoSession, error: Error?) {
        if let error {
            print("[EchoController] WS disconnected: \(error.localizedDescription) — reconnecting")
        }
    }

    public func echoSessionDidFail(_ session: EchoSession) {
        print("[EchoController] WS persistent failure — ending session")
        endSession()
    }
}
