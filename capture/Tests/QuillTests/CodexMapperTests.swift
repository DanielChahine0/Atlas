// CodexMapperTests.swift — XCTest assertions for CodexMapper field mapping
//
// Tests:
//   - A known label maps to the correct Codex field from a fixture cache.
//   - EEO fields produce no proposed value (autofill_eeo=false, T-03-06-06).
//   - Voice fields yield the deterministic snippet (NOT a generated string).
//   - Unmapped fields produce empty proposals.
//   - CodexMapper reads ONLY the local cache (no network client — T-03-06-02).
//
// These tests exercise pure logic only — no AX runtime, no real Codex cloud service.

import XCTest
@testable import Quill
import Shared

// MARK: - Fixture

/// A fixture CodexSnapshot with deterministic test values.
private let fixtureSnapshot = CodexSnapshot(
    fullName: "Daniel Chahine",
    firstName: "Daniel",
    lastName: "Chahine",
    email: "chahinedaniel0@gmail.com",
    phone: "+1-555-555-5555",
    location: "Toronto, ON",
    linkedIn: "https://linkedin.com/in/danielchahine",
    github: "https://github.com/danielchahine",
    website: "https://danielchahine.dev",
    pronouns: "he/him",
    currentTitle: "Senior Software Engineer",
    currentCompany: "Atlas Systems",
    yearsOfExperience: "6",
    workAuthorization: "Authorized to work in Canada",
    degree: "B.Sc. Computer Science",
    major: "Computer Science",
    university: "University of Toronto",
    graduationYear: "2020",
    gpa: "3.8",
    skills: ["Swift", "TypeScript", "Cloudflare Workers", "PostgreSQL"],
    shortBio: "I build developer tools and distributed systems.",
    longBio: "I'm a Senior Software Engineer specializing in developer tools, distributed systems, and AI-powered productivity automation.",
    coverLetterSnippet: "I am excited to apply for this role as it aligns perfectly with my background in distributed systems and developer tooling.",
    whyThisRoleSnippet: "This role excites me because it combines my passion for automation with real-world impact."
)

// MARK: - CodexMapperTests

final class CodexMapperTests: XCTestCase {

    private var mapper: CodexMapper!

    override func setUp() {
        super.setUp()
        // Use a fresh mapper with injected dependencies for test isolation.
        // MockCodexCache implements CodexCacheReadable; returns fixture snapshot without network.
        // MockIncidentRelay implements IncidentEmittable; captures incidents without network.
        let mockCache = MockCodexCache(snapshot: fixtureSnapshot)
        mapper = CodexMapper(codexCache: mockCache as any CodexCacheReadable,
                             incidentRelay: MockIncidentRelay() as any IncidentEmittable)
    }

    // MARK: - Known label → correct Codex field

    func testFullNameLabel_mapsToCodexFullName() async {
        let field = FormField(label: "Full Name", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals.count, 1)
        let proposal = proposals[0]
        XCTAssertEqual(proposal.proposedValue, "Daniel Chahine")
        XCTAssertGreaterThanOrEqual(proposal.confidence, 0.9)
        if case .codexMapped(let codexField, _, _) = proposal.classification {
            XCTAssertEqual(codexField, "full_name")
        } else {
            XCTFail("Expected codexMapped classification for 'Full Name'")
        }
    }

    func testEmailLabel_mapsToCodexEmail() async {
        let field = FormField(label: "Email Address", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "chahinedaniel0@gmail.com")
        XCTAssertGreaterThanOrEqual(proposals[0].confidence, 0.9)
    }

    func testPhoneLabel_mapsToCodexPhone() async {
        let field = FormField(label: "Phone Number", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "+1-555-555-5555")
    }

    func testLinkedInLabel_mapsToCodexLinkedIn() async {
        let field = FormField(label: "LinkedIn Profile", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "https://linkedin.com/in/danielchahine")
    }

    func testUniversityLabel_mapsToCodexUniversity() async {
        let field = FormField(label: "University", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "University of Toronto")
    }

    func testCurrentTitleLabel_mapsToCodexTitle() async {
        let field = FormField(label: "Current Job Title", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "Senior Software Engineer")
    }

    func testSkillsLabel_mapsToJoinedSkills() async {
        let field = FormField(label: "Skills", element: nil)
        let proposals = await mapper.mapFields([field])
        let value = proposals[0].proposedValue
        XCTAssertTrue(value.contains("Swift"))
        XCTAssertTrue(value.contains("TypeScript"))
    }

    // MARK: - EEO fields produce no proposed value (T-03-06-06, autofill_eeo=false)

    func testGenderLabel_producesNoProposal_eeoBlank() async {
        let field = FormField(label: "Gender", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals.count, 1)
        let proposal = proposals[0]
        XCTAssertEqual(proposal.proposedValue, "", "Gender field must produce empty proposal (autofill_eeo=false)")
        if case .eeoBlank = proposal.classification {
            // Correct — EEO fields are left blank.
        } else {
            XCTFail("Expected eeoBlank classification for 'Gender'")
        }
    }

    func testRaceLabel_producesNoProposal_eeoBlank() async {
        let field = FormField(label: "Race / Ethnicity", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "", "Race field must be left blank")
        if case .eeoBlank = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected eeoBlank for 'Race / Ethnicity'")
        }
    }

    func testVeteranStatusLabel_producesNoProposal_eeoBlank() async {
        let field = FormField(label: "Veteran Status", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "", "Veteran status must be left blank")
        if case .eeoBlank = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected eeoBlank for 'Veteran Status'")
        }
    }

    func testDisabilityStatusLabel_producesNoProposal_eeoBlank() async {
        let field = FormField(label: "Disability Status", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "", "Disability status must be left blank")
        if case .eeoBlank = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected eeoBlank for 'Disability Status'")
        }
    }

    // MARK: - Voice field → deterministic local snippet (NOT a generated string, D3-08)

    func testCoverLetterField_yieldsDeterministicSnippet() async {
        let field = FormField(label: "Cover Letter", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals.count, 1)
        let proposal = proposals[0]

        // The snippet is the deterministic cover_letter_snippet from the Codex — not generated.
        XCTAssertEqual(proposal.proposedValue, fixtureSnapshot.coverLetterSnippet)

        // Confidence must be low (0.25) — this is a "review voice" field.
        XCTAssertEqual(proposal.confidence, 0.25, accuracy: 0.01,
                       "Voice field must have low confidence (0.25)")
        XCTAssertEqual(proposal.confidenceLabel, "✎ review voice",
                       "Voice field must show '✎ review voice' label")

        if case .voiceSnippet(let snippet) = proposal.classification {
            // Verify the snippet is the deterministic Codex value, not an empty or generated string.
            XCTAssertFalse(snippet.isEmpty, "Voice snippet must not be empty")
            XCTAssertEqual(snippet, fixtureSnapshot.coverLetterSnippet,
                           "Voice snippet must be the exact Codex cover_letter_snippet")
        } else {
            XCTFail("Expected voiceSnippet classification for 'Cover Letter'")
        }
    }

    func testWhyThisRoleField_yieldsDeterministicSnippet() async {
        let field = FormField(label: "Why do you want this role?", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, fixtureSnapshot.whyThisRoleSnippet)
        XCTAssertEqual(proposals[0].confidence, 0.25, accuracy: 0.01)
        if case .voiceSnippet = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected voiceSnippet for 'Why do you want this role?'")
        }
    }

    func testTellUsAboutYourselfField_yieldsDeterministicShortBio() async {
        let field = FormField(label: "Tell us about yourself", element: nil)
        let proposals = await mapper.mapFields([field])
        // Falls back to short_bio when cover_letter_snippet not applicable.
        XCTAssertFalse(proposals[0].proposedValue.isEmpty)
        if case .voiceSnippet = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected voiceSnippet for 'Tell us about yourself'")
        }
    }

    // MARK: - Unmapped fields

    func testUnknownLabel_producesUnmapped() async {
        let field = FormField(label: "Favourite Pizza Topping", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "")
        if case .unmapped = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected unmapped classification for unknown field")
        }
    }

    // MARK: - No network call in fill loop (T-03-06-02)

    func testCodexMapper_containsNoNetworkClientImport() {
        // Structural assertion: CodexMapper.swift must not import a network client.
        // The actual network-absence check is performed at execution time by grep on
        // the source file (acceptance criteria). This test asserts the same invariant
        // from within the test suite by verifying the source file content.
        let sourceURL = URL(fileURLWithPath: #file)
            .deletingLastPathComponent() // QuillTests/
            .deletingLastPathComponent() // Tests/
            .deletingLastPathComponent() // capture/
            .appendingPathComponent("Sources/Quill/CodexMapper.swift")

        guard let source = try? String(contentsOf: sourceURL, encoding: .utf8) else {
            XCTFail("Could not read CodexMapper.swift source for structural assertion")
            return
        }

        // CodexMapper must not import URLSession (or any network client) for the fill loop.
        // The file should contain NO "import URLSession" or "URLSession(" call.
        XCTAssertFalse(source.contains("URLSession("),
                       "CodexMapper must not instantiate a network session — no cloud round-trip in fill loop (T-03-06-02)")
        XCTAssertFalse(source.contains("import Network"),
                       "CodexMapper must not import Network framework")
        XCTAssertFalse(source.contains("URLRequest("),
                       "CodexMapper must not create network requests — no cloud round-trip in fill loop (T-03-06-02)")
    }

    // MARK: - autofill_eeo locked

    func testAutofillEEO_isLockedFalse() {
        // autofill_eeo must always be false (D3-09, T-03-06-06).
        XCTAssertFalse(mapper.autofillEEO, "autofill_eeo must always be false (D3-09)")
    }

    // MARK: - isEEOField predicate coverage

    func testIsEEOField_recognizesAllEEOKeywords() {
        let eeoLabels = [
            "gender", "sex", "race", "ethnicity", "veteran status",
            "disability status", "date of birth", "citizenship",
            "marital status", "national origin"
        ]
        for label in eeoLabels {
            XCTAssertTrue(mapper.isEEOField(label), "'\(label)' should be classified as EEO")
        }
    }

    func testIsSecretField_recognizesAllSecretKeywords() {
        let secretLabels = [
            "password", "passwd", "ssn", "social security number",
            "credit card number", "cvv", "cvc", "2fa", "verification code",
            "one-time code", "otp", "payment"
        ]
        for label in secretLabels {
            XCTAssertTrue(mapper.isSecretField(label), "'\(label)' should be classified as secret")
        }
    }
}

// MARK: - MockCodexCache

/// A mock CodexCacheReadable that returns a fixture snapshot without any disk or network I/O.
private final class MockCodexCache: CodexCacheReadable {
    private let fixtureData: Data?

    init(snapshot: CodexSnapshot) {
        self.fixtureData = try? JSONEncoder().encode(snapshot)
    }

    public func readSnapshot() async -> Data? {
        return fixtureData
    }
}

// MARK: - MockIncidentRelay

/// A mock IncidentEmittable that captures emitted incidents without network I/O.
private final class MockIncidentRelay: IncidentEmittable {
    private(set) var emittedIncidents: [RawIncident] = []

    public func emit(_ incident: RawIncident) async {
        emittedIncidents.append(incident)
    }
}
