// DiagnosticsService — what fills the Problems panel.
//
// ## Why this was rewritten (2026-08-31)
//
// User: *"diagnostics doesn't seem to be doing anything."* It wasn't. The
// previous version looked for `tsconfig.json`, `Package.swift` or
// `.eslintrc*` **in the repo root only**, and returned `[]` for anything
// else. On a normal monorepo — TypeScript under `apps/web/`, Java under
// `apps/api/` — nothing matched, so it ran no tool at all and the panel
// rendered "No problems detected", which is exactly what a clean build
// looks like. The button was not broken; the search was.
//
// Two structural changes:
//
//   1. **Discovery walks the tree**, bounded and ignore-aware, and returns
//      EVERY sub-project it finds. A monorepo gets one runner per module,
//      not one runner for the whole repo.
//   2. **Runners are values**, not a hardcoded if-chain, so adding a
//      toolchain is a row in `Toolchain.all` plus a parser.
//
// ## Fast vs slow
//
// A `tsc --noEmit` or an `eslint` pass is seconds. `mvn compile`,
// `cargo check` and `swift build` are minutes and can hit the network.
// Fast runners fire automatically on project switch; slow ones run only
// when the user explicitly asks (the panel's Run button). That is the same
// split VS Code makes between a language server (live) and a build task
// (on demand) — we just don't have the language server half yet.
//
// ## What this is NOT
//
// It is not an LSP client. VS Code / Cursor / Antigravity get diagnostics
// pushed per keystroke by language servers; this shells out to a CLI and
// parses stdout, so results are as fresh as the last run. Live push needs
// a real LSP client and its own ADR.

import Foundation

// MARK: - Model

struct DiagnosticItem: Identifiable, Equatable {
    let id = UUID()
    let severity: Severity
    let message: String
    /// Absolute path where we could resolve one.
    let filePath: String
    let line: Int
    let col: Int
    /// Which tool produced this — shown as a chip, and the honest answer
    /// to "why does the panel disagree with my terminal".
    let source: String

    enum Severity: String, CaseIterable {
        case error, warning, info, hint

        var rank: Int {
            switch self {
            case .error: return 0
            case .warning: return 1
            case .info: return 2
            case .hint: return 3
            }
        }
    }

    var displayPath: String { (filePath as NSString).lastPathComponent }

    static func == (a: DiagnosticItem, b: DiagnosticItem) -> Bool {
        a.severity == b.severity && a.message == b.message
            && a.filePath == b.filePath && a.line == b.line
            && a.col == b.col && a.source == b.source
    }
}

// MARK: - Toolchains

/// One diagnostic producer: how to recognise a project, what to run, and
/// how to read the output.
struct Toolchain {
    let id: String
    /// Filenames whose presence in a directory means "this is one of mine".
    let markers: [String]
    /// Executable to look for. Resolved against `node_modules/.bin` first.
    let command: String
    /// Argv, given the project directory.
    let args: (String) -> [String]
    let timeout: TimeInterval
    /// Slow enough that it must not fire on its own.
    let isSlow: Bool
    let parse: (String, String) -> [DiagnosticItem]

    static let all: [Toolchain] = [
        Toolchain(
            id: "tsc",
            markers: ["tsconfig.json"],
            command: "tsc",
            args: { _ in ["--noEmit", "--pretty", "false"] },
            timeout: 90, isSlow: false,
            parse: DiagnosticParsers.tsc
        ),
        Toolchain(
            id: "eslint",
            // Flat config (`eslint.config.*`, the default since ESLint 9)
            // was missing entirely — only the legacy `.eslintrc*` names
            // were checked, which is half the reason this found nothing.
            markers: [
                "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
                "eslint.config.ts", ".eslintrc", ".eslintrc.js",
                ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml",
                ".eslintrc.yaml",
            ],
            command: "eslint",
            args: { _ in [".", "--format", "compact", "--max-warnings", "500"] },
            timeout: 90, isSlow: false,
            parse: DiagnosticParsers.eslintCompact
        ),
        Toolchain(
            id: "biome",
            markers: ["biome.json", "biome.jsonc"],
            command: "biome",
            args: { _ in ["check", "--reporter=gitlab", "."] },
            timeout: 60, isSlow: false,
            parse: DiagnosticParsers.biomeGitLab
        ),
        Toolchain(
            id: "ruff",
            markers: ["ruff.toml", ".ruff.toml"],
            command: "ruff",
            args: { _ in ["check", "--output-format", "concise", "."] },
            timeout: 60, isSlow: false,
            parse: DiagnosticParsers.gccStyle
        ),
        Toolchain(
            id: "go vet",
            markers: ["go.mod"],
            command: "go",
            args: { _ in ["vet", "./..."] },
            timeout: 120, isSlow: true,
            parse: DiagnosticParsers.gccStyle
        ),
        Toolchain(
            id: "cargo",
            markers: ["Cargo.toml"],
            command: "cargo",
            args: { _ in ["check", "--message-format", "short"] },
            timeout: 300, isSlow: true,
            parse: DiagnosticParsers.gccStyle
        ),
        Toolchain(
            id: "swift build",
            markers: ["Package.swift"],
            command: "swift",
            args: { _ in ["build", "--quiet"] },
            timeout: 300, isSlow: true,
            parse: DiagnosticParsers.gccStyle
        ),
        Toolchain(
            id: "maven",
            markers: ["pom.xml"],
            command: "mvn",
            // `-o` (offline) deliberately NOT set: a first compile may
            // legitimately need to resolve. `-q` keeps stdout to the
            // `[ERROR]` lines the parser wants.
            args: { _ in ["-q", "-DskipTests", "compile"] },
            timeout: 600, isSlow: true,
            parse: DiagnosticParsers.maven
        ),
    ]
}

/// A resolved unit of work: one toolchain in one directory.
struct DiagnosticRunner: Identifiable {
    let toolchain: Toolchain
    let directory: String
    var id: String { "\(toolchain.id)@\(directory)" }
}

// MARK: - Service

@MainActor
@Observable
final class DiagnosticsService {
    static let shared = DiagnosticsService()

    /// Nil until the first run finishes. Distinguishing "never ran" from
    /// "ran and found nothing" is the whole reason the old panel read as
    /// broken — both rendered the same clean checkmark.
    private(set) var lastRunAt: Date? = nil
    private(set) var isRunning = false
    /// Runner ids currently executing — the panel names them, so a 90 s
    /// `tsc` looks like work rather than a dead button.
    private(set) var activeRunners: [String] = []
    /// What discovery found, whether or not it ran.
    private(set) var discovered: [DiagnosticRunner] = []
    /// Set when discovery found nothing at all to run.
    private(set) var noToolchainFound = false

    private var runTask: Task<Void, Never>? = nil

    /// Fast toolchains only. Safe to call on project switch and after a turn.
    func refresh(workDir: String) {
        start(workDir: workDir, includeSlow: false, debounce: true)
    }

    /// Everything, including the minute-scale builds. The panel's Run button.
    func runAll(workDir: String) {
        start(workDir: workDir, includeSlow: true, debounce: false)
    }

    func cancel() {
        runTask?.cancel()
        runTask = nil
        isRunning = false
        activeRunners = []
    }

    private func start(workDir: String, includeSlow: Bool, debounce: Bool) {
        runTask?.cancel()
        isRunning = true
        activeRunners = []
        runTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.isRunning = false
                self.activeRunners = []
            }
            if debounce {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled else { return }
            }

            let found = await Task.detached(priority: .userInitiated) {
                DiagnosticDiscovery.runners(in: workDir)
            }.value
            guard !Task.isCancelled else { return }
            self.discovered = found
            self.noToolchainFound = found.isEmpty

            let selected = found.filter { includeSlow || !$0.toolchain.isSlow }
            self.activeRunners = selected.map(\.id)
            guard !selected.isEmpty else {
                MarvinBridge.shared.applyDiagnostics([])
                self.lastRunAt = Date()
                return
            }

            // Runners are independent processes over disjoint directories,
            // so they go concurrently — serialising a 90 s tsc behind a
            // 90 s eslint doubles the wait for no benefit.
            let items = await withTaskGroup(of: [DiagnosticItem].self) { group in
                for runner in selected {
                    group.addTask(priority: .userInitiated) {
                        DiagnosticsService.execute(runner)
                    }
                }
                var all: [DiagnosticItem] = []
                for await chunk in group { all.append(contentsOf: chunk) }
                return all
            }
            guard !Task.isCancelled else { return }

            MarvinBridge.shared.applyDiagnostics(Self.dedupeAndSort(items))
            self.lastRunAt = Date()
        }
    }

    /// Stable order: errors first, then by file, then by line. Duplicates
    /// happen for real — `tsc` and `eslint` both report an unused import —
    /// and two identical rows in the list is noise, not information.
    static func dedupeAndSort(_ items: [DiagnosticItem]) -> [DiagnosticItem] {
        var seen = Set<String>()
        var out: [DiagnosticItem] = []
        for item in items {
            let key = "\(item.severity.rawValue)|\(item.filePath)|\(item.line)|\(item.col)|\(item.message)"
            if seen.insert(key).inserted { out.append(item) }
        }
        return out.sorted {
            if $0.severity.rank != $1.severity.rank { return $0.severity.rank < $1.severity.rank }
            if $0.filePath != $1.filePath { return $0.filePath < $1.filePath }
            if $0.line != $1.line { return $0.line < $1.line }
            return $0.col < $1.col
        }
    }

    private nonisolated static func execute(_ runner: DiagnosticRunner) -> [DiagnosticItem] {
        let tc = runner.toolchain
        guard let exec = ToolLocator.locate(tc.command, workDir: runner.directory) else {
            return [ToolLocator.missing(tc.command, in: runner.directory, source: tc.id)]
        }
        let out = Shell.run(
            exec, args: tc.args(runner.directory),
            cwd: runner.directory, timeout: tc.timeout
        )
        return tc.parse(out ?? "", runner.directory)
    }
}

// MARK: - Discovery

enum DiagnosticDiscovery {
    /// Directories that never contain a project we should lint. Walking into
    /// `node_modules` would find thousands of `tsconfig.json` files and try
    /// to type-check every dependency.
    static let skip: Set<String> = [
        "node_modules", ".git", "dist", "build", "out", "target", ".next",
        ".build", "vendor", "graphify-out", "DerivedData", "coverage",
        "test-results", "playwright-report", ".venv", "venv", "__pycache__",
        ".gradle", ".idea", ".turbo", "logs",
    ]

    /// Depth below the repo root to search. 3 covers `apps/web`,
    /// `packages/*/`, `services/*/` — the shapes monorepos actually use —
    /// without turning discovery into a full-tree walk.
    static let maxDepth = 3

    static func runners(in root: String) -> [DiagnosticRunner] {
        var out: [DiagnosticRunner] = []
        // A toolchain claims the SHALLOWEST directory that matches. A Maven
        // reactor has a pom.xml in every module; running the parent builds
        // them all, so claiming each module would run the same build N times.
        var claimed: [String: String] = [:]   // toolchain id → directory

        for dir in directories(root: root) {
            for tc in Toolchain.all {
                guard claimed[tc.id] == nil else { continue }
                let hit = tc.markers.contains {
                    FileManager.default.fileExists(atPath: dir + "/" + $0)
                }
                if hit {
                    claimed[tc.id] = dir
                    out.append(DiagnosticRunner(toolchain: tc, directory: dir))
                }
            }
        }
        return out
    }

    /// Breadth-first so shallower directories are visited first — which is
    /// what makes "shallowest wins" above true.
    ///
    /// Internal, not private: `BuildTaskService` walks the same tree looking
    /// for build systems, and two independent walks would eventually disagree
    /// about what counts as a sub-project or what to skip.
    static func directories(root: String) -> [String] {
        let fm = FileManager.default
        var result = [root]
        var frontier = [root]
        for _ in 0..<maxDepth {
            var next: [String] = []
            for dir in frontier {
                guard let kids = try? fm.contentsOfDirectory(atPath: dir) else { continue }
                for kid in kids.sorted() {
                    if kid.hasPrefix(".") && !kid.hasPrefix(".claude") { continue }
                    if skip.contains(kid) { continue }
                    var isDir: ObjCBool = false
                    let path = dir + "/" + kid
                    guard fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue
                    else { continue }
                    next.append(path)
                }
            }
            result.append(contentsOf: next)
            frontier = next
            if frontier.isEmpty { break }
        }
        return result
    }
}

// MARK: - Tool location

enum ToolLocator {
    /// Locate a project tool, in the order a developer would expect.
    ///
    /// `which` alone is not enough, for two compounding reasons. A
    /// Finder-launched app inherits the minimal launchd PATH
    /// (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew and node tooling are
    /// invisible to it — the same class of problem `enrichedToolPath()`
    /// solves on the sidecar. And a TypeScript project almost never
    /// installs `tsc` globally: it lives in `node_modules/.bin`.
    static func locate(_ cmd: String, workDir: String) -> String? {
        let fm = FileManager.default
        // Project-local wrappers first — `./mvnw` and `./gradlew` exist
        // precisely so the project is built with its own pinned version.
        for wrapper in wrappers(for: cmd) {
            let p = workDir + "/" + wrapper
            if fm.isExecutableFile(atPath: p) { return p }
        }
        let local = workDir + "/node_modules/.bin/" + cmd
        if fm.isExecutableFile(atPath: local) { return local }
        for dir in [
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
            NSHomeDirectory() + "/.local/bin",
            NSHomeDirectory() + "/.cargo/bin",
            NSHomeDirectory() + "/go/bin",
        ] {
            let p = dir + "/" + cmd
            if fm.isExecutableFile(atPath: p) { return p }
        }
        return which(cmd)
    }

    private static func wrappers(for cmd: String) -> [String] {
        switch cmd {
        case "mvn": return ["mvnw"]
        case "gradle": return ["gradlew"]
        default: return []
        }
    }

    /// A tool we needed and could not find, surfaced AS a diagnostic.
    ///
    /// Returning `[]` for "no tool" is indistinguishable from "no problems",
    /// which is how this failed silently. The panel is the right place to
    /// say so: it is the thing the user is looking at when they wonder why
    /// nothing happened.
    static func missing(_ cmd: String, in dir: String, source: String) -> DiagnosticItem {
        DiagnosticItem(
            severity: .warning,
            message: "\(cmd) not found — looked in the project's own wrapper, "
                + "node_modules/.bin, Homebrew and PATH. Install it to get "
                + "\(source) diagnostics here.",
            filePath: dir,
            line: 0, col: 0,
            source: source
        )
    }

    private static func which(_ cmd: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        p.arguments = [cmd]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        try? p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return out?.isEmpty == false ? out : nil
    }
}

// MARK: - Shell

enum Shell {
    static func run(
        _ exec: String, args: [String], cwd: String, timeout: TimeInterval
    ) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exec)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        var env = ProcessInfo.processInfo.environment
        // A Finder launch has the bare launchd PATH; a tool that shells out
        // to another tool (eslint → node, mvnw → java) needs the real one.
        let extra = "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/.local/bin"
        env["PATH"] = extra + ":" + (env["PATH"] ?? "/usr/bin:/bin")
        // Stable, parseable English regardless of the user's locale.
        env["LC_ALL"] = "C"
        p.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        do { try p.run() } catch { return nil }

        // Read CONCURRENTLY with waiting. The previous version slept until
        // the deadline and only then drained the pipes — a tool emitting
        // more than the 64 KB pipe buffer blocks forever writing into a
        // pipe nobody is reading, and gets killed at the timeout with its
        // output truncated. `tsc` on a large project clears 64 KB easily.
        var outData = Data()
        var errData = Data()
        let lock = NSLock()
        outPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            guard !d.isEmpty else { return }
            lock.lock(); outData.append(d); lock.unlock()
        }
        errPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            guard !d.isEmpty else { return }
            lock.lock(); errData.append(d); lock.unlock()
        }

        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        if p.isRunning { p.terminate(); Thread.sleep(forTimeInterval: 0.3) }
        outPipe.fileHandleForReading.readabilityHandler = nil
        errPipe.fileHandleForReading.readabilityHandler = nil

        lock.lock(); defer { lock.unlock() }
        let out = String(data: outData, encoding: .utf8) ?? ""
        let err = String(data: errData, encoding: .utf8) ?? ""
        return out + "\n" + err
    }
}

// MARK: - Parsers

enum DiagnosticParsers {
    /// `path(line,col): error TS1234: message`
    static func tsc(_ output: String, _ dir: String) -> [DiagnosticItem] {
        match(
            output,
            #"^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+TS\d+:\s*(.+)$"#,
            source: "tsc"
        ) { g in
            DiagnosticItem(
                severity: g(4) == "error" ? .error : .warning,
                message: g(5), filePath: absolute(g(1), in: dir),
                line: Int(g(2)) ?? 0, col: Int(g(3)) ?? 0, source: "tsc"
            )
        }
    }

    /// `/abs/path: line N, col M, Error - message (rule)`
    static func eslintCompact(_ output: String, _ dir: String) -> [DiagnosticItem] {
        match(
            output,
            #"^(.+):\s*line (\d+),\s*col (\d+),\s*(Error|Warning)\s*-\s*(.+?)(?:\s*\(.+\))?$"#,
            source: "eslint"
        ) { g in
            DiagnosticItem(
                severity: g(4) == "Error" ? .error : .warning,
                message: g(5), filePath: absolute(g(1), in: dir),
                line: Int(g(2)) ?? 0, col: Int(g(3)) ?? 0, source: "eslint"
            )
        }
    }

    /// `[ERROR] /abs/File.java:[12,34] message` — Maven's compiler plugin.
    static func maven(_ output: String, _ dir: String) -> [DiagnosticItem] {
        match(
            output,
            #"^\[(ERROR|WARNING)\]\s+(.+?):\[(\d+),(\d+)\]\s*(.+)$"#,
            source: "maven"
        ) { g in
            DiagnosticItem(
                severity: g(1) == "ERROR" ? .error : .warning,
                message: g(5), filePath: absolute(g(2), in: dir),
                line: Int(g(3)) ?? 0, col: Int(g(4)) ?? 0, source: "maven"
            )
        }
    }

    /// Biome's GitLab reporter is line-delimited JSON-ish; fall back to the
    /// gcc shape it also emits for its human output.
    static func biomeGitLab(_ output: String, _ dir: String) -> [DiagnosticItem] {
        gccStyle(output, dir).map {
            DiagnosticItem(
                severity: $0.severity, message: $0.message,
                filePath: $0.filePath, line: $0.line, col: $0.col,
                source: "biome"
            )
        }
    }

    /// `file:line:col: severity: message` — swiftc, go vet, cargo short,
    /// ruff concise and most unix compilers. `severity:` is optional; when
    /// absent the entry is an error, which is what those tools mean.
    static func gccStyle(_ output: String, _ dir: String) -> [DiagnosticItem] {
        match(
            output,
            #"^(.+?):(\d+):(\d+):\s*(?:(error|warning|note)(?:\[[^\]]+\])?:\s*)?(.+)$"#,
            source: "build"
        ) { g in
            let sev: DiagnosticItem.Severity
            switch g(4) {
            case "warning": sev = .warning
            case "note": sev = .info
            default: sev = .error
            }
            return DiagnosticItem(
                severity: sev, message: g(5), filePath: absolute(g(1), in: dir),
                line: Int(g(2)) ?? 0, col: Int(g(3)) ?? 0, source: "build"
            )
        }
    }

    // MARK: helpers

    private static func match(
        _ output: String, _ pattern: String, source: String,
        _ build: ((Int) -> String) -> DiagnosticItem?
    ) -> [DiagnosticItem] {
        guard let re = try? NSRegularExpression(
            pattern: pattern, options: .anchorsMatchLines
        ) else { return [] }
        var items: [DiagnosticItem] = []
        for raw in output.split(separator: "\n") {
            let line = String(raw).trimmingCharacters(in: .whitespaces)
            guard let m = re.firstMatch(
                in: line, range: NSRange(line.startIndex..., in: line)
            ) else { continue }
            func g(_ i: Int) -> String {
                guard i < m.numberOfRanges,
                      let r = Range(m.range(at: i), in: line) else { return "" }
                return String(line[r])
            }
            if let item = build(g) { items.append(item) }
        }
        return items
    }

    private static func absolute(_ path: String, in dir: String) -> String {
        path.hasPrefix("/") ? path : dir + "/" + path
    }
}
