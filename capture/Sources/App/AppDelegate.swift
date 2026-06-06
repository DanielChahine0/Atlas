// AppDelegate.swift — NSStatusItem menubar indicator + launchd bridge
//
// This delegate:
//   1. Creates the NSStatusItem (the menubar dot/icon).
//   2. Initialises Shared services (Auth, OutboxChannel) on launch.
//   3. Starts the outbound poll/drain loop (OutboxChannel.drainLoop).
//
// UI surfaces for 03-05 (Echo recording indicator + consent prompt) and
// 03-06 (Quill review panel) are STUBS here — they will be fleshed out in
// those plans. This task proves the shell builds and is launchd-registerable.
//
// Privacy boundary: AppDelegate never opens any listening socket.
// All network activity flows through OutboxChannel (outbound HTTPS only).

import AppKit
import Shared

final class AppDelegate: NSObject, NSApplicationDelegate {

    // MARK: - Menubar status item

    private var statusItem: NSStatusItem?

    // MARK: - Outbound services (initialised in applicationDidFinishLaunching)

    private var auth: Auth?
    private var outboxChannel: OutboxChannel?

    // MARK: - Application lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Suppress the Dock icon at runtime as a belt-and-suspenders guard
        // (Info.plist LSUIElement=YES already sets this at process launch).
        NSApp.setActivationPolicy(.accessory)

        // --- Menubar status item (STUB — Echo/Quill extend this in 03-05/03-06) ---
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem?.button {
            // Neutral state icon — will change to a recording indicator in 03-05.
            button.image = NSImage(systemSymbolName: "waveform.circle", accessibilityDescription: "Atlas Capture")
            button.image?.isTemplate = true
            button.toolTip = "Atlas Capture — idle"
        }

        // --- Auth: read OAuth bearer from Keychain (fatal-loud if missing) ---
        // At first launch the token will not be present until the owner completes the
        // OAuth grant (owner go-live gate, D3-02). Auth.shared.token is nil-safe here;
        // OutboxChannel will surface the error on the first poll attempt.
        auth = Auth.shared

        // --- Outbound poll/drain loop ---
        // OutboxChannel reads the capture base URL from the environment or a local config.
        // On launch, start draining immediately. KeepAlive in the launchd plist handles
        // process restart on fatal errors.
        let channel = OutboxChannel(auth: Auth.shared)
        outboxChannel = channel
        Task {
            await channel.drainLoop()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Cancel the drain loop on graceful shutdown.
        // launchd KeepAlive restarts the process for unclean exits.
        // OutboxChannel is an actor — use Task to call its cancel() asynchronously.
        if let channel = outboxChannel {
            Task { await channel.cancel() }
        }
    }

    // MARK: - 03-05 stub: Echo recording state hooks
    // These will be replaced in 03-05 with real ConsentGate + AudioTap integration.

    // func startRecording(sessionId: String) { ... }
    // func stopRecording() { ... }
    // func showConsentPrompt(for event: EKEvent) { ... }

    // MARK: - 03-06 stub: Quill hotkey hook
    // These will be replaced in 03-06 with real ScreenReader + ReviewPanel integration.

    // func triggerQuillFill() { ... }
}
