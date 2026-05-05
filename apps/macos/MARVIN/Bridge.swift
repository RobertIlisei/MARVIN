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
import SwiftUI
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

/// One project entry from the registered list. Phase 1d.33 — drives
/// the File → Open Recent submenu. Identifiable so SwiftUI's ForEach
/// can key on `id` without an extra .id() modifier.
struct BridgeProject: Identifiable, Equatable {
    let id: String
    let name: String
    let workDir: String
}

/// Cost snapshot mirrored from the web `<CostPill>` via the
/// `cost-changed` message. Drives the native cost toolbar item +
/// its history popover. Mirrors the web `CostSummary` shape so the
/// same fields render in both places without translation.
struct CostSummary: Equatable {
    let today: Double
    let week: Double
    let lifetime: Double
    let turns: Int
    let inputTokens: Int
    let outputTokens: Int
    let daily: [DailyEntry]

    struct DailyEntry: Equatable, Identifiable {
        let day: String          // "YYYY-MM-DD"
        let costUsd: Double
        let turns: Int

        var id: String { day }
    }
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

    /// Full cost snapshot posted by the web side via `cost-changed`.
    /// `nil` until the web side has a project selected and a cost
    /// summary loaded — the toolbar pill hides in that case.
    /// Phase 1d.6 — drives both the at-a-glance toolbar text
    /// (today $X.YY) AND the click-to-open popover with history.
    private(set) var costSummary: CostSummary? = nil

    /// Convenience for views that only need today's number — keeps
    /// the call site terse without pulling the whole summary into
    /// the dependency.
    var costToday: Double? { costSummary?.today }

    /// Active project name posted by the web side via
    /// `project-changed`. Drives the native NSWindow subtitle so
    /// the active project is always visible in the title bar.
    /// Phase 1d.3 — `nil` when no project is active.
    private(set) var projectName: String? = nil

    /// Active project workDir posted alongside `projectName`.
    /// Stored for future toolbar tooltips / About panel; not yet
    /// consumed by any view.
    private(set) var projectWorkDir: String? = nil

    /// Active git branch + dirty-count, posted by the web side via
    /// `branch-changed`. `nil` branch when not a git repo (or no
    /// project). Phase 1d.7 — drives the NSWindow subtitle alongside
    /// projectName.
    private(set) var branch: String? = nil
    private(set) var branchDirtyCount: Int = 0

    /// User-selected executor + advisor model names, posted by the
    /// web side via `models-changed`. `nil` means "use sidecar
    /// default" (the user hasn't picked one yet). Phase 1d.15 —
    /// drives the About panel's "Active models" section.
    /// ADR-0021 M1: writable by NativePrefs directly.
    var executorModel: String? = nil
    var advisorModel: String? = nil

    /// Active theme name posted by the web side via `theme-changed`.
    /// "light" or "dark" — anything else falls back to system. The
    /// SwiftUI chrome (title bar, About, Settings) reads
    /// `preferredColorScheme` to follow the web theme so a dark
    /// WebView under a light title bar doesn't look mismatched.
    /// Phase 1d.17.
    /// ADR-0021 M1: writable by NativePrefs directly.
    var themeName: String? = nil

    /// ADR-0021 M1 — when true, the bridge silences pref-related
    /// message handlers (personality-changed, permission-changed,
    /// panes-changed, models-changed, theme-changed). Set by
    /// NativePrefs.init() once UserDefaults is the authoritative
    /// source. Prevents the web side from overwriting native prefs
    /// via bridge messages during M1–M4.
    var nativePrefsTakeover: Bool = false

    /// Coarse "MARVIN is busy / idle" flag posted via `busy-changed`.
    /// The menu-bar status item swaps between the idle (outlined
    /// nodes) and active (filled nodes) Brain Circuit SVGs based on
    /// this. Phase 1d.20. False until the web side reports a turn
    /// in flight.
    private(set) var isBusy: Bool = false

    /// Phase 5e — fine-grained marvinState mirror. The web side
    /// posts every transition through `marvin-state-changed`. The
    /// brain reads this to pick the right particle profile (calm
    /// thinking vs energetic tool-use vs writing pulse vs error
    /// flash). Coarse `isBusy` stays for the menu-bar icon swap.
    /// One of: idle | thinking | tool | writing | error | cancelling.
    private(set) var marvinState: String = "idle"

    /// Active personality ("marvin" or "neutral") posted via
    /// `personality-changed`. Drives the About panel's Personality
    /// row so the user can see which mode MARVIN is in without
    /// opening the web Settings popover. Phase 1d.32.
    /// ADR-0021 M1: writable by NativePrefs directly.
    var personality: String? = nil

    /// Phase 5d — active permission strategy ("auto" or "gated")
    /// posted via `permission-changed`. Drives the native Setup
    /// popover so the toolbar reflects the same value as the
    /// localStorage-persisted pref.
    /// ADR-0021 M1: writable by NativePrefs directly.
    var permissionStrategy: String = "auto"

    /// Phase 5d — pane visibility map posted via `panes-changed`.
    /// Drives the native Layout popover. Defaults match
    /// DEFAULT_PREFS in apps/web/src/lib/use-prefs.tsx (files +
    /// brain on; everything else off) so the popover shows the
    /// right initial state before the web side hydrates.
    struct PaneState: Equatable {
        var files: Bool = true
        var brain: Bool = true
        var graph: Bool = false
        var preview: Bool = false
        var terminal: Bool = false
    }
    /// ADR-0021 M1: writable by NativePrefs directly.
    var panes: PaneState = PaneState()

    /// Phase 5d — UI signals. Increments fire one-shot triggers
    /// (open the shortcuts sheet, open Quick Open, etc.) from app-
    /// scope menu commands into ContentView's @State without sharing
    /// SwiftUI state across scenes. ContentView observes the value
    /// change and reacts; the value itself is meaningless.
    private(set) var shortcutsTriggerCount: Int = 0
    private(set) var quickOpenTriggerCount: Int = 0

    /// Phase 5f — editor cursor state lifted onto the bridge so the
    /// app-wide bottom status bar can read it without coupling to the
    /// FileViewerView's @State. 1-indexed row/col matches every IDE
    /// (VS Code, Xcode, Cursor). FileViewerView's Coordinator pushes
    /// updates via setCursor(row:col:selectionLength:); the global
    /// AppStatusBar reads them directly.
    private(set) var cursorRow: Int = 1
    private(set) var cursorCol: Int = 1
    private(set) var cursorSelectionLength: Int = 0
    private(set) var cursorTotalLines: Int = 1
    func setCursor(row: Int, col: Int, selectionLength: Int) {
        cursorRow = row
        cursorCol = col
        cursorSelectionLength = selectionLength
    }
    func setCursorTotalLines(_ lines: Int) {
        if cursorTotalLines != lines { cursorTotalLines = lines }
    }

    func triggerShortcutsHelp() { shortcutsTriggerCount &+= 1 }
    func triggerQuickOpen()     { quickOpenTriggerCount &+= 1 }

    /// ADR-0021 M2 — apply a full project-list load from ProjectsService.
    /// Writes `projects`, `activeProjectId`, `projectName`, and
    /// `projectWorkDir` in one update so observers see a consistent
    /// snapshot. Called once on launch and after every mutation.
    func applyProjectsLoad(projects: [BridgeProject], activeId: String?) {
        self.projects = projects
        let activeProj = activeId.flatMap { id in projects.first { $0.id == id } }
        self.activeProjectId = activeId
        self.projectName    = activeProj?.name
        self.projectWorkDir = activeProj?.workDir
    }

    /// Phase 5f — apply a project selection locally without waiting
    /// for the WebView's React re-render to come back through
    /// `project-changed`. The native surfaces (file tree, editor,
    /// chat hydrate, file viewer) all observe `projectWorkDir` /
    /// `projectName` / `activeProjectId`, so updating them
    /// synchronously kicks the Swift-side fetches in parallel with
    /// the WebView's heavier re-render pipeline. The web side
    /// eventually echoes the same values via its own announcement;
    /// because they match, the second update is a no-op.
    ///
    /// Returns false (and no-ops) when the id isn't in the known
    /// project list — the WebView still owns project bookkeeping
    /// for new projects we haven't seen yet, so we don't bypass
    /// it for unknowns.
    @discardableResult
    func applyLocalProjectSelection(id: String) -> Bool {
        guard let proj = projects.first(where: { $0.id == id }) else {
            return false
        }
        if activeProjectId != id {
            activeProjectId = id
        }
        if projectName != proj.name {
            projectName = proj.name
        }
        if projectWorkDir != proj.workDir {
            projectWorkDir = proj.workDir
        }
        return true
    }

    /// Phase 5e — request the preview pane to load a URL. Used by
    /// the "Open in Browser" affordance on HTML files in the tree
    /// + editor. The preview pane observes `previewLoadCommand` and
    /// applies the URL when it changes; the counter forces a fresh
    /// signal even when the user re-requests the same URL (refresh).
    private(set) var previewLoadURL: String? = nil
    private(set) var previewLoadCommand: Int = 0
    func openInPreview(url: String) {
        previewLoadURL = url
        previewLoadCommand &+= 1
        // Ensure the preview pane is actually visible — otherwise
        // "Open in Browser" silently does nothing the first time.
        if !panes.preview {
            NativePrefs.shared.togglePane("preview")
        }
    }

    /// Registered projects from the web side, in the same order the
    /// web picker shows them (most-recently-used first). Drives the
    /// native File → Open Recent submenu. Phase 1d.33. Empty until
    /// the web side reports a list.
    private(set) var projects: [BridgeProject] = []

    /// Active project id posted alongside the session so the native
    /// chat can hit GET /api/sessions/:id?projectId=… without having
    /// to re-derive the slug from workDir. Phase 2h. Nil when no
    /// project is active.
    private(set) var activeProjectId: String? = nil

    /// In-flight marvinSessionId for the active project, posted via
    /// `session-changed`. The native chat surface watches this to
    /// hydrate transcripts on project switch and attach to live
    /// turns. Phase 2h. Nil when there's no session yet (project
    /// just got picked, or no prior session on disk). Drops the
    /// previous value when the web side reports null — that signals
    /// a project clear or fresh start, and the native list should
    /// follow.
    private(set) var activeMarvinSessionId: String? = nil

    /// Phase 5a — currently-selected file path in the native file
    /// tree. Drives the native file viewer's content. The native
    /// tree (FileTreeView.selectRow) writes via `setSelectedFile`;
    /// the file viewer reads via @Observable. Kept distinct from
    /// the web side's `select-file` dispatchWebCommand so the two
    /// surfaces are independently driven during the Phase 5a→5c
    /// promotion (the WebView's Monaco still consumes the
    /// `select-file` event; the native viewer reads from here).
    private(set) var selectedFilePath: String? = nil

    /// Phase 5c — ordered list of open file tabs. `setSelectedFile`
    /// promotes a path into this list (appending if not already
    /// present), and `closeFile` removes it. The tab bar at the top
    /// of FileViewerView renders directly off this. Empty list +
    /// `selectedFilePath == nil` is the IDE "no editor" state.
    ///
    /// Kept ordered (insertion order) so the tab bar reads naturally
    /// — most-recently-opened on the right is the IDE convention
    /// (VS Code, Xcode). Closing the active tab falls back to the
    /// previous tab in the list (right-then-left), matching VS
    /// Code's behaviour.
    private(set) var openFiles: [String] = []

    /// Phase 5c — open the file in a tab and make it active. If the
    /// path is already in `openFiles` we just refocus; otherwise we
    /// append it. Pass nil to clear (no active tab; openFiles is
    /// untouched so the user can re-pick from the bar).
    func setSelectedFile(_ path: String?) {
        guard let path, !path.isEmpty else {
            selectedFilePath = nil
            return
        }
        if !openFiles.contains(path) {
            openFiles.append(path)
        }
        selectedFilePath = path
    }

    /// Phase 5c — close one open-file tab. Removing the active tab
    /// promotes a neighbour: prefer the tab to the right (the one
    /// that "shifts left" into the closed slot), then fall back to
    /// the tab to the left, then nil if the list is empty. Matches
    /// VS Code's tab-close behaviour.
    func closeFile(_ path: String) {
        guard let idx = openFiles.firstIndex(of: path) else {
            return
        }
        openFiles.remove(at: idx)
        if selectedFilePath == path {
            if idx < openFiles.count {
                selectedFilePath = openFiles[idx]
            } else if idx > 0 {
                selectedFilePath = openFiles[idx - 1]
            } else {
                selectedFilePath = nil
            }
        }
    }

    /// Phase 5c — drop a file's tab in response to a path-level
    /// event the user didn't trigger directly (rename, delete). The
    /// caller is responsible for any path remapping (rename hands
    /// off via `renameOpenFile(from:to:)` which preserves position).
    func renameOpenFile(from oldPath: String, to newPath: String) {
        guard let idx = openFiles.firstIndex(of: oldPath) else { return }
        openFiles[idx] = newPath
        if selectedFilePath == oldPath {
            selectedFilePath = newPath
        }
    }

    /// SwiftUI ColorScheme equivalent of the web theme. `nil`
    /// preserves the user's macOS system preference for the SwiftUI
    /// surfaces (used when the bridge hasn't reported a theme yet).
    var preferredColorScheme: ColorScheme? {
        switch themeName {
        case "dark": .dark
        case "light": .light
        default: nil
        }
    }

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
    ///
    /// Also stamps `<html data-host-shell="swift">` here, before
    /// React paints, so CSS rules that hide web-side controls with
    /// native equivalents (cost pill, future toolbar items) take
    /// effect on first paint without a flicker. The web-side
    /// `announceShell()` re-stamps the same attribute as a fallback.
    static let injectedScript: String = """
    (function () {
      if (window.marvinShell) return;
      try {
        if (document.documentElement) {
          document.documentElement.setAttribute("data-host-shell", "swift");
        }
      } catch (_) {}
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
            // Full cost snapshot — drives the native cost pill +
            // popover. The web side sends either a complete summary
            // or `{ today: null }` to clear (no project / no
            // summary). Decoded manually rather than through Codable
            // because the inbound shape is `[String: Any]`; the
            // round-trip-through-JSONSerialization dance isn't
            // worth the cost for ~6 fields + a small array.
            //
            // Not NSLog'd because cost-changed fires on every
            // /api/cost summary refresh — a chatty turn would flood
            // the log. The toolbar item's visibility is the live
            // signal that messages are flowing.
            if let payload, let today = payload["today"] as? Double {
                let dailyRaw = payload["daily"] as? [[String: Any]] ?? []
                let daily: [CostSummary.DailyEntry] = dailyRaw.compactMap { row in
                    guard let day = row["day"] as? String,
                          let cost = row["costUsd"] as? Double,
                          let turns = row["turns"] as? Int else { return nil }
                    return CostSummary.DailyEntry(day: day, costUsd: cost, turns: turns)
                }
                costSummary = CostSummary(
                    today: today,
                    week: payload["week"] as? Double ?? 0,
                    lifetime: payload["lifetime"] as? Double ?? 0,
                    turns: payload["turns"] as? Int ?? 0,
                    inputTokens: payload["inputTokens"] as? Int ?? 0,
                    outputTokens: payload["outputTokens"] as? Int ?? 0,
                    daily: daily
                )
            } else {
                costSummary = nil
            }
        case "project-changed":
            // Active project name + workDir — drives the NSWindow
            // subtitle. Both fields nullable; null clears them.
            projectName = (payload?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            projectWorkDir = (payload?["workDir"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            NSLog("[MarvinBridge] project-changed name=\(projectName ?? "nil")")
        case "branch-changed":
            // Active git branch + dirty-count — appended to the
            // NSWindow subtitle. Empty/nil branch means not a git
            // repo; subtitle falls back to just projectName.
            // Not NSLog'd because branch-changed fires on every
            // /api/files/status refresh (after every completed turn);
            // the live subtitle is the visible signal.
            branch = (payload?["branch"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            branchDirtyCount = (payload?["dirtyCount"] as? Int) ?? 0
        case "models-changed":
            // ADR-0021 M1: silenced once NativePrefs takes over.
            guard !nativePrefsTakeover else { break }
            // User-selected executor / advisor models. Both nullable
            // — null means "fall back to whatever the sidecar's
            // /api/health reports as defaultModel". Drives the About
            // panel's Active models section.
            executorModel = (payload?["executor"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            advisorModel = (payload?["advisor"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        case "theme-changed":
            // ADR-0021 M1: silenced once NativePrefs takes over.
            guard !nativePrefsTakeover else { break }
            // Active theme name from the web side. Drives the
            // SwiftUI chrome's color scheme via `preferredColorScheme`.
            // Anything other than "light"/"dark" falls back to
            // system preference. Logged because theme-changed is
            // infrequent (only on initial mount + manual toggle) so
            // the log stays useful telemetry without flooding.
            let value = payload?["value"] as? String
            themeName = (value == "light" || value == "dark") ? value : nil
            NSLog("[MarvinBridge] theme-changed value=\(themeName ?? "nil")")
        case "busy-changed":
            // Web side's coarse busy flag — flips on at the start of
            // a turn and off when MARVIN goes back to idle. Drives
            // the menu-bar status item's idle/active icon swap. Not
            // NSLog'd because busy-changed fires on every state
            // transition (including tool / writing) — chatty.
            let busy = (payload?["busy"] as? Bool) ?? false
            isBusy = busy
        case "marvin-state-changed":
            // Phase 5e — full state mirror for the native brain. One
            // of idle | thinking | tool | writing | error |
            // cancelling. Anything else falls back to "idle".
            let v = (payload?["value"] as? String) ?? "idle"
            switch v {
            case "idle", "thinking", "tool", "writing", "error", "cancelling":
                if marvinState != v {
                    NSLog("[MarvinBridge] marvin-state-changed \(marvinState) → \(v)")
                }
                marvinState = v
            default:
                marvinState = "idle"
            }
        case "personality-changed":
            // ADR-0021 M1: silenced once NativePrefs takes over.
            guard !nativePrefsTakeover else { break }
            // Active personality from the web Settings popover.
            // "marvin" | "neutral"; anything else falls back to nil.
            // Drives the About panel's Personality row.
            let value = payload?["value"] as? String
            personality = (value == "marvin" || value == "neutral") ? value : nil
            NSLog("[MarvinBridge] personality-changed value=\(personality ?? "nil")")
        case "permission-changed":
            // ADR-0021 M1: silenced once NativePrefs takes over.
            guard !nativePrefsTakeover else { break }
            // Phase 5d — auto / gated. Echoed by the prefs context on
            // every change + once on hydrate; the native Setup popover
            // reads from here to render the toggle's current state.
            let value = payload?["value"] as? String
            if value == "auto" || value == "gated" {
                permissionStrategy = value!
            }
        case "panes-changed":
            // ADR-0021 M1: silenced once NativePrefs takes over.
            guard !nativePrefsTakeover else { break }
            // Phase 5d — pane visibility map (files / brain / graph /
            // preview / terminal). Decoded loosely; missing keys keep
            // their previous value so a partial payload doesn't
            // collapse the layout.
            if let p = payload {
                var next = panes
                if let v = p["files"] as? Bool { next.files = v }
                if let v = p["brain"] as? Bool { next.brain = v }
                if let v = p["graph"] as? Bool { next.graph = v }
                if let v = p["preview"] as? Bool { next.preview = v }
                if let v = p["terminal"] as? Bool { next.terminal = v }
                panes = next
            }
        case "session-changed":
            // Phase 2h — paired (projectId, marvinSessionId) update
            // from the web side. Both can be null independently:
            // null projectId = no project active; null marvinSessionId
            // = project active but no turn started yet (or no prior
            // session file for it). The native chat surface keys
            // its hydrate / attach logic off these — see
            // ChatPreviewView's onChange wiring.
            //
            // NSLog'd because session changes are infrequent (once
            // per project switch / first turn) and the trail is
            // useful when debugging hydrate failures.
            let pid = (payload?["projectId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let sid = (payload?["marvinSessionId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            activeProjectId = pid
            activeMarvinSessionId = sid
            NSLog("[MarvinBridge] session-changed projectId=\(pid ?? "nil") sid=\(sid ?? "nil")")
        case "projects-changed":
            // Registered project list. Drives File → Open Recent.
            // Decoded loosely — drop entries missing required fields
            // rather than failing the whole message; a malformed
            // entry shouldn't blank out the menu.
            let raw = payload?["projects"] as? [[String: Any]] ?? []
            projects = raw.compactMap { row in
                guard let id = row["id"] as? String, !id.isEmpty,
                      let name = row["name"] as? String, !name.isEmpty,
                      let workDir = row["workDir"] as? String else {
                    return nil
                }
                return BridgeProject(id: id, name: name, workDir: workDir)
            }
        default:
            // Unknown type — log + ignore. Future phases add cases
            // here (cost-update, project-changed, etc.).
            NSLog("[MarvinBridge] received \(type) \(payload ?? [:])")
        }
    }
}
