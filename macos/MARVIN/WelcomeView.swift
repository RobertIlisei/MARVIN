// WelcomeView — startup / no-project landing screen.
//
// Shown in place of the 3-pane IDE layout whenever no project is
// active (bridge.projectWorkDir == nil). Mirrors the "Welcome to …"
// screens in Xcode, VS Code, and Cursor — a centred pane with the
// product identity, a primary action, and a recent-projects list.
//
// The two-column layout (logo | actions) kicks in on wide windows;
// narrow windows (< 560 pt) collapse to a single vertical column.

import SwiftUI

struct WelcomeView: View {
    @Environment(MarvinBridge.self) private var bridge

    private var projects: [BridgeProject] { bridge.projects }

    var body: some View {
        HStack(spacing: 0) {
            // Left: identity panel
            identityPanel
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(nsColor: .controlBackgroundColor))

            Divider()

            // Right: actions + recent projects
            actionsPanel
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(nsColor: .windowBackgroundColor))
        }
        .frame(minWidth: 560, minHeight: 360)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url, url.hasDirectoryPath else { return }
                    Task { @MainActor in
                        try? await ProjectsService.shared.addProject(workDir: url.path)
                    }
                }
            }
            return true
        }
    }

    // MARK: - Identity panel

    private var identityPanel: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "brain.head.profile")
                .font(.system(size: 64, weight: .ultraLight))
                .foregroundStyle(.secondary)
                .symbolRenderingMode(.hierarchical)

            VStack(spacing: 4) {
                Text("MARVIN")
                    .font(.system(size: 36, weight: .bold, design: .monospaced))
                    .tracking(4)
                Text("Moderately Advanced Robotic\nVirtual Intelligence Network")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            Spacer()
        }
        .padding(32)
    }

    // MARK: - Actions panel

    private var actionsPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                Text(projects.isEmpty ? "Get started" : "Recent Projects")
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 4)

                if projects.isEmpty {
                    emptyPrompt
                } else {
                    recentProjectsList
                }
            }
            .padding(32)

            Divider()

            openButton
                .padding(20)
        }
    }

    // MARK: - Subcomponents

    private var emptyPrompt: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("No projects yet.")
                .foregroundStyle(.primary)
            Text("Open a folder to start working with MARVIN.\nDrag a folder onto the window or use the button below.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private var recentProjectsList: some View {
        ScrollView {
            LazyVStack(spacing: 4) {
                ForEach(projects) { project in
                    Button {
                        Task {
                            try? await ProjectsService.shared.setActive(id: project.id)
                        }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "folder.fill")
                                .foregroundStyle(.blue)
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(project.name)
                                    .fontWeight(.medium)
                                    .lineLimit(1)
                                Text(project.workDir
                                    .replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(Color(nsColor: .controlBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxHeight: 240)
    }

    private var openButton: some View {
        HStack {
            Button {
                openProjectWithPanel()
            } label: {
                Label("Open Project…", systemImage: "folder.badge.plus")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            Spacer()

            Text("or drag a folder here")
                .font(.callout)
                .foregroundStyle(.tertiary)
        }
    }
}
