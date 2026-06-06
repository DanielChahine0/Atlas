// CaptureApp.swift — Atlas Capture menubar app entry point
//
// LSUIElement = true (set in Info.plist) means this app has NO Dock icon and NO menu bar
// at the top of the screen — it is purely a menubar STATUS ITEM app. This is the correct
// shape for a daemon-style helper that shows only the recording indicator.
//
// Privacy invariants enforced by construction:
//   - No inbound port: the launchd plist has no Sockets/ListenStream/NetworkBindTimeout.
//   - OAuth token in macOS Keychain only (Auth.swift — never UserDefaults/plist/[vars]).
//   - All connectivity is OUTBOUND (URLSession in OutboxChannel.swift).
//   - Audio/screen never leave the device except as owner-approved derived artifacts.
//
// 03-05 (Echo capture pipeline) and 03-06 (Quill autofill) EXTEND this shell.
// This file stubs the AppDelegate hook; UI surfaces land in those plans.

import AppKit
import SwiftUI

@main
struct CaptureApp: App {
    // Wire AppKit delegate for the NSStatusItem (menubar indicator).
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // LSUIElement=true suppresses the Dock icon and the Window menu entirely.
        // We use an empty WindowGroup here as a no-op (the real UI is the NSStatusItem).
        // The Settings scene is intentionally absent — Quill and Echo are configured via
        // the Codex and launchd environment, not a GUI preferences panel.
        Settings {
            EmptyView()
        }
    }
}
