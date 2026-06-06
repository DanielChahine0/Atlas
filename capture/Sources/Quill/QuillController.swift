// QuillController.swift — Quill orchestrator: hotkey → screen read → map → review → fill
//
// Wires HotkeyMonitor → ScreenReader → CodexMapper → ReviewPanel.
//
// FILL-ONLY invariant (Pillar 2, D3-09, T-03-06-04):
//   There is NO method, call site, or code path in this controller that clicks, activates,
//   presses, or submits any control. The pipeline ENDS at ReviewPanel (which calls
//   ScreenReader.injectValue after owner confirm). Submit/Apply/Send are unreachable.
//
// Quill NEVER writes the Vault, the Wire, or the Codex. The only outbound is IncidentRelay
// (form + field labels only, never field values — T-03-06-01, T-03-06-05).
//
// confirm_before_submit is LOCKED true and is NOT exposed as a user-configurable setting.

import Foundation
import AppKit
import Shared

// MARK: - QuillState

/// The current state of the Quill fill pipeline.
public enum QuillState {
    /// Waiting for the hotkey press (idle — does nothing autonomously).
    case idle
    /// Reading the focused form (AX tree walk or OCR fallback in progress).
    case reading
    /// CodexMapper is mapping labels to Codex fields.
    case mapping
    /// ReviewPanel is showing the owner the proposed fills for confirmation.
    case reviewing
    /// Injecting confirmed values into the form fields.
    case injecting
    /// Pipeline complete (either fills injected or owner cancelled).
    case done
    /// An error occurred (details in associated value).
    case error(String)
}

// MARK: - QuillController

/// Orchestrates the Quill autofill pipeline.
///
/// Usage:
///   1. Call `start()` once at app launch to register the hotkey.
///   2. When the owner presses the hotkey, the controller automatically:
///      a. Reads the focused form (AX-first, OCR fallback).
///      b. Maps field labels to Codex fields via CodexMapper.
///      c. Presents the ReviewPanel for owner confirmation.
///      d. Injects confirmed values via ScreenReader (fill-only — never submits).
///
/// On multi-page / wizard forms, the owner presses the hotkey AGAIN on each page.
/// The controller re-reads the AX tree fresh on every trigger (D3-09 — no stale cache).
@MainActor
public final class QuillController {

    // MARK: - confirm_before_submit (LOCKED)

    /// confirm_before_submit is LOCKED true and is NOT user-disablable (D3-09, T-03-06-04).
    /// Injection only happens after an explicit owner confirm in the ReviewPanel.
    /// There is no code path that sets this to false or bypasses the review step.
    public let confirmBeforeSubmit: Bool = true

    // MARK: - Dependencies

    private let hotkeyMonitor: HotkeyMonitor
    private let screenReader: ScreenReader
    private let codexMapper: CodexMapper
    private let incidentRelay: IncidentRelay

    // MARK: - State

    public private(set) var state: QuillState = .idle

    // MARK: - Init

    public init(
        hotkeyMonitor: HotkeyMonitor = HotkeyMonitor(),
        screenReader: ScreenReader = ScreenReader(),
        codexMapper: CodexMapper = CodexMapper(),
        incidentRelay: IncidentRelay = .shared
    ) {
        self.hotkeyMonitor = hotkeyMonitor
        self.screenReader = screenReader
        self.codexMapper = codexMapper
        self.incidentRelay = incidentRelay
    }

    // MARK: - Lifecycle

    /// Start the hotkey monitor. Call once at app launch.
    ///
    /// Quill does nothing until the owner presses the configured hotkey.
    /// This method is idempotent.
    public func start() {
        hotkeyMonitor.onTrigger = { [weak self] in
            Task { @MainActor [weak self] in
                await self?.handleHotkeyPress()
            }
        }
        hotkeyMonitor.start()
    }

    /// Stop the hotkey monitor. Call at app shutdown.
    public func stop() {
        hotkeyMonitor.stop()
    }

    // MARK: - Pipeline

    /// Handle a hotkey press: read form → map → show review panel.
    ///
    /// If a scan is already in progress, the new press is ignored (debounce).
    private func handleHotkeyPress() async {
        // Ignore if already scanning (debounce — one scan at a time).
        switch state {
        case .idle, .done, .error:
            break // proceed
        default:
            return // already in progress
        }

        state = .reading

        // Step 1: Read the focused form (AX-first, OCR fallback).
        let fields = await screenReader.readFocusedForm()

        guard !fields.isEmpty else {
            state = .idle
            // No fields found — emit a P3 (Quill could not read the form).
            await incidentRelay.emit(RawIncident(
                severity: "P3",
                kind: "quill.no-fields-found",
                sourceAgent: "Quill",
                note: "Quill could not find any form fields in the focused window. The window may not have an accessible AX tree and OCR returned no fields. Try granting Accessibility and Screen Recording permissions (owner go-live gates)."
            ))
            return
        }

        state = .mapping

        // Step 2: Map labels to Codex fields via CodexMapper.
        // CodexMapper reads the local Codex cache ONLY — no cloud round-trip.
        let proposals = await codexMapper.mapFields(fields)

        guard !proposals.isEmpty else {
            state = .idle
            return
        }

        state = .reviewing

        // Step 3: Show the ReviewPanel.
        //
        // The ReviewPanel presents proposed fills to the owner with per-field confidence.
        // The owner can confirm, edit, or cancel. On confirm, it calls back with
        // the approved fills. On cancel, it calls back with an empty array.
        //
        // confirm_before_submit is LOCKED true (no submit action in the panel — see ReviewPanel.swift).
        let panel = ReviewPanel(proposals: proposals, screenReader: screenReader)
        let confirmedFills = await panel.present()

        if confirmedFills.isEmpty {
            // Owner cancelled or confirmed nothing.
            state = .done
            return
        }

        state = .injecting

        // Step 4: Inject confirmed values (fill-only — never submits).
        // This is the ONLY place values are written to the form.
        // There is NO Submit/Apply/Send activation anywhere.
        let formName = focusedAppName()
        for fill in confirmedFills {
            await screenReader.injectValue(fill.proposedValue, into: fill.field, formName: formName)
        }

        state = .done

        // After all fills: reset to idle (ready for next hotkey press, e.g. on next page).
        state = .idle
    }

    // MARK: - Helpers

    /// Return the name of the currently focused application for incident context.
    private func focusedAppName() -> String? {
        NSWorkspace.shared.frontmostApplication?.localizedName
    }
}
