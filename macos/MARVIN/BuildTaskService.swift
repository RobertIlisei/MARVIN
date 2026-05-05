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
    }
    let id = UUID()
    let name: String
    let command: String
    let kind: Kind
    let description: String?

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
        }
    }
}

struct BuildTaskService {
    static func discover(workDir: String) -> [BuildTask] {
        var tasks: [BuildTask] = []
        tasks += fromPackageJSON(workDir: workDir)
        tasks += fromMakefile(workDir: workDir)
        tasks += fromPackageSwift(workDir: workDir)
        tasks += fromCargoToml(workDir: workDir)
        return tasks
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
