// EchoSession.swift — outbound WebSocket client to the cloud EchoSession DO
//
// OUTBOUND ONLY (D3-01, T-03-04-05):
//   The laptop has NO inbound port. The daemon initiates the WebSocket connection.
//   The cloud EchoSession DO (apps/echo) is the server. We connect to it.
//
// AUTHENTICATION (T-03-05-01):
//   Every WS upgrade request presents `Authorization: Bearer <token>`.
//   The token is read from the macOS Keychain via Auth.shared.readToken().
//   The cloud side validates via authenticateCapture(request, env) (03-02 auth.ts).
//
// SESSION ID (D3-08):
//   Stable per-meeting: "echo-<ISO-timestamp>" (e.g. echo-2026-06-06T14-00-03Z).
//   Used in reconnect-to-same-session and in the transcript.ready idempotency key.
//
// RECONNECT:
//   On WS close (non-fatal): exponential backoff, reconnect to SAME session_id.
//   On persistent failure: emit P2 incident, surface to AppDelegate for session end.
//
// TRANSCRIPT.READY (T-03-05-05):
//   At finalize(), emit a Wire event via the OutboxChannel's /capture/wire endpoint:
//   { agent:"Echo", type:"transcript.ready", entity:session_id, op:"append",
//     payload:{ session_id, segments:[...] }, idempotencyKey:"echo:<session_id>:ready" }
//
// PRESIGN / AUDIO UPLOAD (T-03-05-07):
//   Transcript JSON: always uploaded to transcripts/<session_id>/transcript.json via presign.
//   Raw audio: ONLY if audio_disposition == "r2-approved" (explicit owner approval).
//              Default disposition is NEVER to upload audio.
//   Presign endpoint: POST /echo/presign → { url } — uses Auth bearer.
//
// CLOUD WS ROUTE OPEN DEPENDENCY:
//   apps/echo/src/index.ts currently routes ONLY /health and /echo/presign.
//   There is NO public WS route to the EchoSession DO yet. This file constructs the
//   correct WS URL (wss://<host>/echo/ws?session_id=<id>) and will work once the cloud
//   adds the authenticated route. See SUMMARY.md — "Cloud WS Route (Open Dependency)".

import Foundation
import Shared

// MARK: - EchoSessionDelegate

public protocol EchoSessionDelegate: AnyObject, Sendable {
    /// Called when the WS connection becomes active (upgrade confirmed).
    func echoSessionDidConnect(_ session: EchoSession)
    /// Called when the WS connection closes (may reconnect).
    func echoSessionDidDisconnect(_ session: EchoSession, error: Error?)
    /// Called on persistent WS failure (no further reconnect attempts).
    func echoSessionDidFail(_ session: EchoSession)
}

// MARK: - WireEvent (transcript.ready)

private struct WireEvent: Encodable {
    let agent: String
    let type: String
    let entity: String
    let op: String
    let payload: TranscriptPayload
    let idempotencyKey: String

    struct TranscriptPayload: Encodable {
        let session_id: String
        let segments: [TranscriptSegment]
    }
}

// MARK: - EchoSession

/// Outbound WebSocket client for the Echo capture pipeline.
///
/// Manages the lifecycle of one meeting session:
///   open()     → connect WS, present bearer auth
///   send(_:)   → push a transcript segment to the cloud DO in real time
///   finalize() → emit transcript.ready Wire event, presign-upload transcript JSON
///   close()    → close WS, reset state
///
/// One EchoSession instance per meeting. EchoController creates a new one per consent.
public final class EchoSession: NSObject, @unchecked Sendable {

    // MARK: - Configuration

    /// Cloud capture base URL (e.g. https://echo.atlas.workers.dev).
    private let baseURL: URL
    private let auth: Auth
    private let fetcher: any HTTPDataFetcher

    /// Stable session ID for this meeting.
    public let sessionID: String

    /// Audio disposition: "r2-approved" enables raw audio upload to R2.
    /// Default is nil — no audio upload (privacy default).
    public var audioDisposition: String?

    // MARK: - State

    private let queue = DispatchQueue(label: "com.atlas.capture.echosession")
    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 5
    private var isClosed = false
    private var localSegments: [TranscriptSegment] = []
    private var heartbeatTimer: DispatchSourceTimer?

    // MARK: - Delegate

    public weak var delegate: (any EchoSessionDelegate)?

    // MARK: - Init

    public init(
        baseURL: URL? = nil,
        auth: Auth = .shared,
        session: any HTTPDataFetcher = URLSession.shared
    ) {
        // Generate stable session ID: echo-<ISO-8601 timestamp>
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        let ts = iso.string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: ".", with: "-")
        self.sessionID = "echo-\(ts)"

        if let provided = baseURL {
            self.baseURL = provided
        } else if let envVal = ProcessInfo.processInfo.environment["ATLAS_CAPTURE_BASE_URL"],
                  let envURL = URL(string: envVal) {
            self.baseURL = envURL
        } else {
            self.baseURL = URL(string: "https://echo.atlas.workers.dev")!
        }

        self.auth = auth
        self.fetcher = session
        super.init()
    }

    // MARK: - Open

    /// Open the WebSocket connection to the cloud EchoSession DO.
    ///
    /// Constructs wss://<host>/echo/ws?session_id=<sessionID> and presents
    /// Authorization: Bearer <token>. Starts a 15-minute heartbeat.
    ///
    /// CLOUD ROUTE OPEN DEPENDENCY: This URL will return 404 until
    /// apps/echo/src/index.ts adds the authenticated /echo/ws route. See SUMMARY.md.
    public func open() {
        queue.async { [weak self] in
            guard let self, !self.isClosed else { return }
            self._connectLocked()
        }
    }

    private func _connectLocked() {
        guard !isClosed else { return }

        // Build the WS URL: wss://<host>/echo/ws?session_id=<id>
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path = "/echo/ws"
        components.queryItems = [URLQueryItem(name: "session_id", value: sessionID)]

        guard let wsURL = components.url else {
            print("[EchoSession] failed to construct WS URL from \(baseURL)")
            return
        }

        var request = URLRequest(url: wsURL)
        do {
            try auth.authorize(&request)
        } catch {
            // Token missing — cannot open WS. Emit P2 (capture daemon cannot authenticate).
            let incident = RawIncident(
                severity: "P2",
                kind: "echo.session.auth-missing",
                sourceAgent: "Echo",
                runId: sessionID,
                note: "OAuth bearer token not found in Keychain. WS upgrade aborted. Complete D3-02 go-live gate."
            )
            Task { await IncidentRelay.shared.emit(incident) }
            return
        }

        // Create a dedicated URLSession for WS (NSObject delegate for callbacks).
        let config = URLSessionConfiguration.default
        let sess = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        urlSession = sess

        let task = sess.webSocketTask(with: request)
        webSocketTask = task
        task.resume()

        // Begin receiving messages (loop).
        _receiveLoop()

        // Start 15-minute heartbeat ping.
        _startHeartbeat()
    }

    // MARK: - Receive loop

    private func _receiveLoop() {
        webSocketTask?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                // Cloud DO may push acknowledgement or control messages.
                if case .string(let text) = message {
                    print("[EchoSession] received: \(text)")
                }
                // Continue receiving.
                self._receiveLoop()
            case .failure(let error):
                self.queue.async {
                    self._handleDisconnect(error: error)
                }
            }
        }
    }

    // MARK: - Send segment (real-time push)

    /// Push a transcript segment to the cloud EchoSession DO in real time.
    /// Also buffers locally for the finalize() presign upload.
    public func send(_ segment: TranscriptSegment) {
        queue.async { [weak self] in
            guard let self, !self.isClosed else { return }
            self.localSegments.append(segment)

            guard let encoded = try? JSONEncoder().encode(segment),
                  let json = String(data: encoded, encoding: .utf8) else { return }
            self.webSocketTask?.send(.string(json)) { error in
                if let error {
                    print("[EchoSession] WS send error: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: - Finalize (transcript.ready + presign upload)

    /// Finalize the session: emit transcript.ready Wire event, presign-upload transcript JSON.
    ///
    /// transcript.ready idempotencyKey: "echo:<sessionID>:ready" (stable, structured — D3-08).
    /// Raw audio upload: ONLY if audioDisposition == "r2-approved".
    public func finalize() async {
        let segments: [TranscriptSegment] = queue.sync { localSegments }

        // 1. Emit transcript.ready via OutboxChannel /capture/wire
        await emitTranscriptReady(segments: segments)

        // 2. Presign-upload transcript JSON to transcripts/<sessionID>/transcript.json
        await uploadTranscriptJSON(segments: segments)

        // 3. Raw audio upload only if explicitly approved (privacy default: skip).
        // audioDisposition is set by the owner approval flow — default nil means no upload.
        if audioDisposition == "r2-approved" {
            await uploadRawAudio()
        }
    }

    private func emitTranscriptReady(segments: [TranscriptSegment]) async {
        let event = WireEvent(
            agent: "Echo",
            type: "transcript.ready",
            entity: sessionID,
            op: "append",
            payload: WireEvent.TranscriptPayload(session_id: sessionID, segments: segments),
            idempotencyKey: "echo:\(sessionID):ready"
        )

        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("capture/wire"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            try auth.authorize(&request)
            request.httpBody = try JSONEncoder().encode(event)
            let (_, response) = try await fetcher.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                print("[EchoSession] wire emit returned \(http.statusCode)")
            }
        } catch {
            let incident = RawIncident(
                severity: "P2",
                kind: "echo.session.wire-emit-failed",
                sourceAgent: "Echo",
                runId: sessionID,
                note: "transcript.ready Wire emit failed: \(error.localizedDescription)"
            )
            Task { await IncidentRelay.shared.emit(incident) }
        }
    }

    private func uploadTranscriptJSON(segments: [TranscriptSegment]) async {
        guard let presignURL = await presign(key: "transcripts/\(sessionID)/transcript.json") else {
            return
        }
        do {
            let data = try JSONEncoder().encode(segments)
            var put = URLRequest(url: presignURL)
            put.httpMethod = "PUT"
            put.setValue("application/json", forHTTPHeaderField: "Content-Type")
            put.httpBody = data
            let (_, response) = try await fetcher.data(for: put)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                print("[EchoSession] transcript JSON upload returned \(http.statusCode)")
            }
        } catch {
            print("[EchoSession] transcript JSON upload error: \(error.localizedDescription)")
        }
    }

    /// Raw audio upload — ONLY called when audioDisposition == "r2-approved".
    /// Audio is always tagged raw/ with a 7-day expiry (per R2 lifecycle rule in CLAUDE.md).
    private func uploadRawAudio() async {
        // Raw audio data would be passed in from the capture layer. For now this is a stub
        // that obtains a presigned URL for the correct key. The actual audio bytes are
        // delivered from AudioTap / AVAudioEngine by the caller before finalize().
        // This stub establishes the key path — full wiring is in the caller.
        _ = await presign(key: "audio/raw/\(sessionID)/audio.caf")
        // Actual PUT is wired by EchoController which has the raw audio buffer reference.
    }

    // MARK: - Presign helper

    private func presign(key: String) async -> URL? {
        guard let body = try? JSONEncoder().encode(["key": key]) else { return nil }
        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("echo/presign"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            try auth.authorize(&request)
            request.httpBody = body
            let (data, _) = try await fetcher.data(for: request)
            struct PresignResponse: Decodable { let url: String }
            if let resp = try? JSONDecoder().decode(PresignResponse.self, from: data),
               let url = URL(string: resp.url) {
                return url
            }
        } catch {
            print("[EchoSession] presign error for key \(key): \(error.localizedDescription)")
        }
        return nil
    }

    // MARK: - Close

    /// Close the WS connection and mark the session as closed (no further reconnects).
    public func close() {
        queue.async { [weak self] in
            guard let self else { return }
            self.isClosed = true
            self.heartbeatTimer?.cancel()
            self.heartbeatTimer = nil
            self.webSocketTask?.cancel(with: .normalClosure, reason: nil)
            self.webSocketTask = nil
            self.urlSession?.invalidateAndCancel()
            self.urlSession = nil
        }
    }

    // MARK: - Heartbeat

    private func _startHeartbeat() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        // 15-minute heartbeat ping to keep the WS alive during silent meeting segments.
        timer.schedule(deadline: .now() + 900, repeating: 900.0)
        timer.setEventHandler { [weak self] in
            self?.webSocketTask?.sendPing { _ in }
        }
        timer.resume()
        heartbeatTimer = timer
    }

    // MARK: - Reconnect

    private func _handleDisconnect(error: Error?) {
        guard !isClosed else { return }
        let del = delegate
        DispatchQueue.main.async {
            del?.echoSessionDidDisconnect(self, error: error)
        }

        reconnectAttempts += 1
        guard reconnectAttempts <= maxReconnectAttempts else {
            // Persistent failure — emit P2 and surface to delegate.
            let incident = RawIncident(
                severity: "P2",
                kind: "echo.session.persistent-disconnect",
                sourceAgent: "Echo",
                runId: sessionID,
                note: "EchoSession WS disconnected \(reconnectAttempts) times. Giving up. Transcript may be incomplete."
            )
            Task { await IncidentRelay.shared.emit(incident) }
            let delFail = delegate
            DispatchQueue.main.async { delFail?.echoSessionDidFail(self) }
            return
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s.
        let backoff = UInt64(min(pow(2.0, Double(reconnectAttempts - 1)), 16.0) * 1_000_000_000)
        DispatchQueue.global().asyncAfter(deadline: .now() + .nanoseconds(Int(backoff))) { [weak self] in
            self?.queue.async {
                guard let self, !self.isClosed else { return }
                // Reconnect to the SAME session_id (reconnect-to-same-session D3-08).
                self.webSocketTask = nil
                self.urlSession?.invalidateAndCancel()
                self.urlSession = nil
                self._connectLocked()
            }
        }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension EchoSession: URLSessionWebSocketDelegate {
    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        reconnectAttempts = 0
        let del = delegate
        DispatchQueue.main.async {
            del?.echoSessionDidConnect(self)
        }
    }

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        queue.async { [weak self] in
            self?._handleDisconnect(error: nil)
        }
    }
}
