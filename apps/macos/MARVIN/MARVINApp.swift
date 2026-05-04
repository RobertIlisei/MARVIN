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

@main
struct MARVINApp: App {
    /// Health monitor lives at app scope so the connection state
    /// survives window opens/closes (Phase 1+ may add multi-window).
    @State private var health = HealthMonitor()

    var body: some Scene {
        Window("MARVIN", id: "marvin-main") {
            ContentView()
                .environment(health)
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
        }
        .windowResizability(.contentSize)
        .windowStyle(.hiddenTitleBar)
        .commandsRemoved()
    }
}
