// GraphPaneView — the "graph" pane the layout popover always promised.
// Until 2026-07-03 the ⌘G toggle flipped `panes.graph` and nothing
// consumed it (the 2026-07-02 frontend audit's "stale buttons" finding).
// This pane renders graphify's interactive graph.html for the ACTIVE
// project via the sidecar's sandboxed `/api/graph/html?cwd=` route —
// a self-contained visualization document (CSP `sandbox allow-scripts`,
// no same-origin privileges), hosted in a WKWebView the same way the
// preview pane hosts dev servers. This is a viewer, not app chrome —
// MARVIN's UI stays native (ADR-0021).

import SwiftUI
import WebKit

struct GraphPaneView: View {
    @Environment(MarvinBridge.self) private var bridge

    /// nil = probing; true = graph.html served; false = missing (404 —
    /// the project has no graphify-out/graph.html yet).
    @State private var available: Bool? = nil
    /// Bump to force a WKWebView reload after a rebuild.
    @State private var reloadKey = 0
    @State private var probedWorkDir: String? = nil

    private var graphURL: URL? {
        guard let workDir = bridge.projectWorkDir,
              let encoded = workDir.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return nil }
        return URL(string: "\(ServerConfig.baseURLString)/api/graph/html?cwd=\(encoded)")
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .task(id: bridge.projectWorkDir) { await probe() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .foregroundStyle(.secondary)
            Text("Knowledge graph")
                .font(.system(size: 12, weight: .semibold))
            if let workDir = bridge.projectWorkDir {
                Text((workDir as NSString).lastPathComponent)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                Task { await probe(force: true) }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .help("Reload the graph (after /graphify . --update)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var content: some View {
        if bridge.projectWorkDir == nil {
            emptyState("No project open",
                       hint: "Open a project to see its code graph.")
        } else if available == false {
            emptyState("No graph built yet",
                       hint: "Run /graphify . in this project to build graphify-out/graph.html, then reload.")
        } else if let url = graphURL, available == true {
            GraphWebView(url: url, reloadKey: reloadKey)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func emptyState(_ title: String, hint: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
            Text(title).font(.system(size: 13, weight: .semibold))
            Text(hint)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// HEAD-style availability probe so a missing graph shows a native
    /// hint instead of the route's raw 404 JSON inside the web view.
    private func probe(force: Bool = false) async {
        guard let url = graphURL else { available = nil; return }
        if !force, probedWorkDir == bridge.projectWorkDir, available == true { return }
        probedWorkDir = bridge.projectWorkDir
        available = nil
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 5
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            available = ok
            if ok, force { reloadKey += 1 }
        } catch {
            available = false
        }
    }
}

/// Minimal WKWebView host for the sandboxed graph document. Unlike the
/// preview pane there is no URL bar or history — the graph is a single
/// self-contained page; pan/zoom run client-side under the CSP sandbox.
private struct GraphWebView: NSViewRepresentable {
    let url: URL
    let reloadKey: Int

    func makeNSView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        view.setValue(false, forKey: "drawsBackground")
        view.load(URLRequest(url: url))
        context.coordinator.lastURL = url
        context.coordinator.lastKey = reloadKey
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        guard context.coordinator.lastURL != url || context.coordinator.lastKey != reloadKey else { return }
        context.coordinator.lastURL = url
        context.coordinator.lastKey = reloadKey
        nsView.load(URLRequest(url: url))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var lastURL: URL? = nil
        var lastKey: Int = -1
    }
}
