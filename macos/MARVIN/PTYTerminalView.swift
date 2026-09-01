// PTYTerminalView — hosts a session's SwiftTerm view in SwiftUI (ADR-0078).
//
// SwiftTerm renders; the session owns the pty. This representable wires the
// two: keystrokes → pty, pty bytes → renderer (done in the session), size
// changes → `TIOCSWINSZ`. It also owns focus: the old pane had a text field
// under a scrollback, so clicking the pane did not put you in the input and
// every Enter dropped focus (user, 2026-08-29). Here the whole surface is the
// terminal — it becomes first responder when the pane appears and on click.

import AppKit
import MARVINLogic
import SwiftTerm
import SwiftUI

struct PTYTerminalView: NSViewRepresentable {
    let session: TerminalSession
    /// Bumped when something types a command into this shell from elsewhere —
    /// the Tasks panel, the build-task sheet. Focus follows, so ⌃C reaches the
    /// job that was just started.
    ///
    /// Without this, a task launched from the sidebar leaves first responder
    /// in the sidebar: the terminal focuses itself only in `makeNSView`, and a
    /// pane that is already mounted never runs that again. The user then
    /// presses ⌃C into whatever had focus, and reaches for the chat footer's
    /// Stop — which cancels a TURN and has nothing to do with a shell command
    /// (user, 2026-09-01: "i started a task but i can't seem to cancel it").
    var focusToken: Int = 0

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeNSView(context: Context) -> NSView {
        let container = FocusingContainer()
        mount(session.view, in: container, context: context)
        return container
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.session = session
        guard let container = nsView as? FocusingContainer else { return }
        if focusToken != context.coordinator.lastFocusToken {
            context.coordinator.lastFocusToken = focusToken
            if let tv = container.terminal {
                DispatchQueue.main.async { tv.window?.makeFirstResponder(tv) }
            }
        }
        // SESSION SWAP. Sessions are keyed by workDir, so switching projects
        // hands us a DIFFERENT TerminalSession with a different TerminalView —
        // and SwiftUI keeps this representable's identity, so only this method
        // runs, never `makeNSView`.
        //
        // This used to reassign the coordinator's session and stop there: the
        // keystrokes went to the NEW shell while the OLD shell's view stayed
        // on screen. Typing showed nothing and Enter appeared to do nothing,
        // because the new shell's output was feeding a view that was not in
        // the hierarchy. `markAttached()` was `makeNSView`-only too, so the
        // new session never left its `pending` buffer either — it would have
        // stayed blank even once shown. Reported 2026-08-30 and narrowed to
        // "happens when switching projects", which is exactly this path.
        if container.terminal !== session.view {
            container.terminal?.removeFromSuperview()
            mount(session.view, in: container, context: context)
        } else {
            applyTheme(session.view)
        }
    }

    /// Put `tv` in `container` edge-to-edge, wire the delegate, and let the
    /// session flush anything it buffered while detached. One path, so a swap
    /// can never do less than the initial mount did.
    private func mount(_ tv: TerminalView, in container: FocusingContainer, context: Context) {
        tv.terminalDelegate = context.coordinator
        applyTheme(tv)
        tv.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(tv)
        NSLayoutConstraint.activate([
            tv.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            tv.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            tv.topAnchor.constraint(equalTo: container.topAnchor),
            tv.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        container.terminal = tv
        session.markAttached()
        DispatchQueue.main.async { tv.window?.makeFirstResponder(tv) }
    }

    private func applyTheme(_ tv: TerminalView) {
        tv.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        tv.nativeBackgroundColor = NSColor.textBackgroundColor
        tv.nativeForegroundColor = NSColor.textColor
        tv.caretColor = NSColor.textColor
    }

    /// Clicking anywhere in the pane focuses the terminal.
    final class FocusingContainer: NSView {
        weak var terminal: TerminalView?
        override func mouseDown(with event: NSEvent) {
            window?.makeFirstResponder(terminal)
            super.mouseDown(with: event)
        }
        override var acceptsFirstResponder: Bool { true }
        override func becomeFirstResponder() -> Bool {
            if let t = terminal { return window?.makeFirstResponder(t) ?? false }
            return super.becomeFirstResponder()
        }
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency TerminalViewDelegate {
        /// Last `focusToken` acted on, so focus is stolen only when something
        /// actually injected a command — not on every SwiftUI update.
        var lastFocusToken = 0

        var session: TerminalSession
        init(session: TerminalSession) { self.session = session }

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            session.send(data)
        }
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            session.resize(columns: newCols, rows: newRows)
        }
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link) { NSWorkspace.shared.open(url) }
        }
        func bell(source: TerminalView) { NSSound.beep() }
        func clipboardCopy(source: TerminalView, content: Data) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setData(content, forType: .string)
        }
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}
