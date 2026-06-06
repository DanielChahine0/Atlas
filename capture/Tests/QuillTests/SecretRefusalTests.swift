// SecretRefusalTests.swift — XCTest assertions for secret field refusal + P2 incidents
//
// Tests (T-03-06-01, T-03-06-03):
//   - password/SSN/payment fields are refused (no proposed value).
//   - The emitted P2 incident carries the field LABEL but NOT the value.
//   - EEO fields produce no proposed value (covered here and in CodexMapperTests).
//   - The P2 incident payload never contains the field value in any field.
//
// Privacy invariant: the P2 incident may carry:
//   - fieldLabels: [field.label]  ← ALLOWED (label only)
//   - note: describing the refusal ← ALLOWED (no value)
// The P2 incident must NEVER carry:
//   - field values, currentValue, proposedValue, screenContent, or any value-like field.

import XCTest
@testable import Quill
import Shared

final class SecretRefusalTests: XCTestCase {

    private var mapper: CodexMapper!
    private var mockRelay: CapturingIncidentRelay!

    override func setUp() {
        super.setUp()
        mockRelay = CapturingIncidentRelay()
        mapper = CodexMapper(
            codexCache: MockEmptyCodexCache() as any CodexCacheReadable,
            incidentRelay: mockRelay as any IncidentEmittable
        )
    }

    // MARK: - Password field refused + P2 with label only

    func testPasswordField_isRefused_andEmitsP2WithLabelOnly() async {
        let fieldValue = "my-super-secret-password-123"  // This value must NEVER appear in the P2.
        let field = FormField(label: "Password", element: nil, currentValue: fieldValue)
        let proposals = await mapper.mapFields([field])

        XCTAssertEqual(proposals.count, 1)
        let proposal = proposals[0]

        // Refused: no proposed value.
        XCTAssertEqual(proposal.proposedValue, "",
                       "Secret field must produce no proposed value")

        // Classification is secretRefused.
        if case .secretRefused(let label) = proposal.classification {
            XCTAssertEqual(label, "Password")
        } else {
            XCTFail("Expected secretRefused classification for 'Password'")
        }

        // A P2 incident was emitted.
        XCTAssertEqual(mockRelay.emittedIncidents.count, 1)
        let incident = mockRelay.emittedIncidents[0]
        XCTAssertEqual(incident.severity, "P2")

        // The P2 must carry the LABEL (not the value).
        XCTAssertTrue(incident.fieldLabels.contains("Password"),
                      "P2 must include the field label 'Password'")

        // Critical: the field VALUE must never appear in the P2 payload.
        assertNoValueLeak(incident: incident, forbiddenValue: fieldValue, fieldName: "Password")
    }

    func testSSNField_isRefused_andEmitsP2WithLabelOnly() async {
        let ssnValue = "123-45-6789"
        let field = FormField(label: "Social Security Number", element: nil, currentValue: ssnValue)
        let proposals = await mapper.mapFields([field])

        XCTAssertEqual(proposals[0].proposedValue, "", "SSN field must be refused")
        if case .secretRefused = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected secretRefused for 'Social Security Number'")
        }

        XCTAssertEqual(mockRelay.emittedIncidents.count, 1)
        let incident = mockRelay.emittedIncidents[0]
        XCTAssertEqual(incident.severity, "P2")
        XCTAssertTrue(incident.fieldLabels.contains("Social Security Number"))
        assertNoValueLeak(incident: incident, forbiddenValue: ssnValue, fieldName: "SSN")
    }

    func testCreditCardField_isRefused_andEmitsP2WithLabelOnly() async {
        let cardValue = "4111111111111111"
        let field = FormField(label: "Credit Card Number", element: nil, currentValue: cardValue)
        let proposals = await mapper.mapFields([field])

        XCTAssertEqual(proposals[0].proposedValue, "")
        if case .secretRefused = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected secretRefused for 'Credit Card Number'")
        }

        XCTAssertEqual(mockRelay.emittedIncidents.count, 1)
        assertNoValueLeak(incident: mockRelay.emittedIncidents[0], forbiddenValue: cardValue, fieldName: "CreditCard")
    }

    func testCVVField_isRefused_andEmitsP2WithLabelOnly() async {
        let cvvValue = "123"
        let field = FormField(label: "CVV / CVC", element: nil, currentValue: cvvValue)
        let proposals = await mapper.mapFields([field])

        XCTAssertEqual(proposals[0].proposedValue, "")
        if case .secretRefused = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected secretRefused for 'CVV / CVC'")
        }
    }

    func test2FAField_isRefused_andEmitsP2WithLabelOnly() async {
        let otpValue = "847291"
        let field = FormField(label: "2FA Code", element: nil, currentValue: otpValue)
        let proposals = await mapper.mapFields([field])

        XCTAssertEqual(proposals[0].proposedValue, "")
        if case .secretRefused = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected secretRefused for '2FA Code'")
        }

        XCTAssertEqual(mockRelay.emittedIncidents.count, 1)
        let incident = mockRelay.emittedIncidents[0]
        XCTAssertEqual(incident.severity, "P2")
        assertNoValueLeak(incident: incident, forbiddenValue: otpValue, fieldName: "2FA Code")
    }

    func testVerificationCodeField_isRefused_andEmitsP2() async {
        let field = FormField(label: "Verification Code", element: nil, currentValue: "999888")
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "")
        if case .secretRefused = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected secretRefused for 'Verification Code'")
        }
        XCTAssertEqual(mockRelay.emittedIncidents[0].severity, "P2")
    }

    func testOTPField_isRefused_andEmitsP2() async {
        let field = FormField(label: "OTP", element: nil, currentValue: "123456")
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "")
        XCTAssertEqual(mockRelay.emittedIncidents.count, 1)
        XCTAssertEqual(mockRelay.emittedIncidents[0].severity, "P2")
    }

    // MARK: - EEO fields produce no proposed value (T-03-06-06)

    func testGenderField_producesNoProposal_noIncident() async {
        let field = FormField(label: "Gender Identity", element: nil, currentValue: "male")
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "")
        if case .eeoBlank = proposals[0].classification { /* OK */ } else {
            XCTFail("Expected eeoBlank for 'Gender Identity'")
        }
        // EEO refusals do NOT emit a P2 incident (they are silently left blank).
        XCTAssertEqual(mockRelay.emittedIncidents.count, 0,
                       "EEO fields must not emit incidents — they are silently left blank")
    }

    func testRaceField_producesNoProposal_noIncident() async {
        let field = FormField(label: "Race", element: nil)
        let proposals = await mapper.mapFields([field])
        XCTAssertEqual(proposals[0].proposedValue, "")
        XCTAssertEqual(mockRelay.emittedIncidents.count, 0)
    }

    // MARK: - Multiple fields: only secrets emit P2

    func testMixedFields_onlySecretsEmitP2() async {
        let fields = [
            FormField(label: "Full Name", element: nil),
            FormField(label: "Password", element: nil, currentValue: "secret-pass"),
            FormField(label: "Email", element: nil),
            FormField(label: "Gender", element: nil),
        ]
        let _ = await mapper.mapFields(fields)

        // Only "Password" emits a P2 incident.
        XCTAssertEqual(mockRelay.emittedIncidents.count, 1)
        XCTAssertEqual(mockRelay.emittedIncidents[0].severity, "P2")
        XCTAssertTrue(mockRelay.emittedIncidents[0].fieldLabels.contains("Password"))
    }

    // MARK: - P2 incident structure

    func testP2Incident_hasCorrectKind() async {
        let field = FormField(label: "Password", element: nil, currentValue: "anything")
        let _ = await mapper.mapFields([field])
        XCTAssertEqual(mockRelay.emittedIncidents[0].kind, "quill.secret-refused")
    }

    func testP2Incident_sourceAgentIsQuill() async {
        let field = FormField(label: "Password", element: nil, currentValue: "anything")
        let _ = await mapper.mapFields([field])
        XCTAssertEqual(mockRelay.emittedIncidents[0].sourceAgent, "Quill")
    }

    // MARK: - Value leak assertion helper

    /// Assert that the incident does not contain the forbidden value in any field.
    private func assertNoValueLeak(incident: RawIncident, forbiddenValue: String, fieldName: String) {
        // Check note field.
        XCTAssertFalse(incident.note.contains(forbiddenValue),
                       "P2 note for '\(fieldName)' must not contain the field value")

        // Check fieldLabels array.
        for label in incident.fieldLabels {
            XCTAssertFalse(label.contains(forbiddenValue),
                           "P2 fieldLabels for '\(fieldName)' must not contain the field value")
        }

        // Check formName.
        if let formName = incident.formName {
            XCTAssertFalse(formName.contains(forbiddenValue),
                           "P2 formName for '\(fieldName)' must not contain the field value")
        }

        // Check runId.
        if let runId = incident.runId {
            XCTAssertFalse(runId.contains(forbiddenValue),
                           "P2 runId for '\(fieldName)' must not contain the field value")
        }
    }
}

// MARK: - CapturingIncidentRelay

/// A test-only IncidentEmittable that captures all emitted incidents (no network I/O).
final class CapturingIncidentRelay: IncidentEmittable {
    private(set) var emittedIncidents: [RawIncident] = []

    public func emit(_ incident: RawIncident) async {
        emittedIncidents.append(incident)
    }
}

// MARK: - MockEmptyCodexCache

/// A test-only CodexCacheReadable that returns nil (no snapshot — tests secret refusal without Codex).
private final class MockEmptyCodexCache: CodexCacheReadable {
    public func readSnapshot() async -> Data? {
        return nil
    }
}
