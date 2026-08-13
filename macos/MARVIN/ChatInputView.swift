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
//   ⏎    — submit. Default IDE chat shape (Slack / Discord / Cursor)
//          — single line of muscle memory, no modifier required.
//   ⌘⏎   — also submits (preserves the older convention without
//          getting in the way of the new Enter-to-send default).
//   ⇧⏎   — newline. Hold shift when you actually want a multi-line
//          message; falls through to default insertNewline:.
//   ⌥⏎   — newline (alt convention some users have muscle-memory
//          for; falls through to default insertNewline:).
//
// ## Where this lives
//
// Phase 2b sat behind a separate "Native Chat (preview)" Window
// scene opened explicitly from the Window menu, so the then-WebView
// main window stayed undisturbed while the native input matured
// (WebView removed end-to-end in ADR-0021; this IS the chat input
// now). Phase 2g
// promotes this into the main window once the message list,
// tool-call cards, and confirm prompts are at parity.

import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// SwiftUI wrapper around an NSTextView. Bidirectional binding on
/// `text`; `onSubmit` fires when the user hits ⌘⏎.
struct ChatTextEditor: NSViewRepresentable {
    @Binding var text: String
    let onSubmit: () -> Void
    /// Disable the editor (e.g. while a turn is in flight). The
    /// NSTextView still draws but stops accepting keyDown events.
    var isDisabled: Bool = false
    /// Slash-command autocomplete hooks. All default to inert, so any caller
    /// that doesn't opt in behaves exactly as before.
    /// Names of commands that actually exist, so the composer can HIGHLIGHT a
    /// recognised `/command` token. Without it there's no way to tell a real
    /// command from ordinary text that happens to start with a slash.
    var knownCommands: Set<String> = []
    /// Fired from the text view's OWN change notification with its OWN string.
    /// The `text` @Binding round-trips through SwiftUI and can lag a keystroke,
    /// which left the autocomplete showing results for the previous query.
    /// This is the source of truth, at the moment it changes.
    var onTextChange: (String) -> Void = { _ in }
    var isCommandPopupOpen: () -> Bool = { false }
    var onCommandMove: (Int) -> Void = { _ in }
    var onCommandAccept: () -> Void = {}
    var onCommandDismiss: () -> Void = {}
    /// Phase 5e — callback for clipboard images pasted into the
    /// editor. The ChatNSTextView intercepts paste and routes any
    /// image content here; the parent saves it to disk + adds it
    /// to the attachments list. Plain text paste falls through to
    /// the default NSTextView behaviour.
    var onImagePaste: (NSImage) -> Bool = { _ in false }
    /// Phase 5f — callback for file URLs pasted from Finder (or any
    /// app that puts file paths on the pasteboard). Return true to
    /// consume — the parent typically promotes each URL to an
    /// attachment chip and skips the default text-paste path.
    var onFilePaste: ([URL]) -> Bool = { _ in false }
    /// Phase 5f — callback for typing `@` at a word boundary. Return
    /// true to consume the `@` keypress (the parent typically opens
    /// the FileMentionPicker; the `@` itself doesn't get inserted
    /// because picking a file becomes a chip, not literal text).
    var onAtTrigger: () -> Bool = { false }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = ChatNSTextView.scrollableTextView()
        let textView = scrollView.documentView as! ChatNSTextView
        textView.delegate = context.coordinator
        textView.onSubmit = { onSubmit() }
        textView.onImagePaste = { image in onImagePaste(image) }
        textView.onFilePaste = { urls in onFilePaste(urls) }
        textView.onAtTrigger = { onAtTrigger() }
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
        textView.onImagePaste = { image in onImagePaste(image) }
        textView.onFilePaste = { urls in onFilePaste(urls) }
        textView.onAtTrigger = { onAtTrigger() }
        textView.isCommandPopupOpen = { isCommandPopupOpen() }
        textView.onCommandMove = { delta in onCommandMove(delta) }
        textView.onCommandAccept = { onCommandAccept() }
        textView.onCommandDismiss = { onCommandDismiss() }
        textView.isEditable = !isDisabled
        textView.isSelectable = true
        Self.highlightCommandToken(in: textView, known: knownCommands)
    }

    /// Tint a leading `/command` token when it names a real command.
    ///
    /// Uses the layout manager's TEMPORARY attributes, not the text storage:
    /// temporary attributes are display-only, so this cannot disturb typing,
    /// IME composition, undo, or the string the composer actually sends.
    static func highlightCommandToken(in textView: NSTextView, known: Set<String>) {
        guard let lm = textView.layoutManager else { return }
        let full = NSRange(location: 0, length: (textView.string as NSString).length)
        lm.removeTemporaryAttribute(.foregroundColor, forCharacterRange: full)
        lm.removeTemporaryAttribute(.font, forCharacterRange: full)
        let text = textView.string
        guard text.hasPrefix("/") else { return }
        // The token is everything up to the first whitespace/newline.
        let afterSlash = text.dropFirst()
        let token = afterSlash.prefix { !$0.isWhitespace && !$0.isNewline }
        guard !token.isEmpty, known.contains(String(token)) else { return }
        let range = NSRange(location: 0, length: token.count + 1)
        lm.addTemporaryAttributes(
            [
                .foregroundColor: NSColor.controlAccentColor,
                .font: NSFont.monospacedSystemFont(
                    ofSize: NSFont.systemFontSize,
                    weight: .semibold
                ),
            ],
            forCharacterRange: range
        )
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
            let current = textView.string
            parent.text = current
            // Drive dependent UI from the editor's actual content, not from the
            // binding we just wrote (which SwiftUI may not have propagated yet).
            parent.onTextChange(current)
            if let tv = textView as? ChatNSTextView {
                ChatTextEditor.highlightCommandToken(in: tv, known: parent.knownCommands)
            }
        }
    }
}

/// NSTextView subclass that intercepts Enter and ⌘V before the
/// text-editing pipeline sees them. Everything else is stock
/// NSTextView.
final class ChatNSTextView: NSTextView {
    /// Set by the wrapper. Closure to fire on ⏎ / ⌘⏎.
    var onSubmit: (() -> Void)?
    /// Set by the wrapper. Called when ⌘V finds an image on the
    /// pasteboard. Return true to consume the paste; false to let
    /// the default text-paste path run as well.
    var onImagePaste: ((NSImage) -> Bool)?
    /// Phase 5f — file URLs on the pasteboard (Finder copy of a
    /// file, "Copy as Pathname", drag-source apps that promote to
    /// file URLs). Return true to consume.
    var onFilePaste: (([URL]) -> Bool)?
    /// Phase 5f — `@` typed at a word boundary. Return true to
    /// consume the keypress so the literal `@` doesn't end up in
    /// the message text — the picker the parent opens replaces
    /// the would-be `@<query>` with an attachment chip.
    var onAtTrigger: (() -> Bool)?

    /// Slash-command autocomplete. Set by the wrapper; returns true when the
    /// popup is OPEN, which is the only condition under which this view
    /// steals ↑/↓/⇥/⎋/⏎ from the text-editing pipeline. When the popup is
    /// closed every key behaves exactly as before — the popup is strictly
    /// additive, and typing can never be broken by it.
    var isCommandPopupOpen: (() -> Bool)?
    /// Move the popup selection. -1 = up, +1 = down.
    var onCommandMove: ((Int) -> Void)?
    /// Accept the highlighted command (⇥ or ⏎ while open).
    var onCommandAccept: (() -> Void)?
    /// Dismiss the popup (⎋ while open).
    var onCommandDismiss: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        // Slash-command popup navigation. Checked FIRST and gated on the popup
        // actually being open, so none of this is reachable during normal
        // typing. ⏎ is included so Enter accepts the highlighted command
        // instead of submitting a half-typed `/emi` as a chat message.
        if isCommandPopupOpen?() == true {
            let mods = event.modifierFlags
            let plain = !mods.contains(.command) && !mods.contains(.option) && !mods.contains(.control)
            switch event.keyCode {
            case 126 where plain: // ↑
                onCommandMove?(-1); return
            case 125 where plain: // ↓
                onCommandMove?(1); return
            case 48 where plain: // ⇥
                onCommandAccept?(); return
            case 53: // ⎋ — always dismisses, modifiers irrelevant
                onCommandDismiss?(); return
            case 36 where plain && !mods.contains(.shift): // ⏎
                onCommandAccept?(); return
            default:
                break
            }
        }
        // 36 is the keyCode for the main Return key. (NSEvent doesn't
        // expose a typed constant for this; the value is stable across
        // macOS releases.) IDE chat convention: Enter alone submits;
        // Shift+Enter / Option+Enter inserts a literal newline. ⌘⏎
        // also submits — preserves muscle memory from earlier MARVIN
        // versions and from Slack/Linear/iMessage.
        let isReturn = event.keyCode == 36
        let mods = event.modifierFlags
        let isShift = mods.contains(.shift)
        let isOption = mods.contains(.option)
        let isCommand = mods.contains(.command)
        if isReturn && !isShift && !isOption {
            // Enter alone (or ⌘⏎) → submit.
            onSubmit?()
            return
        }
        // Phase 5f — `@` at a word boundary fires the inline mention
        // picker. Word-boundary check (start-of-text / preceding
        // whitespace) keeps an email address or "user@host" string
        // from triggering the picker mid-token. ⇧2 ("@") on US
        // layouts, but `charactersIgnoringModifiers` normalises
        // across keyboard layouts so the ' character on AZERTY
        // layouts still resolves to the right symbol.
        if let chars = event.charactersIgnoringModifiers,
           chars == "@",
           !isCommand && !isOption {
            let selRange = selectedRange()
            let str = string as NSString
            let priorIsBoundary: Bool = {
                if selRange.location == 0 { return true }
                let prior = str.character(at: selRange.location - 1)
                return prior == 32 || prior == 10 || prior == 9
            }()
            if priorIsBoundary, onAtTrigger?() == true {
                return
            }
        }
        // Otherwise (Shift/Option held, or any other key) → fall
        // through to NSTextView's default — Shift/Option+Enter
        // inserts a newline; non-Return keys are normal input.
        _ = isCommand // referenced for clarity; explicit no-op
        super.keyDown(with: event)
    }

    /// Override the default paste so a screenshot / Finder image
    /// drag becomes an attachment chip instead of a base64-ish
    /// blob in the message text. Phase 5f resolution order:
    ///
    /// 1. **File URL(s)** — Finder copy of a file lands here.
    ///    Forwarded as-is to onFilePaste; no re-encode through
    ///    NSImage so the original PNG/JPEG/HEIC bytes are preserved.
    ///    The parent classifier (FileTypeIcon.kind) decides whether
    ///    each URL becomes an image or generic file attachment.
    /// 2. **Raw image data** — `⌘⇧4` screenshots, Universal
    ///    Clipboard from iPhone, copy-from-Photos. Resolved by
    ///    ClipboardImage.fromPasteboard which prefers raw `.png` /
    ///    HEIC / TIFF data over `NSImage(pasteboard:)` to avoid
    ///    grabbing a 1024×1024 generic file-icon thumbnail.
    /// 3. Default text paste.
    /// NSTextView's default validates the Edit ▸ Paste item by
    /// checking only for text-shaped pasteboard content. Without
    /// this override, ⌘V on a clipboard that holds *only* an image
    /// (e.g. a `⌃⌘⇧4` screenshot, or a Photos copy) finds Paste
    /// disabled — which means our `paste(_:)` override below never
    /// gets invoked. We keep the item enabled whenever the
    /// pasteboard carries an image type, a file URL, or any
    /// `com.apple.screenshot.*` variant. The actual decoding still
    /// goes through `paste(_:)` so the policy lives in one place.
    override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(NSText.paste(_:)) {
            if pasteboardHasAttachableImageOrFile(NSPasteboard.general) {
                return true
            }
        }
        return super.validateMenuItem(menuItem)
    }

    /// Mirror of validateMenuItem but for the modern user-interface-
    /// validation protocol (toolbar buttons, validated NSResponder
    /// chains, etc). Same predicate.
    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(NSText.paste(_:)) {
            if pasteboardHasAttachableImageOrFile(NSPasteboard.general) {
                return true
            }
        }
        return super.validateUserInterfaceItem(item)
    }

    private func pasteboardHasAttachableImageOrFile(_ pb: NSPasteboard) -> Bool {
        guard let types = pb.types else { return false }
        for type in types {
            // Image variants — covers PNG/HEIC/JPEG/TIFF + the
            // dynamic `com.apple.screenshot.*` family macOS uses for
            // ⌃⌘⇧4 captures.
            if type == .png
                || type == .tiff
                || type == .fileURL
                || type.rawValue.hasPrefix("public.image")
                || type.rawValue.hasPrefix("public.png")
                || type.rawValue.hasPrefix("public.jpeg")
                || type.rawValue.hasPrefix("public.heic")
                || type.rawValue.hasPrefix("public.heif")
                || type.rawValue.hasPrefix("public.tiff")
                || type.rawValue.hasPrefix("com.apple.screenshot")
            {
                return true
            }
        }
        return false
    }

    override func paste(_ sender: Any?) {
        let pb = NSPasteboard.general
        // Always-on diagnostic. Removed the #if DEBUG gate after a
        // user report that ⌃⌘⇧4 → ⌘V wasn't producing an attachment;
        // without this log we had no way to see which type the
        // pasteboard was actually offering. The line is tagged so
        // it's easy to grep out of dev.log.
        NSLog("[ChatNSTextView.paste] types=\(pb.types?.map(\.rawValue) ?? [])")
        // 1. File URL(s) — bypass the NSImage round-trip entirely
        //    when the source is already a file on disk.
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: nil) as? [URL] {
            let fileUrls = urls.filter { $0.isFileURL }
            if !fileUrls.isEmpty {
                if onFilePaste?(fileUrls) == true {
                    NSLog("[ChatNSTextView.paste] → handled as file URLs (\(fileUrls.count))")
                    return
                } else {
                    NSLog("[ChatNSTextView.paste] file URLs present but onFilePaste returned false")
                }
            }
        }
        // 2. Raw image data on the pasteboard. Common for screenshots
        //    and Universal Clipboard pastes that don't include a file
        //    URL (the source app didn't expose one).
        if let image = ClipboardImage.fromPasteboard(pb) {
            if onImagePaste?(image) == true {
                NSLog("[ChatNSTextView.paste] → handled as image (\(Int(image.size.width))×\(Int(image.size.height)))")
                return
            } else {
                NSLog("[ChatNSTextView.paste] image extracted but onImagePaste returned false")
            }
        } else {
            NSLog("[ChatNSTextView.paste] no image extracted from pasteboard — falling through to super")
        }
        super.paste(sender)
    }
}

// MARK: - The preview window's chat input bar

/// Compact input bar — text editor with a placeholder + Send button.
/// Sits at the bottom of the chat pane. Phase 5e adds the
/// attachments bar on top (file mentions / pasted images) and an
/// onAttachImage callback so paste lands a chip instead of a blob.
struct ChatInputBar: View {
    @Binding var text: String
    let onSubmit: () -> Void
    /// Cancel the in-flight turn. Surfaced as a Stop button next to
    /// Send/Queue while `isSending` is true. Bound to ⌘. as the
    /// macOS-conventional cancel shortcut. nil hides the button (no
    /// stop affordance — used in surfaces where cancel isn't
    /// supported).
    let onStop: (() -> Void)?
    let isSending: Bool
    /// Replaces the static "Sending…" indicator with whatever MARVIN
    /// is doing right now — "Thinking…", "Using Bash", "Writing
    /// reply…", etc. Surfaced from the model's `currentActivity`,
    /// driven by cli.event peeks. Nil falls back to "Working…" so a
    /// brief pre-cli.event window doesn't show an empty label.
    let activityLabel: String?
    /// Number of messages the user typed while the current turn was
    /// in flight. The footer shows "· N queued" so they can see the
    /// pipeline length; the queued-chip strip above the input shows
    /// the full content + per-row remove.
    let queuedCount: Int
    /// Phase 5e — pre-send attachment chips (file mentions, image
    /// paste, snippets). Owned by the parent so they survive the
    /// editor's render cycle. The bar renders the chips + hosts
    /// the `+` picker; the parent decides what to do on submit
    /// (typically: prepend `att.messageFragment` to text + clear).
    @Binding var attachments: [ChatAttachment]
    /// Phase 5f — inline @ trigger state. When the user types `@`
    /// at a word boundary the editor consumes the keypress and we
    /// flip this flag so the FileMentionPicker sheet pops over the
    /// chat. Selecting a file appends an attachment; the literal
    /// `@` never makes it into the message text.
    @State private var atPickerOpen = false

    /// Phase 5f — user-resizable editor height. Persisted via
    /// AppStorage so the chat input remembers how much space the
    /// user gave it across launches. The handle above the editor
    /// drives this; clamping happens in the drag gesture.
    @AppStorage("marvin.chat.editorHeight") private var editorHeight: Double = 120
    /// Captured at drag start so the gesture's accumulated
    /// translation lands on a stable baseline (DragGesture's
    /// `translation` is total-since-start, not per-frame delta).
    @State private var dragStartHeight: Double? = nil

    /// True while a Finder/Desktop drag is hovering over the input.
    /// Drives a visible drop-target outline so the user knows the
    /// chat will accept the file. Resets when the drag leaves or
    /// the drop completes.
    @State private var isDropTargeted: Bool = false

    /// Resolve a list of NSItemProviders (the system's drag payload)
    /// into file URLs and append them as attachments. Returns true
    /// when at least one provider could be loaded — the drop-target
    /// outline clears either way. Files load asynchronously so we
    /// hop back to the main actor before mutating `attachments`.
    private func handleDroppedProviders(_ providers: [NSItemProvider]) -> Bool {
        var accepted = false
        for provider in providers {
            guard provider.canLoadObject(ofClass: URL.self) else { continue }
            accepted = true
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url, url.isFileURL else { return }
                Task { @MainActor in
                    let kind = FileTypeIcon.kind(for: url.path)
                    let att = kind == .image
                        ? ChatAttachment(kind: .image(absPath: url.path))
                        : ChatAttachment(kind: .file(absPath: url.path))
                    attachments.append(att)
                }
            }
        }
        return accepted
    }

    /// Slash-command autocomplete (`/`-triggered). Additive: when the popup is
    /// closed the composer behaves exactly as it did before.
    @Environment(MarvinBridge.self) private var bridge
    @State private var slash = SlashCommandModel()
    /// Distance from the top of the window to the top of the input bar —
    /// measured live, so the popup shrinks as the window does instead of
    /// spilling over the transcript.
    @State private var roomAbove: CGFloat = 320
    /// Leave the transcript some breathing room; never collapse below a
    /// usable list.
    private var popupMaxHeight: CGFloat { max(120, min(360, roomAbove - 48)) }
    /// Project the catalog is scoped to — commands differ per project
    /// (plugins are opt-in per workspace).
    private var bridgeProjectId: String? { bridge.activeProjectId }

    /// Replace the composer text with the accepted command + trailing space.
    private func acceptSlashCommand() {
        if let next = slash.accepted() {
            text = next
            slash.close()
        }
    }

    var body: some View {
        VStack(spacing: 4) {
            // Slash-command autocomplete. A real layout SIBLING above the
            // composer rather than an overlay: as an overlay it drew straight
            // over the Send/effort row below it. As a sibling the VStack gives
            // it its own space and the transcript above yields instead.
            if slash.isOpen {
                SlashCommandPopup(
                    matches: slash.matches,
                    selected: slash.selected,
                    maxListHeight: popupMaxHeight,
                    query: slash.activeQuery,
                    onPick: { idx in
                        slash.selectIndex(idx)
                        acceptSlashCommand()
                    }
                )
                .transition(.opacity)
            }
            ChatAttachmentsBar(attachments: $attachments)
            // Phase 5f — drag handle above the editor. IDE-style
            // chat surfaces (Cursor, Continue, Slack, iMessage on
            // iPad) all let the user resize the input by dragging
            // a thin grabber along its top edge. AppStorage
            // persists the height across launches.
            resizeHandle
            ZStack(alignment: .topLeading) {
                ChatTextEditor(
                    text: $text,
                    onSubmit: onSubmit,
                    // Editor stays live during a turn so the user can
                    // queue follow-up messages. Submitting while
                    // isSending appends to the model's queue instead
                    // of starting a parallel turn.
                    isDisabled: false,
                    knownCommands: slash.knownNames,
                    onTextChange: { current in slash.update(for: current) },
                    isCommandPopupOpen: { slash.isOpen },
                    onCommandMove: { delta in slash.move(delta) },
                    onCommandAccept: { acceptSlashCommand() },
                    onCommandDismiss: { slash.close() },
                    onImagePaste: { image in
                        guard let url = ClipboardImage.savePNG(image) else {
                            return false
                        }
                        attachments.append(
                            ChatAttachment(kind: .image(absPath: url.path))
                        )
                        return true
                    },
                    onFilePaste: { urls in
                        // Promote each file URL on the pasteboard to
                        // an attachment chip. Image files become
                        // image attachments (so the chip renders the
                        // photo icon); other files become file
                        // attachments. Both serialise as `@<absPath>`
                        // in the message text.
                        for url in urls {
                            let kind = FileTypeIcon.kind(for: url.path)
                            let att: ChatAttachment
                            if kind == .image {
                                att = ChatAttachment(
                                    kind: .image(absPath: url.path)
                                )
                            } else {
                                att = ChatAttachment(
                                    kind: .file(absPath: url.path)
                                )
                            }
                            attachments.append(att)
                        }
                        return true
                    },
                    onAtTrigger: {
                        atPickerOpen = true
                        return true
                    }
                )
                .frame(height: editorHeight)

                if text.isEmpty && attachments.isEmpty {
                    Text("Message MARVIN — ⏎ send · ⇧⏎ newline · / commands · @ mention · paste image / file")
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 10)
                        .allowsHitTesting(false)
                }
            }
            .onChange(of: text) { _, newValue in
                slash.update(for: newValue)
            }
            // Measure how much room exists above the composer, live. `minY` in
            // global space IS that room, and it changes on every window resize
            // — so the popup cap tracks the window instead of being a guess.
            //
            // CRASH FIX — the measurement is FROZEN while the popup is open.
            // `roomAbove` feeds `popupMaxHeight`, which sizes `SlashCommandPopup`,
            // which is a layout SIBLING ABOVE this view: re-measuring while it is
            // open closes a geometry → state → geometry cycle. In a window too
            // short to grant the composer its ideal height the cycle has no
            // fixpoint — each pass resizes the popup, which moves `minY`, which
            // resizes the popup. Every iteration dirties the SwiftUI graph from
            // inside `NSHostingView.layout()`, so AppKit keeps re-running the
            // window's "Update Constraints in Window" phase until it exceeds its
            // per-window budget and throws an uncaught NSException from
            // `-[NSWindow _postWindowNeedsUpdateConstraints]` — SIGTRAP, whole
            // app down (crash reports 2026-08-02, 2026-08-05).
            //
            // Freezing is also the CORRECT value, not just the safe one: the
            // quantity we want is "room above the composer with no popup in it",
            // which is exactly the last reading taken before it opened.
            .background(
                GeometryReader { proxy in
                    Color.clear
                        .onAppear { roomAbove = proxy.frame(in: .global).minY }
                        .onChange(of: proxy.frame(in: .global).minY) { _, v in
                            guard !slash.isOpen else { return }
                            roomAbove = v
                        }
                }
            )
            .task(id: bridgeProjectId) {
                if let pid = bridgeProjectId {
                    await slash.load(projectId: pid, workDir: bridge.projectWorkDir)
                }
            }
            .sheet(isPresented: $atPickerOpen) {
                FileMentionPicker { picked in
                    if let picked {
                        attachments.append(
                            ChatAttachment(kind: .file(absPath: picked))
                        )
                    }
                    atPickerOpen = false
                }
            }
            .background(Color(nsColor: .textBackgroundColor))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(
                        isDropTargeted
                            ? Color.accentColor
                            : Color(nsColor: .separatorColor),
                        lineWidth: isDropTargeted ? 2 : 1
                    )
            )
            // Drag-and-drop landing zone for files (screenshots
            // dragged from Desktop / Finder, image files, code
            // files, etc.). Reuses the same classifier the paste
            // path does — image files become image attachments
            // (rendered with a thumbnail chip), other files become
            // generic file attachments.
            .onDrop(of: [.fileURL], isTargeted: $isDropTargeted) { providers in
                handleDroppedProviders(providers)
            }

            HStack(spacing: 8) {
                // Cursor-style per-turn controls on the bottom-left of the
                // input — autonomy mode (Ask · Agent · Plan) + reasoning
                // effort — in the same row as Send, the way Cursor lays out
                // `∞ Agent ⌄  Auto ⌄` beneath the textarea.
                ChatModeToolbar()
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                    Text(activityLabel ?? "Working…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                if queuedCount > 0 {
                    Text(isSending ? "· \(queuedCount) queued" : "\(queuedCount) queued")
                        .font(.callout)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                if isSending, let onStop {
                    Button(role: .destructive) {
                        onStop()
                    } label: {
                        Label("Stop", systemImage: "stop.fill")
                            .labelStyle(.titleAndIcon)
                    }
                    .keyboardShortcut(".", modifiers: [.command])
                    .help("Cancel the in-flight turn. ⌘.")
                }
                Button(isSending ? "Queue" : "Send") {
                    onSubmit()
                }
                .keyboardShortcut(.return, modifiers: [])
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          && attachments.isEmpty)
                .buttonStyle(.borderedProminent)
            }
        }
    }

    /// Drag handle above the editor — three pixels of grabber over
    /// six pixels of hit area, vertical-resize cursor on hover.
    /// Drag UP grows the editor (text area gets taller); drag DOWN
    /// shrinks it. Clamped between 60 and 600 pt so a slip of the
    /// mouse can't completely collapse the input or cover the whole
    /// chat.
    private var resizeHandle: some View {
        Color.clear
            .frame(height: 6)
            .contentShape(Rectangle())
            .overlay {
                Capsule()
                    .fill(Color(nsColor: .separatorColor))
                    .frame(width: 32, height: 3)
                    .opacity(0.6)
            }
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeUpDown.push()
                } else {
                    NSCursor.pop()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        if dragStartHeight == nil {
                            dragStartHeight = editorHeight
                        }
                        // SwiftUI's translation.height is positive
                        // when dragging DOWN — invert so dragging
                        // UP grows the editor.
                        let next = (dragStartHeight ?? editorHeight)
                            - Double(value.translation.height)
                        editorHeight = max(60, min(600, next))
                    }
                    .onEnded { _ in
                        dragStartHeight = nil
                    }
            )
    }
}

