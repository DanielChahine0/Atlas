// OutboxChannelTests.swift — XCTest unit tests for OutboxChannel.swift
//
// Privacy invariant T-03-04-04:
//   - ACK is sent ONLY after a successful execute.
//   - A failed execute must NOT call ack; the command stays pending.
//   - Commands are processed SERIALLY (for loop, never TaskGroup).
//
// Tests inject a fake HTTPDataFetcher and a failing CommandExecutor to verify
// the no-ack-on-failure invariant without making real network calls.

import XCTest
@testable import Shared

// MARK: - Mock HTTPDataFetcher

/// Records which URLs were called + their HTTP methods.
/// Returns pre-configured responses for poll and ack endpoints.
final class MockHTTPFetcher: HTTPDataFetcher, @unchecked Sendable {
    struct Call: Sendable {
        let url: String
        let method: String
    }

    var calls: [Call] = []
    var pollCommands: [CloudCommand] = []
    var pollStatusCode: Int = 200
    var ackStatusCode: Int = 200

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let url = request.url?.absoluteString ?? ""
        let method = request.httpMethod ?? "GET"
        calls.append(Call(url: url, method: method))

        let statusCode: Int
        let body: Data

        if url.contains("capture/poll") {
            statusCode = pollStatusCode
            body = (try? JSONEncoder().encode(pollCommands)) ?? Data()
        } else if url.contains("capture/ack") {
            statusCode = ackStatusCode
            body = Data()
        } else {
            statusCode = 404
            body = Data()
        }

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: nil
        )!
        return (body, response)
    }
}

// MARK: - Mock CommandExecutors

/// An executor that always succeeds.
final class SucceedingExecutor: CommandExecutor, @unchecked Sendable {
    var executed: [CloudCommand] = []
    func execute(_ command: CloudCommand) async throws {
        executed.append(command)
    }
}

/// An executor that always fails (throws a test error).
final class FailingExecutor: CommandExecutor, @unchecked Sendable {
    var executed: [CloudCommand] = []
    struct TestError: Error {}
    func execute(_ command: CloudCommand) async throws {
        executed.append(command)
        throw TestError()
    }
}

/// An executor that fails on the Nth invocation (0-indexed).
final class PartiallyFailingExecutor: CommandExecutor, @unchecked Sendable {
    let failOnIndex: Int
    var executed: [CloudCommand] = []
    var callCount = 0
    struct TestError: Error {}

    init(failOnIndex: Int) { self.failOnIndex = failOnIndex }

    func execute(_ command: CloudCommand) async throws {
        let idx = callCount
        callCount += 1
        executed.append(command)
        if idx == failOnIndex { throw TestError() }
    }
}

// MARK: - OutboxChannelTests

final class OutboxChannelTests: XCTestCase {

    // Helper: create an OutboxChannel backed by a mock HTTP fetcher.
    private func makeChannel(
        fetcher: MockHTTPFetcher,
        executor: (any CommandExecutor)? = nil
    ) async throws -> (channel: OutboxChannel, auth: Auth) {
        let auth = Auth(service: "com.atlas.capture.test", account: "test-\(UUID().uuidString)")
        try auth.store(token: "test-bearer-token")

        let channel = OutboxChannel(
            auth: auth,
            baseURL: URL(string: "https://test.atlas.workers.dev")!,
            session: fetcher,
            executor: executor
        )
        return (channel, auth)
    }

    // MARK: - Successful drain: ack called after execute succeeds

    func testDrainOnce_onSuccess_acksAfterExecute() async throws {
        let fetcher = MockHTTPFetcher()
        let executor = SucceedingExecutor()
        fetcher.pollCommands = [CloudCommand(idem: "test-idem-1", type: "echo.open-session", payload: nil)]

        let (channel, auth) = try await makeChannel(fetcher: fetcher, executor: executor)
        defer { try? auth.deleteToken() }

        let count = try await channel.drainOnce()

        XCTAssertEqual(count, 1, "One command drained")
        XCTAssertEqual(executor.executed.count, 1, "Executor invoked once")

        let ackCalls = fetcher.calls.filter { $0.url.contains("capture/ack") }
        XCTAssertEqual(ackCalls.count, 1, "Ack called exactly once (after successful execute)")
        XCTAssertEqual(ackCalls[0].method, "POST", "Ack must be POST")
    }

    // MARK: - T-03-04-04: Failed execute MUST NOT call ack

    func testDrainOnce_onExecuteFailure_doesNotAck_commandStaysPending() async throws {
        let fetcher = MockHTTPFetcher()
        let executor = FailingExecutor()
        fetcher.pollCommands = [CloudCommand(idem: "test-idem-fail", type: "echo.open-session", payload: nil)]

        let (channel, auth) = try await makeChannel(fetcher: fetcher, executor: executor)
        defer { try? auth.deleteToken() }

        do {
            _ = try await channel.drainOnce()
            XCTFail("Expected drainOnce to throw on execute failure")
        } catch OutboxChannelError.executeFailed(let idem, _) {
            XCTAssertEqual(idem, "test-idem-fail", "Error must carry the failing command's idem key")
        }

        // THE CRITICAL ASSERTION (T-03-04-04): ack must NOT be sent when execute fails.
        let ackCalls = fetcher.calls.filter { $0.url.contains("capture/ack") }
        XCTAssertEqual(ackCalls.count, 0,
                       "ACK must NOT be sent when execute fails — command stays pending (T-03-04-04)")

        // Execute was called before the failure.
        XCTAssertEqual(executor.executed.count, 1, "Executor was invoked before failure")
    }

    // MARK: - Serial processing: commands in FIFO order

    func testDrainOnce_processesCommandsSerially() async throws {
        let fetcher = MockHTTPFetcher()
        let executor = SucceedingExecutor()
        fetcher.pollCommands = [
            CloudCommand(idem: "idem-1", type: "cmd.a", payload: nil),
            CloudCommand(idem: "idem-2", type: "cmd.b", payload: nil),
            CloudCommand(idem: "idem-3", type: "cmd.c", payload: nil),
        ]

        let (channel, auth) = try await makeChannel(fetcher: fetcher, executor: executor)
        defer { try? auth.deleteToken() }

        let count = try await channel.drainOnce()

        XCTAssertEqual(count, 3, "All three commands drained")
        XCTAssertEqual(executor.executed.map(\.idem), ["idem-1", "idem-2", "idem-3"],
                       "Commands processed in FIFO order (serial, not concurrent)")

        let ackCalls = fetcher.calls.filter { $0.url.contains("capture/ack") }
        XCTAssertEqual(ackCalls.count, 3, "Three acks for three commands")
    }

    // MARK: - Partial failure: first command acked, second fails, third never executed

    func testDrainOnce_partialFailure_stopsAtFailedCommand() async throws {
        let fetcher = MockHTTPFetcher()
        let executor = PartiallyFailingExecutor(failOnIndex: 1) // second command fails
        fetcher.pollCommands = [
            CloudCommand(idem: "idem-ok",   type: "cmd.a", payload: nil),
            CloudCommand(idem: "idem-fail", type: "cmd.b", payload: nil),
            CloudCommand(idem: "idem-skip", type: "cmd.c", payload: nil),
        ]

        let (channel, auth) = try await makeChannel(fetcher: fetcher, executor: executor)
        defer { try? auth.deleteToken() }

        do {
            _ = try await channel.drainOnce()
            XCTFail("Expected drainOnce to throw on second command failure")
        } catch OutboxChannelError.executeFailed(let idem, _) {
            XCTAssertEqual(idem, "idem-fail")
        }

        // First command was acked (succeeded).
        let ackCalls = fetcher.calls.filter { $0.url.contains("capture/ack") }
        XCTAssertEqual(ackCalls.count, 1, "Only the first (successful) command was acked")

        // Third command was never executed (serial loop stopped at failure).
        XCTAssertEqual(executor.executed.count, 2,
                       "Executor called for first (ok) and second (fail) — not third (skipped)")
    }

    // MARK: - Empty poll: drains zero, no acks

    func testDrainOnce_emptyPoll_drainsZero() async throws {
        let fetcher = MockHTTPFetcher()
        fetcher.pollCommands = []

        let (channel, auth) = try await makeChannel(fetcher: fetcher)
        defer { try? auth.deleteToken() }

        let count = try await channel.drainOnce()

        XCTAssertEqual(count, 0, "Empty poll returns 0")
        let ackCalls = fetcher.calls.filter { $0.url.contains("capture/ack") }
        XCTAssertEqual(ackCalls.count, 0, "No ack for empty poll")
    }

    // MARK: - Poll is called with GET

    func testDrainOnce_pollRequest_isGET() async throws {
        let fetcher = MockHTTPFetcher()
        fetcher.pollCommands = []

        let (channel, auth) = try await makeChannel(fetcher: fetcher)
        defer { try? auth.deleteToken() }

        _ = try await channel.drainOnce()

        let pollCalls = fetcher.calls.filter { $0.url.contains("capture/poll") }
        XCTAssertEqual(pollCalls.count, 1, "Poll called once")
        XCTAssertEqual(pollCalls[0].method, "GET", "Poll must be a GET")
    }

    // MARK: - Missing token: drainOnce returns 0 (go-live gate handled gracefully)

    func testDrainOnce_missingToken_returnsZero_gracefully() async throws {
        let fetcher = MockHTTPFetcher()
        // Auth without a seeded token (go-live gate scenario).
        let auth = Auth(service: "com.atlas.capture.test", account: "test-no-token-\(UUID().uuidString)")
        // No auth.store(token:) call.

        let channel = OutboxChannel(
            auth: auth,
            baseURL: URL(string: "https://test.atlas.workers.dev")!,
            session: fetcher
        )

        // When token is missing, poll() returns [] silently (go-live gate treated as retryable).
        let count = try await channel.drainOnce()
        XCTAssertEqual(count, 0, "Missing token returns 0 (poll returns empty, not a fatal error)")

        // No ack calls — nothing to ack.
        let ackCalls = fetcher.calls.filter { $0.url.contains("capture/ack") }
        XCTAssertEqual(ackCalls.count, 0, "No ack when token missing")
    }
}
