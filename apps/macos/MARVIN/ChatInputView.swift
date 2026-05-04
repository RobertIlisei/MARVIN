// ChatInputView — native multi-line chat input, Phase 2b.
//
// Wraps an `NSTextView` via `NSViewRepresentable` so we get the
// AppKit text-editing affordances SwiftUI's `TextEditor` doesn't
// quite manage at IDE-grade quality:
//
//   • Proper IME composition (Japanese / Chinese / Korean input
//     methods, dead-key sequences). SwiftUI's TextEditor in macOS
//     Sonoma still drops mid-composition undo events; NSTextView
//     handles this correctly out of the box.
//   • Standard text-find / spelling / autocomplete services.
//   • Stable line-height + padding (TextEditor inherits System
//     font metrics that don't match the rest of the chat UI).
//
// ## Submit semantics
//
//   ⌘⏎  — submit. Same convention as Slack / Linear / iMessage —
//          the web app's <ChatInput> uses the same key. Implemented
//          via a CustomNSTextView subclass that intercepts keyDown
//          before the regular text-editing pipeline sees it.
//   ⏎    — newline (default NSTextView behaviour).
//   ⌥⏎   — newline (alt convention some users have muscle-memory
//          for; falls through to default insertNewline:).
//
// ## Where this lives
//
// Phase 2b sits behind a separate "Native Chat (preview)" Window
// scene that the user opens explicitly from the Window menu. The
// main MARVIN window is unchanged — the WebView still renders the
// existing web chat. The dev surface lets us iterate on the
// native input without disturbing the working UI. Phase 2g
// promotes this into the main window once the message list,
// tool-call cards, and confirm prompts are at parity.

import AppKit
import SwiftUI

/// SwiftUI wrapper around an NSTextView. Bidirectional binding on
/// `text`; `onSubmit` fires when the user hits ⌘⏎.
struct ChatTextEditor: NSViewRepresentable {
    @Binding var text: String
    let onSubmit: () -> Void
    /// Disable the editor (e.g. while a turn is in flight). The
    /// NSTextView still draws but stops accepting keyDown events.
    var isDisabled: Bool = false

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = ChatNSTextView.scrollableTextView()
        let textView = scrollView.documentView as! ChatNSTextView
        textView.delegate = context.coordinator
        textView.onSubmit = { onSubmit() }
        textView.font = .systemFont(ofSize: NSFont.systemFontSize)
        textView.isRichText = false
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        // 8-pt insets match the web ChatInput's padding; the
        // scrollView's content inset is what gives the text
        // breathing room from the visible border.
        textView.textContainerInset = NSSize(width: 6, height: 8)
        textView.string = text
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        // SwiftUI rebuilds this struct on every parent state change.
        // The Coordinator caches the previous View; refresh its
        // snapshot so updated bindings + closures take effect (the
        // onSubmit closure captures the latest model on every
        // rebuild, and isDisabled changes need the Coordinator's
        // textDidChange to see the new value).
        context.coordinator.parent = self
        let textView = scrollView.documentView as! ChatNSTextView
        if textView.string != text {
            textView.string = text
        }
        textView.onSubmit = { onSubmit() }
        textView.isEditable = !isDisabled
        textView.isSelectable = true
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatTextEditor
        init(_ parent: ChatTextEditor) {
            self.parent = parent
        }
        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

/// NSTextView subclass that intercepts ⌘⏎ before the text-editing
/// pipeline sees it. Everything else is stock NSTextView.
final class ChatNSTextView: NSTextView {
    /// Set by the wrapper. Closure to fire on ⌘⏎.
    var onSubmit: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        // 36 is the keyCode for the main Return key. (NSEvent doesn't
        // expose a typed constant for this; the value is stable across
        // macOS releases — used by every "send on Cmd-Enter" app.)
        let isReturn = event.keyCode == 36
        let hasCommand = event.modifierFlags.contains(.command)
        if isReturn && hasCommand {
            onSubmit?()
            return
        }
        super.keyDown(with: event)
    }
}

// MARK: - The preview window's chat input bar

/// Compact input bar — text editor with a placeholder + Send button.
/// Sits at the bottom of the Phase 2b/2c preview window. The Send
/// button is redundant with ⌘⏎ but useful for discoverability while
/// we iterate.
struct ChatInputBar: View {
    @Binding var text: String
    let onSubmit: () -> Void
    let isSending: Bool

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                ChatTextEditor(
                    text: $text,
                    onSubmit: onSubmit,
                    isDisabled: isSending
                )
                .frame(minHeight: 80, maxHeight: 200)

                if text.isEmpty {
                    Text("Type a message — ⌘⏎ to send")
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 12)
                        .allowsHitTesting(false)
                }
            }
            .background(Color(nsColor: .textBackgroundColor))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1)
            )

            HStack(spacing: 8) {
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                    Text("Sending…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Send") {
                    onSubmit()
                }
                .keyboardShortcut(.return, modifiers: [.command])
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
            }
            .padding(.top, 8)
        }
    }
}
