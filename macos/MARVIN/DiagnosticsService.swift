// DiagnosticsService — M8. Runs project-appropriate linters and
// populates MarvinBridge.diagnosticItems (and errorCount/warningCount).
//
// Strategy: detect what's available in the project, pick one tool:
//   1. tsc (TypeScript)  → tsc --noEmit
//   2. eslint            → eslint . --format compact
//   3. swiftc            → swift build (for Swift projects)
//
// Runs asynchronously on a background thread. Results are pushed to
// the bridge on the main actor. Debounced via a shared Task that's
// cancelled on re-trigger.

import Foundation

// MARK: - Model

struct DiagnosticItem: Identifiable {
    let id = UUID()
    let severity: Severity
    let message: String
    let filePath: String    // absolute or relative
    let line: Int
    let col: Int

    enum Severity: String {
        case error, warning, info, hint
    }

    var displayPath: String {
        (filePath as NSString).lastPathComponent
    }
}

// MARK: - Service

@MainActor
final class DiagnosticsService {
    static let shared = DiagnosticsService()

    private var runTask: Task<Void, Never>? = nil

    func refresh(workDir: String) {
        runTask?.cancel()
        runTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: 500_000_000)  // 500 ms debounce
            guard !Task.isCancelled else { return }
            let items = await run(workDir: workDir)
            guard !Task.isCancelled else { return }
            MarvinBridge.shared.applyDiagnostics(items)
        }
    }

    private func run(workDir: String) async -> [DiagnosticItem] {
        return await Task.detached(priority: .background) {
            Self.detectAndRun(workDir: workDir)
        }.value
    }

    private static nonisolated func detectAndRun(workDir: String) -> [DiagnosticItem] {
        let fm = FileManager.default
        // TypeScript project?
        if fm.fileExists(atPath: workDir + "/tsconfig.json") {
            return runTSC(workDir: workDir)
        }
        // Swift project?
        if fm.fileExists(atPath: workDir + "/Package.swift") {
            return runSwiftBuild(workDir: workDir)
        }
        // ESLint config?
        for name in [".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml"] {
            if fm.fileExists(atPath: workDir + "/" + name) {
                return runESLint(workDir: workDir)
            }
        }
        return []
    }

    // MARK: - tsc

    private static nonisolated func runTSC(workDir: String) -> [DiagnosticItem] {
        guard let tsc = which("tsc") else { return [] }
        let out = shell(tsc, args: ["--noEmit", "--pretty", "false"], cwd: workDir, timeout: 30)
        return parseTSC(out ?? "", workDir: workDir)
    }

    static nonisolated func parseTSC(_ output: String, workDir: String) -> [DiagnosticItem] {
        // Format: path(line,col): error TS1234: message
        var items: [DiagnosticItem] = []
        let re = try? NSRegularExpression(
            pattern: #"^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+TS\d+:\s*(.+)$"#,
            options: .anchorsMatchLines
        )
        for raw in output.split(separator: "\n") {
            let line = String(raw)
            guard let match = re?.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) else { continue }
            func g(_ i: Int) -> String {
                guard let r = Range(match.range(at: i), in: line) else { return "" }
                return String(line[r])
            }
            let sev: DiagnosticItem.Severity = g(4) == "error" ? .error : .warning
            items.append(DiagnosticItem(
                severity: sev,
                message: g(5),
                filePath: workDir + "/" + g(1),
                line: Int(g(2)) ?? 0,
                col: Int(g(3)) ?? 0
            ))
        }
        return items
    }

    // MARK: - eslint

    private static nonisolated func runESLint(workDir: String) -> [DiagnosticItem] {
        guard let eslint = which("eslint") else { return [] }
        let out = shell(eslint, args: [".", "--format", "compact", "--max-warnings", "200"], cwd: workDir, timeout: 30)
        return parseESLint(out ?? "", workDir: workDir)
    }

    static nonisolated func parseESLint(_ output: String, workDir: String) -> [DiagnosticItem] {
        // Format: /abs/path: line N, col M, Error/Warning - message (rule)
        var items: [DiagnosticItem] = []
        let re = try? NSRegularExpression(
            pattern: #"^(.+):\s*line (\d+),\s*col (\d+),\s*(Error|Warning)\s*-\s*(.+?)(?:\s*\(.+\))?$"#,
            options: .anchorsMatchLines
        )
        for raw in output.split(separator: "\n") {
            let line = String(raw)
            guard let match = re?.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) else { continue }
            func g(_ i: Int) -> String {
                guard let r = Range(match.range(at: i), in: line) else { return "" }
                return String(line[r])
            }
            let sev: DiagnosticItem.Severity = g(4) == "Error" ? .error : .warning
            items.append(DiagnosticItem(
                severity: sev,
                message: g(5),
                filePath: g(1),
                line: Int(g(2)) ?? 0,
                col: Int(g(3)) ?? 0
            ))
        }
        return items
    }

    // MARK: - swift build

    private static nonisolated func runSwiftBuild(workDir: String) -> [DiagnosticItem] {
        let out = shell("/usr/bin/swift", args: ["build", "--quiet"], cwd: workDir, timeout: 60)
        return parseSwiftBuild(out ?? "", workDir: workDir)
    }

    static nonisolated func parseSwiftBuild(_ output: String, workDir: String) -> [DiagnosticItem] {
        // Format: /path/to/file.swift:line:col: error/warning: message
        var items: [DiagnosticItem] = []
        let re = try? NSRegularExpression(
            pattern: #"^(.+\.swift):(\d+):(\d+):\s*(error|warning):\s*(.+)$"#,
            options: .anchorsMatchLines
        )
        for raw in output.split(separator: "\n") {
            let line = String(raw)
            guard let match = re?.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) else { continue }
            func g(_ i: Int) -> String {
                guard let r = Range(match.range(at: i), in: line) else { return "" }
                return String(line[r])
            }
            let sev: DiagnosticItem.Severity = g(4) == "error" ? .error : .warning
            items.append(DiagnosticItem(
                severity: sev,
                message: g(5),
                filePath: g(1),
                line: Int(g(2)) ?? 0,
                col: Int(g(3)) ?? 0
            ))
        }
        return items
    }

    // MARK: - Helpers

    private static nonisolated func which(_ cmd: String) -> String? {
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

    private static nonisolated func shell(_ exec: String, args: [String], cwd: String, timeout: TimeInterval) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exec)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        p.environment = ProcessInfo.processInfo.environment
        let pipe = Pipe()
        let errPipe = Pipe()
        p.standardOutput = pipe
        p.standardError = errPipe
        do { try p.run() } catch { return nil }
        // Wait with timeout
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
        if p.isRunning { p.terminate() }
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return out + err
    }
}
