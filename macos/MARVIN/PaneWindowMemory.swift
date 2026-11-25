// PaneWindowMemory — a sheet or window that opens at the size it was left at,
// and that can be resized at all.
//
// A SwiftUI sheet is fixed at its content's ideal size unless its window is
// told it may grow, and it forgets a size the person chose the moment it
// closes. The Project Backlog window holds a list of hundreds; a person who
// widened it once should not have to do it again, so this reads the window it
// ends up in, makes it resizable with a floor, applies the remembered size,
// and writes the size back when a resize ends.
//
// The decisions (clamping, the stored string) are `MARVINLogic.WindowSizeMemory`
// and are tested there. This file only talks to AppKit.

import AppKit
import MARVINLogic
import SwiftUI

@MainActor private final class WindowMemoryView: NSView {
    var key = ""
    var minSize = CGSize(width: 480, height: 320)
    private var observer: NSObjectProtocol?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
        guard let window else { return }
        window.styleMask.insert(.resizable)
        window.contentMinSize = minSize
        if let raw = UserDefaults.standard.string(forKey: key),
           let size = WindowSizeMemory.decode(raw, minWidth: minSize.width, minHeight: minSize.height) {
            // Never larger than the screen the window is on.
            let screen = window.screen?.visibleFrame.size ?? CGSize(width: 4000, height: 3000)
            window.setContentSize(CGSize(width: min(size.width, screen.width - 40),
                                         height: min(size.height, screen.height - 40)))
        }
        let key = key
        observer = NotificationCenter.default.addObserver(
            forName: NSWindow.didEndLiveResizeNotification, object: window, queue: .main
        ) { note in
            MainActor.assumeIsolated {
                guard let w = note.object as? NSWindow else { return }
                let size = w.contentLayoutRect.size
                UserDefaults.standard.set(WindowSizeMemory.encode(width: size.width, height: size.height), forKey: key)
            }
        }
    }
}

@MainActor struct PaneWindowMemory: NSViewRepresentable {
    /// `UserDefaults` key the size is kept under.
    let key: String
    let minWidth: CGFloat
    let minHeight: CGFloat

    func makeNSView(context: Context) -> NSView {
        let v = WindowMemoryView()
        v.key = key
        v.minSize = CGSize(width: minWidth, height: minHeight)
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}
