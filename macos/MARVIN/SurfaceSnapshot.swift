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
//     [MARVIN_SNAPSHOT_SETTLE_MS=<ms>]   run-loop settle before capture (default 600)
//
//     MARVIN_SNAPSHOT_VIEW=all MARVIN_SNAPSHOT_OUT=/tmp/surfaces .build/debug/MARVIN
//
// Files are `<out>/<surface>--<light|dark>--<width>.png`, plus `COVERAGE.md`
// recording what each surface actually showed.
//
// NO LIVE SERVICES. The run points the app at a closed port before anything
// reads `ServerConfig`, and refuses to start if that did not take (a snapshot
// must never talk to the user's real sidecar). Views are mounted exactly as
// they ship — no view was changed for the harness and no internals are
// mocked — so a view that loads from the sidecar renders the state it has
// with nothing to load: its no-project / offline / empty state. That is a
// real state worth reviewing, but it is NOT the populated state; the
// coverage table says which is which.
//
// Coverage (Phase 0). "fixture" = populated from neutral data in
// SurfaceSnapshotFixtures; "empty" = renders only its no-project/offline
// state; "not covered" = not rendered, reason given.
//
//   chat transcript (user/assistant/tool/thinking/system rows)  fixture
//   chat: confirm card (tool + plan approval)                   fixture
//   chat: AskUserQuestion sheet                                 fixture
//   chat: scope-met handoff                                     fixture (the message text only)
//   chat: scope-met chip strip                                  not covered — private to ChatPreviewView (4.4K lines, needs ChatPreviewModel)
//   chat input                                                  fixture
//   plan checklist strip                                        fixture
//   top bar: layout popover, setup popover, models dialog       empty (default bridge; models list needs the sidecar)
//   top bar: project picker                                     empty (no project registered)
//   top bar: the toolbar inside the window                      not covered — lives in ContentView, which needs the whole live window
//   status bar                                                  empty (default bridge, offline health)
//   left panes: files, search, source control, sessions,
//               skills, plugins, practice                       empty (no project / nothing to fetch)
//   file viewer / editor                                        empty — an open file needs a project and the sidecar's file API
//   Review Changes window                                       empty — the file list and diffs come from /api/changes
//   diff sheet                                                  not covered — DiffSheetModel fetches its diff from the sidecar
//   backlog panel                                               empty (list loads from the sidecar); detail sheet: fixture
//   settings                                                    empty (default bridge, offline health)
//   terminal, graph (Metal) pane, welcome/onboarding            not covered — PTY / GPU / first-run, outside Phase 0
//
// Geometry: if a surface ever needs measuring, use `onGeometryChange`, never
// `background(GeometryReader)` — see AGENTS.md "Measure before theorising".

import AppKit
import MARVINLogic
import SwiftUI

enum SurfaceSnapshot {
    enum Coverage {
        case fixture
        case empty(String)
        case notCovered(String)

        var label: String {
            switch self {
            case .fixture: return "fixture"
            case .empty: return "empty state"
            case .notCovered: return "not covered"
            }
        }

        var note: String {
            switch self {
            case .fixture: return "populated from neutral fixtures"
            case .empty(let why), .notCovered(let why): return why
            }
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
        let make: (@MainActor () -> AnyView?)?

        init(_ id: String, _ title: String, _ coverage: Coverage,
             widths: [CGFloat], height: CGFloat? = nil,
             make: (@MainActor () -> AnyView?)? = nil) {
            self.id = id
            self.title = title
            self.coverage = coverage
            self.widths = widths
            self.height = height
            self.make = make
        }
    }

    // MARK: - Registry

    private static let paneWidths: [CGFloat] = [260, 420]
    private static let paneHeight: CGFloat = 720
    private static let offline = "no project and no sidecar, so it renders its empty/offline state"

    @MainActor
    private static var surfaces: [Surface] {
        [
            Surface("chat-transcript", "Chat transcript", .fixture, widths: [520, 900]) {
                AnyView(VStack(alignment: .leading, spacing: 10) {
                    ForEach(SurfaceFixtures.transcript) { ChatMessageRow(message: $0) }
                }.padding(16))
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

            Surface("topbar-layout-popover", "Top bar: layout popover", .empty("default bridge"), widths: [300, 420]) {
                AnyView(LayoutPopoverContent())
            },
            Surface("topbar-setup-popover", "Top bar: setup popover", .empty("default bridge"), widths: [340, 480]) {
                AnyView(SetupPopoverContent())
            },
            Surface("topbar-models-dialog", "Top bar: models dialog", .empty("default bridge; the live model list needs the sidecar"),
                    widths: [520, 720], height: 560) {
                AnyView(ModelsDialog())
            },
            Surface("topbar-project-picker", "Top bar: project picker", .empty("no project registered"), widths: [260, 420]) {
                AnyView(ProjectPickerToolbarItem().padding(8))
            },
            Surface("topbar-toolbar", "Top bar: the toolbar inside the window", .notCovered("lives in ContentView, which needs the whole live window (health, projects, sessions)"),
                    widths: [900, 1400]),

            Surface("status-bar", "Status bar", .empty("default bridge, offline health"), widths: [700, 1200]) {
                AnyView(AppStatusBar())
            },

            Surface("pane-files", "Left pane: Files", .empty(offline), widths: paneWidths, height: paneHeight) {
                AnyView(FileTreeView())
            },
            Surface("pane-search", "Left pane: Search", .empty(offline), widths: paneWidths, height: paneHeight) {
                AnyView(FindInFilesView())
            },
            Surface("pane-source-control", "Left pane: Source Control", .empty(offline), widths: paneWidths, height: paneHeight) {
                AnyView(SourceControlView())
            },
            Surface("pane-sessions", "Left pane: Sessions", .empty("no live sessions registered"), widths: paneWidths, height: paneHeight) {
                AnyView(SessionsPane())
            },
            Surface("pane-skills", "Left pane: Skills", .empty(offline), widths: paneWidths, height: paneHeight) {
                AnyView(SkillsPane())
            },
            Surface("pane-plugins", "Left pane: Plugins", .empty(offline), widths: paneWidths, height: paneHeight) {
                AnyView(PluginsPane())
            },
            Surface("pane-practice", "Left pane: Practice", .empty(offline), widths: paneWidths, height: paneHeight) {
                AnyView(PracticePane())
            },

            Surface("file-viewer", "File viewer / editor", .empty("an open file needs a project and the sidecar's file API"),
                    widths: [760, 1100], height: 560) {
                AnyView(FileViewerView())
            },
            Surface("review-changes", "Review Changes window", .empty("the file list and diffs come from /api/changes"),
                    widths: [820, 1180], height: 620) {
                AnyView(ReviewChangesScreen(model: ReviewChangesModel(cwd: SurfaceFixtures.project, marvinSessionId: "fixture-session")))
            },
            Surface("diff-sheet", "Diff sheet", .notCovered("DiffSheetModel fetches its diff from the sidecar; there is no data-only entry point"),
                    widths: [820, 1180]),

            Surface("backlog-panel", "Backlog panel", .empty("the list loads from the sidecar"), widths: [420, 640], height: 640) {
                AnyView(BacklogPanel(workDir: SurfaceFixtures.project, onPromote: { _ in }, onClose: {}, onChanged: {}))
            },
            Surface("backlog-detail", "Backlog item detail", .fixture, widths: [460, 640], height: 560) {
                guard let item = SurfaceFixtures.backlogItem else { return nil }
                return AnyView(BacklogDetailView(workDir: SurfaceFixtures.project, item: item,
                                                 onPromote: { _ in }, onChanged: {}, onDismissSheet: {}))
            },

            Surface("settings", "Settings", .empty("default bridge, offline health"), widths: [520, 760], height: 620) {
                AnyView(SettingsView())
            },

            Surface("chat-scope-met-chip", "Chat: scope-met chip strip", .notCovered("private to ChatPreviewView (4.4K lines), driven by ChatPreviewModel"),
                    widths: [520, 900]),
            Surface("terminal", "Terminal pane", .notCovered("PTY-backed; needs a live shell"), widths: [700, 1000]),
            Surface("graph-pane", "Graph (brain) pane", .notCovered("Metal-backed; needs a GPU surface, not an offscreen window"), widths: [400, 600]),
        ]
    }

    // MARK: - Entry point

    /// Returns true when it handled a snapshot run (caller should exit).
    @MainActor
    static func runIfRequested() -> Bool {
        let env = ProcessInfo.processInfo.environment
        guard let which = env["MARVIN_SNAPSHOT_VIEW"], !which.isEmpty else { return false }

        // Before anything reads ServerConfig: point at a closed port so no
        // view can reach the user's real sidecar. ServerConfig.port is a lazy
        // static, so this only works if nothing has read it yet — verify.
        if getenv("MARVIN_PORT") == nil { setenv("MARVIN_PORT", "1", 1) }
        guard ServerConfig.port != 3030 || env["MARVIN_SNAPSHOT_ALLOW_LIVE"] == "1" else {
            fail("refusing to run against port 3030 (a live sidecar). Set MARVIN_PORT to a closed port.")
            return true
        }

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
        let settle = Double(env["MARVIN_SNAPSHOT_SETTLE_MS"].flatMap(Int.init) ?? 600) / 1000

        var rows: [String] = []
        var written = 0
        for s in selected {
            guard let make = s.make else {
                rows.append("| `\(s.id)` | \(s.title) | not covered | — | \(s.coverage.note) |")
                continue
            }
            // Printed BEFORE rendering: a Swift trap can't be caught, so the
            // last line names the surface that took the run down.
            print("rendering \(s.id)")
            var files: [String] = []
            var failure: String?
            for dark in [false, true] {
                for width in s.widths {
                    guard let view = make() else { failure = "fixture failed to decode"; break }
                    guard let png = render(view, width: width, height: s.height, dark: dark, settle: settle) else {
                        failure = "render failed"
                        break
                    }
                    let name = "\(s.id)--\(dark ? "dark" : "light")--\(Int(width)).png"
                    do {
                        try png.write(to: out.appendingPathComponent(name))
                        files.append(name)
                        written += 1
                    } catch {
                        failure = "write failed: \(error)"
                    }
                }
            }
            if let failure {
                rows.append("| `\(s.id)` | \(s.title) | FAILED | \(files.count) | \(failure) |")
            } else {
                rows.append("| `\(s.id)` | \(s.title) | \(s.coverage.label) | \(files.count) | \(s.coverage.note) |")
            }
        }

        let table = """
        # Surface snapshot coverage

        | surface | title | state | PNGs | note |
        | --- | --- | --- | --- | --- |
        \(rows.joined(separator: "\n"))
        """
        try? table.write(to: out.appendingPathComponent("COVERAGE.md"), atomically: true, encoding: .utf8)
        print("wrote \(written) PNGs to \(outPath)")
        return true
    }

    private static func fail(_ message: String) {
        FileHandle.standardError.write(Data("surface snapshot: \(message)\n".utf8))
    }

    // MARK: - Rendering

    @MainActor
    private static func render(_ content: AnyView, width: CGFloat, height: CGFloat?, dark: Bool, settle: TimeInterval) -> Data? {
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let root = content
            .frame(width: width, height: height)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(MarvinBridge())
            .environment(HealthMonitor())
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

        // Let `.task` / onAppear work land (a failed fetch against the closed
        // port, a state flip) before the pixels are taken.
        RunLoop.main.run(until: Date().addingTimeInterval(settle))

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
