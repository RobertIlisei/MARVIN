// SurfaceSnapshotPaneKit — realistic loads for the pane standard (kit agent,
// 2026-11-25). Dev-only, inert unless the snapshot harness runs.
//
// The stock fixtures show a pane with six rows. The standard is about what a
// pane looks like with forty-four skills, eighty catalog plugins and a ledger
// of findings, and about its empty and error states, so these generate them.
// Every name is invented and neutral (Golden Rule 6).
//
//     MARVIN_PORT=39031 MARVIN_SNAPSHOT_VIEW=all MARVIN_SNAPSHOT_OUT=/tmp/panes .build/debug/MARVIN
//
// renders `panekit-*` along with every other surface; `list` names them.

import AppKit
import MARVINLogic
import SwiftUI

enum PaneKitFixtures {
    enum Scenario { case dozens, empty, error }

    /// Set from the main thread before a surface renders, read from the
    /// stand-in sidecar's queue while it does; the two never overlap.
    nonisolated(unsafe) static var skills: Scenario = .dozens
    nonisolated(unsafe) static var plugins: Scenario = .dozens
    nonisolated(unsafe) static var practice: Scenario = .dozens

    /// The sidecar's answer for a path this file owns, or nil to let the stock
    /// fixtures answer. `SurfaceRoutesMore.handle` asks first.
    static func response(path: String) -> FixtureSidecar.Response? {
        switch path {
        case "/api/skills": return answer(skills, dozens: skillsJSON(), empty: emptySkills)
        case "/api/plugins": return answer(plugins, dozens: pluginsJSON(), empty: #"{"plugins":[],"catalog":[]}"#)
        case "/api/practice": return answer(practice, dozens: practiceJSON(), empty: emptyPractice)
        default: return nil
        }
    }

    private static func answer(_ s: Scenario, dozens: String, empty: String) -> FixtureSidecar.Response {
        switch s {
        case .dozens: return .json(dozens)
        case .empty: return .json(empty)
        case .error: return .json(#"{"error":"The sidecar could not read ~/.claude/skills."}"#, status: 500)
        }
    }

    // MARK: Skills

    private static let skillNames = [
        "accessibility-audit", "api-design-review", "changelog-writer", "code-explainer", "csv-cleaner",
        "db-migration-checklist", "dependency-upgrade", "docker-compose-help", "e2e-test-writer", "error-budget-report",
        "figma-handoff", "git-bisect-guide", "graphify", "i18n-extractor", "incident-postmortem", "json-schema-author",
        "k8s-manifest-lint", "log-triage", "markdown-linter", "metrics-dashboard", "oauth-flow-debug", "openapi-diff",
        "pdf-extract", "perf-profiling", "pr-review", "regex-builder", "release-notes", "rollback-plan", "security-audit",
        "slide-builder", "spreadsheet-tools", "sql-optimizer", "storybook-stories", "systematic-debugging",
        "tailwind-conventions", "terraform-plan-review", "test-driven-development", "threat-model", "typescript-strictness",
        "vitest-patterns", "web-vitals-check", "xlsx-recipes", "yaml-validator", "zod-schema-gen",
    ]

    private static let skillBlurbs = [
        "Review HTTP route handlers for naming, status codes, validation and error shape.",
        "Walk a page against the WCAG checklist and report each failure with its selector.",
        "Draft release notes from merged branches using this repository's changelog format.",
        "Explain an unfamiliar function: what it does, who calls it, what breaks if it changes.",
        "Read, clean and write tabular files; preserves quoting and encodings.",
        "Steps to run before and after a database migration, with a rollback for each.",
        "Plan a dependency upgrade: breaking changes, codemods, and the order to land them.",
        "Write the failing test first, then the smallest change that makes it pass.",
        "Find the root cause before proposing a fix. Four phases, no guessing.",
        "Compose a static poster or card layout from a brief and a palette.",
        "", ">",
    ]

    static func skillsJSON() -> String {
        var user: [String] = []
        var active: [String] = []
        for (i, name) in skillNames.enumerated() {
            let blurb = skillBlurbs[(i * 7) % skillBlurbs.count]
            let updatable = i % 3 != 0
            let source = updatable
                ? #"{"url":"https://github.com/example-org/skills/tree/main/skills/\#(name)","marketplace":null,"plugin":null,"installedAt":"2026-08-12T09:14:03Z","lastUpdated":"2026-10-0\#(1 + i % 9)T17:40:55Z","updatable":true}"#
                : "null"
            user.append(#"{"name":"\#(name)","description":"\#(blurb)","path":"/tmp/demo/.claude/skills/\#(name)/SKILL.md","source":\#(source)}"#)
            if i % 3 == 1 { active.append("\"\(name)\"") }
        }
        let local = [
            #"{"name":"release-notes-local","description":"Draft release notes from merged branches using this repository's changelog format.","path":"/tmp/demo/Atlas/.marvin/skills/release-notes-local/SKILL.md","shadowsUserGlobal":false,"source":null,"loadIssue":null}"#,
            #"{"name":"migration-checklist","description":"Steps to run before and after a database migration in this project.","path":"/tmp/demo/Atlas/.marvin/skills/migration-checklist/SKILL.md","shadowsUserGlobal":false,"source":null,"loadIssue":{"blocked":true,"reason":"SKILL.md frontmatter has no name; the skill loader skips it."}}"#,
        ]
        return #"""
        {"fingerprint":{"tags":["typescript","nextjs","react","vitest","swift","swiftui","macos","git"],"detectedAt":"2026-10-29T08:12:44Z"},
         "suggestions":[
          {"name":"tailwind-conventions-2","verb":"install","matchedTags":["react","nextjs"],"rationale":"The project uses React with Next.js; this skill keeps utility-class usage consistent.","alreadyInstalled":false,"scope":"user-global"},
          {"name":"swiftui-layout-audit","verb":"build","matchedTags":["swift","swiftui","macos"],"rationale":"A native macOS app with SwiftUI panes would benefit from a project-specific layout checklist.","alreadyInstalled":false,"scope":"project-local"},
          {"name":"api-design-review","verb":"install","matchedTags":["typescript"],"rationale":"Route handlers under src/app/api benefit from a consistent review checklist.","alreadyInstalled":true,"scope":"user-global"}],
         "userGlobal":[\#(user.joined(separator: ","))],
         "projectLocal":[\#(local.joined(separator: ","))],
         "audit":{"decided":false,"skillsMdPath":"/tmp/demo/Atlas/.marvin/skills.md","decisionLine":null},
         "discovered":{"suggestions":[{"name":"route-handler-scaffold","description":"Scaffold a new API route with validation, CSRF guard and a matching test.","rationale":"Eleven route files repeat the same guard and parsing boilerplate.","suggestedBody":"# Route handler scaffold"}],"discoveredAt":"2026-10-28T19:05:12Z","costCents":2,"stale":false},
         "enablement":{"active":[\#(active.joined(separator: ","))],"explicit":true,"core":["graphify"]}}
        """#
    }

    private static let emptySkills = #"""
    {"fingerprint":{"tags":[],"detectedAt":"2026-10-29T08:12:44Z"},"suggestions":[],"userGlobal":[],"projectLocal":[],
     "audit":{"decided":true,"skillsMdPath":"/tmp/demo/Atlas/.marvin/skills.md","decisionLine":"parked 2026-10-01"},"discovered":null,
     "enablement":{"active":[],"explicit":false,"core":[]}}
    """#

    // MARK: Plugins

    private static let pluginNames = [
        "review-suite", "release-helper", "docs-writer", "perf-lab", "db-toolkit", "api-forge", "test-pilot", "design-kit",
        "ops-runbook", "data-notebook", "security-pack", "mobile-bridge",
    ]
    private static let catalogNames = [
        "aws-toolkit", "azure-devops", "bigquery-explorer", "changelog-bot", "cloudflare-pages", "code-tour", "commit-coach",
        "contract-testing", "csv-wizard", "dagger-pipelines", "datadog-notes", "deno-helper", "devcontainer-setup",
        "django-patterns", "elixir-guide", "figma-sync", "firebase-admin", "github-actions-lint", "graphql-schema",
        "helm-charts", "honeycomb-observability", "i18n-pack", "jira-bridge", "jupyter-run", "kafka-inspector",
        "laravel-kit", "linear-sync", "log-parser", "migrations-safe", "monorepo-nx", "nextjs-app-router", "notion-export",
        "openapi-tools", "pagerduty-runbooks", "playwright-pack", "postgres-tuning", "prisma-helper", "pydantic-models",
        "rails-conventions", "react-native-kit", "redis-patterns", "rust-analyzer-tips", "sentry-triage", "slack-digest",
        "snowflake-sql", "spring-boot-kit", "stripe-recipes", "supabase-kit", "svelte-guide", "tailwind-ui", "terraform-docs",
        "typeorm-notes", "vercel-deploy", "vite-config", "vue-composition", "webhook-tester", "wordpress-blocks", "zod-forms",
    ]

    static func pluginsJSON() -> String {
        var plugins: [String] = []
        for (i, name) in pluginNames.enumerated() {
            let enabled = i % 2 == 0
            let updatable = i % 3 != 2
            let source = updatable
                ? #"{"url":"https://github.com/example-org/example-marketplace","marketplace":"example-marketplace","plugin":"\#(name)","installedAt":"2026-08-20T10:30:00Z","lastUpdated":"2026-10-05T09:12:41Z","updatable":true}"#
                : "null"
            let desc = i % 5 == 4 ? "" : "Commands, skills and a read-only agent for \(name.replacingOccurrences(of: "-", with: " ")) work."
            plugins.append(#"{"key":"\#(name)@example-marketplace","name":"\#(name)","marketplace":"example-marketplace","author":"\#(i % 4 == 0 ? "Anthropic" : "Northwind Labs")","version":"1.\#(i).0","description":"\#(desc)","skills":["a","b"],"commands":["c"],"agents":\#(i % 3 == 0 ? #"["reviewer"]"# : "[]"),"hasMcp":\#(i % 4 == 1),"hasHooks":\#(i % 5 == 1),"enabled":\#(enabled),"source":\#(source)}"#)
        }
        var catalog: [String] = []
        for (i, name) in catalogNames.enumerated() {
            catalog.append(#"{"marketplace":"\#(i % 2 == 0 ? "example-marketplace" : "community-tools")","name":"\#(name)","displayName":null,"description":"Helpers for \#(name.replacingOccurrences(of: "-", with: " ")): commands, a skill and examples.","category":"\#(["development", "productivity", "deployment", "database"][i % 4])","author":"\#(i % 5 == 0 ? "Anthropic" : "Example Org")","installed":false}"#)
        }
        return #"{"plugins":[\#(plugins.joined(separator: ","))],"catalog":[\#(catalog.joined(separator: ","))]}"#
    }

    // MARK: Practice

    private static let emptyPractice = #"""
    {"projectId":"tmp-demo-atlas","config":{"enabled":true,"hour":3,"thresholds":{"minSessions":3,"minValue":0.6},"verifyWindow":5,"windowDays":45},
     "sessionsSeen":1,"starters":[],"findings":[],"rules":[],"runs":[],"lastRun":null}
    """#

    static func practiceJSON() -> String {
        let kinds = [
            "ship.unreviewed", "graph.first.skipped", "turn.stalled", "plan.stale", "command.retried", "skill.bypassed:review",
            "scope.met.missing", "cache.recreated", "edit.without.read", "test.skipped", "commit.unscoped", "wakeup.missed",
            "branch.stale", "doc.unlinked", "adr.skipped", "lint.ignored", "secret.suspect", "plan.horizontal",
        ]
        let details = [
            "commit touching deploy/ci.yml with no review skill run this session",
            "9 source files read before the first graph query",
            "turn ended with no question or handoff; user typed continue",
            "4 edits under a plan whose checklist was never updated",
            "same failing command re-run unchanged 3 times",
        ]
        let states = ["proposed", "proposed", "proposed", "active", "regressed", "proposed", "fixed", "observed", "observed", "proposed", "confirmed", "dismissed", "proposed", "observed", "proposed", "confirmed", "proposed", "regressed"]
        var findings: [String] = []
        for (i, k) in kinds.enumerated() {
            let st = states[i]
            let value = max(0.42, 0.93 - Double(i) * 0.027)
            let rule = (st == "active" || st == "regressed") ? #","ruleId":"rule-\#(i)","sessionsAfter":4,"recurrenceAfter":\#(st == "regressed" ? 3 : 0)"# : ""
            let fix = st == "fixed" ? #","fixNote":"plan checklist now ticks itself on commit","sessionsAfter":3,"recurrenceAfter":0"# : ""
            let dis = st == "dismissed" ? #","dismissReason":"flaky network in this sandbox, not a behaviour""# : ""
            findings.append(#"{"id":"\#(k)","kind":"\#(k)","polarity":"failure","state":"\#(st)","firstSeen":"2026-10-02T09:12:40.000Z","lastSeen":"2026-10-29T16:41:05.000Z","sessions":{"s-\#(i)":{"count":2,"cost":2,"lastAt":"2026-10-29T16:41:05.000Z","detail":"\#(details[i % details.count])"}},"distinctSessions":\#(3 + i % 6),"costTotal":\#(7 + i * 3),"rate":0.\#(10 + i),"value":\#(String(format: "%.2f", value)),"unit":"commits","template":\#(i % 7 != 0)\#(rule)\#(fix)\#(dis)}"#)
        }
        for (i, k) in ["ship.reviewed", "graph.first.followed", "scope.met.present", "tests.first", "plan.ticked"].enumerated() {
            findings.append(#"{"id":"\#(k)","kind":"\#(k)","polarity":"success","state":"practice","firstSeen":"2026-09-02T08:00:00.000Z","lastSeen":"2026-10-29T16:50:00.000Z","sessions":{"s-a\#(i)":{"count":3,"cost":3,"lastAt":"2026-10-29T16:50:00.000Z","detail":"done right"}},"distinctSessions":\#(19 + i * 4),"costTotal":27,"value":0.88,"unit":"commits","template":false}"#)
        }
        var rules: [String] = []
        for i in 0..<5 {
            rules.append(#"{"id":"rule-\#(i)","builtin":false,"fingerprint":"\#(kinds[i])","title":"Rule about \#(kinds[i])","tier":"\#(["nudge", "prompt", "deny"][i % 3])","message":"Run a graph_* call before reading source files, and say so when you skip it.","status":"\#(i == 4 ? "retired" : "active")","scope":{"projectId":\#(i == 2 ? "null" : #""tmp-demo-atlas""#)},"metrics":{"fired":\#(3 + i * 5),"bypasses":\#(i % 2)},"acceptedAt":"2026-10-24T09:30:00.000Z","updatedAt":"2026-10-24T09:30:00.000Z"\#(i == 1 ? #","suggestGlobal":true,"confirmedIn":3"# : "")}"#)
        }
        for (i, t) in ["Graph before the first structural read", "Graph drift stop", "Advisor before an ADR-trigger edit", "Review before a boundary commit", "Narrow reads after the graph", "Keep a seeded plan current"].enumerated() {
            rules.append(#"{"id":"builtin:b\#(i)","builtin":true,"fingerprint":"builtin.\#(i)","title":"\#(t)","tier":"\#(["deny", "deny", "nudge", "deny", "nudge", "prompt"][i])","message":"A hand-written gate, exposed as a row so its tier and message can be changed.","status":"\#(i == 5 ? "retired" : "active")","scope":{"projectId":null},"metrics":{"fired":\#(i * 11),"bypasses":0},"acceptedAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-01T00:00:00.000Z"}"#)
        }
        var runs: [String] = []
        for i in 0..<14 {
            runs.append(#"{"at":"2026-10-\#(String(format: "%02d", 29 - i))T03:00:09.000Z","durationMs":\#(1100 + i * 90),"sessionsRead":\#(2 + i % 5),"sessionsSkippedLive":0,"occurrences":\#(11 + i),"findingsNew":\#(i % 3),"recurring":4,"proposed":\#(i % 2),"confirmed":0,"regressed":\#(i == 0 ? 1 : 0),"trigger":"\#(i % 5 == 4 ? "manual-backtest" : "nightly")"}"#)
        }
        return #"""
        {"projectId":"tmp-demo-atlas","config":{"enabled":true,"hour":3,"thresholds":{"minSessions":3,"minValue":0.6},"verifyWindow":5,"windowDays":45,
          "fit":{"at":"2026-10-27T03:00:12.000Z","samples":14,"labelled":9,"method":"rank-correlation","rho":0.62}},
         "sessionsSeen":38,
         "starters":[{"ruleId":"rule-thin-slice","fingerprint":"plan.horizontal","title":"Thin slice before widening the plan","tier":"nudge","message":"Re-present the plan with milestone 1 as a thin slice.","confirmedIn":["alpha-service","beta-web"]}],
         "findings":[\#(findings.joined(separator: ","))],"rules":[\#(rules.joined(separator: ","))],"runs":[\#(runs.joined(separator: ","))],
         "lastRun":\#(runs[0])}
        """#
    }

    // MARK: Surfaces

    private static let widths: [CGFloat] = [260, 420]
    private static let height: CGFloat = 760

    /// Everything open, so the long lists are on screen; the stock key is the
    /// pane's default (Off and Suggested closed) and is rendered too.
    @MainActor private static func expandAll(_ pane: String, _ ids: [String]) {
        UserDefaults.standard.set(Dictionary(uniqueKeysWithValues: ids.map { ($0, false) }),
                                  forKey: PaneCollapseState.defaultsKey(pane: pane))
    }

    @MainActor private static func clear(_ pane: String) {
        UserDefaults.standard.removeObject(forKey: PaneCollapseState.defaultsKey(pane: pane))
    }

    /// Type into the first editable field, the way a person would.
    @MainActor private static func typeFilter(_ text: String) -> @MainActor (NSView) -> Void {
        { host in
            func field(in v: NSView) -> NSTextField? {
                if let f = v as? NSTextField, f.isEditable { return f }
                for s in v.subviews { if let f = field(in: s) { return f } }
                return nil
            }
            guard let f = field(in: host), let window = host.window else { return }
            window.makeFirstResponder(f)
            (f.currentEditor() as? NSTextView)?.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
            RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        }
    }

    @MainActor private static func segment(_ index: Int) -> @MainActor (NSView) -> Void {
        { host in
            func seg(in v: NSView) -> NSSegmentedControl? {
                if let c = v as? NSSegmentedControl { return c }
                for s in v.subviews { if let c = seg(in: s) { return c } }
                return nil
            }
            guard let c = seg(in: host), index < c.segmentCount else { return }
            c.selectedSegment = index
            if let a = c.action { _ = c.sendAction(a, to: c.target) }
        }
    }

    @MainActor static var surfaces: [SurfaceSnapshot.Surface] {
        func surface(_ id: String, _ title: String, tall: CGFloat? = nil, scenario: @escaping @MainActor () -> Void,
                     interact: (@MainActor (NSView) -> Void)? = nil,
                     make: @escaping @MainActor () -> AnyView?) -> SurfaceSnapshot.Surface {
            SurfaceSnapshot.Surface(id, title, .populated, widths: widths, height: tall ?? height, settleMs: 1800,
                                    prepareEachAppearance: false, prepare: scenario, interact: interact, make: make)
        }
        return [
            surface("panekit-skills", "Skills — 46 skills, groups open", scenario: {
                skills = .dozens; expandAll("skills", ["available", "suggested", "audit"])
            }) { AnyView(SkillsPane(seedUpdateStatus: seededUpdates(skills: true))) },
            surface("panekit-skills-default", "Skills — the default disclosure (Off, Suggested and Audit closed)", tall: 1500, scenario: {
                skills = .dozens; clear("skills")
            }) { AnyView(SkillsPane(seedUpdateStatus: seededUpdates(skills: true))) },
            surface("panekit-skills-selected", "Skills — one row selected, its detail open", scenario: {
                skills = .dozens; expandAll("skills", ["available", "suggested", "audit"])
            }) { AnyView(SkillsPane(seedUpdateStatus: seededUpdates(skills: true), seedSelection: "/tmp/demo/.claude/skills/api-design-review/SKILL.md")) },
            surface("panekit-skills-filtered", "Skills — filter “git”", scenario: {
                skills = .dozens; clear("skills")
            }, interact: typeFilter("git")) { AnyView(SkillsPane()) },
            surface("panekit-skills-nomatch", "Skills — filter with no match", scenario: {
                skills = .dozens; clear("skills")
            }, interact: typeFilter("zzzz")) { AnyView(SkillsPane()) },
            surface("panekit-skills-empty", "Skills — nothing installed", scenario: { skills = .empty; clear("skills") }) { AnyView(SkillsPane()) },
            surface("panekit-skills-error", "Skills — the sidecar answered with an error", scenario: { skills = .error }) { AnyView(SkillsPane()) },

            surface("panekit-plugins", "Plugins — 12 installed, 58 in the catalog, groups open", scenario: {
                plugins = .dozens; expandAll("plugins", ["catalog"])
            }) { AnyView(PluginsPane(seedUpdateStatus: seededUpdates(skills: false))) },
            surface("panekit-plugins-default", "Plugins — the default disclosure (catalog closed)", tall: 1200, scenario: {
                plugins = .dozens; clear("plugins")
            }) { AnyView(PluginsPane(seedUpdateStatus: seededUpdates(skills: false))) },
            surface("panekit-plugins-selected", "Plugins — one row selected, its detail open", scenario: {
                plugins = .dozens; clear("plugins")
            }) { AnyView(PluginsPane(seedUpdateStatus: seededUpdates(skills: false), seedSelection: "review-suite@example-marketplace")) },
            surface("panekit-plugins-filtered", "Plugins — filter “data”", scenario: {
                plugins = .dozens; clear("plugins")
            }, interact: typeFilter("data")) { AnyView(PluginsPane()) },
            surface("panekit-plugins-empty", "Plugins — none installed", scenario: { plugins = .empty; clear("plugins") }) { AnyView(PluginsPane()) },
            surface("panekit-plugins-error", "Plugins — the sidecar answered with an error", scenario: { plugins = .error }) { AnyView(PluginsPane()) },

            surface("panekit-practice", "Practice — Findings, 18 failures", scenario: {
                practice = .dozens; expandAll("practice", ["findings.below", "findings.done"])
            }) { AnyView(PracticePane()) },
            surface("panekit-practice-default", "Practice — Findings, default disclosure", tall: 1200, scenario: {
                practice = .dozens; clear("practice")
            }) { AnyView(PracticePane()) },
            surface("panekit-practice-selected", "Practice — a finding selected, its detail open", scenario: {
                practice = .dozens; clear("practice")
            }) { AnyView(PracticePane(seedSelection: "ship.unreviewed")) },
            surface("panekit-practice-rules", "Practice — Rules", scenario: {
                practice = .dozens; expandAll("practice", ["rules.builtin"])
            }, interact: segment(2)) { AnyView(PracticePane()) },
            surface("panekit-practice-runs", "Practice — Runs", scenario: { practice = .dozens; clear("practice") },
                    interact: segment(3)) { AnyView(PracticePane()) },
            surface("panekit-practice-empty", "Practice — nothing found yet", scenario: { practice = .empty; clear("practice") }) { AnyView(PracticePane()) },
            surface("panekit-practice-error", "Practice — the ledger could not be read", scenario: { practice = .error }) { AnyView(PracticePane()) },

            SurfaceSnapshot.Surface("panekit-gallery", "The kit: every row anatomy, a group header with a bulk action, notices", .fixture,
                                    widths: widths, height: 900) { AnyView(PaneKitGallery()) },
        ]
    }

    /// A check has run: some skills and plugins have a newer version upstream.
    @MainActor private static func seededUpdates(skills isSkills: Bool) -> [String: String] {
        if isSkills {
            var out: [String: String] = [:]
            for (i, n) in skillNames.enumerated() where i % 3 != 0 && i % 4 == 1 { out["user-global:\(n)"] = "update-available" }
            return out
        }
        var out: [String: String] = [:]
        for (i, n) in pluginNames.enumerated() where i % 3 != 2 && i % 4 == 0 { out["\(n)@example-marketplace"] = "update-available" }
        return out
    }
}

/// Every anatomy the kit draws, on one page: what a pane author is shown first.
@MainActor private struct PaneKitGallery: View {
    @State private var selection: String? = "detail"
    @State private var filter = "gra"
    private let store = PaneCollapseStore(pane: "gallery")

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "Gallery", symbol: "square.grid.2x2", subtitle: "ran 2h ago", count: 7) {
                PaneActionButton(title: "Add…", role: .primary) {}
                PaneOverflowMenu(label: "More") { Button("Reload") {} }
            }
            PaneFilterField(text: $filter, prompt: "Filter skills")
            PaneNoticeStrip(notice: PaneNotice(kind: .warning, headline: "All up to date, but 2 could not be checked.", detail: "They have no recorded source."), onDismiss: {})
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    PaneGroup(store: store, id: "a", title: "Needs update", count: 3, tint: .orange, help: "A check found a newer version.",
                              trailing: { PaneActionButton(title: PaneBulkAction.title("Update all", count: 3), role: .primary) {} }) {
                        PaneListRow(rowID: "r1", title: "graphify", titleIsIdentifier: true,
                                    leading: .toggle(isOn: true, name: "graphify", help: nil, onToggle: { _ in }),
                                    secondary: "Build and query a knowledge graph of the codebase before reading files.",
                                    items: [PaneRowItem(id: "u", title: "Update", role: .primary, perform: {}),
                                            PaneRowItem(id: "v", title: "View SKILL.md", perform: {}),
                                            PaneRowItem(id: "d", title: "Remove", role: .destructive, perform: {})])
                        PaneListRow(rowID: "r2", title: "a-name-that-is-far-too-long-for-a-narrow-sidebar-to-show", titleIsIdentifier: true,
                                    leading: .toggle(isOn: false, name: "x", help: nil, onToggle: { _ in }),
                                    secondary: "No description", secondaryStyle: .placeholder, trailingText: "Updated", trailingSymbol: "checkmark",
                                    trailingTint: GitDecorationColor.added, busy: true)
                        PaneListRow(rowID: "detail", title: "pr-review", titleIsIdentifier: true,
                                    leading: .glyph("folder"), secondary: "Pre-landing review of the current branch diff.",
                                    trailingText: "Project", selected: selection == "detail",
                                    items: [PaneRowItem(id: "v", title: "View SKILL.md", perform: {})],
                                    onSelect: { selection = "detail" }, showsDetail: true,
                                    detail: { Text("The whole description, the source URL and when it was last updated, one block under the row.")
                                        .font(PaneFont.secondary).foregroundStyle(MarvinTheme.textMuted).fixedSize(horizontal: false, vertical: true) })
                    }
                    PaneGroup(store: store, id: "b", title: "Not loaded", count: 1, tint: GitDecorationColor.deleted) {
                        PaneListRow(rowID: "r4", title: "migration-checklist", titleIsIdentifier: true,
                                    leading: .glyph("exclamationmark.triangle.fill", GitDecorationColor.deleted),
                                    secondary: "SKILL.md frontmatter has no name; the skill loader skips it.", secondaryStyle: .error,
                                    trailingText: "Not loaded", trailingSymbol: "exclamationmark.triangle.fill", trailingTint: GitDecorationColor.deleted)
                    }
                    PaneGroup(store: store, id: "c", title: "Off in this project", count: 12, startsCollapsed: true) {
                        PaneNote(text: "Closed groups draw nothing below their header.")
                    }
                    PaneGroup(store: store, id: "d", title: "Quiet group", count: 0) {
                        PaneNote(text: "A group with a note instead of rows. Zero draws no count.")
                    }
                    PaneEmptyView(state: .filtered(query: "zeta", noun: "skills"), actionTitle: "Clear filter") {}
                    PaneLoadingView(label: "Reading the skills index…")
                    PaneEmptyView(state: .couldNotLoad("skills", reason: "The sidecar did not answer."), actionTitle: "Retry") {}
                }
            }
        }
    }
}
