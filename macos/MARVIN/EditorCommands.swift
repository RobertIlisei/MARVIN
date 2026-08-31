// EditorCommands — routes the line-level editor commands to whichever
// text view has focus, using AppKit's responder chain the same way
// `FindCommands` does.
//
// The transforms themselves are pure and live in
// `MARVINLogic/EditorTextOps` with tests; this file is only the glue that
// finds the text view, applies a `TextEdit`, and keeps undo working.
//
// **Undo is the reason this goes through `insertText(_:replacementRange:)`
// rather than assigning `textView.string`.** Setting the string wholesale
// replaces the document out from under `NSUndoManager`, so ⌘Z after a
// Move Line would either do nothing or revert the entire file. Routing the
// change as a text insertion registers one coalesced undo step, which is
// what the user expects: one ⌥↓, one ⌘Z.

import AppKit
import MARVINLogic
import STTextView

@MainActor
enum EditorCommands {
    enum Action {
        case moveLineUp, moveLineDown
        case copyLineUp, copyLineDown
        case duplicate
        case toggleLineComment
        case toggleBlockComment
        case expandSelection, shrinkSelection
        case goToBracket
    }

    /// Selections passed through on the way out by `expandSelection`, so
    /// `shrinkSelection` can walk back down the same path.
    ///
    /// Shrink cannot be computed — "the next SMALLER meaningful span" has no
    /// unique answer, and VS Code's own shrink is likewise a replay of its
    /// expand history. The stack is invalidated whenever the live selection
    /// is not the one expansion last produced, which is how a click or an
    /// arrow key resets it.
    private static var expansionStack: [NSRange] = []
    private static var lastExpansion: NSRange?

    static func perform(_ action: Action) {
        guard let textView = focusedEditor() else { return }
        let text = textView.string
        let selection = textView.selectedRange()

        // Selection-only commands: they move the insertion point, they do
        // not produce a `TextEdit`, and they must not touch the undo stack.
        switch action {
        case .expandSelection:
            if lastExpansion != selection { expansionStack = []; lastExpansion = nil }
            guard let next = EditorTextOps.expandSelection(text, selection) else { return }
            expansionStack.append(selection)
            lastExpansion = next
            textView.setSelectedRange(next)
            textView.scrollRangeToVisible(next)
            return
        case .shrinkSelection:
            guard lastExpansion == selection, let previous = expansionStack.popLast() else { return }
            lastExpansion = previous
            textView.setSelectedRange(previous)
            textView.scrollRangeToVisible(previous)
            return
        case .goToBracket:
            // Try the character at the caret, then the one before it — the
            // caret usually sits just AFTER the bracket you clicked past.
            let candidates = [selection.location, selection.location - 1]
            for offset in candidates {
                if let match = EditorTextOps.matchingBracket(in: text, at: offset) {
                    let to = NSRange(location: match, length: 0)
                    textView.setSelectedRange(to)
                    textView.scrollRangeToVisible(to)
                    return
                }
            }
            return
        default:
            break
        }

        let edit: TextEdit?
        switch action {
        case .moveLineUp:   edit = EditorTextOps.moveLine(text, selection, .up)
        case .moveLineDown: edit = EditorTextOps.moveLine(text, selection, .down)
        case .copyLineUp:   edit = EditorTextOps.copyLine(text, selection, .up)
        case .copyLineDown: edit = EditorTextOps.copyLine(text, selection, .down)
        case .duplicate:    edit = EditorTextOps.duplicate(text, selection)
        case .toggleLineComment:
            let ext = (MarvinBridge.shared.selectedFilePath as NSString?)?
                .pathExtension ?? ""
            // No token for this language → no-op. Guessing `//` into a
            // YAML file would corrupt it, and silently doing nothing is
            // the honest failure here.
            guard let token = EditorTextOps.lineCommentToken(forExtension: ext) else { return }
            edit = EditorTextOps.toggleLineComment(text, selection, token: token)
        case .toggleBlockComment:
            let ext = (MarvinBridge.shared.selectedFilePath as NSString?)?
                .pathExtension ?? ""
            // Same rule as the line token: no delimiters for this language
            // means do nothing. Python lands here deliberately — `"""` is a
            // string literal, not a comment, and inserting one inside an
            // expression changes what the code means.
            guard let tokens = EditorTextOps.blockCommentTokens(forExtension: ext) else { return }
            edit = EditorTextOps.toggleBlockComment(
                text, selection, open: tokens.open, close: tokens.close
            )
        case .expandSelection, .shrinkSelection, .goToBracket:
            return   // handled above; they produce no edit
        }
        guard let edit else { return }   // no-op at the document edges

        // The document moved, so the recorded expansion path no longer
        // describes anything real.
        expansionStack = []
        lastExpansion = nil
        apply(edit, to: textView, original: text)
    }

    /// Replace only the SPAN that changed, not the whole document.
    ///
    /// Two reasons. Undo, as above. And STTextView re-lays-out and
    /// re-highlights whatever it is handed — replacing the full string on
    /// every ⌥↓ re-parses the entire file, which is visible as a stutter
    /// on anything large.
    private static func apply(_ edit: TextEdit, to textView: STTextView, original: String) {
        let (range, replacement) = minimalDiff(from: original, to: edit.text)
        guard let range else { return }
        textView.setSelectedRange(range)
        textView.insertText(replacement, replacementRange: range)
        textView.setSelectedRange(edit.selection)
        textView.scrollRangeToVisible(edit.selection)
    }

    /// The single changed span between two versions of the document —
    /// common prefix and suffix trimmed. Line ops touch two adjacent
    /// lines, so this is usually a few dozen characters out of a file.
    private static func minimalDiff(
        from old: String, to new: String
    ) -> (NSRange?, String) {
        let a = Array(old.utf16), b = Array(new.utf16)
        if a == b { return (nil, "") }
        var head = 0
        while head < a.count, head < b.count, a[head] == b[head] { head += 1 }
        var tail = 0
        while tail < a.count - head, tail < b.count - head,
              a[a.count - 1 - tail] == b[b.count - 1 - tail] { tail += 1 }
        let range = NSRange(location: head, length: a.count - head - tail)
        let insert = String(decoding: b[head..<(b.count - tail)], as: UTF16.self)
        return (range, insert)
    }

    /// The focused STTextView, or the file viewer's if focus is elsewhere.
    /// A line command fired from the menu bar while the chat box has focus
    /// should still act on the editor — unlike Find, where searching the
    /// field you are typing in is correct.
    private static func focusedEditor() -> STTextView? {
        guard let window = NSApp.keyWindow else { return nil }
        if let responder = window.firstResponder as? STTextView { return responder }
        return firstSTTextView(in: window.contentView)
    }

    private static func firstSTTextView(in view: NSView?) -> STTextView? {
        guard let view else { return nil }
        if let tv = view as? STTextView { return tv }
        for sub in view.subviews {
            if let hit = firstSTTextView(in: sub) { return hit }
        }
        return nil
    }
}
