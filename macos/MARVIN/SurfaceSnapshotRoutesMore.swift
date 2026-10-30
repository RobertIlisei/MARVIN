// SurfaceSnapshotRoutesMore — the sidecar fixtures for the left panes that carry
// their own state: Sessions, Skills, Plugins, Practice and the Backlog.
// Same rules as SurfaceSnapshotRoutes.swift: shaped to the Swift decoder, every
// name and number invented, paths written against `@ROOT@`.

import Foundation

enum SurfaceRoutesMore {
    static func handle(method: String, path: String, query: [String: String], root: String) -> FixtureSidecar.Response? {
        func ok(_ json: String) -> FixtureSidecar.Response {
            .json(json.replacingOccurrences(of: "@ROOT@", with: root))
        }
        switch path {
        case "/api/sessions/watch": return ok(watchJSON())
        case "/api/chat/announce": return announce()
        case "/api/worktrees": return ok(method == "POST" ? previewJSON : worktreeList)
        case "/api/skills": return ok(skills)
        case "/api/plugins": return ok(plugins)
        case "/api/practice": return ok(practice)
        case "/api/backlog": return ok(backlog)
        case "/api/models": return ok(models)
        case "/api/models/roles": return ok(modelRoles)
        case "/api/auth/config": return ok(authConfig)
        case "/api/wakeups": return ok(wakeups)
        case "/api/background-jobs": return ok(backgroundJobs)
        case "/api/audit/auto": return ok(autoAudit)
        default: return nil
        }
    }

    // MARK: - Sessions

    /// Row ids for the tabs the Sessions pane shows as open. The pane reads
    /// the id list from UserDefaults (`marvin.chatTabs.<projectId>`), so the
    /// harness writes it and removes it afterwards.
    static let openIds = [
        "a1111111-0000-4000-8000-000000000001", "b2222222-0000-4000-8000-000000000002",
        "c3333333-0000-4000-8000-000000000003", "d4444444-0000-4000-8000-000000000004",
        "e5555555-0000-4000-8000-000000000005", "f6666666-0000-4000-8000-000000000006",
    ]

    /// Relative to now, so "3m" renders as 3m whenever the snapshot is taken.
    static func iso(_ minutesAgo: Double) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(-minutesAgo * 60))
    }

    private static func tree(_ slug: String) -> String {
        #"{"mode":"worktree","slug":"\#(slug)","path":"@ROOT@/.marvin/worktrees/\#(slug)","branch":"marvin/tab/\#(slug)","base":"a1b2c3d","baseRef":"main","cwd":"@ROOT@/.marvin/worktrees/\#(slug)","currentBranch":"marvin/tab/\#(slug)","present":true}"#
    }

    private static func wt(_ slug: String, state: String, commits: Int, dirty: Bool, behind: Int, closed: Bool) -> String {
        #"{"slug":"\#(slug)","branch":"marvin/tab/\#(slug)","state":"\#(state)","commits":\#(commits),"dirty":\#(dirty),"base":"a1b2c3d","behind":\#(behind),"closed":\#(closed),"target":"main"}"#
    }

    private static func ready(_ id: String, _ slug: String, _ title: String, commits: Int, behind: Int, endedMin: Double) -> String {
        #"{"marvinSessionId":"\#(id)","state":"idle","title":"\#(title)","turn":null,"activity":null,"pending":[],"worktree":\#(wt(slug, state: "ready", commits: commits, dirty: false, behind: behind, closed: true)),"tree":\#(tree(slug)),"lastTurn":{"turnId":"t-\#(slug)","startedAt":"\#(iso(endedMin + 10))","endedAt":"\#(iso(endedMin))","outcome":"completed"},"cost":{"turns":3,"costUsd":0.31},"updatedAt":"\#(iso(endedMin))"}"#
    }

    static func watchJSON() -> String {
        let rows = [
            // working · isolated · running Bash
            #"{"marvinSessionId":"\#(openIds[0])","state":"working","title":"Add retry with backoff to the HTTP client","turn":{"turnId":"t-a1","kind":"human","startedAt":"\#(iso(3))","mutated":true},"activity":{"state":"tool","tool":"Bash","turnId":"t-a1"},"pending":[],"worktree":\#(wt("retry-backoff", state: "session", commits: 2, dirty: true, behind: 1, closed: false)),"tree":\#(tree("retry-backoff")),"diff":{"added":84,"removed":12,"files":5,"untracked":1},"plan":{"done":3,"total":8,"open":5,"lastTodoAt":"\#(iso(2))","seeded":false},"graphUsage":{"graphCalls":12,"fileReads":20,"bashReads":10,"ratio":2.5},"lastTurn":null,"cost":{"turns":4,"costUsd":0.42},"supervisor":{"delegation":"answer-questions","sharedCheckout":false,"touchedTurn":null,"waitingOnOwn":null,"stoppedByUser":false,"lastActAt":null,"openEscalations":0},"updatedAt":"\#(iso(0))"}"#,
            // working · shared · writing
            #"{"marvinSessionId":"\#(openIds[1])","state":"working","title":"Draft the quickstart section","turn":{"turnId":"t-b1","kind":"human","startedAt":"\#(iso(1))","mutated":true},"activity":{"state":"writing","turnId":"t-b1"},"pending":[],"worktree":null,"tree":{"mode":"shared"},"diff":{"added":9,"removed":3,"files":2},"plan":null,"lastTurn":null,"cost":{"turns":1,"costUsd":0.08},"supervisor":{"delegation":"observe","sharedCheckout":true,"touchedTurn":null,"waitingOnOwn":null,"stoppedByUser":false,"lastActAt":null,"openEscalations":0},"updatedAt":"\#(iso(0))"}"#,
            // awaiting you · a pending confirm answerable inline · shared
            #"{"marvinSessionId":"\#(openIds[2])","state":"awaiting-you","title":"Publish the release branch","turn":{"turnId":"t-c1","kind":"human","startedAt":"\#(iso(6))","mutated":true},"activity":{"state":"tool","tool":"Bash","turnId":"t-c1"},"pending":[{"turnId":"t-c1","toolUseId":"use-c1","toolName":"Bash","since":"\#(iso(1))","excerpt":"git push origin feature/retry","reason":"Pushes commits to a remote","userOnly":false,"supervisorProposal":{"ledgerId":"L-fixture-1","actionId":"deny","grounds":[]},"proposalRevealed":false}],"worktree":null,"tree":{"mode":"shared"},"lastTurn":null,"cost":{"turns":2,"costUsd":0.17},"supervisor":{"delegation":"answer-confirms","sharedCheckout":true,"touchedTurn":null,"waitingOnOwn":null,"stoppedByUser":false,"lastActAt":null,"openEscalations":1},"updatedAt":"\#(iso(0))"}"#,
            // idle · isolated · behind its base
            #"{"marvinSessionId":"\#(openIds[3])","state":"idle","title":"Fix the flaky cache test","turn":null,"activity":null,"pending":[],"worktree":\#(wt("fix-flaky-test", state: "session", commits: 1, dirty: false, behind: 3, closed: false)),"tree":\#(tree("fix-flaky-test")),"lastTurn":{"turnId":"t-d1","startedAt":"\#(iso(27))","endedAt":"\#(iso(25))","outcome":"completed"},"cost":{"turns":2,"costUsd":0.19},"supervisor":{"delegation":"answer-questions","sharedCheckout":false,"touchedTurn":null,"waitingOnOwn":null,"stoppedByUser":false,"lastActAt":null,"openEscalations":0},"updatedAt":"\#(iso(25))"}"#,
            // failed · shared
            #"{"marvinSessionId":"\#(openIds[4])","state":"failed","title":"Migrate the config loader","turn":null,"activity":null,"pending":[],"worktree":null,"tree":{"mode":"shared"},"lastTurn":{"turnId":"t-e1","startedAt":"\#(iso(15))","endedAt":"\#(iso(12))","outcome":"error","error":"Typecheck failed: TS2345"},"cost":{"turns":3,"costUsd":0.26},"supervisor":{"delegation":"off","sharedCheckout":true,"touchedTurn":null,"waitingOnOwn":null,"stoppedByUser":false,"lastActAt":null,"openEscalations":0},"updatedAt":"\#(iso(12))"}"#,
            // stopped by the user · shared (derives to idle, not red)
            #"{"marvinSessionId":"\#(openIds[5])","state":"idle","title":"Explore pagination options","turn":null,"activity":null,"pending":[],"worktree":null,"tree":{"mode":"shared"},"lastTurn":{"turnId":"t-f1","startedAt":"\#(iso(42))","endedAt":"\#(iso(40))","outcome":"stopped"},"cost":{"turns":1,"costUsd":0.05},"supervisor":{"delegation":"observe","sharedCheckout":true,"touchedTurn":null,"waitingOnOwn":null,"stoppedByUser":true,"lastActAt":null,"openEscalations":0},"updatedAt":"\#(iso(40))"}"#,
            // closed tabs whose branches are ready to integrate
            ready("r7777777-0000-4000-8000-000000000007", "rate-limit-headers", "Add rate-limit headers", commits: 3, behind: 0, endedMin: 90),
            ready("r8888888-0000-4000-8000-000000000008", "docs-quickstart", "Rewrite the quickstart", commits: 1, behind: 2, endedMin: 150),
            ready("r9999999-0000-4000-8000-000000000009", "refactor-auth-session", "Refactor session handling", commits: 4, behind: 5, endedMin: 300),
        ]
        return #"{"projectId":"prj_atlas","generatedAt":"\#(iso(0))","rows":[\#(rows.joined(separator: ","))]}"#
    }

    /// The pane's feed indicator turns orange until one decoded event arrives,
    /// so the stream says one thing and then holds the connection open.
    static func announce() -> FixtureSidecar.Response {
        var r = FixtureSidecar.Response.stream()
        r.body = Data("""
        event: session.activity
        data: {"marvinSessionId":"\(openIds[0])","turnId":"t-a1","state":"tool","tool":"Bash"}


        """.utf8)
        return r
    }

    static let previewJSON = #"""
    {"target":"main","targetHead":"9f8e7d6","previewAvailable":true,"rows":[
      {"slug":"rate-limit-headers","branch":"marvin/tab/rate-limit-headers","sessionId":"r7777777-0000-4000-8000-000000000007","task":"Add rate-limit headers","state":"ready","commits":3,"added":120,"removed":18,"behind":0,"verdict":"clean","conflicts":[],"skipReason":null},
      {"slug":"docs-quickstart","branch":"marvin/tab/docs-quickstart","sessionId":"r8888888-0000-4000-8000-000000000008","task":"Rewrite the quickstart","state":"ready","commits":1,"added":40,"removed":6,"behind":2,"verdict":"clean","conflicts":[],"skipReason":null},
      {"slug":"refactor-auth-session","branch":"marvin/tab/refactor-auth-session","sessionId":"r9999999-0000-4000-8000-000000000009","task":"Refactor session handling","state":"ready","commits":4,"added":310,"removed":145,"behind":5,"verdict":"conflict","conflicts":["src/auth/session.ts","src/auth/tokens.ts"],"skipReason":null}]}
    """#

    static let worktreeList = #"""
    {"worktrees":[
     {"slug":"add-retry-jitter","path":"@ROOT@/.marvin/worktrees/add-retry-jitter","branch":"marvin/add-retry-jitter","base":"a1b2c3d","task":"Add jitter to the retry delay","state":"running","commits":0,"filesChanged":0,"dirty":true,"checkoutPresent":true},
     {"slug":"typed-error-classes","path":"@ROOT@/.marvin/worktrees/typed-error-classes","branch":"marvin/typed-error-classes","base":"a1b2c3d","task":"Introduce typed error classes","state":"ready","commits":3,"filesChanged":5,"dirty":false,"checkoutPresent":true,"lastCommitAt":"2026-10-30T07:55:00.000Z","added":142,"removed":27},
     {"slug":"replay-buffered-body","path":"@ROOT@/.marvin/worktrees/replay-buffered-body","branch":"marvin/replay-buffered-body","base":"a1b2c3d","task":"Replay a buffered body across attempts","state":"ready","commits":1,"filesChanged":2,"dirty":false,"checkoutPresent":false,"lastCommitAt":"2026-10-29T18:20:00.000Z","added":38,"removed":4},
     {"slug":"tab-fix-body-replay","path":"@ROOT@/.marvin/worktrees/tab-fix-body-replay","branch":"marvin/tab/fix-body-replay","base":"a1b2c3d","task":"Fix body replay","state":"session","commits":2,"filesChanged":3,"dirty":true,"checkoutPresent":true,"lastCommitAt":"2026-10-30T09:10:00.000Z","added":61,"removed":9},
     {"slug":"scratch-spike","path":"@ROOT@/.marvin/worktrees/scratch-spike","branch":"marvin/scratch-spike","base":"9f8e7d6","task":"Spike a connection pool","state":"empty","commits":0,"filesChanged":0,"dirty":false,"checkoutPresent":true},
     {"slug":"pin-backoff-range","path":"@ROOT@/.marvin/worktrees/pin-backoff-range","branch":"marvin/pin-backoff-range","base":"9f8e7d6","task":"Pin the backoff range in a test","state":"merged","commits":1,"filesChanged":1,"dirty":false,"checkoutPresent":true,"mergedInto":"main","lastCommitAt":"2026-10-22T12:00:00.000Z"}],
     "job":null}
    """#

    // MARK: - Skills

    static let skills = #"""
    {
      "fingerprint": {"tags": ["typescript", "nextjs", "react", "vitest", "swift", "swiftui", "macos", "git"], "detectedAt": "2026-10-29T08:12:44Z"},
      "suggestions": [
        {"name": "tailwind-conventions", "verb": "install", "matchedTags": ["react", "nextjs"], "rationale": "The project uses React with Next.js; this skill keeps utility-class usage consistent.", "alreadyInstalled": false, "scope": "user-global"},
        {"name": "api-design-review", "verb": "install", "matchedTags": ["typescript", "nextjs"], "rationale": "Route handlers under src/app/api benefit from a consistent review checklist.", "alreadyInstalled": true, "scope": "user-global"},
        {"name": "vitest-patterns", "verb": "install", "matchedTags": ["vitest", "typescript"], "rationale": "Test files use Vitest; this skill documents fixtures and mocking conventions.", "alreadyInstalled": false, "scope": "user-global"},
        {"name": "swiftui-layout-audit", "verb": "build", "matchedTags": ["swift", "swiftui", "macos"], "rationale": "A native macOS app with SwiftUI panes would benefit from a project-specific layout checklist.", "alreadyInstalled": false, "scope": "project-local"}
      ],
      "userGlobal": [
        {"name": "graphify", "description": "Build and query a knowledge graph of the codebase before reading files.", "path": "/tmp/demo/.claude/skills/graphify/SKILL.md",
         "source": {"url": "https://github.com/example-org/skills/tree/main/skills/graphify", "marketplace": null, "plugin": null, "installedAt": "2026-08-12T09:14:03Z", "lastUpdated": "2026-10-02T17:40:55Z", "updatable": true}},
        {"name": "test-driven-development", "description": "Write the failing test first, then the smallest change that makes it pass.", "path": "/tmp/demo/.claude/skills/test-driven-development/SKILL.md",
         "source": {"url": "https://github.com/example-org/skills/tree/main/skills/test-driven-development", "marketplace": null, "plugin": null, "installedAt": "2026-08-12T09:14:09Z", "lastUpdated": "2026-09-20T11:02:31Z", "updatable": true}},
        {"name": "api-design-review", "description": "Review HTTP route handlers for naming, status codes, validation and error shape.", "path": "/tmp/demo/.claude/skills/api-design-review/SKILL.md",
         "source": {"url": null, "marketplace": "example-marketplace", "plugin": "api-toolkit", "installedAt": "2026-09-03T14:20:00Z", "lastUpdated": "2026-09-03T14:20:00Z", "updatable": false}},
        {"name": "slide-builder", "description": "Assemble a presentation from an outline, with consistent layouts and speaker notes.", "path": "/tmp/demo/.claude/skills/slide-builder/SKILL.md",
         "source": {"url": "https://github.com/example-org/skills/tree/main/skills/slide-builder", "marketplace": null, "plugin": null, "installedAt": "2026-07-01T10:00:00Z", "lastUpdated": "2026-07-01T10:00:00Z", "updatable": true}},
        {"name": "spreadsheet-tools", "description": "Read, clean and write tabular workbooks; preserves formulas and formatting.", "path": "/tmp/demo/.claude/skills/spreadsheet-tools/SKILL.md", "source": null},
        {"name": "canvas-poster", "description": "Compose a static poster or card layout from a brief and a palette.", "path": "/tmp/demo/.claude/skills/canvas-poster/SKILL.md", "source": null}
      ],
      "projectLocal": [
        {"name": "release-notes", "description": "Draft release notes from merged branches using this repository's changelog format.", "path": "@ROOT@/.marvin/skills/release-notes/SKILL.md", "shadowsUserGlobal": false,
         "source": {"url": null, "marketplace": null, "plugin": null, "installedAt": "2026-09-15T08:00:00Z", "lastUpdated": "2026-10-01T08:00:00Z", "updatable": false}, "loadIssue": null},
        {"name": "migration-checklist", "description": "Steps to run before and after a database migration in this project.", "path": "@ROOT@/.marvin/skills/migration-checklist/SKILL.md", "shadowsUserGlobal": false, "source": null,
         "loadIssue": {"blocked": true, "reason": "SKILL.md frontmatter has no name; the skill loader skips it."}}
      ],
      "audit": {"decided": false, "skillsMdPath": "@ROOT@/.marvin/skills.md", "decisionLine": null},
      "discovered": {
        "suggestions": [
          {"name": "route-handler-scaffold", "description": "Scaffold a new API route with validation, CSRF guard and a matching test.", "rationale": "Eleven route files repeat the same guard and parsing boilerplate.", "suggestedBody": "# Route handler scaffold\n\n1. Create the route file.\n2. Add the client guard.\n3. Validate the body.\n4. Add a test."},
          {"name": "pane-empty-states", "description": "Checklist for the empty, loading and error states of a left-pane view.", "rationale": "Every pane implements the three states slightly differently.", "suggestedBody": "# Pane states\n\n- Empty: headline, hint, one action.\n- Loading: label.\n- Error: message and Retry."}
        ],
        "discoveredAt": "2026-10-28T19:05:12Z", "costCents": 2, "stale": false
      },
      "enablement": {"active": ["graphify", "test-driven-development", "api-design-review"], "explicit": false, "core": ["graphify", "skill-creator", "systematic-debugging", "test-driven-development", "pr-review", "security-audit"]}
    }
    """#

    // MARK: - Plugins

    static let plugins = #"""
    {
      "plugins": [
        {"key": "review-suite@example-marketplace", "name": "review-suite", "marketplace": "example-marketplace", "author": "Anthropic", "version": "1.4.0",
         "description": "Structured code review with security and performance passes, plus a read-only reviewer agent.",
         "skills": ["code-review", "security-pass", "perf-pass", "pr-summary", "test-gaps"], "commands": ["review", "review-security", "review-perf"], "agents": ["reviewer", "triager"],
         "hasMcp": true, "hasHooks": false, "enabled": true,
         "source": {"url": "https://github.com/example-org/example-marketplace", "marketplace": "example-marketplace", "plugin": "review-suite", "installedAt": "2026-08-20T10:30:00Z", "lastUpdated": "2026-10-05T09:12:41Z", "updatable": true}},
        {"key": "release-helper@community-tools", "name": "release-helper", "marketplace": "community-tools", "author": "Northwind Labs", "version": "0.9.2",
         "description": "Changelog drafting and version bump commands. Ships a pre-commit hook that MARVIN never loads.",
         "skills": ["changelog"], "commands": ["bump", "release-notes"], "agents": [],
         "hasMcp": false, "hasHooks": true, "enabled": true, "source": null},
        {"key": "docs-writer@example-marketplace", "name": "docs-writer", "marketplace": "example-marketplace", "author": "Example Org", "version": "2.1.0",
         "description": "Writing guides for reference docs and tutorials.",
         "skills": ["reference-docs", "tutorial-docs"], "commands": [], "agents": [],
         "hasMcp": false, "hasHooks": false, "enabled": false,
         "source": {"url": "https://github.com/example-org/docs-writer", "marketplace": "example-marketplace", "plugin": "docs-writer", "installedAt": "2026-07-14T16:00:00Z", "lastUpdated": "2026-07-14T16:00:00Z", "updatable": true}},
        {"key": "db-inspector@local", "name": "db-inspector", "marketplace": null, "author": null, "version": "unknown", "description": null,
         "skills": [], "commands": ["schema", "explain"], "agents": ["query-planner"],
         "hasMcp": true, "hasHooks": true, "enabled": false,
         "source": {"url": null, "marketplace": null, "plugin": null, "installedAt": "2026-09-01T12:00:00Z", "lastUpdated": "2026-09-01T12:00:00Z", "updatable": false}}
      ],
      "catalog": [
        {"marketplace": "example-marketplace", "name": "review-suite", "displayName": "Review Suite", "description": "Structured code review with security and performance passes.", "category": "development", "author": "Anthropic", "installed": true},
        {"marketplace": "example-marketplace", "name": "docs-writer", "displayName": "Docs Writer", "description": "Writing guides for reference docs and tutorials.", "category": "documentation", "author": "Example Org", "installed": true},
        {"marketplace": "example-marketplace", "name": "test-scaffolder", "displayName": null, "description": "Generates test scaffolding from function signatures.", "category": "testing", "author": "Example Org", "installed": false},
        {"marketplace": "example-marketplace", "name": "api-explorer", "displayName": "API Explorer", "description": "Browse and call HTTP endpoints from an OpenAPI description.", "category": "development", "author": "Northwind Labs", "installed": false},
        {"marketplace": "community-tools", "name": "diagram-maker", "displayName": "Diagram Maker", "description": "Turn a description into a Mermaid or PlantUML diagram.", "category": "design", "author": null, "installed": false}
      ]
    }
    """#
}
