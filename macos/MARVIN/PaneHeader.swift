// PaneHeader — the title row every left pane wears (ADR-0114).
//
// Four shapes were in use across seven panes, and only two of them used
// `MarvinTheme.paneHeaderHeight`, so the activity rail's first icon lined up
// with two panes and floated against five.
//
// Two details here are load-bearing, both from measured regressions:
//
//   - `minWidth: 0`. All seven panes stay mounted in a ZStack (`LeftPane`), so
//     the container's minimum width is the WIDEST of the seven. A header that
//     declares an intrinsic width raises the floor for the whole sidebar, and
//     the last time that happened the 44pt rail was pushed off the left edge.
//
//   - `Spacer(minLength: 0)`, never a bare `Spacer()`. The default spacer
//     contributes intrinsic width of its own, which is half the reason header
//     rows squeezed their buttons before their spacer.
//
// The header never takes focus and must never be made `.focusable()` — that
// draws macOS's ring around the entire pane, which has been reported twice.

import SwiftUI

struct PaneHeader<Trailing: View>: View {
    let title: String
    var symbol: String? = nil
    /// Section headers shout; a pane showing the PROJECT's name does not.
    /// Files puts the project name here, and uppercasing someone's folder is
    /// both wrong and unreadable.
    var uppercase: Bool = true
    /// Shown after the title, before the actions — a count, a branch, a state.
    var subtitle: String? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 6) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(MarvinTheme.textMuted)
            }
            Text(title)
                .font(.system(size: uppercase ? 11 : 12, weight: .semibold))
                .textCase(uppercase ? .uppercase : nil)
                .tracking(uppercase ? 0.4 : 0)
                .foregroundStyle(uppercase ? MarvinTheme.textMuted : MarvinTheme.textPrimary)
                .lineLimit(1)
                .fixedSize(horizontal: false, vertical: true)
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            // The actions keep their size while the title gives way: a
            // truncated title is still legible, a truncated button is not.
            HStack(spacing: 2) { trailing() }
                .layoutPriority(1)
        }
        .padding(.horizontal, 10)
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: MarvinTheme.paneHeaderHeight)
    }
}

extension PaneHeader where Trailing == EmptyView {
    init(title: String, symbol: String? = nil, uppercase: Bool = true, subtitle: String? = nil) {
        self.init(title: title, symbol: symbol, uppercase: uppercase, subtitle: subtitle, trailing: { EmptyView() })
    }
}
