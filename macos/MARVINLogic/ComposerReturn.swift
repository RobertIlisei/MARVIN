// ComposerReturn — what the Return key does in the chat composer.
//
// `ChatInputView.keyDown` called `onSubmit` for any plain Return without asking
// whether an input method was mid-composition (audit C1). For a CJK or accent
// composition, Return is the key that CONFIRMS the candidate; sending the
// message instead ships half-typed text. The file's own header claimed IME
// handling. The decision lives here so it can be asserted.

import Foundation

public enum ComposerReturn: Equatable, Sendable {
    case notReturn
    /// An input method has marked text: Return is its to consume.
    case deferToInputMethod
    /// Shift/Option+Return — a literal newline.
    case newline
    case submit

    public static func decide(
        keyCode: UInt16,
        shift: Bool,
        option: Bool,
        hasMarkedText: Bool
    ) -> ComposerReturn {
        // 36 is the main Return key; NSEvent has no typed constant for it.
        guard keyCode == 36 else { return .notReturn }
        if hasMarkedText { return .deferToInputMethod }
        return shift || option ? .newline : .submit
    }
}
