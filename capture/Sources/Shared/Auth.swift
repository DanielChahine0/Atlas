// Auth.swift — OAuth bearer token read/store via macOS Keychain
//
// Privacy invariant T-03-04-02: the OAuth bearer is stored in the macOS Keychain ONLY.
// Never in system preferences storage, a plist, [vars], the Vault, the Codex, or any tracked file.
//
// Contract (mirrors daemon/src/drain.ts loadConfig + pollOnce patterns):
//   - Read: SecItemCopyMatching → extract token as String
//   - Store: SecItemAdd (called at first OAuth grant, owner go-live gate D3-02)
//   - Missing token: throw AuthError.tokenMissing — loud fatal, never fabricate
//   - All outbound URLSession calls set Authorization: Bearer <token>
//   - No listening socket is ever opened (outbound only, T-03-04-05)
//
// Full implementation provided here so the executable target compiles in Task 1.
// Task 2 adds AuthTests.swift (XCTest assertions for all Auth invariants).

import Foundation
import Security

// MARK: - Auth errors

public enum AuthError: Error, LocalizedError {
    /// The OAuth bearer token is not present in the Keychain.
    /// This is a go-live gate (D3-02) — the owner must seed the token after OAuth grant.
    case tokenMissing
    /// Keychain returned an unexpected status code.
    case keychainError(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .tokenMissing:
            return """
                Atlas Capture: OAuth bearer token not found in Keychain. \
                Complete the OAuth grant (owner go-live gate D3-02) and store the token \
                via Auth.shared.store(token:). The capture daemon cannot operate without it.
                """
        case .keychainError(let status):
            return "Atlas Capture: Keychain error (OSStatus \(status)). Check system Keychain access."
        }
    }
}

// MARK: - Keychain constants

private let kService = "com.atlas.capture"
private let kAccount = "echo-capture-bearer"

// MARK: - Auth

/// Manages the OAuth bearer token for the capture daemon.
///
/// All operations use the macOS Keychain (SecItem API). The token is NEVER stored in
/// a plist, [vars], the Vault, the Codex, or any system preferences store (T-03-04-02).
///
/// This token is the bearer the capture app presents as:
///   Authorization: Bearer <token>
/// on every outbound request to the Atlas cloud (EchoSession WS upgrade, presign endpoint,
/// incident relay, Codex cache refresh). The cloud side validates it via ECHO_CAPTURE_TOKEN
/// (added in 03-02 security hardening). See apps/echo/src/auth.ts for the cloud verification.
public final class Auth {

    // MARK: - Shared singleton

    public static let shared = Auth()

    private init() {}

    // MARK: - Token access

    /// The current bearer token, loaded lazily from Keychain.
    /// `nil` if the token has not yet been seeded (go-live gate).
    public private(set) var token: String? {
        get { _token }
        set { _token = newValue }
    }
    private var _token: String?

    /// Read the bearer token from the macOS Keychain.
    ///
    /// - Throws: `AuthError.tokenMissing` if the token has not been seeded.
    /// - Throws: `AuthError.keychainError` on unexpected Keychain failures.
    /// - Returns: The bearer token string.
    public func readToken() throws -> String {
        if let cached = _token { return cached }

        let query: [String: Any] = [
            kSecClass as String:            kSecClassGenericPassword,
            kSecAttrService as String:      kService,
            kSecAttrAccount as String:      kAccount,
            kSecReturnData as String:       true,
            kSecMatchLimit as String:       kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard
                let data = result as? Data,
                let tokenString = String(data: data, encoding: .utf8),
                !tokenString.isEmpty
            else {
                throw AuthError.tokenMissing
            }
            _token = tokenString
            return tokenString

        case errSecItemNotFound:
            // Token not yet seeded — owner must complete the OAuth grant (D3-02).
            throw AuthError.tokenMissing

        default:
            throw AuthError.keychainError(status)
        }
    }

    /// Store a bearer token in the macOS Keychain.
    ///
    /// Called once at first OAuth grant (owner go-live gate D3-02).
    /// Subsequent calls update the stored item.
    ///
    /// - Parameter token: The bearer token string to persist.
    /// - Throws: `AuthError.keychainError` on Keychain failures.
    public func store(token: String) throws {
        guard let data = token.data(using: .utf8) else {
            throw AuthError.keychainError(errSecParam)
        }

        // Try updating an existing item first (common case after token rotation).
        let query: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  kService,
            kSecAttrAccount as String:  kAccount,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String:    data,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)

        if updateStatus == errSecItemNotFound {
            // First grant: add a new item.
            var addAttributes = query
            addAttributes[kSecValueData as String] = data
            addAttributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

            let addStatus = SecItemAdd(addAttributes as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw AuthError.keychainError(addStatus)
            }
        } else if updateStatus != errSecSuccess {
            throw AuthError.keychainError(updateStatus)
        }

        _token = token
    }

    /// Delete the stored token from Keychain (e.g. on revocation or re-auth).
    public func deleteToken() throws {
        let query: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  kService,
            kSecAttrAccount as String:  kAccount,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AuthError.keychainError(status)
        }
        _token = nil
    }

    // MARK: - Request helpers

    /// Apply the Authorization: Bearer header to an outbound URLRequest.
    ///
    /// - Parameter request: The request to mutate. Must be an outbound HTTPS request.
    /// - Throws: `AuthError.tokenMissing` if the token is not in Keychain.
    public func authorize(_ request: inout URLRequest) throws {
        let token = try readToken()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
}
