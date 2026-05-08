// Bridge — ADR-0021 M5: WebView removed. MarvinBridge is now a pure
// @Observable state bucket read by SwiftUI views. All state is written
// by the native services (NativePrefs, ProjectsService, CostService,
// BranchService, ChatPreviewModel). No WKScriptMessageHandler,
// no injected JS, no WebView dependency.

import Foundation
import SwiftUI

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

@MainActor
@Observable
final class MarvinBridge {
    static let shared = MarvinBridge()

    /// Latest `document.title` posted by the web side via the
    /// `title` message. `nil` until the web side posts its first
    /// title — ContentView falls back to "MARVIN" in that case.
    /// Phase 1d uses this to mirror the React-managed title (which
    /// includes the v1.2 `(N)` pending-confirm badge) into the
    /// native NSWindow title bar.
    private(set) var webTitle: String? = nil

    /// Full cost snapshot — drives the at-a-glance toolbar text
    /// (today $X.YY) AND the click-to-open history popover.
    /// Phase 1d.6. ADR-0021 M3: written by CostService directly.
    var costSummary: CostSummary? = nil

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

    /// Active git branch + dirty-count. Phase 1d.7 — drives the
    /// NSWindow subtitle alongside projectName.
    /// ADR-0021 M3: written by BranchService directly.
    var branch: String? = nil
    var branchDirtyCount: Int = 0

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

    /// Coarse "MARVIN is busy / idle" flag. The menu-bar status item
    /// swaps between the idle and active Brain Circuit SVGs based on
    /// this. Phase 1d.20. ADR-0021 M4: written by ChatPreviewModel
    /// directly from the SSE stream.
    var isBusy: Bool = false

    /// Fine-grained marvinState mirror. The brain reads this to pick
    /// the right particle profile. One of: idle | thinking | tool |
    /// writing | error | cancelling. ADR-0021 M4: written by
    /// ChatPreviewModel directly from the SSE stream.
    var marvinState: String = "idle"

    /// Resident-context tokens (ADR-0022 §2). The bytes the model
    /// walks every turn — drives latency. `cache_read + input` from
    /// the latest assistant cli.event's `usage`. The bottom status
    /// bar reads this to render the `ctx N K` segment with a
    /// 4-band colour ramp (40K / 80K / 140K). Nil when no assistant
    /// turn has yet emitted usage on this session.
    var residentContextTokens: Int? = nil

    /// Cache-creation tokens billed *this turn* (ADR-0022 §2). Shown
    /// only in the hover tooltip so the user can see the cost
    /// breakdown. Not added to `residentContextTokens` — those are
    /// orthogonal axes. Nil when no assistant turn has emitted usage.
    var billableThisTurn: Int? = nil

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

    /// User-facing thinking mode: "fast" | "thinking" | "max".
    /// Maps to the SDK's `effort` field in the runtime layer (see
    /// `effortForThinkingMode`). The toolbar picker writes here via
    /// NativePrefs; ChatPreviewView reads it when minting a turn so
    /// the chosen mode reaches the sidecar in the same request.
    var thinkingMode: String = "thinking"

    /// Per-file porcelain status from `git status --porcelain=v1`.
    /// Keyed by absolute path; value is the trimmed two-char code
    /// (e.g. "M" for modified, "A" for added, "??" for untracked,
    /// "D" for deleted, "MM" for staged-and-modified). Empty when
    /// the project isn't a git repo or the poll hasn't completed
    /// yet. Drives the badges in FileTreeView so the user can see
    /// at a glance which files MARVIN (or anything else) touched.
    /// Populated by BranchService on its 15s poll + on every
    /// turn.completed kick.
    var dirtyStatus: [String: String] = [:]

    /// Phase 5d — pane visibility map posted via `panes-changed`.
    /// Drives the native Layout popover. Defaults match
    /// DEFAULT_PREFS in sidecar/src/lib/use-prefs.tsx (files +
    /// brain on; everything else off) so the popover shows the
    /// right initial state before the web side hydrates.
    struct PaneState: Equatable {
        var files: Bool = true
        var brain: Bool = true
        var graph: Bool = false
        var preview: Bool = false
        var terminal: Bool = false
        var problems: Bool = false
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

    private(set) var symbolSearchTriggerCount: Int = 0
    private(set) var buildTaskTriggerCount: Int = 0
    /// M7 — command string to inject into the terminal pane.
    private(set) var pendingTerminalCommand: String? = nil

    func triggerShortcutsHelp()  { shortcutsTriggerCount   &+= 1 }
    func triggerQuickOpen()      { quickOpenTriggerCount    &+= 1 }
    func triggerSymbolSearch()   { symbolSearchTriggerCount &+= 1 }
    func triggerBuildTask()      { buildTaskTriggerCount    &+= 1 }
    func triggerTerminalCommand(_ cmd: String) {
        pendingTerminalCommand = cmd
    }

    func consumePendingTerminalCommand() {
        pendingTerminalCommand = nil
    }

    // MARK: - Indent style (M1)

    /// Editor indent size preference. 0 = use tab character; any
    /// positive value = that many spaces. Stored in NativePrefs /
    /// UserDefaults; read here by AppStatusBar and FileViewerView.
    var indentSize: Int = 4

    // MARK: - Notifications (M1)

    struct NotificationEntry: Identifiable {
        let id = UUID()
        let message: String
        let timestamp: Date
        var isRead: Bool = false
    }

    private(set) var notifications: [NotificationEntry] = []
    private(set) var unreadNotificationCount: Int = 0

    func appendNotification(_ message: String) {
        notifications.append(NotificationEntry(message: message, timestamp: Date()))
        unreadNotificationCount = notifications.filter { !$0.isRead }.count
    }

    func markAllNotificationsRead() {
        for i in notifications.indices { notifications[i].isRead = true }
        unreadNotificationCount = 0
    }

    // MARK: - Diagnostics (M8 infrastructure)

    /// Diagnostic counters. Written by DiagnosticsService (M8).
    /// Rendered as ⊗N ⚠N in the left status bar cluster.
    var errorCount: Int = 0
    var warningCount: Int = 0

    /// M8: structured diagnostic items for the Problems panel.
    var diagnosticItems: [DiagnosticItem] = []

    func applyDiagnostics(_ items: [DiagnosticItem]) {
        diagnosticItems = items
        errorCount   = items.filter { $0.severity == .error }.count
        warningCount = items.filter { $0.severity == .warning }.count
    }

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
            persistFileState()
            return
        }
        if !openFiles.contains(path) {
            openFiles.append(path)
        }
        selectedFilePath = path
        persistFileState()
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
        persistFileState()
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
        persistFileState()
    }

    /// Restore the persisted tab set + selected file for a project.
    /// Called after `applyProjectsLoad` / `applyLocalProjectSelection`
    /// so the editor reopens to the same state on relaunch / project
    /// switch. Bypasses `setSelectedFile` so the writes are silent
    /// (no ping-pong with NativePrefs during restore).
    func restoreFileState(forProject projectId: String) {
        let prefs = NativePrefs.shared
        let tabs = prefs.openTabs(forProject: projectId)
        let selected = prefs.selectedFile(forProject: projectId)
        openFiles = tabs
        if let selected, tabs.contains(selected) {
            selectedFilePath = selected
        } else {
            selectedFilePath = tabs.first
        }
    }

    /// Push the current file state to NativePrefs under the active
    /// project. No-op when there's no active project (defensive — can
    /// happen briefly during launch before ProjectsService.load completes).
    private func persistFileState() {
        guard let pid = activeProjectId, !pid.isEmpty else { return }
        let prefs = NativePrefs.shared
        prefs.setOpenTabs(openFiles, forProject: pid)
        prefs.setSelectedFile(selectedFilePath, forProject: pid)
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

}
