// AppDelegate.swift — NSStatusItem menubar indicator + launchd bridge
//
// This delegate:
//   1. Creates the NSStatusItem (the menubar dot/icon).
//   2. Initialises Shared services (Auth, OutboxChannel) on launch.
//   3. Starts the outbound poll/drain loop (OutboxChannel.drainLoop).
//   4. Wires up the Echo capture pipeline (03-05): ConsentGate, CalendarMonitor,
//      AudioTap, TranscriptionPipeline, EchoController.
//
// Privacy boundary: AppDelegate never opens any listening socket.
// All network activity flows through OutboxChannel (outbound HTTPS only).
// The WS upgrade to the cloud EchoSession DO is initiated outbound by EchoSession.open().

import AppKit
import Echo
import Shared

final class AppDelegate: NSObject, NSApplicationDelegate {

    // MARK: - Menubar status item

    private var statusItem: NSStatusItem?

    // MARK: - Outbound services (initialised in applicationDidFinishLaunching)

    private var auth: Auth?
    private var outboxChannel: OutboxChannel?

    // MARK: - Echo capture pipeline (03-05)

    private var echoController: EchoController?

    // MARK: - Application lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Suppress the Dock icon at runtime as a belt-and-suspenders guard
        // (Info.plist LSUIElement=YES already sets this at process launch).
        NSApp.setActivationPolicy(.accessory)

        // --- Menubar status item ---
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        updateMenubarIcon(state: .idle)

        // --- Auth: read OAuth bearer from Keychain ---
        auth = Auth.shared

        // --- Outbound poll/drain loop ---
        let channel = OutboxChannel(auth: Auth.shared)
        outboxChannel = channel
        Task {
            await channel.drainLoop()
        }

        // --- Echo capture pipeline (03-05) ---
        let ui = buildConsentGateUIHook()
        let gate = ConsentGate(ui: ui)
        let monitor = CalendarMonitor()
        let tap = AudioTap()
        let pipeline = TranscriptionPipeline()

        let controller = EchoController(
            consentGate: gate,
            calendarMonitor: monitor,
            audioTap: tap,
            pipeline: pipeline
        )
        echoController = controller
        controller.startMonitoring()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Stop Echo pipeline on graceful shutdown.
        echoController?.stop()

        // Cancel the drain loop.
        if let channel = outboxChannel {
            Task { await channel.cancel() }
        }
    }

    // MARK: - Menubar icon state

    enum MenubarState {
        case idle, armed, active
    }

    private func updateMenubarIcon(state: MenubarState) {
        guard let button = statusItem?.button else { return }
        switch state {
        case .idle:
            button.image = NSImage(systemSymbolName: "waveform.circle", accessibilityDescription: "Atlas Capture")
            button.image?.isTemplate = true
            button.toolTip = "Atlas Capture — idle"
        case .armed:
            button.image = NSImage(systemSymbolName: "waveform.circle.fill", accessibilityDescription: "Atlas Capture — consent pending")
            button.image?.isTemplate = false
            button.toolTip = "Atlas Capture — consent pending"
        case .active:
            button.image = NSImage(systemSymbolName: "record.circle.fill", accessibilityDescription: "Atlas Capture — recording")
            button.image?.isTemplate = false
            button.toolTip = "Atlas Capture — recording"
        }
    }

    // MARK: - ConsentGate UI hook builder

    private func buildConsentGateUIHook() -> ConsentGateUIHook {
        ConsentGateUIHook(
            showArmedIndicator: { [weak self] in
                DispatchQueue.main.async { self?.updateMenubarIcon(state: .armed) }
            },
            hideIndicator: { [weak self] in
                DispatchQueue.main.async { self?.updateMenubarIcon(state: .idle) }
            },
            showConsentPrompt: { [weak self] reason in
                DispatchQueue.main.async { self?.presentConsentPrompt(reason: reason) }
            },
            showActiveIndicator: { [weak self] in
                DispatchQueue.main.async { self?.updateMenubarIcon(state: .active) }
            }
        )
    }

    // MARK: - Consent prompt

    private func presentConsentPrompt(reason: String) {
        // Find the ConsentGate from the controller. We need a reference to forward the
        // decision back to the gate. Controllers are stored via echoController.
        guard let controller = echoController else { return }

        let alert = NSAlert()
        alert.messageText = "Start capturing '\(reason)'?"
        alert.informativeText = "Atlas Capture will transcribe this meeting on-device. Raw audio stays local unless you approve R2 upload. You can stop at any time from the menubar."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Start")
        alert.addButton(withTitle: "Not now")

        let response = alert.runModal()
        // We cannot directly call consentGate here — let EchoController own the gate reference.
        // Surface the decision via the controller's public confirm/decline entry points.
        if response == .alertFirstButtonReturn {
            controller.confirmConsent()
        } else {
            controller.declineConsent()
        }
    }

    // MARK: - 03-06 stub: Quill hotkey hook
    // These will be replaced in 03-06 with real ScreenReader + ReviewPanel integration.

    // func triggerQuillFill() { ... }
}
