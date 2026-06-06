// swift-tools-version:5.9
// Package.swift — Atlas Capture daemon (Swift native, macOS 14.4+)
//
// This package lives OUTSIDE apps/ — it is NOT a Cloudflare Worker.
// It runs as a macOS launchd agent (com.atlas.capture) alongside the
// existing Node Obsidian bridge (com.atlas.bridge). Per D3-01 the two
// are separate processes; this file does NOT touch daemon/.
//
// Targets:
//   AtlasCapture   — the executable (LSUIElement menubar app)
//   Shared         — Keychain auth, outbound poll/drain/ack, incident relay, Codex cache
//   SharedTests    — XCTest unit tests for Shared (privacy-boundary assertions)
//
// SPM dependencies:
//   argmax-oss-swift  — product "WhisperKit" (v1.0.0 monorepo URL — see below)
//   FluidAudio        — speaker diarization (v0.15.1)
//
// Pitfall 2 (RESEARCH.md): the legacy WhisperKit GitHub URL (argmaxinc org, pre-v1 repo)
// has no releases as of v1.0.0. Always use https://github.com/argmaxinc/argmax-oss-swift.

import PackageDescription

let package = Package(
    name: "AtlasCapture",
    platforms: [
        .macOS(.v14), // macOS 14.4+ for AudioHardwareCreateProcessTap (D3-04)
    ],
    products: [
        .executable(name: "AtlasCapture", targets: ["AtlasCapture"]),
    ],
    dependencies: [
        // WhisperKit — on-device STT (D3-05). Migrated to argmax-oss-swift monorepo at v1.0.0.
        // Product name is "WhisperKit". Always use argmax-oss-swift (the current monorepo URL).
        .package(url: "https://github.com/argmaxinc/argmax-oss-swift", from: "1.0.0"),
        // FluidAudio — speaker diarization LSEENDDiarizer on loopback channel (D3-06).
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.1"),
    ],
    targets: [
        // Shared library: Auth, OutboxChannel, IncidentRelay, CodexCache
        .target(
            name: "Shared",
            dependencies: [],
            path: "Sources/Shared"
        ),

        // Echo library: AudioTap, TranscriptionPipeline, ConsentGate, CalendarMonitor,
        // EchoSession (WS client), EchoController — the capture pipeline (03-05)
        .target(
            name: "Echo",
            dependencies: [
                "Shared",
                .product(name: "WhisperKit", package: "argmax-oss-swift"),
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "Sources/Echo"
        ),

        // Main executable: menubar app shell (AppDelegate wires Shared + Echo + Quill at launch)
        .executableTarget(
            name: "AtlasCapture",
            dependencies: [
                "Shared",
                "Echo",
                "Quill",
                .product(name: "WhisperKit", package: "argmax-oss-swift"),
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "Sources/App"
        ),

        // XCTest target for Shared (privacy-boundary assertions — T-03-04-02 through T-03-04-04)
        .testTarget(
            name: "SharedTests",
            dependencies: ["Shared"],
            path: "Tests/SharedTests"
        ),

        // XCTest target for Echo: AudioWatchdogTests, ConsentGateTests, TranscriptContractTests
        // Pure-logic tests — no real audio hardware required (D3-04 toolchain gate).
        .testTarget(
            name: "EchoTests",
            dependencies: ["Echo", "Shared"],
            path: "Tests/EchoTests"
        ),

        // Quill library: HotkeyMonitor, ScreenReader, CodexMapper, ReviewPanel, QuillController
        // Hotkey-triggered autofill from the local Codex (D3-07, D3-09).
        // No Echo data dependency (D6 — builds independently of 03-05).
        .target(
            name: "Quill",
            dependencies: ["Shared"],
            path: "Sources/Quill"
        ),

        // XCTest target for Quill: privacy-boundary assertions (T-03-06-01 through T-03-06-06).
        // Pure-logic tests (CodexMapper, secret refusal, confirm-before-submit).
        // No AX/OCR/SwiftUI runtime required (pure logic, no Xcode signing gate).
        .testTarget(
            name: "QuillTests",
            dependencies: ["Quill", "Shared"],
            path: "Tests/QuillTests"
        ),
    ]
)
