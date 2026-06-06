// AudioTap.swift — Core Audio process-tap loopback + mic capture (two separate channels)
//
// PRIVACY BOUNDARY: Raw audio never leaves the device. Audio is processed on-device
// by TranscriptionPipeline.swift. The mic channel and the loopback channel are kept
// SEPARATE — this separation IS the diarization prior (D3-06):
//   mic channel    → hardcoded "Owner" label (deterministic, free)
//   loopback channel → FluidAudio DiarizerManager splits multiple remote speakers
//
// TECHNIQUE: AudioHardwareCreateProcessTap + private aggregate device (D3-04, macOS 14.2+).
// No virtual driver install required. NSAudioCaptureUsageDescription covers this prompt.
//
// CATapDescription usage (verified against Apple SDK headers):
//   - CATapDescription() default init → set exclusive=true, processes=[] for global tap
//   - OR use initStereoGlobalTapButExcludeProcesses([]) which taps all system output.
//   - The Swift-friendly form is CATapDescription(stereoMixdownOfProcesses:) etc.
//
// kAudioAggregateDeviceTapListKey = "taps" — tap list in aggregate device config dict.
// kAudioSubTapUIDKey = "uid" — the tap's UUID string in the sub-tap entry.
// kAudioAggregateDeviceIsPrivateKey = "private" — private aggregate device.
//
// WATCHDOG (Pitfall 1 — silent zeros during long sessions):
//   If buffer RMS < 1e-7 for > 500 ms WHILE output is actively running, tear down
//   AND recreate BOTH the Process Tap AND the Aggregate Device atomically.
//   Partial teardown (recreating only one) is unreliable.
//   On watchdog trigger: emit P3 via IncidentRelay; mark the transcript incomplete.
//
// The pure RMS-threshold decision is factored into free functions `computeRMS` and
// `rmsThresholdFired` so AudioWatchdogTests can test them without real audio hardware.

import CoreAudio
import Foundation
import Shared

// MARK: - Pure logic (testable without audio hardware)

/// Compute the root-mean-square of a float buffer.
/// Returns 0.0 for an empty buffer.
public func computeRMS(_ samples: [Float]) -> Float {
    guard !samples.isEmpty else { return 0.0 }
    let sumSquares = samples.reduce(0.0) { $0 + $1 * $1 }
    return sqrt(sumSquares / Float(samples.count))
}

/// Determine whether the silent-zeros watchdog should fire.
///
/// The watchdog fires if ALL of the following are true:
///   1. The measured RMS is below the silent-zeros threshold (< 1e-7, exclusive).
///   2. The silence has persisted for at least `durationThresholdMs` milliseconds.
///   3. The output device is actively running (to distinguish legitimate silence from
///      a meeting where everyone paused — isOutputRunning must be true).
///
/// - Parameters:
///   - rms: Measured buffer RMS.
///   - silentDurationMs: How long silence has been observed (milliseconds).
///   - isOutputRunning: Whether the system output is currently producing audio.
///   - rmsThreshold: Silent-zero threshold (default 1e-7).
///   - durationThresholdMs: Minimum silence duration to trigger (default 500 ms).
/// - Returns: true if the watchdog should fire (tear down + recreate both tap + device).
public func rmsThresholdFired(
    rms: Float,
    silentDurationMs: Double,
    isOutputRunning: Bool,
    rmsThreshold: Float = 1e-7,
    durationThresholdMs: Double = 500.0
) -> Bool {
    guard isOutputRunning else { return false }
    guard rms < rmsThreshold else { return false }
    return silentDurationMs >= durationThresholdMs
}

// MARK: - AudioTap delegate

/// Receives decoded PCM buffers from the two audio channels.
/// Implementors should be thread-safe (callbacks may arrive on Core Audio threads).
public protocol AudioTapDelegate: AnyObject, Sendable {
    /// Called with a mic-input buffer (the Owner channel).
    /// Samples are Float32, native device sample rate, native channel count.
    func audioTap(_ tap: AudioTap, didReceiveMicSamples samples: [Float], sampleRate: Double)

    /// Called with a loopback buffer (the system-output tap — all remote speakers mixed).
    /// Samples are Float32, native device sample rate, native channel count.
    func audioTap(_ tap: AudioTap, didReceiveLoopbackSamples samples: [Float], sampleRate: Double)

    /// Called when the silent-zeros watchdog fires and a tap recreation is underway.
    /// The transcript should be marked incomplete for this interval.
    func audioTapWatchdogFired(_ tap: AudioTap)
}

// MARK: - AudioTap

/// Two-channel Core Audio capture:
///   - Loopback channel: system-audio process tap (AudioHardwareCreateProcessTap) in a
///     private aggregate device, capturing all system output.
///   - Mic channel: the default input device (the Owner's microphone).
///     Mic capture is delegated to the caller — use AVAudioEngine or CoreAudio separately.
///
/// Both channels are delivered to the delegate as separate PCM buffers so the
/// diarization stack can apply a deterministic Owner prior on the mic channel
/// without running a speaker-clustering model on it.
///
/// WATCHDOG: an RMS-based silent-zeros detector recreates BOTH the tap AND the
/// aggregate device atomically when stale audio is detected during active playback.
///
/// LIFECYCLE:
///   start()  → creates tap + aggregate device + IOProc, starts IO
///   stop()   → stops IO, destroys IOProc, destroys aggregate device, destroys tap
///   Recreation on watchdog fires stop() + start() atomically on the internal queue.
///
/// NOTE: AudioHardwareCreateProcessTap requires macOS 14.2+ (per Apple SDK header).
/// The package platform target is macOS 14.4+ (D3-04) which satisfies this.
/// Entitlement required: com.apple.developer.audio.multi-channel-capture
///                       com.apple.security.device.audio-input
public final class AudioTap: @unchecked Sendable {

    // MARK: - Configuration

    /// Delegate that receives PCM buffer callbacks.
    public weak var delegate: (any AudioTapDelegate)?

    // MARK: - Core Audio objects

    private var tapID: AudioObjectID = kAudioObjectUnknown
    private var aggregateDeviceID: AudioDeviceID = kAudioObjectUnknown
    private var ioProcID: AudioDeviceIOProcID?

    // MARK: - Watchdog state (accessed on `queue`)

    private let queue = DispatchQueue(label: "com.atlas.capture.audiotap", qos: .userInteractive)
    private var silentStartMs: Double? = nil
    private var isRecreating = false

    // MARK: - Silent-zeros threshold constants

    /// RMS below this value is treated as silence (all-zero buffer from stale tap).
    public static let rmsThreshold: Float = 1e-7
    /// Silence duration that triggers the watchdog (milliseconds).
    public static let silenceDurationThresholdMs: Double = 500.0

    // MARK: - Running state

    private var isRunning = false

    // MARK: - Init

    public init() {}

    // MARK: - Start / Stop

    /// Start loopback audio capture.
    /// Creates the process tap, aggregate device, and IOProc.
    /// Requires macOS 14.2+ (AudioHardwareCreateProcessTap). On older systems returns false.
    /// Must be called after TCC audio-capture permission has been granted.
    ///
    /// - Returns: true if the tap started successfully, false on error or unavailable OS.
    @discardableResult
    public func start() -> Bool {
        guard #available(macOS 14.2, *) else {
            print("[AudioTap] AudioHardwareCreateProcessTap requires macOS 14.2+")
            return false
        }
        return queue.sync {
            guard !isRunning else { return true }
            return _startLocked()
        }
    }

    /// Stop audio capture. Destroys IOProc, aggregate device, and process tap atomically.
    public func stop() {
        guard #available(macOS 14.2, *) else { return }
        queue.sync {
            guard isRunning else { return }
            _stopLocked()
        }
    }

    // MARK: - Private: start (must be called on `queue`)

    @available(macOS 14.2, *)
    private func _startLocked() -> Bool {
        // Step 1: Create a CATapDescription for global system-output tap.
        // initStereoGlobalTapButExcludeProcesses([]) taps all system output processes.
        // AudioHardwareCreateProcessTap requires macOS 14.2+.
        // Package platform is macOS 14.4+ (D3-04); the @available annotation satisfies
        // the Swift compiler's availability checker.
        let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        tapDesc.isPrivate = true
        tapDesc.muteBehavior = .unmuted  // owner still hears the call normally

        var newTapID: AudioObjectID = kAudioObjectUnknown
        let tapStatus = AudioHardwareCreateProcessTap(tapDesc, &newTapID)
        guard tapStatus == noErr else {
            print("[AudioTap] AudioHardwareCreateProcessTap failed: OSStatus \(tapStatus)")
            return false
        }
        tapID = newTapID

        // Step 2: Create a private aggregate device that includes the tap.
        // Keys from AudioHardware.h:
        //   kAudioAggregateDeviceTapListKey = "taps"   — array of sub-tap dicts
        //   kAudioSubTapUIDKey = "uid"                 — the tap's UUID string
        //   kAudioAggregateDeviceIsPrivateKey = "private" — private to our process
        let tapUID = tapDesc.uuid.uuidString
        let subTapDict: [String: Any] = [kAudioSubTapUIDKey: tapUID]
        let aggConfig: [String: Any] = [
            kAudioAggregateDeviceTapListKey: [subTapDict],
            kAudioAggregateDeviceIsPrivateKey: true as AnyObject,
        ]
        var newAggDeviceID: AudioDeviceID = kAudioObjectUnknown
        let aggStatus = AudioHardwareCreateAggregateDevice(aggConfig as CFDictionary, &newAggDeviceID)
        guard aggStatus == noErr else {
            print("[AudioTap] AudioHardwareCreateAggregateDevice failed: OSStatus \(aggStatus)")
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
            return false
        }
        aggregateDeviceID = newAggDeviceID

        // Step 3: Install an IOProc on the aggregate device.
        // AudioDeviceIOBlock signature (AudioHardware.h typedef):
        //   (inNow, inInputData, inInputTime, outOutputData, inOutputTime) -> Void
        var newProcID: AudioDeviceIOProcID?
        let procStatus = AudioDeviceCreateIOProcIDWithBlock(
            &newProcID,
            aggregateDeviceID,
            nil  // dispatch queue: nil = called directly on Core Audio thread
        ) { [weak self] _, inInputData, _, _, _ in
            guard let self else { return }
            self._ioProc(inData: inInputData)
        }
        guard procStatus == noErr, newProcID != nil else {
            print("[AudioTap] AudioDeviceCreateIOProcIDWithBlock failed: OSStatus \(procStatus)")
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
            aggregateDeviceID = kAudioObjectUnknown
            return false
        }
        ioProcID = newProcID

        // Step 4: Start IO.
        let startStatus = AudioDeviceStart(aggregateDeviceID, ioProcID)
        guard startStatus == noErr else {
            print("[AudioTap] AudioDeviceStart failed: OSStatus \(startStatus)")
            if let proc = ioProcID {
                AudioDeviceDestroyIOProcID(aggregateDeviceID, proc)
            }
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
            aggregateDeviceID = kAudioObjectUnknown
            ioProcID = nil
            return false
        }

        isRunning = true
        return true
    }

    // MARK: - Private: stop (must be called on `queue`)

    @available(macOS 14.2, *)
    private func _stopLocked() {
        // Tear down in reverse creation order:
        // IOProc → aggregate device → process tap.
        // BOTH the tap AND the aggregate device are destroyed (Pitfall 1 invariant).
        if let proc = ioProcID {
            AudioDeviceStop(aggregateDeviceID, proc)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, proc)
            ioProcID = nil
        }
        if aggregateDeviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
        isRunning = false
        silentStartMs = nil
    }

    // MARK: - IOProc callback

    /// Invoked by Core Audio on a high-priority real-time thread.
    /// Extracts PCM samples, measures RMS, triggers the watchdog on sustained silence.
    private func _ioProc(inData: UnsafePointer<AudioBufferList>) {
        // Extract Float32 samples from the AudioBufferList.
        // withUnsafePointer + pointer arithmetic to iterate the variable-length ABL.
        let abl = inData.pointee
        guard abl.mNumberBuffers > 0 else { return }

        var allSamples: [Float] = []
        withUnsafePointer(to: abl.mBuffers) { firstBuf in
            for i in 0..<Int(abl.mNumberBuffers) {
                let ab = (firstBuf + i).pointee
                guard ab.mDataByteSize > 0, let data = ab.mData else { continue }
                let count = Int(ab.mDataByteSize) / MemoryLayout<Float>.size
                let floatPtr = data.bindMemory(to: Float.self, capacity: count)
                allSamples += Array(UnsafeBufferPointer(start: floatPtr, count: count))
            }
        }

        let rms = computeRMS(allSamples)

        // Check if system output is actively running.
        var isRunningOutput: UInt32 = 0
        var propSize = UInt32(MemoryLayout<UInt32>.size)
        var propAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunning,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectGetPropertyData(aggregateDeviceID, &propAddr, 0, nil, &propSize, &isRunningOutput)
        let outputRunning = isRunningOutput != 0

        // Update silent-duration tracking and check watchdog.
        let nowMs = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000.0
        if rms < AudioTap.rmsThreshold && outputRunning {
            if silentStartMs == nil { silentStartMs = nowMs }
            let silentDuration = nowMs - (silentStartMs ?? nowMs)
            if rmsThresholdFired(
                rms: rms,
                silentDurationMs: silentDuration,
                isOutputRunning: true,
                rmsThreshold: AudioTap.rmsThreshold,
                durationThresholdMs: AudioTap.silenceDurationThresholdMs
            ) && !isRecreating {
                isRecreating = true
                silentStartMs = nil
                _triggerWatchdogRecreate()
            }
        } else {
            silentStartMs = nil
        }

        // Deliver loopback samples to delegate (nominal 44100 Hz — TranscriptionPipeline
        // resamples to 16 kHz via the helpers in TranscriptionPipeline.swift).
        let sampleRate: Double = 44100.0
        delegate?.audioTap(self, didReceiveLoopbackSamples: allSamples, sampleRate: sampleRate)
    }

    // MARK: - Watchdog: recreate BOTH tap AND aggregate device (Pitfall 1)

    /// Tear down and recreate BOTH the Process Tap AND the Aggregate Device atomically.
    ///
    /// RULE: Recreating only the aggregate device is unreliable (Pitfall 1 / RESEARCH.md).
    /// Both must be destroyed and recreated together.
    ///
    /// This method is called on the IOProc thread; it schedules the recreate on `queue`
    /// asynchronously (the IOProc must return quickly).
    private func _triggerWatchdogRecreate() {
        guard #available(macOS 14.2, *) else { return }
        queue.async { [weak self] in
            guard let self else { return }
            guard #available(macOS 14.2, *) else { return }
            // Notify delegate before teardown so transcript can be marked incomplete.
            self.delegate?.audioTapWatchdogFired(self)

            // Emit P3 incident via IncidentRelay.
            let incident = RawIncident(
                severity: "P3",
                kind: "echo.audiotap.silent-zeros-watchdog",
                sourceAgent: "Echo",
                note: "AudioTap silent-zeros watchdog fired — tearing down and recreating BOTH Process Tap AND Aggregate Device. Transcript interval may be incomplete."
            )
            Task { await IncidentRelay.shared.emit(incident) }

            // Atomic teardown of BOTH the tap AND the aggregate device (Pitfall 1).
            self._stopLocked()

            // Recreate.
            let success = self._startLocked()
            self.isRecreating = false
            if !success {
                print("[AudioTap] watchdog recreate failed — loopback tap will not restart")
            }
        }
    }
}
