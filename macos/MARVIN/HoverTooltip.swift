// HoverTooltip — MARVIN's own tooltip window, because AppKit's is too slow
// and its delay is not settable.
//
// ## Why not `NSView.toolTip`
//
// AppKit holds a tooltip for ~1.5-2s before the FIRST one appears; after that
// it enters a "session" where moving to another tooltip-bearing view shows the
// next one almost instantly. That is exactly what the user described twice
// (2026-08-29): "still taking 1-2 seconds and after that it works better, like
// almost instant". On a VS Code-style icon rail the first hover is the one
// that matters — by the time the name appears you have already clicked.
//
// The delay is read from an `NSInitialToolTipDelay` default, but there is no
// public API to set it and no supported domain that reliably wins:
// registering it in MARVIN's registration domain was tried first and did NOT
// change the first-hover delay. `NSToolTipManager` is private. So the tooltip
// is ours.
//
// ## What this reproduces from AppKit, deliberately
//
//   * the session feel the user liked — the first tooltip waits `initialDelay`,
//     but one shown within `sessionWindow` of the last dismissal appears at
//     once, so sweeping down the rail doesn't stutter;
//   * screen-edge clamping, so a tooltip near the bottom of the display isn't
//     drawn half off it.
//
// It is a single shared panel, never key and never activating, that ignores
// mouse events — so it cannot steal focus from the window, and it cannot sit
// between the cursor and the thing being hovered.

import AppKit

@MainActor
final class HoverTooltip {
    static let shared = HoverTooltip()

    /// Wait before the first tooltip of a session. AppKit's is ~1.5-2s; VS
    /// Code's rail is nearer 300ms, which is what this is matched to.
    private static let initialDelay: TimeInterval = 0.3
    /// Dismiss-to-show gap within which the next tooltip is instant.
    private static let sessionWindow: TimeInterval = 1.2

    private var panel: NSPanel?
    private var label: NSTextField?
    private var pending: DispatchWorkItem?
    private var lastDismissed: Date = .distantPast

    private init() {}

    /// Schedule `text` to appear next to `view`. Cancels any pending or
    /// visible tooltip first, so a fast sweep across the rail shows one
    /// tooltip, not a trail of them.
    func show(_ text: String, for view: NSView) {
        cancel()
        guard !text.isEmpty else { return }
        let instant = Date().timeIntervalSince(lastDismissed) < Self.sessionWindow
        let work = DispatchWorkItem { [weak view] in
            guard let view, view.window != nil else { return }
            self.present(text, for: view)
        }
        pending = work
        if instant {
            work.perform()
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.initialDelay, execute: work)
        }
    }

    /// Cancel a pending tooltip and hide a visible one. Safe to call when
    /// nothing is showing — `mouseExited` fires more often than `mouseEntered`
    /// during a drag.
    func cancel() {
        pending?.cancel()
        pending = nil
        if let panel, panel.isVisible {
            panel.orderOut(nil)
            lastDismissed = Date()
        }
    }

    private func present(_ text: String, for view: NSView) {
        guard let window = view.window else { return }
        let (panel, label) = ensurePanel()
        label.stringValue = text

        // Size to the text, then place to the RIGHT of the hovered view and
        // vertically centred on it — VS Code's rail convention.
        let size = label.intrinsicContentSize
        let width = ceil(size.width) + 16
        let height = ceil(size.height) + 10
        let inWindow = view.convert(view.bounds, to: nil)
        let onScreen = window.convertToScreen(inWindow)
        var origin = NSPoint(
            x: onScreen.maxX + 8,
            y: onScreen.midY - height / 2
        )

        // Clamp to the display the view is actually on. Without this a rail
        // icon near the bottom of the screen draws its tooltip half off it.
        if let visible = (window.screen ?? NSScreen.main)?.visibleFrame {
            origin.x = min(origin.x, visible.maxX - width - 4)
            origin.x = max(origin.x, visible.minX + 4)
            origin.y = min(origin.y, visible.maxY - height - 4)
            origin.y = max(origin.y, visible.minY + 4)
        }

        panel.setFrame(NSRect(origin: origin, size: NSSize(width: width, height: height)),
                       display: false)
        // `orderFront`, never `makeKey` — the panel must not take focus, or
        // hovering the rail would deactivate the text field you were typing in.
        panel.orderFront(nil)
    }

    private func ensurePanel() -> (NSPanel, NSTextField) {
        if let panel, let label { return (panel, label) }

        let field = NSTextField(labelWithString: "")
        field.font = .systemFont(ofSize: 12)
        field.textColor = MarvinTheme.textPrimaryNSColor
        field.backgroundColor = .clear
        field.isBezeled = false
        field.isEditable = false
        field.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.wantsLayer = true
        content.layer?.backgroundColor = MarvinTheme.elevatedNSColor.cgColor
        content.layer?.borderColor = MarvinTheme.borderNSColor.cgColor
        content.layer?.borderWidth = 1
        content.layer?.cornerRadius = 5
        content.addSubview(field)
        NSLayoutConstraint.activate([
            field.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            field.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])

        let p = NSPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        p.contentView = content
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.level = .floating
        p.ignoresMouseEvents = true
        p.hidesOnDeactivate = true
        p.collectionBehavior = [.transient, .ignoresCycle]
        p.animationBehavior = .none

        panel = p
        label = field
        return (p, field)
    }
}
