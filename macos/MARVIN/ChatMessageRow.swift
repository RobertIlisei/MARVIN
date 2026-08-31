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
import AppKit
import MARVINLogic

struct ChatMessageRow: View {
    let message: ChatMessage

    var body: some View {
        // One context menu over both branches. Copy reads the MODEL, not
        // the rendered view: prose renders through an AppKit `NSTextView`
        // (`RichText`), and whatever is wrong with drag-selection there,
        // "I want to copy this" should not depend on it (user, 2026-08-31:
        // "i can't select the text, reason is i want to copy it from here").
        // It also copies the WHOLE message, which is what dragging across
        // it was trying to achieve.
        Group {
        // User messages right-align in an accent-tinted bubble
        // (chat-UI convention; matches the web `<MessageView>`'s
        // `justify-end` + `bg-[color:var(--color-accent-glow)]`
        // bubble in sidecar/src/components/chat/message-view.tsx).
        // Everything else stays left-aligned with a 56pt role gutter
        // on the left and no bubble — matches the assistant /
        // system / result rendering on the web side.
        if message.role == .user {
            HStack(alignment: .top, spacing: 0) {
                Spacer(minLength: 40)
                userBubble
            }
            .padding(.vertical, 6)
        } else {
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
        }
        .contextMenu {
            Button("Copy Message") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(plainText, forType: .string)
            }
            .disabled(plainText.isEmpty)
        }
    }

    /// User message bubble — accent-tinted rounded rectangle with
    /// the "you" label above the text. The bubble itself sizes to
    /// content; ChatMessageRow's outer HStack provides the
    /// minLength: 40 left spacer so a long user line doesn't span
    /// the entire pane width (would visually fight with the
    /// assistant's left-aligned blocks).
    private var userBubble: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Text("you")
                .font(.caption2.monospaced())
                .tracking(2)
                .textCase(.uppercase)
                .foregroundStyle(Color.accentColor.opacity(0.8))
            VStack(alignment: .leading, spacing: 8) {
                ForEach(message.blocks) { block in
                    blockView(for: block)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        // Neutral lifted card, not an accent-tinted one. Background-job
        // completion prompts (ADR-0038) are injected as USER messages, so
        // with the old accent tint every job report rendered as a large
        // navy block — the "weird colors" finding, 2026-08-29.
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(MarvinTheme.elevated)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(MarvinTheme.border, lineWidth: 1)
                )
        )
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
        case .assistant: MarvinTheme.textPrimary
        case .system: MarvinTheme.textMuted
        case .result: MarvinTheme.textMuted.opacity(0.7)
        }
    }

    /// This message as plain text for the clipboard.
    ///
    /// Reads the MODEL, not the rendered view, so copying works regardless
    /// of what drag-selection does in the AppKit text view underneath.
    private var plainText: String {
        MessagePlainText.joined(message.blocks.map { block in
            switch block {
            case .text(_, let text):
                return .text(text)
            case .thinking(_, let text, let redacted):
                return .thinking(text, redacted: redacted)
            case .toolCall(_, let name, let input, _):
                return .toolCall(name: name, input: input?.summaryLine)
            case .orphanToolResult, .unknown:
                return .unknown
            }
        })
    }

    @ViewBuilder
    private func blockView(for block: ChatBlock) -> some View {
        switch block {
        case .text(_, let text):
            // ADR-0036 — a Plan-mode plan contains a `# Plan` heading
            // (prompt contract). Render the plan portion as the structured
            // Cursor-style card; any diagnosis prose the model wrote BEFORE
            // the heading stays as normal text above it. Content-shaped, so
            // it also fires on transcript replay.
            if message.role == .assistant, let parts = PlanCard.split(text) {
                if !parts.preamble.isEmpty {
                    TextBlockView(text: parts.preamble, role: message.role)
                }
                PlanCardView(text: parts.plan)
            } else {
                TextBlockView(text: text, role: message.role)
            }
        case .toolCall(_, let name, let input, let result):
            ToolCallBlockView(name: name, input: input, result: result)
        case .orphanToolResult(_, let toolUseId, let output, let isError):
            OrphanToolResultBlockView(toolUseId: toolUseId, output: output, isError: isError)
        case .thinking(_, let text, let redacted):
            ThinkingBlockView(text: text, redacted: redacted)
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
        // User-bubble text sizes to content (the bubble's outer
        // RoundedRectangle wraps to whichever is smaller: text
        // intrinsic width or the row's available width). Assistant
        // / system / result text fills the row width so long
        // paragraphs wrap naturally without ragged-right edges.
        let isInBubble = (role == .user)
        // Assistant/system/result output is markdown — headings, fenced code,
        // pipe tables, lists — and used to render as literal syntax. The user's
        // own message stays plain: they typed it, so showing it back
        // reinterpreted (a leading `#` becoming a heading) would misrepresent
        // what they sent.
        if isInBubble {
            // A pasted image is carried as an `@/abs/path.png` token, so the
            // bubble used to show the raw path — the preview vanished at
            // exactly the moment the user pressed send (2026-08-30). Render the
            // picture, the way the composer chip already does.
            if AttachmentMentions.containsImage(text) {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(AttachmentMentions.split(text).enumerated()), id: \.offset) { _, segment in
                        switch segment {
                        case .text(let body):
                            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !trimmed.isEmpty {
                                Text(trimmed)
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        case .image(let path):
                            SentAttachmentImage(path: path)
                        }
                    }
                }
            } else {
                Text(text)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: nil, alignment: .leading)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            MarkdownView(
                text: text,
                fillWidth: true,
                baseFont: role == .system || role == .result ? .caption : .body,
                baseColor: role == .system || role == .result ? .secondary : .primary,
                workDir: MarvinBridge.shared.projectWorkDir
            )
        }
    }
}

/// One image attachment inside a sent user message.
///
/// Falls back to the plain `@path` token when the file will not load — a
/// mention of a deleted or non-image file must still read correctly rather
/// than leaving a blank gap.
private struct SentAttachmentImage: View {
    let path: String

    var body: some View {
        if let thumb = AttachmentThumbnail.image(forPath: path, maxEdge: AttachmentThumbnail.bubbleMaxEdge) {
            Image(nsImage: thumb)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: 320, maxHeight: 220, alignment: .leading)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(MarvinTheme.border, lineWidth: 0.5)
                )
                .contentShape(Rectangle())
                .onTapGesture {
                    QuickLookCoordinator.shared.show(url: URL(fileURLWithPath: path))
                }
                .onHover { inside in
                    if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                }
                .help("\((path as NSString).lastPathComponent) — click to preview")
                .accessibilityLabel("Attached image \((path as NSString).lastPathComponent)")
        } else {
            Text("@\(path)")
                .font(.body.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Tool-call card (Phase 2d)

/// Visual style for one tool's name pill. Each tool gets a distinct
/// tint so a turn that runs Bash + Edit + Read is scannable at a
/// glance — matches the colour grouping the web side uses.
private enum ToolStyle {
    case execute    // Bash, Task, AskUserQuestion — actions that run
    case read       // Read, Grep, Glob — read-only inspection
    case write      // Edit, Write, NotebookEdit — file mutations
    case web        // WebFetch, WebSearch — external IO
    case other      // anything we haven't mapped yet

    var tint: Color {
        switch self {
        case .execute: .orange
        case .read: .blue
        case .write: .green
        case .web: .purple
        case .other: .secondary
        }
    }

    static func forName(_ name: String) -> ToolStyle {
        switch name {
        case "Bash", "Task", "AskUserQuestion": .execute
        case "Read", "Grep", "Glob", "ListMcpResourcesTool": .read
        case "Edit", "Write", "NotebookEdit": .write
        case "WebFetch", "WebSearch": .web
        default: .other
        }
    }
}

/// Unified call+result card. Header shows the tool name pill, a
/// one-line summary of the input, a status pip (running / done /
/// errored), and a chevron. Expanded body shows the full input
/// dump and (when arrived) the full output.
private struct ToolCallBlockView: View {
    let name: String
    let input: ChatJSON?
    let result: ChatToolResult?

    @State private var expanded = false

    private var style: ToolStyle { ToolStyle.forName(name) }
    private var isPending: Bool { result == nil }
    private var isErrored: Bool { result?.isError == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if expanded {
                expandedBody
            } else if isErrored, let result {
                // Errors get a one-line preview even when collapsed —
                // a red toolCall is surprising enough to warrant
                // visibility without forcing the user to expand.
                Text(result.output)
                    .font(.caption.monospaced())
                    .foregroundStyle(Color.red.opacity(0.85))
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(style.tint.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(style.tint.opacity(0.25), lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(name)
                .font(.caption.monospaced().weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(style.tint.opacity(0.18))
                )
                .foregroundStyle(style.tint.opacity(0.9))
            Text(inputSummary)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer()
            statusPip
            Button(expanded ? "▾" : "▸") {
                withAnimation(.easeOut(duration: 0.12)) { expanded.toggle() }
            }
            .buttonStyle(.borderless)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
        }
    }

    /// Tiny status indicator: spinner while pending, dot once done.
    @ViewBuilder
    private var statusPip: some View {
        if isPending {
            ProgressView()
                .controlSize(.mini)
        } else if isErrored {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .font(.caption)
        } else {
            Image(systemName: "checkmark")
                .foregroundStyle(.green)
                .font(.caption.weight(.semibold))
        }
    }

    @ViewBuilder
    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let input {
                ToolInputView(name: name, input: input)
            }
            if let result {
                ToolOutputView(output: result.output, isError: result.isError)
            }
        }
        .padding(.top, 4)
    }

    /// One-line preview for the collapsed header. Picks the most
    /// useful field per tool — `command` for Bash, `file_path` for
    /// file tools, `pattern` for Grep, `url` for web. Falls back to
    /// the first-line of the full JSON.
    private var inputSummary: String {
        input?.summaryLine ?? ""
    }
}

extension ChatJSON {
    /// The most useful single line of a tool's input — `command` for Bash,
    /// `file_path` for the file tools, `pattern` for Grep, `url` for web,
    /// falling back to the first line of the pretty JSON.
    ///
    /// Shared by the collapsed tool header and the row's Copy command, so
    /// what you copy is what you were looking at.
    var summaryLine: String? {
        if case let .object(dict) = self {
            for key in ["command", "file_path", "path", "pattern", "url", "query"] {
                if case let .string(s) = dict[key] ?? .null {
                    return s
                }
            }
        }
        let pretty = prettyJSON(self)
        return pretty.split(separator: "\n").first.map(String.init)
    }
}

/// Tool-aware input renderer. Bash gets a `$ command` shell prompt
/// style; Edit / Write / Read show the file path on its own line
/// followed by the rest of the input fields; everything else gets
/// the pretty JSON dump.
private struct ToolInputView: View {
    let name: String
    let input: ChatJSON

    var body: some View {
        switch name {
        case "Bash":
            bashView
        case "Edit", "Write":
            fileMutationView
        case "Read", "Glob":
            fileReadView
        case "Grep":
            grepView
        default:
            jsonDumpView
        }
    }

    private var bashView: some View {
        let cmd = stringField("command") ?? prettyJSON(input)
        return HStack(alignment: .top, spacing: 6) {
            Text("$")
                .font(.caption.monospaced().weight(.semibold))
                .foregroundStyle(.secondary)
            Text(cmd)
                .font(.caption.monospaced())
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
    }

    private var fileMutationView: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let path = stringField("file_path") ?? stringField("path") {
                Label(path, systemImage: "doc.text")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            // For Edit, show old_string → new_string lengths only —
            // the full strings are usually big and the user has to
            // expand the result to see effect anyway.
            if name == "Edit" {
                let oldLen = stringField("old_string")?.count ?? 0
                let newLen = stringField("new_string")?.count ?? 0
                Text("Edit: \(oldLen) → \(newLen) chars")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            }
            if name == "Write", let content = stringField("content") {
                Text("Write: \(content.count) chars")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var fileReadView: some View {
        let path = stringField("file_path") ?? stringField("path") ?? stringField("pattern") ?? "?"
        return Label(path, systemImage: name == "Glob" ? "doc.on.doc" : "doc.text.magnifyingglass")
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
    }

    private var grepView: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let pattern = stringField("pattern") {
                Text("/\(pattern)/")
                    .font(.caption.monospaced())
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
            }
            if let path = stringField("path") {
                Text("in \(path)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var jsonDumpView: some View {
        Text(prettyJSON(input))
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }

    /// Pull a single string field out of an object input. Used by
    /// the per-tool views; nil when the field isn't present or the
    /// input isn't an object.
    private func stringField(_ key: String) -> String? {
        guard case let .object(dict) = input,
              case let .string(s) = dict[key] ?? .null else {
            return nil
        }
        return s
    }
}

/// Tool output renderer. Truncates long outputs with a show-all
/// toggle; renders errors red.
private struct ToolOutputView: View {
    let output: String
    let isError: Bool

    @State private var expanded = false
    private let inlineLimit = 800

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
                        .fill(MarvinTheme.elevated)
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

/// Defensive renderer for a tool_result that arrived without a
/// matching tool_use. Surfaces the output so we don't lose data on
/// out-of-order delivery.
private struct OrphanToolResultBlockView: View {
    let toolUseId: String
    let output: String
    let isError: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("orphan tool_result · use_id=\(toolUseId.prefix(8))…")
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
            ToolOutputView(output: output, isError: isError)
        }
        .padding(.vertical, 2)
    }
}

/// Extended thinking, collapsed by default.
///
/// Reasoning is long and it is not the answer, so it stays out of the way —
/// but it is not noise either, and it certainly is not what it used to
/// render as: `unhandled block: thinking` over a struct dump whose `text`
/// was nil. One dim disclosure row, expandable, matching how the tool cards
/// already hide their payload.
private struct ThinkingBlockView: View {
    let text: String
    let redacted: Bool
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                if !redacted { expanded.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "brain")
                        .font(.system(size: 10))
                    Text(redacted ? "thinking (redacted)" : "thinking")
                        .font(.caption.monospaced())
                    if !redacted {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 8))
                    }
                }
                .foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
            .disabled(redacted)
            .help(redacted
                  ? "This reasoning was encrypted by the API — there is nothing to show."
                  : "The model's reasoning for this step.")
            if expanded && !text.isEmpty {
                Text(text)
                    .font(.caption)
                    .italic()
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 15)
            }
        }
        .padding(.vertical, 2)
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
