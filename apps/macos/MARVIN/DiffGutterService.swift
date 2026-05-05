// DiffGutterService — M5. Runs `git diff HEAD --unified=0 -- <file>`
// and parses the unified diff output into a per-line status dict.
// Only looks at the + (new-file) side of the hunk headers so the
// result maps to the file's CURRENT line numbers (what the editor
// shows). Returns an empty dict when git is unavailable, the file is
// untracked, or the file is clean.

import Foundation

enum DiffLineStatus {
    case added      // line exists only in working copy (green)
    case modified   // line replaced an existing line (orange/yellow)
    case removed    // line was deleted above this point (small red triangle)
}

struct DiffGutterService {
    static func load(path: String, workDir: String) async -> [Int: DiffLineStatus] {
        return await Task.detached(priority: .userInitiated) {
            run(path: path, workDir: workDir)
        }.value
    }

    private static func run(path: String, workDir: String) -> [Int: DiffLineStatus] {
        let rel = relativePath(path, to: workDir)
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        proc.arguments = ["-C", workDir, "diff", "HEAD", "--unified=0", "--", rel]
        proc.currentDirectoryURL = URL(fileURLWithPath: workDir)
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do { try proc.run() } catch { return [:] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        guard proc.terminationStatus == 0,
              let output = String(data: data, encoding: .utf8) else { return [:] }
        return parseHunks(output)
    }

    // Parse `@@ -oldStart[,oldCount] +newStart[,newCount] @@` headers.
    // New-side ranges are mapped to DiffLineStatus:
    //   newCount == 0  → deletion before newStart (mark newStart with .removed)
    //   oldCount == 0  → pure addition (mark all new lines .added)
    //   else           → replacement (mark new lines .modified)
    static func parseHunks(_ diff: String) -> [Int: DiffLineStatus] {
        var result: [Int: DiffLineStatus] = [:]
        let hunkRe = try? NSRegularExpression(pattern: #"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@"#)
        for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            let s = String(line)
            guard s.hasPrefix("@@"),
                  let match = hunkRe?.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { continue }
            func group(_ i: Int) -> Int? {
                let r = match.range(at: i)
                guard r.location != NSNotFound, let range = Range(r, in: s) else { return nil }
                return Int(s[range])
            }
            let oldCount = group(2) ?? 1
            let newStart = group(3) ?? 1
            let newCount = group(4) ?? 1

            if newCount == 0 {
                // Pure deletion — mark the line before the gap
                let target = max(1, newStart)
                if result[target] == nil { result[target] = .removed }
            } else if oldCount == 0 {
                // Pure addition
                for ln in newStart ..< (newStart + newCount) {
                    result[ln] = .added
                }
            } else {
                // Replacement (modified)
                for ln in newStart ..< (newStart + newCount) {
                    result[ln] = .modified
                }
            }
        }
        return result
    }

    private static func relativePath(_ path: String, to workDir: String) -> String {
        let base = workDir.hasSuffix("/") ? workDir : workDir + "/"
        return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : path
    }
}
