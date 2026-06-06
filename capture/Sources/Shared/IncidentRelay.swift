// IncidentRelay.swift — Flagger incident relay (values stripped by construction)
//
// Privacy invariant T-03-04-03: RawIncident carries form name + field LABELS only.
// Screen content, filled values, screenshots, and raw field values are NEVER emitted.
// The value-stripping is enforced by the struct definition — there is no field for values.
// IncidentRelayTests.swift (Task 2) asserts this by construction.
//
// This relay emits incidents to the cloud atlas-incidents endpoint via the outbound channel
// (OutboxChannel or a dedicated incidents path). The cloud Flagger Worker scores and routes.
//
// Mirrors docs/11-security-privacy.md §12: "the daemon's Flagger channel may name a form
// + field LABELS but NEVER screen content/filled values/screenshots."

import Foundation

// MARK: - RawIncident

/// A privacy-safe incident report emitted by the capture daemon.
///
/// BY CONSTRUCTION this struct has NO field for values, screen content, or screenshots.
/// The privacy invariant is enforced structurally — not by a runtime check.
///
/// Permitted fields:
///   severity       — P1 (critical) through P4 (informational)
///   formName       — the name of the form (e.g. "Greenhouse Application")
///   fieldLabels    — the LABELS of relevant fields (e.g. ["Full Name", "Email"])
///   kind           — machine-readable incident kind
///   sourceAgent    — "Echo" or "Quill"
///   runId          — stable session/run identifier for correlation
///   note           — free-text detail (must NOT contain field values — caller's responsibility)
///
/// NEVER add a `fieldValues`, `screenContent`, `screenshot`, or `rawText` field here.
public struct RawIncident: Codable {
    /// Flagger severity: P1 (trust=100), P2 (trust=95), P3 (trust=50), P4 (trust=70).
    public let severity: String

    /// The name of the form that triggered the incident (e.g. "Greenhouse Application").
    /// May be nil if the incident is not form-related (e.g. an auth error).
    public let formName: String?

    /// Field LABELS involved in the incident (e.g. ["Full Name", "Email Address"]).
    /// NEVER field values — the invariant is enforced by the absence of a values field.
    public let fieldLabels: [String]

    /// Machine-readable kind for Flagger routing (e.g. "quill.secret-refused", "echo.auth-error").
    public let kind: String

    /// The agent that generated this incident: "Echo" or "Quill".
    public let sourceAgent: String

    /// A stable session or run identifier (e.g. "echo-2026-06-06T14-00-03").
    public let runId: String?

    /// Free-text detail. Caller MUST NOT include field values or screen content.
    /// This is the human-readable message surfaced in the Vault/Flagger feed.
    public let note: String

    // MARK: - No values field (T-03-04-03 by construction)
    // There is intentionally NO field named: values, fieldValues, screenContent,
    // rawText, screenshot, filledValue, extractedText, or any synonym.
    // Adding such a field is a privacy regression — do not do it.

    public init(
        severity: String,
        formName: String? = nil,
        fieldLabels: [String] = [],
        kind: String,
        sourceAgent: String,
        runId: String? = nil,
        note: String
    ) {
        self.severity = severity
        self.formName = formName
        self.fieldLabels = fieldLabels
        self.kind = kind
        self.sourceAgent = sourceAgent
        self.runId = runId
        self.note = note
    }
}

// MARK: - IncidentRelay

/// Emits a RawIncident to the cloud Flagger endpoint via the outbound channel.
///
/// The relay is responsible ONLY for transport — callers are responsible for ensuring
/// the incident payload contains no values or screen content (the struct enforces this).
public final class IncidentRelay {

    // MARK: - Shared singleton

    public static let shared = IncidentRelay()

    private let auth: Auth
    private let session: URLSession

    /// Base URL for the incidents endpoint. Set via ATLAS_CAPTURE_BASE_URL env var.
    private var baseURL: URL {
        if let envVal = ProcessInfo.processInfo.environment["ATLAS_CAPTURE_BASE_URL"],
           let url = URL(string: envVal) {
            return url
        }
        return URL(string: "https://echo.atlas.workers.dev")!
    }

    public init(auth: Auth = .shared, session: URLSession = .shared) {
        self.auth = auth
        self.session = session
    }

    // MARK: - Emit

    /// Emit a RawIncident over the outbound HTTPS channel.
    ///
    /// The incident is POSTed to `/capture/incident` with an Authorization: Bearer header.
    /// On failure the error is logged locally; incidents are best-effort (P3/P4 loss is
    /// acceptable; P1/P2 callers should retry or fall back to local logging).
    ///
    /// - Parameter incident: The privacy-safe incident (labels only, no values).
    public func emit(_ incident: RawIncident) async {
        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("capture/incident"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            try auth.authorize(&request)
            request.httpBody = try JSONEncoder().encode(incident)

            let (_, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                print("[IncidentRelay] warning: incident POST returned \(http.statusCode) (kind=\(incident.kind))")
            }
        } catch {
            // Log locally; never surface the token in the log.
            let msg = error.localizedDescription.replacingOccurrences(of: "Bearer ", with: "Bearer [REDACTED] ")
            print("[IncidentRelay] error emitting incident (kind=\(incident.kind)): \(msg)")
        }
    }
}
