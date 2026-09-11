// PaneNoticeStrip — the outcome of an action, with its kind visible
// (ADR-0114). Promoted from `SourceControlView.worktreeNoticeRow`, which was
// the only place in the app that got this right.
//
// What it replaces, in three panes: one tinted strip with one icon carrying
// both "Installed X" and "Install failed: HTTP 500", auto-dismissed after
// three seconds. The failure was the message that mattered and the one
// guaranteed to vanish unread. `PaneNotice.dismissal` now decides by kind, so
// a warning or an error waits to be dismissed.
//
// The detail is deliberately NOT selectable: ADR-0062 — `.textSelection` in a
// ScrollView-rooted left-pane view oscillates AppKit's layout-pass counter and
// crashes the app. Copy belongs on a context menu, never on the strip.
//
// Transitions on opacity only. A height transition inside a mounted,
// zero-framed pane slot re-lays out the whole pane.

import MARVINLogic
import SwiftUI

struct PaneNoticeStrip: View {
    let notice: PaneNotice
    /// The one thing this outcome offers to do about itself — "Retry" after a
    /// failure, "Undo" after something reversible. One verb, never a row.
    var actionTitle: String = "Retry"
    var onAction: (() -> Void)? = nil
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: notice.kind.symbol)
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundStyle(notice.kind.tint)
                .frame(width: 12)
            VStack(alignment: .leading, spacing: 2) {
                Text(notice.headline)
                    .font(.system(size: 10.5))
                    .foregroundStyle(notice.kind == .error ? MarvinTheme.textPrimary : MarvinTheme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = notice.detail {
                    Text(detail)
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            if let onAction {
                Button(actionTitle, action: onAction).rowChip(.neutral)
            }
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .semibold))
                    .frame(width: 14, height: 14)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tertiary)
            .help("Dismiss")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: MarvinTheme.Radius.card, style: .continuous)
                .fill(notice.kind.tint.opacity(notice.kind == .info ? 0 : 0.08))
        )
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .transition(.opacity)
    }
}
