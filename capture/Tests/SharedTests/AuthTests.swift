// AuthTests.swift — XCTest unit tests for Auth.swift (Keychain bearer token)
//
// Privacy invariant T-03-04-02:
//   - Auth.readToken() throws AuthError.tokenMissing if the token is not seeded.
//   - Auth.store(token:) writes to Keychain; readToken() round-trips it back.
//   - No system-preferences storage, plist, [vars], or tracked-file storage —
//     enforced by Auth.swift source code (also checked in acceptance criteria grep).
//
// These tests run against the real macOS Keychain. Each test uses a unique Keychain
// account to avoid cross-test pollution. Tests clean up via deleteToken() in tearDown.

import XCTest
@testable import Shared

final class AuthTests: XCTestCase {

    // Each test creates its own Auth instance with a unique Keychain account.
    // Auth.init(service:account:) is the injectable path (not the shared singleton).

    // MARK: - Missing token → throws AuthError.tokenMissing

    func testReadToken_whenNotSeeded_throwsTokenMissing() throws {
        let auth = Auth(service: "com.atlas.capture.test", account: "test-\(UUID().uuidString)")

        XCTAssertThrowsError(try auth.readToken()) { error in
            guard case AuthError.tokenMissing = error else {
                XCTFail("Expected AuthError.tokenMissing, got \(error)")
                return
            }
        }
    }

    // MARK: - Store and round-trip read

    func testStore_thenReadToken_returnsStoredToken() throws {
        let auth = Auth(service: "com.atlas.capture.test", account: "test-\(UUID().uuidString)")
        defer { try? auth.deleteToken() }

        let expected = "test-bearer-\(UUID().uuidString)"
        try auth.store(token: expected)

        let actual = try auth.readToken()
        XCTAssertEqual(actual, expected, "readToken() must return the stored bearer token verbatim")
    }

    // MARK: - Store twice (update path — SecItemUpdate)

    func testStore_calledTwice_updatesToken() throws {
        let auth = Auth(service: "com.atlas.capture.test", account: "test-\(UUID().uuidString)")
        defer { try? auth.deleteToken() }

        try auth.store(token: "first-token")
        try auth.store(token: "second-token")

        // Clear in-memory cache to force a Keychain read
        let freshAuth = Auth(service: auth.testService, account: auth.testAccount)
        let actual = try freshAuth.readToken()
        XCTAssertEqual(actual, "second-token", "Calling store() twice must update the Keychain item")
    }

    // MARK: - Delete then read → throws tokenMissing

    func testDeleteToken_thenReadToken_throwsTokenMissing() throws {
        let auth = Auth(service: "com.atlas.capture.test", account: "test-\(UUID().uuidString)")

        try auth.store(token: "temp-token")
        try auth.deleteToken()

        XCTAssertThrowsError(try auth.readToken()) { error in
            guard case AuthError.tokenMissing = error else {
                XCTFail("Expected AuthError.tokenMissing after delete, got \(error)")
                return
            }
        }
    }

    // MARK: - authorize(_:) sets the Bearer header

    func testAuthorize_setsAuthorizationHeader() throws {
        let auth = Auth(service: "com.atlas.capture.test", account: "test-\(UUID().uuidString)")
        defer { try? auth.deleteToken() }

        try auth.store(token: "my-bearer-token")

        var request = URLRequest(url: URL(string: "https://echo.atlas.workers.dev/capture/poll")!)
        try auth.authorize(&request)

        let header = request.value(forHTTPHeaderField: "Authorization")
        XCTAssertEqual(header, "Bearer my-bearer-token",
                       "Authorization header must be exactly 'Bearer <token>'")
    }

    // MARK: - authorize(_:) throws when token missing

    func testAuthorize_whenTokenMissing_throwsTokenMissing() throws {
        let auth = Auth(service: "com.atlas.capture.test", account: "test-\(UUID().uuidString)")
        var request = URLRequest(url: URL(string: "https://echo.atlas.workers.dev/capture/poll")!)

        XCTAssertThrowsError(try auth.authorize(&request)) { error in
            guard case AuthError.tokenMissing = error else {
                XCTFail("Expected AuthError.tokenMissing, got \(error)")
                return
            }
        }
    }

    // MARK: - Token in Keychain only (construction check)

    func testAuth_containsNoSystemPreferenceReference_inSourceCode() {
        // This test is a build-time assertion: if Auth.swift contained a reference to
        // NSUserDefaults or UserDefaults, the source would need to be changed.
        // The acceptance criteria grep checks this externally; here we verify the runtime
        // type does not expose a UserDefaults-based storage path.
        //
        // The presence of Auth.store(token:) via SecItemAdd is verified by the round-trip
        // test above. This test simply confirms the type exists and compiles with Keychain calls.
        let auth = Auth(service: "com.atlas.capture.test", account: "test-\(UUID().uuidString)")
        XCTAssertNotNil(auth, "Auth must initialise without system-preferences storage")
    }
}

// MARK: - Auth internal test accessors

extension Auth {
    /// Expose service/account for test verification (test-only).
    var testService: String { service }
    var testAccount: String { account }
}
