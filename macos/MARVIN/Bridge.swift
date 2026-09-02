// Bridge — ADR-0021 M5: WebView removed. MarvinBridge is now a pure
// @Observable state bucket read by SwiftUI views. All state is written
// by the native services (NativePrefs, ProjectsService, CostService,
// BranchService, ChatPreviewModel). No WKScriptMessageHandler,
// no injected JS, no WebView dependency.

import Foundation
import MARVINLogic
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

    struct OpenRouterBalance: Equatable, Codable {
        let totalCredits: Double
        let totalUsage: Double
    }

    /// One Claude plan window (5-hour / weekly), as last reported by the
    /// SDK's `rate_limit_event` (ADR-0082). A subscription has no dollar
    /// balance — this is its usage.
    struct ClaudeWindow: Equatable, Codable, Identifiable {
        let type: String
        let status: String
        let utilization: Double?
        let resetsAt: Double?
        let isUsingOverage: Bool?
        var id: String { type }

        /// Same wording as the Claude CLI's Usage tab and the desktop app,
        /// so the three surfaces read as one.
        var label: String {
            switch type {
            case "five_hour": return "current session"
            case "seven_day": return "current week (all models)"
            case "seven_day_overage_included": return "current week (incl. overage)"
            case "overage": return "overage"
            default:
                if type.hasPrefix("seven_day_") {
                    // Per-model weekly windows (`seven_day_fable`,
                    // `seven_day_opus`, …). They appear in `unifiedWindows`
                    // only once that model has been used against the plan, so
                    // a row missing here means the API has not reported it —
                    // not that MARVIN dropped it.
                    let model = String(type.dropFirst("seven_day_".count))
                    return "current week (\(model.prefix(1).uppercased() + model.dropFirst()))"
                }
                return type.replacingOccurrences(of: "_", with: " ")
            }
        }
    }

    let openRouter: OpenRouterBalance?
    let claudeWindows: [ClaudeWindow]
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

    /// Upstream tracking state for the current branch, polled by
    /// BranchService alongside the dirty count. Drives the status
    /// bar's sync control — without ahead/behind it can only offer
    /// "sync" as a verb, never as a count.
    var branchUpstream: String? = nil
    var branchAhead: Int = 0
    var branchBehind: Int = 0

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
    private(set) var isBusy: Bool = false

    /// Fine-grained marvinState mirror. The brain reads this to pick
    /// the right particle profile. One of: idle | thinking | tool |
    /// writing | error | cancelling. ADR-0021 M4: written by
    /// ChatPreviewModel directly from the SSE stream.
    ///
    /// Write through `setMarvinState(_:forSession:)`, not directly, so the
    /// brain can only ever show the state of the session ON SCREEN — see
    /// there for why.
    private(set) var marvinState: String = "idle"

    /// The session `marvinState` describes.
    private(set) var marvinStateSessionId: String? = nil

    /// Set the brain's state, tagged with the session it belongs to.
    ///
    /// Several sessions run at once, and a turn that is not on screen still
    /// streams: background-job completions and wakeups fire against sessions
    /// the user is not looking at. With one untagged global, whichever
    /// session wrote last owned the brain — so it showed "something general"
    /// rather than the selected session (user, 2026-09-01: "brain status
    /// should reflect the session i select, not something general").
    ///
    /// A write from a session that is not the active one is DROPPED rather
    /// than queued: the brain is a picture of what the user is looking at,
    /// and a state from elsewhere is not a stale version of that, it is an
    /// answer to a different question. `sessionId == nil` means "no session
    /// in particular" (teardown, boot) and is always allowed, so idling still
    /// works when nothing is loaded.
    func setMarvinState(_ state: String, forSession sessionId: String?) {
        guard BrainStateGate.accepts(writer: sessionId, active: activeMarvinSessionId)
        else { return }
        marvinStateSessionId = sessionId
        if marvinState != state { marvinState = state }
    }

    /// Busy flag, under the same gate and for the same reason: it is written
    /// from the same eight sites as `marvinState` and feeds the same brain.
    /// Leaving one gated and the other not would show a calm brain with a
    /// spinning footer, which is worse than either being wrong.
    func setBusy(_ busy: Bool, forSession sessionId: String?) {
        guard BrainStateGate.accepts(writer: sessionId, active: activeMarvinSessionId)
        else { return }
        if isBusy != busy { isBusy = busy }
    }

    /// May a per-session status-bar counter written by `sessionId` be shown?
    ///
    /// Same gate, same reason as `setMarvinState`. The ctx / graph-reads /
    /// agents chips describe ONE session's turn; a figure from another session
    /// is not a stale version of the on-screen one, it is a different answer.
    /// Exposed rather than kept private because the three counters are fed
    /// from `ContextUsageBridge`, which parses the event before it knows
    /// whether the write is wanted.
    func acceptsSessionCounters(from sessionId: String?) -> Bool {
        BrainStateGate.accepts(writer: sessionId, active: activeMarvinSessionId)
    }

    /// Zero every counter that describes one session's SDK conversation.
    ///
    /// Called on a session switch as well as on a fresh SDK session. Before
    /// 2026-09-01 only the latter cleared them, so switching between two live
    /// sessions kept the leaving session's `ctx 147K`, its `graph N · reads M`
    /// and its subagent ledger pinned in the status bar while the transcript
    /// below showed the session you had just opened — the two sessions read as
    /// "interconnected" even though their conversations were entirely separate
    /// (user, 2026-09-01). `hydrate` already did this for the plan / to-do /
    /// changed-files strips; these are the same content class and were missed.
    func resetSessionCounters() {
        residentContextTokens = nil
        billableThisTurn = nil
        reportedContextWindow = nil
        sessionGraphCalls = 0
        sessionFileReadCalls = 0
        sessionGraphSummaryCalls = 0
        subagents = SubagentLedger()
    }

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

    /// Per-session tool-use counts (2026-05-27 graphify-drift audit).
    /// Incremented in the chat preview's cli.event handler via
    /// `ToolUseCounter.deltaForCliEvent`. Reset to zero when the
    /// sidecar reports a fresh SDK session (same trigger as
    /// `residentContextTokens`). The AppStatusBar's "graph N · reads M"
    /// chip reads these to surface live drift between the graphify
    /// protocol and observed behaviour.
    /// The context window the SDK reported on the last result event — the
    /// authoritative figure, preferred over inferring one from the model id.
    var reportedContextWindow: Int? = nil
    var sessionGraphCalls: Int = 0
    var sessionFileReadCalls: Int = 0
    var sessionGraphSummaryCalls: Int = 0
    /// Subagent dispatches / running / settled this session (ADR-0080/0081
    /// observability) — fed from the same cli.event stream, shown in the
    /// status bar "agents" chip. Reset with the other session counters.
    var subagents = SubagentLedger()

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
    /// ADR-0045: opt-in Playwright MCP browser server. Writable by NativePrefs.
    var playwrightEnabled: Bool = false

    /// Autonomy mode (ADR-0036): "ask" | "agent" | "plan". Orthogonal to
    /// permissionStrategy. ChatPreviewView reads it when minting a turn.
    /// Written by NativePrefs / the agents-bar mode picker.
    var mode: String = "agent"

    /// User-facing reasoning-effort selection — the SDK ladder
    /// "low" | "medium" | "high" | "xhigh" | "max" (see `resolveEffort`
    /// in the runtime). The toolbar picker writes here via NativePrefs;
    /// ChatPreviewView reads it when minting a turn so the chosen effort
    /// reaches the sidecar in the same request. `xhigh` is the rung that
    /// enables Claude's dynamic-workflow behaviour.
    var thinkingMode: String = "high"

    /// Advisor-specific reasoning effort (ADR-0033). Same ladder as
    /// `thinkingMode`; `nil` means the advisor follows the executor's
    /// effort (the pre-0033 behaviour and the default).
    var advisorThinkingMode: String? = nil

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
        /// The bottom area is ONE tabbed panel (plan §D), not four
        /// independent panes. `graph`/`preview`/`terminal`/`problems` are
        /// derived from it so existing call sites and the legacy persisted
        /// payload keep working; the panel is the source of truth.
        var bottom = BottomPanelState()

        /// The browser preview, which is an EDITOR surface — not a bottom tab.
        /// It occupies the editor region (where files open) the way every
        /// other IDE opens a browser, and deliberately never registers as a
        /// file tab: it is not a document, so it does not belong in the
        /// open-files bar.
        var previewOpen: Bool = false

        var graph: Bool { bottom.isOpen && bottom.activeTab == .graph }
        var preview: Bool { previewOpen }
        var terminal: Bool { bottom.isOpen && bottom.activeTab == .terminal }
        var problems: Bool { bottom.isOpen && bottom.activeTab == .problems }
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
    /// ADR-0059 — the always-available "Audit Session" menu affordance (the
    /// scope-met chip is the primary one). ChatPreviewView observes this and
    /// runs the read-only auditor.
    private(set) var sessionAuditTriggerCount: Int = 0

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

    /// ⇧⌘P — the command palette (ADR-0099's sibling: one registry, two
    /// renderings). Same one-shot counter pattern as the other triggers.
    private(set) var commandPaletteTriggerCount: Int = 0
    /// ^G — go to line/column.
    private(set) var goToLineTriggerCount: Int = 0
    /// ⌘O routed through the bridge so the palette and the menu share one path.
    private(set) var openProjectTriggerCount: Int = 0
    /// Which left-pane tab a command asked for. The pane observes this and
    /// switches; nil means "no request outstanding".
    var requestedLeftTab: String? = nil

    func triggerCommandPalette() { commandPaletteTriggerCount &+= 1 }
    func triggerGoToLine()       { goToLineTriggerCount       &+= 1 }
    func triggerOpenProject()    { openProjectTriggerCount    &+= 1 }
    func revealLeftTab(_ tab: String) {
        // Revealing a tab in a collapsed pane must also open the pane, or
        // the command silently switches a tab nobody can see.
        if panes.files == false { NativePrefs.shared.togglePane("files") }
        requestedLeftTab = tab
    }

    func triggerShortcutsHelp()  { shortcutsTriggerCount   &+= 1 }
    func triggerQuickOpen()      { quickOpenTriggerCount    &+= 1 }
    func triggerSessionAudit()   { sessionAuditTriggerCount &+= 1 }
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
    /// Editor soft wrap. Mirrored from `NativePrefs`; read by the editor's
    /// `updateNSView` so flipping it re-lays-out the open document.
    var wordWrap: Bool = false
    /// Auto-save dirty buffers after a pause in typing. Mirrored from
    /// `NativePrefs`; acted on by `FileViewerView`.
    var autoSave: Bool = false

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

    /// The Problems panel's list — the MERGE of two independent producers,
    /// held separately so neither can clobber the other (ADR-0099).
    ///
    /// A CLI run sees the whole project including files nobody opened; a
    /// language server sees the open buffer, live and range-accurate. They
    /// answer different questions and arrive on completely different
    /// schedules, so one flat array written by both would mean whichever
    /// finished last erased the other's findings.
    private(set) var diagnosticItems: [DiagnosticItem] = []
    private var cliDiagnostics: [DiagnosticItem] = []
    /// Keyed by absolute file path, because that is the unit a language
    /// server republishes: every `publishDiagnostics` REPLACES the list for
    /// one file, and an empty list means "this file is clean now".
    private var lspDiagnostics: [String: [DiagnosticItem]] = [:]

    func applyDiagnostics(_ items: [DiagnosticItem]) {
        cliDiagnostics = items
        recomputeDiagnostics()
    }

    /// One file's diagnostics from one language server. An empty `items`
    /// clears that file — which is how a server says "you fixed it".
    func applyLSPDiagnostics(file: String, items: [DiagnosticItem]) {
        if items.isEmpty { lspDiagnostics.removeValue(forKey: file) }
        else { lspDiagnostics[file] = items }
        recomputeDiagnostics()
    }

    /// Drop everything a server had published — on shutdown, crash, or
    /// project switch. Leaving them up would attribute a dead server's
    /// stale opinion to the current project.
    func clearLSPDiagnostics() {
        guard !lspDiagnostics.isEmpty else { return }
        lspDiagnostics.removeAll()
        recomputeDiagnostics()
    }

    private func recomputeDiagnostics() {
        let merged = cliDiagnostics + lspDiagnostics.values.flatMap { $0 }
        diagnosticItems = DiagnosticsService.dedupeAndSort(merged)
        errorCount   = diagnosticItems.filter { $0.severity == .error }.count
        warningCount = diagnosticItems.filter { $0.severity == .warning }.count
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

    /// Phase 5f — apply a project selection locally and synchronously.
    /// The native surfaces (file tree, editor, chat hydrate, file
    /// viewer) all observe `projectWorkDir` / `projectName` /
    /// `activeProjectId`, so updating them here kicks the Swift-side
    /// fetches immediately. (Historical: this originally raced the
    /// removed WebView's React re-render; native-only since ADR-0021.)
    ///
    /// Returns false (and no-ops) when the id isn't in the known
    /// project list — the sidecar's project registry owns bookkeeping
    /// for new projects we haven't seen yet, so we don't bypass it
    /// for unknowns.
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
        // Ensure the preview is actually visible — otherwise "Open in
        // Browser" silently does nothing the first time.
        if !panes.previewOpen {
            NativePrefs.shared.setPreviewOpen(true)
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
    /// The session on screen.
    ///
    /// Was written only by the WebView and has been **permanently nil since
    /// that was removed** — a dead property that still had readers, which is
    /// how the Stop-All button shipped permanently disabled (2026-09-01).
    /// `ChatPreviewModel` now publishes to it whenever its own session id
    /// changes, so menu commands and status surfaces can ask the bridge
    /// instead of reaching into the view model.
    private(set) var activeMarvinSessionId: String? = nil

    func setActiveMarvinSession(_ id: String?) {
        guard activeMarvinSessionId != id else { return }
        activeMarvinSessionId = id
    }

    /// Phase 5a — currently-selected file path in the native file
    /// tree. Drives the native file viewer's content. The native
    /// tree (FileTreeView.selectRow) writes via `setSelectedFile`;
    /// the file viewer reads via @Observable. (Historical: during
    /// the Phase 5a→5c promotion this was kept distinct from the
    /// removed WebView's `select-file` event; native-only since
    /// ADR-0021.)
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
        recordNavigation(to: path)
        selectedFilePath = path
        persistFileState()
    }

    // MARK: - Editor navigation history (Go ▸ Back / Forward)

    /// Visited files, oldest first, with `navIndex` pointing at the current
    /// one. A browser-style stack: going Back then opening something NEW
    /// truncates the forward half, because the branch you abandoned is not
    /// somewhere "forward" any more.
    private var navHistory: [String] = []
    private var navIndex: Int = -1
    /// Set while Back/Forward is driving, so the resulting `setSelectedFile`
    /// does not push the destination onto the stack it came from — that is
    /// the classic infinite-history bug.
    private var isNavigating = false

    var canNavigateBack: Bool { navIndex > 0 }
    var canNavigateForward: Bool { navIndex >= 0 && navIndex < navHistory.count - 1 }

    private func recordNavigation(to path: String) {
        guard !isNavigating else { return }
        if navIndex >= 0, navIndex < navHistory.count, navHistory[navIndex] == path {
            return          // re-selecting the current file is not a move
        }
        if navIndex < navHistory.count - 1 {
            navHistory.removeSubrange((navIndex + 1)...)
        }
        navHistory.append(path)
        // Bounded: an all-day session must not accumulate an unbounded list.
        if navHistory.count > 100 { navHistory.removeFirst(navHistory.count - 100) }
        navIndex = navHistory.count - 1
    }

    func navigateBack() {
        guard canNavigateBack else { return }
        navIndex -= 1
        jumpToHistoryEntry()
    }

    func navigateForward() {
        guard canNavigateForward else { return }
        navIndex += 1
        jumpToHistoryEntry()
    }

    private func jumpToHistoryEntry() {
        guard navHistory.indices.contains(navIndex) else { return }
        isNavigating = true
        defer { isNavigating = false }
        let path = navHistory[navIndex]
        if !openFiles.contains(path) { openFiles.append(path) }
        selectedFilePath = path
        persistFileState()
    }

    /// Chat-link navigation: open `path` in the editor, optionally remembering
    /// a target line so the viewer can scroll to it. Called when the user
    /// clicks a `file.swift:120` reference in MARVIN's output.
    func openFileFromChat(path: String, line: Int?) {
        pendingEditorLine = line
        setSelectedFile(path)
    }

    /// Ask the viewer to scroll the ALREADY-open file to `line`.
    ///
    /// Same channel as a chat link, without touching the selected file —
    /// used by Next/Previous Change, which navigates inside the file the
    /// user is already looking at.
    func requestEditorLine(_ line: Int) {
        pendingEditorLine = line
    }

    /// Line a chat link asked to jump to, consumed by the file viewer once it
    /// has loaded. Nil when the open came from anywhere else.
    private(set) var pendingEditorLine: Int?

    /// Viewer calls this after honouring (or ignoring) the target.
    func consumePendingEditorLine() -> Int? {
        defer { pendingEditorLine = nil }
        return pendingEditorLine
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
