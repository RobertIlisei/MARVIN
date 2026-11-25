// SurfaceSnapshotSessionsFleet — the Sessions pane under a supervisor's load
// (pane-standard round, 25.11.2026): 2 working, 3 waiting, 45 finished (with
// and without a tab, merged, old) and 12 idle.
//
// The stand-in sidecar answers `/api/sessions/watch` with `watchJSON()` while
// `active` is set (one line in SurfaceSnapshotRoutesMore.swift). Every name and
// number is invented; times are relative to now so "14h" reads 14h whenever the
// snapshot is taken.
//
//     MARVIN_PORT=39031 MARVIN_SNAPSHOT_VIEW=pane-sessions-fleet MARVIN_SNAPSHOT_OUT=<dir> .build/debug/MARVIN
//
// Surfaces: `pane-sessions-fleet` (the default view), `-collapsed` (Finished
// and Idle folded), `-show-all` (Finished unfolded to every row), `-reviewed`
// (right after "Mark all reviewed", with its Undo strip).

import AppKit
import MARVINLogic
import SwiftUI

enum SurfaceSessionsFleet {
    /// Read from the stand-in sidecar's thread; set once, before the pane mounts.
    static var active = false

    private static func id(_ kind: String, _ n: Int) -> String {
        String(format: "%@%07d-0000-4000-8000-%012d", kind, n, n)
    }

    private static let working = (1...2).map { id("a", $0) }
    private static let waiting = (1...3).map { id("b", $0) }
    /// Finished with a tab: the ones a person still has to look at.
    private static let finishedTab = (1...4).map { id("c", $0) }
    /// Finished with no tab, recent: not yet settled.
    private static let finishedRecent = (1...11).map { id("d", $0) }
    /// Finished with no tab, hours old: settled, so they never reach the pane.
    private static let finishedOld = (1...30).map { id("e", $0) }
    private static let idle = (1...12).map { id("f", $0) }

    /// What the pane lists as tabs.
    static var openIds: [String] { working + Array(waiting.prefix(2)) + finishedTab + idle }

    private static func iso(_ minutesAgo: Double) -> String { SurfaceRoutesMore.iso(minutesAgo) }

    private static let titles = [
        "Add retry with backoff to the HTTP client", "Fix the flaky cache test", "Rewrite the quickstart",
        "Refactor session handling into a store with typed errors and a long name that must truncate at the end",
        "Migrate the config loader", "Draft the release notes", "Pin the backoff range in a test",
        "Replay a buffered body across attempts", "Introduce typed error classes", "Spike a connection pool",
        "Update the changelog", "Wire the rate-limit headers", "Tighten the upload size check",
        "Explain the sync service in the readme", "Port the date helpers", "Remove the unused feature flag",
    ]
    private static func title(_ n: Int) -> String { titles[n % titles.count] }

    private static func tree(_ slug: String, present: Bool = true) -> String {
        #"{"mode":"worktree","slug":"\#(slug)","path":"@ROOT@/.marvin/worktrees/\#(slug)","branch":"marvin/tab/\#(slug)","base":"a1b2c3d","baseRef":"main","cwd":"@ROOT@/.marvin/worktrees/\#(slug)","currentBranch":"marvin/tab/\#(slug)","present":\#(present)}"#
    }

    private static func wt(_ slug: String, state: String, commits: Int, merged: Bool) -> String {
        #"{"slug":"\#(slug)","branch":"marvin/tab/\#(slug)","state":"\#(state)","commits":\#(commits),"dirty":false,"base":"a1b2c3d","behind":0,"closed":false,"target":"main"\#(merged ? #","mergedInto":"main""# : "")}"#
    }

    private static let supervisor =
        #""supervisor":{"delegation":"off","sharedCheckout":false,"touchedTurn":null,"waitingOnOwn":null,"stoppedByUser":false,"lastActAt":null,"openEscalations":0}"#

    private static func row(_ sid: String, state: String, title t: String, extra: String, endedMin: Double?,
                            outcome: String = "completed", slug: String? = nil, worktree: String? = nil, present: Bool = true) -> String {
        let last = endedMin.map {
            #","lastTurn":{"turnId":"t-\#(sid.prefix(8))","startedAt":"\#(iso($0 + 6))","endedAt":"\#(iso($0))","outcome":"\#(outcome)","marker":null}"#
        } ?? #","lastTurn":null"#
        let tr = slug.map { tree($0, present: present) } ?? #"{"mode":"shared"}"#
        return #"{"marvinSessionId":"\#(sid)","state":"\#(state)","title":"\#(t.replacingOccurrences(of: "\"", with: "'"))","turn":null,"activity":null,"pending":[],"worktree":\#(worktree ?? "null"),"tree":\#(tr),"diff":{"added":84,"removed":12,"files":5}\#(last)\#(extra),"cost":{"turns":3,"costUsd":0.31},\#(supervisor),"updatedAt":"\#(iso(endedMin ?? 0))"}"#
    }

    static func watchJSON() -> String {
        var rows: [String] = []
        for (i, sid) in working.enumerated() {
            rows.append(#"{"marvinSessionId":"\#(sid)","state":"working","title":"\#(title(i))","turn":{"turnId":"t-w\#(i)","kind":"human","startedAt":"\#(iso(Double(3 + i)))","mutated":true},"activity":{"state":"tool","tool":"Bash","turnId":"t-w\#(i)"},"pending":[],"worktree":null,"tree":{"mode":"shared"},"lastTurn":null,"cost":{"turns":2,"costUsd":0.2},\#(supervisor),"updatedAt":"\#(iso(0))"}"#)
        }
        for (i, sid) in waiting.enumerated() {
            let since = [34.0, 12.0, 52.0][i]
            let label = ["gated commit queue: position 3", "Integration suite", "wakeup in 20 min"][i]
            rows.append(row(sid, state: "waiting", title: title(4 + i), extra: #","waitingOn":{"kind":"job","label":"\#(label)","since":"\#(iso(since))"}"#, endedMin: since + 2, slug: "wait-\(i)", worktree: wt("wait-\(i)", state: "session", commits: 2, merged: false)))
        }
        for (i, sid) in finishedTab.enumerated() {
            // The last one has its branch merged: it says so and goes last.
            let merged = i == 3
            let slug = "fin-tab-\(i)"
            rows.append(row(sid, state: "idle", title: title(8 + i), extra: "", endedMin: Double(20 + i * 35), slug: slug,
                            worktree: wt(slug, state: merged ? "merged" : "session", commits: 3, merged: merged)))
        }
        for (i, sid) in finishedRecent.enumerated() {
            // Eleven results from the last hour, no tab; three of them already merged (and so about to leave).
            let merged = i % 4 == 3
            let slug = "fin-\(i)"
            let age = merged ? Double(1 + i % 3) : Double(4 + i * 5)
            rows.append(row(sid, state: "idle", title: title(i), extra: "", endedMin: age, slug: slug,
                            worktree: wt(slug, state: merged ? "merged" : "session", commits: 1 + i % 4, merged: merged)))
        }
        for (i, sid) in finishedOld.enumerated() {
            let slug = "old-\(i)"
            rows.append(row(sid, state: "idle", title: title(i + 3), extra: "", endedMin: Double(180 + i * 25), slug: slug,
                            worktree: wt(slug, state: i % 2 == 0 ? "merged" : "session", commits: 2, merged: i % 2 == 0)))
        }
        for (i, sid) in idle.enumerated() {
            // A Stop is not a result, so these are plain idle tabs, not "finished".
            rows.append(row(sid, state: "idle", title: title(i + 5), extra: "", endedMin: Double(40 + i * 17), outcome: "stopped"))
        }
        return #"{"projectId":"prj_atlas","generatedAt":"\#(iso(0))","rows":[\#(rows.joined(separator: ","))]}"#
    }

    // MARK: - Seeding

    private static let projectId = "prj_atlas"

    /// Start the registry against the stand-in with this fleet. `registry.start`
    /// is a no-op for a project it already serves, hence the stop first.
    @MainActor
    static func seed(collapse: [SessionGroupId] = [], markAllReviewed: Bool = false) {
        let d = UserDefaults.standard
        d.set(openIds, forKey: "marvin.chatTabs.\(projectId)")
        // The rule's baseline is "now" on a first run, which would call every
        // fixture result old news; the epoch makes all of them reviewable.
        d.set(0.0, forKey: "marvin.reviewedBaseline.\(projectId)")
        d.removeObject(forKey: "marvin.reviewed.\(projectId)")
        d.set(collapse.map(\.rawValue), forKey: SessionGroupCollapse.storageKey(projectId: projectId))
        active = true
        SurfaceFixtures.populateBridge(MarvinBridge.shared)
        let registry = SessionRegistry.shared
        registry.stop()
        registry.start(projectId: projectId)
        let deadline = Date().addingTimeInterval(5)
        while registry.ledger.entries.count < working.count + waiting.count + finishedTab.count + finishedRecent.count + idle.count,
              Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        if markAllReviewed {
            registry.markAllReviewed(registry.fleetSessionIds.filter { registry.rowState($0) == .finished })
        }
    }

    @MainActor
    static var surfaces: [SurfaceSnapshot.Surface] {
        let widths: [CGFloat] = [260, 420]
        func surface(_ id: String, _ title: String, collapse: [SessionGroupId] = [], showAll: Bool = false,
                     reviewed: Bool = false) -> SurfaceSnapshot.Surface {
            SurfaceSnapshot.Surface(id, title, .populated, widths: widths, height: 1500,
                                    prepare: { seed(collapse: collapse, markAllReviewed: reviewed) }) {
                AnyView(SessionsPane(showAllFinished: showAll))
            }
        }
        return [
            surface("pane-sessions-fleet", "Sessions under load: 2 working, 3 waiting, 45 finished, 12 idle"),
            surface("pane-sessions-fleet-collapsed", "Sessions under load: Finished and Idle folded", collapse: [.finished, .idle]),
            surface("pane-sessions-fleet-show-all", "Sessions under load: Show all finished", showAll: true),
            surface("pane-sessions-fleet-reviewed", "Sessions under load: right after Mark all reviewed", reviewed: true),
        ]
    }
}
