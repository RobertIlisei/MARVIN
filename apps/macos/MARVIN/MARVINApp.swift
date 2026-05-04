// Phase 1a/b/c entry point — see docs/decisions/0016-swift-migration.md.
//
// The app boots a single window, polls the Node sidecar at
// http://localhost:3030/api/health, and renders one of three states
// in the content view: connecting / online (full-bleed WKWebView
// pointed at localhost:3030) / offline (with concrete instructions
// for starting the sidecar). Phase 1d (NSToolbar) and Phase 2+ are
// gated on the daily-use evaluation — see PHASE-1A-OBSERVATIONS.md.
//
// Architecture note: the sidecar is the trust boundary. The Swift
// process never reads Anthropic credentials, never spawns the
// Claude CLI, never persists session transcripts. The `.app` is
// just a window onto an already-running Node server.

import AppKit
import SwiftUI

/// Wraps an action that opens a SwiftUI window by id. `@Environment`
/// is reliable inside Views but can be nil-at-runtime when read
/// directly on an `App` — pulling it through a small View bridges
/// it into a `.commands` closure safely.
private struct OpenAboutButton: View {
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Button("About MARVIN") {
            openWindow(id: "marvin-about")
        }
    }
}

/// Reveal a directory in Finder, with the directory itself
/// selected (not its contents shown). `activateFileViewerSelecting`
/// is the AppKit idiom — same as Finder's "Reveal in Finder" entry.
/// No-op when workDir is nil or the path doesn't resolve.
@MainActor
private func revealProjectInFinder(workDir: String?) {
    guard let workDir, !workDir.isEmpty else { return }
    let url = URL(fileURLWithPath: workDir)
    NSWorkspace.shared.activateFileViewerSelecting([url])
}

/// Open Terminal.app with the working directory cd'd to workDir.
/// We hand Terminal the directory path directly via NSWorkspace —
/// `open -a Terminal /some/path` is the AppKit-equivalent of what
/// the Finder context menu's "New Terminal at Folder" does, and
/// crucially DOESN'T require Apple Events / Automation permission
/// (which AppleScript would prompt for on first use).
@MainActor
private func openTerminalAt(workDir: String?) {
    guard let workDir, !workDir.isEmpty else { return }
    let dirURL = URL(fileURLWithPath: workDir)
    let terminalURL = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
    let config = NSWorkspace.OpenConfiguration()
    NSWorkspace.shared.open(
        [dirURL],
        withApplicationAt: terminalURL,
        configuration: config
    ) { _, error in
        if let error {
            NSLog("[openTerminalAt] failed to launch Terminal: \(error)")
        }
    }
}

/// SwiftUI lifecycle hook for app-scope AppKit state. We use this
/// only for things that genuinely don't fit in a SwiftUI scene —
/// currently the menu-bar `NSStatusItem` (Phase 1d.19), which has
/// to live on the global `NSStatusBar` and outlive any window.
///
/// Marked `@MainActor` because the `NSApplicationDelegate` callbacks
/// already run on the main thread, and our state
/// (`StatusBarController`) is itself main-actor-isolated. Without
/// the annotation, Swift 6 complains about calling
/// `StatusBarController()` from a "nonisolated" init context.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusBar = StatusBarController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Install the status item once on launch. The controller
        // retains the NSStatusItem itself; we just hold the
        // controller so it doesn't deallocate.
        statusBar.install()
    }

    /// Phase 1d.28 — guard ⌘Q when MARVIN is mid-turn.
    ///
    /// Without this, an accidental ⌘Q during streaming kills the
    /// WebView and the in-flight Claude CLI request together —
    /// silently, with no chance to confirm. The confirmation is
    /// the same modal pattern Mail / Messages show when there's
    /// unsent draft state. We only prompt when the bridge reports
    /// busy; idle quits proceed normally with no friction.
    ///
    /// Returns:
    ///   • .terminateNow when idle or the user chose Quit.
    ///   • .terminateCancel when the user chose Cancel.
    func applicationShouldTerminate(
        _ sender: NSApplication
    ) -> NSApplication.TerminateReply {
        guard MarvinBridge.shared.isBusy else { return .terminateNow }

        let alert = NSAlert()
        alert.messageText = "MARVIN is still working."
        alert.informativeText = "Quitting now will cancel the current turn. Continue?"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        alert.buttons.first?.hasDestructiveAction = true

        // .alertFirstButtonReturn = Quit; default Esc maps to the
        // second button (Cancel) which is the safe choice.
        let response = alert.runModal()
        return response == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }
}

@main
struct MARVINApp: App {
    /// Bridge AppKit-only app-scope state (menu-bar item) into
    /// SwiftUI's lifecycle. Nothing else uses the delegate today.
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    /// Health monitor lives at app scope so the connection state
    /// survives window opens/closes (Phase 1+ may add multi-window).
    @State private var health = HealthMonitor()

    /// JS↔Swift bridge — singleton, but threaded through the
    /// environment so SwiftUI observation tracks `webTitle` and
    /// future @Observable fields (project, cost, etc. as the
    /// migration phases land).
    private let bridge = MarvinBridge.shared

    /// WebView command bridge — singleton, threaded through the
    /// environment so SwiftUI observation tracks load progress
    /// (Phase 1d.10).
    private let webCommands = WebViewCommands.shared

    var body: some Scene {
        Window("MARVIN", id: "marvin-main") {
            ContentView()
                .environment(health)
                .environment(bridge)
                .environment(webCommands)
                // 1440×900 default + 960×600 floor — matches the
                // existing Tauri config (tauri.conf.json) so users
                // don't see a different window geometry across the
                // two builds during the migration. Phase 1c adds
                // `frameAutosaveName`, so subsequent launches restore
                // the user's last frame in preference to ideal*.
                .frame(
                    minWidth: 960,
                    idealWidth: 1440,
                    minHeight: 600,
                    idealHeight: 900
                )
                .task {
                    // Start polling on launch; the monitor self-stops
                    // when the window closes (Phase 1a only has one).
                    await health.start()
                }
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .commands {
            // Phase 1b — native menu bar.
            //
            // Standard macOS menus (App / Edit / Window) are
            // provided by SwiftUI for free. We extend the App menu
            // (custom About), View, and Help with MARVIN-specific
            // items.
            //
            // Deliberately NOT claimed by SwiftUI here: ⌘K, ⌘B/G/J/P,
            // ⌘⇧N, ⌘., `?`. Those are the web-app's keyboard
            // shortcuts, handled by React inside the WebView. If a
            // SwiftUI menu item assigned `keyboardShortcut("k", ...)`
            // it would intercept ⌘K and the web side would never
            // hear it. Phase 1d (NSToolbar + bridge) replaces the
            // web-rendered top bar properly; until then, the web
            // shortcuts pass through untouched.

            // App → About MARVIN. Replaces SwiftUI's default
            // generated About panel (which only shows version +
            // copyright) with our custom AboutView that surfaces
            // live sidecar status — useful during the migration
            // evaluation to confirm which build is running and what
            // the sidecar reports.
            CommandGroup(replacing: .appInfo) {
                OpenAboutButton()
            }

            // View → Reload (⌘R) / Force Reload (⇧⌘R).
            //
            // Reload uses the cache; Force Reload bypasses it
            // (`reloadFromOrigin()`) — useful after a sidecar rebuild
            // when the page is showing stale Next.js assets. Both
            // are guarded by health.state — Reload makes no sense
            // when the WebView isn't even mounted.
            CommandGroup(after: .toolbar) {
                Divider()
                Button("Reload") {
                    if health.state.isOnline {
                        WebViewCommands.shared.reload()
                    } else {
                        // When offline, ⌘R kicks the health probe —
                        // matches the explicit "Reconnect" button in
                        // the offline view.
                        Task { await health.refreshNow() }
                    }
                }
                .keyboardShortcut("r", modifiers: [.command])

                Button("Force Reload") {
                    if health.state.isOnline {
                        WebViewCommands.shared.forceReload()
                    } else {
                        Task { await health.refreshNow() }
                    }
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])

                // Phase 1d.11 — page zoom controls. Standard macOS
                // shortcuts: ⌘0 reset, ⌘= zoom in (macOS displays
                // as ⌘+ since the same key is shifted), ⌘- zoom
                // out. Persisted to UserDefaults so the size
                // survives launches. Disabled offline because the
                // WebView isn't mounted then.
                Divider()
                Button("Actual Size") {
                    WebViewCommands.shared.resetZoom()
                }
                .keyboardShortcut("0", modifiers: [.command])
                .disabled(!health.state.isOnline)
                Button("Zoom In") {
                    WebViewCommands.shared.zoomIn()
                }
                .keyboardShortcut("=", modifiers: [.command])
                .disabled(!health.state.isOnline)
                Button("Zoom Out") {
                    WebViewCommands.shared.zoomOut()
                }
                .keyboardShortcut("-", modifiers: [.command])
                .disabled(!health.state.isOnline)
            }

            // Phase 1d.12 — Find in page. Conventionally lives in
            // the Edit menu; placed after .textEditing so the
            // standard Find / Find Next / Find Previous slot is
            // taken by ours. Disabled offline (no WebView mounted).
            CommandGroup(after: .textEditing) {
                Divider()
                Button("Find…") {
                    WebViewCommands.shared.showFind()
                }
                .keyboardShortcut("f", modifiers: [.command])
                .disabled(!health.state.isOnline)
                Button("Find Next") {
                    WebViewCommands.shared.findNext()
                }
                .keyboardShortcut("g", modifiers: [.command])
                .disabled(!health.state.isOnline)
                Button("Find Previous") {
                    WebViewCommands.shared.findPrevious()
                }
                .keyboardShortcut("g", modifiers: [.command, .shift])
                .disabled(!health.state.isOnline)
            }

            // Phase 1d.25 — File → New Session (⌘⇧N) replaces
            // SwiftUI's default "New" item which would otherwise be
            // a no-op (we have no document model). Bridges into the
            // web app's existing reset() handler via a dispatched
            // CustomEvent — no need to duplicate React state into
            // Swift just to trigger a reset.
            CommandGroup(replacing: .newItem) {
                Button("New Session") {
                    WebViewCommands.shared.dispatchWebCommand("new-session")
                }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(!health.state.isOnline)
            }

            // Phase 1d.23 — File menu items that act on the active
            // project's workDir. Both depend on the bridge —
            // disabled when no project is selected — and are net-
            // additive native affordances expected of any project-
            // oriented Mac app. SwiftUI's default "File" menu has
            // .newItem / .undoRedo / .pasteboard groups; .saveItem
            // is the conventional slot for project-state actions.
            CommandGroup(after: .saveItem) {
                Divider()

                // Phase 1d.25 — bridges to the web app's project
                // picker. The web button in the top bar still works;
                // this just makes the action discoverable from the
                // menu bar (and via ⌘O, the macOS-conventional
                // shortcut for "open").
                Button("Open Project…") {
                    WebViewCommands.shared.dispatchWebCommand("open-project-picker")
                }
                .keyboardShortcut("o", modifiers: [.command])
                .disabled(!health.state.isOnline)

                Divider()

                Button("Reveal Project in Finder") {
                    revealProjectInFinder(workDir: bridge.projectWorkDir)
                }
                .keyboardShortcut("r", modifiers: [.command, .option])
                .disabled(bridge.projectWorkDir == nil)

                Button("Open Terminal Here") {
                    openTerminalAt(workDir: bridge.projectWorkDir)
                }
                .keyboardShortcut("t", modifiers: [.command, .option])
                .disabled(bridge.projectWorkDir == nil)
            }

            // Phase 1d.25 — Window menu shortcuts that bridge to web
            // app dialogs (theme toggle, keyboard shortcuts panel).
            // Both already work via web hotkeys (⌘⇧T isn't claimed
            // anywhere; `?` opens shortcuts), but the menu bar makes
            // them discoverable for users who don't know the web
            // hotkey set yet. .windowList is the conventional slot
            // for "show me UI surfaces" actions.
            CommandGroup(after: .windowList) {
                Divider()
                Button("Toggle Theme") {
                    WebViewCommands.shared.dispatchWebCommand("toggle-theme")
                }
                .keyboardShortcut("t", modifiers: [.command, .shift])
                .disabled(!health.state.isOnline)

                Button("Keyboard Shortcuts…") {
                    WebViewCommands.shared.dispatchWebCommand("show-shortcuts")
                }
                .keyboardShortcut("/", modifiers: [.command])
                .disabled(!health.state.isOnline)
            }

            // Help menu — quick links out to the project. macOS
            // already auto-creates a Help menu with a search field
            // and a "$AppName Help" item; CommandGroup(replacing:
            // .help) lets us put real items there.
            CommandGroup(replacing: .help) {
                Button("MARVIN on GitHub") {
                    if let url = URL(string: "https://github.com/RobertIlisei/MARVIN") {
                        NSWorkspace.shared.open(url)
                    }
                }
                Button("Report an Issue…") {
                    if let url = URL(string: "https://github.com/RobertIlisei/MARVIN/issues/new") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }

        // Phase 1c — custom About panel. Mounted as a separate
        // Window scene so it gets its own window-state / close-
        // button / ⌘W behavior for free. Opened via the App menu's
        // About item (CommandGroup(replacing: .appInfo) above).
        // .commandsRemoved() keeps the About window from
        // contributing duplicate menu items when it has focus.
        Window("About MARVIN", id: "marvin-about") {
            AboutView()
                .environment(health)
                .environment(bridge)
        }
        .windowResizability(.contentSize)
        .windowStyle(.hiddenTitleBar)
        .commandsRemoved()

        // Phase 1d.9 — native Settings scene (⌘,). SwiftUI's
        // `Settings` scene is special: it auto-installs the
        // "Settings…" item in the App menu and binds ⌘, to it,
        // no manual command wiring needed. The view itself only
        // touches local native affordances — open data dir, open
        // project workDir, reset window frame, re-probe sidecar.
        // Anything that should mutate sidecar state stays in the
        // web app's existing settings popover.
        Settings {
            SettingsView()
                .environment(health)
                .environment(bridge)
        }
    }
}
