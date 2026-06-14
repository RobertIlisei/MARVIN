// AskQuestionSheet — ADR-0040. Interactive AskUserQuestion.
//
// The model's built-in `AskUserQuestion` tool arrives through the same
// confirm channel as gated tool confirms (sdk-runner routes it there in every
// mode — it can never be auto-answered). Instead of the generic Allow/Deny
// `ConfirmSheet`, an AskUserQuestion confirm is rendered here: each question
// with its options as clickable rows (label + description), single- or
// multi-select, plus an "Other" free-text the harness normally adds itself.
//
// Submitting returns the choice to the model as the tool RESULT via the
// confirm response's `updatedInput` (the AskUserQuestionOutput shape:
// `{ questions: <echo>, answers: { <question text>: <label(s)> } }`). Skipping
// denies with a nudge to proceed on the model's own recommendation, so the
// turn never hangs.

import SwiftUI

// MARK: - Parsed question model

struct AskOption: Identifiable, Equatable {
    let id = UUID()
    let label: String
    let description: String
    let preview: String?
}

struct AskQuestion: Identifiable, Equatable {
    let id = UUID()
    let question: String
    let header: String
    let multiSelect: Bool
    let options: [AskOption]

    /// Parse the `AskUserQuestion` tool input (ChatJSON) into typed questions.
    /// Tolerant — a malformed entry is skipped rather than crashing the sheet.
    static func parse(_ input: ChatJSON?) -> [AskQuestion] {
        guard case let .object(root)? = input,
              case let .array(rawQuestions)? = root["questions"] else { return [] }
        return rawQuestions.compactMap { q in
            guard case let .object(qo) = q,
                  case let .string(question)? = qo["question"],
                  case let .array(rawOpts)? = qo["options"] else { return nil }
            let header: String = {
                if case let .string(h)? = qo["header"] { return h }
                return "Choose"
            }()
            let multi: Bool = {
                if case let .bool(b)? = qo["multiSelect"] { return b }
                return false
            }()
            let opts: [AskOption] = rawOpts.compactMap { o in
                guard case let .object(oo) = o,
                      case let .string(label)? = oo["label"] else { return nil }
                let desc: String = { if case let .string(d)? = oo["description"] { return d }; return "" }()
                let preview: String? = { if case let .string(p)? = oo["preview"] { return p }; return nil }()
                return AskOption(label: label, description: desc, preview: preview)
            }
            guard !opts.isEmpty else { return nil }
            return AskQuestion(question: question, header: header, multiSelect: multi, options: opts)
        }
    }
}

// MARK: - Sheet

struct AskQuestionSheet: View {
    let request: ConfirmRequest
    /// Allow with the AskUserQuestionOutput `updatedInput`.
    let onSubmit: ([String: Any]) -> Void
    /// Deny — "you decide", proceed on MARVIN's recommendation.
    let onSkip: () -> Void

    /// qIndex → chosen option labels (a Set so multi-select is natural; a
    /// single-select question just holds 0 or 1).
    @State private var picked: [Int: Set<String>] = [:]
    /// qIndex → free-text for the auto-added "Other" choice.
    @State private var otherText: [Int: String] = [:]

    private var questions: [AskQuestion] { AskQuestion.parse(request.input) }

    private func isChosen(_ q: Int, _ label: String) -> Bool { picked[q]?.contains(label) ?? false }
    private func otherChosen(_ q: Int) -> Bool { !(otherText[q]?.trimmingCharacters(in: .whitespaces).isEmpty ?? true) }

    /// Every question must have an answer (a picked option or Other text).
    private var canSubmit: Bool {
        questions.indices.allSatisfy { i in !(picked[i]?.isEmpty ?? true) || otherChosen(i) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(Array(questions.enumerated()), id: \.offset) { qi, q in
                        questionBlock(qi, q)
                    }
                    if questions.isEmpty {
                        Text("MARVIN asked a question, but its options couldn't be read. Skip to let it proceed.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(16)
            }
            Divider()
            footer
        }
        .frame(width: 520)
        .frame(maxHeight: 600)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "questionmark.circle.fill")
                .foregroundStyle(.orange)
            Text("MARVIN needs your decision")
                .font(.headline)
            Spacer()
        }
        .padding(16)
    }

    @ViewBuilder
    private func questionBlock(_ qi: Int, _ q: AskQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(q.header.uppercased())
                    .font(.caption2.monospaced())
                    .tracking(1)
                    .foregroundStyle(.orange)
                if q.multiSelect {
                    Text("· pick any")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Text(q.question)
                .font(.system(size: 13, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
            ForEach(q.options) { opt in
                optionRow(qi, q, opt)
            }
            otherRow(qi, q)
        }
    }

    private func optionRow(_ qi: Int, _ q: AskQuestion, _ opt: AskOption) -> some View {
        let chosen = isChosen(qi, opt.label)
        return Button {
            toggle(qi, q, opt.label)
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: selectionIcon(multi: q.multiSelect, on: chosen))
                    .foregroundStyle(chosen ? Color.accentColor : .secondary)
                    .font(.system(size: 13))
                VStack(alignment: .leading, spacing: 2) {
                    Text(opt.label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.primary)
                    if !opt.description.isEmpty {
                        Text(opt.description)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let preview = opt.preview, !preview.isEmpty {
                        Text(preview)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .padding(6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 5).fill(Color(nsColor: .textBackgroundColor).opacity(0.5)))
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 6).fill(chosen ? Color.accentColor.opacity(0.10) : Color.secondary.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(chosen ? Color.accentColor.opacity(0.4) : Color.secondary.opacity(0.15), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The "Other" free-text choice the harness adds automatically.
    private func otherRow(_ qi: Int, _ q: AskQuestion) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: otherChosen(qi) ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(otherChosen(qi) ? Color.accentColor : .secondary)
                .font(.system(size: 13))
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text("Other")
                    .font(.system(size: 12, weight: .medium))
                TextField("Type your own answer…", text: Binding(
                    get: { otherText[qi] ?? "" },
                    set: { newValue in
                        otherText[qi] = newValue
                        // Typing in Other clears single-select picks so the two
                        // don't both submit; multi-select keeps its picks.
                        if !q.multiSelect, !newValue.trimmingCharacters(in: .whitespaces).isEmpty {
                            picked[qi] = []
                        }
                    }
                ))
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12))
            }
            Spacer(minLength: 0)
        }
        .padding(8)
    }

    private var footer: some View {
        HStack {
            Button("Skip — you decide") { onSkip() }
                .help("Let MARVIN proceed using its own recommended option.")
            Spacer()
            Button("Send choice") { submit() }
                .keyboardShortcut(.return, modifiers: [.command])
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit)
        }
        .padding(16)
    }

    // MARK: - Selection logic

    private func selectionIcon(multi: Bool, on: Bool) -> String {
        if multi { return on ? "checkmark.square.fill" : "square" }
        return on ? "largecircle.fill.circle" : "circle"
    }

    private func toggle(_ qi: Int, _ q: AskQuestion, _ label: String) {
        var set = picked[qi] ?? []
        if q.multiSelect {
            if set.contains(label) { set.remove(label) } else { set.insert(label) }
        } else {
            set = [label]
            otherText[qi] = ""  // single-select option supersedes Other
        }
        picked[qi] = set
    }

    // MARK: - Submit → AskUserQuestionOutput

    private func submit() {
        var answers: [String: Any] = [:]
        for (qi, q) in questions.enumerated() {
            var parts = q.options.map(\.label).filter { picked[qi]?.contains($0) ?? false }
            let other = otherText[qi]?.trimmingCharacters(in: .whitespaces) ?? ""
            if !other.isEmpty { parts.append(other) }
            // AskUserQuestionOutput keys answers by the full question text;
            // multi-select joins labels with commas (SDK convention).
            answers[q.question] = parts.joined(separator: ",")
        }
        // Echo the original questions back alongside the answers — the SDK
        // builds the tool result (AskUserQuestionOutput) from updatedInput.
        var updated: [String: Any] = ["answers": answers]
        if let qs = chatJSONToAny(request.input), case let dict as [String: Any] = qs,
           let questionsAny = dict["questions"] {
            updated["questions"] = questionsAny
        }
        onSubmit(updated)
    }
}

/// Convert a ChatJSON value into a Foundation JSON object (`Any`) suitable for
/// `JSONSerialization` — used to echo the original `questions` back verbatim.
private func chatJSONToAny(_ value: ChatJSON?) -> Any? {
    guard let value else { return nil }
    switch value {
    case .null: return NSNull()
    case .bool(let b): return b
    case .number(let n): return n
    case .string(let s): return s
    case .array(let a): return a.compactMap { chatJSONToAny($0) }
    case .object(let o):
        var out: [String: Any] = [:]
        for (k, v) in o { out[k] = chatJSONToAny(v) ?? NSNull() }
        return out
    }
}
