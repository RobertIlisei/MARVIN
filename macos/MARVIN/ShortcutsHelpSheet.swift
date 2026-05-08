// ShortcutsHelpSheet — Phase 5d. Native peer of the web app's
// shortcuts-help. Shown via Window > Keyboard Shortcuts (⌘/) or
// the `?` global key. Lists every binding the user can use across
// MARVIN-Swift's surfaces.

import SwiftUI

struct ShortcutsHelpSheet: View {
    @Environment(\.dismiss) private var dismiss

    private struct Section: Identifiable {
        let id = UUID()
        let title: String
        let entries: [(keys: String, label: String)]
    }

    private var sections: [Section] {
        [
            Section(title: "Window", entries: [
                ("⌘/", "Show this shortcuts sheet"),
                ("⌘,", "Open Settings"),
                ("⌘W", "Close active editor tab"),
                ("⌘R", "Reload"),
                ("⌘⇧R", "Force Reload (bypass cache)"),
                ("⌘0", "Actual size"),
                ("⌘=", "Zoom in"),
                ("⌘-", "Zoom out"),
                ("⌘F", "Find in page"),
                ("⌘G", "Find next"),
                ("⌘⇧G", "Find previous"),
            ]),
            Section(title: "Files", entries: [
                ("⌘P", "Quick Open file"),
                ("⌘O", "Open Project…"),
                ("⌘B", "Toggle file tree"),
                ("⌘S", "Save active file"),
                ("⌫", "Move selected row to Trash (in tree)"),
                ("↩", "Rename selected row (in tree)"),
                ("Space", "Quick Look (in tree)"),
            ]),
            Section(title: "Session", entries: [
                ("⌘⇧N", "New session"),
                ("⌘.", "Cancel current turn"),
                ("⌘K", "Open project picker"),
                ("⌘⏎", "Send message"),
            ]),
            Section(title: "Panes", entries: [
                ("⌘B", "Files"),
                ("⌘G", "Graph"),
                ("⌘J", "Terminal"),
                ("⌘⇧P", "Preview"),
            ]),
            Section(title: "Theme", entries: [
                ("⌘⇧T", "Toggle light / dark"),
            ]),
            Section(title: "macOS", entries: [
                ("⌘Q", "Quit MARVIN"),
                ("⌘H", "Hide MARVIN"),
                ("⌘⌥H", "Hide others"),
                ("⌘M", "Minimize"),
                ("⌘⌥R", "Reveal project in Finder"),
                ("⌘⌥T", "Open Terminal at project"),
            ]),
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Keyboard Shortcuts")
                    .font(.title2.weight(.semibold))
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(20)
            .background(Color(nsColor: .underPageBackgroundColor))
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(sections) { section in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(section.title.uppercased())
                                .font(.system(size: 10, design: .monospaced))
                                .tracking(2)
                                .foregroundStyle(.tertiary)
                                .padding(.bottom, 2)
                            ForEach(section.entries, id: \.label) { entry in
                                HStack(spacing: 12) {
                                    Text(entry.keys)
                                        .font(.system(size: 12, design: .monospaced))
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 2)
                                        .background(
                                            RoundedRectangle(cornerRadius: 4, style: .continuous)
                                                .fill(Color(nsColor: .underPageBackgroundColor))
                                                .overlay(
                                                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                                                        .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                                                )
                                        )
                                        .frame(minWidth: 80, alignment: .leading)
                                    Text(entry.label)
                                        .font(.system(size: 12))
                                        .foregroundStyle(.primary)
                                    Spacer()
                                }
                            }
                        }
                    }
                }
                .padding(20)
            }
        }
        .frame(width: 540, height: 640)
    }
}
