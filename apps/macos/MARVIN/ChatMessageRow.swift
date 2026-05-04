// ChatMessageRow — SwiftUI row views for the native message list.
//
// Phase 2c. One ChatMessageRow per ChatMessage; per-block sub-views
// inside. Visual style is intentionally minimal — Phase 2d polishes
// the tool-call card layout, syntax-highlights code blocks, and adds
// timestamps; Phase 4 (theme port) brings the OKLCH tokens over from
// the web side. Today: legibility + role differentiation, nothing
// more.
//
// ## Why no NSCollectionView yet
//
// ADR-0017 §5 defers the NSCollectionView decision to "after we have
// real numbers". SwiftUI's List handles a few hundred rows fine; the
// motivation for the migration was the 500-1000+ message case, but
// even there our messages are heavyweight rows with text + tool
// content, not narrow rows where List's per-cell overhead matters.
// We measure when 2c ships against a real session before reaching
// for NSCollectionView.

import SwiftUI

struct ChatMessageRow: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            roleGutter
                .frame(width: 56, alignment: .topTrailing)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(message.blocks) { block in
                    blockView(for: block)
                }
                if message.isStreaming {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                        Text("streaming…")
                            .font(.caption.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
    }

    /// Role label down the left gutter — keeps the message body
    /// flush so long text reads cleanly. Tinted by role.
    private var roleGutter: some View {
        Text(roleLabel)
            .font(.caption.monospaced())
            .foregroundStyle(roleColor)
    }

    private var roleLabel: String {
        switch message.role {
        case .user: "you"
        case .assistant: "marvin"
        case .system: "system"
        case .result: "—"
        }
    }

    private var roleColor: Color {
        switch message.role {
        case .user: .accentColor
        case .assistant: .primary
        case .system: .secondary
        case .result: Color.secondary.opacity(0.6)
        }
    }

    @ViewBuilder
    private func blockView(for block: ChatBlock) -> some View {
        switch block {
        case .text(_, let text):
            TextBlockView(text: text, role: message.role)
        case .toolUse(_, let name, let input):
            ToolUseBlockView(name: name, input: input)
        case .toolResult(_, _, let output, let isError):
            ToolResultBlockView(output: output, isError: isError)
        case .unknown(_, let kind, let raw):
            UnknownBlockView(kind: kind, raw: raw)
        }
    }
}

// MARK: - Per-block subviews

private struct TextBlockView: View {
    let text: String
    let role: ChatRole

    var body: some View {
        Text(text)
            .font(role == .system || role == .result ? .caption : .body)
            .foregroundStyle(role == .system || role == .result ? .secondary : .primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Tool-call card. Phase 2c keeps this terse — name + collapsible
/// input dump. Phase 2d adds tool-specific renderers (Bash command,
/// Edit diff preview, Read snippet, etc.).
private struct ToolUseBlockView: View {
    let name: String
    let input: ChatJSON?

    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(name)
                    .font(.caption.monospaced().weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.accentColor.opacity(0.15))
                    )
                Text(inputSummary)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                Button(expanded ? "▾" : "▸") {
                    withAnimation(.easeOut(duration: 0.12)) { expanded.toggle() }
                }
                .buttonStyle(.borderless)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            }
            if expanded, let input {
                Text(prettyJSON(input))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(Color(nsColor: .textBackgroundColor).opacity(0.5))
                    )
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 2)
    }

    private var inputSummary: String {
        guard let input else { return "" }
        // Pull a one-line summary out — e.g. `command:` for Bash,
        // `file_path:` for Edit / Read / Write. Falls back to a short
        // serialisation of the whole input.
        if case let .object(dict) = input {
            for key in ["command", "file_path", "path", "pattern", "url"] {
                if case let .string(s) = dict[key] ?? .null {
                    return s
                }
            }
        }
        return prettyJSON(input).split(separator: "\n").first.map(String.init) ?? ""
    }
}

private struct ToolResultBlockView: View {
    let output: String
    let isError: Bool

    @State private var expanded = false
    private let inlineLimit = 500

    var body: some View {
        let truncated = output.count > inlineLimit && !expanded
        let visible = truncated ? String(output.prefix(inlineLimit)) + "…" : output

        VStack(alignment: .leading, spacing: 4) {
            Text(visible)
                .font(.caption.monospaced())
                .foregroundStyle(isError ? Color.red.opacity(0.85) : .secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color(nsColor: .textBackgroundColor).opacity(0.4))
                )
                .textSelection(.enabled)
            if output.count > inlineLimit {
                Button(expanded ? "show less" : "show all (\(output.count) chars)") {
                    withAnimation(.easeOut(duration: 0.12)) { expanded.toggle() }
                }
                .buttonStyle(.borderless)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            }
        }
    }
}

private struct UnknownBlockView: View {
    let kind: String
    let raw: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("unhandled block: \(kind)")
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
            Text(raw)
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(3)
                .truncationMode(.tail)
                .textSelection(.enabled)
        }
        .padding(.vertical, 2)
    }
}

/// Pretty-print a ChatJSON value as a stable, human-readable string.
/// Used by the tool-use input dump + the input-summary fallback.
private func prettyJSON(_ value: ChatJSON) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value),
          let text = String(data: data, encoding: .utf8) else {
        return "\(value)"
    }
    return text
}
