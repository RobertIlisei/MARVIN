// PaneEmptyView / PaneLoadingView — what a pane shows when it has nothing
// to show, and while it is finding out (ADR-0114).
//
// The copy is decided in `MARVINLogic/PaneChrome.swift`; this only draws it.
// Before, seven panes wrote the same idea in three registers, and the worst
// of them looked like debug output left in by mistake: `(empty tree)`,
// `(initialising)`, `(not a git repository)`. A person cannot tell from that
// whether the app is broken, busy, or simply waiting for them.

import MARVINLogic
import SwiftUI

struct PaneEmptyView: View {
    let state: PaneEmptyState
    /// An optional way out, which is what turns an empty state into wayfinding.
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 6) {
            if let symbol = state.symbol {
                Image(systemName: symbol)
                    .font(.system(size: 20, weight: .light))
                    .foregroundStyle(.quaternary)
            }
            Text(state.headline)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(MarvinTheme.textMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let hint = state.hint {
                Text(hint)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .chip(.neutral)
                    .padding(.top, 2)
            }
        }
        // A readable column, capped. Prose that is allowed to be as wide as
        // the pane makes the pane as wide as the prose, and all seven panes
        // share one minimum width because they stay mounted together.
        .frame(maxWidth: 260)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.vertical, 24)
    }
}

struct PaneLoadingView: View {
    var label: String? = nil

    var body: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.small).scaleEffect(0.6).frame(width: 14, height: 14)
            Text(label ?? "Loading…")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
    }
}
