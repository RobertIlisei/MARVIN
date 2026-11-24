// SurfaceSnapshotWorkArea — dev-only probe of the REAL main window's work-area
// layout (W-11 / R2-13). Inert unless `MARVIN_SNAPSHOT_VIEW=window-work-area`
// and `MARVIN_SNAPSHOT_OUT=<dir>` are set; see SurfaceSnapshot.swift for the
// rules every snapshot run follows (a free `MARVIN_PORT`, never 3030).
//
// Why it exists: layout bugs in this app have been misdiagnosed from source four
// times (AGENTS.md "Measure before theorising"), and this change moves where the
// chat column sits. So the real `ContentView` is hosted in an offscreen window
// against the stand-in sidecar, driven through the states that decide the layout
// (a file opened and closed, the bottom panel toggled, the preview toggled),
// several times over, at a wide and a narrow window. For each state it prints
// the frames of the main split's columns and how many split-view resize
// notifications the change produced; a layout that converges produces a handful,
// a loop produces hundreds. The ADR-0062 storm monitor and breaker are armed in
// this process (hooks install before snapshots run) and mirror to stderr, so a
// run's stderr is the per-process record of any storm.
//
// Geometry is read from NSView frames and `NSSplitView` notifications, never from
// a `GeometryReader` background (AGENTS.md).

import AppKit
import MARVINLogic
import SwiftUI

enum WorkAreaSnapshot {
    @MainActor
    static func run(out: URL) {
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

        let sidecar = FixtureSidecar(port: ServerConfig.port) { method, path, query in
            SurfaceRoutes.handle(method: method, path: path, query: query)
        }
        guard sidecar?.start() == true else {
            print("[work-area] could not bind the stand-in sidecar on \(ServerConfig.port); use a free MARVIN_PORT")
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
        print("[work-area] health=\(health.state)")
        UpdateService.shared.stop()

        let counter = ResizeCounter()
        for (w, h) in [(2560, 1400), (1100, 800)] as [(CGFloat, CGFloat)] {
            let root = ContentView().environment(health).environment(bridge)
            let host = NSHostingView(rootView: root)
            host.sizingOptions = []
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: w, height: h),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.toolbar = NSToolbar(identifier: "snapshot.work-area")
            window.toolbarStyle = .unified
            window.contentView = host
            window.setFrame(NSRect(x: -12_000, y: -12_000, width: w, height: h), display: true)
            window.orderFront(nil)
            settle(1.8)
            // A fresh run has no saved divider, so the split starts 50/50. A real
            // window restores the user's left-pane width; put it there.
            positionLeftPane(in: host, width: w > 1500 ? 330 : 260)
            settle(0.6)
            let tag = "w\(Int(w))"
            report(tag + " start (no file)", host: host, counter: counter, out: out, png: "\(tag)-1-no-file", window: window)

            let file = "\(SurfaceFixtures.project)/\(SurfaceFixtures.openFiles[0])"
            for cycle in 1...6 {
                counter.reset()
                bridge.setSelectedFile(file)
                settle(0.5)
                report("\(tag) cycle \(cycle) file open", host: host, counter: counter, out: out,
                       png: cycle == 1 ? "\(tag)-2-file-open" : nil, window: window)
                counter.reset()
                bridge.closeFile(file)
                settle(0.5)
                report("\(tag) cycle \(cycle) file closed", host: host, counter: counter, out: out,
                       png: cycle == 1 ? "\(tag)-3-file-closed" : nil, window: window)
            }

            // The other surfaces that need the editor column.
            counter.reset()
            NativePrefs.shared.toggleBottomPanel()
            settle(0.6)
            report("\(tag) bottom panel open", host: host, counter: counter, out: out, png: "\(tag)-4-panel", window: window)
            counter.reset()
            NativePrefs.shared.toggleBottomPanel()
            settle(0.6)
            report("\(tag) bottom panel closed", host: host, counter: counter, out: out, png: nil, window: window)

            // The inspector covers the chat only while the supervisor is enabled.
            let decoded = SupervisorStatus(
                revision: 1, mode: "shadow", run: "idle",
                budget: .init(capUsd: 20, spentUsd: 1, level: "ok"))
            SupervisorModel.shared.status = decoded
            counter.reset()
            SupervisorModel.shared.openWorkspace()
            settle(0.6)
            report("\(tag) supervisor workspace open", host: host, counter: counter, out: out, png: "\(tag)-5-workspace", window: window)
            counter.reset()
            SupervisorModel.shared.closeWorkspace()
            settle(0.6)
            SupervisorModel.shared.status = nil
            report("\(tag) supervisor workspace closed", host: host, counter: counter, out: out, png: nil, window: window)

            window.orderOut(nil)
            window.contentView = nil
        }
        let key = "NSSplitView Subview Frames marvin.main.v2"
        print("[work-area] persisted split frames after the run: \(String(describing: UserDefaults.standard.object(forKey: key)))")
        print("[work-area] done; PNGs in \(out.path)")
    }

    // MARK: - Measuring

    /// Counts `NSSplitView` resize notifications between `reset()` calls.
    @MainActor
    private final class ResizeCounter {
        private(set) var n = 0
        private var token: NSObjectProtocol?
        init() {
            token = NotificationCenter.default.addObserver(
                forName: NSSplitView.didResizeSubviewsNotification, object: nil, queue: .main
            ) { [weak self] _ in MainActor.assumeIsolated { self?.n += 1 } }
        }
        func reset() { n = 0 }
    }

    @MainActor
    private static func report(_ label: String, host: NSView, counter: ResizeCounter, out: URL,
                               png: String?, window: NSWindow) {
        host.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        let cols = mainSplitColumns(in: host)
            .map { "\(Int($0.minX))..\(Int($0.maxX)) (w=\(Int($0.width)))" }
            .joined(separator: " | ")
        print("[work-area] \(label): columns \(cols.isEmpty ? "NOT FOUND" : cols); split resizes=\(counter.n)")
        if let png, let frameView = window.contentView?.superview ?? Optional(host),
           let rep = frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds) {
            frameView.cacheDisplay(in: frameView.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: out.appendingPathComponent("\(png).png"))
        }
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

    /// The window's main horizontal split: the one with the most arranged
    /// subviews wider than a rail. Frames are in the split's own coordinates.
    @MainActor
    private static func mainSplitColumns(in root: NSView) -> [NSRect] {
        var best: NSSplitView?
        func walk(_ v: NSView) {
            if let s = v as? NSSplitView, s.isVertical, s.arrangedSubviews.count >= 2,
               s.bounds.width > (best?.bounds.width ?? 0) { best = s }
            v.subviews.forEach(walk)
        }
        walk(root)
        return best?.arrangedSubviews.map(\.frame) ?? []
    }

    // MARK: - Run loop

    @MainActor private static func settle(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    @MainActor private static func spin(until done: () -> Bool, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done(), Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    }
}
