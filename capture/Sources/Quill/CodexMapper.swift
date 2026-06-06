// CodexMapper.swift — Field-label → Codex-field normalization from the LOCAL Codex cache
//
// Privacy invariants (D3-08, D3-09):
//   - Reads ONLY the local CodexCache disk snapshot — NO cloud round-trip in the fill loop.
//   - NO network client, NO generative model, NO network I/O of any kind in the fill path.
//   - Secret fields (password/SSN/payment/2FA) → REFUSE (no proposed value) + P2 incident
//     with the field LABEL only, never the value (T-03-06-01, T-03-06-03).
//   - EEO/demographics fields → NO proposed value, left blank (autofill_eeo=false, T-03-06-06).
//   - Free-text "voice" fields (cover letter / "Why this role?") → DETERMINISTIC local Codex
//     bio/voice-note snippet insert marked low-confidence "review voice" — no generative model
//     (D3-08, T-03-06-02).
//   - Quill NEVER writes the Codex, Vault, or Wire (read-only, T-03-06-05).
//
// Invariant check: grep for network client imports in this file must return nothing.

import Foundation
import Shared

// MARK: - Injectable protocols for testing

/// Protocol for reading the local Codex snapshot without requiring a real CodexCache actor.
/// Enables test injection without actor inheritance (actors cannot be subclassed).
public protocol CodexCacheReadable: Sendable {
    func readSnapshot() async -> Data?
}

extension CodexCache: CodexCacheReadable {
    public func readSnapshot() async -> Data? {
        // Delegate to the synchronous read() method on the actor (called within actor context).
        return read()
    }
}

/// Protocol for emitting incidents without requiring a real IncidentRelay.
/// Enables test injection without class inheritance (IncidentRelay is final).
public protocol IncidentEmittable: Sendable {
    func emit(_ incident: RawIncident) async
}

extension IncidentRelay: IncidentEmittable {}

// MARK: - FieldClassification

/// How CodexMapper classifies a form field.
public enum FieldClassification {
    /// The field maps to a known Codex field; a proposed value is available.
    case codexMapped(codexField: String, proposedValue: String, confidence: Double)
    /// The field is a free-text "voice" field; a deterministic local snippet is proposed.
    case voiceSnippet(snippet: String)
    /// The field is EEO/demographics; left blank per autofill_eeo=false.
    case eeoBlank
    /// The field is a secret (password/SSN/payment/2FA); refused + P2 incident emitted.
    case secretRefused(fieldLabel: String)
    /// The field label could not be mapped to any Codex field.
    case unmapped
}

// MARK: - FieldProposal

/// A proposal for filling a form field, produced by CodexMapper.
public struct FieldProposal {
    /// The original form field.
    public let field: FormField
    /// The proposed value to fill (empty for refused/EEO/unmapped fields).
    public let proposedValue: String
    /// Confidence score 0.0–1.0 (low = "review voice" or partial match).
    public let confidence: Double
    /// Human-readable confidence label for the ReviewPanel.
    public let confidenceLabel: String
    /// Whether this field is sensitive and should be masked in the review panel.
    public let maskInPanel: Bool
    /// The classification result.
    public let classification: FieldClassification

    public init(
        field: FormField,
        proposedValue: String,
        confidence: Double,
        confidenceLabel: String,
        maskInPanel: Bool = false,
        classification: FieldClassification
    ) {
        self.field = field
        self.proposedValue = proposedValue
        self.confidence = confidence
        self.confidenceLabel = confidenceLabel
        self.maskInPanel = maskInPanel
        self.classification = classification
    }
}

// MARK: - CodexSnapshot

/// A decoded snapshot of the local Codex cache.
///
/// The Codex is the owner's personal source of truth (docs/07-source-of-truth-codex.md §11).
/// Quill reads these sections: identity / education / work / skills / projects / bios / socials.
struct CodexSnapshot: Codable {
    // Identity
    var fullName: String?
    var firstName: String?
    var lastName: String?
    var email: String?
    var phone: String?
    var location: String?
    var linkedIn: String?
    var github: String?
    var website: String?
    var pronouns: String?

    // Work
    var currentTitle: String?
    var currentCompany: String?
    var yearsOfExperience: String?
    var workAuthorization: String?

    // Education
    var degree: String?
    var major: String?
    var university: String?
    var graduationYear: String?
    var gpa: String?

    // Skills
    var skills: [String]?

    // Bios (voice notes for cover letters / free-text fields)
    var shortBio: String?
    var longBio: String?
    var coverLetterSnippet: String?
    var whyThisRoleSnippet: String?

    // Coding keys to handle various JSON key names from the Codex.
    enum CodingKeys: String, CodingKey {
        case fullName = "full_name"
        case firstName = "first_name"
        case lastName = "last_name"
        case email
        case phone
        case location
        case linkedIn = "linkedin"
        case github
        case website
        case pronouns
        case currentTitle = "current_title"
        case currentCompany = "current_company"
        case yearsOfExperience = "years_of_experience"
        case workAuthorization = "work_authorization"
        case degree
        case major
        case university
        case graduationYear = "graduation_year"
        case gpa
        case skills
        case shortBio = "short_bio"
        case longBio = "long_bio"
        case coverLetterSnippet = "cover_letter_snippet"
        case whyThisRoleSnippet = "why_this_role_snippet"
    }
}

// MARK: - CodexMapper

/// Maps form field labels to Codex fields using the LOCAL disk cache.
///
/// NO network call is ever made in the fill loop. The entire mapping is deterministic
/// and offline — field labels are normalized via a local keyword map, not a cloud model.
public final class CodexMapper {

    // MARK: - Dependencies (read-only, injectable)

    private let codexCache: any CodexCacheReadable
    private let incidentRelay: any IncidentEmittable

    // MARK: - autofill_eeo (LOCKED false — D3-09)

    /// EEO/demographics autofill is LOCKED false (D3-09).
    /// This field is NOT user-configurable. EEO fields are always left blank.
    public let autofillEEO: Bool = false

    // MARK: - Init

    public init(
        codexCache: any CodexCacheReadable = CodexCache.shared,
        incidentRelay: any IncidentEmittable = IncidentRelay.shared
    ) {
        self.codexCache = codexCache
        self.incidentRelay = incidentRelay
    }

    // MARK: - Public interface

    /// Map an array of form fields to Codex-backed proposals.
    ///
    /// Steps per field:
    ///   1. Classify the label (secret / EEO / voice / codex-mapped / unmapped).
    ///   2. For secrets: refuse + emit P2 (label only, never value).
    ///   3. For EEO: leave blank.
    ///   4. For voice: return deterministic local snippet.
    ///   5. For codex: look up the Codex snapshot value from the local cache.
    ///
    /// Returns only proposals that have a non-empty proposed value or that are
    /// explicitly refused (so ReviewPanel can show the refusal to the owner).
    public func mapFields(_ fields: [FormField]) async -> [FieldProposal] {
        let snapshot = await loadCodexSnapshot()
        var proposals: [FieldProposal] = []

        for field in fields {
            let proposal = await classify(field: field, snapshot: snapshot)
            proposals.append(proposal)
        }

        return proposals
    }

    // MARK: - Classification

    /// Classify a single form field and produce a proposal.
    func classify(field: FormField, snapshot: CodexSnapshot?) async -> FieldProposal {
        let normalizedLabel = field.label.lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)

        // 1. Secret check (highest priority — refuse before any other classification).
        if isSecretField(normalizedLabel) {
            // Emit P2 incident: field LABEL only, never the value (T-03-06-01, T-03-06-03).
            await incidentRelay.emit(RawIncident(
                severity: "P2",
                fieldLabels: [field.label],
                kind: "quill.secret-refused",
                sourceAgent: "Quill",
                note: "Quill refused to autofill a secret field (label: '\(field.label)'). Secret fields (password, SSN, payment, 2FA) are never autofilled. No value was proposed or emitted."
            ))
            return FieldProposal(
                field: field,
                proposedValue: "",
                confidence: 0.0,
                confidenceLabel: "refused — secret field",
                maskInPanel: true,
                classification: .secretRefused(fieldLabel: field.label)
            )
        }

        // 2. EEO/demographics check (autofill_eeo=false — T-03-06-06).
        if isEEOField(normalizedLabel) {
            return FieldProposal(
                field: field,
                proposedValue: "",
                confidence: 0.0,
                confidenceLabel: "left blank — demographics",
                maskInPanel: false,
                classification: .eeoBlank
            )
        }

        // 3. Voice/free-text check (deterministic local snippet — D3-08, T-03-06-02).
        if isVoiceField(normalizedLabel) {
            let snippet = voiceSnippet(for: normalizedLabel, snapshot: snapshot)
            return FieldProposal(
                field: field,
                proposedValue: snippet,
                confidence: 0.25, // low confidence — owner MUST review
                confidenceLabel: "✎ review voice",
                maskInPanel: false,
                classification: .voiceSnippet(snippet: snippet)
            )
        }

        // 4. Codex field mapping.
        if let (codexField, value, confidence) = mapToCodex(label: normalizedLabel, snapshot: snapshot) {
            return FieldProposal(
                field: field,
                proposedValue: value,
                confidence: confidence,
                confidenceLabel: confidenceLabel(for: confidence),
                maskInPanel: false,
                classification: .codexMapped(codexField: codexField, proposedValue: value, confidence: confidence)
            )
        }

        // 5. Unmapped — no proposal.
        return FieldProposal(
            field: field,
            proposedValue: "",
            confidence: 0.0,
            confidenceLabel: "no match",
            maskInPanel: false,
            classification: .unmapped
        )
    }

    // MARK: - Field classification predicates

    /// Returns true if the label indicates a secret field (password/SSN/payment/2FA).
    ///
    /// SecretRefusalTests.swift asserts this returns true for: "password", "ssn",
    /// "social security", "credit card", "card number", "cvv", "cvc", "2fa",
    /// "verification code", "one-time code", "otp".
    func isSecretField(_ normalizedLabel: String) -> Bool {
        let secretKeywords = [
            "password", "passwd", "passcode",
            "ssn", "social security",
            "credit card", "card number", "card no", "debit card",
            "cvv", "cvc", "security code",
            "account number", "routing number", "bank account",
            "2fa", "two-factor", "two factor", "authenticator",
            "verification code", "one-time code", "one time code", "otp",
            "pin number", "secret answer", "security question",
            "payment", // broad catch for "payment details", "payment info"
        ]
        for keyword in secretKeywords {
            if normalizedLabel.contains(keyword) { return true }
        }
        return false
    }

    /// Returns true if the label indicates an EEO/demographics field.
    ///
    /// CodexMapperTests.swift asserts this returns true for: "gender", "race",
    /// "ethnicity", "veteran status", "disability status".
    func isEEOField(_ normalizedLabel: String) -> Bool {
        let eeoKeywords = [
            "gender", "sex", "pronouns",
            "race", "ethnicity", "national origin",
            "veteran", "military status",
            "disability", "disabled",
            "date of birth", "dob", "birth date", "age",
            "citizenship", "marital status",
            "eeo", "equal opportunity", "demographic",
        ]
        for keyword in eeoKeywords {
            if normalizedLabel.contains(keyword) { return true }
        }
        return false
    }

    /// Returns true if the label indicates a free-text voice/narrative field.
    ///
    /// CodexMapperTests.swift asserts this triggers the deterministic snippet path.
    func isVoiceField(_ normalizedLabel: String) -> Bool {
        let voiceKeywords = [
            "cover letter", "cover note",
            "why this role", "why do you want", "why are you interested",
            "tell us about yourself", "about yourself", "about you",
            "personal statement", "statement of purpose",
            "motivation", "motivating",
            "additional information", "anything else",
            "comments", "notes",
        ]
        for keyword in voiceKeywords {
            if normalizedLabel.contains(keyword) { return true }
        }
        return false
    }

    // MARK: - Voice snippet (deterministic, no generative model — D3-08)

    /// Returns a deterministic local Codex bio/voice-note snippet for free-text fields.
    ///
    /// This is NOT generated by a model. It reads from the local Codex snapshot only.
    /// The snippet is marked low-confidence (0.25) so the owner is prompted to review it.
    func voiceSnippet(for normalizedLabel: String, snapshot: CodexSnapshot?) -> String {
        guard let snapshot = snapshot else {
            return "[Your Codex voice snippet will appear here once the Codex cache is populated. Open Atlas Capture and let it sync.]"
        }

        // Choose the most relevant snippet based on the field label.
        if normalizedLabel.contains("cover letter") || normalizedLabel.contains("cover note") {
            return snapshot.coverLetterSnippet ?? snapshot.longBio ?? snapshot.shortBio ?? voicePlaceholder()
        }

        if normalizedLabel.contains("why this role") || normalizedLabel.contains("why do you want")
            || normalizedLabel.contains("why are you interested") {
            return snapshot.whyThisRoleSnippet ?? snapshot.shortBio ?? voicePlaceholder()
        }

        // Default: short bio.
        return snapshot.shortBio ?? voicePlaceholder()
    }

    private func voicePlaceholder() -> String {
        "[Codex voice snippet not yet populated. Edit your Codex to add a short_bio or cover_letter_snippet.]"
    }

    // MARK: - Codex field mapping

    /// Map a normalized field label to a Codex field value.
    ///
    /// Returns (codexFieldName, proposedValue, confidence) or nil if unmapped.
    /// All lookups are from the local CodexSnapshot — zero network I/O.
    func mapToCodex(label: String, snapshot: CodexSnapshot?) -> (String, String, Double)? {
        guard let s = snapshot else { return nil }

        // Identity fields — high confidence.
        if label.hasAnyKeyword(["full name", "legal name", "name"]) {
            if let v = s.fullName, !v.isEmpty { return ("full_name", v, 0.95) }
        }
        if label.hasAnyKeyword(["first name", "given name"]) {
            if let v = s.firstName, !v.isEmpty { return ("first_name", v, 0.95) }
        }
        if label.hasAnyKeyword(["last name", "surname", "family name"]) {
            if let v = s.lastName, !v.isEmpty { return ("last_name", v, 0.95) }
        }
        if label.hasAnyKeyword(["email", "e-mail"]) {
            if let v = s.email, !v.isEmpty { return ("email", v, 0.95) }
        }
        if label.hasAnyKeyword(["phone", "mobile", "cell", "telephone"]) {
            if let v = s.phone, !v.isEmpty { return ("phone", v, 0.90) }
        }
        if label.hasAnyKeyword(["location", "city", "address", "postal", "zip code", "state"]) {
            if let v = s.location, !v.isEmpty { return ("location", v, 0.80) }
        }
        if label.hasAnyKeyword(["linkedin", "linked in"]) {
            if let v = s.linkedIn, !v.isEmpty { return ("linkedin", v, 0.95) }
        }
        if label.hasAnyKeyword(["github"]) {
            if let v = s.github, !v.isEmpty { return ("github", v, 0.95) }
        }
        if label.hasAnyKeyword(["website", "portfolio", "personal site"]) {
            if let v = s.website, !v.isEmpty { return ("website", v, 0.90) }
        }

        // Work fields.
        if label.hasAnyKeyword(["job title", "current title", "position", "role"]) {
            if let v = s.currentTitle, !v.isEmpty { return ("current_title", v, 0.85) }
        }
        if label.hasAnyKeyword(["company", "employer", "current employer", "organization"]) {
            if let v = s.currentCompany, !v.isEmpty { return ("current_company", v, 0.85) }
        }
        if label.hasAnyKeyword(["years of experience", "experience", "how many years"]) {
            if let v = s.yearsOfExperience, !v.isEmpty { return ("years_of_experience", v, 0.80) }
        }
        if label.hasAnyKeyword(["work authorization", "authorized to work", "visa", "sponsorship"]) {
            if let v = s.workAuthorization, !v.isEmpty { return ("work_authorization", v, 0.80) }
        }

        // Education fields.
        if label.hasAnyKeyword(["degree", "highest education", "education level"]) {
            if let v = s.degree, !v.isEmpty { return ("degree", v, 0.85) }
        }
        if label.hasAnyKeyword(["major", "field of study", "area of study"]) {
            if let v = s.major, !v.isEmpty { return ("major", v, 0.85) }
        }
        if label.hasAnyKeyword(["university", "college", "school", "institution"]) {
            if let v = s.university, !v.isEmpty { return ("university", v, 0.85) }
        }
        if label.hasAnyKeyword(["graduation year", "graduation date", "expected graduation"]) {
            if let v = s.graduationYear, !v.isEmpty { return ("graduation_year", v, 0.85) }
        }
        if label.hasAnyKeyword(["gpa", "grade point"]) {
            if let v = s.gpa, !v.isEmpty { return ("gpa", v, 0.80) }
        }

        // Skills.
        if label.hasAnyKeyword(["skills", "technologies", "tech stack", "tools"]) {
            if let skills = s.skills, !skills.isEmpty {
                return ("skills", skills.joined(separator: ", "), 0.75)
            }
        }

        return nil
    }

    // MARK: - Codex snapshot loading

    /// Load and decode the local Codex snapshot from the disk cache.
    ///
    /// Returns nil if the cache is empty or cannot be decoded (Quill shows "no match" for fields).
    /// NO cloud call is made here — purely local disk read.
    func loadCodexSnapshot() async -> CodexSnapshot? {
        guard let data = await codexCache.readSnapshot() else { return nil }
        return try? JSONDecoder().decode(CodexSnapshot.self, from: data)
    }

    // MARK: - Helpers

    private func confidenceLabel(for confidence: Double) -> String {
        switch confidence {
        case 0.9...: return "high"
        case 0.75..<0.9: return "good"
        case 0.5..<0.75: return "medium"
        default: return "low — review"
        }
    }
}

// MARK: - String extension (keyword matching)

private extension String {
    /// Returns true if the string contains any of the given keywords.
    func hasAnyKeyword(_ keywords: [String]) -> Bool {
        for keyword in keywords {
            if self.contains(keyword) { return true }
        }
        return false
    }
}
