// WebView — `NSViewRepresentable` wrapper around `WKWebView`.
//
// Phase 1a island: a single full-bleed WebView pointed at the
// Node sidecar (`http://localhost:3030`) hosts the entire MARVIN
// web UI. The SwiftUI process owns the window, menu bar, and
// connection probe; everything below the shell still renders in
// WebKit until later phases progressively replace pieces with
// native AppKit views. See ADR-0016 §Migration phases.
//
// Architectural contract — what this is allowed to do:
//   • Load the loopback URL.
//   • Forward link clicks bound for non-loopback hosts to the
//     user's default browser (NSWorkspace).
//   • Tag the user-agent so the web app can detect "running in
//     SwiftUI shell" once we want to hide the web-rendered top
//     bar (Phase 1d).
//
// What this MUST NOT do:
//   • Read or persist Anthropic credentials. The Node sidecar is
//     the trust boundary (ADR-0016).
//   • Inject scripts that could exfiltrate session content.
//     The user-agent suffix is the only injection allowed.

import SwiftUI
@preconcurrency import WebKit

/// Bridge between the SwiftUI menu bar (commands fire outside the
/// view hierarchy) and the live `WKWebView`. Single-window app, so a
/// shared instance is fine — the WebView registers itself on mount
/// and clears on tear-down. Phase 1+ may need a per-window registry
/// if MARVIN ever opens multiple windows.
@MainActor
@Observable
final class WebViewCommands {
    static let shared = WebViewCommands()
    weak var webView: WKWebView?

    /// Mirrors `WKWebView.isLoading` so SwiftUI can show / hide a
    /// progress indicator without touching the WebView directly.
    /// Kept up to date by the Coordinator's KVO observers.
    var isLoading: Bool = false

    /// Mirrors `WKWebView.estimatedProgress` (0.0–1.0). Drives the
    /// thin Safari-style progress bar at the top of the WebView
    /// during page loads. Phase 1d.10.
    var loadProgress: Double = 0

    /// Page-level content zoom (1.0 = 100%). Persisted to
    /// UserDefaults so the user's preferred size survives across
    /// launches. Clamped to [0.5, 3.0] — beyond that the layout
    /// breaks down (toolbar items overlap, text wraps badly).
    /// Phase 1d.11. WebView reads this on mount and sets
    /// `webView.pageZoom`; menu commands mutate via setZoom(_:).
    var zoomLevel: Double = {
        let saved = UserDefaults.standard.double(forKey: "marvin.zoomLevel")
        return saved == 0 ? 1.0 : saved
    }() {
        didSet {
            UserDefaults.standard.set(zoomLevel, forKey: "marvin.zoomLevel")
            webView?.pageZoom = CGFloat(zoomLevel)
        }
    }

    /// Soft reload — uses the cache. Cheap, the common "I want the
    /// page to refetch" action. Maps to ⌘R in the View menu.
    func reload() {
        webView?.reload()
    }

    /// Hard reload — bypasses cache via `reloadFromOrigin()`. Use
    /// when the page is showing stale assets after a sidecar rebuild.
    /// Maps to ⇧⌘R in the View menu.
    func forceReload() {
        webView?.reloadFromOrigin()
    }

    /// Dispatch a custom DOM event the web app can listen for.
    /// The native menu bar uses this to invoke the web app's
    /// existing handlers (new session, project picker, theme
    /// toggle, shortcuts dialog) without forking the React state
    /// into Swift. The web side wires `window.addEventListener` in
    /// `apps/web/src/lib/marvin-shell.ts`. Fire-and-forget — there's
    /// no return value; if the page hasn't loaded yet, the event is
    /// silently dropped (next click works once the page is up).
    func dispatchWebCommand(_ name: String) {
        // Sanitise: only A-Za-z0-9- characters allowed. Defends
        // against accidental quote injection if a future caller
        // ever derives the name from user input. Not a security
        // boundary (the call site is local), just hygiene.
        let safe = name.filter { $0.isLetter || $0.isNumber || $0 == "-" }
        guard !safe.isEmpty else { return }
        let js = "window.dispatchEvent(new CustomEvent('marvin:\(safe)'))"
        webView?.evaluateJavaScript(js)
    }

    /// Bump zoom by 10%. Hits the [0.5, 3.0] clamp at the edges.
    /// Maps to ⌘= in the View menu (macOS displays as ⌘+).
    func zoomIn() {
        setZoom(zoomLevel * 1.1)
    }

    /// Cut zoom by 10%. Maps to ⌘- in the View menu.
    func zoomOut() {
        setZoom(zoomLevel / 1.1)
    }

    /// Reset to 100%. Maps to ⌘0 in the View menu.
    func resetZoom() {
        setZoom(1.0)
    }

    private func setZoom(_ level: Double) {
        zoomLevel = min(max(level, 0.5), 3.0)
    }

    // MARK: - Find in page (Phase 1d.12)

    /// Whether the find bar is currently shown over the WebView.
    /// Toggled by ⌘F (show) and Esc / Done button (hide).
    var isFindVisible: Bool = false

    /// Current search query. Bound to the find bar's TextField; the
    /// WebView re-searches on every change so results highlight as
    /// the user types — matches Safari/Mail's find-bar behavior.
    var findText: String = "" {
        didSet {
            guard isFindVisible, oldValue != findText else { return }
            if findText.isEmpty {
                findCount = 0
            } else {
                findNext()
                updateFindCount()
            }
        }
    }

    /// Total occurrences of `findText` in the live document body.
    /// Updated after every successful search via a JS occurrence
    /// counter — `WKFindResult` only returns `matchFound: Bool`,
    /// not a count, so we compute it ourselves. 0 when empty query
    /// or no matches; the find bar renders "no matches" in that
    /// case. Phase 1d.13.
    var findCount: Int = 0

    /// Open the find bar and focus its TextField.
    func showFind() {
        isFindVisible = true
    }

    /// Close the find bar and clear the search query so a stale
    /// match doesn't linger when reopened.
    func hideFind() {
        isFindVisible = false
        findText = ""
        findCount = 0
    }

    /// Forward search. WKFindConfiguration handles the highlight
    /// automatically; we kick the JS occurrence counter alongside
    /// so the find bar can show "X matches".
    func findNext() {
        guard let webView, !findText.isEmpty else { return }
        let config = WKFindConfiguration()
        config.backwards = false
        config.wraps = true
        webView.find(findText, configuration: config) { _ in }
    }

    /// Backward search — ⇧⌘G or the find bar's chevron-up button.
    func findPrevious() {
        guard let webView, !findText.isEmpty else { return }
        let config = WKFindConfiguration()
        config.backwards = true
        config.wraps = true
        webView.find(findText, configuration: config) { _ in }
    }

    /// Refresh `findCount` by counting case-insensitive occurrences
    /// of `findText` in the document's text content. Uses an
    /// `indexOf` loop in JS — avoids the regex-escape dance you'd
    /// need with `String.match(/.../gi)`. Result is bounced through
    /// `Task { @MainActor }` because `evaluateJavaScript`'s callback
    /// fires on an unspecified queue.
    private func updateFindCount() {
        guard let webView else { return }
        if findText.isEmpty {
            findCount = 0
            return
        }
        let safe = findText
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let js = """
        (function() {
            var n = "\(safe)".toLowerCase();
            if (!n) return 0;
            var h = (document.body.innerText || '').toLowerCase();
            var c = 0, i = 0;
            while ((i = h.indexOf(n, i)) !== -1) { c++; i += n.length; }
            return c;
        })()
        """
        webView.evaluateJavaScript(js) { [weak self] result, _ in
            let count = (result as? Int) ?? 0
            Task { @MainActor in
                self?.findCount = count
            }
        }
    }
}

struct WebView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()

        // JavaScript is required (Next.js + React). No way around it.
        let pagePrefs = WKWebpagePreferences()
        pagePrefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = pagePrefs

        // Phase 1d/2+ groundwork — JS↔Swift bridge. Adds the
        // `marvin` message channel + injects `window.marvinShell`
        // at document start. See Bridge.swift for the wire format
        // and security boundary. Idempotent within a config; safe
        // to call once per WebView mount (each WebView gets a
        // fresh WKWebViewConfiguration anyway).
        MarvinBridge.shared.install(on: config)

        // Web Inspector — explicitly OFF.
        //
        // Tauri shipped an Inspect Element / devtools right-click
        // entry by default, which leaked the "this is just a wrapped
        // browser tab" feeling we're migrating away from. We turn
        // both signals off:
        //
        //   • `developerExtrasEnabled` (private KVC key, all macOS
        //     versions) — controls whether "Inspect Element" appears
        //     in the right-click menu and whether ⌘⌥I opens devtools.
        //   • `isInspectable` (public API on macOS 13.3+) — controls
        //     whether Safari's Develop menu can attach to this
        //     WebView remotely.
        //
        // Both default to false on a fresh WKWebView, but we set
        // them explicitly so a future preferences change can't flip
        // the surface back on by accident. Re-enable only by editing
        // this file — never via a menu toggle, never via DEBUG flag.
        config.preferences.setValue(false, forKey: "developerExtrasEnabled")

        // CuratedWebView (defined below) is a thin WKWebView subclass
        // that overrides `willOpenMenu(_:with:)` to strip the
        // browser-style entries (Reload, Back/Forward, Inspect
        // Element, Save Image As, Search With…) from the right-click
        // context menu before AppKit shows it. Using a subclass is
        // the only public-API path on macOS — `WKUIDelegate` has no
        // context-menu hook outside iOS.
        let webView = CuratedWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        if #available(macOS 13.3, *) {
            webView.isInspectable = false
        }

        // Don't paint a solid white during load — let the SwiftUI
        // background bleed through. Without this you get a flash of
        // white in dark mode every time the WebView mounts.
        webView.setValue(false, forKey: "drawsBackground")

        // Pinch-to-zoom is the wrong UX for an IDE-shaped UI; the web
        // app handles font/zoom controls itself. Forward/back swipe
        // gestures match Safari/Tauri behaviour.
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = true

        // Tag the user-agent so the web app can detect the SwiftUI
        // shell. Phase 1d will use this to hide the web-rendered top
        // bar (replaced by NSToolbar). For now, harmless metadata.
        let baseUA = (webView.value(forKey: "userAgent") as? String) ?? ""
        webView.customUserAgent = baseUA + " MARVIN-Swift/0.1"

        // Apply persisted zoom (Phase 1d.11) before load so the
        // initial paint already at the user's preferred size — no
        // flash of 100% before the persisted level kicks in.
        webView.pageZoom = CGFloat(WebViewCommands.shared.zoomLevel)

        webView.load(URLRequest(url: url))

        // Register with the menu-command bridge so View → Reload
        // (⌘R) and Force Reload (⇧⌘R) reach this WebView.
        WebViewCommands.shared.webView = webView

        // Phase 1d.10 — mirror `isLoading` and `estimatedProgress`
        // into the @Observable singleton so the SwiftUI progress
        // bar can react. KVO-via-NSKeyValueObservation, observers
        // owned by the Coordinator so they cancel when the WebView
        // tears down.
        context.coordinator.observe(webView)

        return webView
    }

    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        // Clear the singleton's weak ref proactively. The weak ref
        // would clear on its own when the WebView deallocates, but
        // SwiftUI sometimes keeps NSViewRepresentables alive past
        // their visible lifetime, and we don't want a stale pointer
        // surviving an online → offline transition.
        if WebViewCommands.shared.webView === nsView {
            WebViewCommands.shared.webView = nil
        }
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        // Reload only on actual URL changes. Phase 1a keeps the URL
        // constant (loopback only), but later phases may swap it
        // (e.g. project switching driven from the native menu bar).
        if nsView.url != url {
            nsView.load(URLRequest(url: url))
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        /// KVO tokens for the load-progress observers. Held here so
        /// they live as long as the WebView's Coordinator and clean
        /// up automatically when the Representable tears down.
        private var observers: [NSKeyValueObservation] = []

        /// Wire up KVO on the new WebView's load state. Idempotent
        /// per Coordinator instance — observers replace any prior
        /// set. Updates the @Observable singleton on the main actor.
        func observe(_ webView: WKWebView) {
            observers.removeAll()
            observers.append(webView.observe(\.isLoading, options: [.new, .initial]) { _, change in
                guard let value = change.newValue else { return }
                Task { @MainActor in
                    WebViewCommands.shared.isLoading = value
                }
            })
            observers.append(webView.observe(\.estimatedProgress, options: [.new, .initial]) { _, change in
                guard let value = change.newValue else { return }
                Task { @MainActor in
                    WebViewCommands.shared.loadProgress = value
                }
            })
        }

        /// Route external link clicks to NSWorkspace; keep loopback
        /// + file navigation in-app. Programmatic navigation
        /// (`.other`, `.reload`, `.backForward`) always allowed —
        /// the SSE / fetch traffic the web app uses doesn't surface
        /// here anyway, but defensively allow non-link cases.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let dest = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let host = dest.host?.lowercased() ?? ""
            let isLoopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
            if isLoopback || dest.isFileURL {
                decisionHandler(.allow)
                return
            }
            // External hosts: only intervene on user-initiated link
            // clicks. Anything else (form submit, programmatic) is
            // unlikely to fire for non-loopback URLs in our app, but
            // if it does, allow rather than silently break.
            if navigationAction.navigationType == .linkActivated {
                NSWorkspace.shared.open(dest)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

    }
}

/// `WKWebView` subclass that curates the default right-click menu
/// before AppKit shows it.
///
/// The default WebKit context menu is a stack of browser-style items —
/// Reload, Back / Forward, Open Frame in New Window, Save Image As,
/// Search With…, Inspect Element — that makes the app feel like a
/// wrapped Chrome tab and duplicates the native menu bar's View →
/// Reload entry. We strip those out so what remains is the IDE-style
/// minimum: Cut / Copy / Paste / Select All on text selections,
/// links rendered as plain links, and nothing else.
///
/// `willOpenMenu(_:with:)` is the AppKit-level hook called whenever
/// any NSView is about to present a context menu — it runs after
/// WebKit has populated the menu but before macOS shows it. Public
/// API, no private SPI required, no `WKUIDelegate` extension needed.
/// The macOS public WKUIDelegate has no equivalent of iOS's
/// `contextMenuConfigurationForElement` — this is the supported path.
///
/// Identifiers come from the open-source WebKit headers
/// (`WKMenuItemIdentifier*`). Items without a stable identifier
/// (Cut / Copy / Paste added by NSText hosts) survive untouched.
final class CuratedWebView: WKWebView {
    private static let dropIdentifiers: Set<String> = [
        "WKMenuItemIdentifierReload",
        "WKMenuItemIdentifierGoBack",
        "WKMenuItemIdentifierGoForward",
        "WKMenuItemIdentifierInspectElement",
        "WKMenuItemIdentifierShowHideMediaControls",
        "WKMenuItemIdentifierToggleEnhancedFullScreen",
        "WKMenuItemIdentifierToggleFullScreen",
        "WKMenuItemIdentifierShareMenu",
        "WKMenuItemIdentifierSpeechMenu",
        "WKMenuItemIdentifierLookUp",
        "WKMenuItemIdentifierTranslate",
        "WKMenuItemIdentifierOpenFrameInNewWindow",
        "WKMenuItemIdentifierOpenLinkInNewWindow",
        "WKMenuItemIdentifierOpenImageInNewWindow",
        "WKMenuItemIdentifierOpenMediaInNewWindow",
        "WKMenuItemIdentifierDownloadLinkedFile",
        "WKMenuItemIdentifierDownloadImage",
        "WKMenuItemIdentifierDownloadMedia",
        "WKMenuItemIdentifierSearchWeb",
    ]

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        for item in menu.items.reversed() {
            if let id = item.identifier?.rawValue,
               Self.dropIdentifiers.contains(id) {
                menu.removeItem(item)
            }
        }
        Self.collapseSeparators(in: menu)
    }

    private static func collapseSeparators(in menu: NSMenu) {
        while let first = menu.items.first, first.isSeparatorItem {
            menu.removeItem(first)
        }
        while let last = menu.items.last, last.isSeparatorItem {
            menu.removeItem(last)
        }
        var i = 0
        while i < menu.items.count - 1 {
            if menu.items[i].isSeparatorItem && menu.items[i + 1].isSeparatorItem {
                menu.removeItem(at: i + 1)
            } else {
                i += 1
            }
        }
    }
}
