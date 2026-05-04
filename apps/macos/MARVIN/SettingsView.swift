// SettingsView — native preferences panel (⌘,). Shipped as a
// SwiftUI `Settings` scene in MARVINApp.swift, which auto-creates
// the App-menu "Settings…" item with ⌘, on macOS.
//
// Phase 1d.9. Deliberately scoped to local native affordances:
// nothing here mutates the Node sidecar, no chat / project / cost
// state lives here. The web app's existing settings popover stays
// where the user can change those — this panel is for the things
// that only make sense at the SwiftUI shell layer.

import AppKit
import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @Environment(HealthMonitor.self) private var health
    @Environment(MarvinBridge.self) private var bridge

    /// Phase 1d.35 — bound to UserDefaults via @AppStorage. Default
    /// true so a fresh install auto-launches the sidecar on first
    /// open; users on shared machines / non-conventional clone paths
    /// can flip it off here.
    @AppStorage("marvin.autoStartSidecar") private var autoStartSidecar: Bool = true

    /// Phase 1d.36 — Launch-at-login toggle. The actual registration
    /// lives in SMAppService.mainApp; the @AppStorage value mirrors
    /// it so the Toggle has reactive state. We resync on appear in
    /// case the user disabled the login item via System Settings →
    /// General → Login Items (which would leave our @AppStorage
    /// value stale).
    @State private var launchAtLogin: Bool = (SMAppService.mainApp.status == .enabled)

    /// `~/.marvin/` — same default as the sidecar's MARVIN_DATA_DIR.
    /// Built fresh per access so the path resolves correctly on a
    /// fresh user (no caching).
    private var dataDirectoryURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".marvin", isDirectory: true)
    }

    var body: some View {
        Form {
            Section("Sidecar") {
                LabeledContent("URL") {
                    Text("http://localhost:3030")
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                }
                LabeledContent("State") {
                    Text(health.state.shortLabel)
                        .font(.body.monospaced())
                        .foregroundStyle(.secondary)
                }
                Toggle("Auto-start at launch", isOn: $autoStartSidecar)
                    .help("On first cold launch with no sidecar running, MARVIN spawns `bin/marvin start` from the most likely repo clone path. Disable if you manage the sidecar via launchd or a separate Terminal.")
                HStack {
                    Spacer()
                    Button("Re-probe now") {
                        Task { await health.refreshNow() }
                    }
                }
            }

            Section("Data") {
                LabeledContent("Directory") {
                    Text(dataDirectoryURL.path)
                        .font(.body.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                HStack {
                    Spacer()
                    Button("Open in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([dataDirectoryURL])
                    }
                }
            }

            Section("Active project") {
                if let workDir = bridge.projectWorkDir {
                    LabeledContent("workDir") {
                        Text(workDir)
                            .font(.body.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                    HStack {
                        Spacer()
                        Button("Open in Finder") {
                            NSWorkspace.shared.activateFileViewerSelecting(
                                [URL(fileURLWithPath: workDir)]
                            )
                        }
                    }
                } else {
                    Text("No project active.")
                        .foregroundStyle(.secondary)
                }
            }

            Section("Launch") {
                // Phase 1d.36 — Launch at Login. SMAppService.mainApp
                // registers the .app bundle as a login item via
                // launchd; macOS 13+ replaces the older LSSharedFile
                // dance with a clean public API that doesn't need a
                // privileged helper. Failures (e.g. ad-hoc build the
                // user moved out of /Applications) surface as the
                // Toggle reverting to its previous state — quiet,
                // matches what System Settings does on a similar
                // failure, and the help tooltip explains the fix.
                Toggle("Launch MARVIN at login", isOn: $launchAtLogin)
                    .help("Adds MARVIN-Swift.app to your macOS login items so it starts on boot. Move the .app to /Applications first — login items can't run from a Downloads folder.")
                    .onChange(of: launchAtLogin) { _, newValue in
                        applyLaunchAtLogin(newValue)
                    }
            }

            Section("Window") {
                // NSWindow's frameAutosaveName persists position +
                // size to UserDefaults under "NSWindow Frame <name>".
                // Removing the key restores the default frame on the
                // next launch — useful when the saved frame is off-
                // screen (e.g. after disconnecting an external
                // monitor) and the user can't drag it back.
                LabeledContent("Saved frame") {
                    if UserDefaults.standard.string(forKey: "NSWindow Frame MARVINMainWindow") != nil {
                        Text("present")
                            .foregroundStyle(.secondary)
                    } else {
                        Text("none")
                            .foregroundStyle(.tertiary)
                    }
                }
                HStack {
                    Spacer()
                    Button("Reset to default") {
                        UserDefaults.standard.removeObject(
                            forKey: "NSWindow Frame MARVINMainWindow"
                        )
                    }
                    .help("Clears saved window position & size; next launch uses the default frame.")
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 460, height: 540)
        // Phase 1d.17 — match the web theme so ⌘, doesn't pop a
        // light panel against a dark session. nil falls back to
        // system preference.
        .preferredColorScheme(bridge.preferredColorScheme)
        // Phase 1d.36 — re-read launch-at-login state on appear.
        // Catches the user toggling MARVIN off in System Settings →
        // General → Login Items between Settings opens.
        .onAppear {
            launchAtLogin = (SMAppService.mainApp.status == .enabled)
        }
    }

    /// Apply a launch-at-login toggle change. SMAppService throws
    /// rather than returning a Bool, so we catch + revert the local
    /// state on failure (most common cause: app is running outside
    /// /Applications, where login items can't reach it).
    private func applyLaunchAtLogin(_ enable: Bool) {
        do {
            if enable {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSLog("[SettingsView] launchAtLogin \(enable) failed: \(error)")
            // Revert UI to actual SMAppService state on the next
            // runloop tick — gives the user immediate visual
            // feedback that the toggle didn't take.
            DispatchQueue.main.async {
                launchAtLogin = (SMAppService.mainApp.status == .enabled)
            }
        }
    }
}
