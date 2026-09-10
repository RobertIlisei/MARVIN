// ChatAgentsFooter — Phase 5e. The identity bar above the messages:
// which models run the turn (executor → advisor), the voice
// (personality), and the permission posture (auto / gated). The
// per-turn *behaviour* controls — autonomy mode (Ask · Agent · Plan)
// and reasoning effort — moved BELOW the chat input into
// `ChatModeToolbar` (Cursor-style), so this bar stays focused on
// identity and isn't crowded.
//
// Clicking either model pill opens the ModelsDialog. Clicking the
// personality pill toggles marvin / neutral; the badge toggles
// auto / gated.

import SwiftUI

struct ChatAgentsFooter: View {
    @Environment(MarvinBridge.self) private var bridge
    @State private var modelsDialogOpen = false

    @State private var open = false

    /// ADR-0112 — the four identity chips are one pill; the controls live in
    /// its popover. ADR-0108 made posture per session, so this is the one
    /// control that decision implies rather than four with three styles.
    var body: some View {
        Button {
            open.toggle()
        } label: {
            HStack(spacing: 5) {
                Text(trim(bridge.executorModel) ?? "default")
                    .foregroundStyle(bridge.executorModel == nil ? Color.secondary : Color.accentColor)
                dot
                Text(bridge.advisorModel.flatMap(trim) ?? "no advisor")
                    .foregroundStyle(bridge.advisorModel == nil ? Color.secondary : Color.accentColor)
                dot
                Text(bridge.personality ?? "ultron")
                    .foregroundStyle(.secondary)
                dot
                Circle()
                    .fill(bridge.permissionStrategy == "auto" ? Color.green : Color.orange)
                    .frame(width: 6, height: 6)
                Text(bridge.permissionStrategy == "auto" ? "auto" : "gated")
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
            }
            .font(.system(size: 11, design: .monospaced))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: .underPageBackgroundColor))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                    )
            )
        }
        .buttonStyle(.plain)
        .help("Posture for this tab: executor · advisor · voice · permissions. Click to change.")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 10) {
                Text("This tab's posture")
                    .font(.system(size: 12, weight: .semibold))
                HStack(spacing: 6) {
                    modelPill(
                        role: "executor",
                        value: trim(bridge.executorModel) ?? "default",
                        tint: bridge.executorModel == nil ? .secondary : .accentColor
                    )
                    Image(systemName: "arrow.right")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                    modelPill(
                        role: "advisor",
                        value: bridge.advisorModel.flatMap(trim) ?? "—",
                        tint: bridge.advisorModel == nil ? .secondary : .accentColor
                    )
                }
                HStack(spacing: 6) {
                    personalityPill
                    modeBadge
                }
                Text("Mode and effort are below the input. Posture is per tab (ADR-0108).")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            .padding(12)
            .frame(width: 340)
        }
        .sheet(isPresented: $modelsDialogOpen) {
            ModelsDialog()
                .environment(bridge)
        }
    }

    private var dot: some View {
        Text("·").foregroundStyle(.tertiary)
    }

    // MARK: - Pills

    private func modelPill(role: String, value: String, tint: Color) -> some View {
        Button {
            modelsDialogOpen = true
        } label: {
            HStack(spacing: 5) {
                Text(role)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .tracking(1)
                Text(value)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(tint)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: .underPageBackgroundColor))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                    )
            )
        }
        .buttonStyle(.plain)
        .help("\(role): \(value) — click to configure")
    }

    /// Voice / personality pill. Single click cycles the three voices
    /// (ultron → marvin → neutral → ultron), matching the web peer.
    private var personalityPill: some View {
        let active = bridge.personality ?? "ultron"
        let next = active == "ultron" ? "marvin" : active == "marvin" ? "neutral" : "ultron"
        return Button {
            NativePrefs.shared.setPersonality(next)
        } label: {
            HStack(spacing: 4) {
                let iconName = active == "marvin" ? "brain" : active == "neutral" ? "face.dashed" : "face.smiling"
                Image(systemName: iconName)
                    .font(.system(size: 10))
                Text(active)
                    .font(.system(size: 11, design: .monospaced))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(active == "neutral" ? Color.secondary : Color.accentColor)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: .underPageBackgroundColor))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                    )
            )
        }
        .buttonStyle(.plain)
        .help("Voice — click to cycle ultron / marvin / neutral")
    }

    /// Permission-strategy badge. Auto = green; Gated = amber. Tap
    /// to flip. Lives here (identity bar) because the per-turn confirm
    /// shape is one of the most "what mode am I in" things in the chat.
    private var modeBadge: some View {
        let isAuto = bridge.permissionStrategy == "auto"
        return Button {
            let next = isAuto ? "gated" : "auto"
            NativePrefs.shared.setPermissionStrategy(next)
        } label: {
            HStack(spacing: 4) {
                Circle()
                    .fill(isAuto ? Color.green : Color.orange)
                    .frame(width: 6, height: 6)
                Text(isAuto ? "auto" : "gated")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: .underPageBackgroundColor))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                    )
            )
        }
        .buttonStyle(.plain)
        .help(isAuto
              ? "Permissions: auto (full bypass). Click to switch to gated."
              : "Permissions: gated (tool-call confirms). Click to switch to auto.")
    }

    // MARK: - Helpers

    /// Lossy trim mirroring web `summariseModels`. Drops the
    /// `claude-` prefix and the trailing -2YYMMDD date stamp so
    /// the pill stays compact.
    private func trim(_ id: String?) -> String? {
        guard var s = id else { return nil }
        if s.hasPrefix("claude-") { s = String(s.dropFirst("claude-".count)) }
        if let r = s.range(of: #"-2\d{6}$"#, options: .regularExpression) {
            s = String(s[..<r.lowerBound])
        }
        return s
    }
}
