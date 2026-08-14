// EditorAIActions — right-click AI actions on a code selection.
//
// The editor could show you code and MARVIN could talk about code, but the two
// never met: asking "what does this do" meant selecting, copying, switching to
// the chat, pasting, and typing the file path from memory. Every IDE with an
// assistant closes that gap from the context menu — VS Code calls them "smart
// actions", Cursor puts them behind ⌘K — because the selection IS the prompt's
// subject and re-typing it is pure friction.
//
// ## Why this posts a notification rather than calling the chat
//
// The file viewer and the chat live in different view trees; the viewer has no
// reference to `ChatPreviewModel`. This is the same seam File ▸ New Session and
// View ▸ Backlog already cross, so it uses the same mechanism rather than
// inventing a second one.
//
// ## Why the prompts are written here and not left to the model
//
// Each action carries a specific instruction with the file, the line range and
// the code. A bare "explain this" would make the model re-derive what it is
// looking at, and — worse — an unanchored selection invites it to go read half
// the project first. The `file:line` anchoring is also what makes the reply's
// citations clickable in the transcript (MarkdownLinks).

import AppKit
import Foundation

/// One right-click action over a code selection.
enum EditorAIAction: String, CaseIterable {
    case explain
    case review
    case docstring
    case addToChat

    var title: String {
        switch self {
        case .explain:   return "Explain this code…"
        case .review:    return "Review & improve…"
        case .docstring: return "Generate docstring…"
        case .addToChat: return "Add selection to chat…"
        }
    }

    /// Shown in the transcript as the control row, so the turn reads as an
    /// action you took rather than a message you supposedly typed.
    func display(file: String, lines: String) -> String {
        let name = (file as NSString).lastPathComponent
        switch self {
        case .explain:   return "💬 Explain \(name):\(lines)"
        case .review:    return "🔍 Review \(name):\(lines)"
        case .docstring: return "📝 Docstring for \(name):\(lines)"
        case .addToChat: return "📎 Added \(name):\(lines) to chat"
        }
    }

    /// The instruction the model receives.
    ///
    /// `review` and `docstring` are deliberately READ-ONLY-first: they propose
    /// and wait. An action fired from a context menu carries no confirmation
    /// step, and silently rewriting the file under the cursor because someone
    /// right-clicked is exactly the surprise this codebase keeps designing out.
    func prompt(file: String, lines: String, language: String, code: String) -> String {
        let fence = "```\(language)\n\(code)\n```"
        let where_ = "`\(file):\(lines)`"
        switch self {
        case .explain:
            return """
            Explain what this code does, in plain English. It is \(where_).

            \(fence)

            Cover: what it's for, how it works step by step, and anything \
            surprising or risky about it. Do NOT edit anything — this is a \
            question, not a task.
            """
        case .review:
            return """
            Review this code and suggest improvements. It is \(where_).

            \(fence)

            Look for correctness bugs, unhandled edge cases, unclear naming, and \
            simpler formulations. Rank what you find by how much it matters, and \
            say plainly if it's already fine — a clean review is a valid result. \
            PROPOSE the changes; do not apply them until I say so.
            """
        case .docstring:
            return """
            Write a docstring for this code. It is \(where_).

            \(fence)

            Match the docstring convention already used in this file (check the \
            surrounding code first). Document what it does, its parameters and \
            return value, and any non-obvious behaviour — not a restatement of \
            the signature. SHOW me the docstring; don't write it into the file \
            until I confirm.
            """
        case .addToChat:
            return """
            For reference, here is \(where_):

            \(fence)
            """
        }
    }
}

extension Notification.Name {
    /// Posted by the editor's context menu. `userInfo` carries `prompt`,
    /// `display` and `cwd`; the chat view observes and dispatches the turn.
    static let marvinEditorAIAction = Notification.Name("marvin.editorAIAction")
}

enum EditorAIDispatcher {
    /// Build and post the turn for `action` over the current selection.
    ///
    /// Falls back to the WHOLE file when nothing is selected — right-clicking
    /// without a selection means "this file", and refusing to act would read as
    /// a broken menu item.
    @MainActor
    static func fire(
        _ action: EditorAIAction,
        selection: String,
        wholeFile: String,
        path: String,
        lineRange: String,
        cwd: String?
    ) {
        let hasSelection = !selection.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let code = hasSelection ? selection : wholeFile
        let lines = hasSelection ? lineRange : "whole file"
        // Big selections are the user's call, but an unbounded paste can blow a
        // context window on one right-click. Trim with a visible marker rather
        // than silently sending a truncated fragment as if it were complete.
        let capped = code.count > 12_000
            ? String(code.prefix(12_000)) + "\n… [truncated — \(code.count) chars total]"
            : code

        let payload: [String: String] = [
            "prompt": action.prompt(
                file: path,
                lines: lines,
                language: (path as NSString).pathExtension.lowercased(),
                code: capped
            ),
            "display": action.display(file: path, lines: lines),
            "cwd": cwd ?? "",
        ]
        NotificationCenter.default.post(
            name: .marvinEditorAIAction,
            object: nil,
            userInfo: payload
        )
    }
}
