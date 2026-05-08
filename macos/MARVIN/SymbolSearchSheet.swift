// SymbolSearchSheet — M4. ⌘T "Go to Symbol" powered by the project's
// graphify knowledge graph. Loads <workDir>/graphify-out/graph.json,
// presents a fuzzy-filtered list of graph nodes (functions, types,
// files, concepts), and navigates to the source file on selection.
//
// If no graph exists, shows a one-line hint to run /graphify.
// Mirrors VS Code ⌘T / Xcode ⌘O "Open Quickly" for symbols.

import SwiftUI

// MARK: - Node model

struct GraphNode: Identifiable {
    let id: String
    let label: String
    let sourceFile: String
    let sourceLocation: String?
    let fileType: String
}

// MARK: - Sheet

struct SymbolSearchSheet: View {
    @Environment(MarvinBridge.self) private var bridge
    @Environment(\.dismiss) private var dismiss

    @State private var query: String = ""
    @State private var nodes: [GraphNode] = []
    @State private var loadState: LoadState = .idle
    @State private var selection: GraphNode? = nil
    @FocusState private var focused: Bool

    enum LoadState {
        case idle, loading, loaded, noGraph, error(String)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack(spacing: 8) {
                Image(systemName: "scope")
                    .foregroundStyle(.secondary)
                    .font(.system(size: 14))
                TextField("Go to symbol…", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .focused($focused)
                    .onSubmit { openSelected() }
                if case .loading = loadState {
                    ProgressView().scaleEffect(0.65).frame(width: 14, height: 14)
                } else if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                    }.buttonStyle(.borderless)
                }
            }
            .font(.system(size: 14))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color(nsColor: .underPageBackgroundColor))

            Divider()

            // Body
            bodyContent

            // Footer
            HStack {
                switch loadState {
                case .loaded:
                    Text("\(filtered.count) symbol\(filtered.count == 1 ? "" : "s")")
                        .font(.caption2.monospaced()).foregroundStyle(.tertiary)
                case .noGraph:
                    Text("No graph — run /graphify in a MARVIN session to index this project")
                        .font(.caption2).foregroundStyle(.orange)
                case .error(let msg):
                    Text("Error: \(msg)").font(.caption2).foregroundStyle(.red)
                default:
                    EmptyView()
                }
                Spacer()
                Text("↩ open · esc dismiss")
                    .font(.caption2.monospaced()).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color(nsColor: .underPageBackgroundColor))
        }
        .frame(width: 640)
        .onAppear {
            focused = true
            Task { await loadGraph() }
        }
        .onKeyPress(.escape) { dismiss(); return .handled }
        .onKeyPress(.upArrow) { moveSelection(-1); return .handled }
        .onKeyPress(.downArrow) { moveSelection(1); return .handled }
    }

    @ViewBuilder
    private var bodyContent: some View {
        switch loadState {
        case .noGraph:
            VStack(spacing: 8) {
                Image(systemName: "square.grid.3x3.fill").font(.system(size: 32))
                    .foregroundStyle(.tertiary)
                Text("No knowledge graph found")
                    .font(.headline)
                Text("Run `/graphify .` in a MARVIN session to index this project.\nAfter indexing, ⌘T will search across all symbols.")
                    .font(.callout).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: 340)
        case .loading:
            ProgressView("Loading graph…")
                .frame(maxWidth: .infinity, maxHeight: 340)
        default:
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(filtered.prefix(200)) { node in
                        nodeRow(node)
                    }
                }
            }
            .frame(height: 380)
        }
    }

    private func nodeRow(_ node: GraphNode) -> some View {
        let isSelected = selection?.id == node.id
        return Button { open(node) } label: {
            HStack(spacing: 8) {
                nodeIcon(node)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(node.label)
                        .font(.system(size: 13))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        Text(node.sourceFile)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.head)
                        if let loc = node.sourceLocation {
                            Text("· \(loc)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(isSelected ? Color.accentColor.opacity(0.18) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func nodeIcon(_ node: GraphNode) -> some View {
        let (symbol, color) = iconForNode(node)
        Image(systemName: symbol)
            .font(.system(size: 11))
            .foregroundStyle(color)
    }

    private func iconForNode(_ node: GraphNode) -> (String, Color) {
        switch node.fileType {
        case "code":
            let label = node.label.lowercased()
            if label.contains("class") || label.contains("struct") { return ("cube", .purple) }
            if label.contains("func") || label.contains("fn ") || label.contains("def ") { return ("function", .blue) }
            if label.contains("enum") { return ("list.bullet.rectangle", .orange) }
            if label.contains("protocol") || label.contains("interface") { return ("curlybraces", .teal) }
            return ("chevron.left.forwardslash.chevron.right", .secondary)
        case "document":
            return ("doc.text", .gray)
        case "paper":
            return ("doc.richtext", .indigo)
        case "image":
            return ("photo", .mint)
        default:
            return ("circle.fill", .secondary)
        }
    }

    // MARK: - Filtering

    private var filtered: [GraphNode] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return nodes }
        var labelHits: [GraphNode] = []
        var fileHits: [GraphNode] = []
        for n in nodes {
            if n.label.lowercased().contains(q) {
                labelHits.append(n)
            } else if n.sourceFile.lowercased().contains(q) {
                fileHits.append(n)
            }
        }
        return labelHits + fileHits
    }

    // MARK: - Navigation

    private func moveSelection(_ delta: Int) {
        let list = Array(filtered.prefix(200))
        guard !list.isEmpty else { return }
        if let current = selection, let i = list.firstIndex(where: { $0.id == current.id }) {
            let next = max(0, min(list.count - 1, i + delta))
            selection = list[next]
        } else {
            selection = list[delta > 0 ? 0 : list.count - 1]
        }
    }

    private func openSelected() {
        if let node = selection ?? filtered.first {
            open(node)
        }
    }

    private func open(_ node: GraphNode) {
        guard let workDir = bridge.projectWorkDir else { return }
        let fullPath = workDir + "/" + node.sourceFile
        bridge.setSelectedFile(fullPath)
        dismiss()
    }

    // MARK: - Graph loading

    private func loadGraph() async {
        guard let workDir = bridge.projectWorkDir else { return }
        let graphPath = workDir + "/graphify-out/graph.json"

        loadState = .loading
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: graphPath))
            let raw = try JSONDecoder().decode(RawGraph.self, from: data)
            nodes = raw.nodes.compactMap { n -> GraphNode? in
                guard let src = n.source_file, !src.isEmpty else { return nil }
                return GraphNode(
                    id: n.id,
                    label: n.label,
                    sourceFile: src,
                    sourceLocation: n.source_location,
                    fileType: n.file_type ?? "unknown"
                )
            }
            loadState = .loaded
        } catch CocoaError.fileNoSuchFile, CocoaError.fileReadNoSuchFile {
            loadState = .noGraph
        } catch {
            // Also catch "no such file" from POSIX
            let nsErr = error as NSError
            if nsErr.domain == NSCocoaErrorDomain && nsErr.code == NSFileReadNoSuchFileError {
                loadState = .noGraph
            } else {
                loadState = .error(error.localizedDescription)
            }
        }
    }
}

// MARK: - Raw graph JSON models

private struct RawGraph: Decodable {
    let nodes: [RawNode]
    struct RawNode: Decodable {
        let id: String
        let label: String
        let source_file: String?
        let source_location: String?
        let file_type: String?
    }
}
