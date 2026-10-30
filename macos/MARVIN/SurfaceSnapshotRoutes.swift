// SurfaceSnapshotRoutes — what the stand-in sidecar answers (SurfaceSnapshotSidecar.swift).
//
// Each body is the JSON the real route returns, shaped to the Swift decoder
// that reads it (the decoder is the contract; a missing non-optional key
// fails the whole pane, so these carry every one). Everything is invented:
// the project, its files, its people and its numbers are neutral demo data and
// never a real project (Golden Rule 6). Paths are written against `@ROOT@` and
// resolved to `SurfaceFixtures.project` when served.

import Foundation

enum SurfaceRoutes {
    /// Resolve a request to its fixture. Unknown paths are a 404, logged once
    /// by the server, so a missing fixture shows up in the run output rather
    /// than as a silently empty pane.
    static func handle(method: String, path: String, query: [String: String]) -> FixtureSidecar.Response {
        let root = SurfaceFixtures.project
        func ok(_ json: String) -> FixtureSidecar.Response {
            .json(json.replacingOccurrences(of: "@ROOT@", with: root))
        }

        switch path {
        case "/api/health": return ok(health)
        case "/api/projects": return ok(projects)
        case "/api/projects/active": return ok(#"{"id":"prj_atlas","project":{"id":"prj_atlas","name":"Atlas","workDir":"@ROOT@"}}"#)
        case "/api/cost": return ok(cost)
        case "/api/context": return ok(context)
        case "/api/files/tree": return ok(tree)
        case "/api/files/status": return ok(fileStatus)
        case "/api/files/content": return ok(fileContent(query["path"] ?? ""))
        case "/api/files/search": return ok(search)
        case "/api/git/status": return ok(gitStatus)
        case "/api/git/repos": return ok(gitRepos)
        case "/api/git/branch": return ok(gitBranches)
        case "/api/git/graph": return ok(gitGraph)
        case "/api/git/stash": return ok(gitStash)
        case "/api/git/diff": return ok(gitDiff(path: query["path"] ?? "", mode: query["mode"] ?? "working"))
        case "/api/changes": return ok(changes)
        case "/api/changes/diff": return ok(changeDiff(query["path"] ?? ""))
        case "/api/graph/html": return .html(graphHTML)
        default:
            if let extra = SurfaceRoutesMore.handle(method: method, path: path, query: query, root: root) { return extra }
            // Streams the app opens and then waits on: silence, not failure.
            if path == "/api/sessions/watch" || path == "/api/chat/announce" { return .stream() }
            return .missing()
        }
    }

    // MARK: - Session basics

    static let health = #"""
    {"ok":true,"auth":{"mode":"host-credentials","credentialHint":null,"error":null},
     "claudeBinary":"/usr/local/bin/claude","binaryError":null,"model":"claude-sonnet-5-5","modelIsLive":true,
     "dataDir":"/tmp/demo/.marvin","version":"0.1.118"}
    """#

    static let projects = #"""
    {"projects":[
      {"id":"prj_atlas","name":"Atlas","workDir":"@ROOT@"},
      {"id":"prj_harbor","name":"Harbor","workDir":"/tmp/demo/Harbor"},
      {"id":"prj_notes","name":"Field Notes","workDir":"/tmp/demo/Notes"}],
     "active":"prj_atlas"}
    """#

    static let cost = #"""
    {"today":{"costUsd":1.84,"turns":12,"inputTokens":184320,"outputTokens":22650,"cacheCreationTokens":41200,"cacheReadTokens":903400},
     "week":{"costUsd":9.62,"turns":71,"inputTokens":1120400,"outputTokens":141900,"cacheCreationTokens":210000,"cacheReadTokens":5120000},
     "lifetime":{"costUsd":47.3,"turns":402,"inputTokens":5402100,"outputTokens":690300,"cacheCreationTokens":880000,"cacheReadTokens":21900000},
     "daily":[
      {"day":"2026-10-24","costUsd":0.9,"turns":7},{"day":"2026-10-25","costUsd":0.0,"turns":0},
      {"day":"2026-10-26","costUsd":2.4,"turns":16},{"day":"2026-10-27","costUsd":1.15,"turns":9},
      {"day":"2026-10-28","costUsd":1.78,"turns":13},{"day":"2026-10-29","costUsd":1.55,"turns":14},
      {"day":"2026-10-30","costUsd":1.84,"turns":12}],
     "openRouter":null,
     "claudeRateLimits":[
      {"type":"five_hour","status":"allowed","utilization":0.35,"resetsAt":1793329200,"isUsingOverage":false},
      {"type":"seven_day","status":"allowed_warning","utilization":0.55,"resetsAt":1793491200,"isUsingOverage":false},
      {"type":"seven_day_opus","status":"allowed","utilization":0.12,"resetsAt":1793491200}]}
    """#

    static let context = #"""
    {"model":"claude-sonnet-5-5","contextWindow":200000,
     "estimate":{"systemPrompt":3200,"tools":11000,
      "projectContext":{"total":4800,"sections":[
       {"label":"CLAUDE.md","approxTokens":1900},{"label":"README.md","approxTokens":1100},
       {"label":"Directory tree","approxTokens":900},{"label":"Recent commits","approxTokens":600},
       {"label":"Git status","approxTokens":300}]}}}
    """#

    // MARK: - Files

    static let tree = #"""
    {"root":"@ROOT@","truncated":false,"count":41,"tree":[
     {"name":".github","path":"@ROOT@/.github","type":"dir","children":[
      {"name":"workflows","path":"@ROOT@/.github/workflows","type":"dir","children":[
       {"name":"ci.yml","path":"@ROOT@/.github/workflows/ci.yml","type":"file"},
       {"name":"release.yml","path":"@ROOT@/.github/workflows/release.yml","type":"file"}]}]},
     {"name":"Sources","path":"@ROOT@/Sources","type":"dir","children":[
      {"name":"App","path":"@ROOT@/Sources/App","type":"dir","children":[
       {"name":"Models","path":"@ROOT@/Sources/App/Models","type":"dir","children":[
        {"name":"Project.swift","path":"@ROOT@/Sources/App/Models/Project.swift","type":"file"},
        {"name":"UsageLedger.swift","path":"@ROOT@/Sources/App/Models/UsageLedger.swift","type":"file"}]},
       {"name":"Services","path":"@ROOT@/Sources/App/Services","type":"dir","children":[
        {"name":"ApiClient.swift","path":"@ROOT@/Sources/App/Services/ApiClient.swift","type":"file"},
        {"name":"SyncService.swift","path":"@ROOT@/Sources/App/Services/SyncService.swift","type":"file"}]},
       {"name":"AtlasApp.swift","path":"@ROOT@/Sources/App/AtlasApp.swift","type":"file"},
       {"name":"ContentView.swift","path":"@ROOT@/Sources/App/ContentView.swift","type":"file"},
       {"name":"Theme.swift","path":"@ROOT@/Sources/App/Theme.swift","type":"file"}]},
      {"name":"Resources","path":"@ROOT@/Sources/Resources","type":"dir","children":[
       {"name":"Info.plist","path":"@ROOT@/Sources/Resources/Info.plist","type":"file"}]}]},
     {"name":"Tests","path":"@ROOT@/Tests","type":"dir","children":[
      {"name":"AtlasTests","path":"@ROOT@/Tests/AtlasTests","type":"dir","children":[
       {"name":"SyncServiceTests.swift","path":"@ROOT@/Tests/AtlasTests/SyncServiceTests.swift","type":"file"},
       {"name":"UsageLedgerTests.swift","path":"@ROOT@/Tests/AtlasTests/UsageLedgerTests.swift","type":"file"}]}]},
     {"name":"docs","path":"@ROOT@/docs","type":"dir","children":[
      {"name":"decisions","path":"@ROOT@/docs/decisions","type":"dir","children":[
       {"name":"0001-local-first-storage.md","path":"@ROOT@/docs/decisions/0001-local-first-storage.md","type":"file"}]},
      {"name":"architecture.md","path":"@ROOT@/docs/architecture.md","type":"file"}]},
     {"name":"scripts","path":"@ROOT@/scripts","type":"dir","children":[]},
     {"name":"web","path":"@ROOT@/web","type":"dir","children":[
      {"name":"src","path":"@ROOT@/web/src","type":"dir","children":[
       {"name":"components","path":"@ROOT@/web/src/components","type":"dir","children":[
        {"name":"Header.tsx","path":"@ROOT@/web/src/components/Header.tsx","type":"file"}]},
       {"name":"index.ts","path":"@ROOT@/web/src/index.ts","type":"file"},
       {"name":"router.ts","path":"@ROOT@/web/src/router.ts","type":"file"},
       {"name":"types.ts","path":"@ROOT@/web/src/types.ts","type":"file"}]},
      {"name":"package.json","path":"@ROOT@/web/package.json","type":"file"},
      {"name":"tsconfig.json","path":"@ROOT@/web/tsconfig.json","type":"file"}]},
     {"name":".env.example","path":"@ROOT@/.env.example","type":"file"},
     {"name":".gitignore","path":"@ROOT@/.gitignore","type":"file"},
     {"name":".swiftlint.yml","path":"@ROOT@/.swiftlint.yml","type":"file"},
     {"name":"CHANGELOG.md","path":"@ROOT@/CHANGELOG.md","type":"file"},
     {"name":"Package.swift","path":"@ROOT@/Package.swift","type":"file"},
     {"name":"README.md","path":"@ROOT@/README.md","type":"file"}]}
    """#

    /// Absolute path → trimmed porcelain code. The same map the tree badges read.
    static let fileStatus = #"""
    {"isGit":true,"branch":"feature/usage-ledger","upstream":"origin/feature/usage-ledger","ahead":3,"behind":1,
     "status":{
      "@ROOT@/Sources/App/Services/SyncService.swift":"MM",
      "@ROOT@/Sources/App/Models/Project.swift":"A",
      "@ROOT@/docs/architecture.md":"M",
      "@ROOT@/Tests/AtlasTests/LegacyTests.swift":"D",
      "@ROOT@/Sources/App/Services/ApiClient.swift":"R",
      "@ROOT@/Sources/App/Models/UsageLedger.swift":"M",
      "@ROOT@/web/src/legacy.ts":"D",
      "@ROOT@/web/src/router.ts":"M",
      "@ROOT@/Sources/App/ContentView.swift":"M",
      "@ROOT@/scripts/seed.sh":"??",
      "@ROOT@/.env.local":"??",
      "@ROOT@/notes/todo.md":"??"}}
    """#

    static let swiftSource = """
    import Foundation

    /// Tracks token spend per session and rolls it up by day.
    struct UsageLedger {
        struct Entry: Identifiable {
            let id: UUID
            let day: String
            let costUsd: Double
            let turns: Int
        }

        private(set) var entries: [Entry] = []

        mutating func record(costUsd: Double, turns: Int, on day: String) {
            let entry = Entry(id: UUID(), day: day, costUsd: costUsd, turns: turns)
            entries.append(entry)
            entries.sort { $0.day < $1.day }
        }

        var lifetimeCost: Double {
            entries.reduce(0) { $0 + $1.costUsd }
        }

        func total(for day: String) -> Double {
            entries
                .filter { $0.day == day }
                .reduce(0) { $0 + $1.costUsd }
        }

        func trailing(days: Int) -> [Entry] {
            Array(entries.suffix(days))
        }

        func formatted(_ value: Double) -> String {
            let formatter = NumberFormatter()
            formatter.numberStyle = .currency
            formatter.currencyCode = "USD"
            formatter.maximumFractionDigits = 2
            return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
        }
    }

    extension UsageLedger {
        /// Busiest day by turn count, if any entries exist.
        var busiestDay: String? {
            let byDay = Dictionary(grouping: entries, by: \\.day)
            return byDay
                .mapValues { $0.reduce(0) { $0 + $1.turns } }
                .max { $0.value < $1.value }?
                .key
        }

        func summary() -> String {
            guard let busiest = busiestDay else {
                return "No usage recorded yet."
            }
            let cost = formatted(lifetimeCost)
            return "Lifetime \\(cost), busiest day \\(busiest)."
        }
    }

    """

    /// Any file opens as the same Swift source — the viewer's chrome, gutter and
    /// highlighting are what the snapshot is for, not the file's identity.
    static func fileContent(_ path: String) -> String {
        let body = swiftSource.replacingOccurrences(of: "\\\\", with: "\\")
        let wire: [String: Any] = [
            "path": path, "size": body.utf8.count, "mtime": 1_793_318_400_000.0, "maxSize": 4_194_304,
            "binary": false, "truncated": false, "content": body,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: wire),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    static let search = #"""
    {"truncated":false,"results":[
     {"file":"Sources/App/Models/UsageLedger.swift","matches":[
      {"line":14,"col":18,"text":"    mutating func record(costUsd: Double, turns: Int, on day: String) {"},
      {"line":17,"col":15,"text":"        entries.sort { $0.day < $1.day }"},
      {"line":53,"col":29,"text":"        let byDay = Dictionary(grouping: entries, by: \\.day)"}]},
     {"file":"Sources/App/Services/SyncService.swift","matches":[
      {"line":22,"col":9,"text":"        ledger.record(costUsd: delta.cost, turns: 1, on: delta.day)"},
      {"line":41,"col":13,"text":"            // record the retry so the ledger and the server stay in step"}]},
     {"file":"Tests/AtlasTests/UsageLedgerTests.swift","matches":[
      {"line":9,"col":9,"text":"        ledger.record(costUsd: 0.42, turns: 6, on: \"2026-10-28\")"},
      {"line":10,"col":9,"text":"        ledger.record(costUsd: 1.18, turns: 14, on: \"2026-10-29\")"},
      {"line":18,"col":22,"text":"    func testRecordKeepsEntriesSorted() {"}]},
     {"file":"docs/architecture.md","matches":[
      {"line":31,"col":27,"text":"The ledger is append-only; every call to `record` is one turn."}]}]}
    """#

    // MARK: - Git

    static let gitStatus = #"""
    {"enabled":true,
     "branch":{"oid":"9f3c1a7e5b2d84c06a91f7e3d2b8c4a5e6f70123","name":"feature/usage-ledger","upstream":"origin/feature/usage-ledger","ahead":3,"behind":1},
     "files":[
      {"path":"Sources/App/Services/SyncService.swift","indexStatus":"M","workingStatus":"M","renamedFrom":null,"ordinary":true,"entryType":"ordinary"},
      {"path":"Sources/App/Models/Project.swift","indexStatus":"A","workingStatus":".","renamedFrom":null,"ordinary":true,"entryType":"ordinary"},
      {"path":"docs/architecture.md","indexStatus":"M","workingStatus":".","renamedFrom":null,"ordinary":true,"entryType":"ordinary"},
      {"path":"Tests/AtlasTests/LegacyTests.swift","indexStatus":"D","workingStatus":".","renamedFrom":null,"ordinary":true,"entryType":"ordinary"},
      {"path":"Sources/App/Services/ApiClient.swift","indexStatus":"R","workingStatus":".","renamedFrom":"Sources/App/Services/NetClient.swift","ordinary":false,"entryType":"rename-copy"},
      {"path":"Sources/App/Models/UsageLedger.swift","indexStatus":".","workingStatus":"M","renamedFrom":null,"ordinary":true,"entryType":"ordinary"},
      {"path":"web/src/legacy.ts","indexStatus":".","workingStatus":"D","renamedFrom":null,"ordinary":true,"entryType":"ordinary"},
      {"path":"web/src/router.ts","indexStatus":".","workingStatus":"M","renamedFrom":null,"ordinary":true,"entryType":"ordinary"},
      {"path":"Sources/App/ContentView.swift","indexStatus":".","workingStatus":"M","renamedFrom":null,"ordinary":true,"entryType":"ordinary"},
      {"path":"scripts/seed.sh","indexStatus":".","workingStatus":"?","renamedFrom":null,"ordinary":false,"entryType":"untracked"},
      {"path":".env.local","indexStatus":".","workingStatus":"?","renamedFrom":null,"ordinary":false,"entryType":"untracked"},
      {"path":"notes/todo.md","indexStatus":".","workingStatus":"?","renamedFrom":null,"ordinary":false,"entryType":"untracked"}]}
    """#

    static let gitRepos = #"""
    {"enabled":true,"repos":[
     {"path":"@ROOT@","name":"Atlas","branch":"feature/usage-ledger","head":"9f3c1a7e5b2d84c06a91f7e3d2b8c4a5e6f70123","detached":false,"isCurrent":true,"isMain":true,"dirtyCount":12,"locked":false},
     {"path":"/tmp/demo/Atlas-worktrees/fix-sync-retry","name":"fix-sync-retry","branch":"fix/sync-retry","head":"4d82e6b17c0a93f521e8d4ab63c7f90e15b2a8d4","detached":false,"isCurrent":false,"isMain":false,"dirtyCount":2,"locked":true}]}
    """#

    static let gitBranches = #"""
    {"enabled":true,"current":"feature/usage-ledger","detached":false,
     "locals":[
      {"name":"feature/usage-ledger","isCurrent":true,"upstream":"origin/feature/usage-ledger","ahead":3,"behind":1,"sha":"9f3c1a7","author":"Dana Whitfield","relativeDate":"12 minutes ago","subject":"feat(ledger): add trailing-days summary"},
      {"name":"fix/sync-retry","isCurrent":false,"upstream":null,"ahead":null,"behind":null,"sha":"4d82e6b","author":"Dana Whitfield","relativeDate":"3 hours ago","subject":"fix(sync): retry on 429 with backoff"},
      {"name":"docs/sync-flow","isCurrent":false,"upstream":"origin/docs/sync-flow","ahead":0,"behind":2,"sha":"e5a21d9","author":"Priya Raman","relativeDate":"2 days ago","subject":"docs: describe sync flow"},
      {"name":"main","isCurrent":false,"upstream":"origin/main","ahead":0,"behind":0,"sha":"2be94d0","author":"Priya Raman","relativeDate":"4 days ago","subject":"Merge pull request #41 from atlas/api-client"}],
     "remotes":[
      {"name":"origin/main","sha":"2be94d0","author":"Priya Raman","relativeDate":"4 days ago","subject":"Merge pull request #41 from atlas/api-client"},
      {"name":"origin/feature/usage-ledger","sha":"b0d46f1","author":"Marco Silva","relativeDate":"1 day ago","subject":"chore: bump dependencies"},
      {"name":"origin/docs/sync-flow","sha":"e5a21d9","author":"Priya Raman","relativeDate":"2 days ago","subject":"docs: describe sync flow"}],
     "tags":[
      {"name":"v1.4.0","sha":"17c8b3e","author":"Priya Raman","relativeDate":"3 weeks ago","subject":"feat: project list and active project"},
      {"name":"v1.3.0","sha":"b0d46f1","author":"Priya Raman","relativeDate":"2 months ago","subject":"chore: initial scaffold"}]}
    """#

    static let gitGraph = #"""
    {"enabled":true,"commits":[
     {"sha":"9f3c1a7e5b2d84c06a91f7e3d2b8c4a5e6f70123","shortSha":"9f3c1a7","author":"Dana Whitfield","date":"2026-10-30T09:48:12+00:00","relativeDate":"12 minutes ago","refs":["HEAD","feature/usage-ledger"],"parents":["4d82e6b17c0a93f521e8d4ab63c7f90e15b2a8d4"],"subject":"feat(ledger): add trailing-days summary"},
     {"sha":"4d82e6b17c0a93f521e8d4ab63c7f90e15b2a8d4","shortSha":"4d82e6b","author":"Dana Whitfield","date":"2026-10-30T07:02:40+00:00","relativeDate":"3 hours ago","refs":["fix/sync-retry"],"parents":["c71a05fe38b9d246e10f7a3c85d2b6940af1e7c3"],"subject":"test: cover busiestDay with ties"},
     {"sha":"c71a05fe38b9d246e10f7a3c85d2b6940af1e7c3","shortSha":"c71a05f","author":"Dana Whitfield","date":"2026-10-29T16:20:05+00:00","relativeDate":"18 hours ago","refs":[],"parents":["2be94d07a6f1c3859d0e72b4fa13c68e51d7a029"],"subject":"fix(sync): retry on 429 with backoff"},
     {"sha":"b0d46f12a83e59c76f21d0b8e49a3c7512f8d6a0","shortSha":"b0d46f1","author":"Marco Silva","date":"2026-10-29T10:11:33+00:00","relativeDate":"1 day ago","refs":["origin/feature/usage-ledger"],"parents":["2be94d07a6f1c3859d0e72b4fa13c68e51d7a029"],"subject":"chore: bump dependencies"},
     {"sha":"2be94d07a6f1c3859d0e72b4fa13c68e51d7a029","shortSha":"2be94d0","author":"Priya Raman","date":"2026-10-26T13:45:00+00:00","relativeDate":"4 days ago","refs":["main","origin/main"],"parents":["83f0a6c21e5d97b40c2a8f63d19e4b75a6038fc1","e5a21d98f7036b4c2a8e1d90b45c7f368d02e9a1"],"subject":"Merge pull request #41 from atlas/api-client"},
     {"sha":"83f0a6c21e5d97b40c2a8f63d19e4b75a6038fc1","shortSha":"83f0a6c","author":"Priya Raman","date":"2026-10-25T15:30:21+00:00","relativeDate":"5 days ago","refs":[],"parents":["17c8b3e490fd2a56c4e18b073a95d6f2e8b10c47"],"subject":"refactor(api): rename NetClient to ApiClient"},
     {"sha":"e5a21d98f7036b4c2a8e1d90b45c7f368d02e9a1","shortSha":"e5a21d9","author":"Priya Raman","date":"2026-10-24T11:05:09+00:00","relativeDate":"6 days ago","refs":["origin/docs/sync-flow"],"parents":["17c8b3e490fd2a56c4e18b073a95d6f2e8b10c47"],"subject":"docs: describe sync flow"},
     {"sha":"17c8b3e490fd2a56c4e18b073a95d6f2e8b10c47","shortSha":"17c8b3e","author":"Priya Raman","date":"2026-10-09T09:00:00+00:00","relativeDate":"3 weeks ago","refs":["tag: v1.4.0"],"parents":[],"subject":"feat: project list and active project"}]}
    """#

    static let gitStash = #"""
    {"enabled":true,"entries":[{"ref":"stash@{0}","index":0,"message":"WIP on feature/usage-ledger: 9f3c1a7 add trailing-days summary","relativeDate":"2 hours ago","sha":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"}]}
    """#

    static func gitDiff(path: String, mode: String) -> String {
        let diff = """
        diff --git a/\(path) b/\(path)
        index 3a9c1f2..b84e07d 100644
        --- a/\(path)
        +++ b/\(path)
        @@ -4,7 +4,8 @@ struct UsageLedger {
             struct Entry: Identifiable {
                 let id: UUID
                 let day: String
        -        let costUsd: Double
        +        let costUsd: Decimal
        +        let model: String
                 let turns: Int
             }

        @@ -18,7 +19,9 @@ struct UsageLedger {
             }

             func total(for day: String) -> Double {
        -        entries.filter { $0.day == day }.reduce(0) { $0 + $1.costUsd }
        +        entries
        +            .filter { $0.day == day }
        +            .reduce(0) { $0 + $1.costUsd }
             }

             func trailing(days: Int) -> [Entry] {

        """
        let wire: [String: Any] = ["path": path, "mode": mode, "binary": false, "truncated": false, "diff": diff]
        guard let data = try? JSONSerialization.data(withJSONObject: wire),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    // MARK: - Agent changes (Review Changes)

    static let changes = #"""
    {"files":[
     {"path":"Sources/App/Models/UsageLedger.swift","status":"modified","additions":9,"deletions":3,"firstTurnId":"turn_01","lastTouchedAt":"2026-10-30T09:41:07.220Z"},
     {"path":"Sources/App/Models/Project.swift","status":"added","additions":10,"deletions":0,"firstTurnId":"turn_02","lastTouchedAt":"2026-10-30T09:44:51.004Z"},
     {"path":"web/src/legacy.ts","status":"deleted","additions":0,"deletions":8,"firstTurnId":"turn_03","lastTouchedAt":"2026-10-30T09:46:30.918Z"}]}
    """#

    static func changeDiff(_ path: String) -> String {
        switch path {
        case "Sources/App/Models/Project.swift": return changeDiffAdded
        case "web/src/legacy.ts": return changeDiffDeleted
        default: return changeDiffModified
        }
    }

    static let changeDiffModified = #"""
    {"path":"Sources/App/Models/UsageLedger.swift","status":"modified","hunks":[
     {"index":0,"header":"@@ -4,7 +4,8 @@","lines":[
      {"kind":"context","text":"    struct Entry: Identifiable {"},
      {"kind":"context","text":"        let id: UUID"},
      {"kind":"context","text":"        let day: String"},
      {"kind":"removed","text":"        let costUsd: Double"},
      {"kind":"added","text":"        let costUsd: Decimal"},
      {"kind":"added","text":"        let model: String"},
      {"kind":"context","text":"        let turns: Int"},
      {"kind":"context","text":"    }"},
      {"kind":"context","text":""}]},
     {"index":1,"header":"@@ -18,7 +19,9 @@","lines":[
      {"kind":"context","text":"    }"},
      {"kind":"context","text":""},
      {"kind":"context","text":"    func total(for day: String) -> Double {"},
      {"kind":"removed","text":"        entries.filter { $0.day == day }.reduce(0) { $0 + $1.costUsd }"},
      {"kind":"added","text":"        entries"},
      {"kind":"added","text":"            .filter { $0.day == day }"},
      {"kind":"added","text":"            .reduce(0) { $0 + $1.costUsd }"},
      {"kind":"context","text":"    }"},
      {"kind":"context","text":""},
      {"kind":"context","text":"    func trailing(days: Int) -> [Entry] {"}]},
     {"index":2,"header":"@@ -40,4 +43,7 @@","lines":[
      {"kind":"context","text":"    func summary() -> String {"},
      {"kind":"removed","text":"        \"\\(entries.count) entries\""},
      {"kind":"added","text":"        guard let busiest = busiestDay else {"},
      {"kind":"added","text":"            return \"No usage recorded yet.\""},
      {"kind":"added","text":"        }"},
      {"kind":"added","text":"        return \"Lifetime \\(formatted(lifetimeCost)), busiest day \\(busiest).\""},
      {"kind":"context","text":"    }"},
      {"kind":"context","text":"}"}]}]}
    """#

    static let changeDiffAdded = #"""
    {"path":"Sources/App/Models/Project.swift","status":"added","hunks":[
     {"index":0,"header":"@@ -0,0 +1,10 @@","lines":[
      {"kind":"added","text":"import Foundation"},
      {"kind":"added","text":""},
      {"kind":"added","text":"/// A registered workspace."},
      {"kind":"added","text":"struct Project: Identifiable, Equatable {"},
      {"kind":"added","text":"    let id: String"},
      {"kind":"added","text":"    let name: String"},
      {"kind":"added","text":"    let workDir: String"},
      {"kind":"added","text":""},
      {"kind":"added","text":"    var displayName: String { name.isEmpty ? workDir : name }"},
      {"kind":"added","text":"}"}]}]}
    """#

    static let changeDiffDeleted = #"""
    {"path":"web/src/legacy.ts","status":"deleted","hunks":[
     {"index":0,"header":"@@ -1,8 +0,0 @@","lines":[
      {"kind":"removed","text":"export function legacyRoute(path: string) {"},
      {"kind":"removed","text":"  const parts = path.split(\"/\");"},
      {"kind":"removed","text":"  if (parts[0] === \"v1\") {"},
      {"kind":"removed","text":"    return parts.slice(1).join(\"/\");"},
      {"kind":"removed","text":"  }"},
      {"kind":"removed","text":"  return path;"},
      {"kind":"removed","text":"}"},
      {"kind":"removed","text":"export const LEGACY_PREFIX = \"v1\";"}]}]}
    """#

    // MARK: - Graph pane

    /// A self-contained page, as the real route serves: graphify's graph.html.
    /// Neutral stand-in drawn with inline SVG — no script, no network.
    static let graphHTML = """
    <!doctype html><meta charset="utf-8"><body style="margin:0;background:#161a22;font:12px -apple-system,sans-serif;color:#c9d1d9">
    <svg width="100%" height="100%" viewBox="0 0 600 420" preserveAspectRatio="xMidYMid meet">
    <g stroke="#3b4658" stroke-width="1.2">
    <line x1="300" y1="210" x2="170" y2="120"/><line x1="300" y1="210" x2="440" y2="110"/><line x1="300" y1="210" x2="470" y2="260"/>
    <line x1="300" y1="210" x2="190" y2="310"/><line x1="170" y1="120" x2="90" y2="190"/><line x1="440" y1="110" x2="520" y2="170"/>
    <line x1="190" y1="310" x2="260" y2="370"/></g>
    <g fill="#5b8def"><circle cx="300" cy="210" r="16"/><circle cx="170" cy="120" r="10"/><circle cx="440" cy="110" r="11"/></g>
    <g fill="#e0a64a"><circle cx="470" cy="260" r="9"/><circle cx="520" cy="170" r="6"/></g>
    <g fill="#5fb88a"><circle cx="190" cy="310" r="10"/><circle cx="90" cy="190" r="6"/><circle cx="260" cy="370" r="6"/></g>
    <g fill="#c9d1d9"><text x="318" y="205">SyncService</text><text x="120" y="108">UsageLedger</text><text x="452" y="98">ApiClient</text></g>
    </svg>
    """
}
