// ConsentGate.swift — Consent state machine: IDLE → ARMED → ACTIVE
//
// PRIVACY CONTRACT (D3-11, T-03-05-03):
//   IDLE   — nothing running, no UI, no capture, no WS.
//   ARMED  — calendar event detected; menubar indicator shown; consent prompt queued.
//            Audio capture is NOT started. WS connection is NOT opened.
//            Being ARMED means "we want to capture, but the owner has not consented yet."
//   ACTIVE — owner tapped "Start" in the consent prompt.
//            ONLY then does EchoSession.open() fire and audio capture begin.
//
// The WS open is physically unreachable from the ARMED state. The transition guard in
// confirm() is the single choke-point. ConsentGateTests verifies the ARMED→no-WS invariant.
//
// Decline path:
//   owner taps "Not now" → state → IDLE
//   Nothing is written, no audio buffered, no WS opened.
//   A P3 RawIncident is emitted (consent was declined — informational for the Vault).
//   consent property returns "discarded".
//
// The menubar indicator is driven by UIHook callbacks so the gate itself has no AppKit
// dependency (testable without a running NSApplication).

import Foundation
import Shared

// MARK: - ConsentGate state

public enum ConsentState: String, Sendable {
    case idle
    case armed       // indicator shown, consent prompt pending — NO capture, NO WS
    case active      // consent given — audio capture running, WS open
    case discarded   // owner declined — ephemeral, transitions to idle
}

// MARK: - ConsentGate UI hooks (injected, no AppKit dependency in core logic)

/// Callbacks the ConsentGate uses to drive the menubar indicator and consent prompt.
/// Injected at init so the state machine is testable without a running NSApplication.
public struct ConsentGateUIHook: Sendable {
    /// Show the recording-armed indicator (yellow/amber dot).
    public let showArmedIndicator: @Sendable () -> Void
    /// Hide the armed indicator (revert to idle icon).
    public let hideIndicator: @Sendable () -> Void
    /// Show the consent prompt to the owner.
    /// The prompt should call ConsentGate.confirm() or ConsentGate.decline().
    public let showConsentPrompt: @Sendable (String) -> Void   // param: session reason / event title
    /// Show the active-recording indicator (red dot).
    public let showActiveIndicator: @Sendable () -> Void

    public init(
        showArmedIndicator: @escaping @Sendable () -> Void,
        hideIndicator: @escaping @Sendable () -> Void,
        showConsentPrompt: @escaping @Sendable (String) -> Void,
        showActiveIndicator: @escaping @Sendable () -> Void
    ) {
        self.showArmedIndicator = showArmedIndicator
        self.hideIndicator = hideIndicator
        self.showConsentPrompt = showConsentPrompt
        self.showActiveIndicator = showActiveIndicator
    }

    /// No-op hook — used in tests that do not need UI callbacks.
    public static let noop = ConsentGateUIHook(
        showArmedIndicator: {},
        hideIndicator: {},
        showConsentPrompt: { _ in },
        showActiveIndicator: {}
    )
}

// MARK: - ConsentGate

/// Consent state machine for the Echo audio capture pipeline.
///
/// The gate enforces that audio capture and the outbound WebSocket connection can ONLY
/// start AFTER the owner has explicitly consented via confirm().
///
/// THREAD SAFETY: All state mutations are serialized on an internal DispatchQueue.
/// Callbacks (onActivate, onDecline) are called on the main queue.
public final class ConsentGate: @unchecked Sendable {

    // MARK: - State

    private let stateQueue = DispatchQueue(label: "com.atlas.capture.consentgate")
    private var _state: ConsentState = .idle
    private var _sessionReason: String = ""

    public var state: ConsentState {
        stateQueue.sync { _state }
    }

    /// Returns "discarded" if the last action was a decline, otherwise the raw state value.
    /// Exposed for ConsentGateTests.
    public var consent: String {
        stateQueue.sync {
            _state == .discarded ? "discarded" : _state.rawValue
        }
    }

    // MARK: - Callbacks (wired by EchoController)

    /// Called when the gate transitions to ACTIVE. EchoController opens the WS here.
    public var onActivate: (@Sendable (String) -> Void)?
    /// Called when the owner declines. EchoController stays idle.
    public var onDecline: (@Sendable () -> Void)?

    // MARK: - UI hooks

    private let ui: ConsentGateUIHook

    // MARK: - Init

    public init(ui: ConsentGateUIHook = .noop) {
        self.ui = ui
    }

    // MARK: - IDLE → ARMED

    /// Arm the gate for a potential recording session.
    ///
    /// Shows the menubar indicator and queues the consent prompt.
    /// DOES NOT open the WebSocket. DOES NOT start audio capture.
    ///
    /// - Parameter reason: Human-readable context (e.g. meeting title) for the consent prompt.
    public func arm(reason: String) {
        var didArm = false
        stateQueue.sync {
            guard _state == .idle else { return }
            _state = .armed
            _sessionReason = reason
            didArm = true
        }
        guard didArm else { return }
        ui.showArmedIndicator()
        ui.showConsentPrompt(reason)
    }

    // MARK: - ARMED → ACTIVE (consent confirmed)

    /// Confirm consent. Transitions ARMED → ACTIVE and calls onActivate.
    ///
    /// This is the ONLY code path that calls onActivate. The WS open lives in
    /// EchoController's onActivate handler — physically unreachable before this call.
    ///
    /// Calling confirm() from IDLE or ACTIVE is a no-op.
    public func confirm() {
        var reason = ""
        var shouldActivate = false
        stateQueue.sync {
            guard _state == .armed else { return }
            _state = .active
            reason = _sessionReason
            shouldActivate = true
        }
        guard shouldActivate else { return }
        ui.hideIndicator()
        ui.showActiveIndicator()
        let captured = reason
        let cb = onActivate
        DispatchQueue.main.async { cb?(captured) }
    }

    // MARK: - ARMED → IDLE (consent declined)

    /// Decline consent. Transitions ARMED → IDLE (via the transient `discarded` value).
    ///
    /// Nothing is written. No audio has been buffered. No WS was ever opened.
    /// A P3 incident is emitted (declined consent is informational for the Vault).
    ///
    /// The consent property returns "discarded" briefly, then the state resets to idle.
    public func decline() {
        var shouldDecline = false
        stateQueue.sync {
            guard _state == .armed else { return }
            _state = .discarded
            shouldDecline = true
        }
        guard shouldDecline else { return }

        // Emit P3 incident — declined consent is informational, not a failure.
        let incident = RawIncident(
            severity: "P3",
            kind: "echo.consent.declined",
            sourceAgent: "Echo",
            note: "Owner declined the capture consent prompt for '\(_sessionReason)'. No audio captured, no WS opened."
        )
        Task {
            await IncidentRelay.shared.emit(incident)
        }

        ui.hideIndicator()
        let cb = onDecline

        // Reset to idle after the "discarded" snapshot is visible to tests.
        stateQueue.sync { _state = .idle }
        DispatchQueue.main.async { cb?() }
    }

    // MARK: - ACTIVE → IDLE (session ended)

    /// End the active session. Transitions ACTIVE → IDLE.
    /// Called by EchoController when the WS closes or the meeting ends.
    public func end() {
        stateQueue.sync {
            guard _state == .active else { return }
            _state = .idle
            _sessionReason = ""
        }
        ui.hideIndicator()
    }

    // MARK: - Force reset (error recovery)

    /// Reset to IDLE from any state. Used on watchdog fire or unrecoverable error.
    public func reset() {
        stateQueue.sync {
            _state = .idle
            _sessionReason = ""
        }
        ui.hideIndicator()
    }
}
