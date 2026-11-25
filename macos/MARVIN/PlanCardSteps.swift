// PlanCardSteps — the numbered steps of the in-chat plan card, with the
// bullets beneath each step folded into it.
//
// A plan's text is read from the model's own markdown (`PlanLineParser`); a
// numbered step is often a paragraph and its bullets are the detail. The card
// shows each step as its lead (the whole text on request), and a step's
// bullets as sub-steps that fold — a step with more than three starts
// folded — so a long plan reads as its steps first. Display only.

import MARVINLogic
import SwiftUI

/// The card's body as blocks: ordinary lines, and numbered steps that own the
/// bullets beneath them.
enum PlanCardBlock {
    case line(PlanLine)
    case step(marker: String, text: String, subs: [(indent: Int, text: String)])

    static func group(_ lines: [PlanLine]) -> [PlanCardBlock] {
        var out: [PlanCardBlock] = []
        var i = 0
        while i < lines.count {
            guard case .numbered(let marker, let text) = lines[i] else {
                out.append(.line(lines[i]))
                i += 1
                continue
            }
            var subs: [(indent: Int, text: String)] = []
            var j = i + 1
            while j < lines.count {
                if case .bullet(let indent, let t) = lines[j] {
                    subs.append((indent, t))
                    j += 1
                } else if case .blank = lines[j], j + 1 < lines.count, case .bullet = lines[j + 1] {
                    j += 1  // one blank between a step's bullets does not end them
                } else {
                    break
                }
            }
            out.append(.step(marker: marker, text: text, subs: subs))
            i = j
        }
        return out
    }
}

@MainActor struct PlanCardStep: View {
    let marker: String
    let text: String
    let subs: [(indent: Int, text: String)]

    @State private var textOpen = false
    @State private var subsToggled = false

    private var subsOpen: Bool { (subs.count <= 3) != subsToggled }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if subs.isEmpty {
                    Color.clear.frame(width: 12, height: 1)
                } else {
                    Button { MarvinMotion.with(.easeOut(duration: 0.15)) { subsToggled.toggle() } } label: {
                        Image(systemName: subsOpen ? "chevron.down" : "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .frame(width: 12)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(subsOpen ? "Fold the sub-steps" : "Show the sub-steps")
                }
                Text(marker)
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.purple)
                Text(inline(textOpen ? PlanStepDisplay.full(text) : PlanStepDisplay.lead(text)))
                    .font(.system(size: 12))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: textOpen)
                if PlanStepDisplay.hasMore(text) {
                    Button(textOpen ? "less" : "more") { textOpen.toggle() }
                        .buttonStyle(.plain)
                        .font(.system(size: 10))
                        .foregroundStyle(.purple)
                        .fixedSize()
                        .accessibilityLabel(textOpen ? "Show the lead only" : "Show the whole step")
                }
                if !subs.isEmpty && !subsOpen {
                    Text("\(subs.count) sub-step\(subs.count == 1 ? "" : "s")")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                }
                Spacer(minLength: 0)
            }
            if subsOpen {
                ForEach(Array(subs.enumerated()), id: \.offset) { _, sub in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•").font(.system(size: 11)).foregroundStyle(.secondary)
                        Text(inline(sub.text))
                            .font(.system(size: 11.5))
                            .foregroundStyle(MarvinTheme.textMuted)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(32 + sub.indent * 12))
                }
            }
        }
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}
