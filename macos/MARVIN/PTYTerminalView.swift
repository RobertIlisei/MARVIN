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

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeNSView(context: Context) -> NSView {
        let container = FocusingContainer()
        let tv = session.view
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
        return container
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.session = session
        if let tv = (nsView as? FocusingContainer)?.terminal { applyTheme(tv) }
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
