// QuickOpenSheet — Phase 5d. Native ⌘P file fuzzy-search, IDE
// muscle memory. Loads /api/files/tree, walks the result into a
// flat list, filters by substring (case-insensitive), and opens
// the picked file in a tab on Enter.
//
// Why custom filtering instead of NSPredicate / SwiftUI Searchable:
// the web app uses a real fuzzy matcher (sublime / fzf-style); we'd
// like the same here but a substring filter covers 90% of the UX
// for the first cut. Upgrading to `LSSubsequenceMatch` or a
// hand-rolled fuzzy ranker is one focused change away.

import SwiftUI
import AppKit

struct QuickOpenSheet: View {
    @Environment(MarvinBridge.self) private var bridge
    @Environment(\.dismiss) private var dismiss

    @State private var query: String = ""
    @State private var allFiles: [String] = []
    @State private var recentPaths: [String] = []
    @State private var loadError: String? = nil
    @State private var selection: String? = nil
    @FocusState private var queryFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // Search field
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Type a filename…", text: $query)
                    .textFieldStyle(.plain)
                    .focused($queryFocused)
                    .onSubmit {
                        if let path = selection ?? filtered.first {
                            open(path)
                        }
                    }
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .font(.system(size: 14))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color(nsColor: .underPageBackgroundColor))

            Divider()

            // Results
            if let err = loadError {
                Text("Failed to load tree: \(err)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.red)
                    .padding()
            } else {
                let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
                let showSections = q.isEmpty && !validRecents.isEmpty
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if showSections {
                            sectionLabel("RECENT")
                            ForEach(validRecents, id: \.self) { path in
                                row(path: path)
                            }
                            sectionLabel("ALL FILES")
                            let recentSet = Set(validRecents)
                            ForEach(allFiles.filter { !recentSet.contains($0) }.prefix(140), id: \.self) { path in
                                row(path: path)
                            }
                        } else {
                            ForEach(filtered.prefix(150), id: \.self) { path in
                                row(path: path)
                            }
                        }
                    }
                }
                .frame(height: 380)
            }

            HStack {
                let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
                if q.isEmpty {
                    Text("\(allFiles.count) file\(allFiles.count == 1 ? "" : "s")")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                } else {
                    Text("\(filtered.count) match\(filtered.count == 1 ? "" : "es")")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                Text("↩ open · esc dismiss")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color(nsColor: .underPageBackgroundColor))
        }
        .frame(width: 600)
        .onAppear {
            queryFocused = true
            if let pid = bridge.activeProjectId {
                recentPaths = NativePrefs.shared.recentFiles(forProject: pid)
            }
            Task { await loadTree() }
        }
        .onKeyPress(.escape) {
            dismiss()
            return .handled
        }
        .onKeyPress(.upArrow) {
            moveSelection(-1)
            return .handled
        }
        .onKeyPress(.downArrow) {
            moveSelection(1)
            return .handled
        }
    }

    private var validRecents: [String] {
        guard !recentPaths.isEmpty else { return [] }
        let available = Set(allFiles)
        return recentPaths.filter { available.contains($0) }
    }

    private func sectionLabel(_ title: String) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(.tertiary)
                .tracking(1)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 2)
    }

    private func row(path: String) -> some View {
        let kind = FileTypeIcon.kind(for: path)
        let name = (path as NSString).lastPathComponent
        let parent = (path as NSString).deletingLastPathComponent
        let cwd = bridge.projectWorkDir ?? ""
        let displayParent = parent.hasPrefix(cwd)
            ? String(parent.dropFirst(cwd.count).drop(while: { $0 == "/" }))
            : parent
        let isSelected = selection == path
        return Button {
            open(path)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: FileTypeIcon.symbol(for: kind))
                    .foregroundStyle(FileTypeIcon.color(for: kind))
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(name)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(.primary)
                    if !displayParent.isEmpty {
                        Text(displayParent)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(isSelected
                        ? Color.accentColor.opacity(0.18)
                        : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var filtered: [String] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty {
            // Recents first, then remaining files — drives moveSelection.
            let recent = validRecents
            let recentSet = Set(recent)
            return recent + allFiles.filter { !recentSet.contains($0) }
        }
        // Score: filename contains > path contains. Two passes so
        // matches in the basename rank above matches deep in the
        // path. Stable sort within each group preserves tree order.
        var nameMatches: [String] = []
        var pathMatches: [String] = []
        for p in allFiles {
            let name = (p as NSString).lastPathComponent.lowercased()
            if name.contains(q) {
                nameMatches.append(p)
            } else if p.lowercased().contains(q) {
                pathMatches.append(p)
            }
        }
        return nameMatches + pathMatches
    }

    private func moveSelection(_ delta: Int) {
        let list = Array(filtered.prefix(150))
        guard !list.isEmpty else { return }
        if let current = selection, let i = list.firstIndex(of: current) {
            let next = (i + delta).clamped(to: 0...(list.count - 1))
            selection = list[next]
        } else {
            selection = list[delta > 0 ? 0 : list.count - 1]
        }
    }

    private func open(_ path: String) {
        if let pid = bridge.activeProjectId {
            NativePrefs.shared.recordOpenedFile(path, forProject: pid)
        }
        bridge.setSelectedFile(path)
        dismiss()
    }

    /// Walk the project tree into a flat list of file paths.
    /// Directories are excluded — Quick Open is for opening a file,
    /// not for navigation.
    private func loadTree() async {
        guard let cwd = bridge.projectWorkDir else {
            loadError = "no project active"
            return
        }
        do {
            let response = try await FilesService.shared.fetchTree(cwd: cwd)
            var collected: [String] = []
            collected.reserveCapacity(2_000)
            walk(nodes: response.tree, into: &collected)
            allFiles = collected
        } catch {
            loadError = "\(error)"
        }
    }

    private func walk(nodes: [FileNode], into out: inout [String]) {
        for node in nodes {
            if node.isDirectory {
                if let children = node.children {
                    walk(nodes: children, into: &out)
                }
            } else {
                out.append(node.path)
            }
        }
    }
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}
