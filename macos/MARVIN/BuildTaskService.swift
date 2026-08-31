// BuildTaskService — M7. Discovers runnable tasks from:
//   • package.json → "scripts" keys (npm run <name>)
//   • Makefile     → non-private targets (make <target>)
//   • Package.swift → executable targets (swift run <name>)
//   • Cargo.toml   → [package.metadata.scripts] (cargo run --bin <name>)
//
// All discovery is synchronous and cheap (reads a handful of files).
// Tasks are sorted: user-facing scripts first, build/test next, misc last.

import Foundation

struct BuildTask: Identifiable, Hashable {
    enum Kind: String {
        case npm, yarn, pnpm, make, swift, cargo, shell
        // Golden Rule 6 — MARVIN ships no stack assumptions. The task list has
        // to work for whatever the user opened: a Maven monolith, a Go module,
        // a Python package, a Gradle build. Adding a build system here is a
        // parser plus a row in `discover`; nothing about the UI is per-language.
        case maven, gradle, go, python
    }
    let id = UUID()
    let name: String
    let command: String
    let kind: Kind
    let description: String?
    /// Where the task runs. A monorepo's `apps/web: build` must run in
    /// `apps/web`, not at the repo root — running npm from the wrong
    /// directory is the classic "task does nothing" report.
    var directory: String? = nil

    var displayLabel: String { name }
    var kindLabel: String {
        switch kind {
        case .npm:   return "npm"
        case .yarn:  return "yarn"
        case .pnpm:  return "pnpm"
        case .make:  return "make"
        case .swift: return "swift"
        case .cargo: return "cargo"
        case .shell: return "shell"
        case .maven: return "maven"
        case .gradle: return "gradle"
        case .go: return "go"
        case .python: return "python"
        }
    }
}

struct BuildTaskService {
    /// Every build system found in the project, root first.
    ///
    /// Walks sub-projects rather than checking only the root: a monorepo puts
    /// its web app in `apps/web/` and its service in `apps/api/`, and a
    /// root-only scan finds neither (the exact bug the Problems panel had —
    /// see `DiagnosticDiscovery`). Reuses that same bounded, ignore-aware walk
    /// so the two surfaces cannot disagree about what a project contains.
    static func discover(workDir: String) -> [BuildTask] {
        var tasks: [BuildTask] = []
        var seen = Set<String>()
        for dir in DiagnosticDiscovery.directories(root: workDir) {
            let rel = dir == workDir
                ? ""
                : String(dir.dropFirst(workDir.count).drop(while: { $0 == "/" }))
            for var t in tasksIn(dir: dir) {
                // Same-named script in two modules is two different tasks —
                // `apps/web: build` and `apps/api: build` must both survive.
                if !rel.isEmpty {
                    t = BuildTask(name: "\(rel): \(t.name)", command: t.command,
                                  kind: t.kind, description: t.description,
                                  directory: dir)
                }
                if seen.insert("\(t.kind.rawValue)|\(t.name)").inserted { tasks.append(t) }
            }
        }
        return tasks
    }

    private static func tasksIn(dir: String) -> [BuildTask] {
        var tasks: [BuildTask] = []
        tasks += fromPackageJSON(workDir: dir)
        tasks += fromMakefile(workDir: dir)
        tasks += fromPackageSwift(workDir: dir)
        tasks += fromCargoToml(workDir: dir)
        tasks += fromMaven(workDir: dir)
        tasks += fromGradle(workDir: dir)
        tasks += fromGoMod(workDir: dir)
        tasks += fromPython(workDir: dir)
        return tasks
    }

    // MARK: - Maven / Gradle / Go / Python
    //
    // These four are LIFECYCLE systems, not script registries: the useful
    // entries are the phases the tool defines, not names someone wrote in a
    // config file. So the task list is the lifecycle, and the wrapper script
    // is preferred over a global binary because that is the version the
    // project pins.

    private static func fromMaven(workDir: String) -> [BuildTask] {
        let fm = FileManager.default
        guard fm.fileExists(atPath: workDir + "/pom.xml") else { return [] }
        let exe = fm.isExecutableFile(atPath: workDir + "/mvnw") ? "./mvnw" : "mvn"
        return [
            ("clean", "remove target/"),
            ("compile", "compile sources"),
            ("test", "run tests"),
            ("package", "build the artifact"),
            ("verify", "run checks + integration tests"),
            ("install", "install to the local repository"),
        ].map { phase, why in
            BuildTask(name: phase, command: "\(exe) \(phase)", kind: .maven,
                      description: why, directory: workDir)
        }
    }

    private static func fromGradle(workDir: String) -> [BuildTask] {
        let fm = FileManager.default
        let hasBuild = ["build.gradle", "build.gradle.kts"].contains {
            fm.fileExists(atPath: workDir + "/" + $0)
        }
        guard hasBuild else { return [] }
        let exe = fm.isExecutableFile(atPath: workDir + "/gradlew") ? "./gradlew" : "gradle"
        return [
            ("build", "assemble and test"),
            ("assemble", "assemble without testing"),
            ("test", "run tests"),
            ("clean", "delete build output"),
            ("tasks", "list every available task"),
        ].map { name, why in
            BuildTask(name: name, command: "\(exe) \(name)", kind: .gradle,
                      description: why, directory: workDir)
        }
    }

    private static func fromGoMod(workDir: String) -> [BuildTask] {
        guard FileManager.default.fileExists(atPath: workDir + "/go.mod") else { return [] }
        return [
            ("build", "go build ./...", "compile every package"),
            ("test", "go test ./...", "run tests"),
            ("vet", "go vet ./...", "report suspicious constructs"),
            ("tidy", "go mod tidy", "prune and add module requirements"),
        ].map { name, cmd, why in
            BuildTask(name: name, command: cmd, kind: .go, description: why, directory: workDir)
        }
    }

    private static func fromPython(workDir: String) -> [BuildTask] {
        let fm = FileManager.default
        // `pyproject.toml` is the modern marker; the runner is whichever
        // manager the project actually uses, detected by its lock file.
        guard fm.fileExists(atPath: workDir + "/pyproject.toml") else { return [] }
        let runner: String
        if fm.fileExists(atPath: workDir + "/uv.lock") { runner = "uv run" }
        else if fm.fileExists(atPath: workDir + "/poetry.lock") { runner = "poetry run" }
        else { runner = "python -m" }
        return [
            ("test", "\(runner) pytest", "run tests"),
            ("lint", "\(runner) ruff check .", "lint"),
            ("format", "\(runner) ruff format .", "format"),
        ].map { name, cmd, why in
            BuildTask(name: name, command: cmd, kind: .python, description: why, directory: workDir)
        }
    }

    // MARK: - package.json

    private static func fromPackageJSON(workDir: String) -> [BuildTask] {
        let path = workDir + "/package.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let scripts = json["scripts"] as? [String: String] else { return [] }

        // Detect package manager from lockfile.
        let fm = FileManager.default
        let runner: BuildTask.Kind = fm.fileExists(atPath: workDir + "/pnpm-lock.yaml") ? .pnpm
            : fm.fileExists(atPath: workDir + "/yarn.lock") ? .yarn
            : .npm
        let prefix: String
        switch runner {
        case .pnpm: prefix = "pnpm run"
        case .yarn: prefix = "yarn"
        default:    prefix = "npm run"
        }

        return scripts.sorted(by: { priorityOrder($0.key) < priorityOrder($1.key) }).map { name, cmd in
            BuildTask(name: name, command: "\(prefix) \(name)", kind: runner, description: cmd)
        }
    }

    // MARK: - Makefile

    private static func fromMakefile(workDir: String) -> [BuildTask] {
        for name in ["Makefile", "makefile", "GNUmakefile"] {
            let path = workDir + "/" + name
            guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
            var targets: [String] = []
            for line in text.split(separator: "\n") {
                let s = String(line)
                // Standard target: starts at column 0, ends with :, not a variable assign
                guard s.first?.isLetter == true || s.first == "_",
                      let colonIdx = s.firstIndex(of: ":"),
                      colonIdx != s.startIndex,
                      !s.contains("=") else { continue }
                let target = String(s[..<colonIdx]).trimmingCharacters(in: .whitespaces)
                // Skip .PHONY and internal targets starting with .
                guard !target.hasPrefix("."), !target.isEmpty,
                      !target.contains(" "), !target.contains("$") else { continue }
                targets.append(target)
            }
            return targets.prefix(30).map { t in
                BuildTask(name: t, command: "make \(t)", kind: .make, description: nil)
            }
        }
        return []
    }

    // MARK: - Package.swift (Swift executables)

    private static func fromPackageSwift(workDir: String) -> [BuildTask] {
        let path = workDir + "/Package.swift"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
        // Heuristic: .executable targets declared in Package.swift
        var names: [String] = []
        let re = try? NSRegularExpression(pattern: #"\.executableTarget\s*\(\s*name:\s*"([^"]+)""#)
        let range = NSRange(text.startIndex..., in: text)
        re?.enumerateMatches(in: text, range: range) { match, _, _ in
            if let r = match?.range(at: 1), let swiftRange = Range(r, in: text) {
                names.append(String(text[swiftRange]))
            }
        }
        // Also add generic build / test tasks
        var tasks: [BuildTask] = [
            BuildTask(name: "build", command: "swift build", kind: .swift, description: "swift build"),
            BuildTask(name: "test",  command: "swift test",  kind: .swift, description: "swift test"),
        ]
        tasks += names.map { n in
            BuildTask(name: "run \(n)", command: "swift run \(n)", kind: .swift, description: nil)
        }
        return tasks
    }

    // MARK: - Cargo.toml

    private static func fromCargoToml(workDir: String) -> [BuildTask] {
        let path = workDir + "/Cargo.toml"
        guard FileManager.default.fileExists(atPath: path) else { return [] }
        return [
            BuildTask(name: "build",      command: "cargo build",       kind: .cargo, description: nil),
            BuildTask(name: "build release", command: "cargo build --release", kind: .cargo, description: nil),
            BuildTask(name: "test",       command: "cargo test",        kind: .cargo, description: nil),
            BuildTask(name: "run",        command: "cargo run",         kind: .cargo, description: nil),
            BuildTask(name: "clippy",     command: "cargo clippy",      kind: .cargo, description: nil),
            BuildTask(name: "fmt",        command: "cargo fmt",         kind: .cargo, description: nil),
        ]
    }

    // MARK: - Priority ordering for npm scripts

    private static let orderedFirst = ["dev", "start", "build", "test", "lint", "format", "clean", "deploy"]

    private static func priorityOrder(_ name: String) -> Int {
        if let i = orderedFirst.firstIndex(of: name) { return i }
        return orderedFirst.count
    }
}
