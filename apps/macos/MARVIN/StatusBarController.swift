// Phase 1d.19 — menu-bar status item.
//
// Adds an `NSStatusItem` to the macOS system menu bar that surfaces
// MARVIN at-a-glance from anywhere in the OS:
//
//   • Click → brings the MARVIN window forward (or re-opens it if
//     the user closed it but the app is still running).
//   • Tooltip → "MARVIN" + the current cost-today snapshot from the
//     bridge, so the user can glance at spend without switching to
//     the app.
//   • Icon → the Brain Circuit template SVG from the design bundle
//     (`marvin-idle.svg`). Set as a template image so macOS tints it
//     correctly in light + dark menu bars.
//
// The "active" variant (`marvin-active.svg`, filled nodes) is staged
// for a follow-up that wires a bridge "busy" signal — currently we
// only have a static idle. Switching is one image swap when the
// signal lands; nothing else needs to change here.
//
// ## Why a status item at all
//
// Two daily-use observations from Phase 1a:
//   1. Users alt-tab to MARVIN often enough that a Dock click feels
//      heavy. A menu-bar item is one click from anywhere.
//   2. The Tauri build had no surface outside its own window. Going
//      native gives us cheap access to NSStatusBar, and the design
//      bundle ships the assets — declining to ship them would leave
//      a delivered design half-implemented.
//
// ## Lifecycle
//
// The status item lives on the app delegate (`AppDelegate`) so its
// lifetime tracks NSApplication, not any single SwiftUI scene. If we
// ever go multi-window we don't want one status item per window. The
// delegate is bridged into SwiftUI via `NSApplicationDelegateAdaptor`
// in `MARVINApp.swift` — the only Swift-style entry point for app-
// scope AppKit state in a SwiftUI app.

import AppKit
import SwiftUI

@MainActor
final class StatusBarController {
    /// The retained status item. NSStatusBar.system holds a weak
    /// reference; if we drop our copy the item disappears.
    private var item: NSStatusItem?

    /// Cached idle / active images so we're not re-loading on every
    /// state flip. Resolved from the bundle Resources at install time
    /// so we fail fast if the SVGs are missing.
    private var idleImage: NSImage?
    private var activeImage: NSImage?

    func install() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        self.item = item

        // The button is the click target. We set the image + action
        // here; the `target` is `self` because the click handler is
        // an instance method, not a closure.
        //
        // sendAction(on:) tells AppKit to fire our handler on BOTH
        // left- and right-mouse-down. The handler then routes to
        // either "focus the window" (left) or "show the context
        // menu" (right) based on the current event. NSStatusItem's
        // `menu` property only fires on left-click, which is the
        // wrong default for an app where left-click should bring
        // the window forward (Things 3 / Slack / 1Password pattern).
        let button = item.button
        button?.target = self
        button?.action = #selector(handleClick(_:))
        button?.sendAction(on: [.leftMouseDown, .rightMouseDown])
        button?.toolTip = "MARVIN"

        // Resolve the idle image. NSImage(named:) walks the main
        // bundle Resources — that's where bin/marvin's SPM-fallback
        // path drops marvin-idle.svg + marvin-active.svg.
        if let idle = loadTemplateImage(named: "marvin-idle") {
            idleImage = idle
            button?.image = idle
        } else {
            // Fallback so the item is still discoverable even if the
            // SVG didn't make it into the bundle (shouldn't happen,
            // but a missing icon shouldn't hide the surface).
            button?.title = "M"
        }
        if let active = loadTemplateImage(named: "marvin-active") {
            activeImage = active
        }

        // Refresh the tooltip + busy-state icon on a 1s tick. Lower
        // than the cost-only refresh used to be (5s) because the
        // busy flag flips frequently inside a turn — a 5s lag would
        // mean the active icon shows up half a turn late.
        //
        // We poll @Observable rather than wiring full Observation
        // tracking because the surface is throwaway. Reads are O(1).
        Task { @MainActor in
            for await _ in bridgeTick(seconds: 1.0) {
                let bridge = MarvinBridge.shared
                let today = bridge.costSummary.map { String(format: "$%.2f today", $0.today) } ?? ""
                let project = bridge.projectName.map { " · \($0)" } ?? ""
                button?.toolTip = "MARVIN" + (today.isEmpty ? "" : " — \(today)") + project
                setActive(bridge.isBusy)
            }
        }
    }

    /// Swap the menu-bar icon between idle (outlined nodes) and
    /// active (filled nodes). Wired from a future bridge "busy"
    /// signal — a no-op when the active image didn't load.
    func setActive(_ active: Bool) {
        guard let button = item?.button else { return }
        if active, let img = activeImage {
            button.image = img
        } else if let img = idleImage {
            button.image = img
        }
    }

    /// Click handler — routes to "focus the window" on left-click,
    /// "show context menu" on right-click. Control-click counts as
    /// right-click on macOS.
    @objc private func handleClick(_ sender: Any?) {
        let event = NSApp.currentEvent
        let isRightClick = event?.type == .rightMouseDown
            || (event?.modifierFlags.contains(.control) ?? false)

        if isRightClick {
            showContextMenu()
        } else {
            focusMainWindow()
        }
    }

    /// Bring the main window forward, re-creating it if the user
    /// previously closed all windows. We can't use SwiftUI's
    /// `openWindow(id:)` here because we're outside a View scope;
    /// NSApp.activate + windows lookup is the AppKit-native
    /// equivalent and works whether the window is hidden,
    /// miniaturised, or never opened.
    private func focusMainWindow() {
        // Foreground the app so we steal focus. `.activateIgnoringOtherApps`
        // is what menu-bar utilities like 1Password / Things use.
        NSApp.activate(ignoringOtherApps: true)

        // Find an existing main window and bring it forward. We
        // identify it by the SwiftUI scene id ("marvin-main") — but
        // NSWindow doesn't expose that directly, so we fall back to
        // "first non-About window" which is reliably the main one.
        let aboutTitle = "About MARVIN"
        if let mainWindow = NSApp.windows.first(where: { window in
            window.isVisible && window.title != aboutTitle
        }) ?? NSApp.windows.first(where: { $0.title != aboutTitle }) {
            mainWindow.deminiaturize(nil)
            mainWindow.makeKeyAndOrderFront(nil)
        } else {
            // No window exists at all — the user closed it. Ask the
            // app to re-create one via the standard reopen entry
            // point. SwiftUI's Window scene re-opens on this signal.
            NSApp.sendAction(
                #selector(NSApplication.unhide(_:)),
                to: nil,
                from: nil
            )
        }
    }

    /// Build + display the right-click menu. Built fresh on every
    /// invocation so menu items can reflect live bridge state (e.g.
    /// disabling "Show MARVIN" if the window is already key) without
    /// needing to plumb update notifications.
    private func showContextMenu() {
        let menu = NSMenu()
        menu.addItem(menuItem(
            title: "Show MARVIN",
            keyEquivalent: "",
            action: #selector(menuShowMARVIN)
        ))
        menu.addItem(menuItem(
            title: "About MARVIN",
            keyEquivalent: "",
            action: #selector(menuAbout)
        ))
        menu.addItem(menuItem(
            title: "Settings…",
            keyEquivalent: ",",
            action: #selector(menuSettings)
        ))
        menu.addItem(.separator())
        menu.addItem(menuItem(
            title: "Quit MARVIN",
            keyEquivalent: "q",
            action: #selector(menuQuit)
        ))

        // popUpMenu(_:) is the AppKit-supported way to show a menu
        // from an NSStatusItem button without permanently binding it
        // to the item (which would suppress our left-click handler).
        item?.menu = menu
        item?.button?.performClick(nil)
        // Detach immediately after so the next left-click goes back
        // to focusMainWindow. AppKit dispatches the menu before this
        // line runs because performClick is synchronous on the menu
        // present — we're safe to nil it out here.
        item?.menu = nil
    }

    private func menuItem(
        title: String,
        keyEquivalent: String,
        action: Selector
    ) -> NSMenuItem {
        let mi = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
        mi.target = self
        return mi
    }

    @objc private func menuShowMARVIN() {
        focusMainWindow()
    }

    @objc private func menuAbout() {
        NSApp.activate(ignoringOtherApps: true)
        // SwiftUI's About-replacement menu item lives in the App
        // menu — sending the same selector AppKit uses for "App →
        // About <appname>" routes through our CommandGroup
        // override and opens the marvin-about scene.
        NSApp.sendAction(#selector(NSApplication.orderFrontStandardAboutPanel(_:)), to: nil, from: nil)
    }

    @objc private func menuSettings() {
        NSApp.activate(ignoringOtherApps: true)
        // SwiftUI's `Settings { }` scene installs a Settings… item
        // in the App menu and binds ⌘, to it. We replicate that
        // here. The selector name has shifted across macOS versions
        // ("showSettingsWindow:" on macOS 14+, "showPreferencesWindow:"
        // before); send both so the right one wins.
        if !NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil) {
            NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
        }
    }

    @objc private func menuQuit() {
        NSApp.terminate(nil)
    }

    /// Load a template SVG from the bundle. Setting `isTemplate = true`
    /// tells macOS to ignore the SVG's stroke colour and render it
    /// using the menu bar's current foreground colour — black on
    /// light, white on dark. This is the convention every native
    /// menu-bar utility follows.
    ///
    /// We resolve the URL explicitly via Bundle.url instead of
    /// NSImage(named:) because NSImage's name-based lookup walks
    /// asset catalogs first; loose .svg files in Resources/ aren't
    /// always found that way (the lookup depends on what build path
    /// produced the bundle — Xcode vs the SPM-fallback assembler in
    /// bin/marvin). An explicit URL load works in both cases.
    private func loadTemplateImage(named name: String) -> NSImage? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "svg"),
              let img = NSImage(contentsOf: url) else {
            return nil
        }
        // 18×18 is the standard menu-bar icon size on macOS — fits
        // the bar comfortably without crowding the clock.
        img.size = NSSize(width: 18, height: 18)
        img.isTemplate = true
        return img
    }

    /// Plain timer stream — yields a tick every `seconds`, plus an
    /// immediate first tick so the consumer doesn't wait for the
    /// first poll cycle before refreshing. Used to drive the
    /// tooltip + busy-state icon refresh without wiring full
    /// Observation tracking on @Observable bridge fields (the
    /// surface is throwaway, polling is O(1)).
    private func bridgeTick(seconds: TimeInterval) -> AsyncStream<Void> {
        AsyncStream { continuation in
            continuation.yield(())
            let nanos = UInt64(seconds * 1_000_000_000)
            let task = Task { @MainActor in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: nanos)
                    continuation.yield(())
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
