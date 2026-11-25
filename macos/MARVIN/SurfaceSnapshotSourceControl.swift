// SurfaceSnapshotSourceControl — the Source Control pane under load, for
// `MARVIN_SNAPSHOT_VIEW=sc-*` (see SurfaceSnapshot.swift for the rules every run
// follows: a free `MARVIN_PORT`, never 3030).
//
// What the owner's review named is a pane that shows ONE tree and a hundred rows,
// so the fixtures are those cases, with invented data (Golden Rule 6):
//
//   sc-tab-12            a worktree tab selected: its own 12 changes, its branch
//   sc-project-100       the shared checkout: 100 changed files in 20 directories
//   sc-project-filtered  the same, filtered to one directory
//   sc-project-preview   the same, a folder open and a file selected (the diff preview)
//   sc-pinned            a worktree tab selected, the view pinned to the checkout
//   sc-clean             nothing to commit
//   sc-conflicts         merge conflicts above ordinary changes
//   sc-worktrees-14      the project scope: fourteen worktrees in mixed states
//
// The stand-in sidecar answers `/api/git/status` by directory: the project root
// gets the big list and a tab's worktree gets its own, which is exactly the
// separation the pane exists to show.

import AppKit
import MARVINLogic
import SwiftUI

enum SurfaceSourceControlFixtures {
    enum Scenario { case fleet, clean, conflicts }

    /// Read from the stand-in's server thread, written on the main thread between renders.
    nonisolated(unsafe) static var scenario: Scenario? = nil

    // MARK: Routes

    static func handle(method: String, path: String, query: [String: String], root: String) -> FixtureSidecar.Response? {
        guard let scenario else { return nil }
        func ok(_ json: String) -> FixtureSidecar.Response {
            .json(json.replacingOccurrences(of: "@ROOT@", with: root))
        }
        switch path {
        case "/api/git/status":
            let cwd = query["cwd"] ?? root
            return ok(status(scenario, inTab: cwd.contains("/.marvin/worktrees/")))
        case "/api/git/repos":
            return ok(repos)
        case "/api/worktrees" where method != "POST":
            return ok(worktrees)
        default:
            return nil
        }
    }

    // MARK: Status

    private static func file(_ path: String, index: String, working: String, type: String = "ordinary", from: String? = nil) -> String {
        let renamed = from.map { "\"\($0)\"" } ?? "null"
        return #"{"path":"\#(path)","indexStatus":"\#(index)","workingStatus":"\#(working)","renamedFrom":\#(renamed),"ordinary":\#(type == "ordinary"),"entryType":"\#(type)"}"#
    }

    private static func status(_ scenario: Scenario, inTab: Bool) -> String {
        let branch = inTab
            ? #"{"oid":"4d82e6b17c0a93f521e8d4ab63c7f90e15b2a8d4","name":"marvin/tab/fix-flaky-test","upstream":null,"ahead":null,"behind":null}"#
            : #"{"oid":"9f3c1a7e5b2d84c06a91f7e3d2b8c4a5e6f70123","name":"main","upstream":"origin/main","ahead":0,"behind":0}"#
        let files: [String]
        switch scenario {
        case .clean: files = []
        case .conflicts: files = conflicted
        case .fleet: files = inTab ? tabTwelve : projectHundred
        }
        return #"{"enabled":true,"branch":\#(branch),"files":[\#(files.joined(separator: ","))]}"#
    }

    private static let tabTwelve: [String] = [
        file("Tests/AtlasTests/CacheTests.swift", index: "M", working: ".", type: "ordinary"),
        file("Sources/Core/Storage/Cache.swift", index: "M", working: "M"),
        file("Sources/Core/Storage/CacheKey.swift", index: "A", working: "."),
        file("Sources/Core/Storage/Eviction.swift", index: ".", working: "M"),
        file("Sources/Core/Storage/Clock.swift", index: ".", working: "M"),
        file("Sources/App/Services/SyncService.swift", index: ".", working: "M"),
        file("Sources/App/Services/SyncQueue.swift", index: ".", working: "D"),
        file("Tests/AtlasTests/FakeClock.swift", index: ".", working: "M"),
        file("docs/decisions/0012-injectable-clock.md", index: ".", working: "?", type: "untracked"),
        file("scripts/flaky-repro.sh", index: ".", working: "?", type: "untracked"),
        file("notes/todo.md", index: ".", working: "?", type: "untracked"),
        file("Package.resolved", index: ".", working: "M"),
    ]

    private static let directories = [
        "Sources/App/Models", "Sources/App/Services", "Sources/App/Views", "Sources/App/Views/Settings",
        "Sources/Core/Networking", "Sources/Core/Storage", "Tests/AtlasTests", "Tests/AtlasUITests",
        "docs/architecture", "docs/decisions", "web/src/components", "web/src/routes", "web/src/hooks",
        "scripts", "config", "migrations", ".github/workflows", "assets/icons", "assets/strings",
        "packages/shared/src",
    ]
    private static let stems = ["Ledger", "Client", "Router", "Store", "Adapter"]

    /// 100 files over 20 directories: some staged, a few untracked, a handful
    /// half-staged (in both lists), the rest modified or deleted.
    private static let projectHundred: [String] = {
        var out: [String] = []
        for (d, dir) in directories.enumerated() {
            for f in 0..<5 {
                let i = d * 5 + f
                let ext = dir.hasPrefix("web") ? "tsx" : (dir == "scripts" ? "sh" : (dir.hasPrefix("docs") ? "md" : (dir == "config" || dir == "migrations" ? "sql" : "swift")))
                let path = "\(dir)/\(stems[f])\(i).\(ext)"
                switch i {
                case 0..<6: out.append(file(path, index: i % 2 == 0 ? "M" : "A", working: "."))
                case 6..<10: out.append(file(path, index: ".", working: "?", type: "untracked"))
                case 10..<15: out.append(file(path, index: "M", working: "M"))
                case let n where n % 11 == 0: out.append(file(path, index: ".", working: "D"))
                default: out.append(file(path, index: ".", working: "M"))
                }
            }
        }
        return out
    }()

    private static let conflicted: [String] = [
        file("Sources/App/Services/SyncService.swift", index: "U", working: "U", type: "unmerged"),
        file("Sources/Core/Networking/RetryPolicy.swift", index: "U", working: "U", type: "unmerged"),
        file("web/src/routes/sync.tsx", index: "U", working: "U", type: "unmerged"),
        file("Sources/App/Models/UsageLedger.swift", index: ".", working: "M"),
        file("Tests/AtlasTests/SyncServiceTests.swift", index: ".", working: "M"),
        file("docs/architecture/sync.md", index: "M", working: "."),
        file("scripts/seed.sh", index: ".", working: "?", type: "untracked"),
    ]

    // MARK: Repos and worktrees

    private static let repos = #"""
    {"enabled":true,"repos":[
     {"path":"@ROOT@","name":"Atlas","branch":"main","head":"9f3c1a7e5b2d84c06a91f7e3d2b8c4a5e6f70123","detached":false,"isCurrent":true,"isMain":true,"dirtyCount":100,"locked":false},
     {"path":"/tmp/demo/Atlas-hotfix","name":"Atlas-hotfix","branch":"hotfix/token-expiry","head":"4d82e6b17c0a93f521e8d4ab63c7f90e15b2a8d4","detached":false,"isCurrent":false,"isMain":false,"dirtyCount":2,"locked":false}]}
    """#

    private static func wt(_ slug: String, _ task: String, _ state: String, commits: Int, files: Int, dirty: Bool = false,
                           present: Bool = true, merged: String? = nil, at: String? = nil, added: Int? = nil, removed: Int? = nil) -> String {
        let mergedInto = merged.map { "\"\($0)\"" } ?? "null"
        let last = at.map { "\"\($0)\"" } ?? "null"
        let a = added.map(String.init) ?? "null"
        let r = removed.map(String.init) ?? "null"
        return #"{"slug":"\#(slug)","path":"@ROOT@/.marvin/worktrees/\#(slug)","branch":"marvin/tab/\#(slug)","base":"a1b2c3d","task":"\#(task)","state":"\#(state)","commits":\#(commits),"filesChanged":\#(files),"dirty":\#(dirty),"checkoutPresent":\#(present),"mergedInto":\#(mergedInto),"lastCommitAt":\#(last),"added":\#(a),"removed":\#(r)}"#
    }

    /// Fourteen branches in mixed states: three ready (one whose checkout is gone),
    /// a build, five open tabs, three merged, two empty (one with uncommitted work).
    private static let worktrees: String = {
        let rows = [
            wt("typed-error-classes", "Introduce typed error classes", "ready", commits: 3, files: 5, at: "2026-11-25T08:55:00.000Z", added: 142, removed: 27),
            wt("add-rate-limit-headers", "Add rate-limit headers to the API client", "ready", commits: 2, files: 4, at: "2026-11-24T18:20:00.000Z", added: 96, removed: 11),
            wt("replay-buffered-body", "Replay a buffered body across attempts", "ready", commits: 1, files: 2, present: false, at: "2026-11-23T10:05:00.000Z", added: 38, removed: 4),
            wt("add-retry-jitter", "Add jitter to the retry delay", "running", commits: 0, files: 0, dirty: true),
            wt("fix-flaky-test", "Fix the flaky cache test", "session", commits: 2, files: 3, dirty: true, at: "2026-11-25T09:10:00.000Z", added: 61, removed: 9),
            wt("load-test-sync", "Load-test the sync service", "session", commits: 5, files: 9, at: "2026-11-25T07:40:00.000Z", added: 410, removed: 36),
            wt("tab-fix-body-replay", "Fix body replay", "session", commits: 1, files: 1, dirty: true, at: "2026-11-24T21:30:00.000Z", added: 12, removed: 3),
            wt("tab-docs-quickstart", "Rewrite the quickstart", "session", commits: 4, files: 6, at: "2026-11-24T12:00:00.000Z", added: 220, removed: 90),
            wt("tab-config-loader", "Migrate the config loader with a very long title that has to truncate somewhere sensible", "session", commits: 0, files: 0),
            wt("pin-backoff-range", "Pin the backoff range in a test", "merged", commits: 1, files: 1, merged: "main", at: "2026-11-22T12:00:00.000Z"),
            wt("rename-api-client", "Rename NetClient to ApiClient", "merged", commits: 3, files: 12, merged: "main", at: "2026-11-21T09:00:00.000Z"),
            wt("drop-legacy-flag", "Drop the legacy sync flag", "merged", commits: 2, files: 3, merged: "release/1.4", at: "2026-11-19T16:00:00.000Z"),
            wt("scratch-spike", "Spike a connection pool", "empty", commits: 0, files: 0),
            wt("pool-experiment", "Pool experiment", "empty", commits: 0, files: 0, dirty: true),
        ]
        return #"{"worktrees":[\#(rows.joined(separator: ","))]}"#
    }()
}

// MARK: - Surfaces

enum SurfaceSourceControlSurfaces {
    private static let widths: [CGFloat] = [260, 420]
    private static let height: CGFloat = 780
    /// A tab that works in its own worktree / one that shares the checkout (SurfaceRoutesMore.openIds).
    private static let worktreeTab = SurfaceRoutesMore.openIds[3]
    private static let sharedTab = SurfaceRoutesMore.openIds[1]

    @MainActor
    static func surfaces() -> [SurfaceSnapshot.Surface] {
        func surface(
            _ id: String, _ title: String, _ scenario: SurfaceSourceControlFixtures.Scenario, tab: String,
            initial: SourceControlInitialState = SourceControlInitialState(),
            interact: (@MainActor (NSView) -> Void)? = nil
        ) -> SurfaceSnapshot.Surface {
            SurfaceSnapshot.Surface(
                id, title, .populated, widths: widths, height: height, settleMs: 2200,
                prepare: { seed(scenario) },
                configure: { b in
                    SurfaceFixtures.populateBridge(b)
                    b.setActiveMarvinSession(tab)
                },
                interact: interact,
                make: { AnyView(SourceControlView(initial: initial)) })
        }
        // Sources → App/Views (a joined chain) hold the half-staged files, which are in Changes too.
        let openFolders = ["changes|d|Sources": false, "changes|d|Sources/App/Views": false]
        return [
            surface("sc-tab-12", "Source Control — a worktree tab selected: its own 12 changes", .fleet, tab: worktreeTab),
            surface("sc-project-100", "Source Control — the project checkout, 100 changed files in 20 directories", .fleet, tab: sharedTab),
            surface("sc-project-filtered", "Source Control — 100 files filtered to “services”", .fleet, tab: sharedTab,
                    initial: SourceControlInitialState(filter: "services")),
            surface("sc-project-preview", "Source Control — a folder open, a file selected, its diff previewed", .fleet, tab: sharedTab,
                    initial: SourceControlInitialState(
                        selection: "changes|f|Sources/App/Views/Ledger10.swift",
                        folderOverrides: openFolders)),
            surface("sc-pinned", "Source Control — a worktree tab selected, the view pinned to the project checkout", .fleet, tab: worktreeTab,
                    initial: SourceControlInitialState(pin: .project)),
            surface("sc-clean", "Source Control — nothing to commit", .clean, tab: sharedTab),
            surface("sc-conflicts", "Source Control — merge conflicts above ordinary changes", .conflicts, tab: sharedTab),
            surface("sc-worktrees-14", "Source Control — the project scope: fourteen worktrees in mixed states", .fleet, tab: worktreeTab,
                    initial: SourceControlInitialState(scope: .project)),
        ]
    }

    private static var seeded = false

    /// The stand-in sidecar feeds the session registry; the worktree tab's
    /// checkout must exist on disk, or the pane (rightly) refuses to show it.
    @MainActor
    private static func seed(_ scenario: SurfaceSourceControlFixtures.Scenario) {
        SurfaceSourceControlFixtures.scenario = scenario
        UserDefaults.standard.removeObject(forKey: "marvin.sourceControl.collapsed.v1")
        for slug in ["fix-flaky-test", "load-test-sync"] {
            try? FileManager.default.createDirectory(
                atPath: "\(SurfaceFixtures.project)/.marvin/worktrees/\(slug)", withIntermediateDirectories: true)
        }
        guard !seeded else { return }
        seeded = true
        UserDefaults.standard.set(SurfaceRoutesMore.openIds, forKey: "marvin.chatTabs.prj_atlas")
        SurfaceFixtures.populateBridge(MarvinBridge.shared)
        let registry = SessionRegistry.shared
        registry.start(projectId: "prj_atlas")
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline, !(registry.ledger.entries.count >= 9 && registry.feedConnected) {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
    }
}
