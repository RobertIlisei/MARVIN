// SurfaceSnapshotEditor — dev-only probe of the editor area INSIDE the real main
// window. Inert unless `MARVIN_SNAPSHOT_VIEW=window-editor` and
// `MARVIN_SNAPSHOT_OUT=<dir>` are set; see SurfaceSnapshot.swift for the rules
// every snapshot run follows (a free `MARVIN_PORT`, never 3030).
//
// Why it exists: on 25.11.2026 the owner reported the editor had lost its tab bar,
// its Markdown preview and its preview button. None of it was deleted. The W-11
// clip on the editor column stripped the safe area from the column's AppKit split
// view, so the tab bar and the file header were laid out under the title bar. The
// standalone `file-viewer` surface renders `FileViewerView` outside the window, so
// it never showed it; only the real `ContentView` in a real window does. This hosts
// that, opens two files (a Swift file and a Markdown file), and for each width and
// appearance prints where the editor's content starts against the title bar and
// takes a PNG of the source view and of the Markdown preview (⇧⌘V sent to the
// window, which is what the header's button is bound to).
//
// Geometry is read from NSView frames, never from a `GeometryReader` background
// (AGENTS.md "Measure before theorising").

import AppKit
import MARVINLogic
import SwiftUI

enum EditorSnapshot {
    /// Tab bar (30) + divider (1) + header + divider (1): the chrome that has to sit
    /// between the title bar and the first line of the editor. Anything shorter means
    /// part of it is under the title bar.
    private static let minimumChrome: CGFloat = 56

    @MainActor
    static func run(out: URL) {
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

        let sidecar = FixtureSidecar(port: ServerConfig.port) { method, path, query in
            SurfaceRoutes.handle(method: method, path: path, query: query)
        }
        guard sidecar?.start() == true else {
            print("[editor] could not bind the stand-in sidecar on \(ServerConfig.port); use a free MARVIN_PORT")
            return
        }
        defer { sidecar?.stop() }

        let bridge = MarvinBridge.shared
        SurfaceFixtures.populateBridge(bridge)
        for f in bridge.openFiles { bridge.closeFile(f) }
        NativePrefs.shared.setPreviewOpen(false)
        if NativePrefs.shared.panes.bottom.isOpen { NativePrefs.shared.toggleBottomPanel() }

        let health = HealthMonitor()
        Task { await health.start() }
        spin(until: { health.state.isOnline }, timeout: 6)
        UpdateService.shared.stop()

        let swiftFile = "\(SurfaceFixtures.project)/\(SurfaceFixtures.openFiles[0])"
        let mdFile = "\(SurfaceFixtures.project)/docs/0616-ledger-retention.md"
        var failures = 0

        for dark in [false, true] {
            let scheme = dark ? "dark" : "light"
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            NativePrefs.shared.setTheme(scheme)
            for (w, h) in [(1500, 900), (980, 760)] as [(CGFloat, CGFloat)] {
                for f in bridge.openFiles { bridge.closeFile(f) }
                let root = ContentView().environment(health).environment(bridge)
                let host = NSHostingView(rootView: root)
                host.sizingOptions = []
                let window = NSWindow(
                    contentRect: NSRect(x: 0, y: 0, width: w, height: h),
                    styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                    backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                window.toolbar = NSToolbar(identifier: "snapshot.editor")
                window.toolbarStyle = .unified
                window.contentView = host
                window.setFrame(NSRect(x: -12_000, y: -12_000, width: w, height: h), display: true)
                window.orderFront(nil)
                settle(1.8)
                positionLeftPane(in: host, width: w > 1200 ? 300 : 230)
                settle(0.4)

                bridge.setSelectedFile(swiftFile)
                settle(0.5)
                bridge.setSelectedFile(mdFile)
                settle(0.9)
                let tag = "\(Int(w))-\(scheme)"
                print("[editor] \(tag) openFiles=\(bridge.openFiles.map { ($0 as NSString).lastPathComponent }) selected=\((bridge.selectedFilePath as NSString?)?.lastPathComponent ?? "none")")

                failures += report("\(tag) source", host: host, window: window, expectScroll: .sourceText, out: out, png: "editor-\(tag)-1-source")

                // ⇧⌘V: the shortcut the header's Markdown toggle is bound to.
                sendKey("v", [.command, .shift], to: window)
                settle(0.7)
                failures += report("\(tag) preview", host: host, window: window, expectScroll: .markdown, out: out, png: "editor-\(tag)-2-preview")

                // Back to the Swift tab, then to source: the toggle is per file.
                bridge.setSelectedFile(swiftFile)
                settle(0.5)
                failures += report("\(tag) swift tab", host: host, window: window, expectScroll: .sourceText, out: out, png: "editor-\(tag)-3-swift-tab")

                window.orderOut(nil)
                window.contentView = nil
            }
        }
        NativePrefs.shared.setTheme(nil)
        print("[editor] \(failures == 0 ? "ALL OK" : "\(failures) CHECK(S) FAILED"); PNGs in \(out.path)")
    }

    private enum Expect { case sourceText, markdown }

    /// Prints the title bar depth and where the editor's content starts; returns 1 when
    /// the chrome is not between them.
    @MainActor
    private static func report(_ label: String, host: NSView, window: NSWindow, expectScroll: Expect,
                               out: URL, png: String) -> Int {
        host.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        let h = window.frame.height
        let titlebar = h - window.contentLayoutRect.height
        func top(_ v: NSView) -> NSRect {
            let r = v.convert(v.bounds, to: nil)
            return NSRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height)
        }
        // The editor column is the second column of the window: right of the left pane,
        // left of the chat. Look for the first scroll view in it that is wide enough to
        // be the editor (the file tree and the chat transcript are not).
        var best: NSRect?
        func walk(_ v: NSView) {
            let name = String(describing: type(of: v))
            let isSource = v is NSScrollView && !name.contains("Hosting")
            let isMarkdown = name.contains("HostingScrollView")
            let wanted = expectScroll == .sourceText ? isSource : isMarkdown
            if wanted {
                let f = top(v)
                if f.width > 250, f.height > 200, f.minX > 150, f.minY >= titlebar - 1,
                   best == nil || f.minY < best!.minY || (expectScroll == .markdown && f.height > best!.height) {
                    if expectScroll == .sourceText || f.height > 200 { best = f }
                }
            }
            v.subviews.forEach(walk)
        }
        walk(host)
        var failed = 0
        if let best {
            // How much sits between the title bar and the editor content.
            let chrome = best.minY - titlebar
            let ok = chrome >= minimumChrome
            if !ok { failed = 1 }
            print("[editor] \(label): titlebar=\(Int(titlebar)) contentTop=\(Int(best.minY)) chrome=\(Int(chrome)) "
                  + (ok ? "OK (tab bar and header fit between the title bar and the content)"
                        : "HIDDEN (less than \(Int(minimumChrome)) pt: the tab bar or header is under the title bar)"))
        } else {
            failed = 1
            print("[editor] \(label): content view NOT FOUND (\(expectScroll == .sourceText ? "source text" : "Markdown preview"))")
        }
        if let frameView = window.contentView?.superview ?? Optional(host),
           let rep = frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds) {
            frameView.cacheDisplay(in: frameView.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: out.appendingPathComponent("\(png).png"))
        }
        return failed
    }

    @MainActor
    private static func sendKey(_ chars: String, _ flags: NSEvent.ModifierFlags, to window: NSWindow) {
        guard let event = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, characters: chars,
            charactersIgnoringModifiers: chars, isARepeat: false, keyCode: 9)
        else { return }
        _ = window.contentView?.performKeyEquivalent(with: event)
    }

    @MainActor
    private static func positionLeftPane(in root: NSView, width: CGFloat) {
        var best: NSSplitView?
        func walk(_ v: NSView) {
            if let s = v as? NSSplitView, s.isVertical, s.arrangedSubviews.count >= 2,
               s.bounds.width > (best?.bounds.width ?? 0) { best = s }
            v.subviews.forEach(walk)
        }
        walk(root)
        best?.setPosition(width, ofDividerAt: 0)
    }

    @MainActor private static func settle(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    @MainActor private static func spin(until done: () -> Bool, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done(), Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    }
}
