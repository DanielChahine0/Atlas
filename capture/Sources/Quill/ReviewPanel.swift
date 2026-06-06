// ReviewPanel.swift — SwiftUI confirm-before-fill panel (NEVER submits)
//
// Privacy invariant (D3-09, Pillar 2, T-03-06-04):
//   confirm_before_submit is LOCKED true (not user-disablable).
//   The panel has NO Submit/Apply/Send button, no form-submission action,
//   and no code path that activates any submit control.
//
// The panel shows per-field proposals with confidence labels. The owner:
//   • Confirms: triggers ScreenReader.injectValue for each approved field (fill-only).
//   • Cancels: closes the panel with no fills applied.
//   • mask_sensitive_in_panel: sensitive fields (refused secrets) show "••••" in the panel.
//
// Quill NEVER writes the Vault, Wire, or Codex from this panel.
// The ONLY outbound action is IncidentRelay (labels only, never values) from CodexMapper.

import Foundation
import AppKit
import SwiftUI
import Shared

// MARK: - ConfirmedFill

/// A fill that the owner has confirmed in the ReviewPanel.
public struct ConfirmedFill {
    /// The form field to fill.
    public let field: FormField
    /// The value to inject (may be different from the original proposal if owner edited it).
    public let proposedValue: String

    public init(field: FormField, proposedValue: String) {
        self.field = field
        self.proposedValue = proposedValue
    }
}

// MARK: - ReviewPanel

/// Presents a confirm-before-fill panel with per-field confidence.
///
/// LOCKED: confirm_before_submit = true. There is NO submit action in this panel.
/// The panel fills form fields only after the owner's explicit confirm. It never
/// activates any Submit/Apply/Send control.
///
/// Usage: `await panel.present()` — returns the owner-confirmed fills (empty = cancelled).
public final class ReviewPanel {

    // MARK: - confirm_before_submit (LOCKED true — cannot be set false)

    /// confirm_before_submit is LOCKED true. Setting this property to false is a no-op
    /// and emits a P2 incident indicating an attempt to bypass the confirm gate.
    ///
    /// This property is intentionally NOT stored as a mutable var. The implementation
    /// always requires an explicit confirm before fills are returned. The confirm gate
    /// cannot be bypassed.
    public var confirmBeforeSubmit: Bool {
        get { return true }
        set {
            if newValue == false {
                // Attempt to disable confirm_before_submit — this is a security violation.
                // Emit a P2 incident. The gate remains locked to true.
                Task {
                    await IncidentRelay.shared.emit(RawIncident(
                        severity: "P2",
                        kind: "quill.confirm-gate-bypass-attempt",
                        sourceAgent: "Quill",
                        note: "An attempt was made to set confirmBeforeSubmit=false. This is not permitted. The confirm gate is locked true (D3-09, Pillar 2). No fills will be applied without explicit owner confirmation."
                    ))
                }
            }
            // Always return true regardless of what was set.
        }
    }

    // MARK: - Properties

    /// The proposals to present to the owner.
    public let proposals: [FieldProposal]

    /// The ScreenReader used to inject confirmed values.
    private let screenReader: ScreenReader

    // MARK: - Init

    public init(proposals: [FieldProposal], screenReader: ScreenReader) {
        self.proposals = proposals
        self.screenReader = screenReader
    }

    // MARK: - Present

    /// Present the review panel and return the owner-confirmed fills.
    ///
    /// This is a suspension point — it waits for the owner to confirm or cancel.
    /// Returns an empty array if the owner cancels or if no proposals have values.
    ///
    /// confirm_before_submit is LOCKED: no fills are returned without owner confirmation.
    @MainActor
    public func present() async -> [ConfirmedFill] {
        // Filter to proposals that have a non-empty value (secrets and EEO are excluded).
        let fillable = proposals.filter { !$0.proposedValue.isEmpty }

        guard !fillable.isEmpty else {
            // Nothing to fill — immediately return empty (no panel needed).
            return []
        }

        // Present the SwiftUI panel and wait for the owner's response.
        return await withCheckedContinuation { continuation in
            let viewModel = ReviewPanelViewModel(proposals: fillable, onConfirm: { confirmed in
                continuation.resume(returning: confirmed)
            }, onCancel: {
                continuation.resume(returning: [])
            })

            let contentView = ReviewPanelView(viewModel: viewModel)
            let hostingView = NSHostingController(rootView: contentView)
            let window = ReviewPanelWindow(contentViewController: hostingView)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }
}

// MARK: - ReviewPanelViewModel

/// View model for the ReviewPanel SwiftUI view.
///
/// Holds the mutable state of the panel (per-field edits, selection state).
@MainActor
final class ReviewPanelViewModel: ObservableObject {
    let proposals: [FieldProposal]
    @Published var editedValues: [String: String] // keyed by field label
    @Published var selectedFields: Set<String>    // field labels selected for fill

    let onConfirm: ([ConfirmedFill]) -> Void
    let onCancel: () -> Void

    init(proposals: [FieldProposal], onConfirm: @escaping ([ConfirmedFill]) -> Void, onCancel: @escaping () -> Void) {
        self.proposals = proposals
        self.onConfirm = onConfirm
        self.onCancel = onCancel
        // Pre-populate with proposed values; owner may edit inline.
        var edited: [String: String] = [:]
        var selected: Set<String> = []
        for p in proposals {
            edited[p.field.label] = p.proposedValue
            if !p.proposedValue.isEmpty {
                selected.insert(p.field.label)
            }
        }
        self.editedValues = edited
        self.selectedFields = selected
    }

    func confirm() {
        // Build confirmed fills for selected fields with non-empty values.
        let fills: [ConfirmedFill] = proposals.compactMap { proposal in
            guard selectedFields.contains(proposal.field.label),
                  let value = editedValues[proposal.field.label],
                  !value.isEmpty else { return nil }
            return ConfirmedFill(field: proposal.field, proposedValue: value)
        }
        onConfirm(fills)
    }

    func cancel() {
        onCancel()
    }
}

// MARK: - ReviewPanelView

/// The SwiftUI view for the review panel.
///
/// Shows per-field proposals with confidence labels and mask_sensitive_in_panel.
/// Has a "Fill Selected Fields" confirm button and a "Cancel" button.
/// There is NO Submit/Apply/Send button — the panel FILLS ONLY.
struct ReviewPanelView: View {
    @ObservedObject var viewModel: ReviewPanelViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header — communicates fill-only intent clearly.
            HStack {
                Image(systemName: "pencil.and.list.clipboard")
                    .foregroundColor(.accentColor)
                Text("Quill — Fill Form Fields")
                    .font(.headline)
                Spacer()
            }
            .padding()

            Text("Review the proposed values below. Select the fields to fill, then confirm. Quill fills form fields only — it never activates a Submit or Apply control.")
                .font(.caption)
                .foregroundColor(.secondary)
                .padding(.horizontal)
                .padding(.bottom, 8)

            Divider()

            // Field list.
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(viewModel.proposals, id: \.field.label) { proposal in
                        ReviewFieldRow(proposal: proposal, viewModel: viewModel)
                        Divider()
                    }
                }
            }
            .frame(maxHeight: 400)

            Divider()

            // Action bar — FILL ONLY, no submit.
            HStack {
                Button("Cancel") {
                    viewModel.cancel()
                }
                .keyboardShortcut(.cancelAction)

                Spacer()

                // NOTE: this button FILLS form fields only.
                // There is NO submit/apply/send button in this panel — by construction (T-03-06-04).
                Button("Fill Selected Fields") {
                    viewModel.confirm()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(viewModel.selectedFields.isEmpty)
            }
            .padding()
        }
        .frame(width: 480)
    }
}

// MARK: - ReviewFieldRow

struct ReviewFieldRow: View {
    let proposal: FieldProposal
    @ObservedObject var viewModel: ReviewPanelViewModel

    var isSelected: Bool {
        viewModel.selectedFields.contains(proposal.field.label)
    }

    var displayValue: String {
        if proposal.maskInPanel {
            return "••••"
        }
        return viewModel.editedValues[proposal.field.label] ?? proposal.proposedValue
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Selection toggle (only for fillable fields).
            if proposal.proposedValue.isEmpty {
                Image(systemName: "minus.circle")
                    .foregroundColor(.secondary)
                    .frame(width: 20)
            } else {
                Toggle("", isOn: Binding(
                    get: { isSelected },
                    set: { checked in
                        if checked {
                            viewModel.selectedFields.insert(proposal.field.label)
                        } else {
                            viewModel.selectedFields.remove(proposal.field.label)
                        }
                    }
                ))
                .toggleStyle(.checkbox)
                .frame(width: 20)
            }

            VStack(alignment: .leading, spacing: 4) {
                // Field label + confidence badge.
                HStack {
                    Text(proposal.field.label)
                        .font(.subheadline)
                        .fontWeight(.medium)
                    Spacer()
                    Text(proposal.confidenceLabel)
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(confidenceBadgeColor(proposal.confidence))
                        .foregroundColor(.white)
                        .clipShape(Capsule())
                }

                // Proposed value (editable inline if not masked).
                if proposal.maskInPanel || proposal.proposedValue.isEmpty {
                    Text(displayValue)
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else if isSelected {
                    TextField("", text: Binding(
                        get: { viewModel.editedValues[proposal.field.label] ?? "" },
                        set: { viewModel.editedValues[proposal.field.label] = $0 }
                    ))
                    .font(.caption)
                    .textFieldStyle(.roundedBorder)
                } else {
                    Text(displayValue)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(isSelected ? Color.accentColor.opacity(0.05) : Color.clear)
    }

    private func confidenceBadgeColor(_ confidence: Double) -> Color {
        switch confidence {
        case 0.9...: return .green
        case 0.75..<0.9: return .blue
        case 0.5..<0.75: return .orange
        default: return .gray
        }
    }
}

// MARK: - ReviewPanelWindow

/// A borderless floating window for the ReviewPanel.
private final class ReviewPanelWindow: NSWindow {
    init(contentViewController: NSViewController) {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 500),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        self.contentViewController = contentViewController
        self.title = "Quill — Fill Form Fields"
        self.level = .floating
        self.center()
        self.isReleasedWhenClosed = false
    }
}
