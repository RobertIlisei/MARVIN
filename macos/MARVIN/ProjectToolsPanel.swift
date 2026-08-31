// ProjectToolsPanel — the collapsible sections under the file tree.
//
// VS Code / Antigravity put Outline, Timeline and a build-tool view below the
// Explorer's file list (user, 2026-08-31, with a screenshot of exactly that).
// This is MARVIN's equivalent, with one deliberate difference.
//
// ## Nothing here is language-specific
//
// The reference screenshot showed a **Maven** section — Lifecycle, Plugins,
// Dependencies, Profiles. Shipping that would put a Java assumption into
// MARVIN's own source, which Golden Rule 6 forbids: "MARVIN must not ship
// assumptions about any specific project… stack choices". The user reached the
// same conclusion unprompted ("if it's only for Java, perhaps others will use
// Python or C or something else").
//
// So the third section is **Tasks**, and it renders whatever build system the
// project actually has — Maven, Gradle, npm, Make, Cargo, Go, Python, SwiftPM.
// A Maven project sees its lifecycle; a Python project sees pytest and ruff.
// The panel does not know which it is looking at.
//
// Outline and Timeline are language-agnostic for the same reason:
//
//   • **Outline** reads the graphify graph, which already indexes every
//     language graphify parses — 19,223 Java symbols in the user's project,
//     alongside its TypeScript, SQL and Markdown. Tree-sitter would have been
//     the obvious source and is the wrong one here: MARVIN wires 12 grammars
//     and Java is not among them, so the outline would have been empty on the
//     very project that prompted the request.
//   • **Timeline** is `git log --follow` on the active file. Git does not care
//     what language the file is.

import AppKit
import SwiftUI

@MainActor
@Observable
final class ProjectToolsModel {
    // MARK: Outline
    private(set) var outline: [GraphNode] = []
    private(set) var outlineLoading = false
    /// The file the outline currently describes, so a re-render for an
    /// unrelated reason does not re-read a 19k-node graph.
    private var outlineFor: String? = nil

    // MARK: Timeline
    private(set) var timeline: [GitCommit] = []
    private(set) var timelineLoading = false
    private var timelineFor: String? = nil

    // MARK: Tasks
    private(set) var tasks: [BuildTask] = []
    private var tasksFor: String? = nil

    func refreshOutline(path: String?, workDir: String?) {
        guard let path, let workDir, !path.isEmpty else {
            outline = []; outlineFor = nil; return
        }
        guard outlineFor != path else { return }
        outlineFor = path
        outlineLoading = true
        Task { @MainActor in
            defer { outlineLoading = false }
            let rel = Self.relative(path, to: workDir)
            outline = await Task.detached(priority: .userInitiated) {
                GraphOutline.symbols(inFile: rel, workDir: workDir)
            }.value
        }
    }

    func refreshTimeline(path: String?, workDir: String?) {
        guard let path, let workDir, !path.isEmpty else {
            timeline = []; timelineFor = nil; return
        }
        guard timelineFor != path else { return }
        timelineFor = path
        timelineLoading = true
        Task { @MainActor in
            defer { timelineLoading = false }
            timeline = await GitHistoryService.fileHistory(
                path: path, workDir: workDir, limit: 25
            )
        }
    }

    func refreshTasks(workDir: String?) {
        guard let workDir, !workDir.isEmpty else { tasks = []; tasksFor = nil; return }
        guard tasksFor != workDir else { return }
        tasksFor = workDir
        Task { @MainActor in
            tasks = await Task.detached(priority: .utility) {
                BuildTaskService.discover(workDir: workDir)
            }.value
        }
    }

    static func relative(_ path: String, to workDir: String) -> String {
        let base = workDir.hasSuffix("/") ? workDir : workDir + "/"
        return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : path
    }
}

/// Symbols for one file, read out of `graphify-out/graph.json`.
///
/// The graph is the only symbol source MARVIN has that covers every language
/// the user might open. It is also potentially large (19k+ nodes), so this
/// runs off the main actor and caches the decoded node list per graph file.
enum GraphOutline {
    private struct Wire: Decodable {
        struct Node: Decodable {
            let id: String
            let label: String?
            let source_file: String?
            let source_location: String?
            let file_type: String?
        }
        let nodes: [Node]
    }

    /// Decoded once per (path, mtime). Re-decoding a multi-megabyte graph on
    /// every file selection is what would make this section the new source of
    /// "sluggish".
    private nonisolated(unsafe) static var cache: (key: String, nodes: [Wire.Node])? = nil

    static func symbols(inFile relativePath: String, workDir: String) -> [GraphNode] {
        let graphPath = workDir + "/graphify-out/graph.json"
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: graphPath),
              let mtime = attrs[.modificationDate] as? Date else { return [] }
        let key = "\(graphPath)|\(mtime.timeIntervalSince1970)"

        let nodes: [Wire.Node]
        if let c = cache, c.key == key {
            nodes = c.nodes
        } else {
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: graphPath)),
                  let wire = try? JSONDecoder().decode(Wire.self, from: data)
            else { return [] }
            nodes = wire.nodes
            cache = (key, nodes)
        }

        return nodes
            .filter { $0.source_file == relativePath }
            .compactMap { n -> GraphNode? in
                guard let label = n.label, !label.isEmpty else { return nil }
                return GraphNode(
                    id: n.id, label: label,
                    sourceFile: n.source_file ?? relativePath,
                    sourceLocation: n.source_location,
                    fileType: n.file_type ?? "unknown"
                )
            }
            // By line, so the outline reads in file order rather than in
            // whatever order the graph happens to store nodes.
            .sorted { (SymbolSearchSheet.line(from: $0.sourceLocation) ?? 0)
                    < (SymbolSearchSheet.line(from: $1.sourceLocation) ?? 0) }
    }
}

// MARK: - View

struct ProjectToolsPanel: View {
    /// How many sections are expanded, reported upward so the enclosing split
    /// can give the panel a sensible target height instead of the panel
    /// demanding one. Sizing from the inside is what made expanding a section
    /// "squeeze everything" — the panel asked for a fixed slab and the
    /// splitter took it out of the file tree in one jump.
    @Binding var openSections: Int

    @Environment(MarvinBridge.self) private var bridge
    @State private var model = ProjectToolsModel()
    /// Collapsed section ids. Storing the CLOSED ones means a section added
    /// later is open by default rather than silently hidden.
    @State private var collapsed: Set<String> = ["outline", "timeline", "tasks"]

    static let allSectionIds = ["outline", "timeline", "tasks"]

    private var workDir: String? { bridge.projectWorkDir }
    private var activePath: String? { bridge.selectedFilePath }

    var body: some View {
        // A plain VStack of sections, each scrolling its OWN content — the
        // shape VS Code's sidebar uses.
        //
        // Two earlier attempts got this wrong, both visibly:
        //
        //   1. Each open section took `maxHeight: .infinity` and shared the
        //      panel, while the panel's `idealHeight` grew with the open
        //      count. A changing ideal makes the split view re-apply it on
        //      every expand/collapse, yanking the divider back after the user
        //      had dragged it. The ideal is stable now (see `LeftPane`).
        //   2. Replacing the per-section scrolls with ONE outer scroll and a
        //      `maxHeight` cap. `frame(maxHeight:)` constrains the PROPOSED
        //      size; it does not clip. So 53 task rows rendered past their cap
        //      and drew straight over the section headers below them.
        //
        // A `ScrollView` both bounds and clips its content, which is what the
        // cap alone could not do.
        VStack(spacing: 0) {
            section(
                id: "outline", title: "Outline",
                count: model.outline.count, loading: model.outlineLoading
            ) { outlineBody }
            MarvinDivider()
            section(
                id: "timeline", title: "Timeline",
                count: model.timeline.count, loading: model.timelineLoading
            ) { timelineBody }
            MarvinDivider()
            section(id: "tasks", title: "Tasks", count: model.tasks.count, loading: false) {
                tasksBody
            }
        }
        .background(MarvinTheme.background)
        // Only load a section's data when it is actually open. A collapsed
        // Outline must not read a 19k-node graph on every file click.
        .onChange(of: activePath, initial: true) { _, _ in loadOpenSections() }
        .onChange(of: collapsed) { _, _ in loadOpenSections() }
        .onChange(of: workDir, initial: true) { _, _ in loadOpenSections() }
        .onChange(of: collapsed, initial: true) { _, c in
            openSections = ProjectToolsPanel.allSectionIds.count - c.count
        }
    }

    private func loadOpenSections() {
        if !collapsed.contains("outline") {
            model.refreshOutline(path: activePath, workDir: workDir)
        }
        if !collapsed.contains("timeline") {
            model.refreshTimeline(path: activePath, workDir: workDir)
        }
        if !collapsed.contains("tasks") {
            model.refreshTasks(workDir: workDir)
        }
    }

    // MARK: Section chrome

    @ViewBuilder
    private func section<Content: View>(
        id: String, title: String, count: Int, loading: Bool,
        @ViewBuilder content: () -> Content
    ) -> some View {
        let isCollapsed = collapsed.contains(id)
        Button {
            if isCollapsed { collapsed.remove(id) } else { collapsed.insert(id) }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 8))
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                Spacer()
                if loading {
                    ProgressView().controlSize(.small).scaleEffect(0.55)
                } else if count > 0 {
                    Text("\(count)")
                        .font(.system(size: 9, design: .monospaced))
                        .padding(.horizontal, 5)
                        .background(Capsule().fill(MarvinTheme.elevated))
                }
            }
            .foregroundStyle(MarvinTheme.textMuted)
            .contentShape(Rectangle())
            .padding(.horizontal, 10)
            .frame(height: 24)
        }
        .buttonStyle(.plain)

        if !isCollapsed {
            // A ScrollView, because it is what CLIPS as well as bounds: a
            // bare `frame(maxHeight:)` constrains the PROPOSED size without
            // clipping, so 53 task rows rendered past their cap and painted
            // straight over the headers below them.
            //
            // No height cap. A ScrollView accepts whatever height it is
            // offered, so the open sections divide the pane between them and
            // a collapsed one costs only its header — which is how VS Code's
            // sidebar behaves. A fixed cap looked tidier and was worse both
            // ways: dead space below a single open section, and three open
            // sections still cramped, only now with a magic number deciding
            // how cramped.
            ScrollView {
                content()
            }
        }
    }

    private func empty(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10))
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.bottom, 6)
    }

    // MARK: Outline

    @ViewBuilder
    private var outlineBody: some View {
        if activePath == nil {
            empty("Open a file to see its symbols.")
        } else if model.outline.isEmpty && !model.outlineLoading {
            // Naming the reason matters: an empty outline on a supported file
            // usually means the graph has not been built, which the user can
            // fix — unlike "this file genuinely has no symbols".
            empty("No symbols in the graph for this file. Run /graphify to build or refresh it.")
        } else {
            LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(model.outline) { node in
                        Button {
                            guard let w = workDir else { return }
                            bridge.openFileFromChat(
                                path: w + "/" + node.sourceFile,
                                line: SymbolSearchSheet.line(from: node.sourceLocation)
                            )
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "chevron.left.forwardslash.chevron.right")
                                    .font(.system(size: 8))
                                    .foregroundStyle(.tertiary)
                                Text(node.label)
                                    .font(.system(size: 11, design: .monospaced))
                                    .lineLimit(1).truncationMode(.middle)
                                Spacer(minLength: 4)
                                if let loc = node.sourceLocation {
                                    Text(loc)
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .contentShape(Rectangle())
                            .padding(.horizontal, 14)
                            .frame(height: 20)
                        }
                        .buttonStyle(ToolRowStyle())
                    }
                }
        }
    }

    // MARK: Timeline

    @ViewBuilder
    private var timelineBody: some View {
        if activePath == nil {
            empty("Open a file to see its history.")
        } else if model.timeline.isEmpty && !model.timelineLoading {
            empty("No commits touch this file yet.")
        } else {
            LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(model.timeline) { c in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(c.message)
                                .font(.system(size: 11))
                                .lineLimit(1).truncationMode(.tail)
                            HStack(spacing: 5) {
                                Text(c.id).font(.system(size: 9, design: .monospaced))
                                Text(c.author).font(.system(size: 9))
                                Text(c.date).font(.system(size: 9))
                            }
                            .foregroundStyle(.tertiary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                        .contextMenu {
                            Button("Copy SHA") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(c.sha, forType: .string)
                            }
                            Button("Copy Subject") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(c.message, forType: .string)
                            }
                        }
                    }
                }
        }
    }

    // MARK: Tasks

    @ViewBuilder
    private var tasksBody: some View {
        if model.tasks.isEmpty {
            empty("No build system found — looked for package.json, Makefile, pom.xml, build.gradle, Cargo.toml, go.mod, pyproject.toml and Package.swift.")
        } else {
            LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(model.tasks) { task in
                        Button { run(task) } label: {
                            HStack(spacing: 6) {
                                Text(task.kindLabel)
                                    .font(.system(size: 8, weight: .medium))
                                    .padding(.horizontal, 4)
                                    .background(Capsule().fill(MarvinTheme.elevated))
                                    .foregroundStyle(.tertiary)
                                Text(task.name)
                                    .font(.system(size: 11))
                                    .lineLimit(1).truncationMode(.middle)
                                Spacer(minLength: 4)
                                Image(systemName: "play.fill")
                                    .font(.system(size: 8))
                                    .foregroundStyle(.tertiary)
                            }
                            .contentShape(Rectangle())
                            .padding(.horizontal, 14)
                            .frame(height: 20)
                        }
                        .buttonStyle(ToolRowStyle())
                        .help(task.description.map { "\($0) — \(task.command)" } ?? task.command)
                    }
                }
        }
    }

    /// Send the task to the terminal rather than running it silently: the
    /// output is the point, and a build that fails needs to be readable.
    private func run(_ task: BuildTask) {
        NativePrefs.shared.revealPane(.terminal)
        let cd = task.directory.map { "cd \($0.replacingOccurrences(of: " ", with: "\\ ")) && " } ?? ""
        bridge.triggerTerminalCommand(cd + task.command)
    }
}

private struct ToolRowStyle: ButtonStyle {
    @State private var hovering = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(hovering ? MarvinTheme.rowHover : Color.clear)
            .onHover { hovering = $0 }
    }
}
