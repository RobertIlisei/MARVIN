// PreviewPaneView — Phase 5e. Browser-grade preview pane. URL bar
// + back / forward / home / reload, history-aware navigation, and
// the ability for other surfaces (file tree "Open in Browser",
// editor tab action) to load a URL via `bridge.openInPreview(...)`.
//
// Implementation notes:
//
//   • WKWebView already maintains its own back/forward list. We
//     wire NSToolbar-style buttons through canGoBack / canGoForward
//     and surface them above the URL bar.
//   • "Home" = the URL the user last typed into the URL bar (the
//     persisted-per-project value). Distinct from `goBack` because
//     after navigating around a SPA the user often wants to jump
//     back to the dev-server root in one click — that's "home".
//   • `bridge.previewLoadCommand` is a one-shot counter. When it
//     ticks, we adopt `bridge.previewLoadURL` as the new URL. The
//     counter pattern (rather than a Bool) makes "load the same
//     URL again" work — useful for re-rendering after an edit.
//   • file:// URLs work out of the box for local HTML, including
//     relative <link>/<script> paths because allowingReadAccess
//     points WebKit at the file's parent directory.

import SwiftUI
import WebKit

struct PreviewPaneView: View {
    @Environment(MarvinBridge.self) private var bridge

    @State private var urlString: String = ""
    @State private var pendingUrl: String = ""
    @State private var reloadKey: Int = 0
    @State private var isLoading: Bool = false
    @State private var loadError: String? = nil
    @State private var canGoBack: Bool = false
    @State private var canGoForward: Bool = false
    /// Triggers we send into the WebView wrapper (back/forward/home).
    @State private var navTrigger: Int = 0
    @State private var navAction: NavAction = .none
    /// Most-recent (project-level) home URL — the value the user
    /// typed into the URL bar. Distinct from urlString because the
    /// user may have navigated away via in-page links.
    @State private var homeUrl: String = ""

    fileprivate enum NavAction { case none, back, forward, home }

    var body: some View {
        VStack(spacing: 0) {
            urlBar
            Divider()
            content
            Divider()
            footer
        }
        .background(Color(nsColor: .textBackgroundColor))
        .onAppear { hydrateFromProject() }
        .onChange(of: bridge.activeProjectId ?? "") { _, _ in
            hydrateFromProject()
        }
        // External load request — file tree / editor "Open in
        // Browser" hooks come through here.
        .onChange(of: bridge.previewLoadCommand) { _, _ in
            if let req = bridge.previewLoadURL, !req.isEmpty {
                applyURL(req, persist: false)
            }
        }
    }

    // MARK: - URL bar (browser chrome)

    private var urlBar: some View {
        HStack(spacing: 6) {
            navButton(
                system: "chevron.left",
                tip: "Back",
                disabled: !canGoBack
            ) {
                navAction = .back
                navTrigger &+= 1
            }
            navButton(
                system: "chevron.right",
                tip: "Forward",
                disabled: !canGoForward
            ) {
                navAction = .forward
                navTrigger &+= 1
            }
            navButton(
                system: "house",
                tip: "Home (project preview URL)",
                disabled: homeUrl.isEmpty
            ) {
                navAction = .home
                navTrigger &+= 1
            }
            navButton(
                system: "arrow.clockwise",
                tip: "Reload",
                disabled: urlString.isEmpty
            ) {
                reloadKey &+= 1
                isLoading = true
                loadError = nil
            }
            TextField(
                bridge.activeProjectId == nil
                    ? "pick a project first"
                    : "http://localhost:3000  or  file:///path/to/page.html",
                text: $pendingUrl
            )
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 11, design: .monospaced))
            .disabled(bridge.activeProjectId == nil)
            .onSubmit { applyURL(pendingUrl, persist: true) }
            Button {
                applyURL(pendingUrl, persist: true)
            } label: {
                Image(systemName: "arrow.right.circle.fill")
                    .foregroundStyle(.tint)
            }
            .buttonStyle(.borderless)
            .disabled(pendingUrl.trimmingCharacters(in: .whitespaces).isEmpty)
            .help("Load URL (⏎)")
            Button {
                if let url = URL(string: urlString) {
                    NSWorkspace.shared.open(url)
                }
            } label: {
                Image(systemName: "arrow.up.right.square")
            }
            .buttonStyle(.borderless)
            .disabled(urlString.isEmpty)
            .help("Open in default browser")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(nsColor: .underPageBackgroundColor))
    }

    private func navButton(
        system: String,
        tip: String,
        disabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 12, weight: .medium))
        }
        .buttonStyle(.borderless)
        .disabled(disabled)
        .help(tip)
    }

    // MARK: - Content area

    @ViewBuilder
    private var content: some View {
        if urlString.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "safari")
                    .font(.system(size: 28, weight: .light))
                    .foregroundStyle(.tertiary)
                Text("Type a URL above, or right-click an HTML file in the tree → \"Open in Browser\".")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            PreviewWebView(
                urlString: urlString,
                reloadKey: reloadKey,
                navTrigger: navTrigger,
                navAction: navAction,
                homeUrl: homeUrl,
                onLoadStart: { isLoading = true; loadError = nil },
                onLoadFinish: { url in
                    isLoading = false
                    // Reflect the actual landed URL — in-page links
                    // change the URL while the user clicks around.
                    if let url, url.absoluteString != urlString {
                        urlString = url.absoluteString
                        pendingUrl = urlString
                    }
                },
                onLoadFail: { msg in
                    isLoading = false
                    loadError = msg
                },
                onNavStateChange: { back, forward in
                    canGoBack = back
                    canGoForward = forward
                }
            )
            .overlay(alignment: .top) {
                if isLoading {
                    ProgressView()
                        .progressViewStyle(.linear)
                        .frame(height: 2)
                        .tint(.accentColor)
                }
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 8) {
            if let loadError {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text(loadError)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } else if !urlString.isEmpty {
                Text("src:")
                    .foregroundStyle(.tertiary)
                Text(urlString)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } else {
                Text("nothing loaded")
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
        .font(.system(size: 10, design: .monospaced))
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(Color(nsColor: .underPageBackgroundColor))
    }

    // MARK: - State helpers

    private func storageKey(for projectId: String) -> String {
        "marvin.previewUrl.\(projectId)"
    }

    private func hydrateFromProject() {
        guard let pid = bridge.activeProjectId else {
            urlString = ""
            pendingUrl = ""
            homeUrl = ""
            return
        }
        let key = storageKey(for: pid)
        let saved = UserDefaults.standard.string(forKey: key) ?? ""
        urlString = saved
        pendingUrl = saved
        homeUrl = saved
    }

    /// Apply a URL to the WebView. `persist: true` writes it into
    /// UserDefaults as the new "home" for this project; `false`
    /// (the file-tree "Open in Browser" path) doesn't overwrite a
    /// dev-server URL the user might have typed earlier.
    private func applyURL(_ raw: String, persist: Bool) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // Normalise — bare "localhost:3000" → http; everything else
        // already with a scheme passes through. file:/// is honoured.
        let normalized: String = {
            if trimmed.hasPrefix("http://")
                || trimmed.hasPrefix("https://")
                || trimmed.hasPrefix("file://") {
                return trimmed
            }
            // Absolute paths → file://
            if trimmed.hasPrefix("/") {
                return "file://" + trimmed
            }
            return "http://\(trimmed)"
        }()
        urlString = normalized
        pendingUrl = normalized
        if persist {
            homeUrl = normalized
            if let pid = bridge.activeProjectId {
                UserDefaults.standard.set(normalized, forKey: storageKey(for: pid))
            }
        }
        reloadKey &+= 1
        isLoading = true
        loadError = nil
    }
}

// MARK: - WKWebView wrapper

/// Browser-shaped WKWebView wrapper. Owns the back/forward stack;
/// surfaces canGoBack / canGoForward / current URL up to the host.
private struct PreviewWebView: NSViewRepresentable {
    let urlString: String
    let reloadKey: Int
    let navTrigger: Int
    let navAction: PreviewPaneView.NavAction
    let homeUrl: String
    let onLoadStart: () -> Void
    let onLoadFinish: (URL?) -> Void
    let onLoadFail: (String) -> Void
    let onNavStateChange: (Bool, Bool) -> Void

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.setValue(false, forKey: "drawsBackground")
        // Observe back/forward availability so the toolbar buttons
        // can grey themselves out at the moment the WebView's
        // history changes.
        context.coordinator.installObservers(on: webView)
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        // Load on URL / reloadKey change.
        let urlChanged = context.coordinator.lastURL != urlString
        let reloadBumped = context.coordinator.lastReloadKey != reloadKey
        if urlChanged || reloadBumped {
            context.coordinator.lastURL = urlString
            context.coordinator.lastReloadKey = reloadKey
            if let url = URL(string: urlString) {
                onLoadStart()
                if url.isFileURL {
                    // file:// needs explicit file-system read access
                    // for relative <link href="…"> + <script src="…">
                    // to resolve from the same directory.
                    nsView.loadFileURL(
                        url,
                        allowingReadAccessTo: url.deletingLastPathComponent()
                    )
                } else {
                    nsView.load(URLRequest(url: url))
                }
            }
        }
        // Nav action triggers — back / forward / home.
        if context.coordinator.lastNavTrigger != navTrigger {
            context.coordinator.lastNavTrigger = navTrigger
            switch navAction {
            case .back:
                if nsView.canGoBack { nsView.goBack() }
            case .forward:
                if nsView.canGoForward { nsView.goForward() }
            case .home:
                if let url = URL(string: homeUrl) {
                    onLoadStart()
                    if url.isFileURL {
                        nsView.loadFileURL(
                            url,
                            allowingReadAccessTo: url.deletingLastPathComponent()
                        )
                    } else {
                        nsView.load(URLRequest(url: url))
                    }
                }
            case .none:
                break
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let parent: PreviewWebView
        var lastURL: String = ""
        var lastReloadKey: Int = -1
        var lastNavTrigger: Int = -1
        private var observations: [NSKeyValueObservation] = []

        init(parent: PreviewWebView) { self.parent = parent }

        func installObservers(on webView: WKWebView) {
            observations.append(webView.observe(\.canGoBack) { [weak self] wv, _ in
                guard let self else { return }
                Task { @MainActor in
                    self.parent.onNavStateChange(wv.canGoBack, wv.canGoForward)
                }
            })
            observations.append(webView.observe(\.canGoForward) { [weak self] wv, _ in
                guard let self else { return }
                Task { @MainActor in
                    self.parent.onNavStateChange(wv.canGoBack, wv.canGoForward)
                }
            })
            observations.append(webView.observe(\.url) { [weak self] wv, _ in
                guard let self else { return }
                // Don't echo the URL back during the initial load —
                // didFinish handles that. Only mid-flight in-page
                // navigations need this.
                Task { @MainActor in
                    if !wv.isLoading {
                        self.parent.onLoadFinish(wv.url)
                    }
                }
            })
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.onLoadFinish(webView.url)
            parent.onNavStateChange(webView.canGoBack, webView.canGoForward)
        }
        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            parent.onLoadFail(error.localizedDescription)
        }
        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            parent.onLoadFail(error.localizedDescription)
        }
    }
}
