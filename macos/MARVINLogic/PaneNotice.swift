// PaneNotice — the result of an action in a left-pane section, with its kind
// attached (2026-09-11).
//
// Before: one `String?` rendered as 10pt grey text, four lines deep. A merge
// that succeeded and a merge that failed with a git conflict looked exactly
// alike, and the failure's text was the raw child-process error —
// "Merge of marvin/tab/x into main failed and was aborted: Command failed:
// git merge --no-ff -m Merge branch 'marvin/tab/…" — wrapped into a grey
// paragraph where the sentence that mattered was buried in the middle.
//
// Apple's rule is that feedback comes in kinds — status, completion, warning,
// error — and that an error says what went wrong and what to do. So a notice
// carries its kind, and splits into a SENTENCE a person reads and a DETAIL
// that is machine output. The detail is monospaced, dimmed, clipped to three
// lines, and never competes with the sentence.
//
// Pure logic, no AppKit — testable from MARVINTests.

import Foundation

public struct PaneNotice: Equatable {
    public enum Kind: Equatable {
        /// Nothing happened, and nothing was wrong. "Nothing to reclaim."
        case info
        /// It worked.
        case success
        /// It partly worked, or it declined for a reason the user can fix.
        case warning
        /// It failed.
        case error

    }

    public let kind: Kind
    public let headline: String
    public let detail: String?

    public init(kind: Kind, headline: String, detail: String? = nil) {
        self.kind = kind
        self.headline = headline
        self.detail = detail
    }

    /// Split a raw outcome string into the sentence and the machine detail.
    ///
    /// Two markers, both seen on real failures: a child-process error appends
    /// `Command failed: …`, and multi-line outcomes put the summary first and
    /// the per-branch notes after. Everything from the first marker onward is
    /// detail; what precedes it is the sentence, with a trailing separator
    /// tidied so it reads as one.
    public init(kind: Kind, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var head = trimmed
        var tail: String? = nil

        if let range = trimmed.range(of: "Command failed:") {
            head = String(trimmed[trimmed.startIndex..<range.lowerBound])
            tail = String(trimmed[range.lowerBound...])
        } else if let newline = trimmed.firstIndex(of: "\n") {
            head = String(trimmed[trimmed.startIndex..<newline])
            tail = String(trimmed[trimmed.index(after: newline)...])
        }

        head = head.trimmingCharacters(in: .whitespacesAndNewlines)
        // "…was aborted:" and "…failed:" read as an unfinished sentence once
        // what followed them has moved into the detail.
        while head.hasSuffix(":") || head.hasSuffix(" —") || head.hasSuffix(",") {
            head = String(head.dropLast()).trimmingCharacters(in: .whitespaces)
        }
        if !head.isEmpty, !head.hasSuffix(".") , !head.hasSuffix("!"), !head.hasSuffix("?") {
            head += "."
        }

        let cleanTail = tail?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.kind = kind
        self.headline = head.isEmpty ? (kind == .error ? "It failed." : "Done.") : head
        self.detail = (cleanTail?.isEmpty ?? true) ? nil : cleanTail
    }
}
