// BacklogRowView — one row of the Project Backlog list, on the pane standard:
// a title line, ONE secondary line, a trailing state, at most one visible
// action, everything else in a menu.
//
// What the row says is `MARVINLogic.BacklogRowText`; which action is the
// visible one is `BacklogRowActions`. This draws the result and holds no
// rules. Hover is the row's own @State, so a pointer moving over the list
// re-renders one row, never the list.

import MARVINLogic
import SwiftUI

extension BacklogItem {
    var severityGlyph: String {
        switch severity {
        case "high": return "exclamationmark.2"
        case "low": return "arrow.down"
        default: return "equal"
        }
    }

    var severityTint: Color {
        switch severity {
        case "high": return .red
        case "low": return MarvinTheme.textMuted
        default: return .orange
        }
    }
}

@MainActor struct BacklogRowView: View {
    let item: BacklogItem
    let now: Date
    let findings: [BacklogFinding]
    let selected: Bool
    let onAction: (BacklogAction) -> Void

    @State private var hovering = false

    private var resolved: Bool { item.status == "done" || item.status == "dismissed" }

    var body: some View {
        let actions = BacklogRowActions.forStatus(item.status)
        HStack(alignment: .center, spacing: 8) {
            // Severity is a shape and a word on the second line — never colour alone.
            Image(systemName: item.severityGlyph)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(item.severityTint)
                .frame(width: 14)
                .help("Severity: \(BacklogBrowse.severityTitle(item.severity))")
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(.system(size: 12, weight: .medium))
                    .strikethrough(resolved, color: .secondary)
                    .foregroundStyle(resolved ? MarvinTheme.textMuted : MarvinTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(BacklogRowText.secondary(item, now: now))
                    .font(.system(size: 10.5))
                    .foregroundStyle(MarvinTheme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .help(item.title)
            Spacer(minLength: 4)
            if item.isBlocked {
                Image(systemName: "hourglass")
                    .font(.system(size: 10))
                    .foregroundStyle(.purple)
                    .help(item.blockedOn.flatMap { $0.isEmpty ? nil : "Waiting on: \($0)" } ?? "Blocked")
                    .accessibilityLabel("Blocked")
            }
            if !findings.isEmpty {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(.orange)
                    .help(findings.map { "\($0.badge): \($0.detail)" }.joined(separator: "\n"))
                    .accessibilityLabel("Flagged by the review: \(findings.map(\.badge).joined(separator: ", "))")
            }
            if !actions.menu.isEmpty {
                Menu {
                    ForEach(actions.menu, id: \.self) { a in
                        Button(a.title, role: a.isDestructive ? .destructive : nil) { onAction(a) }
                    }
                } label: {
                    Image(systemName: "ellipsis").frame(width: 20, height: 16)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .opacity(hovering || selected ? 1 : 0)
                .help("More actions")
                .accessibilityLabel("More actions for \(item.title)")
            }
            if let primary = actions.primary {
                Button(primary.chipTitle) { onAction(primary) }
                    .rowChip(primary == .keep ? .primary : .neutral)
                    .help(primary.title)
                    .accessibilityLabel("\(primary.title): \(item.title)")
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu {
            if let primary = actions.primary {
                Button(primary.title) { onAction(primary) }
            }
            ForEach(actions.menu, id: \.self) { a in
                Button(a.title, role: a.isDestructive ? .destructive : nil) { onAction(a) }
            }
        }
    }
}
