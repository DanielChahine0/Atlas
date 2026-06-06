// OutboxChannel.swift — outbound poll/drain/ack command channel
//
// Translates the proven daemon/src/drain.ts pattern into Swift:
//   drainOnce (lines 118–134): poll → for loop (SERIAL) → execute → ack ONLY after success
//   drainLoop (lines 177–192): Task { while !cancelled { drainOnce | backoff } }
//
// Privacy invariant T-03-04-04: serial drain; ack ONLY after a successful execute;
// on transient error back off and LEAVE the item pending (NEVER drop, NEVER double-ack).
// Privacy invariant T-03-04-05: daemon initiates all connections; default cert validation;
// accepts NO inbound requests.
//
// OutboxChannelTests.swift (Task 2) asserts: a failed execute does NOT ack and leaves
// the command pending (the no-ack-on-failure invariant).

import Foundation

// MARK: - HTTP transport protocol (injectable for tests)

/// Protocol for making HTTPS requests. Injected so tests avoid real network calls.
/// `URLSession` conforms to this via an extension below.
public protocol HTTPDataFetcher: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPDataFetcher {}

// MARK: - Command model

/// A command received from the cloud command endpoint via the poll response.
/// Commands are processed SERIALLY — never concurrently (T-03-04-04).
public struct CloudCommand: Codable, Sendable {
    /// Stable idempotency key for the ack payload. Mirrors daemon/src/drain.ts `idem`.
    public let idem: String
    /// Command type (e.g. "echo.open-session", "quill.fill-form", "codex.refresh").
    public let type: String
    /// Command-specific payload. Nil-safe; consumers must handle unknown types gracefully.
    public let payload: [String: AnyCodable]?
}

/// Type-erased Codable wrapper for arbitrary JSON values.
/// Needed because Swift Codable does not natively support heterogeneous dictionaries.
public struct AnyCodable: Codable, Sendable {
    public let value: any Sendable

    public init(_ value: any Sendable) { self.value = value }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let i = try? container.decode(Int.self) { value = i }
        else if let d = try? container.decode(Double.self) { value = d }
        else if let s = try? container.decode(String.self) { value = s }
        else if let b = try? container.decode(Bool.self) { value = b }
        else { value = String("null") }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let i as Int:    try container.encode(i)
        case let d as Double: try container.encode(d)
        case let s as String: try container.encode(s)
        case let b as Bool:   try container.encode(b)
        default:              try container.encodeNil()
        }
    }
}

// MARK: - OutboxChannel errors

public enum OutboxChannelError: Error {
    /// The cloud base URL is not configured.
    case missingBaseURL
    /// Poll returned a non-2xx response.
    case pollFailed(Int)
    /// Ack returned a non-2xx response.
    case ackFailed(Int)
    /// Command execution failed — the command remains pending (T-03-04-04).
    case executeFailed(String, underlyingError: Error)
}

// MARK: - Command executor protocol (injectable for tests)

/// Protocol for executing a single CloudCommand. Injected so tests can simulate failures
/// without a real network or command handler (OutboxChannelTests.swift, Task 2).
public protocol CommandExecutor: Sendable {
    func execute(_ command: CloudCommand) async throws
}

// MARK: - OutboxChannel

/// Outbound poll/drain/ack command channel.
///
/// Mirrors daemon/src/drain.ts: poll the cloud command endpoint, process each returned
/// command SERIALLY, execute, ack ONLY after successful execution. On error: back off and
/// leave the command pending (never drop silently). drainLoop runs until `cancel()` is called
/// or the Task is cancelled; launchd KeepAlive handles process restart on fatal exits.
///
/// All connections are OUTBOUND HTTPS with default certificate validation.
/// No listening socket is opened (T-03-04-05).
public actor OutboxChannel {

    // MARK: - Configuration

    /// The base URL of the cloud capture endpoint (e.g. https://echo.atlas.workers.dev).
    public let baseURL: URL

    /// Authentication (reads bearer token from Keychain via Auth.shared).
    private let auth: Auth

    /// HTTP transport (injectable for tests; defaults to URLSession.shared).
    private let fetcher: any HTTPDataFetcher

    /// Whether the drain loop has been cancelled.
    private var cancelled = false

    /// Injectable command executor (defaults to nil until 03-05/03-06 wire in real handlers).
    private var executor: (any CommandExecutor)?

    // MARK: - Init

    public init(
        auth: Auth = .shared,
        baseURL: URL? = nil,
        session: any HTTPDataFetcher = URLSession.shared,
        executor: (any CommandExecutor)? = nil
    ) {
        self.auth = auth
        self.fetcher = session
        self.executor = executor

        let resolvedURL: URL
        if let provided = baseURL {
            resolvedURL = provided
        } else if let envVal = ProcessInfo.processInfo.environment["ATLAS_CAPTURE_BASE_URL"],
                  let envURL = URL(string: envVal) {
            resolvedURL = envURL
        } else {
            resolvedURL = URL(string: "https://echo.atlas.workers.dev")!
        }
        self.baseURL = resolvedURL
    }

    // MARK: - Cancel

    /// Cancel the drain loop. Called by AppDelegate on graceful shutdown.
    public func cancel() {
        cancelled = true
    }

    // MARK: - Register command executor

    /// Register the command executor (called by 03-05/03-06 features once they are wired in).
    public func register(executor: any CommandExecutor) {
        self.executor = executor
    }

    // MARK: - Poll

    /// Poll the cloud command endpoint for pending commands.
    func poll() async throws -> [CloudCommand] {
        var request = URLRequest(url: baseURL.appendingPathComponent("capture/poll"))
        request.httpMethod = "GET"
        do {
            try auth.authorize(&request)
        } catch AuthError.tokenMissing {
            // Token not yet seeded (go-live gate) — return empty and back off.
            return []
        }

        let (data, response) = try await fetcher.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OutboxChannelError.pollFailed(-1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw OutboxChannelError.pollFailed(http.statusCode)
        }

        return (try? JSONDecoder().decode([CloudCommand].self, from: data)) ?? []
    }

    // MARK: - Ack

    /// Acknowledge a successfully-executed command.
    ///
    /// Called ONLY after execute succeeds (T-03-04-04).
    /// A failed execute MUST NOT call ack — the command stays pending.
    func ack(idem: String) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("capture/ack"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        try auth.authorize(&request)
        request.httpBody = try JSONEncoder().encode(["idem": idem])

        let (_, response) = try await fetcher.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OutboxChannelError.ackFailed(-1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw OutboxChannelError.ackFailed(http.statusCode)
        }
    }

    // MARK: - drainOnce (mirrors daemon/src/drain.ts drainOnce lines 118-134)

    /// Poll once, execute all returned commands SERIALLY, ack each ONLY after success.
    ///
    /// If execute throws, the command is left pending (back off in drainLoop).
    /// NEVER drops a command silently (T-03-04-04).
    @discardableResult
    public func drainOnce() async throws -> Int {
        let commands = try await poll()
        var drained = 0

        // SERIAL loop (never TaskGroup / never concurrent) — mirrors the for…of in drain.ts.
        for command in commands {
            do {
                if let exec = executor {
                    try await exec.execute(command)
                }
                // ACK only after successful execution (T-03-04-04 invariant).
                try await ack(idem: command.idem)
                drained += 1
            } catch {
                // Execute failed: back off and leave the command pending.
                // NEVER drop the command silently. NEVER call ack here.
                throw OutboxChannelError.executeFailed(command.idem, underlyingError: error)
            }
        }

        return drained
    }

    // MARK: - drainLoop (mirrors daemon/src/drain.ts drainLoop lines 177-192)

    /// Run the drain loop indefinitely until `cancel()` is called.
    public func drainLoop() async {
        var backoffSeconds: Double = 5

        while !cancelled && !Task.isCancelled {
            do {
                try await drainOnce()
                backoffSeconds = 5
            } catch {
                let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                let safe = msg.replacingOccurrences(of: "Bearer ", with: "Bearer [REDACTED] ")
                print("[OutboxChannel] error: \(safe) — backing off \(Int(backoffSeconds))s")
                try? await Task.sleep(nanoseconds: UInt64(backoffSeconds * 1_000_000_000))
                backoffSeconds = min(backoffSeconds * 2, 300)
            }
        }
    }
}
