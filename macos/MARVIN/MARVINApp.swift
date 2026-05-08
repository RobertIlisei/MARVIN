// Phase 1a/b/c entry point — see docs/decisions/0016-swift-migration.md.
//
// The app boots a single window, polls the Node sidecar at
// http://localhost:3030/api/health, and renders one of three states
// in the content view: connecting / online (full-bleed WKWebView
// pointed at localhost:3030) / offline (with concrete instructions
// for starting the sidecar). Phase 1d (NSToolbar) and Phase 2+ are
// gated on the daily-use evaluation — see PHASE-1A-OBSERVATIONS.md.
//
// Architecture note: the sidecar is the trust boundary. The Swift
// process never reads Anthropic credentials, never spawns the
// Claude CLI, never persists session transcripts. The `.app` is
// just a window onto an already-running Node server.

import AppKit
import SwiftUI

/// Wraps an action that opens a SwiftUI window by id. `@Environment`
/// is reliable inside Views but can be nil-at-runtime when read
/// directly on an `App` — pulling it through a small View bridges
/// it into a `.commands` closure safely.
private struct OpenAboutButton: View {
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Button("About MARVIN") {
            openWindow(id: "marvin-about")
        }
    }
}

// Phase 3d retired the `OpenFilesPreviewButton` + the standalone
// "Native Files (preview)" Window scene. The native file tree now
// lives inline as the leftmost pane of the main window's HSplitView.
// FileTreeView is reused there unchanged — only the hosting Window
// scene + menu entry went away (same retirement pattern Phase 2g.3
// used for the chat preview window).
//
// Phase 4g retired the `OpenBrainPreviewButton` + the standalone
// "Brain (preview)" Window scene. The native MTKView now lives
// inline as the top of the main window's right HSplitView pane
// (above ChatPreviewView), mirroring the web app's `side-top` +
// `side-chat` panel layout. Same retirement pattern as 2g.3 / 3d
// — only the hosting Window scene + menu entry went away.
//
// Phase 5c retired the `OpenFileViewerPreviewButton` + the standalone
// "File Viewer (preview)" Window scene. The native STTextView-backed
// FileViewerView now overlays the middle webIsland in ContentView
// when a file is selected. Same retirement pattern as 2g.3 / 3d / 4g.

/// File → Open Recent submenu content. Reads the @Observable
/// singleton directly — SwiftUI's command tree does NOT inherit
/// the Window scene's environment, so an `@Environment(MarvinBridge
/// .self)` lookup here crashes at runtime ("No Observable object of
/// type MarvinBridge found"). Direct singleton read is the path the
/// SwiftUI commands DSL actually supports for menu state.
///
/// Wrapping the menu items in a View (rather than building them
/// inline inside `Menu("Open Recent") { … }`) is what gives the
/// commands DSL a tracked re-render boundary — without the View
/// wrapper, items capture a stale snapshot at command-tree creation
/// time and the list never updates.
private struct OpenRecentMenuContent: View {
    var body: some View {
        // ADR-0021 M2: ProjectsService is the authority; MarvinBridge
        // mirrors the same list but ProjectsService is the write origin.
        let projects = ProjectsService.shared.projects
        if projects.isEmpty {
            Button("(no projects yet)") {}
                .disabled(true)
        } else {
            ForEach(projects) { project in
                Button(project.name) {
                    // ADR-0021 M2 — ProjectsService owns project state;
                    // no WebView dispatch needed.
                    Task { try? await ProjectsService.shared.setActive(id: project.id) }
                }
            }
        }
    }
}

/// Reveal a directory in Finder, with the directory itself
/// selected (not its contents shown). `activateFileViewerSelecting`
/// is the AppKit idiom — same as Finder's "Reveal in Finder" entry.
/// No-op when workDir is nil or the path doesn't resolve.
@MainActor
private func revealProjectInFinder(workDir: String?) {
    guard let workDir, !workDir.isEmpty else { return }
    let url = URL(fileURLWithPath: workDir)
    NSWorkspace.shared.activateFileViewerSelecting([url])
}

/// Open Terminal.app with the working directory cd'd to workDir.
/// We hand Terminal the directory path directly via NSWorkspace —
/// `open -a Terminal /some/path` is the AppKit-equivalent of what
/// the Finder context menu's "New Terminal at Folder" does, and
/// crucially DOESN'T require Apple Events / Automation permission
/// (which AppleScript would prompt for on first use).
@MainActor
private func openTerminalAt(workDir: String?) {

    guard let workDir, !workDir.isEmpty else { return }
    let dirURL = URL(fileURLWithPath: workDir)
    let terminalURL = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
    let config = NSWorkspace.OpenConfiguration()
    NSWorkspace.shared.open(
        [dirURL],
        withApplicationAt: terminalURL,
        configuration: config
    ) { _, error in
        if let error {
            NSLog("[openTerminalAt] failed to launch Terminal: \(error)")
        }
    }
}

/// Open an NSOpenPanel so the user can pick a folder to add as a project.
/// Replaces the WebView's `open-project-picker` dispatch (ADR-0021 M5).
@MainActor
func openProjectWithPanel() {
    let panel = NSOpenPanel()
    panel.title = "Open Project Folder"
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.canCreateDirectories = false
    panel.allowsMultipleSelection = false
    panel.begin { response in
        guard response == .OK, let url = panel.url else { return }
        Task {
            try? await ProjectsService.shared.addProject(
                workDir: url.path,
                name: url.lastPathComponent
            )
        }
    }
}

/// SwiftUI lifecycle hook for app-scope AppKit state. We use this
/// only for things that genuinely don't fit in a SwiftUI scene —
/// currently the menu-bar `NSStatusItem` (Phase 1d.19), which has
/// to live on the global `NSStatusBar` and outlive any window.
///
/// Marked `@MainActor` because the `NSApplicationDelegate` callbacks
/// already run on the main thread, and our state
/// (`StatusBarController`) is itself main-actor-isolated. Without
/// the annotation, Swift 6 complains about calling
/// `StatusBarController()` from a "nonisolated" init context.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusBar = StatusBarController()

    /// Phase 1d.31 — App-Nap-disabling activity token. macOS throttles
    /// background apps' Tasks / Timers after ~5s of inactivity, which
    /// stretches HealthMonitor's 5s poll interval into 30s+ chunks.
    /// The user-visible symptom: bring MARVIN back to the foreground
    /// after working in another app, see "offline" flash for a
    /// second before the next probe lands. Holding a
    /// `.userInitiatedAllowingIdleSystemSleep` activity tells the
    /// scheduler to keep our Tasks running normally even in the
    /// background, while still letting the system sleep on its own
    /// idle timer (we don't want to keep the Mac awake).
    private var appNapToken: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Spawn the bundled sidecar FIRST — Process.run() returns the
        // moment the child is forked, well before Next.js binds to
        // 3030, so kicking it off now overlaps Node startup with the
        // SwiftUI window-creation work that follows. In dev (no
        // bundled payload), this is a fast no-op and the offline view
        // will instead guide the user to start `pnpm dev`. ADR-0023.
        SidecarManager.shared.start()

        // Install the status item once on launch. The controller
        // retains the NSStatusItem itself; we just hold the
        // controller so it doesn't deallocate.
        statusBar.install()

        appNapToken = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep],
            reason: "MARVIN polls the local sidecar every 5s — App Nap throttling causes spurious offline flashes on foreground."
        )
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Tear down the bundled sidecar before the AppKit run-loop
        // exits. Without this, the `node server.js` child survives
        // Cmd-Q and keeps :3030 bound until the user logs out — a
        // surprising "ghost server" the next launch fights with.
        SidecarManager.shared.stop()

        if let token = appNapToken {
            ProcessInfo.processInfo.endActivity(token)
            appNapToken = nil
        }
    }

    /// Phase 1d.34 — keep the app alive when the user closes the
    /// main window with ⌘W. Standard macOS behaviour for any app
    /// that has a status item (Mail, Messages, Music, Things,
    /// 1Password — none of them quit on last-window-closed). Re-open
    /// happens from the menu-bar status item's "Show MARVIN" entry
    /// or its left-click action; `applicationShouldHandleReopen` (by
    /// default true on macOS) also re-opens the window when the user
    /// clicks the Dock icon.
    ///
    /// Without this, ⌘W on the main window terminates the whole
    /// process — so the bridge state, the App-Nap activity, the
    /// status-item icon swap, and the WebView all tear down. The
    /// next launch is a 1-2s cold start instead of an instant
    /// re-show.
    func applicationShouldTerminateAfterLastWindowClosed(
        _ sender: NSApplication
    ) -> Bool {
        false
    }

    /// Phase 1d.34 — ensure clicking the Dock icon re-opens the main
    /// window after the user closed it. macOS calls this when the
    /// app is reactivated and `flag` is false (no visible windows);
    /// returning true tells the framework to fall through to
    /// `applicationDidFinishLaunching`-like reopen behaviour. Our
    /// SwiftUI Window scene re-creates the window on this signal.
    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        true
    }

    /// Phase 1d.30 — accept folder drops on the Dock icon AND
    /// `open MARVIN-Swift.app /some/folder` from the command line.
    /// Both go through the same path: validate the URL is a real
    /// directory, then forward to the web side as the same
    /// `marvin:dropped-folder` CustomEvent the in-window drag-drop
    /// uses (Phase 1d.29). The web's addProject handler is the
    /// single authoritative place that decides what to do with a
    /// path — manifest sniff, CLAUDE.md detection, dedup against
    /// the existing registry, etc.
    func application(_ application: NSApplication, open urls: [URL]) {
        // We may be invoked before the WebView has even mounted
        // (cold-start with a folder argument). Retry on a timer so
        // the dispatch lands once the page is up — bounded so a
        // sidecar that never starts doesn't leak retries forever.
        for url in urls {
            forwardFolder(url, retriesRemaining: 30)
        }
    }

    // ADR-0021 M2 — ProjectsService.addProject replaces the web-side
    // `dropped-folder` dispatch. Retry on failure (sidecar may still
    // be starting on a cold-launch open-with scenario).
    private func forwardFolder(_ url: URL, retriesRemaining: Int) {
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(
            atPath: url.path,
            isDirectory: &isDir
        )
        guard exists, isDir.boolValue else { return }
        Task {
            do {
                try await ProjectsService.shared.addProject(
                    workDir: url.path,
                    name: url.lastPathComponent
                )
            } catch {
                guard retriesRemaining > 0 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    self?.forwardFolder(url, retriesRemaining: retriesRemaining - 1)
                }
            }
        }
    }

    /// Phase 1d.28 — guard ⌘Q when MARVIN is mid-turn.
    ///
    /// Without this, an accidental ⌘Q during streaming kills the
    /// WebView and the in-flight Claude CLI request together —
    /// silently, with no chance to confirm. The confirmation is
    /// the same modal pattern Mail / Messages show when there's
    /// unsent draft state. We only prompt when the bridge reports
    /// busy; idle quits proceed normally with no friction.
    ///
    /// Returns:
    ///   • .terminateNow when idle or the user chose Quit.
    ///   • .terminateCancel when the user chose Cancel.
    func applicationShouldTerminate(
        _ sender: NSApplication
    ) -> NSApplication.TerminateReply {
        guard MarvinBridge.shared.isBusy else { return .terminateNow }

        let alert = NSAlert()
        alert.messageText = "MARVIN is still working."
        alert.informativeText = "Quitting now will cancel the current turn. Continue?"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        alert.buttons.first?.hasDestructiveAction = true

        // .alertFirstButtonReturn = Quit; default Esc maps to the
        // second button (Cancel) which is the safe choice.
        let response = alert.runModal()
        return response == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }
}

@main
struct MARVINApp: App {
    /// Bridge AppKit-only app-scope state (menu-bar item) into
    /// SwiftUI's lifecycle. Nothing else uses the delegate today.
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    /// Health monitor lives at app scope so the connection state
    /// survives window opens/closes (Phase 1+ may add multi-window).
    @State private var health = HealthMonitor()

    /// JS↔Swift bridge — singleton, but threaded through the
    /// environment so SwiftUI observation tracks `webTitle` and
    /// future @Observable fields (project, cost, etc. as the
    /// migration phases land).
    private let bridge = MarvinBridge.shared

    var body: some Scene {
        Window("MARVIN", id: "marvin-main") {
            ContentView()
                .environment(health)
                .environment(bridge)
                // 1440×900 default + 960×600 floor.
                // `frameAutosaveName` (wired below) restores the
                // user's last frame in preference to ideal* on
                // subsequent launches.
                .frame(
                    minWidth: 960,
                    idealWidth: 1440,
                    minHeight: 600,
                    idealHeight: 900
                )
                .task {
                    // Start polling on launch; the monitor self-stops
                    // when the window closes (Phase 1a only has one).
                    await health.start()
                }
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified)
        .commands {
            // Phase 1b — native menu bar.
            //
            // Standard macOS menus (App / Edit / Window) are
            // provided by SwiftUI for free. We extend the App menu
            // (custom About), View, and Help with MARVIN-specific
            // items.
            //
            // Deliberately NOT claimed by SwiftUI here: ⌘K, ⌘B/G/J/P,
            // ⌘⇧N, ⌘., `?`. Those are the web-app's keyboard
            // shortcuts, handled by React inside the WebView. If a
            // SwiftUI menu item assigned `keyboardShortcut("k", ...)`
            // it would intercept ⌘K and the web side would never
            // hear it. Phase 1d (NSToolbar + bridge) replaces the
            // web-rendered top bar properly; until then, the web
            // shortcuts pass through untouched.

            // App → About MARVIN. Replaces SwiftUI's default
            // generated About panel (which only shows version +
            // copyright) with our custom AboutView that surfaces
            // live sidecar status — useful during the migration
            // evaluation to confirm which build is running and what
            // the sidecar reports.
            CommandGroup(replacing: .appInfo) {
                OpenAboutButton()
            }

            // ADR-0021 M5: Reload/Zoom/Find were WebView-only — removed.
            // ⌘R reconnects the sidecar health probe from the offline view's
            // "Reconnect" button. Native NSTextFinder for ⌘F is a follow-up.

            // Phase 1d.25 — File → New Session (⌘⇧N). ADR-0021 M5:
            // WebView removed; the native ChatPreviewView manages sessions.
            // Kept as a placeholder that will wire to ChatPreviewModel.reset()
            // once the native session-reset path is formalised.
            CommandGroup(replacing: .newItem) {
                Button("New Session") {}
                    .keyboardShortcut("n", modifiers: [.command, .shift])
                    .disabled(true)
            }

            // Phase 1d.23 — File menu items that act on the active
            // project's workDir. Both depend on the bridge —
            // disabled when no project is selected — and are net-
            // additive native affordances expected of any project-
            // oriented Mac app. SwiftUI's default "File" menu has
            // .newItem / .undoRedo / .pasteboard groups; .saveItem
            // is the conventional slot for project-state actions.
            CommandGroup(after: .saveItem) {
                Divider()

                // ADR-0021 M5: native NSOpenPanel replaces the WebView dispatch.
                Button("Open Project…") {
                    openProjectWithPanel()
                }
                .keyboardShortcut("o", modifiers: [.command])

                // Phase 1d.33 — File → Open Recent submenu populated
                // from the bridge. Click on a project to make it
                // active without going through the web picker.
                Menu("Open Recent") {
                    OpenRecentMenuContent()
                }
                .disabled(!health.state.isOnline)

                Divider()

                Button("Reveal Project in Finder") {
                    revealProjectInFinder(workDir: bridge.projectWorkDir)
                }
                .keyboardShortcut("r", modifiers: [.command, .option])
                .disabled(bridge.projectWorkDir == nil)

                Button("Open Terminal Here") {
                    openTerminalAt(workDir: bridge.projectWorkDir)
                }
                .keyboardShortcut("t", modifiers: [.command, .option])
                .disabled(bridge.projectWorkDir == nil)
            }

            // Phase 1d.25 — Window menu shortcuts that bridge to web
            // app dialogs (theme toggle, keyboard shortcuts panel).
            // Both already work via web hotkeys (⌘⇧T isn't claimed
            // anywhere; `?` opens shortcuts), but the menu bar makes
            // them discoverable for users who don't know the web
            // hotkey set yet. .windowList is the conventional slot
            // for "show me UI surfaces" actions.
            CommandGroup(after: .windowList) {
                Divider()
                Button("Toggle Theme") {
                    let next = NativePrefs.shared.themeName == "dark" ? "light" : "dark"
                    NativePrefs.shared.setTheme(next)
                }
                .keyboardShortcut("t", modifiers: [.command, .shift])

                Button("Keyboard Shortcuts…") {
                    // Phase 5d — fire native shortcuts sheet via the
                    // bridge's one-shot trigger. ContentView observes
                    // and flips its local sheet state. The web peer
                    // is no longer needed because the swift shell
                    // owns its own keymap surface.
                    MarvinBridge.shared.triggerShortcutsHelp()
                }
                .keyboardShortcut("/", modifiers: [.command])

                Button("Quick Open File…") {
                    MarvinBridge.shared.triggerQuickOpen()
                }
                .keyboardShortcut("p", modifiers: [.command])
                .disabled(!health.state.isOnline)

                Button("Go to Symbol…") {
                    MarvinBridge.shared.triggerSymbolSearch()
                }
                .keyboardShortcut("t", modifiers: [.command])
                .disabled(MarvinBridge.shared.projectWorkDir == nil)

                Button("Run Build Task…") {
                    MarvinBridge.shared.triggerBuildTask()
                }
                .keyboardShortcut("b", modifiers: [.command, .shift])
                .disabled(MarvinBridge.shared.projectWorkDir == nil)

                Divider()

                // Pane toggles. The TopBarPopover already advertises
                // these as the canonical kbd hints (⌘B / ⌘G / ⌘J / ⌘⇧P);
                // the bindings here are what makes those hints real.
                // NativePrefs.togglePane writes the new state through
                // both UserDefaults and bridge.panes so every reader
                // (ContentView, TopBarPopover, the persisted prefs) sees
                // the same value.
                Button("Toggle File Tree") {
                    NativePrefs.shared.togglePane("files")
                }
                .keyboardShortcut("b", modifiers: [.command])

                Button("Toggle Knowledge Graph") {
                    NativePrefs.shared.togglePane("graph")
                }
                .keyboardShortcut("g", modifiers: [.command])
                .disabled(MarvinBridge.shared.projectWorkDir == nil)

                Button("Toggle Terminal") {
                    NativePrefs.shared.togglePane("terminal")
                }
                .keyboardShortcut("j", modifiers: [.command])
                .disabled(MarvinBridge.shared.projectWorkDir == nil)

                Button("Toggle Browser Preview") {
                    NativePrefs.shared.togglePane("preview")
                }
                .keyboardShortcut("p", modifiers: [.command, .shift])
                .disabled(MarvinBridge.shared.projectWorkDir == nil)

                // Phase 2g.3 retired the standalone "Native Chat
                // (preview)" window. Phase 3d retired the standalone
                // "Native Files (preview)" window. Phase 4g retired
                // the standalone "Brain (preview)" window. Phase 5c
                // retired the "File Viewer (preview)" window — the
                // native viewer now overlays the middle pane inline.
                // All four surfaces live inline as panes (or sub-
                // panes / overlays) of the main window's HSplitView.
            }

            // Help menu — quick links out to the project. macOS
            // already auto-creates a Help menu with a search field
            // and a "$AppName Help" item; CommandGroup(replacing:
            // .help) lets us put real items there.
            CommandGroup(replacing: .help) {
                Button("MARVIN on GitHub") {
                    if let url = URL(string: "https://github.com/RobertIlisei/MARVIN") {
                        NSWorkspace.shared.open(url)
                    }
                }
                Button("Report an Issue…") {
                    if let url = URL(string: "https://github.com/RobertIlisei/MARVIN/issues/new") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }

        // Phase 1c — custom About panel. Mounted as a separate
        // Window scene so it gets its own window-state / close-
        // button / ⌘W behavior for free. Opened via the App menu's
        // About item (CommandGroup(replacing: .appInfo) above).
        // .commandsRemoved() keeps the About window from
        // contributing duplicate menu items when it has focus.
        Window("About MARVIN", id: "marvin-about") {
            AboutView()
                .environment(health)
                .environment(bridge)
        }
        .windowResizability(.contentSize)
        .windowStyle(.hiddenTitleBar)
        .commandsRemoved()

        // Phase 4g retired the standalone "Brain (preview)" Window
        // scene — see retirement comment near OpenBrainPreviewButton
        // above. The native MTKView lives inline in BrainPaneView
        // at the top of the main window's right HSplitView pane.
        //
        // Phase 5c retired the standalone "File Viewer (preview)"
        // Window scene. The native STTextView-backed FileViewerView
        // overlays the middle webIsland in ContentView when a file
        // is selected (read from bridge.selectedFilePath). Same
        // retirement pattern as 2g.3 / 3d / 4g.

        // Phase 1d.9 — native Settings scene (⌘,). SwiftUI's
        // `Settings` scene is special: it auto-installs the
        // "Settings…" item in the App menu and binds ⌘, to it,
        // no manual command wiring needed. The view itself only
        // touches local native affordances — open data dir, open
        // project workDir, reset window frame, re-probe sidecar.
        // Anything that should mutate sidecar state stays in the
        // web app's existing settings popover.
        Settings {
            SettingsView()
                .environment(health)
                .environment(bridge)
        }

    }
}
