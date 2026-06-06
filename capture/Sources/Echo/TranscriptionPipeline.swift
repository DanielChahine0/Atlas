// TranscriptionPipeline.swift — WhisperKit STT + FluidAudio LSEENDDiarizer
//
// TWO-CHANNEL DIARIZATION STRATEGY (D3-06):
//   mic channel     → hardcoded "Owner" label (deterministic, no model needed)
//   loopback channel → FluidAudio DiarizerManager splits multiple remote speakers
//                      into "Speaker 2", "Speaker 3", etc.
//
// AUDIO FORMAT (Pitfall 6):
//   FluidAudio requires 16 kHz MONO Float32. Core Audio delivers 44.1 kHz or 48 kHz
//   stereo (device-dependent). We resample + downmix each channel before feeding
//   WhisperKit or FluidAudio.
//
// WHISPERKIT MODEL:
//   argmax-oss-swift v1.0.0 monorepo — product "WhisperKit".
//   Model: "large-v3-turbo" (Assumption A2 in RESEARCH.md).
//   WhisperKit downloads the model from HuggingFace on first use.
//   API: transcribe(audioArray: [Float]) -> [TranscriptionResult]
//
// FLUIDAUDIO DIARIZER API:
//   DiarizerManager.performCompleteDiarization(_ samples:) -> DiarizationResult
//   DiarizationResult.segments is [TimedSpeakerSegment] with .speakerId, .startTimeSeconds,
//   .endTimeSeconds, .qualityScore (used as confidence proxy).
//   No streaming addAudio/process API — batch-only (offline diarization).
//
// SEGMENT CONTRACT (matches 03-02 transcript.ts TranscriptSegment shape):
//   { speaker, text, start_ts, end_ts, confidence, idx }
//   Low-confidence loopback splits (confidence < 0.6) are KEPT as "Speaker N" + P4 flag.
//   They are NEVER silently dropped (D3-06 / T-03-05-06).

import Foundation
import Shared
import WhisperKit
import FluidAudio

// MARK: - Transcript segment (mirrors 03-02 transcript.ts TranscriptSegment)

/// A single diarized + transcribed segment of a meeting.
/// Conforms to the 03-02 cloud contract (apps/echo/src/transcript.ts).
public struct TranscriptSegment: Codable, Sendable {
    /// Speaker label: "Owner" (mic), "Speaker 2", "Speaker 3", … (loopback diarization)
    public let speaker: String
    /// Transcribed text for this segment.
    public let text: String
    /// Segment start time (seconds from meeting start).
    public let start_ts: Double
    /// Segment end time (seconds from meeting start).
    public let end_ts: Double
    /// Speaker-identification confidence (0.0 – 1.0). < 0.6 = kept + flagged P4.
    public let confidence: Double
    /// Monotonically-increasing index for ordering (idempotency key in EchoSession DO).
    public let idx: Int

    public init(speaker: String, text: String, start_ts: Double, end_ts: Double,
                confidence: Double, idx: Int) {
        self.speaker = speaker
        self.text = text
        self.start_ts = start_ts
        self.end_ts = end_ts
        self.confidence = confidence
        self.idx = idx
    }
}

// MARK: - Pipeline delegate

/// Receives transcribed + diarized segments from the pipeline.
public protocol TranscriptionPipelineDelegate: AnyObject, Sendable {
    func pipeline(_ pipeline: TranscriptionPipeline, didProduceSegment segment: TranscriptSegment)
}

// MARK: - Audio format helpers (pure functions — testable without hardware)

/// Downmix a stereo (or multi-channel) Float32 buffer to mono.
/// Returns the input unchanged if already mono.
public func downmixToMono(_ samples: [Float], channelCount: Int) -> [Float] {
    guard channelCount > 1 else { return samples }
    let frameCount = samples.count / channelCount
    var mono = [Float](repeating: 0, count: frameCount)
    for frame in 0..<frameCount {
        var sum: Float = 0
        for ch in 0..<channelCount {
            sum += samples[frame * channelCount + ch]
        }
        mono[frame] = sum / Float(channelCount)
    }
    return mono
}

/// Linear-interpolation resampler: from `sourceSampleRate` to `targetSampleRate`.
/// Suitable for converting 44100 Hz or 48000 Hz to 16000 Hz before FluidAudio / WhisperKit.
public func resample(_ samples: [Float], from sourceSampleRate: Double, to targetSampleRate: Double) -> [Float] {
    guard sourceSampleRate != targetSampleRate, !samples.isEmpty else { return samples }
    let ratio = sourceSampleRate / targetSampleRate
    let targetCount = Int(Double(samples.count) / ratio)
    guard targetCount > 0 else { return [] }
    var output = [Float](repeating: 0, count: targetCount)
    for i in 0..<targetCount {
        let srcIdx = Double(i) * ratio
        let lo = Int(srcIdx)
        let hi = min(lo + 1, samples.count - 1)
        let frac = Float(srcIdx - Double(lo))
        output[i] = samples[lo] * (1.0 - frac) + samples[hi] * frac
    }
    return output
}

/// Full conversion: downmix to mono + resample to 16 kHz.
/// This is what FluidAudio (and WhisperKit) require (Pitfall 6).
public func toMono16k(_ samples: [Float], channelCount: Int, sampleRate: Double) -> [Float] {
    let mono = downmixToMono(samples, channelCount: channelCount)
    return resample(mono, from: sampleRate, to: 16_000.0)
}

// MARK: - TranscriptionPipeline

/// Manages WhisperKit + FluidAudio for on-device STT + diarization.
///
/// Owner of two parallel transcription paths:
///   1. Mic path:      accumulated Float32 (16 kHz mono) → WhisperKit → emit segment with speaker="Owner"
///   2. Loopback path: batch Float32 (16 kHz mono) → DiarizerManager.performCompleteDiarization →
///                     [TimedSpeakerSegment] → per-segment WhisperKit transcription → emit with speaker="Speaker N"
///
/// All audio is resampled to 16 kHz mono Float32 before processing (Pitfall 6).
/// Low-confidence speaker splits (qualityScore < 0.6) are KEPT + flagged P4 (T-03-05-06).
///
/// THREAD SAFETY: Pipeline operations are dispatched to a serial internal queue.
/// Delegate callbacks are dispatched asynchronously (not on the pipeline queue).
public final class TranscriptionPipeline: @unchecked Sendable {

    // MARK: - Configuration

    public weak var delegate: (any TranscriptionPipelineDelegate)?

    /// WhisperKit model identifier (Assumption A2 in RESEARCH.md — large-v3-turbo).
    public static let whisperModel = "large-v3-turbo"

    /// Speaker confidence threshold below which a segment is kept but flagged P4.
    public static let lowConfidenceThreshold: Double = 0.6

    // MARK: - Internal state

    private var whisperKit: WhisperKit?
    private var loopbackDiarizer: DiarizerManager?
    private var meetingStartEpoch: Double = 0
    private var segmentIndex: Int = 0

    // Accumulated mic samples (16 kHz mono) for batch transcription at flush.
    private var micSamples: [Float] = []

    // MARK: - Serial queue for pipeline operations

    private let pipelineQueue = DispatchQueue(label: "com.atlas.capture.pipeline", qos: .userInitiated)

    // MARK: - Init

    public init() {}

    // MARK: - Lifecycle

    /// Initialise WhisperKit and FluidAudio models.
    /// Downloads models on first call (cached thereafter by each library).
    /// Call from a background task — model download can take time.
    public func prepare() async throws {
        // WhisperKit: argmax-oss-swift v1.0.0, model large-v3-turbo.
        whisperKit = try await WhisperKit(model: Self.whisperModel)

        // FluidAudio: download diarization models if not cached.
        let models = try await DiarizerModels.downloadIfNeeded()
        let diarizer = DiarizerManager()
        diarizer.initialize(models: models)
        loopbackDiarizer = diarizer

        meetingStartEpoch = Date().timeIntervalSince1970
        segmentIndex = 0
    }

    /// Reset state for a new meeting session.
    public func reset() {
        pipelineQueue.sync {
            micSamples = []
            segmentIndex = 0
            meetingStartEpoch = Date().timeIntervalSince1970
        }
    }

    // MARK: - Audio ingestion (called by AudioTap delegate callbacks)

    /// Ingest mic samples (will be labeled "Owner" deterministically).
    /// - Parameters:
    ///   - samples: Raw Float32 samples at the device's native sample rate.
    ///   - sampleRate: Native sample rate of `samples`.
    ///   - channelCount: Number of interleaved channels (default 1 for mic).
    public func ingestMicSamples(_ samples: [Float], sampleRate: Double, channelCount: Int = 1) {
        pipelineQueue.async { [weak self] in
            guard let self else { return }
            let mono16k = toMono16k(samples, channelCount: channelCount, sampleRate: sampleRate)
            self.micSamples += mono16k
        }
    }

    /// Ingest loopback samples (will be diarized by FluidAudio into remote speakers).
    ///
    /// FluidAudio is batch-only (offline diarization). This method accumulates samples
    /// and diarizes when `flushLoopbackChannel()` is called at meeting end.
    /// For real-time use, callers may call `flushLoopbackChannel()` periodically.
    ///
    /// - Parameters:
    ///   - samples: Raw Float32 samples at the device's native sample rate.
    ///   - sampleRate: Native sample rate of `samples`.
    ///   - channelCount: Number of interleaved channels (default 2 for system output).
    private var loopbackSamples: [Float] = []
    public func ingestLoopbackSamples(_ samples: [Float], sampleRate: Double, channelCount: Int = 2) {
        pipelineQueue.async { [weak self] in
            guard let self else { return }
            let mono16k = toMono16k(samples, channelCount: channelCount, sampleRate: sampleRate)
            self.loopbackSamples += mono16k
        }
    }

    // MARK: - Transcribe accumulated mic buffer (Owner path)

    /// Transcribe all accumulated mic samples and emit a segment labeled "Owner".
    /// Call at the end of a meeting or on a flush interval.
    public func flushMicChannel(meetingOffsetSeconds: Double = 0.0) async {
        var samples: [Float] = []
        pipelineQueue.sync { samples = micSamples; micSamples = [] }
        guard !samples.isEmpty, let wk = whisperKit else { return }

        do {
            // WhisperKit transcribes the 16 kHz mono Float32 buffer.
            // transcribe(audioArray:) returns [TranscriptionResult].
            let results = try await wk.transcribe(audioArray: samples)
            let text = results.compactMap { $0.text }.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            let durationSec = Double(samples.count) / 16_000.0
            let segment = TranscriptSegment(
                speaker: "Owner",
                text: text,
                start_ts: meetingOffsetSeconds,
                end_ts: meetingOffsetSeconds + durationSec,
                confidence: 1.0,  // mic = Owner is deterministic (D3-06)
                idx: nextIndex()
            )
            delegate?.pipeline(self, didProduceSegment: segment)
        } catch {
            print("[TranscriptionPipeline] WhisperKit mic transcription error: \(error)")
        }
    }

    // MARK: - Diarize + transcribe loopback buffer (remote speakers path)

    /// Diarize and transcribe all accumulated loopback samples.
    /// Call at meeting end. Produces one segment per identified remote speaker turn.
    ///
    /// FluidAudio identifies speaker boundaries (startTimeSeconds/endTimeSeconds);
    /// WhisperKit transcribes each speaker's audio slice.
    public func flushLoopbackChannel(meetingOffsetSeconds: Double = 0.0) async {
        var samples: [Float] = []
        pipelineQueue.sync { samples = loopbackSamples; loopbackSamples = [] }
        guard !samples.isEmpty, let diarizer = loopbackDiarizer, let wk = whisperKit else { return }

        do {
            // FluidAudio: batch diarize the entire loopback buffer.
            // Returns DiarizationResult.segments: [TimedSpeakerSegment]
            let result = try diarizer.performCompleteDiarization(samples, sampleRate: 16_000)

            for seg in result.segments {
                // qualityScore is used as the confidence proxy.
                let confidence = Double(seg.qualityScore)
                let isLowConfidence = confidence < Self.lowConfidenceThreshold

                // KEEP the segment regardless of confidence (T-03-05-06 — never drop).
                // For low-confidence splits, emit a P4 incident.
                let speakerLabel = "Speaker \(seg.speakerId)"
                if isLowConfidence {
                    let incident = RawIncident(
                        severity: "P4",
                        kind: "echo.diarization.low-confidence-split",
                        sourceAgent: "Echo",
                        note: "Loopback diarization segment for '\(speakerLabel)' has confidence \(String(format: "%.2f", confidence)) < 0.6. Kept; Archivist 'correct the speakers' step will surface this."
                    )
                    Task { await IncidentRelay.shared.emit(incident) }
                }

                // Extract the audio slice for this speaker turn and transcribe with WhisperKit.
                let startFrame = Int(Double(seg.startTimeSeconds) * 16_000.0)
                let endFrame = min(Int(Double(seg.endTimeSeconds) * 16_000.0), samples.count)
                guard startFrame < endFrame else { continue }
                let audioSlice = Array(samples[startFrame..<endFrame])

                let text: String
                do {
                    let results = try await wk.transcribe(audioArray: audioSlice)
                    text = results.compactMap { $0.text }.joined(separator: " ")
                        .trimmingCharacters(in: .whitespaces)
                } catch {
                    print("[TranscriptionPipeline] WhisperKit loopback segment error: \(error)")
                    text = ""
                }

                let startTs = meetingOffsetSeconds + Double(seg.startTimeSeconds)
                let endTs = meetingOffsetSeconds + Double(seg.endTimeSeconds)
                let segment = TranscriptSegment(
                    speaker: speakerLabel,
                    text: text,
                    start_ts: startTs,
                    end_ts: endTs,
                    confidence: confidence,
                    idx: nextIndex()
                )
                delegate?.pipeline(self, didProduceSegment: segment)
            }
        } catch {
            print("[TranscriptionPipeline] FluidAudio diarization error: \(error)")
        }
    }

    // MARK: - Index

    private func nextIndex() -> Int {
        var idx = 0
        pipelineQueue.sync { idx = segmentIndex; segmentIndex += 1 }
        return idx
    }
}
