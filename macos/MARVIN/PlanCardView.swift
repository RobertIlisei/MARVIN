// PlanCardView — ADR-0036 (revised). The Cursor-style plan card.
//
// Plan mode presents the plan inline in the chat and stops (no
// ExitPlanMode, no modal — see the ADR's 2026-06-11 revision). The
// plan-mode prompt contract requires the final reply to open with a
// `# Plan — <title>` heading; ChatMessageRow detects that heading and
// renders the message through this card instead of the plain text
// bubble. Detection is content-shaped, so it works live (while the
// plan streams) AND on transcript replay, where the turn's mode is no
// longer known. If the model ever omits the heading the message
// degrades gracefully to the normal text bubble — nothing breaks.

import SwiftUI

/// Content-shape detection for a plan message.
enum PlanCard {
    /// True when an assistant text block is a Plan-mode plan: the
    /// (trimmed) text opens with the `# Plan` heading the plan-mode
    /// prompt contract mandates.
    static func isPlan(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .hasPrefix("# plan")
    }
}

/// The structured plan card: header (title + step count + collapse),
/// body (the plan markdown, line-styled). Approval actions stay in the
/// status-tray chip — the card is the readable artifact.
struct PlanCardView: View {
    let text: String

    @State private var collapsed = false

    private var lines: [PlanLine] { PlanLineParser.parse(text) }

    /// "Plan — title" pulled from the opening `# Plan…` heading.
    private var title: String {
        let first = text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n", maxSplits: 1)
            .first.map(String.init) ?? "Plan"
        let stripped = first.drop(while: { $0 == "#" || $0 == " " })
        return stripped.isEmpty ? "Plan" : String(stripped)
    }

    private var stepCount: Int {
        lines.filter {
            if case .numbered = $0 { return true }
            return false
        }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if !collapsed {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        lineView(line)
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.purple.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.purple.opacity(0.25), lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 7) {
            Button {
                withAnimation(.easeInOut(duration: 0.12)) { collapsed.toggle() }
            } label: {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 14)
            }
            .buttonStyle(.plain)
            Image(systemName: "map")
                .font(.system(size: 11))
                .foregroundStyle(.purple)
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
            if stepCount > 0 {
                Text("\(stepCount) steps")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func lineView(_ line: PlanLine) -> some View {
        switch line {
        case .heading(let level, let s):
            Text(inline(s))
                .font(.system(size: level <= 2 ? 12 : 11.5, weight: .semibold))
                .padding(.top, 4)
                .textSelection(.enabled)
        case .numbered(let marker, let s):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker)
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.purple)
                Text(inline(s))
                    .font(.system(size: 12))
                    .textSelection(.enabled)
            }
        case .bullet(let indent, let s):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("•")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                Text(inline(s))
                    .font(.system(size: 12))
                    .textSelection(.enabled)
            }
            .padding(.leading, CGFloat(12 + indent * 12))
        case .code(let s):
            Text(s)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(Color(nsColor: .textBackgroundColor).opacity(0.5))
                )
                .textSelection(.enabled)
        case .prose(let s):
            Text(inline(s))
                .font(.system(size: 12))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        case .blank:
            Spacer().frame(height: 1)
        }
    }

    /// Inline markdown (bold / italics / code spans) via Foundation's
    /// parser; falls back to the raw string on parse failure.
    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(
            markdown: s,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(s)
    }
}

// MARK: - Line-level markdown parsing

/// One styled line of the plan body. Deliberately line-based — plans
/// are headings + numbered steps + bullets + short prose; a full
/// markdown engine is overkill for the card.
enum PlanLine {
    case heading(Int, String)
    /// Marker as written ("1." / "2)") + content — keeps the model's
    /// own numbering so the card matches the saved PLAN.md.
    case numbered(String, String)
    case bullet(Int, String)  // indent level (0 = top), content
    case code(String)         // one fenced code block, joined
    case prose(String)
    case blank
}

enum PlanLineParser {
    private static let numberedRE = try? NSRegularExpression(pattern: #"^\s*(\d+[.)])\s+(.+\S)\s*$"#)
    private static let bulletRE = try? NSRegularExpression(pattern: #"^(\s*)[-*•]\s+(.+\S)\s*$"#)

    private static func match(_ re: NSRegularExpression?, _ s: String) -> (String, String)? {
        guard let re else { return nil }
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        guard let m = re.firstMatch(in: s, range: range),
              let r1 = Range(m.range(at: 1), in: s),
              let r2 = Range(m.range(at: 2), in: s) else { return nil }
        return (String(s[r1]), String(s[r2]))
    }

    static func parse(_ text: String) -> [PlanLine] {
        var out: [PlanLine] = []
        var codeBuffer: [String] = []
        var inCode = false

        let allLines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        for (i, raw) in allLines.enumerated() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if inCode {
                    out.append(.code(codeBuffer.joined(separator: "\n")))
                    codeBuffer = []
                }
                inCode.toggle()
                continue
            }
            if inCode {
                codeBuffer.append(raw)
                continue
            }
            // The opening `# Plan…` heading is the card header — skip it.
            if i == 0 && line.lowercased().hasPrefix("# plan") { continue }
            if line.isEmpty {
                // Collapse runs of blanks to one spacer.
                if case .blank = out.last { continue }
                if out.isEmpty { continue }
                out.append(.blank)
            } else if line.hasPrefix("#") {
                let level = line.prefix(while: { $0 == "#" }).count
                let content = line.drop(while: { $0 == "#" || $0 == " " })
                out.append(.heading(level, String(content)))
            } else if let (marker, content) = match(Self.numberedRE, line) {
                out.append(.numbered(marker, content))
            } else if let (indent, content) = match(Self.bulletRE, raw) {
                out.append(.bullet(min(indent.count / 2, 3), content))
            } else {
                out.append(.prose(line))
            }
        }
        if inCode, !codeBuffer.isEmpty {
            // Unterminated fence (plan still streaming) — show what we have.
            out.append(.code(codeBuffer.joined(separator: "\n")))
        }
        if case .blank = out.last { out.removeLast() }
        return out
    }
}
