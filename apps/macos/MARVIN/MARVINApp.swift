// Phase 0 entry point — see docs/decisions/0016-swift-migration.md.
//
// The app boots a single window, polls the Node sidecar at
// http://localhost:3030/api/health, and renders one of three states
// in the content view: connecting / online (with the auth + model
// summary) / offline (with concrete instructions for starting the
// sidecar). Phase 0 deliberately does NOT load the web app yet —
// that's Phase 1, where this same window gets a WKWebView island
// pointing at localhost:3030.
//
// Architecture note: the sidecar is the trust boundary. The Swift
// process never reads Anthropic credentials, never spawns the
// Claude CLI, never persists session transcripts. The `.app` is
// just a window onto an already-running Node server.

import AppKit
import SwiftUI

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
                // two builds during the migration.
                .frame(
                    minWidth: 960,
                    idealWidth: 1440,
                    minHeight: 600,
                    idealHeight: 900
                )
                .task {
                    // Start polling on launch; the monitor self-stops
                    // when the window closes (Phase 0 only has one).
                    await health.start()
                }
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .commands {
            // Replace the default New / Open menu with something
            // useful for MARVIN's shape. Phase 1+ will flesh this
            // out with project switching, pane toggles, etc.
            CommandGroup(replacing: .newItem) {
                Button("Reconnect to Sidecar") {
                    Task { await health.refreshNow() }
                }
                .keyboardShortcut("r", modifiers: [.command])
            }
        }
    }
}
