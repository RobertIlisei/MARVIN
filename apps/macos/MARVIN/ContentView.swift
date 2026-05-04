// ContentView — Phase 1a window.
//
// Three states wired to HealthMonitor.state:
//   • connecting — soft "starting up" message + spinner
//   • online     — full-bleed WKWebView pointed at the sidecar
//                  (`http://localhost:3030`). The web app renders
//                  here unchanged. Later phases replace pieces of
//                  this WebView with native AppKit views.
//   • offline    — the failure reason, plus a copyable command for
//                  starting the sidecar.
//
// Phase 1a tradeoff (intentional, documented for future iteration):
// every transition online → offline → online tears down the
// WebView, losing scroll position / form input / chat focus. The
// alternative — keep the WebView always mounted under a ZStack
// overlay — is straightforward but means the WebView attempts to
// load `localhost:3030` while the sidecar is still booting, which
// shows WebKit's ugly "can't connect" error page on cold start.
// Trading the cold-start ugliness for the rare-mid-session-drop
// regression. Re-evaluate if the drop becomes painful in practice.
//
// Visual style is deliberately minimal — Phase 1a is about proving
// the WebView island works inside the SwiftUI shell. Native menu
// bar, toolbar, window-state restoration land in 1b/1c/1d.

import SwiftUI

/// Hardcoded for Phase 1a — single MARVIN install per machine,
/// `bin/marvin` always uses port 3030. Phase 2+ may move this into
/// a Settings surface so multi-port dev setups work, but that's
/// premature today.
private let sidecarURL = URL(string: "http://localhost:3030")!

struct ContentView: View {
    @Environment(HealthMonitor.self) private var health
    @Environment(MarvinBridge.self) private var bridge
    @Environment(WebViewCommands.self) private var webCommands

    /// Phase 1d.35 — gate the auto-start-sidecar attempt so it
    /// fires at most once per launch. Without this flag, every
    /// health probe that returns offline would spawn another
    /// `bin/marvin start` process — which is harmless because the
    /// shell script idempotents itself, but generates spurious
    /// processes and confuses tail-the-launchd-log workflows.
    @State private var autoStartAttempted = false

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()
            switch health.state {
            case .connecting:
                connectingView
            case .online:
                // Phase 1a: full-bleed WebView. Once the sidecar is
                // reachable, hand the entire content area over to
                // the existing web UI. The auth/model summary that
                // Phase 0 rendered is discoverable via `bin/marvin
                // status` from the terminal — the SwiftUI app's
                // job here is to host the UI, not duplicate its
                // status view.
                ZStack(alignment: .top) {
                    WebView(url: sidecarURL)
                        .ignoresSafeArea()
                        // Phase 1d.29 — drag a folder from Finder
                        // anywhere onto the WebView to add it as a
                        // MARVIN project. The drop is forwarded to
                        // the web side via a typed CustomEvent
                        // (`marvin:dropped-folder`); the web's
                        // useProjects().addProject handler is the
                        // canonical place to validate the path
                        // (manifest sniff, CLAUDE.md detection, etc.)
                        // and prompt for a display name. Native
                        // doesn't try to short-circuit any of that
                        // — it just hands the path over.
                        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                            handleFolderDrop(providers: providers)
                        }
                        // Phase 1d.10 — Safari-style thin progress bar
                        // pinned to the top edge of the WebView while
                        // it's loading. Fades out at 100% so the bar
                        // doesn't linger after the page finishes. Driven
                        // by KVO on WKWebView.estimatedProgress / .isLoading.
                        .overlay(alignment: .top) {
                            if webCommands.isLoading && webCommands.loadProgress < 1.0 {
                                ProgressView(value: webCommands.loadProgress)
                                    .progressViewStyle(.linear)
                                    .tint(.accentColor)
                                    .frame(height: 2)
                                    .transition(.opacity)
                            }
                        }
                        .animation(.easeOut(duration: 0.15), value: webCommands.isLoading)

                    // Phase 1d.12 — find bar overlays the WebView's
                    // top edge when ⌘F is pressed. Sits inside the
                    // ZStack so it draws above the WebView (which
                    // would otherwise eat all hits). Slides in from
                    // the top, dismisses with Esc or the Done button.
                    if webCommands.isFindVisible {
                        FindBarView()
                            .padding(.top, 8)
                            .padding(.horizontal, 12)
                            .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .animation(.easeOut(duration: 0.18), value: webCommands.isFindVisible)
            case .offline(let reason):
                offlineView(reason: reason)
            }
        }
        .frame(minWidth: 480, minHeight: 320)
        // Phase 1d.17 — follow the web app's theme so the SwiftUI
        // title bar / offline view / connecting view don't read as
        // mismatched against a dark WebView. nil means "follow
        // macOS system" (used until the web side posts its first
        // theme).
        .preferredColorScheme(bridge.preferredColorScheme)
        .background(WindowAccessor { window in
            // Phase 1c — window-state restoration. NSWindow's built-in
            // frameAutosaveName persists position + size to
            // NSUserDefaults under this key and restores on relaunch,
            // for free. SwiftUI's `Window` scene (vs `WindowGroup`)
            // doesn't surface @SceneStorage, so we reach into AppKit.
            window.setFrameAutosaveName("MARVINMainWindow")
        })
        // Phase 1d — native NSToolbar in the unified title bar.
        // Today this hosts only a connection-status indicator that
        // pulls from HealthMonitor; future phases bridge in
        // web-app state (project name, cost) as new ToolbarItems.
        // Doing it as a .toolbar modifier (vs raw NSToolbar via an
        // NSWindowDelegate) keeps the items as SwiftUI Views so
        // theme + accent colors track macOS automatically.
        .toolbar {
            // Single ToolbarItem so the cost pill + connection
            // status get explicit spacing; two separate items in
            // the same .primaryAction slot pack flush with no
            // gap (visual collision reported in 1d.3 review).
            // .controlSize(.large) makes the auto-wrapped pill
            // taller; without it the .callout-sized text crowded
            // the pill's vertical padding.
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: 14) {
                    if let summary = bridge.costSummary {
                        CostToolbarItem(summary: summary)
                    }
                    ConnectionStatusToolbarItem(state: health.state) {
                        Task { await health.refreshNow() }
                    }
                }
                .controlSize(.large)
            }
        }
        // Phase 1d — mirror the web app's `document.title` into the
        // native NSWindow title bar via the bridge. Falls back to
        // "MARVIN" until the web side posts its first title (cold
        // start, offline, or running outside the SwiftUI shell).
        // The web app's title includes the v1.2 `(N)` confirm-
        // pending badge, so this surfaces the badge natively too.
        .navigationTitle(bridge.webTitle ?? "MARVIN")
        // Phase 1d.3/1d.7 — active project + branch as the NSWindow
        // subtitle. "$project · $branch●" when both present;
        // "$project" when no git repo; empty when no project. The
        // ● suffix marks an uncommitted-changes count, matching
        // the web BranchBadge's dirty pip.
        .navigationSubtitle(composeSubtitle())
        // Phase 1d.3/1d.14 — pending-confirm count drives both the
        // dock tile badge AND a system notification on 0 → N
        // transitions. Parsed once out of webTitle so both surfaces
        // stay in sync without two regex passes.
        .onChange(of: bridge.webTitle ?? "") { _, newTitle in
            let count = parseConfirmCount(newTitle)
            updateDockBadge(count: count)
            NotificationManager.shared.updateConfirmCount(count)
        }
        // Phase 1d.27 — represented URL. NSWindow.representedURL +
        // .representedFilename make the title bar show the project
        // folder's Finder icon next to the window title. ⌘-click on
        // that icon opens the path-hierarchy popup macOS users
        // expect from any document-window app (Xcode, BBEdit, even
        // Pages); drag-out copies the path. With this set, the
        // window stops looking generic and starts behaving like a
        // window onto a specific filesystem location, which is the
        // truth of what MARVIN-with-a-project-loaded is.
        //
        // Drives the icon proxy, the ⌘-click path popup, AND
        // window-list grouping in macOS Sonoma's Window menu —
        // three native affordances for one bridge field.
        .onChange(of: bridge.projectWorkDir ?? "") { _, newWorkDir in
            updateRepresentedURL(workDir: newWorkDir.isEmpty ? nil : newWorkDir)
        }
        // Phase 1d.35 — auto-start the sidecar on first cold launch
        // if it isn't already running. Removes the friction of
        // having to keep a Terminal open with `bin/marvin start`;
        // for users who installed via launchd (`bin/marvin start`
        // is idempotent and forks the dev server), this is a one-
        // line follow-up. Only fires when:
        //   • the health monitor is already in `.offline` (sidecar
        //     genuinely down, not just still booting),
        //   • a `bin/marvin` script exists somewhere we can find it,
        //   • the user hasn't disabled auto-start in Settings,
        //   • we haven't already tried this session.
        // After the attempt, normal health-probe cycling takes
        // over — if the sidecar comes up, the next probe flips us
        // to .online and the WebView mounts.
        .onChange(of: health.state.isOffline) { _, isOffline in
            maybeAutoStartSidecar(isOffline: isOffline)
        }
        .task {
            // Run the same check on first appearance so launches
            // that go straight to .offline (no .connecting transit)
            // still get the auto-start attempt.
            maybeAutoStartSidecar(isOffline: health.state.isOffline)
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

    /// Resolve dropped NSItemProviders to file URLs, take the first
    /// directory, and forward it to the web side as a `marvin:
    /// dropped-folder` CustomEvent. Skips files (not directories) so
    /// the user can't accidentally add a stray .txt as a "project".
    /// Returns true to tell SwiftUI we've consumed the drop —
    /// otherwise the WebView's default file-drop handler kicks in
    /// and would try to navigate to file:// (which navigationDelegate
    /// already blocks but the visual feedback would be wrong).
    private func handleFolderDrop(providers: [NSItemProvider]) -> Bool {
        guard let provider = providers.first else { return false }
        // Resolve asynchronously — loadObject(ofClass: URL.self,
        // completionHandler:) hops to a background queue. We bounce
        // back to MainActor before touching webCommands.
        provider.loadObject(ofClass: URL.self) { url, _ in
            guard let url else { return }
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(
                atPath: url.path,
                isDirectory: &isDir
            )
            guard exists, isDir.boolValue else { return }
            Task { @MainActor in
                WebViewCommands.shared.dispatchWebCommand(
                    "dropped-folder",
                    detail: ["path": url.path, "name": url.lastPathComponent]
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
            Divider()
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

/// Cost pill for the unified title bar (Phase 1d.6). Mirrors the
/// full cost summary from the web app's `<CostPill>` via the
/// bridge. The label is at-a-glance "today $X.YY"; clicking opens
/// a native popover with the same fields the web pill's popover
/// has — today / 7 days / lifetime / turns / tokens / daily bar
/// chart — so hiding the web pill in the SwiftUI shell wouldn't
/// regress functionality (still gated; see globals.css).
private struct CostToolbarItem: View {
    let summary: CostSummary
    @State private var showPopover = false

    var body: some View {
        Button {
            showPopover.toggle()
        } label: {
            HStack(spacing: 6) {
                Text("today")
                    .foregroundStyle(.tertiary)
                Text(fmtUsd(summary.today))
                    .foregroundStyle(.secondary)
            }
            .font(.body.monospaced())
            .padding(.horizontal, 4)
        }
        .buttonStyle(.borderless)
        .help("Cost for the active project · click for history")
        .popover(isPresented: $showPopover, arrowEdge: .top) {
            CostHistoryPopover(summary: summary)
        }
    }
}

/// Native counterpart to the web `<CostPill>` popover. Renders the
/// same fields (today / 7d / lifetime / turns / tokens) plus a
/// daily-history bar chart with day labels and immediate hover
/// feedback (matching the web pill's group-hover overlay). Phase 1d.6.
private struct CostHistoryPopover: View {
    let summary: CostSummary
    @State private var hoveredDay: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("cost for this project")
                .font(.caption.monospaced())
                .tracking(2)
                .textCase(.uppercase)
                .foregroundStyle(.tertiary)

            VStack(spacing: 4) {
                row("today", currency: summary.today)
                row("7 days", currency: summary.week)
                row("lifetime", currency: summary.lifetime)
                Divider()
                    .padding(.vertical, 2)
                row("turns", text: summary.turns.formatted())
                row("in / out tokens",
                    text: "\(summary.inputTokens.formatted()) / \(summary.outputTokens.formatted())")
            }
            .font(.callout.monospaced())

            if !summary.daily.isEmpty {
                dailyChart
            }
        }
        .padding(16)
        .frame(width: 340)
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
private func fmtUsd(_ v: Double) -> String {
    if v == 0 { return "$0.00" }
    if v < 0.01 { return String(format: "$%.4f", v) }
    return String(format: "$%.2f", v)
}

/// Connection status pip + label for the unified title bar (Phase 1d).
/// Click to manually re-probe the sidecar. State drives both the pip
/// fill and the foreground label, so a glance at the title bar
/// answers "is the sidecar reachable?" without leaving the window.
private struct ConnectionStatusToolbarItem: View {
    let state: SidecarState
    let onRefresh: () -> Void

    var body: some View {
        Button(action: onRefresh) {
            HStack(spacing: 6) {
                pip
                Text(state.shortLabel)
                    .font(.body.monospaced())
            }
            .padding(.horizontal, 4)
            .foregroundStyle(labelColor)
        }
        .buttonStyle(.borderless)
        // Tooltip is the discoverability layer — `connecting` /
        // `online` / `offline` is terse on purpose; the tooltip
        // explains the click affordance.
        .help("Re-probe http://localhost:3030/api/health")
    }

    private var pip: some View {
        Circle()
            .fill(pipColor)
            .frame(width: 8, height: 8)
            .overlay(
                Circle()
                    .stroke(Color.black.opacity(0.15), lineWidth: 0.5)
            )
    }

    private var pipColor: Color {
        switch state {
        case .connecting: .secondary
        case .online: .green
        case .offline: .orange
        }
    }

    private var labelColor: Color {
        switch state {
        case .connecting, .offline: .secondary
        case .online: .primary
        }
    }
}

/// Find-in-page bar overlay (Phase 1d.12). Sits at the top of the
/// WebView region; live-searches as the user types, advances on
/// Enter, dismisses with Esc or the Done button. Uses
/// WKWebView.find under the hood — match highlight is handled by
/// WebKit, no DOM manipulation needed.
private struct FindBarView: View {
    @Environment(WebViewCommands.self) private var webCommands
    @FocusState private var fieldFocused: Bool

    var body: some View {
        @Bindable var webCommands = webCommands
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Find in page", text: $webCommands.findText)
                .textFieldStyle(.plain)
                .focused($fieldFocused)
                .onSubmit {
                    webCommands.findNext()
                }
            // Match count — "12 matches" when results, "no matches"
            // in red-ish when query is set but unmatched, hidden when
            // the query is empty. Phase 1d.13.
            if !webCommands.findText.isEmpty {
                Text(matchLabel(for: webCommands.findCount))
                    .font(.caption.monospaced())
                    .foregroundStyle(webCommands.findCount > 0 ? .secondary : Color.orange.opacity(0.85))
                    .frame(minWidth: 70, alignment: .trailing)
            }
            Button {
                webCommands.findPrevious()
            } label: {
                Image(systemName: "chevron.up")
            }
            .buttonStyle(.borderless)
            .disabled(webCommands.findText.isEmpty || webCommands.findCount == 0)
            .help("Previous match · ⇧⌘G")
            Button {
                webCommands.findNext()
            } label: {
                Image(systemName: "chevron.down")
            }
            .buttonStyle(.borderless)
            .disabled(webCommands.findText.isEmpty || webCommands.findCount == 0)
            .help("Next match · ⌘G")
            Button("Done") {
                webCommands.hideFind()
            }
            .buttonStyle(.borderless)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
        )
        .frame(maxWidth: 420)
        // Force focus to the field whenever the bar appears OR when
        // it's already visible and ⌘F is pressed again (re-focus
        // pattern matches Safari's "tap ⌘F to refocus").
        .onAppear { fieldFocused = true }
        .onChange(of: webCommands.isFindVisible) { _, visible in
            if visible { fieldFocused = true }
        }
    }

    private func matchLabel(for count: Int) -> String {
        switch count {
        case 0: "no matches"
        case 1: "1 match"
        default: "\(count) matches"
        }
    }
}

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
