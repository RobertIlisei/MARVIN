// ProjectPickerToolbar — Phase 5d. Native peer of the web app's
// ProjectPicker. Mounted in the leading area of NSToolbar so the
// active project is always one click away — same affordance VS
// Code, Xcode, IntelliJ all surface in their title bar.
//
// Pattern: SwiftUI Menu over a button-shaped label, populated from
// `bridge.projects`. Clicking a project dispatches the same
// `marvin:select-project` event the File > Open Recent menu fires;
// the web side handles the actual project switch.

import SwiftUI

struct ProjectPickerToolbarItem: View {
    @Environment(MarvinBridge.self) private var bridge

    var body: some View {
        Menu {
            Section("Switch project") {
                if bridge.projects.isEmpty {
                    Text("(no projects yet)")
                        .foregroundStyle(.tertiary)
                } else {
                    ForEach(bridge.projects) { project in
                        Button {
                            // ADR-0021 M2: ProjectsService owns project switching.
                            Task { try? await ProjectsService.shared.setActive(id: project.id) }
                        } label: {
                            HStack {
                                if project.workDir == bridge.projectWorkDir {
                                    Image(systemName: "checkmark")
                                }
                                Text(project.name)
                            }
                        }
                    }
                }
            }
            Divider()
            Button("Open Project…") {
                openProjectWithPanel()
            }
            .keyboardShortcut("o", modifiers: [.command])
            if let workDir = bridge.projectWorkDir {
                Divider()
                Button("Reveal in Finder") {
                    let url = URL(fileURLWithPath: workDir)
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                }
                .keyboardShortcut("r", modifiers: [.command, .option])
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.system(size: 11))
                Text(bridge.projectName ?? "no project")
                    .font(.system(size: 12, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: 200)
        }
        .menuStyle(.borderlessButton)
        .help("Switch project · ⌘O to open another")
    }
}
