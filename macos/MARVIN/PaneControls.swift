// PaneControls — the icon button and the enable toggle, in one shape
// (ADR-0114).
//
// Five icon-button styles were in use across the seven panes: `.borderless`,
// `.plain` at 9pt, a private `iconButton` at 18×18, bare `.plain`, and
// `Label` with `.iconOnly`. None of them showed a hover or a press, so an
// icon in a left pane was indistinguishable from decoration until clicked.
//
// The toggle is the more serious one. Skills and Plugins both render their
// central enable/disable control as a `.buttonStyle(.plain)` SF Symbol — no
// hover, no press, no focus ring, no accessibility trait — and enabling a
// plugin loads MCP servers and agents into the model's tool surface. A
// control with that consequence must look and behave like a control.

import SwiftUI

// MARK: - Icon button

private struct PaneIconButtonStyle: ButtonStyle {
    let size: CGFloat
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        return configuration.label
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(isEnabled ? MarvinTheme.textMuted : Color.secondary.opacity(0.5))
            .frame(width: size + 8, height: size + 8)
            .background(
                RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                    .fill(pressed ? MarvinTheme.rowSelected : (hovering ? MarvinTheme.rowHover : .clear))
            )
            .scaleEffect(pressed && !reduceMotion ? 0.94 : 1)
            .contentShape(Rectangle())
            .onHover { hovering = $0 && isEnabled }
            .animation(.snappy(duration: 0.14, extraBounce: 0), value: pressed)
            .animation(.snappy(duration: 0.14, extraBounce: 0), value: hovering)
    }
}

extension View {
    /// An icon-only action in a pane header or a row.
    func paneIconButton(_ size: CGFloat = 11) -> some View {
        buttonStyle(PaneIconButtonStyle(size: size))
    }
}

// MARK: - Enable toggle

/// The on/off control for a skill or a plugin.
///
/// A real `Toggle` rather than a tinted glyph: it carries the platform's own
/// switch affordance, it takes keyboard focus, and VoiceOver announces it as
/// a switch with its state. `onToggle` fires with the value the user asked
/// for, so the caller can await the round trip and revert on failure without
/// this view holding any state of its own.
struct PaneEnableToggle: View {
    let isOn: Bool
    var help: String? = nil
    let onToggle: (Bool) -> Void

    var body: some View {
        Toggle("", isOn: Binding(get: { isOn }, set: { onToggle($0) }))
            .toggleStyle(.switch)
            .controlSize(.mini)
            .labelsHidden()
            .help(help ?? (isOn ? "Switch off" : "Switch on"))
    }
}
