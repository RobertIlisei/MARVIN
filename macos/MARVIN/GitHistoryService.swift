// GitHistoryService — M6. Thin wrappers around `git log` and
// `git blame` for the active file. Runs as detached Tasks so the
// main thread is never blocked. Both are best-effort: if git is
// unavailable or the file isn't tracked, the service returns empty.

import Foundation

// MARK: - File history (git log)

struct GitCommit: Identifiable {
    let id: String       // short SHA
    let sha: String      // full SHA
    let message: String
    let author: String
    let date: String     // relative ("3 days ago")
    let dateISO: String  // absolute ("2026-04-12")
}

struct GitHistoryService {
    static func fileHistory(path: String, workDir: String, limit: Int = 50) async -> [GitCommit] {
        return await Task.detached(priority: .userInitiated) {
            run(path: path, workDir: workDir, limit: limit)
        }.value
    }

    private static func run(path: String, workDir: String, limit: Int) -> [GitCommit] {
        let rel = relativePath(path, to: workDir)
        // format: sha|short|author|relDate|isoDate|subject
        let format = "%H|%h|%an|%cr|%ci|%s"
        let proc = makeProc(workDir: workDir, args: [
            "log", "--follow",
            "--pretty=format:\(format)",
            "--max-count=\(limit)",
            "--", rel,
        ])
        guard let output = runProc(proc), proc.terminationStatus == 0 else { return [] }
        return output.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "|", maxSplits: 5, omittingEmptySubsequences: false)
            guard parts.count == 6 else { return nil }
            return GitCommit(
                id: String(parts[1]),
                sha: String(parts[0]),
                message: String(parts[5]),
                author: String(parts[2]),
                date: String(parts[3]),
                dateISO: String(String(parts[4]).prefix(10))
            )
        }
    }

    private static func relativePath(_ path: String, to workDir: String) -> String {
        let base = workDir.hasSuffix("/") ? workDir : workDir + "/"
        return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : path
    }

    private static func makeProc(workDir: String, args: [String]) -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", workDir] + args
        p.currentDirectoryURL = URL(fileURLWithPath: workDir)
        p.standardError = Pipe()
        return p
    }

    private static func runProc(_ proc: Process) -> String? {
        let pipe = Pipe()
        proc.standardOutput = pipe
        do { try proc.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }
}

// MARK: - Blame (per-line last commit)

struct BlameEntry: Identifiable {
    let id = UUID()
    let lineStart: Int
    let lineCount: Int
    let sha: String
    let shortSha: String
    let author: String
    let date: String  // "YYYY-MM-DD"
    let summary: String
}

struct GitBlameService {
    static func blame(path: String, workDir: String) async -> [BlameEntry] {
        return await Task.detached(priority: .userInitiated) {
            run(path: path, workDir: workDir)
        }.value
    }

    // Parses `git blame --porcelain` output into BlameEntry per hunk.
    // Porcelain format: one header block per unique-commit group, then
    // tab-prefixed content lines. We extract commit metadata and the
    // line range, and collapse consecutive same-commit lines into one entry.
    private static func run(path: String, workDir: String) -> [BlameEntry] {
        let rel = relativePath(path, to: workDir)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", workDir, "blame", "--porcelain", "--", rel]
        p.currentDirectoryURL = URL(fileURLWithPath: workDir)
        p.standardError = Pipe()
        let pipe = Pipe()
        p.standardOutput = pipe
        do { try p.run() } catch { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0,
              let output = String(data: data, encoding: .utf8) else { return [] }
        return parsePorcelain(output)
    }

    private static func parsePorcelain(_ output: String) -> [BlameEntry] {
        var entries: [BlameEntry] = []
        // Per-SHA metadata cache so subsequent hunks for the same commit
        // don't re-parse author/date fields (porcelain only emits them once).
        var metaCache: [String: (author: String, date: String, summary: String)] = [:]

        var currentSha = ""
        var currentLine = 0
        var currentAuthor = ""
        var currentDate = ""
        var currentSummary = ""

        for raw in output.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("\t") { continue }  // content line
            let parts = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: false)
            guard parts.count >= 1 else { continue }

            let first = String(parts[0])
            // Hunk header: <sha> <orig-line> <result-line> [<num-lines>]
            if first.count == 40 && first.allSatisfy({ $0.isHexDigit }) {
                // Emit previous entry if any
                if !currentSha.isEmpty {
                    let (a, d, s) = metaCache[currentSha] ?? (currentAuthor, currentDate, currentSummary)
                    entries.append(BlameEntry(
                        lineStart: currentLine,
                        lineCount: 1,
                        sha: currentSha,
                        shortSha: String(currentSha.prefix(7)),
                        author: a, date: d, summary: s
                    ))
                }
                currentSha = first
                currentLine = parts.count >= 3 ? (Int(parts[2]) ?? 0) : 0
                // Restore cached metadata if we've seen this SHA before
                if let cached = metaCache[currentSha] {
                    currentAuthor = cached.author
                    currentDate = cached.date
                    currentSummary = cached.summary
                }
            } else if first == "author" {
                currentAuthor = parts.dropFirst().joined(separator: " ")
            } else if first == "author-time" {
                if let ts = TimeInterval(parts.dropFirst().joined()) {
                    let d = Date(timeIntervalSince1970: ts)
                    let f = ISO8601DateFormatter()
                    f.formatOptions = [.withFullDate]
                    currentDate = f.string(from: d)
                }
            } else if first == "summary" {
                currentSummary = parts.dropFirst().joined(separator: " ")
                metaCache[currentSha] = (currentAuthor, currentDate, currentSummary)
            }
        }
        // Emit last entry
        if !currentSha.isEmpty {
            let (a, d, s) = metaCache[currentSha] ?? (currentAuthor, currentDate, currentSummary)
            entries.append(BlameEntry(
                lineStart: currentLine, lineCount: 1,
                sha: currentSha, shortSha: String(currentSha.prefix(7)),
                author: a, date: d, summary: s
            ))
        }
        return entries
    }

    private static func relativePath(_ path: String, to workDir: String) -> String {
        let base = workDir.hasSuffix("/") ? workDir : workDir + "/"
        return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : path
    }
}
