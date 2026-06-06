// AudioWatchdogTests.swift — XCTest: silent-zeros watchdog pure-logic assertions
//
// PRIVACY BOUNDARY: These tests exercise only the pure, hardware-free decision logic.
// No real audio hardware is required. No Core Audio objects are created.
//
// WHAT IS TESTED:
//   rmsThresholdFired(_:_:_:_:_:) — the single function that decides whether the
//   watchdog should fire. This function is extracted from AudioTap.swift so it is
//   testable without a real microphone or Core Audio session.
//
// ACCEPTANCE CRITERIA:
//   1. Watchdog fires on sustained all-zero silence (> 500 ms, output running).
//   2. Watchdog does NOT fire on legitimate brief silence (< 500 ms).
//   3. Watchdog does NOT fire when output is NOT running (quiet system ≠ stale tap).
//   4. Watchdog does NOT fire on non-zero audio even if loud (RMS above threshold).
//   5. computeRMS returns 0.0 for an empty buffer and correct value for a known buffer.
//
// These tests backstop T-03-05-04 (Tampering — silent-zeros tap producing incomplete
// transcript). AudioWatchdogTests is THE backstop called out in the acceptance criteria.

import XCTest
@testable import Echo

final class AudioWatchdogTests: XCTestCase {

    // MARK: - computeRMS tests

    func testComputeRMS_emptyBuffer_returnsZero() {
        let rms = computeRMS([])
        XCTAssertEqual(rms, 0.0, accuracy: 1e-10, "Empty buffer RMS must be 0.0")
    }

    func testComputeRMS_allZeroBuffer_returnsZero() {
        let zeros = [Float](repeating: 0.0, count: 1024)
        let rms = computeRMS(zeros)
        XCTAssertEqual(rms, 0.0, accuracy: 1e-10, "All-zero buffer RMS must be 0.0")
        // Confirm this is below the watchdog threshold.
        XCTAssertLessThan(rms, AudioTap.rmsThreshold, "All-zero RMS must be below the watchdog threshold")
    }

    func testComputeRMS_knownAmplitude_returnsCorrectValue() {
        // A constant-value buffer of amplitude A has RMS = A.
        let amplitude: Float = 0.5
        let buffer = [Float](repeating: amplitude, count: 512)
        let rms = computeRMS(buffer)
        XCTAssertEqual(rms, amplitude, accuracy: 1e-6, "Constant-amplitude buffer RMS should equal the amplitude")
        // Confirm this is above the watchdog threshold.
        XCTAssertGreaterThan(rms, AudioTap.rmsThreshold, "Real audio RMS must be above watchdog threshold")
    }

    func testComputeRMS_singleNonZeroSample_returnsCorrectValue() {
        let buffer: [Float] = [1.0, 0.0, 0.0, 0.0]
        let rms = computeRMS(buffer)
        let expected: Float = sqrt(1.0 / 4.0)
        XCTAssertEqual(rms, expected, accuracy: 1e-6)
    }

    // MARK: - rmsThresholdFired: fires on sustained all-zero silence

    func testWatchdog_fireOnSustainedZeros_outputRunning() {
        // All-zero buffer (RMS = 0) for > 500 ms while output is running.
        let rms: Float = 0.0
        let silentMs: Double = 600.0  // beyond the 500 ms threshold
        let result = rmsThresholdFired(rms: rms, silentDurationMs: silentMs, isOutputRunning: true)
        XCTAssertTrue(result, "Watchdog must fire on all-zero buffer lasting > 500 ms while output runs")
    }

    func testWatchdog_fireOnRMSJustBelowThreshold() {
        // RMS is non-zero but still below 1e-7 (machine-epsilon-scale zeros).
        let rms: Float = 5e-8  // less than 1e-7
        let silentMs: Double = 510.0
        let result = rmsThresholdFired(rms: rms, silentDurationMs: silentMs, isOutputRunning: true)
        XCTAssertTrue(result, "Watchdog must fire for RMS < 1e-7 lasting > 500 ms while output runs")
    }

    // MARK: - rmsThresholdFired: does NOT fire on brief silence

    func testWatchdog_doesNotFire_onBriefSilence() {
        // Even with a fully-zero RMS, the watchdog must not fire if silence is < 500 ms.
        let rms: Float = 0.0
        let silentMs: Double = 400.0  // under the 500 ms threshold
        let result = rmsThresholdFired(rms: rms, silentDurationMs: silentMs, isOutputRunning: true)
        XCTAssertFalse(result, "Watchdog must NOT fire on brief silence (< 500 ms)")
    }

    func testWatchdog_doesNotFire_exactlyAtThresholdBoundary() {
        // Exactly at 500 ms — threshold is >=, so 500.0 fires.
        // Exactly at 499.999 ms — must NOT fire.
        let rms: Float = 0.0
        XCTAssertFalse(
            rmsThresholdFired(rms: rms, silentDurationMs: 499.9, isOutputRunning: true),
            "Watchdog must NOT fire at 499.9 ms"
        )
        XCTAssertTrue(
            rmsThresholdFired(rms: rms, silentDurationMs: 500.0, isOutputRunning: true),
            "Watchdog MUST fire at exactly 500.0 ms"
        )
    }

    // MARK: - rmsThresholdFired: does NOT fire when output is not running

    func testWatchdog_doesNotFire_outputNotRunning() {
        // Zero RMS + > 500 ms but the owner's output device is not running.
        // Legitimate silence (no one is in a meeting) — must not trigger watchdog.
        let rms: Float = 0.0
        let silentMs: Double = 1000.0  // well beyond threshold
        let result = rmsThresholdFired(rms: rms, silentDurationMs: silentMs, isOutputRunning: false)
        XCTAssertFalse(result, "Watchdog must NOT fire when output is not running")
    }

    // MARK: - rmsThresholdFired: does NOT fire on real (non-zero) audio

    func testWatchdog_doesNotFire_onNonZeroAudio() {
        // Legitimate audio above the RMS threshold — even if "silent" for a long time
        // in duration, the RMS check should catch it.
        let rms: Float = 0.1  // well above 1e-7
        let silentMs: Double = 2000.0
        let result = rmsThresholdFired(rms: rms, silentDurationMs: silentMs, isOutputRunning: true)
        XCTAssertFalse(result, "Watchdog must NOT fire on audio with RMS above threshold")
    }

    func testWatchdog_doesNotFire_onRMSExactlyAtThreshold() {
        // RMS exactly at 1e-7 — threshold is strict < so this should NOT fire.
        let rms: Float = 1e-7
        let silentMs: Double = 1000.0
        let result = rmsThresholdFired(rms: rms, silentDurationMs: silentMs, isOutputRunning: true)
        XCTAssertFalse(result, "Watchdog must NOT fire when RMS equals the threshold (threshold is exclusive)")
    }

    // MARK: - rmsThresholdFired: custom threshold parameters

    func testWatchdog_customThresholds_respected() {
        // Custom RMS threshold of 1e-4 and 200 ms duration.
        let customRmsThreshold: Float = 1e-4
        let customDurationMs: Double = 200.0

        // Should fire: RMS=5e-5 (below 1e-4), duration=250 ms (above 200 ms)
        XCTAssertTrue(
            rmsThresholdFired(
                rms: 5e-5, silentDurationMs: 250.0, isOutputRunning: true,
                rmsThreshold: customRmsThreshold, durationThresholdMs: customDurationMs
            ),
            "Custom thresholds: should fire"
        )

        // Should NOT fire: duration=150 ms (below 200 ms threshold)
        XCTAssertFalse(
            rmsThresholdFired(
                rms: 5e-5, silentDurationMs: 150.0, isOutputRunning: true,
                rmsThreshold: customRmsThreshold, durationThresholdMs: customDurationMs
            ),
            "Custom thresholds: should not fire on short silence"
        )
    }

    // MARK: - toMono16k and resample helpers (used by TranscriptionPipeline)

    func testDownmixToMono_stereoToMono_averagesChannels() {
        // Stereo buffer: [L1, R1, L2, R2, ...] where L=0.4, R=0.8
        let stereo: [Float] = [0.4, 0.8, 0.4, 0.8]
        let mono = downmixToMono(stereo, channelCount: 2)
        XCTAssertEqual(mono.count, 2, "Stereo→mono should halve the frame count")
        XCTAssertEqual(mono[0], 0.6, accuracy: 1e-6, "Mono sample should be average of L+R")
        XCTAssertEqual(mono[1], 0.6, accuracy: 1e-6)
    }

    func testDownmixToMono_alreadyMono_returnsUnchanged() {
        let mono: [Float] = [0.1, 0.2, 0.3]
        let result = downmixToMono(mono, channelCount: 1)
        XCTAssertEqual(result, mono, "Mono buffer should be returned unchanged")
    }

    func testResample_preservesSignalLength() {
        // 44100 Hz → 16000 Hz: output length should be approximately (16000/44100) of input.
        let input = [Float](repeating: 0.5, count: 44100)
        let output = resample(input, from: 44100.0, to: 16000.0)
        let expectedCount = Int(Double(input.count) / (44100.0 / 16000.0))
        XCTAssertEqual(output.count, expectedCount, "Resampled output count should match expected")
    }

    func testResample_sameRate_returnsIdentical() {
        let input: [Float] = [0.1, 0.2, 0.3]
        let output = resample(input, from: 16000.0, to: 16000.0)
        XCTAssertEqual(output, input, "Same-rate resample should return the input unchanged")
    }
}
