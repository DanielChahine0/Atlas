// CodexCache.swift — local read-only Codex snapshot for Quill
//
// The Codex is the owner's personal source of truth (read-only to agents).
// Quill reads the local disk cache to map field labels → Codex fields WITHOUT a cloud
// round-trip during operation (CONTEXT.md Claude's Discretion: "Quill needs a local
// read-only copy of the Codex — how it stays fresh is Claude's discretion").
//
// Resolution (Open Question 2 from RESEARCH.md):
//   - Cache is a JSON blob on disk (not tracked; in the app's Application Support dir).
//   - Refresh: fetch from the cloud codex endpoint at startup + every 24h.
//   - Staleness > 48h: emit a P4 incident via IncidentRelay (non-blocking warning).
//   - Quill's fill loop reads the disk cache ONLY (zero cloud round-trip during fill).
//
// Privacy invariant: Codex is read-only (agents never write it back, D3-08).
// The local cache is a derived read-only projection. Quill never writes to it.

import Foundation

// MARK: - CodexCache errors

public enum CodexCacheError: Error {
    case cacheFileNotFound
    case decodingFailed(underlyingError: Error)
    case fetchFailed(statusCode: Int)
}

// MARK: - CodexCache

/// Manages a local read-only Codex snapshot for Quill's fill loop.
///
/// Refresh schedule:
///   - On arm (first use) if the cache is missing or > 24h stale.
///   - On a 24h periodic timer thereafter.
///   - Staleness > 48h emits a P4 incident (non-fatal; Quill continues with stale data).
///
/// Quill's fill loop calls `read()` which returns the cached data without any network call.
public actor CodexCache {

    // MARK: - Singleton

    public static let shared = CodexCache()

    // MARK: - Cache location

    private var cacheFileURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let atlasDir = appSupport.appendingPathComponent("com.atlas.capture", isDirectory: true)
        try? FileManager.default.createDirectory(at: atlasDir, withIntermediateDirectories: true)
        return atlasDir.appendingPathComponent("codex-cache.json")
    }

    private let auth: Auth
    private let fetcher: any HTTPDataFetcher
    private let incidentRelay: IncidentRelay
    private var refreshTimer: Task<Void, Never>?

    /// How long before the cache is considered stale (refresh trigger).
    let staleThreshold: TimeInterval = 24 * 3600      // 24 hours

    /// How long before the cache is considered critically stale (P4 alert).
    let criticalStaleThreshold: TimeInterval = 48 * 3600  // 48 hours

    private var baseURL: URL {
        if let envVal = ProcessInfo.processInfo.environment["ATLAS_CAPTURE_BASE_URL"],
           let url = URL(string: envVal) {
            return url
        }
        return URL(string: "https://echo.atlas.workers.dev")!
    }

    // MARK: - Init

    public init(
        auth: Auth = .shared,
        session: any HTTPDataFetcher = URLSession.shared,
        incidentRelay: IncidentRelay = .shared
    ) {
        self.auth = auth
        self.fetcher = session
        self.incidentRelay = incidentRelay
    }

    // MARK: - Public interface

    /// Read the cached Codex snapshot from disk.
    ///
    /// Returns `nil` if the cache has not yet been populated. Callers should call `arm()` at
    /// app start to ensure the cache is populated before Quill needs it.
    ///
    /// This call is synchronous with respect to disk I/O only — NO cloud round-trip.
    public func read() -> Data? {
        try? Data(contentsOf: cacheFileURL)
    }

    /// Arm the cache: fetch a fresh snapshot if the cache is missing or stale.
    ///
    /// Call at app launch and after each successful OAuth grant.
    /// Starts the 24h refresh timer.
    public func arm() async {
        await refreshIfNeeded()
        startRefreshTimer()
    }

    // MARK: - Internal refresh

    func refreshIfNeeded() async {
        let needsRefresh: Bool
        let criticallyStale: Bool

        if let attrs = try? FileManager.default.attributesOfItem(atPath: cacheFileURL.path),
           let modified = attrs[.modificationDate] as? Date {
            let age = Date().timeIntervalSince(modified)
            needsRefresh = age > staleThreshold
            criticallyStale = age > criticalStaleThreshold
        } else {
            // Cache file missing — always refresh.
            needsRefresh = true
            criticallyStale = false
        }

        if criticallyStale {
            // Emit P4 incident: stale Codex cache (non-blocking).
            await incidentRelay.emit(RawIncident(
                severity: "P4",
                kind: "codex.cache-stale",
                sourceAgent: "Quill",
                note: "Codex cache is > 48h stale. Quill fill loop is operating on outdated data. Trigger a refresh by restarting Atlas Capture."
            ))
        }

        if needsRefresh {
            await fetchAndStore()
        }
    }

    func fetchAndStore() async {
        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("capture/codex"))
            request.httpMethod = "GET"
            try auth.authorize(&request)

            let (data, response) = try await fetcher.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                throw CodexCacheError.fetchFailed(statusCode: code)
            }

            try data.write(to: cacheFileURL, options: .atomic)
        } catch AuthError.tokenMissing {
            // Go-live gate — token not yet seeded. Skip silently; will retry on next arm().
            return
        } catch {
            print("[CodexCache] refresh failed: \(error.localizedDescription)")
        }
    }

    private func startRefreshTimer() {
        refreshTimer?.cancel()
        refreshTimer = Task {
            while !Task.isCancelled {
                // Sleep 24h then refresh.
                try? await Task.sleep(nanoseconds: UInt64(staleThreshold * 1_000_000_000))
                if Task.isCancelled { break }
                await fetchAndStore()
            }
        }
    }
}
