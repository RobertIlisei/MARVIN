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

    var body: some View {
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
            Spacer(minLength: 8)
            personalityPill
            // Autonomy mode + reasoning-effort pickers moved BELOW the chat
            // input (ChatModeToolbar) — Cursor-style — to declutter this bar.
            modeBadge
        }
        .sheet(isPresented: $modelsDialogOpen) {
            ModelsDialog()
                .environment(bridge)
        }
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

    /// Voice / personality pill. Single click toggles between
    /// "marvin" and "neutral" (only two options, like the web peer).
    private var personalityPill: some View {
        let active = bridge.personality ?? "marvin"
        let next = active == "marvin" ? "neutral" : "marvin"
        return Button {
            NativePrefs.shared.setPersonality(next)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "waveform")
                    .font(.system(size: 9))
                Text(active)
                    .font(.system(size: 11, design: .monospaced))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(active == "marvin" ? Color.accentColor : .secondary)
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
        .help("Voice — click to switch between MARVIN and neutral")
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
