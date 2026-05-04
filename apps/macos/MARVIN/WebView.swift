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

        // Enable the WebKit inspector in DEBUG builds — same affordance
        // Tauri ships. Right-click → Inspect Element. KVC-set because
        // it's not exposed publicly until macOS 13.3+ and we want a
        // single code path that works on Sonoma 14.0.
        #if DEBUG
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        #endif

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator

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

        webView.load(URLRequest(url: url))

        // Register with the menu-command bridge so View → Reload
        // (⌘R) and Force Reload (⇧⌘R) reach this WebView.
        WebViewCommands.shared.webView = webView

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
