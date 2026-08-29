// ContentView — main window.
//
// Three states wired to HealthMonitor.state:
//   • connecting — soft "starting up" message + spinner
//   • online     — native SwiftUI chat/file-tree/terminal/source-control
//                  shell, talking to the sidecar's `/api/**` routes over
//                  `http://localhost:3030`. No browser or WKWebView is
//                  involved — the sidecar's own UI was removed (ADR-0075);
//                  it's an API-only backend now.
//   • offline    — the failure reason, plus a copyable command for
//                  starting the sidecar.

import MARVINLogic
import SwiftUI


struct ContentView: View {
    @Environment(HealthMonitor.self) private var health
    @Environment(MarvinBridge.self) private var bridge

    /// Phase 1d.35 — gate the auto-start-sidecar attempt so it
    /// fires at most once per launch. Without this flag, every
    /// health probe that returns offline would spawn another
    /// `bin/marvin start` process — which is harmless because the
    /// shell script idempotents itself, but generates spurious
    /// processes and confuses tail-the-launchd-log workflows.
    @State private var autoStartAttempted = false

    /// Phase 5d — toolbar popover open state. Each popover is bound
    /// to a discrete bool so opening one auto-dismisses the other
    /// (SwiftUI `.popover(isPresented:)` only allows one at a time
    /// per anchor). Phase 5e dropped the Setup popover (its controls
    /// moved under the chat input as a Cursor-style agents footer);
    /// modelsDialogOpen now opens from the ChatAgentsFooter scope,
    /// not the toolbar.
    @State private var layoutPopoverOpen = false
    @State private var quickOpenOpen = false
    @State private var symbolSearchOpen = false
    @State private var buildTaskOpen = false
    @State private var shortcutsOpen = false

    var body: some View {
        // Phase 5f — outermost VStack so the global bottom status bar
        // (AppStatusBar) spans the full window width below every pane.
        // Cursor / VS Code / IntelliJ all do this — the bottom strip is
        // app-scoped chrome, not a per-pane affordance. Sits flush
        // against the window's bottom edge so the transition from
        // content to chrome is one visual surface.
        VStack(spacing: 0) {
            mainContent
                // Hairline under the title bar — the toolbar and the
                // content are the same fill now (flat theme), so without
                // this the top edge has no definition (user, 2026-08-29).
                .overlay(alignment: .top) {
                    Rectangle().fill(MarvinTheme.border).frame(height: 1)
                }
            AppStatusBar()
                .environment(bridge)
                .environment(health)
        }
        .frame(minWidth: 480, minHeight: 320)
        .preferredColorScheme(bridge.preferredColorScheme)
        .background(WindowAccessor { window in
            window.setFrameAutosaveName("MARVINMainWindow")
            // Match the window's own fill to the theme so the split
            // views' live-resize gaps and the title bar blend instead of
            // flashing the system window color.
            window.backgroundColor = MarvinTheme.backgroundNSColor
        })
        .toolbar { toolbarContent }
        // Flat solid title bar instead of the system's translucent
        // material — matches the rest of the Antigravity-redesign
        // pass. Traffic lights / drag region are untouched; only the
        // fill color changes. Bundled into one ViewModifier (rather
        // than two chained `.toolbarBackground` calls) because the
        // outer body is already a very long modifier chain and two
        // more generic calls pushed the type-checker over its time
        // budget ("unable to type-check in reasonable time").
        .modifier(FlatToolbarBackground())
        .sheet(isPresented: $quickOpenOpen) {
            QuickOpenSheet()
                .environment(bridge)
        }
        .sheet(isPresented: $symbolSearchOpen) {
            SymbolSearchSheet()
                .environment(bridge)
        }
        .sheet(isPresented: $buildTaskOpen) {
            BuildTaskSheet()
                .environment(bridge)
        }
        .sheet(isPresented: $shortcutsOpen) {
            ShortcutsHelpSheet()
        }
        .onChange(of: bridge.shortcutsTriggerCount) { _, _ in
            shortcutsOpen = true
        }
        .onChange(of: bridge.quickOpenTriggerCount) { _, _ in
            if bridge.projectWorkDir != nil {
                quickOpenOpen = true
            }
        }
        .onChange(of: bridge.symbolSearchTriggerCount) { _, _ in
            if bridge.projectWorkDir != nil {
                symbolSearchOpen = true
            }
        }
        .onChange(of: bridge.buildTaskTriggerCount) { _, _ in
            if bridge.projectWorkDir != nil {
                buildTaskOpen = true
            }
        }
        .navigationTitle(bridge.webTitle ?? "MARVIN")
        .navigationSubtitle(composeSubtitle())
        .onChange(of: bridge.webTitle ?? "") { _, newTitle in
            let count = parseConfirmCount(newTitle)
            updateDockBadge(count: count)
            NotificationManager.shared.updateConfirmCount(count)
        }
        .onChange(of: bridge.projectWorkDir ?? "") { _, newWorkDir in
            updateRepresentedURL(workDir: newWorkDir.isEmpty ? nil : newWorkDir)
            if !newWorkDir.isEmpty {
                Task { await DiagnosticsService.shared.refresh(workDir: newWorkDir) }
            }
        }
        .onChange(of: health.state.isOffline) { _, isOffline in
            maybeAutoStartSidecar(isOffline: isOffline)
        }
        .task {
            maybeAutoStartSidecar(isOffline: health.state.isOffline)
        }
    }

    /// The pre-status-bar app body. Three connection states (connecting
    /// / online / offline). Pre-Phase-5f this was the entire body;
    /// 5f wraps it under a VStack so AppStatusBar sits below.
    @ViewBuilder
    private var mainContent: some View {
        ZStack {
            MarvinTheme.background
                .ignoresSafeArea()
            switch health.state {
            case .connecting:
                connectingView
            case .online:
                if bridge.projectWorkDir == nil {
                    // No active project. First-launch users hit
                    // OnboardingView — a brief welcome + credential
                    // check. Subsequent launches drop straight to
                    // WelcomeView (the existing project picker).
                    // hasCompletedOnboarding flips when the user
                    // dismisses OnboardingView's last step.
                    if !NativePrefs.shared.hasCompletedOnboarding {
                        OnboardingView()
                            .transition(.opacity)
                    } else {
                        WelcomeView()
                            .environment(bridge)
                            .transition(.opacity)
                    }
                } else {
                // IDE-style 3-pane split — every divider is a
                // draggable NSSplitView handle. The ideal sizes are
                // hints for first launch; idealWidth / idealHeight
                // pre-position the dividers but the user can drag
                // freely within [minWidth … available].
                HSplitView {
                    // `files` / `brain` pane toggles (⌘B, layout
                    // popover) gate their panes here — before
                    // 2026-07-03 the flags were written but never
                    // read (the stale-buttons audit finding).
                    // Conditional removal resets the autosaved
                    // divider on toggle; acceptable, and hiding the
                    // brain actually stops its Metal render loop.
                    if bridge.panes.files {
                        LeftPane()
                            // minWidth is the RAIL's width, not the sidebar's:
                            // dragging the divider left past LeftPane's own
                            // collapse threshold hides the content and leaves
                            // the icon rail, the way VS Code / Antigravity do.
                            // Clamping at 200 was what made the pane "remain at
                            // an exact size" (user, 2026-08-29).
                            .frame(minWidth: 45, idealWidth: 260)
                            .background(SplitViewAutosave(name: "marvin.main"))
                    }
                    webIsland
                        .frame(minWidth: 320)
                    // Right pane mirrors the web `side` aside —
                    // brain on top of chat. VSplitView lets the
                    // user drag the brain/chat split anywhere
                    // between the two children's minimums (no
                    // maxHeight cap — the user might want all
                    // brain or all chat).
                    VSplitView {
                        if bridge.panes.brain {
                            BrainPaneView()
                                .frame(minHeight: 120, idealHeight: 280)
                                .background(SplitViewAutosave(name: "marvin.right"))
                        }
                        ChatPreviewView()
                            .frame(minHeight: 200)
                    }
                    .frame(minWidth: 320, idealWidth: 480)
                }
                // NB: no `.animation(value: bridge.panes)` on the split —
                // animating an NSSplitView-backed layout feeds AppKit's
                // update-constraints loop (ADR-0062); it crashed at launch
                // on 2026-08-29. Pane toggles snap; contents animate.
                } // end else (project active)
            case .offline(let reason):
                offlineView(reason: reason)
            }
        }
    }

    /// Native NSToolbar contents — extracted so the outer body can
    /// stay focused on the VStack composition (mainContent +
    /// AppStatusBar).
    ///
    /// Phase 5f de-duplicated chrome: project picker, connection
    /// status, and the cost pill all moved to the `AppStatusBar`
    /// at the bottom of the window so they only render once. The
    /// toolbar keeps only ACTIONS — Layout, Quick Open. Cursor /
    /// VS Code use the same split (status at the bottom, actions at
    /// the top) so the user's eye learns one rule.
    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button {
                layoutPopoverOpen.toggle()
            } label: {
                Label("Layout", systemImage: "rectangle.3.group")
            }
            .help("Toggle panes — files, graph, brain, preview, terminal")
            .popover(
                isPresented: $layoutPopoverOpen,
                arrowEdge: .bottom
            ) {
                LayoutPopoverContent()
                    .environment(bridge)
            }
        }
        ToolbarItem(placement: .navigation) {
            Button {
                quickOpenOpen = true
            } label: {
                Label("Quick Open", systemImage: "magnifyingglass")
            }
            .keyboardShortcut("p", modifiers: [.command])
            .disabled(bridge.projectWorkDir == nil)
            .help("Quick Open file (⌘P)")
        }
    }

    /// Auto-start gate. Reads UserDefaults for the user opt-out,
    /// resolves a marvin binary, and at most once per session
    /// fires `startSidecar()`. The attempt is fire-and-forget —
    /// success is visible via the next health probe, failure shows
    /// up as the offline view continuing to render with manual
    /// affordances.
    private func maybeAutoStartSidecar(isOffline: Bool) {
        guard isOffline,
              !autoStartAttempted,
              autoStartEnabled,
              marvinBinaryPath != nil
        else { return }
        autoStartAttempted = true
        startSidecar()
    }

    /// User pref — defaults to true (silently auto-start), set
    /// to false via Settings → "Auto-start sidecar at launch".
    /// UserDefaults is read on every offline transition so a flip
    /// in Settings takes effect on the next probe without needing
    /// a relaunch.
    private var autoStartEnabled: Bool {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: "marvin.autoStartSidecar") == nil {
            // First read — populate the default explicitly so the
            // Settings toggle has a known starting state to render.
            defaults.set(true, forKey: "marvin.autoStartSidecar")
            return true
        }
        return defaults.bool(forKey: "marvin.autoStartSidecar")
    }

    /// Parse the leading `(N)` pending-confirm count out of a
    /// document.title. Anchored prefix match to avoid false
    /// positives like "(deferred) MARVIN". Returns 0 when no match.
    private func parseConfirmCount(_ title: String) -> Int {
        let pattern = #"^\((\d+)\)"#
        guard let range = title.range(of: pattern, options: .regularExpression) else {
            return 0
        }
        let inner = title[range].dropFirst().dropLast() // strip "(" and ")"
        return Int(inner) ?? 0
    }

    /// Set the macOS Dock badge to a non-empty count, or clear it.
    private func updateDockBadge(count: Int) {
        NSApp.dockTile.badgeLabel = count > 0 ? String(count) : ""
    }

    /// ADR-0021 M5: WebView removed. The middle pane is now purely native —
    /// workPaneSplit directly, with folder-drop forwarded to ProjectsService.
    /// Tabs that have been activated at least once — see `bottomPanesArea`.
    @State private var mountedBottomTabs: Set<BottomPanelTab> = []

    private var webIsland: some View {
        workPaneSplit
            .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                handleFolderDrop(providers: providers)
            }
            .animation(.easeOut(duration: 0.18), value: bridge.selectedFilePath)
    }

    /// Vertical split between the editor (top) and the bottom panes
    /// (preview / terminal). The VSplitView stays in the hierarchy at
    /// all times so the divider position survives pane toggles — a
    /// conditional if/else would recreate the NSSplitView each time,
    /// resetting the saved position. When no bottom pane is active the
    /// bottom child collapses to zero height; the system hides the
    /// divider automatically when a subview is collapsed.
    private var workPaneSplit: some View {
        let hasBottomPane = bridge.panes.bottom.isOpen
        return VSplitView {
            editorArea
                .frame(minHeight: 120)
                .background(SplitViewAutosave(name: "marvin.work"))
            bottomPanesArea
                .frame(
                    minHeight: hasBottomPane ? 120 : 0,
                    idealHeight: hasBottomPane ? 280 : 0,
                    maxHeight: hasBottomPane ? .infinity : 0
                )
        }
    }

    /// Editor surface — file viewer when there's an active tab,
    /// native empty-state hint otherwise.
    @ViewBuilder
    private var editorArea: some View {
        if let path = bridge.selectedFilePath, !path.isEmpty {
            FileViewerView()
                .transition(.opacity)
        } else {
            workPaneEmptyHint
                .transition(.opacity)
        }
    }

    /// The bottom panel: a tab strip and one visible pane (plan §D).
    ///
    /// Was four independent panes in an `HSplitView` when 2+ were on and a
    /// bare `if/else` chain when 1 was — so toggling 1→2 swapped view
    /// identity and destroyed each pane's `@State`, and Problems was
    /// unreachable unless its status-bar pill happened to be rendering.
    /// Now every tab stays mounted (`keptMounted`), so terminal scrollback
    /// and scroll offsets survive a switch.
    @ViewBuilder
    private var bottomPanesArea: some View {
        let panel = bridge.panes.bottom
        VStack(spacing: 0) {
            bottomTabStrip(panel)
            MarvinDivider()
            ZStack {
                // Gated on first activation so an unopened Graph tab never
                // pays for a WKWebView it may never show.
                if mountedBottomTabs.contains(.problems) {
                    DiagnosticsPanelView().environment(bridge)
                        .keptMounted(active: panel.activeTab == .problems)
                }
                if mountedBottomTabs.contains(.terminal) {
                    TerminalPaneView().environment(bridge)
                        .keptMounted(active: panel.activeTab == .terminal)
                }
                if mountedBottomTabs.contains(.preview) {
                    PreviewPaneView().environment(bridge)
                        .keptMounted(active: panel.activeTab == .preview)
                }
                if mountedBottomTabs.contains(.graph) {
                    GraphPaneView().environment(bridge)
                        .keptMounted(active: panel.activeTab == .graph)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onChange(of: panel.activeTab, initial: true) { _, tab in
            if panel.isOpen { mountedBottomTabs.insert(tab) }
        }
    }

    private func bottomTabStrip(_ panel: BottomPanelState) -> some View {
        HStack(spacing: 2) {
            ForEach(BottomPanelTab.allCases, id: \.rawValue) { tab in
                let active = panel.activeTab == tab
                Button {
                    NativePrefs.shared.selectBottomTab(tab)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: tab.symbol)
                            .font(.system(size: 10))
                        Text(tab.title)
                            .font(.system(size: 11))
                        if tab == .problems {
                            let n = bridge.errorCount + bridge.warningCount
                            if n > 0 {
                                Text(n.formatted())
                                    .font(.system(size: 9, design: .monospaced))
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1)
                                    .background(
                                        (bridge.errorCount > 0 ? Color.red : Color.orange).opacity(0.22),
                                        in: Capsule()
                                    )
                            }
                        }
                    }
                    .foregroundStyle(active ? AnyShapeStyle(MarvinTheme.textPrimary) : AnyShapeStyle(.secondary))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(active ? MarvinTheme.elevated : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
                .help(tab.title)
            }
            Spacer()
            Button {
                NativePrefs.shared.toggleBottomPanel()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tertiary)
            .help("Hide panel (⌘J)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(nsColor: .underPageBackgroundColor))
    }

    /// Native empty-state hint shown over the middle pane when no
    /// file is open. Mirrors the IDE feel users expect (VS Code's
    /// welcome surface, Xcode's "No Editor"). Pure SwiftUI; reads
    /// no bridge state beyond presence detection so it stays cheap.
    private var workPaneEmptyHint: some View {
        VStack(spacing: 12) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 36, weight: .light))
                .foregroundStyle(.tertiary)
            Text("No file open")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("Select a file from the tree on the left, or right-click a row to create / rename / delete.")
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Fully opaque — anything translucent here shows the WebView's
        // chrome (project picker stripe, status-rail, brand marks) as
        // a faint ghost layer behind the native shell. The native
        // chrome IS the chrome.
        .background(Color(nsColor: .textBackgroundColor))
    }

    /// Resolve dropped NSItemProviders to file URLs, take the first
    /// directory, and forward it to the web side as a `marvin:
    /// dropped-folder` CustomEvent. Skips files (not directories) so
    /// the user can't accidentally add a stray .txt as a "project".
    /// Returns true to tell SwiftUI we've consumed the drop —
    /// otherwise the WebView's default file-drop handler kicks in
    /// and would try to navigate to file:// (which navigationDelegate
    /// already blocks but the visual feedback would be wrong).
    // ADR-0021 M2 — ProjectsService.addProject replaces the web-side
    // `dropped-folder` dispatch. No confirmation dialog: the drop is
    // intentional, immediate project switch is the feedback.
    private func handleFolderDrop(providers: [NSItemProvider]) -> Bool {
        guard let provider = providers.first else { return false }
        provider.loadObject(ofClass: URL.self) { url, _ in
            guard let url else { return }
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(
                atPath: url.path,
                isDirectory: &isDir
            )
            guard exists, isDir.boolValue else { return }
            Task { @MainActor in
                try? await ProjectsService.shared.addProject(
                    workDir: url.path,
                    name: url.lastPathComponent
                )
            }
        }
        return true
    }

    /// Set NSWindow.representedURL on the main window so the title
    /// bar shows the project folder's Finder icon. Looking up the
    /// window via NSApp.windows is fine for our single-main-window
    /// app; if the migration ever goes multi-window, this needs to
    /// take a window reference instead.
    private func updateRepresentedURL(workDir: String?) {
        let aboutTitle = "About MARVIN"
        guard let mainWindow = NSApp.windows.first(where: { $0.title != aboutTitle }) else {
            return
        }
        if let workDir, !workDir.isEmpty {
            mainWindow.representedURL = URL(fileURLWithPath: workDir)
        } else {
            mainWindow.representedURL = nil
        }
    }

    /// Compose the NSWindow subtitle from the bridge state. Three
    /// shapes: empty (no project), "$project" (no git), or
    /// "$project · $branch" with an optional dirty pip suffix.
    private func composeSubtitle() -> String {
        guard let project = bridge.projectName else { return "" }
        guard let branch = bridge.branch else { return project }
        let dirty = bridge.branchDirtyCount > 0 ? " ●" : ""
        return "\(project) · \(branch)\(dirty)"
    }

    // MARK: - States

    private var connectingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Connecting to MARVIN sidecar…")
                .font(.body.monospaced())
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func offlineView(reason: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.orange)
                    .frame(width: 10, height: 10)
                Text("Sidecar not reachable")
                    .font(.title3.weight(.semibold))
            }
            Text(reason)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            MarvinDivider()
            VStack(alignment: .leading, spacing: 6) {
                Text("Start the sidecar")
                    .font(.callout.weight(.semibold))
                CodeBlock(text: "bin/marvin start")
                Text("Run from the MARVIN repo root. The Node server bound to port 3030 is what this app talks to.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                Button("Open Terminal") {
                    openTerminal()
                }
                if marvinBinaryPath != nil {
                    Button("Start Sidecar") {
                        startSidecar()
                    }
                    .help("Spawns bin/marvin start in the background via a login shell")
                }
                Spacer()
                Button("Reconnect") {
                    Task { await health.refreshNow() }
                }
                .keyboardShortcut("r", modifiers: [.command])
            }
        }
        .padding(28)
        .frame(maxWidth: 520, maxHeight: .infinity, alignment: .topLeading)
    }

    /// First MARVIN binary found in the conventional clone
    /// locations. `nil` if none — in that case the offline view
    /// hides the "Start Sidecar" button and the user falls back to
    /// "Open Terminal" + manual run. Phase 1d.16.
    private var marvinBinaryPath: String? {
        let home = NSHomeDirectory()
        let candidates = [
            "\(home)/marvin/bin/marvin",
            "\(home)/code/marvin/bin/marvin",
            "\(home)/dev/marvin/bin/marvin",
            "\(home)/Documents/marvin/bin/marvin",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Open Terminal.app — pure NSWorkspace, no shell spawn.
    /// Always available, no permission concerns.
    private func openTerminal() {
        let url = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        NSWorkspace.shared.open(url)
    }

    /// Spawn `bin/marvin start` from the MARVIN repo root via
    /// `/bin/zsh -l -c …`. The login shell (`-l`) picks up the
    /// user's `.zshrc` PATH so pnpm / node / claude etc. resolve —
    /// without that, GUI-spawned processes have a minimal PATH
    /// (`/usr/bin:/bin:/usr/sbin:/sbin`) and `bin/marvin` immediately
    /// fails its preflight checks. The script is designed to fork
    /// the dev server and exit, so we don't have to keep the
    /// Process alive past launch.
    private func startSidecar() {
        guard let binPath = marvinBinaryPath else { return }
        // binPath is "<repoRoot>/bin/marvin"; strip both segments
        // via two NSString.deletingLastPathComponent. Avoids the
        // hazard of `replacingOccurrences("/bin", "")` over-matching
        // when the user's home itself contains "/bin" (rare but
        // possible — `/Users/sbin/marvin/...` etc.).
        let binDir = (binPath as NSString).deletingLastPathComponent
        let repoRoot = (binDir as NSString).deletingLastPathComponent
        let task = Process()
        task.currentDirectoryURL = URL(fileURLWithPath: repoRoot)
        task.executableURL = URL(fileURLWithPath: "/bin/zsh")
        task.arguments = ["-l", "-c", "./bin/marvin start"]
        do {
            try task.run()
        } catch {
            NSLog("[MARVIN-Swift] Failed to spawn sidecar: \(error)")
        }
    }

}

private struct FlatToolbarBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .toolbarBackground(MarvinTheme.background, for: .windowToolbar)
            .toolbarBackground(.visible, for: .windowToolbar)
    }
}

// Phase 5f retired CostToolbarItem and ConnectionStatusToolbarItem.
// Both used to live in the toolbar's primary-action slot; the global
// AppStatusBar now hosts the cost segment (with the same daily-
// history popover) and the connection pip (clickable to re-probe),
// so the toolbar stays focused on actions and the bottom bar owns
// status — Cursor / VS Code split.

/// Native counterpart to the web `<CostPill>` popover. Renders the
/// same fields (today / 7d / lifetime / turns / tokens) plus a
/// daily-history bar chart with day labels and immediate hover
/// feedback (matching the web pill's group-hover overlay). Phase 1d.6.
///
/// Lifted to file scope in Phase 5f so `AppStatusBar` (the new
/// global bottom strip) can reuse it from its own cost segment —
/// the toolbar pill it used to anchor was retired in the same
/// phase as part of de-duplicating top + bottom chrome.
struct CostHistoryPopover: View {
    let summary: CostSummary
    /// ADR-0082 — on a Claude subscription the `$` figures are what the
    /// tokens WOULD cost at API rates (the SDK's `total_cost_usd`); nothing
    /// is billed per token. Say so, or "$31,125 lifetime" reads as a bill.
    var subscription: Bool = false
    @State private var hoveredDay: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(subscription ? "api-equivalent cost · this project" : "cost for this project")
                .font(.caption.monospaced())
                .tracking(2)
                .textCase(.uppercase)
                .foregroundStyle(.tertiary)
            if subscription {
                Text("You are on a Claude plan, not an API key: these are what the tokens would cost at API rates — a relative gauge, not a bill. Your real limits are the plan windows below.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 4) {
                row("today", currency: summary.today)
                row("7 days", currency: summary.week)
                row("lifetime", currency: summary.lifetime)
                MarvinDivider()
                    .padding(.vertical, 2)
                row("turns", text: summary.turns.formatted())
                row("in / out tokens",
                    text: "\(summary.inputTokens.formatted()) / \(summary.outputTokens.formatted())")
            }
            .font(.callout.monospaced())

            if let or = summary.openRouter {
                VStack(alignment: .leading, spacing: 4) {
                    Divider()
                        .padding(.vertical, 2)
                    Text("openrouter account")
                        .font(.caption.monospaced())
                        .tracking(2)
                        .textCase(.uppercase)
                        .foregroundStyle(.tertiary)
                    row("total credits", currency: or.totalCredits)
                    row("total usage", currency: or.totalUsage)
                }
                .font(.callout.monospaced())
            }

            if !summary.claudeWindows.isEmpty {
                claudePlanUsage
            }

            if !summary.daily.isEmpty {
                dailyChart
            }
        }
        .padding(16)
        .frame(width: 340)
    }

    /// ADR-0082 — the Claude-subscription analogue of the OpenRouter credits
    /// block. The SDK reports each rate-limit window on every turn; this shows
    /// the newest snapshot per window as a bar, with the refill time. A window
    /// the API has not sized (`utilization` absent) shows its status only —
    /// never a fabricated number.
    @ViewBuilder
    private var claudePlanUsage: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
                .padding(.vertical, 2)
            Text("claude plan usage limits")
                .font(.caption.monospaced())
                .tracking(2)
                .textCase(.uppercase)
                .foregroundStyle(.tertiary)
            ForEach(summary.claudeWindows) { w in
                ClaudeWindowRow(window: w)
            }
        }
        .font(.callout.monospaced())
    }


    @ViewBuilder
    private var dailyChart: some View {
        let maxCost = max(summary.daily.map(\.costUsd).max() ?? 0, 0.0001)
        let hovered = summary.daily.first { $0.day == hoveredDay }
        VStack(alignment: .leading, spacing: 4) {
            // Header — always "last N days · max $X.YY". Earlier
            // versions swapped the right side to the hovered detail
            // and got clipped at any readable font. The hover
            // detail now lives on its own row below.
            HStack {
                Text("last \(summary.daily.count) active days")
                    .tracking(1.5)
                    .textCase(.uppercase)
                Spacer()
                Text("max \(fmtUsd(maxCost))")
                    .foregroundStyle(.secondary)
            }
            .font(.caption2.monospaced())
            .foregroundStyle(.tertiary)

            HStack(alignment: .bottom, spacing: 2) {
                ForEach(summary.daily) { entry in
                    let h = max(3.0, (entry.costUsd / maxCost) * 48.0)
                    let isHovered = entry.day == hoveredDay
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(Color.accentColor.opacity(isHovered ? 1.0 : 0.75))
                        .frame(maxWidth: .infinity)
                        .frame(height: h)
                        .onHover { hovering in
                            hoveredDay = hovering ? entry.day : nil
                        }
                }
            }
            .frame(height: 50, alignment: .bottom)

            // Day labels — "04-27", matching the web pill's
            // `day.slice(5)` truncation. Slightly bigger than the
            // pre-1d.8 `.caption2 + .quaternary` (which was hard to
            // read at native popover sizes); now `.caption + .tertiary`.
            HStack(spacing: 2) {
                ForEach(summary.daily) { entry in
                    Text(String(entry.day.suffix(5)))
                        .frame(maxWidth: .infinity)
                }
            }
            .font(.caption.monospaced())
            .foregroundStyle(.tertiary)

            // Dedicated hover-detail row. Reserves the height even
            // when nothing is hovered so the popover doesn't reflow
            // mid-hover — a fixed-height row keeps the chart bars
            // exactly where the cursor expects them.
            HStack(spacing: 8) {
                if let h = hovered {
                    Text(String(h.day.suffix(5)))
                        .foregroundStyle(.secondary)
                    Text(fmtUsd(h.costUsd))
                        .foregroundStyle(.primary)
                    Spacer()
                    Text("\(h.turns.formatted()) turns")
                        .foregroundStyle(.secondary)
                } else {
                    Text("hover a bar for daily detail")
                        .foregroundStyle(.tertiary)
                    Spacer()
                }
            }
            .font(.callout.monospaced())
            .frame(height: 18)
        }
    }

    private func row(_ label: String, currency value: Double) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(fmtUsd(value))
                .foregroundStyle(.primary)
        }
    }

    private func row(_ label: String, text value: String) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .foregroundStyle(.primary)
        }
    }
}

/// Mirror of the web side's `fmtUsd` so a value like $0.0042
/// renders identically in both places. NumberFormatter would be
/// overkill — we want the bespoke micro-cent rendering. Lives at
/// file scope so both CostToolbarItem and CostHistoryPopover share
/// the same formatter.
/// One Claude plan window: label, percentage, bar, refill time (ADR-0082).
private struct ClaudeWindowRow: View {
    let window: CostSummary.ClaudeWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(window.label)
                Spacer()
                if let u = window.utilization {
                    Text("\(percentLabel(u)) used")
                        .foregroundStyle(tint(u))
                } else {
                    // No `utilization` on this snapshot: either the event
                    // predates the unifiedWindows ingest (an older build) or
                    // the API did not size the window. Say that — a bare
                    // "allowed" with no number reads as a broken gauge.
                    Text(window.status == "allowed" ? "no % yet" : window.status.replacingOccurrences(of: "_", with: " "))
                        .foregroundStyle(window.status == "allowed" ? Color.secondary : Color.orange)
                }
            }
            if let u = window.utilization {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color.secondary.opacity(0.18))
                        RoundedRectangle(cornerRadius: 2)
                            .fill(tint(u))
                            .frame(width: max(2, geo.size.width * min(max(u, 0), 1)))
                    }
                }
                .frame(height: 5)
            }
            HStack(spacing: 6) {
                if let r = window.resetsAt {
                    Text("resets \(resetLabel(epoch: r))")
                }
                if window.utilization == nil {
                    Text("· fills on the next turn").foregroundStyle(.tertiary)
                }
                if window.isUsingOverage == true {
                    Text("· using overage").foregroundStyle(Color.orange)
                }
            }
            .font(.caption2.monospaced())
            .foregroundStyle(.tertiary)
        }
        .font(.callout.monospaced())
    }

    private func percentLabel(_ u: Double) -> String {
        "\(Int((u * 100).rounded()))%"
    }

    private func tint(_ u: Double) -> Color {
        if window.status == "rejected" || u >= 0.9 { return .red }
        if window.status == "allowed_warning" || u >= 0.7 { return .orange }
        return .green
    }

    private func resetLabel(epoch: Double) -> String {
        let date = Date(timeIntervalSince1970: epoch)
        let remaining = date.timeIntervalSinceNow
        let clock = date.formatted(date: .omitted, time: .shortened)
        if remaining <= 0 { return "now" }
        let h = Int(remaining) / 3600
        let m = (Int(remaining) % 3600) / 60
        let span = h > 0 ? "\(h)h \(m)m" : "\(m)m"
        return remaining < 86_400 ? "in \(span) (\(clock))" : date.formatted(date: .abbreviated, time: .shortened)
    }
}

private func fmtUsd(_ v: Double) -> String {
    if v == 0 { return "$0.00" }
    if v < 0.01 { return String(format: "$%.4f", v) }
    return String(format: "$%.2f", v)
}

// ConnectionStatusToolbarItem retired in Phase 5f — see the comment
// next to the CostToolbarItem retirement above. The pip + clickable
// re-probe live in AppStatusBar's connectionPip now.

/// Bridge to the underlying `NSWindow` for things SwiftUI's `Window`
/// scene doesn't expose (Phase 1c: `frameAutosaveName`). Phase 1+
/// may grow more uses; keep them all flowing through here so the
/// `view.window` resolution + main-thread dispatch lives in one place.
private struct WindowAccessor: NSViewRepresentable {
    let onWindow: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        // The view isn't attached to a window during makeNSView —
        // defer until the next runloop tick when the window hierarchy
        // has resolved.
        DispatchQueue.main.async {
            if let window = view.window {
                onWindow(window)
            }
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// Tiny inline code block — selectable, monospaced, subtly framed.
/// Avoids pulling in SwiftUI Text styling tricks the user might
/// override globally later.
private struct CodeBlock: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.body.monospaced())
            .textSelection(.enabled)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(nsColor: .textBackgroundColor))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

// SwiftUI #Preview macros aren't checked in here because the
// `PreviewsMacros` plugin is shipped with Xcode and isn't available
// to plain Command Line Tools / `swift build`. CI compiles via
// SPM (no Xcode), so a #Preview block would break that path. Add
// previews locally when iterating in Xcode and don't commit them.
