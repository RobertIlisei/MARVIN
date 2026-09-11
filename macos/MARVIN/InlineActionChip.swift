// InlineActionChip — the one way an action reads as an action in MARVIN's
// left-pane sections (Source Control ▸ Worktrees, Sessions).
//
// The bug this fixes, in the user's words (2026-09-11): *"nobody knows the
// Prepare MR, Merge All, Reclaim are buttons, they look like normal text."*
// They were `Button(...).buttonStyle(.plain)` with a tinted label — which
// strips every cue macOS uses for a control: no fill, no border, no press
// state, no hover. Worse, both panes are full of tinted *status* text
// (`+880 −13`, `clean`, `6 ready`), so a tinted word carried no information
// about whether it could be clicked.
//
// Apple's design principles, applied:
//
//   - **Familiarity.** A control looks like the platform's controls. A filled
//     capsule with a label is what a small inline action looks like on macOS,
//     and it is already this app's own vocabulary — the commit box's
//     *Generate* button and the branch pill were built this way. Nothing new
//     is invented here; the vocabulary is made consistent.
//   - **Response.** Feedback is on pointer DOWN, not on release: the chip
//     deepens and settles to 0.97 the instant it is pressed. A control that
//     waits for the click to complete before acknowledging it feels dead.
//   - **Behaviour over animation.** The press uses a critically damped spring
//     (`snappy`, no overshoot): a button is not a thrown object, so it must
//     not bounce. Hover crossfades on the same timing.
//   - **Flexibility.** This is a precise-pointer platform, so hover is a real
//     affordance and is used: the chip lifts before it is clicked.
//   - **Simplicity / hierarchy.** Three roles, no more. One accent-filled
//     chip per group is the primary action; everything else is neutral or
//     carries the colour of its own outcome.
//   - **Reduced motion.** The scale is dropped under
//     `accessibilityReduceMotion`; the colour change stays, because it is
//     comprehension, not decoration.

import SwiftUI

enum ChipRole {
    /// The one action a section is FOR. Accent-filled; at most one per group.
    case primary
    /// A real action that is not the headline one.
    case neutral
    /// An action that carries the colour of its own outcome — green to merge,
    /// orange to sync, red to discard.
    case tinted(Color)
}

struct InlineChipStyle: ButtonStyle {
    let role: ChipRole
    /// Row actions are smaller than section actions; both are chips.
    var compact: Bool = false

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        return configuration.label
            .font(.system(size: compact ? 10 : 10.5, weight: .medium))
            // Squeezed below its own width, a Text wraps at every character
            // and a chip becomes a vertical strip of letters — which is what
            // the panes did at narrow widths (2026-09-11). A chip keeps its
            // intrinsic width and lets its ROW clip it instead.
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(foreground)
            .padding(.horizontal, compact ? 7 : 8)
            .padding(.vertical, compact ? 2.5 : 3)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(fill(pressed: pressed))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(stroke, lineWidth: 0.5)
            )
            // Scale is the press cue that reads at any size; it settles with
            // no overshoot, because a button is not thrown.
            .scaleEffect(pressed && !reduceMotion ? 0.97 : 1)
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .onHover { hovering = $0 && isEnabled }
            .animation(.snappy(duration: 0.16, extraBounce: 0), value: pressed)
            .animation(.snappy(duration: 0.16, extraBounce: 0), value: hovering)
    }

    private var tint: Color {
        switch role {
        case .primary: return .accentColor
        case .neutral: return MarvinTheme.textPrimary
        case .tinted(let c): return c
        }
    }

    private var foreground: Color {
        switch role {
        case .primary: return .accentColor
        case .neutral: return isEnabled ? MarvinTheme.textPrimary : MarvinTheme.textMuted
        case .tinted(let c): return c
        }
    }

    /// Pressed is deeper than hovered is deeper than at rest — the same order
    /// the pointer travels, so the chip always reads as ahead of the click.
    private func fill(pressed: Bool) -> Color {
        switch role {
        case .neutral:
            if pressed { return MarvinTheme.rowSelected }
            return hovering ? MarvinTheme.rowHover : MarvinTheme.elevated
        case .primary, .tinted:
            if pressed { return tint.opacity(0.32) }
            return tint.opacity(hovering ? 0.24 : 0.15)
        }
    }

    private var stroke: Color {
        switch role {
        case .neutral: return MarvinTheme.border
        case .primary, .tinted: return tint.opacity(hovering ? 0.45 : 0.28)
        }
    }
}

extension View {
    /// A section action: `Merge all`, `Prepare MR…`.
    func chip(_ role: ChipRole) -> some View {
        buttonStyle(InlineChipStyle(role: role))
    }

    /// A row action: `Merge`, `Sync`, `Answer`.
    func rowChip(_ role: ChipRole) -> some View {
        buttonStyle(InlineChipStyle(role: role, compact: true))
    }
}
