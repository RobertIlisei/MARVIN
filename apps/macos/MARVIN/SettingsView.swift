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
import SwiftUI

struct SettingsView: View {
    @Environment(HealthMonitor.self) private var health
    @Environment(MarvinBridge.self) private var bridge

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
        .frame(width: 460, height: 460)
    }
}
