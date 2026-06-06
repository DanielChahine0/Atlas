// ScreenReader.swift — AX-first form read + on-device OCR fallback + value injection
//
// Privacy invariant: screen content NEVER leaves the device (D3-07).
// AX tree walk + on-device VNRecognizeTextRequest — zero cloud round-trip.
//
// Value injection (AXUIElementSetAttributeValue) is ONLY called after the owner
// confirms via the ReviewPanel. There is NO code path that submits or activates a
// Submit/Apply/Send control — Quill fills fields ONLY (Pillar 2, D3-09).
//
// On multi-page/wizard forms, the caller must invoke `readFocusedForm()` PER STEP
// (do not cache a stale tree across pages — D3-09).
//
// References:
//   AX: developer.apple.com/documentation/applicationservices/axuielement
//   OCR: developer.apple.com/documentation/vision/vnrecognizetextrequest

import Foundation
import AppKit
import ApplicationServices
import Vision
import CoreGraphics
import Shared

// MARK: - FormField

/// A single form field discovered by the AX tree walk or OCR fallback.
public struct FormField {
    /// The human-readable label for the field (e.g. "Full Name", "Email Address").
    public let label: String
    /// The AX element reference (nil for OCR-only fields that have no AX backing).
    public let element: AXUIElement?
    /// The current value of the field (may be empty).
    public let currentValue: String
    /// Whether this field was discovered via OCR fallback (true) or AX (false).
    public let isOCRFallback: Bool

    public init(label: String, element: AXUIElement?, currentValue: String = "", isOCRFallback: Bool = false) {
        self.label = label
        self.element = element
        self.currentValue = currentValue
        self.isOCRFallback = isOCRFallback
    }
}

// MARK: - ScreenReader

/// Reads the focused form (AX-first with on-device OCR fallback) and injects confirmed values.
///
/// FILL-ONLY invariant: `injectValue(_:into:label:)` is the only method that writes to the form.
/// It writes ONLY the text value of a field. It has NO submit/press/click capability.
/// There is NO method in this class that activates a Submit/Apply/Send control.
public final class ScreenReader {

    // MARK: - Dependencies

    private let incidentRelay: IncidentRelay

    /// Role attributes that represent text input fields in the AX tree.
    private let inputRoles: Set<String> = [
        kAXTextFieldRole as String,
        kAXTextAreaRole as String,
        "AXComboBox",
        "AXSearchField",
    ]

    // MARK: - Init

    public init(incidentRelay: IncidentRelay = .shared) {
        self.incidentRelay = incidentRelay
    }

    // MARK: - Public interface

    /// Read all form fields from the currently focused window.
    ///
    /// Strategy (AX-first, OCR fallback):
    ///   1. Walk the focused app's AX tree for text input fields.
    ///   2. If the AX walk yields zero fields (e.g. canvas-rendered web form), fall back
    ///      to on-device OCR via VNRecognizeTextRequest.
    ///
    /// On multi-page / wizard forms, call this method PER STEP — never cache the result
    /// across page transitions (D3-09).
    ///
    /// - Returns: An array of `FormField` items discovered in the focused window.
    public func readFocusedForm() async -> [FormField] {
        // Step 1: AX tree walk.
        let axFields = readAXFields()

        if !axFields.isEmpty {
            return axFields
        }

        // Step 2: OCR fallback — AX tree returned no fields.
        // Capture the focused window and run on-device text recognition.
        return await readViaOCR()
    }

    /// Inject a confirmed value into a form field (AX write).
    ///
    /// CRITICAL: This method is called ONLY after the owner has confirmed via the ReviewPanel.
    /// There is NO submit/press/click code path in Quill — this method fills text ONLY.
    ///
    /// On non-.success AX error: emits a P3 incident (form + label only, never the value).
    ///
    /// - Parameters:
    ///   - value: The text value to inject.
    ///   - field: The form field to write into.
    ///   - formName: Optional form name for incident reporting.
    public func injectValue(_ value: String, into field: FormField, formName: String? = nil) async {
        guard let element = field.element else {
            // OCR-only field — cannot inject directly (no AX element). Log as informational.
            print("[ScreenReader] OCR-only field '\(field.label)': no AX element for injection.")
            return
        }

        let cfValue = value as CFTypeRef
        let err = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, cfValue)

        guard err == .success else {
            // Injection failed — emit a P3 incident (form + label only, never the value).
            await incidentRelay.emit(RawIncident(
                severity: "P3",
                formName: formName,
                fieldLabels: [field.label],
                kind: "quill.injection-rejected",
                sourceAgent: "Quill",
                note: "AX value injection rejected for field '\(field.label)' (AXError \(err.rawValue)). The field may not accept programmatic value setting."
            ))
            return
        }
    }

    // MARK: - AX tree walk

    /// Walk the focused app's accessibility tree collecting text input fields.
    private func readAXFields() -> [FormField] {
        let systemElement = AXUIElementCreateSystemWide()

        // Get the focused application element.
        var focusedAppRef: CFTypeRef?
        let appErr = AXUIElementCopyAttributeValue(systemElement, kAXFocusedApplicationAttribute as CFString, &focusedAppRef)
        guard appErr == .success, let focusedApp = focusedAppRef else {
            return []
        }
        let appElement = focusedApp as! AXUIElement

        // Get the focused window.
        var focusedWindowRef: CFTypeRef?
        let winErr = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedWindowRef)
        guard winErr == .success, let focusedWindow = focusedWindowRef else {
            return []
        }
        let windowElement = focusedWindow as! AXUIElement

        // Walk the window's subtree collecting input fields.
        var fields: [FormField] = []
        collectFields(from: windowElement, into: &fields)
        return fields
    }

    /// Recursively collect text input fields from an AX element subtree.
    private func collectFields(from element: AXUIElement, into fields: inout [FormField]) {
        // Check if this element is an input field.
        var roleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef) == .success,
           let role = roleRef as? String,
           inputRoles.contains(role) {

            let label = elementLabel(element)
            let currentValue = elementValue(element)

            // Only collect fields that have a label (skip unlabeled inputs — no mapping possible).
            if !label.isEmpty {
                fields.append(FormField(
                    label: label,
                    element: element,
                    currentValue: currentValue,
                    isOCRFallback: false
                ))
            }
        }

        // Recurse into children.
        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let children = childrenRef as? [AXUIElement] else { return }

        for child in children {
            collectFields(from: child, into: &fields)
        }
    }

    /// Extract a human-readable label for an AX element.
    private func elementLabel(_ element: AXUIElement) -> String {
        // Try: AXTitle, AXDescription, AXPlaceholderValue (in priority order).
        for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute] {
            var ref: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success,
               let label = ref as? String,
               !label.isEmpty {
                return label
            }
        }

        // Try: AXTitleUIElement — the label element associated with this input.
        var titleUIRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXTitleUIElementAttribute as CFString, &titleUIRef) == .success,
           let titleUI = titleUIRef {
            let labelElement = titleUI as! AXUIElement
            var labelValueRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(labelElement, kAXValueAttribute as CFString, &labelValueRef) == .success,
               let label = labelValueRef as? String,
               !label.isEmpty {
                return label
            }
        }

        return ""
    }

    /// Extract the current value of an AX element.
    private func elementValue(_ element: AXUIElement) -> String {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &ref) == .success,
              let value = ref as? String else { return "" }
        return value
    }

    // MARK: - OCR fallback

    /// Capture the focused window and run on-device text recognition.
    ///
    /// Uses VNRecognizeTextRequest (fully on-device, no cloud round-trip).
    /// Associates recognized labels spatially with nearby input regions.
    private func readViaOCR() async -> [FormField] {
        guard let windowCapture = captureActiveWindow() else {
            return []
        }

        return await withCheckedContinuation { continuation in
            var observations: [VNRecognizedTextObservation] = []

            let request = VNRecognizeTextRequest { req, err in
                if let err = err {
                    print("[ScreenReader] OCR error: \(err.localizedDescription)")
                    continuation.resume(returning: [])
                    return
                }
                observations = req.results as? [VNRecognizedTextObservation] ?? []

                // Associate labels spatially with inputs (heuristic: label is above/left of input).
                let fields = ScreenReader.fieldsfromOCRObservations(observations, image: windowCapture)
                continuation.resume(returning: fields)
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true

            let handler = VNImageRequestHandler(cgImage: windowCapture, options: [:])
            do {
                try handler.perform([request])
            } catch {
                print("[ScreenReader] OCR handler error: \(error.localizedDescription)")
                continuation.resume(returning: [])
            }
        }
    }

    /// Capture the active (frontmost) window as a CGImage.
    private func captureActiveWindow() -> CGImage? {
        guard let frontApp = NSWorkspace.shared.frontmostApplication else { return nil }
        let pid = frontApp.processIdentifier

        let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        guard let windows = windowList as? [[String: Any]] else { return nil }

        for window in windows {
            guard let windowPID = window[kCGWindowOwnerPID as String] as? Int32,
                  windowPID == pid,
                  let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = bounds["X"], let y = bounds["Y"],
                  let w = bounds["Width"], let h = bounds["Height"],
                  w > 0, h > 0 else { continue }

            let rect = CGRect(x: x, y: y, width: w, height: h)
            return CGWindowListCreateImage(rect, .optionIncludingWindow, kCGNullWindowID, [])
        }
        return nil
    }

    /// Convert OCR observations into FormField items using spatial association heuristics.
    ///
    /// Heuristic: text observations whose bounding box Y is significantly above an input-like
    /// observation are treated as its label. This is a best-effort approach for PDF/canvas forms.
    static func fieldsfromOCRObservations(_ observations: [VNRecognizedTextObservation], image: CGImage) -> [FormField] {
        // Extract all recognized text segments with their bounding boxes.
        var segments: [(text: String, box: CGRect)] = []
        for obs in observations {
            guard let candidate = obs.topCandidates(1).first else { continue }
            let text = candidate.string.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { continue }
            segments.append((text: text, box: obs.boundingBox))
        }

        // Simple heuristic: pair consecutive segments as label → field.
        // In Vision's coordinate system, y=0 is at the bottom (flipped from screen coords).
        // Sort by descending y (top-to-bottom reading order), then by x.
        let sorted = segments.sorted { a, b in
            if abs(a.box.origin.y - b.box.origin.y) > 0.02 {
                return a.box.origin.y > b.box.origin.y // higher y = higher on screen
            }
            return a.box.origin.x < b.box.origin.x
        }

        // Group into pairs: label text + input placeholder text.
        // This is intentionally conservative — only produce a field when we have a label.
        var fields: [FormField] = []
        var i = 0
        while i < sorted.count {
            let labelCandidate = sorted[i]
            // Treat the segment as a field label if it looks like a label (short text, no digits).
            // The next segment (if vertically close) is treated as the current value or placeholder.
            let isLikelyLabel = labelCandidate.text.count < 60 && !labelCandidate.text.hasPrefix("http")
            if isLikelyLabel {
                let currentValue: String
                if i + 1 < sorted.count {
                    let next = sorted[i + 1]
                    // If the next segment is spatially close (same visual line or just below), use as value.
                    let yDelta = abs(next.box.origin.y - labelCandidate.box.origin.y)
                    if yDelta < 0.05 {
                        currentValue = next.text
                        i += 2
                    } else {
                        currentValue = ""
                        i += 1
                    }
                } else {
                    currentValue = ""
                    i += 1
                }
                fields.append(FormField(
                    label: labelCandidate.text,
                    element: nil,
                    currentValue: currentValue,
                    isOCRFallback: true
                ))
            } else {
                i += 1
            }
        }

        return fields
    }
}
