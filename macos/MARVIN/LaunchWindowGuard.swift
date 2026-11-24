// LaunchWindowGuard — records what the window looks like in the seconds after
// launch, and makes sure the user gets one (UX review F-01).
//
// The first launch after a quit sometimes showed no window; a second `open`
// did. The cause is not proven, so this does two cheap things:
//
//  1. LOGS, to the same file the layout-storm reports go to
//     (`~/Library/Logs/MARVIN/exceptions.log`), a line at launch and at +0.5,
//     +2 and +5 s, plus one line per window event for the first 15 s: how many
//     windows, which, visible, key, main, frame, and whether the app is active.
//     The next occurrence then explains itself.
//  2. At +2 s, if no main window is visible on a screen, brings it forward or,
//     when none exists, asks the app to reopen the way a second `open` does.
//
// The decision is `LaunchWindowCheck` (MARVINLogic, tested). This file is the
// AppKit mapping around it.

import AppKit
import Foundation
import MARVINLogic

@MainActor
final class LaunchWindowGuard {
    static let shared = LaunchWindowGuard()

    private var launchBegan = Date()
    private var observers: [NSObjectProtocol] = []
    private var began = false

    private init() {}

    /// Very first line of `applicationDidFinishLaunching`.
    func noteLaunchBegan() {
        launchBegan = Date()
        log("applicationDidFinishLaunching")
    }

    /// Once the rest of start-up (which blocks the main thread while the port is
    /// reclaimed) has run: arm the samples, the safety net and the event log.
    func begin() {
        guard !began else { return }
        began = true
        log("start-up returned")
        watchWindowEvents()
        for delay in [0.5, 2.0, 5.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.sample(act: delay == 2.0)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            self?.observers.forEach(NotificationCenter.default.removeObserver)
            self?.observers = []
        }
    }

    // MARK: - Sampling

    private func sample(act: Bool) {
        let windows = probes()
        let decision = LaunchWindowCheck.decide(windows: windows, screens: screens())
        write(label: elapsedLabel(), windows: windows, decision: decision)
        guard act else { return }
        switch decision {
        case .none:
            break
        case .bringForward(let index, let recenter):
            let candidates = NSApp.windows
            guard index < candidates.count else { return }
            let w = candidates[index]
            if recenter { w.center() }
            MainWindowFocus.order(w)
        case .reopen:
            MainWindowFocus.requestReopen()
        }
    }

    private func log(_ what: String) {
        write(label: "\(elapsedLabel()) \(what)", windows: probes(), decision: .none)
    }

    /// One stamped line (time and pid) in the shared log.
    nonisolated static func note(_ text: String) {
        ExceptionLog.appendPublic("[\(ISO8601DateFormatter().string(from: Date())) pid=\(ProcessInfo.processInfo.processIdentifier)] launch-window \(text)\n")
    }

    /// Quit timing: how long the app took to go away. A relaunch while the old
    /// process is still stopping its sidecar is handed to the dying process by
    /// LaunchServices and shows nothing (reproduced on a scratch build with a
    /// sidecar that took 2.8 s to stop), so the next occurrence needs this number.
    nonisolated static func noteQuit(began: Date, sidecarStop: TimeInterval) {
        note(String(format: "quit: finished in %.2fs (sidecar stop %.2fs)", Date().timeIntervalSince(began), sidecarStop))
    }

    private func write(label: String, windows: [WindowProbe], decision: LaunchWindowAction) {
        let line = LaunchWindowCheck.logLine(
            label: label,
            windows: windows,
            appIsActive: NSApp.isActive,
            appIsHidden: NSApp.isHidden,
            screens: screens(),
            decision: decision
        )
        ExceptionLog.appendPublic("[\(ISO8601DateFormatter().string(from: Date())) pid=\(ProcessInfo.processInfo.processIdentifier)] \(line)\n")
    }

    private func elapsedLabel() -> String {
        String(format: "launch+%.2fs", Date().timeIntervalSince(launchBegan))
    }

    private func watchWindowEvents() {
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            NSWindow.didBecomeKeyNotification, NSWindow.didBecomeMainNotification,
            NSWindow.didMiniaturizeNotification, NSWindow.willCloseNotification,
            NSWindow.didChangeOcclusionStateNotification, NSApplication.didBecomeActiveNotification,
            NSApplication.didHideNotification, NSApplication.didUnhideNotification,
        ]
        for name in names {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                MainActor.assumeIsolated {
                    let who = (note.object as? NSWindow).map { String(describing: type(of: $0)) } ?? "app"
                    self?.log("event \(note.name.rawValue) (\(who))")
                }
            })
        }
    }

    // MARK: - AppKit mapping

    private func probes() -> [WindowProbe] {
        NSApp.windows.map { w in
            WindowProbe(
                title: w.title,
                identifier: w.identifier?.rawValue,
                className: String(describing: type(of: w)),
                isVisible: w.isVisible,
                isMiniaturized: w.isMiniaturized,
                isKey: w.isKeyWindow,
                isMain: w.isMainWindow,
                isMainCandidate: MainWindowFocus.isMainCandidate(w),
                x: w.frame.origin.x, y: w.frame.origin.y,
                width: w.frame.size.width, height: w.frame.size.height
            )
        }
    }

    private func screens() -> [ScreenArea] {
        NSScreen.screens.map {
            ScreenArea(x: $0.frame.origin.x, y: $0.frame.origin.y, width: $0.frame.size.width, height: $0.frame.size.height)
        }
    }
}

/// Bringing MARVIN's main window to the front from outside a SwiftUI view:
/// the safety net above, and a click on a notification.
@MainActor
enum MainWindowFocus {
    /// The window the user would call "MARVIN": a normal, main-capable window that
    /// is not the About box or Settings.
    static func isMainCandidate(_ w: NSWindow) -> Bool {
        guard w.canBecomeMain, !(w is NSPanel) else { return false }
        let id = w.identifier?.rawValue ?? ""
        return w.title != "About MARVIN" && !id.localizedCaseInsensitiveContains("settings")
    }

    static func order(_ w: NSWindow) {
        if w.isMiniaturized { w.deminiaturize(nil) }
        NSApp.unhide(nil)
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
    }

    /// `openWindow(id: "marvin-main")`, handed over by the Window ▸ Show MARVIN
    /// menu item once SwiftUI has built it (see `ShowMainWindowButton`).
    static var openWindowAction: (() -> Void)?

    /// Bring the main window forward, or open it when there is none.
    static func bringForward() {
        if let w = NSApp.windows.first(where: { isMainCandidate($0) }) {
            order(w)
        } else {
            requestReopen()
        }
    }

    /// No main window exists: open it with the SwiftUI action, because a
    /// reopen event does not (measured: `open` and the reopen AppleEvent both
    /// left a closed `Window` scene closed). Falls back to the reopen request
    /// when the action has not been handed over yet.
    static func requestReopen() {
        NSApp.activate(ignoringOtherApps: true)
        if let open = openWindowAction {
            LaunchWindowGuard.note("opening the main window with openWindow(id:)")
            open()
            return
        }
        LaunchWindowGuard.note("openWindow action was never handed over; falling back to a reopen request")
        guard Bundle.main.bundleIdentifier != nil else { return }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, error in
            if let error {
                LaunchWindowGuard.note("reopen request failed: \(error.localizedDescription)")
            }
        }
    }
}
