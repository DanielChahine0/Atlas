// IncidentRelayTests.swift — XCTest unit tests for IncidentRelay.swift
//
// Privacy invariant T-03-04-03 — the assertion backstop:
//   A built RawIncident contains the form name + field LABELS and contains NEITHER a
//   field value NOR screen content. This is enforced BY CONSTRUCTION (no values field
//   exists in the struct) and verified here as a structural assertion test.
//
// As noted in IncidentRelay.swift: the value-stripping invariant is structural —
// there is no field for values. These tests assert the structure and confirm that
// emitted incidents carry only the fields the spec permits.

import XCTest
@testable import Shared

// MARK: - RawIncident structural tests (privacy assertion backstop)

final class IncidentRelayTests: XCTestCase {

    // MARK: - T-03-04-03: RawIncident by construction contains no values field

    func testRawIncident_hasNoValuesField_byConstruction() {
        // This test verifies the type's structure. If a developer adds a `fieldValues`,
        // `screenContent`, `rawText`, or `filledValue` field to RawIncident, this
        // test would need to be updated — the existence of this test documents that
        // adding such a field is a privacy regression.
        //
        // The structural assertion: RawIncident is a value type (struct) with ONLY
        // these fields: severity, formName, fieldLabels, kind, sourceAgent, runId, note.
        // There is no field for values, screen content, or screenshots.
        let incident = RawIncident(
            severity: "P3",
            formName: "Greenhouse Application",
            fieldLabels: ["Full Name", "Email Address", "Phone Number"],
            kind: "quill.secret-refused",
            sourceAgent: "Quill",
            runId: "quill-run-abc123",
            note: "Quill refused to autofill a sensitive field (Password)."
        )

        // Verify permitted fields are present and correct.
        XCTAssertEqual(incident.severity, "P3")
        XCTAssertEqual(incident.formName, "Greenhouse Application")
        XCTAssertEqual(incident.fieldLabels, ["Full Name", "Email Address", "Phone Number"],
                       "fieldLabels contains only label strings, never values")
        XCTAssertEqual(incident.kind, "quill.secret-refused")
        XCTAssertEqual(incident.sourceAgent, "Quill")
        XCTAssertEqual(incident.runId, "quill-run-abc123")
        XCTAssertFalse(incident.note.isEmpty)

        // Verify the incident can be round-tripped through JSON without gaining a values field.
        guard let encoded = try? JSONEncoder().encode(incident),
              let json = try? JSONDecoder().decode([String: AnyCodable].self, from: encoded) else {
            XCTFail("RawIncident must be JSON-encodable")
            return
        }

        // These keys must NOT be present in the serialised JSON (T-03-04-03).
        let forbiddenKeys = ["values", "fieldValues", "screenContent", "rawText",
                             "filledValue", "screenshot", "extractedText"]
        for key in forbiddenKeys {
            XCTAssertNil(json[key],
                         "JSON must NOT contain '\(key)' — values/screen content never emitted (T-03-04-03)")
        }

        // These keys MUST be present.
        XCTAssertNotNil(json["severity"], "severity must be present")
        XCTAssertNotNil(json["formName"], "formName must be present")
        XCTAssertNotNil(json["fieldLabels"], "fieldLabels must be present")
        XCTAssertNotNil(json["kind"], "kind must be present")
        XCTAssertNotNil(json["sourceAgent"], "sourceAgent must be present")
    }

    // MARK: - RawIncident with nil formName and empty fieldLabels (non-form incidents)

    func testRawIncident_withNoFormContext_isValidIncident() {
        // Auth errors and other non-form incidents are valid; formName/fieldLabels are optional.
        let incident = RawIncident(
            severity: "P2",
            kind: "echo.auth-error",
            sourceAgent: "Echo",
            note: "OAuth bearer token not found in Keychain — capture session cannot start."
        )

        XCTAssertNil(incident.formName, "formName must be nil for non-form incidents")
        XCTAssertTrue(incident.fieldLabels.isEmpty, "fieldLabels must be empty for non-form incidents")
        XCTAssertEqual(incident.severity, "P2")
        XCTAssertEqual(incident.sourceAgent, "Echo")
    }

    // MARK: - Note field must not contain values (caller responsibility check)
    //
    // The struct cannot enforce what the caller puts in `note`, but the policy is:
    // note = human-readable description of the incident, NOT the content of the field.
    // This test documents the expected note content for a Quill secret-refusal incident.

    func testRawIncident_noteDescribesIncident_notFieldContent() {
        // Correct: note describes what happened, not the field's value.
        let correctNote = "Quill refused to autofill the 'Password' field — secrets are never autofilled."

        // Incorrect (would be a policy violation): note = "The password field contained: hunter2"
        // We cannot test runtime behavior since the struct doesn't enforce this, but
        // the accepted note format is documented here.

        let incident = RawIncident(
            severity: "P2",
            formName: "Login Form",
            fieldLabels: ["Password"],
            kind: "quill.secret-refused",
            sourceAgent: "Quill",
            note: correctNote
        )

        XCTAssertEqual(incident.fieldLabels, ["Password"],
                       "Label is present (the field name, not its value)")
        XCTAssertEqual(incident.note, correctNote,
                       "Note describes the incident, not the field value")
        // Ensure the note does not look like it contains an actual password value.
        // This is a heuristic check; the structural enforcement is in the type definition.
        XCTAssertFalse(incident.note.contains("contained:"),
                       "Note must not describe field content — only the incident event")
    }

    // MARK: - IncidentRelay.emit does not crash when auth token missing (go-live gate)

    func testIncidentRelay_emitWithMissingToken_handlesGracefully() async {
        // Before the owner seeds the token (go-live gate), emit() should log + return,
        // not crash or throw. Auth will throw AuthError.tokenMissing; IncidentRelay catches it.
        let auth = Auth(service: "com.atlas.capture.test", account: "test-relay-\(UUID().uuidString)")
        // Intentionally do NOT call auth.store(token:) — token is missing.

        let relay = IncidentRelay(auth: auth)
        let incident = RawIncident(
            severity: "P4",
            kind: "test.relay-graceful",
            sourceAgent: "Echo",
            note: "Test incident with missing auth token."
        )

        // This should complete without crashing or throwing.
        await relay.emit(incident)
    }

    // MARK: - Severity values are within the expected set

    func testRawIncident_severityValues_areWithinSpec() {
        // Flagger uses P1–P4; verify the relay accepts and preserves all four.
        let severities = ["P1", "P2", "P3", "P4"]
        for severity in severities {
            let incident = RawIncident(
                severity: severity,
                kind: "test.severity",
                sourceAgent: "Echo",
                note: "Severity \(severity) test."
            )
            XCTAssertEqual(incident.severity, severity,
                           "Severity '\(severity)' must round-trip through RawIncident")
        }
    }
}
