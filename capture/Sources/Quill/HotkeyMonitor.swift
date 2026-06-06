// HotkeyMonitor.swift — Global hotkey registration for Quill (on-demand, never autonomous)
//
// Quill is hotkey-triggered (D3-07, D3-09). It does nothing until the owner presses the
// global hotkey. The monitor registers a system-wide event tap for the owner-configured
// key combination and fires the scan callback on press.
//
// Privacy invariant: the hotkey monitor does NOT capture any key OTHER than the configured
// trigger key combination. It does NOT log keystrokes or record user input.
//
// Owner go-live gate: Accessibility permission must be granted (TCC) before the event tap
// can be registered. If permission is absent, the monitor emits a P3 incident and remains
// idle (fail-safe — Quill simply does nothing until the owner grants access).

import Foundation
import AppKit
import Shared

// MARK: - HotkeyMonitor

/// Registers a global hotkey and invokes a scan callback on press.
///
/// Quill is on-demand only (D3-07). This monitor does nothing until the owner presses
/// the configured key combination. On press, it fires `onTrigger` once per key-down event.
///
/// Default trigger: ⌃⌥⌘F (Control + Option + Command + F)
/// This combination is unlikely to conflict with system shortcuts and is easily memorable.
/// The owner can reconfigure via CONFIG KV (owner go-live gate — not wired here in v1).
public final class HotkeyMonitor {

    // MARK: - Configuration

    /// The modifier flags that must be held when the trigger key is pressed.
    /// Default: Control + Option + Command (⌃⌥⌘).
    public let requiredModifiers: NSEvent.ModifierFlags

    /// The key code for the trigger key. Default: 'F' (keyCode 3).
    public let triggerKeyCode: UInt16

    // MARK: - State

    /// Called (on main thread) when the hotkey is pressed.
    public var onTrigger: (() -> Void)?

    private var eventMonitor: Any?
    private var localMonitor: Any?
    private let incidentRelay: IncidentRelay

    // MARK: - Init

    public init(
        requiredModifiers: NSEvent.ModifierFlags = [.control, .option, .command],
        triggerKeyCode: UInt16 = 3, // 'F' key
        incidentRelay: IncidentRelay = .shared
    ) {
        self.requiredModifiers = requiredModifiers
        self.triggerKeyCode = triggerKeyCode
        self.incidentRelay = incidentRelay
    }

    // MARK: - Start / Stop

    /// Start monitoring for the global hotkey.
    ///
    /// Requires Accessibility permission (TCC). If the app does not have permission,
    /// the global monitor will silently fail on macOS 14+. The local monitor (for the
    /// capture app's own key events) will still work for testing within the app.
    ///
    /// On Accessibility permission denied: emits a P3 incident (non-blocking).
    public func start() {
        // Global monitor: fires even when the capture app is NOT focused.
        // This is the primary path for Quill (owner is looking at a form in another app).
        eventMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handle(event: event)
        }

        // Local monitor: fires when the capture app IS focused (useful for testing / dev).
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handle(event: event)
            return event
        }

        // Check Accessibility permission status and emit a P3 if absent.
        // The actual permission prompt is handled by the OS on first AX API call.
        let accessEnabled = AXIsProcessTrusted()
        if !accessEnabled {
            Task {
                await self.incidentRelay.emit(RawIncident(
                    severity: "P3",
                    kind: "quill.accessibility-permission-missing",
                    sourceAgent: "Quill",
                    note: "Quill hotkey monitor started but Accessibility permission is not yet granted. Grant access in System Settings → Privacy & Security → Accessibility to enable form reading. (Owner go-live gate — not a failure.)"
                ))
            }
        }
    }

    /// Stop monitoring for the global hotkey and release resources.
    public func stop() {
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
            eventMonitor = nil
        }
        if let monitor = localMonitor {
            NSEvent.removeMonitor(monitor)
            localMonitor = nil
        }
    }

    // MARK: - Private

    private func handle(event: NSEvent) {
        // Only fire if the exact modifier combination is held and the trigger key is pressed.
        let exactModifiers = event.modifierFlags.intersection([.control, .option, .command, .shift])
        guard
            exactModifiers == requiredModifiers,
            event.keyCode == triggerKeyCode
        else { return }

        // Dispatch on main thread (AppKit requirement for UI interactions).
        DispatchQueue.main.async { [weak self] in
            self?.onTrigger?()
        }
    }
}
