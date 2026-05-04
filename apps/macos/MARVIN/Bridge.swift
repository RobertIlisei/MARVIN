// Bridge — JS↔Swift message channel between the WKWebView and the
// SwiftUI shell. Phase 1d/2+ groundwork.
//
// ## Why a bridge at all
//
// Phase 1a hands the entire content area to a `WKWebView`. That's
// fine when the SwiftUI shell only owns the window chrome (title
// bar, menu bar, About panel). Once we want NSToolbar buttons that
// reflect web-app state (current project, cost, model), or native
// chat that hands input back to the agent loop, the two halves
// have to talk. There are three plausible channels:
//
//   1. **`evaluateJavaScript` polling.** Swift periodically asks
//      the page for state. Cheap to wire, but laggy and wastes
//      cycles when nothing changed.
//   2. **URL hash / custom scheme navigation.** Swift sets the URL,
//      web side reads `location.hash`. Coarse and ergonomically bad
//      for anything beyond toggle commands.
//   3. **`WKScriptMessageHandler` + injected `window.marvinShell`.**
//      First-class WebKit API. Push-based, structured payloads,
//      one channel per name. This is what Apple's own apps do
//      (e.g. the Mail composer in macOS).
//
// We pick (3). The Swift side registers a single message handler
// named `marvin`. A `WKUserScript` injected at document start
// defines `window.marvinShell` so the web app sees a stable global
// regardless of when its own JS runs.
//
// ## Wire format
//
// All messages are JSON objects with a required `type` discriminator:
//
//     window.marvinShell.postMessage({ type: "hello", payload: {...} })
//
// `payload` is opaque to the bridge — each `type` defines its own
// shape. Adding a new message type is: pick a name, document it on
// the web side, add a `case` in `handle(_:)` here. No protobuf, no
// JSON Schema, no codegen — kept minimal so additions are cheap.
//
// ## Security boundary
//
// The bridge is a privileged surface: any JS running in the WebView
// can post messages. The Node sidecar's trust boundary is unchanged
// (creds, agent loop, etc. all stay there). The bridge MUST NOT:
//   • Forward shell commands.
//   • Touch the filesystem.
//   • Spawn subprocesses.
//   • Read keychain / Anthropic credentials.
// Reasonable bridge work: state mirroring (cost, project, model),
// UI intent forwarding (open-this-window, focus-toolbar-search),
// telemetry passthrough.

import Foundation
import WebKit

/// Single inbound message from the web side.
///
/// The shape is intentionally permissive — `payload` is `Any?` so
/// each type's handler decodes its own slice. If/when we have more
/// than ~5 types this should grow into typed `Codable` enums; for
/// now the cost of doing that early outweighs the value.
struct BridgeMessage {
    let type: String
    let payload: [String: Any]?
}

/// Receives JS-side messages on the `marvin` channel.
///
/// Lives at app scope — single-window app, one bridge instance, no
/// per-message-handler weakness. If we ever go multi-window, this
/// becomes per-WebView (and the WKUserContentController is created
/// fresh per-window, so duplication isn't a concern).
@MainActor
@Observable
final class MarvinBridge: NSObject, WKScriptMessageHandler {
    static let shared = MarvinBridge()

    /// Latest `document.title` posted by the web side via the
    /// `title` message. `nil` until the web side posts its first
    /// title — ContentView falls back to "MARVIN" in that case.
    /// Phase 1d uses this to mirror the React-managed title (which
    /// includes the v1.2 `(N)` pending-confirm badge) into the
    /// native NSWindow title bar.
    private(set) var webTitle: String? = nil

    /// Today's cost (USD) posted by the web side via `cost-changed`.
    /// `nil` until the web side has a project selected and a cost
    /// summary loaded — the toolbar pill hides in that case.
    /// Phase 1d.2 — mirrors what `<CostPill>` shows in the web top
    /// bar so the native toolbar pip doesn't go stale.
    private(set) var costToday: Double? = nil

    /// Active project name posted by the web side via
    /// `project-changed`. Drives the native NSWindow subtitle so
    /// the active project is always visible in the title bar.
    /// Phase 1d.3 — `nil` when no project is active.
    private(set) var projectName: String? = nil

    /// Active project workDir posted alongside `projectName`.
    /// Stored for future toolbar tooltips / About panel; not yet
    /// consumed by any view.
    private(set) var projectWorkDir: String? = nil

    /// Channel name — must match the JS-side
    /// `webkit.messageHandlers.<name>.postMessage(...)` call site.
    /// One name keeps the WebKit configuration simple; routing
    /// happens by `type` discriminator inside the payload.
    static let channelName = "marvin"

    /// Bridge protocol version. Bumped when we make a breaking
    /// change to the wire format. The web side reads this off
    /// `window.marvinShell.version` and can fall back gracefully.
    static let bridgeVersion = "0.1"

    /// Source for the `WKUserScript` injected at document start.
    /// Defines a stable `window.marvinShell` global before any of
    /// the web app's code runs. The web side checks for it via
    /// `apps/web/src/lib/marvin-shell.ts`.
    ///
    /// Frozen object so the page can't replace `postMessage` with
    /// something malicious mid-session.
    static let injectedScript: String = """
    (function () {
      if (window.marvinShell) return;
      var channel = (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(channelName)) || null;
      var shell = {
        isSwift: true,
        version: "\(bridgeVersion)",
        build: "MARVIN-Swift/0.1",
        postMessage: function (payload) {
          if (!channel) return false;
          try {
            channel.postMessage(payload);
            return true;
          } catch (_) {
            return false;
          }
        }
      };
      Object.freeze(shell);
      Object.defineProperty(window, "marvinShell", {
        value: shell,
        writable: false,
        configurable: false,
        enumerable: true
      });
    })();
    """

    /// Mount the bridge onto a fresh `WKWebViewConfiguration`.
    ///
    /// Call this from `WebView.makeNSView` BEFORE constructing the
    /// `WKWebView`. The `WKUserContentController` it lives on is
    /// owned by the configuration, which is in turn owned by the
    /// WebView, so lifetime tracks the WebView automatically.
    func install(on config: WKWebViewConfiguration) {
        let controller = config.userContentController
        // Inbound channel for web → Swift messages.
        controller.add(self, name: Self.channelName)
        // Outbound bootstrap — defines window.marvinShell at
        // document start so it's available to all web-side JS.
        let userScript = WKUserScript(
            source: Self.injectedScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        controller.addUserScript(userScript)
    }

    // MARK: - WKScriptMessageHandler

    nonisolated func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        // The protocol delivers on the main thread (per WebKit
        // docs), but the type system doesn't know that — bounce
        // through MainActor.
        let body = message.body
        Task { @MainActor in
            self.handle(body)
        }
    }

    /// Decode + dispatch a single inbound message.
    ///
    /// Errors are deliberately swallowed (logged, not raised) — the
    /// bridge sits between two processes and a malformed message
    /// from the web side should never crash the shell.
    private func handle(_ raw: Any) {
        guard let dict = raw as? [String: Any] else {
            NSLog("[MarvinBridge] dropped non-object payload: \(raw)")
            return
        }
        guard let type = dict["type"] as? String else {
            NSLog("[MarvinBridge] dropped payload without type: \(dict)")
            return
        }
        let payload = dict["payload"] as? [String: Any]
        let msg = BridgeMessage(type: type, payload: payload)
        switch msg.type {
        case "hello":
            // First message from the web side after detection.
            // Logged so the migration evaluation can confirm the
            // channel works end-to-end without manually wiring a
            // dev-tools breakpoint.
            NSLog("[MarvinBridge] hello \(payload ?? [:])")
        case "title":
            // document.title mirror — drives the native NSWindow
            // title via @Observable. The web side posts the initial
            // title on mount and re-posts on every change (e.g.
            // confirm-pending badge transitions).
            if let value = payload?["value"] as? String, !value.isEmpty {
                webTitle = value
                NSLog("[MarvinBridge] title \(value)")
            }
        case "cost-changed":
            // Today's cost (USD) — drives the native cost pill.
            // `today` is nullable on the wire: a null payload from
            // the web side (no project, no summary) clears the
            // native pill rather than leaving it stale.
            //
            // Not NSLog'd because cost-changed fires on every
            // /api/cost summary refresh — a chatty turn would flood
            // the log. The toolbar item's visibility is the live
            // signal that messages are flowing.
            if let value = payload?["today"] as? Double {
                costToday = value
            } else {
                costToday = nil
            }
        case "project-changed":
            // Active project name + workDir — drives the NSWindow
            // subtitle. Both fields nullable; null clears them.
            projectName = (payload?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            projectWorkDir = (payload?["workDir"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            NSLog("[MarvinBridge] project-changed name=\(projectName ?? "nil")")
        default:
            // Unknown type — log + ignore. Future phases add cases
            // here (cost-update, project-changed, etc.).
            NSLog("[MarvinBridge] received \(type) \(payload ?? [:])")
        }
    }
}
