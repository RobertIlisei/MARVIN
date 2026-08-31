// MessagePlainText — a chat message as copyable plain text.
//
// The transcript renders prose through an AppKit `NSTextView` (`RichText`,
// so links get a pointing-hand cursor that SwiftUI's `Text` cannot give
// while also being selectable). Whatever is wrong with drag-selection
// there, "I want to copy this" should not depend on it: a copy command
// reads the model, not the rendered view, so it works even when selection
// does not — and it copies the WHOLE message, which is what the user was
// trying to do by dragging across it.
//
// Pure (ADR-0022) so the block-to-text mapping is pinned without a window.

import Foundation

public enum MessagePlainText {
    /// One rendered block as the text a user would expect on the clipboard.
    /// Returns nil for blocks with nothing readable in them.
    public static func text(forBlockKind kind: BlockKind) -> String? {
        switch kind {
        case .text(let body):
            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case .thinking(let body, let redacted):
            // Redacted thinking carries no readable text by design; copying
            // a placeholder for it would be copying our own UI, not content.
            guard !redacted else { return nil }
            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case .toolCall(let name, let input):
            // The command, not the output. Someone copying a message wants
            // the prose and what was run — a tool result can be megabytes.
            let arg = input?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return arg.isEmpty ? "$ \(name)" : "$ \(name) \(arg)"
        case .unknown:
            return nil
        }
    }

    /// The blocks joined into one clipboard payload.
    public static func joined(_ kinds: [BlockKind]) -> String {
        kinds.compactMap { text(forBlockKind: $0) }.joined(separator: "\n\n")
    }

    /// A view-independent description of a block, so this file does not
    /// depend on the app target's `ChatBlock`.
    public enum BlockKind: Equatable {
        case text(String)
        case thinking(String, redacted: Bool)
        case toolCall(name: String, input: String?)
        case unknown
    }
}
