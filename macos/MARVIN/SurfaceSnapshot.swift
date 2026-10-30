// SurfaceSnapshot — dev-only offscreen rasteriser for MARVIN's UI surfaces.
//
// Generalises MarkdownSnapshot / TodoStripSnapshot: one entry point renders
// every surface that can be mounted without a live session, in light and dark
// and at two widths, writes PNGs and exits. Added so design work (Impeccable
// passes, layout bugs) can be judged by looking at the rendered result rather
// than by reading SwiftUI source.
//
// Inert unless BOTH variables are set:
//
//     MARVIN_SNAPSHOT_VIEW=<surface-id | all | list>
//     MARVIN_SNAPSHOT_OUT=<directory>
//     [MARVIN_SNAPSHOT_SETTLE_MS=<ms>]   run-loop settle before capture (default 600; populated surfaces use 1500)
//
//     MARVIN_PORT=39031 MARVIN_SNAPSHOT_VIEW=all MARVIN_SNAPSHOT_OUT=/tmp/surfaces .build/debug/MARVIN
//
// `MARVIN_PORT` is REQUIRED and must be a free, unprivileged port (not 3030):
// `ServerConfig.port` is read before this runs, so the harness cannot choose
// it, and it refuses to run while the port is 3030 (a snapshot must never talk
// to the user's real sidecar). The populated surfaces bind a stand-in sidecar
// on that port (SurfaceSnapshotSidecar.swift); with a port that cannot be bound
// (`MARVIN_PORT=1`) they are reported FAILED and only the empty states render.
//
// A `-DMARVIN_LEGACY_SDK` build is for local verification only; never install, ship or bundle it.
//
// ## Building on a Mac without Xcode 16 (Command Line Tools + a swift.org toolchain)
//
// Verified 2026-10-30 on macOS 14.4, CLT 15.3 (SDK 14.4), Swift 6.4.2 from
// https://swift.org installed under ~/Library/Developer/Toolchains. Nothing
// below is committed to the repo; steps 1-2 touch only untracked, git-ignored
// state (`Package.resolved`, `.build/`).
//
//     cd macos
//     export SDKROOT="$(xcrun --show-sdk-path)"
//     SWIFT=$HOME/Library/Developer/Toolchains/swift-6.4.2-RELEASE.xctoolchain/usr/bin/swift
//
//  1. `$SWIFT package resolve && $SWIFT package resolve swiftterm --version 1.20.0`
//     (a local pin to the oldest SwiftTerm Package.swift allows; 1.99.x needs
//     the macOS 15 SDK. The identity is lowercase `swiftterm`.)
//  2. In `.build/checkouts/SwiftTerm/Package.swift` change
//     `.process("Apple/Metal/Shaders.metal")` to `.copy(...)`. That skips the
//     `metal` compiler (only Xcode has it); SwiftTerm compiles the shader from
//     source at runtime.
//  3. `$SWIFT build -Xswiftc -DMARVIN_LEGACY_SDK`  (flag enables
//     LegacySDKShims.swift; the sources carry explicit @MainActor for the 14.4 SDK).
//  4. `MARVIN_PORT=39031 MARVIN_SNAPSHOT_VIEW=all MARVIN_SNAPSHOT_OUT=/tmp/surfaces .build/debug/MARVIN`
//  5. Tests: `$SWIFT run -Xswiftc -DMARVIN_LEGACY_SDK MARVINTests`
//
// `LegacySDKShims.swift` stands in for `onGeometryChange` with a
// `GeometryReader` background, which AGENTS.md links to a past crash — hence
// the local-only rule above.
//
// Files are `<out>/<surface>--<light|dark>--<width>.png` (PNGs are 2× pixel
// size), plus `COVERAGE.md` recording what each surface actually showed. The
// harness fills each surface with `windowBackgroundColor`, not
// `MarvinTheme.background`, so the grey you see is the system window grey
// (#333-ish in dark), not the app's chrome fill.
//
// ## Populated vs empty
//
// Views are mounted exactly as they ship; no view was changed for the harness.
// A view that loads from the sidecar shows what it has with nothing to load —
// its no-project / offline / empty state. That is a real state worth
// reviewing, so every such surface is rendered twice:
//
//   `<surface>`         populated — the stand-in sidecar answers the app's
//                       own requests (SurfaceSnapshotRoutes*.swift) and the
//                       shared bridge is put in the state of a session in use
//                       (`SurfaceFixtures.populateBridge`)
//   `<surface>-empty`   the no-project / offline state, a fresh bridge
//
// The empties render first, before the stand-in sidecar starts, so nothing a
// populated surface touches can reach them. The chat-row surfaces take their
// data in-process (`fixture`) and need no sidecar.
//
// All data is invented and neutral (Golden Rule 6): a demo project "Atlas",
// its files, branches and people. Nothing names a real project.
//
// Side effects, all outside the repo: the Sessions fixture writes
// `marvin.chatTabs.prj_atlas` into this process's UserDefaults (removed at the
// end of the run), `marvin.autoStartSidecar` is forced off for the run and
// restored, the terminal surface creates `/tmp/demo/Atlas` and runs the user's
// login shell there, and the stand-in sidecar listens on loopback only.
//
// Geometry: if a surface ever needs measuring, use `onGeometryChange`, never
// `background(GeometryReader)` — see AGENTS.md "Measure before theorising".

import AppKit
import MARVINLogic
import SwiftUI

enum SurfaceSnapshot {
    enum Coverage {
        /// Populated from in-process data; no sidecar involved.
        case fixture
        /// Populated through the stand-in sidecar and a configured bridge.
        case populated
        case empty(String)
        case notCovered(String)

        var label: String {
            switch self {
            case .fixture, .populated: return "populated"
            case .empty: return "empty"
            case .notCovered: return "not covered"
            }
        }

        var note: String {
            switch self {
            case .fixture: return "neutral in-process fixtures"
            case .populated: return "stand-in sidecar + configured bridge"
            case .empty(let why), .notCovered(let why): return why
            }
        }

        var needsSidecar: Bool {
            if case .populated = self { return true }
            return false
        }
    }

    struct Surface {
        let id: String
        let title: String
        let coverage: Coverage
        /// Two representative widths, narrow first.
        let widths: [CGFloat]
        /// nil → the view's natural height at that width.
        let height: CGFloat?
        /// Run-loop settle before capture; nil → the run default for its kind.
        let settleMs: Int?
        let prepareEachAppearance: Bool
        /// Once, before the first render of this surface — or before each
        /// appearance when `prepareEachAppearance` (state that bakes in colours).
        let prepare: (@MainActor () -> Void)?
        /// Before every render of a populated surface; nil → `populateBridge`.
        let configure: (@MainActor (MarvinBridge) -> Void)?
        /// After the settle: drive the mounted view (e.g. pick a tab).
        let interact: (@MainActor (NSView) -> Void)?
        let make: (@MainActor () -> AnyView?)?

        init(_ id: String, _ title: String, _ coverage: Coverage,
             widths: [CGFloat], height: CGFloat? = nil, settleMs: Int? = nil,
             prepareEachAppearance: Bool = false,
             prepare: (@MainActor () -> Void)? = nil,
             configure: (@MainActor (MarvinBridge) -> Void)? = nil,
             interact: (@MainActor (NSView) -> Void)? = nil,
             make: (@MainActor () -> AnyView?)? = nil) {
            self.id = id
            self.title = title
            self.coverage = coverage
            self.widths = widths
            self.height = height
            self.settleMs = settleMs
            self.prepareEachAppearance = prepareEachAppearance
            self.prepare = prepare
            self.configure = configure
            self.interact = interact
            self.make = make
        }
    }

    // MARK: - Registry

    private static let paneWidths: [CGFloat] = [260, 420]
    private static let paneHeight: CGFloat = 720
    private static let offline = "no project and no sidecar, so it renders its empty/offline state"

    /// A populated surface and its `-empty` twin, mounting the same view.
    @MainActor
    private static func pair(_ id: String, _ title: String, widths: [CGFloat], height: CGFloat? = nil,
                             empty why: String = offline, settleMs: Int? = nil,
                             prepare: (@MainActor () -> Void)? = nil,
                             interact: (@MainActor (NSView) -> Void)? = nil,
                             make: @escaping @MainActor () -> AnyView?) -> [Surface] {
        [
            Surface(id, title, .populated, widths: widths, height: height, settleMs: settleMs,
                    prepare: prepare, interact: interact, make: make),
            Surface("\(id)-empty", "\(title) — empty", .empty(why), widths: widths, height: height, make: make),
        ]
    }

    @MainActor
    private static var surfaces: [Surface] {
        let chat: [Surface] = [
            Surface("chat-transcript", "Chat transcript", .fixture, widths: [520, 900]) {
                AnyView(VStack(alignment: .leading, spacing: 10) {
                    ForEach(SurfaceFixtures.transcript) { ChatMessageRow(message: $0) }
                }.padding(16))
            },
            // Known bug, shown on purpose: the handoff's hidden marker
            // `<!-- marvin:scope-met -->` is drawn as visible text.
            Surface("chat-scope-met-handoff", "Chat: scope-met handoff message (shows the visible marker bug)", .fixture,
                    widths: [520, 900]) {
                AnyView(ChatMessageRow(message: SurfaceFixtures.handoffMessage).padding(16))
            },
            Surface("chat-confirm-card", "Confirm cards (tool, plan approval)", .fixture, widths: [520, 900]) {
                guard let tool = SurfaceFixtures.bashConfirm, let plan = SurfaceFixtures.planConfirm else { return nil }
                return AnyView(VStack(spacing: 12) {
                    ConfirmCard(request: tool, onAllow: {}, onDeny: { _ in })
                    ConfirmCard(request: plan, onAllow: {}, onDeny: { _ in })
                }.padding(16))
            },
            Surface("chat-ask-question", "AskUserQuestion sheet", .fixture, widths: [560, 760]) {
                guard let ask = SurfaceFixtures.askQuestion else { return nil }
                return AnyView(AskQuestionSheet(request: ask, onSubmit: { _ in }, onSkip: {}))
            },
            Surface("chat-input", "Chat input (idle with draft, sending)", .fixture, widths: [520, 900]) {
                AnyView(VStack(spacing: 12) {
                    ChatInputFixture(text: SurfaceFixtures.draft, isSending: false)
                    ChatInputFixture(text: "", isSending: true)
                }.padding(12))
            },
            Surface("plan-strip", "Plan checklist strip", .fixture, widths: [520, 900]) {
                AnyView(TodoListStrip(
                    steps: TodoStripSnapshot.sampleSteps,
                    planTitle: "Retry with backoff for the HTTP client",
                    onOpenPlanFile: {}, onOpenPlansPanel: {}, onClose: {}
                ))
            },
        ]

        let topBar: [Surface] =
            pair("topbar-layout-popover", "Top bar: layout popover", widths: [300, 420], empty: "default bridge") {
                AnyView(LayoutPopoverContent())
            }
            + pair("topbar-models-dialog", "Top bar: models dialog", widths: [520, 720], height: 560,
                   empty: "default bridge; the live model list needs the sidecar") {
                AnyView(ModelsDialog())
            }
            + [Surface("topbar-toolbar", "Top bar: the toolbar inside the window",
                       .notCovered("two buttons declared in ContentView's `.toolbar`; an NSToolbar only materialises in a titled window hosting the whole ContentView, so it needs the live window — not attempted offscreen"),
                       widths: [900, 1400])]

        let statusBar: [Surface] =
            pair("status-bar", "Status bar", widths: [700, 1200], empty: "default bridge, offline health") {
                AnyView(AppStatusBar())
            }

        let panes: [Surface] =
            pair("pane-files", "Left pane: Files", widths: paneWidths, height: paneHeight) { AnyView(FileTreeView()) }
            + pair("pane-search", "Left pane: Search", widths: paneWidths, height: paneHeight,
                   interact: typeIntoFirstField("record")) { AnyView(FindInFilesView()) }
            + pair("pane-source-control", "Left pane: Source Control", widths: paneWidths, height: paneHeight) {
                AnyView(SourceControlView())
            }
            + pair("pane-sessions", "Left pane: Sessions", widths: paneWidths, height: paneHeight,
                   empty: "no live sessions registered", prepare: seedSessions) { AnyView(SessionsPane()) }
            + pair("pane-skills", "Left pane: Skills", widths: paneWidths, height: paneHeight) { AnyView(SkillsPane()) }
            + pair("pane-plugins", "Left pane: Plugins", widths: paneWidths, height: paneHeight) { AnyView(PluginsPane()) }
            + pair("pane-practice", "Left pane: Practice — Findings", widths: paneWidths, height: paneHeight) {
                AnyView(PracticePane())
            }
            + [
                Surface("pane-practice-working", "Left pane: Practice — Working", .populated,
                        widths: paneWidths, height: paneHeight, interact: selectSegment(1)) { AnyView(PracticePane()) },
                Surface("pane-practice-rules", "Left pane: Practice — Rules", .populated,
                        widths: paneWidths, height: paneHeight, interact: selectSegment(2)) { AnyView(PracticePane()) },
            ]

        let editor: [Surface] =
            pair("file-viewer", "File viewer / editor", widths: [760, 1100], height: 560,
                 empty: "no file is open without a project") { AnyView(FileViewerView()) }
            + pair("review-changes", "Review Changes window", widths: [820, 1180], height: 620,
                   empty: "the file list and diffs come from /api/changes; none without a sidecar") {
                AnyView(ReviewChangesScreen(model: ReviewChangesModel(cwd: SurfaceFixtures.project, marvinSessionId: "fixture-session")))
            }
            + [Surface("diff-sheet", "Diff sheet", .populated, widths: [820, 1180]) {
                AnyView(DiffSheet(
                    model: DiffSheetModel(cwd: SurfaceFixtures.project,
                                          relativePath: "Sources/App/Models/UsageLedger.swift"),
                    onDismiss: {}))
            }]

        let backlog: [Surface] =
            pair("backlog-panel", "Backlog panel", widths: [420, 640], height: 640, empty: "the list loads from the sidecar") {
                AnyView(BacklogPanel(workDir: SurfaceFixtures.project, onPromote: { _ in }, onClose: {}, onChanged: {}))
            }
            + [Surface("backlog-detail", "Backlog item detail", .fixture, widths: [460, 640], height: 560) {
                guard let item = SurfaceFixtures.backlogItem else { return nil }
                return AnyView(BacklogDetailView(workDir: SurfaceFixtures.project, item: item,
                                                 onPromote: { _ in }, onChanged: {}, onDismissSheet: {}))
            }]

        let settings: [Surface] =
            pair("settings", "Settings", widths: [520, 760], height: 620, empty: "default bridge, offline health") {
                AnyView(SettingsView())
            }

        let live: [Surface] = [
            Surface("chat-pane", "Chat pane (ChatPreviewView with a loaded transcript — includes the scope-met chip strip)",
                    .populated, widths: [520, 900], height: 720,
                    configure: { b in
                        SurfaceFixtures.populateBridge(b)
                        ChatPreviewModel.shared.messages = SurfaceFixtures.transcript
                    }) { AnyView(ChatPreviewView()) },
            // A short window with the largest persisted composer and plan-strip
            // heights (audit C6). Proves the persisted sizes yield to the window.
            Surface("chat-pane-short", "Chat pane in a short window with the composer and plan strip persisted at their maximum heights",
                    .populated, widths: [520], height: 320,
                    configure: { b in
                        SurfaceFixtures.populateBridge(b)
                        ChatPreviewModel.shared.messages = SurfaceFixtures.transcript
                        // An isolated suite, never `.standard`: the persisted sizes
                        // would otherwise leak into every later surface and run.
                        let suite = UserDefaults(suiteName: "marvin.snapshot.short")!
                        suite.removePersistentDomain(forName: "marvin.snapshot.short")
                        suite.set(600.0, forKey: "marvin.chat.editorHeight")
                        suite.set(520.0, forKey: "marvin.planStripHeight")
                    }) { AnyView(ChatPreviewView().defaultAppStorage(UserDefaults(suiteName: "marvin.snapshot.short")!)) },
            Surface("terminal", "Terminal pane (a login shell running a neutral command). Observed offscreen, unverified in the live app: in dark the terminal background draws white under default-white text, so the output is invisible", .populated,
                    widths: [700, 1000], height: 360, settleMs: 2500, prepareEachAppearance: true, prepare: seedTerminal) {
                AnyView(TerminalPaneView())
            },
            Surface("graph-pane", "Graph pane (WKWebView — the stand-in serves a small SVG graph page)", .populated,
                    widths: [400, 600], height: 520, settleMs: 2500) {
                AnyView(GraphPaneView())
            },
            Surface("graph-pane-empty", "Graph pane — no project", .empty("no project open"), widths: [400, 600], height: 520) {
                AnyView(GraphPaneView())
            },
        ]

        // ADR-0127 M6 — one surface per design-brief §7 state, plus the
        // set-up sheet, transcript marking and the external-answer note.
        let supervisor: [Surface] = SurfaceSupervisorFixtures.states.map { st in
            Surface(st.id, st.title, .populated, widths: paneWidths, height: 1100, prepare: seedSessions) {
                AnyView(SessionsPane(supervisor: st.model()))
            }
        } + [
            Surface("sup-setup-sheet", "Supervisor §6.7 set-up sheet (Cancel is the default; Start in shadow)", .fixture, widths: [460]) {
                AnyView(SupervisorSetUpSheet(model: SurfaceSupervisorFixtures.model(nil),
                                             tabs: [(SurfaceRoutesMore.openIds[0], "Add retry with backoff to the HTTP client"),
                                                    (SurfaceRoutesMore.openIds[3], "Fix the flaky cache test")],
                                             modelLabel: "Sonnet 5.5", onClose: {}))
            },
            Surface("chat-supervisor-marking", "Chat: supervisor message bubble, answered-by chip, touched-turn divider", .fixture,
                    widths: [520, 900]) {
                AnyView(VStack(alignment: .leading, spacing: 10) {
                    ForEach(SurfaceSupervisorFixtures.transcript) { ChatMessageRow(message: $0) }
                }.padding(16))
            },
            Surface("chat-external-answer-note", "Chat tray: the note that replaces a sheet or card answered elsewhere", .fixture,
                    widths: [520, 900]) {
                AnyView(ExternalAnswerNoteFixture())
            },
        ]

        return chat + topBar + statusBar + panes + editor + backlog + settings + live + supervisor
    }

    // MARK: - Per-surface preparation

    /// The Sessions pane is a pure observer of `SessionRegistry`, which is fed
    /// by three sidecar requests. Start it against the stand-in and wait for
    /// the ledger, the integration preview and the feed.
    @MainActor
    private static func seedSessions() {
        let projectId = "prj_atlas"
        UserDefaults.standard.set(SurfaceRoutesMore.openIds, forKey: "marvin.chatTabs.\(projectId)")
        SurfaceFixtures.populateBridge(MarvinBridge.shared)
        let registry = SessionRegistry.shared
        registry.start(projectId: projectId)
        registry.refreshIntegrationPreview()
        spin(until: { registry.ledger.entries.count >= 9 && registry.integrationTarget != nil && registry.feedConnected },
             timeout: 4)
    }

    /// A real shell in the demo project, shown running one neutral command. The
    /// prompt is replaced and the screen cleared first — the shell's default
    /// prompt names this machine and its user — and the output is `cat`ed from
    /// a file so the typed command is short.
    @MainActor
    private static func seedTerminal() {
        try? FileManager.default.createDirectory(atPath: SurfaceFixtures.project, withIntermediateDirectories: true)
        let output = "\n\u{1B}[1m RUN \u{1B}[0m  v1.4.0 \(SurfaceFixtures.project)\n\n"
            + " \u{1B}[32m✓\u{1B}[0m Tests/UsageLedgerTests.swift (6 tests) 41ms\n"
            + " \u{1B}[32m✓\u{1B}[0m Tests/SyncServiceTests.swift (9 tests) 118ms\n\n"
            + " Test Files  2 passed (2)\n      Tests  15 passed (15)\n   Duration  1.02s\n\n"
        try? output.write(toFile: SurfaceFixtures.project + "/test-output.txt", atomically: true, encoding: .utf8)
        // A fresh shell each time: the terminal view bakes its colours in at
        // creation, so one session cannot serve both appearances.
        for old in TerminalSessionStore.shared.sessions(for: SurfaceFixtures.project) {
            TerminalSessionStore.shared.close(old)
        }
        let session = TerminalSessionStore.shared.newSession(for: SurfaceFixtures.project)
        spin(for: 0.8)
        session.run(command: "PS1='$ '; clear")
        spin(for: 0.8)
        session.run(command: "cat test-output.txt")
        spin(for: 1.0)
    }

    /// Pick a tab of a segmented picker in the mounted view. A SwiftUI
    /// segmented `Picker` is an `NSSegmentedControl`; setting the segment and
    /// sending its action is what a click does.
    private static func selectSegment(_ index: Int) -> @MainActor (NSView) -> Void {
        { host in
            guard let control = findSegmented(in: host), index < control.segmentCount else {
                FileHandle.standardError.write(Data("surface snapshot: no segmented control with segment \(index)\n".utf8))
                return
            }
            control.selectedSegment = index
            if let action = control.action { _ = control.sendAction(action, to: control.target) }
        }
    }

    /// Type into the first editable text field of the mounted view, the way a
    /// user would — through the field editor, so the view's own binding and
    /// debounce see it — then give the search time to come back.
    private static func typeIntoFirstField(_ text: String) -> @MainActor (NSView) -> Void {
        { host in
            guard let field = findEditableField(in: host), let window = host.window else {
                FileHandle.standardError.write(Data("surface snapshot: no editable text field to type into\n".utf8))
                return
            }
            window.makeFirstResponder(field)
            (field.currentEditor() as? NSTextView)?
                .insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
            spin(for: 1.4)
        }
    }

    private static func findEditableField(in view: NSView) -> NSTextField? {
        if let field = view as? NSTextField, field.isEditable { return field }
        for sub in view.subviews { if let found = findEditableField(in: sub) { return found } }
        return nil
    }

    private static func findSegmented(in view: NSView) -> NSSegmentedControl? {
        if let control = view as? NSSegmentedControl { return control }
        for sub in view.subviews { if let found = findSegmented(in: sub) { return found } }
        return nil
    }

    @MainActor
    private static func spin(for seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    @MainActor
    private static func spin(until done: () -> Bool, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done(), Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    }

    // MARK: - Entry point

    /// Returns true when it handled a snapshot run (caller should exit).
    @MainActor
    static func runIfRequested() -> Bool {
        let env = ProcessInfo.processInfo.environment
        guard let which = env["MARVIN_SNAPSHOT_VIEW"], !which.isEmpty else { return false }

        // Refuse to run against the live sidecar. `ServerConfig.port` is a lazy
        // static that the app reads before this point, so the caller must pass
        // MARVIN_PORT=<free port> (see the header).
        guard ServerConfig.port != 3030 || env["MARVIN_SNAPSHOT_ALLOW_LIVE"] == "1" else {
            fail("refusing to run against port 3030 (a live sidecar). Set MARVIN_PORT to a free port.")
            return true
        }

        // The app's own window is alive behind the harness. Offline, it would
        // spawn a real sidecar on MARVIN_PORT; keep it from doing that, and put
        // the preference back afterwards (ContentView writes a default when
        // none is set).
        let autoStartKey = "marvin.autoStartSidecar"
        let priorAutoStart = UserDefaults.standard.object(forKey: autoStartKey)
        UserDefaults.standard.set(false, forKey: autoStartKey)
        defer {
            if let priorAutoStart { UserDefaults.standard.set(priorAutoStart, forKey: autoStartKey) }
            else { UserDefaults.standard.removeObject(forKey: autoStartKey) }
        }

        // ADR-0127 — the shared supervisor model must never read the user's real
        // token or call the stand-in for it; fixtures fill their own models.
        SupervisorModel.shared.offline = true

        let all = surfaces
        if which == "list" {
            for s in all { print("\(s.id)\t\(s.coverage.label)\t\(s.title)") }
            return true
        }
        guard let outPath = env["MARVIN_SNAPSHOT_OUT"], !outPath.isEmpty else {
            fail("MARVIN_SNAPSHOT_OUT=<directory> is required")
            return true
        }
        let selected = which == "all" ? all : all.filter { $0.id == which }
        guard !selected.isEmpty else {
            fail("no surface '\(which)'. Try MARVIN_SNAPSHOT_VIEW=list")
            return true
        }
        let out = URL(fileURLWithPath: outPath, isDirectory: true)
        do { try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true) } catch {
            fail("cannot create \(outPath): \(error)")
            return true
        }
        let settle = env["MARVIN_SNAPSHOT_SETTLE_MS"].flatMap(Int.init)

        var rows: [String: String] = [:]
        var written = 0

        // Pass 1: everything that needs no sidecar, on a fresh bridge — the
        // empty states and the in-process chat rows.
        for s in selected where !s.coverage.needsSidecar {
            guard let make = s.make else {
                rows[s.id] = "| `\(s.id)` | \(s.title) | not covered | — | \(s.coverage.note) |"
                continue
            }
            let (row, n) = renderSurface(s, make: make, out: out, settleMs: settle ?? s.settleMs ?? 600, populated: false)
            rows[s.id] = row
            written += n
        }

        // Pass 2: the populated surfaces, against the stand-in sidecar.
        let populated = selected.filter { $0.coverage.needsSidecar }
        var sidecar: FixtureSidecar?
        if !populated.isEmpty {
            sidecar = FixtureSidecar(port: ServerConfig.port) { method, path, query in
                SurfaceRoutes.handle(method: method, path: path, query: query)
            }
            if sidecar?.start() != true {
                sidecar = nil
                for s in populated {
                    rows[s.id] = "| `\(s.id)` | \(s.title) | FAILED | 0 | could not bind port \(ServerConfig.port) for the stand-in sidecar; rerun with a free MARVIN_PORT (e.g. 39031) |"
                }
            }
        }
        if sidecar != nil {
            for s in populated {
                guard let make = s.make else { continue }
                let (row, n) = renderSurface(s, make: make, out: out, settleMs: settle ?? s.settleMs ?? 1500, populated: true)
                rows[s.id] = row
                written += n
            }
            sidecar?.stop()
        }
        UserDefaults.standard.removeObject(forKey: "marvin.chatTabs.prj_atlas")

        let ordered = selected.compactMap { rows[$0.id] }
        let table = """
        # Surface snapshot coverage

        | surface | title | state | PNGs | note |
        | --- | --- | --- | --- | --- |
        \(ordered.joined(separator: "\n"))
        """
        try? table.write(to: out.appendingPathComponent("COVERAGE.md"), atomically: true, encoding: .utf8)
        print("wrote \(written) PNGs to \(outPath)")
        return true
    }

    @MainActor
    private static func renderSurface(_ s: Surface, make: @MainActor () -> AnyView?, out: URL,
                                      settleMs: Int, populated: Bool) -> (row: String, written: Int) {
        // Printed BEFORE rendering: a Swift trap can't be caught, so the
        // last line names the surface that took the run down.
        print("rendering \(s.id)")
        if !s.prepareEachAppearance { s.prepare?() }
        var files: [String] = []
        var failure: String?
        let settle = Double(settleMs) / 1000
        for dark in [false, true] {
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            if s.prepareEachAppearance { s.prepare?() }
            for width in s.widths {
                let bridge: MarvinBridge
                if populated {
                    bridge = MarvinBridge.shared
                    (s.configure ?? SurfaceFixtures.populateBridge)(bridge)
                } else {
                    bridge = MarvinBridge()
                }
                guard let view = make() else { failure = "fixture failed to decode"; break }
                guard let png = render(view, width: width, height: s.height, dark: dark, settle: settle,
                                       bridge: bridge, live: populated, interact: s.interact) else {
                    failure = "render failed"
                    break
                }
                let name = "\(s.id)--\(dark ? "dark" : "light")--\(Int(width)).png"
                do {
                    try png.write(to: out.appendingPathComponent(name))
                    files.append(name)
                } catch {
                    failure = "write failed: \(error)"
                }
            }
        }
        let n = files.count
        if let failure {
            return ("| `\(s.id)` | \(s.title) | FAILED | \(n) | \(failure) |", n)
        }
        return ("| `\(s.id)` | \(s.title) | \(s.coverage.label) | \(n) | \(s.coverage.note) |", n)
    }

    private static func fail(_ message: String) {
        FileHandle.standardError.write(Data("surface snapshot: \(message)\n".utf8))
    }

    // MARK: - Rendering

    @MainActor
    private static func render(_ content: AnyView, width: CGFloat, height: CGFloat?, dark: Bool, settle: TimeInterval,
                               bridge: MarvinBridge, live: Bool,
                               interact: (@MainActor (NSView) -> Void)?) -> Data? {
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let health = HealthMonitor()
        let root = content
            .frame(width: width, height: height)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(bridge)
            .environment(health)
            .environment(\.colorScheme, dark ? .dark : .light)

        let host = NSHostingView(rootView: root)
        host.appearance = appearance
        host.frame = NSRect(x: 0, y: 0, width: width, height: height ?? 10)
        host.layoutSubtreeIfNeeded()

        // Hosted in a real (offscreen) window — ImageRenderer cannot rasterise
        // NSViewRepresentable content (see MarkdownSnapshot).
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = appearance
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.orderFront(nil)

        // A populated surface reads health the way the app does: one poll.
        if live { Task { @MainActor in await health.refreshNow() } }

        // Let `.task` / onAppear work land (a fetch against the stand-in, or a
        // failed one against the closed port, a state flip) before the pixels
        // are taken.
        RunLoop.main.run(until: Date().addingTimeInterval(settle))

        if let interact {
            interact(host)
            RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        }

        let fitted = host.fittingSize
        let finalHeight = height ?? max(fitted.height, 10)
        host.frame = NSRect(x: 0, y: 0, width: width, height: finalHeight)
        window.setContentSize(host.frame.size)
        host.layoutSubtreeIfNeeded()
        window.displayIfNeeded()

        defer { window.orderOut(nil) }
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
        host.cacheDisplay(in: host.bounds, to: rep)
        return rep.representation(using: NSBitmapImageRep.FileType.png, properties: [:])
    }
}
