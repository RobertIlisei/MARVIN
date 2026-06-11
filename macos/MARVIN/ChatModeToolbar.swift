// ChatModeToolbar — the row of per-turn behaviour controls that sits
// directly BELOW the chat input, Cursor-style: the autonomy mode
// (Ask · Agent · Plan) on the left, reasoning effort (executor + advisor)
// on the right. These used to live in the crowded top agents bar with the
// model pills; moving the "what will it do / how hard will it think"
// controls under the textarea matches Cursor / Zed and keeps the top bar
// focused on identity (models, voice, permission posture).

import SwiftUI

struct ChatModeToolbar: View {
    @Environment(MarvinBridge.self) private var bridge

    var body: some View {
        HStack(spacing: 6) {
            autonomyModePicker
            Spacer(minLength: 8)
            thinkingModePicker
            advisorEffortPicker
        }
    }

    // MARK: - Autonomy mode (Ask · Agent · Plan)

    /// Autonomy-mode picker (ADR-0036): Ask · Agent · Plan — Cursor-style.
    /// Orthogonal to the auto/gated permission badge: this is *what* MARVIN
    /// may do, that is *how* its edits get confirmed. Ask = read-only;
    /// Agent = full autonomy (default); Plan = plan-first, approval-gated.
    private var autonomyModePicker: some View {
        let active = bridge.mode
        return Menu {
            ForEach(["ask", "agent", "plan"], id: \.self) { m in
                Button {
                    NativePrefs.shared.setMode(m)
                } label: {
                    Label(
                        autonomyModeLabel(m),
                        systemImage: active == m ? "checkmark" : autonomyModeIcon(m)
                    )
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: autonomyModeIcon(active))
                    .font(.system(size: 10))
                Text(autonomyModeLabel(active))
                    .font(.system(size: 11, design: .monospaced))
                Image(systemName: "chevron.up")
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
            }
            .foregroundStyle(autonomyModeColour(active))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(autonomyModeHelp(active))
    }

    private func autonomyModeLabel(_ m: String) -> String {
        switch m {
        case "ask": return "Ask"
        case "plan": return "Plan"
        default: return "Agent"
        }
    }

    private func autonomyModeIcon(_ m: String) -> String {
        switch m {
        case "ask": return "bubble.left.and.text.bubble.right"
        case "plan": return "checklist"
        default: return "wand.and.stars"
        }
    }

    private func autonomyModeColour(_ m: String) -> Color {
        switch m {
        case "ask": return .blue
        case "plan": return .purple
        default: return .accentColor
        }
    }

    private func autonomyModeHelp(_ m: String) -> String {
        switch m {
        case "ask":
            return "Ask — read-only. MARVIN explores and explains but cannot edit (enforced at the gate)."
        case "plan":
            return "Plan — MARVIN drafts a plan + to-do list and waits for your approval before executing."
        default:
            return "Agent — full autonomy: reads, edits, runs. The auto/gated badge controls how edits are confirmed."
        }
    }

    // MARK: - Reasoning effort (executor)

    /// Reasoning-effort picker — the full SDK ladder (Low / Medium /
    /// High / XHigh / Max). Maps to the SDK's `effort` field. The top two
    /// rungs (XHigh, Max) are Opus-only; disabled when the executor is
    /// Sonnet. XHigh enables Claude's dynamic-workflow ("ultracode") path.
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
                Image(systemName: "chevron.up")
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(thinkingModeColour(active))
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(thinkingModeHelp(active, executorIsOpus: executorIsOpus))
    }

    // MARK: - Reasoning effort (advisor)

    /// Advisor-specific effort picker (ADR-0033). "follow" = inherit the
    /// executor's effort (the pre-0033 default).
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
                Image(systemName: "chevron.up")
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(active.map(thinkingModeColour) ?? .secondary)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(active == nil
              ? "Advisor effort: follows the executor's effort. Click to set independently."
              : "Advisor effort: \(effortLabel(active!)) — independent of the executor (ADR-0033).")
    }

    // MARK: - Effort helpers

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
        default: return "brain"
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
        default:
            return "Effort: High — deep reasoning when needed. Default."
        }
    }
}
