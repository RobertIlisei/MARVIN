// LaunchWindowCheck — "is there a window the user can see?" after launch
// (UX review F-01).
//
// The first launch after a quit sometimes showed no window, and a second
// `open` did. The cause is not proven (see `docs/roadmap.md`), so there are two
// halves: a log line that records the window state at a few moments after
// launch, so the next occurrence explains itself, and a safety net that acts on
// this decision a couple of seconds in.
//
// Pure: the app maps its NSWindows and NSScreens to the value types below.

import Foundation

public struct ScreenArea: Equatable, Sendable {
    public let x: Double, y: Double, width: Double, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
}

public struct WindowProbe: Equatable, Sendable {
    public let title: String
    public let identifier: String?
    /// The AppKit class, so a log line can tell a SwiftUI window from a panel.
    public let className: String
    public let isVisible: Bool
    public let isMiniaturized: Bool
    /// AppKit's own key / main flags: logged, not used to decide.
    public let isKey: Bool
    public let isMain: Bool
    /// The caller's call on whether this is a window the user would call "MARVIN"
    /// (not the About box, a panel, a status-item window or Settings).
    public let isMainCandidate: Bool
    public let x: Double, y: Double, width: Double, height: Double

    public init(title: String, identifier: String?, className: String = "", isVisible: Bool, isMiniaturized: Bool,
                isKey: Bool = false, isMain: Bool = false, isMainCandidate: Bool, x: Double, y: Double, width: Double, height: Double) {
        self.title = title; self.identifier = identifier; self.className = className
        self.isVisible = isVisible; self.isMiniaturized = isMiniaturized
        self.isKey = isKey; self.isMain = isMain
        self.isMainCandidate = isMainCandidate
        self.x = x; self.y = y; self.width = width; self.height = height
    }
}

public enum LaunchWindowAction: Equatable, Sendable {
    /// A main window is visible on a screen.
    case none
    /// A main window exists but is hidden, minimised or off every screen: order it front
    /// (and put it back on a screen when `recenter`).
    case bringForward(index: Int, recenter: Bool)
    /// No main window exists: ask the app to reopen, which is what a second `open` does.
    case reopen
}

public enum LaunchWindowCheck {
    public static func decide(windows: [WindowProbe], screens: [ScreenArea]) -> LaunchWindowAction {
        let mains = windows.enumerated().filter { $0.element.isMainCandidate }
        if mains.isEmpty { return .reopen }
        // With no screen information a window cannot be called off-screen.
        func onScreen(_ w: WindowProbe) -> Bool {
            screens.isEmpty || screens.contains { intersects(w, $0) }
        }
        if mains.contains(where: { $0.element.isVisible && !$0.element.isMiniaturized && onScreen($0.element) }) {
            return .none
        }
        // Prefer the one that is merely hidden; a window off every screen is the last resort.
        let target = mains.first(where: { onScreen($0.element) }) ?? mains[0]
        return .bringForward(index: target.offset, recenter: !onScreen(target.element))
    }

    private static func intersects(_ w: WindowProbe, _ s: ScreenArea) -> Bool {
        let overlapX = min(w.x + w.width, s.x + s.width) - max(w.x, s.x)
        let overlapY = min(w.y + w.height, s.y + s.height) - max(w.y, s.y)
        return overlapX > 0 && overlapY > 0
    }

    /// One line for `exceptions.log`: everything the next occurrence needs.
    public static func logLine(
        label: String,
        windows: [WindowProbe],
        appIsActive: Bool,
        appIsHidden: Bool,
        screens: [ScreenArea],
        decision: LaunchWindowAction
    ) -> String {
        func n(_ v: Double) -> String { String(Int(v.rounded())) }
        let wins = windows.enumerated().map { i, w in
            "[\(i)] \(w.className) title=\"\(w.title)\" id=\(w.identifier ?? "-") visible=\(w.isVisible) mini=\(w.isMiniaturized) key=\(w.isKey) main=\(w.isMain) "
                + "candidate=\(w.isMainCandidate) frame=\(n(w.x)),\(n(w.y)),\(n(w.width))x\(n(w.height))"
        }.joined(separator: " ")
        let scr = screens.map { "\(n($0.x)),\(n($0.y)),\(n($0.width))x\(n($0.height))" }.joined(separator: ";")
        let d: String
        switch decision {
        case .none: d = "none"
        case .reopen: d = "reopen"
        case .bringForward(let i, let r): d = "bringForward(index=\(i),recenter=\(r))"
        }
        return "launch-window \(label): windows=\(windows.count) active=\(appIsActive) hidden=\(appIsHidden) "
            + "screens=\(scr.isEmpty ? "-" : scr) decision=\(d) \(wins)"
    }
}
