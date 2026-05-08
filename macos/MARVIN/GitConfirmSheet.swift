// GitConfirmSheet — Phase 3g. Native equivalent of the web
// guarded-mutation confirm dialog (sidecar/src/components/source-
// control/git-confirm-prompt.tsx). Shown when /api/git/<op> returns
// a 409 needs-confirm response — the user OKs, we mint a token via
// /api/git/confirm, and re-issue the original mutation with the
// X-Marvin-Confirmed header.
//
// Visual style mirrors the Phase 2e tool ConfirmSheet: shield icon,
// reason banner, severity-tinted action button, default keyboard
// shortcuts (⏎ confirm, esc cancel). The shape is intentionally
// similar so a user who's seen the tool-confirm sheet recognizes
// the SCM one without re-learning.

import SwiftUI

/// Severity drives the action-button colour and the icon. The web
/// route returns "warn" or "danger" today; "info" is reserved for
/// future ops where the gate fires for advisory reasons.
private enum GitConfirmSeverity: String {
    case info
    case warn
    case danger

    init(_ raw: String?) {
        switch raw {
        case "danger": self = .danger
        case "info": self = .info
        default: self = .warn
        }
    }

    var tint: Color {
        switch self {
        case .info: return .blue
        case .warn: return .orange
        case .danger: return .red
        }
    }

    var icon: String {
        switch self {
        case .info: return "info.circle.fill"
        case .warn: return "exclamationmark.triangle.fill"
        case .danger: return "octagon.fill"
        }
    }

    /// Wording for the primary action button. Matches the web
    /// dialog's "Discard changes" / "Force push" cadence — calls out
    /// what's about to happen, not just "OK".
    func actionLabel(for actionVerb: String) -> String {
        switch self {
        case .info: return actionVerb
        case .warn: return actionVerb
        case .danger: return actionVerb
        }
    }
}

struct GitConfirmSheet: View {
    /// Action verb the button will display ("Discard", "Amend",
    /// "Force-push" etc.) — caller-provided so each action site
    /// can describe itself precisely.
    let actionVerb: String
    /// Concise human-facing reason from the policy ("overwrites
    /// uncommitted edits in N files", etc.).
    let reason: String
    let severity: String
    /// Optional list of paths affected — when non-empty, rendered
    /// as a scrollable monospace block. Phase 3g only passes paths
    /// for stage / unstage / discard; commit-amend skips it.
    let paths: [String]

    let onConfirm: () -> Void
    let onCancel: () -> Void

    private var sev: GitConfirmSeverity { GitConfirmSeverity(severity) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            Divider()
            reasonBlock
            if !paths.isEmpty { pathsBlock }
            Spacer(minLength: 0)
            footer
        }
        .padding(20)
        .frame(minWidth: 480, idealWidth: 540, minHeight: 280, idealHeight: 360)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: sev.icon)
                .font(.title2)
                .foregroundStyle(sev.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text("Confirm \(actionVerb.lowercased())")
                    .font(.title3.weight(.semibold))
                Text("git policy requires explicit confirmation")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
    }

    private var reasonBlock: some View {
        Text(reason)
            .font(.body)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(sev.tint.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(sev.tint.opacity(0.25), lineWidth: 1)
                    )
            )
    }

    private var pathsBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Paths (\(paths.count))")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(paths, id: \.self) { p in
                        Text(p)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(8)
            }
            .frame(maxHeight: 120)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: .textBackgroundColor))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                    )
            )
        }
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel") { onCancel() }
                .keyboardShortcut(.cancelAction)
            Button(sev.actionLabel(for: actionVerb)) { onConfirm() }
                .keyboardShortcut(.defaultAction)
                // The system-default action tint is fine for warn;
                // bump to red for danger so the consequence is
                // visually obvious before the click lands.
                .tint(sev == .danger ? .red : nil)
        }
    }
}
