// ChatAgentsFooter — Phase 5e. Sits under the chat input as a
// compact agent / model selector — the convention every modern
// IDE-with-AI-chat uses (Cursor, Continue, Aider, Zed Assistant):
// the model picker lives in the chat surface, not the global
// toolbar, because switching the executor / advisor is a per-turn
// decision the user makes WHILE drafting a message, not from
// "settings".
//
// The footer is split into:
//   • executor pill — primary model that handles the turn.
//   • advisor pill — optional second-opinion model. "—" when nil.
//   • models button — opens the ModelsDialog sheet.
//   • personality pill — marvin / neutral toggle (the "voice").
//
// Clicking either model pill opens the ModelsDialog. Clicking the
// personality pill toggles between marvin and neutral via the
// existing bridge dispatch path.

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
            thinkingModePicker
            advisorEffortPicker
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

    /// Reasoning-effort picker — the full SDK ladder (Low / Medium /
    /// High / XHigh / Max), matching Claude Desktop & the CLI. Maps to
    /// the SDK's `effort` field server-side via `resolveEffort`. The
    /// top two rungs (XHigh, Max) are Opus-only; they're disabled when
    /// the executor is Sonnet (advisor runtimeMode). The runtime would
    /// silently downgrade anyway, but graying them out keeps the UI
    /// honest. XHigh additionally enables Claude's dynamic-workflow
    /// ("ultracode") behaviour — called out in its help text.
    private var thinkingModePicker: some View {
        let active = bridge.thinkingMode
        let executorIsOpus: Bool = {
            guard let e = bridge.executorModel else { return true }
            return e.range(of: "opus", options: .caseInsensitive) != nil
        }()
        return Menu {
            effortButton("low", "Low", "hare", executorIsOpus: executorIsOpus)
            effortButton("medium", "Medium", "gauge.with.dots.needle.33percent", executorIsOpus: executorIsOpus)
            effortButton("high", "High", "brain", executorIsOpus: executorIsOpus)
            Divider()
            effortButton("xhigh", "XHigh", "brain.head.profile", executorIsOpus: executorIsOpus)
            effortButton("max", "Max", "bolt.fill", executorIsOpus: executorIsOpus)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: thinkingModeIcon(active))
                    .font(.system(size: 9))
                Text(effortLabel(active))
                    .font(.system(size: 11, design: .monospaced))
                Image(systemName: "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(thinkingModeColour(active))
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: .underPageBackgroundColor))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                    )
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(thinkingModeHelp(active, executorIsOpus: executorIsOpus))
    }

    /// Advisor-specific effort picker (ADR-0033). Defaults to "follow"
    /// — the advisor inherits the executor's effort, the pre-0033
    /// behaviour — so the chip stays quiet until the user explicitly
    /// splits the two. The ladder mirrors `thinkingModePicker`;
    /// `xhigh`/`max` gate on the ADVISOR model being Opus (nil means
    /// the default advisor, which is Opus).
    private var advisorEffortPicker: some View {
        let active = bridge.advisorThinkingMode // nil = follow executor
        let advisorIsOpus: Bool = {
            guard let a = bridge.advisorModel else { return true }
            return a.range(of: "opus", options: .caseInsensitive) != nil
        }()
        return Menu {
            Button {
                NativePrefs.shared.setAdvisorThinkingMode(nil)
            } label: {
                Label("Follow executor", systemImage: "arrow.turn.down.left")
            }
            Divider()
            advisorEffortButton("low", "Low", "hare", advisorIsOpus: advisorIsOpus)
            advisorEffortButton("medium", "Medium", "gauge.with.dots.needle.33percent", advisorIsOpus: advisorIsOpus)
            advisorEffortButton("high", "High", "brain", advisorIsOpus: advisorIsOpus)
            Divider()
            advisorEffortButton("xhigh", "XHigh", "brain.head.profile", advisorIsOpus: advisorIsOpus)
            advisorEffortButton("max", "Max", "bolt.fill", advisorIsOpus: advisorIsOpus)
        } label: {
            HStack(spacing: 5) {
                Text("adv")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .tracking(1)
                Image(systemName: active.map(thinkingModeIcon) ?? "arrow.turn.down.left")
                    .font(.system(size: 9))
                Text(active.map(effortLabel) ?? "follow")
                    .font(.system(size: 11, design: .monospaced))
                Image(systemName: "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(active.map(thinkingModeColour) ?? .secondary)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: .underPageBackgroundColor))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                    )
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(active == nil
              ? "Advisor effort: follows the executor's effort. Click to set independently."
              : "Advisor effort: \(effortLabel(active!)) — independent of the executor (ADR-0033).")
    }

    /// One advisor effort-ladder row. `xhigh`/`max` gate on the advisor
    /// model being Opus.
    @ViewBuilder
    private func advisorEffortButton(
        _ value: String,
        _ title: String,
        _ icon: String,
        advisorIsOpus: Bool
    ) -> some View {
        let opusOnly = value == "xhigh" || value == "max"
        Button {
            NativePrefs.shared.setAdvisorThinkingMode(value)
        } label: {
            Label(title, systemImage: icon)
        }
        .disabled(opusOnly && !advisorIsOpus)
    }

    /// One effort-ladder row. `xhigh`/`max` are disabled off-Opus.
    @ViewBuilder
    private func effortButton(
        _ value: String,
        _ title: String,
        _ icon: String,
        executorIsOpus: Bool
    ) -> some View {
        let opusOnly = value == "xhigh" || value == "max"
        Button {
            NativePrefs.shared.setThinkingMode(value)
        } label: {
            Label(title, systemImage: icon)
        }
        .disabled(opusOnly && !executorIsOpus)
    }

    /// Short display label for the chip. Normalises any legacy value
    /// that slipped through so the chip never shows "thinking"/"fast".
    private func effortLabel(_ mode: String) -> String {
        switch mode {
        case "fast", "low": return "low"
        case "medium": return "medium"
        case "thinking", "high": return "high"
        case "xhigh": return "xhigh"
        case "max": return "max"
        default: return mode
        }
    }

    private func thinkingModeIcon(_ mode: String) -> String {
        switch mode {
        case "fast", "low": return "hare"
        case "medium": return "gauge.with.dots.needle.33percent"
        case "xhigh": return "brain.head.profile"
        case "max": return "bolt.fill"
        default: return "brain" // high / thinking
        }
    }

    private func thinkingModeColour(_ mode: String) -> Color {
        switch mode {
        case "fast", "low": return .secondary
        case "xhigh", "max": return .accentColor
        default: return .primary
        }
    }

    private func thinkingModeHelp(_ mode: String, executorIsOpus: Bool) -> String {
        switch mode {
        case "fast", "low":
            return "Effort: Low — minimal extended reasoning, quickest responses."
        case "medium":
            return "Effort: Medium — moderate reasoning."
        case "xhigh":
            return executorIsOpus
                ? "Effort: XHigh — deeper than High. Enables dynamic workflows (parallel subagents for large audits/migrations). Opus only."
                : "Effort: XHigh — falls back to High on a non-Opus executor."
        case "max":
            return executorIsOpus
                ? "Effort: Max — maximum reasoning, longest budget. Opus only."
                : "Effort: Max — falls back to High on a non-Opus executor."
        default: // high / thinking
            return "Effort: High — deep reasoning when needed. Default."
        }
    }

    /// Permission-strategy badge. Auto = green; Gated = amber. Tap
    /// to flip. Lives here too because the per-turn confirm shape
    /// is one of the most "I want to know what mode I'm in" things
    /// in the chat — same reason VS Code surfaces the workspace
    /// trust state next to the chat send button.
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
