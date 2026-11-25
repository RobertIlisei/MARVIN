// BacklogCountSourceScan — the guard that keeps the backlog count in ONE place.
//
// The strip's number went stale because a model captured it when it was created
// and nothing refreshed it (ADR-0044 addendum, 2026-11-25). A fix that lives
// only in review is undone by the next view that wants "just the count", so
// this scans the app's Swift source (a test reads the files and hands the text
// here, which keeps the rule a pure function with fixtures) and names every
// copy as `File.swift:42 why`.
//
// What is a copy:
//   - assigning to anything named like a backlog count (`backlogOpenCount = …`,
//     `@State var parkedBacklogCount = 0`, `private(set) var backlogCount: Int = 0`);
//     a computed property reading the store has no `=` and passes;
//   - the one-time service read, `….openCount(` — the function is gone, and a
//     caller that brings it back is a captured count;
//   - a hand-written "… parked" line that does not go through `BacklogSurface`.
//
// `BacklogLiveStore.swift` is the only file allowed to hold the numbers.

import Foundation

public enum BacklogCountSourceScan {
    /// The one file that holds the counts.
    public static let store = "BacklogLiveStore.swift"

    public static func loadSources(macosDir: String) -> [String: String] {
        let dir = macosDir + "/MARVIN"
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        var out: [String: String] = [:]
        for n in names where n.hasSuffix(".swift") {
            if let text = try? String(contentsOfFile: dir + "/" + n, encoding: .utf8) { out[n] = text }
        }
        return out
    }

    private static let countAssignment = try! NSRegularExpression(
        pattern: #"\b\w*backlog\w*count\w*\s*(?::\s*Int\s*)?=\s*[^=]"#, options: [.caseInsensitive])
    private static let serviceRead = try! NSRegularExpression(pattern: #"\.openCount\("#)

    private static func has(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    public static func violations(in files: [String: String]) -> [String] {
        var out: [String] = []
        for name in files.keys.sorted() where name != store {
            for (i, line) in files[name]!.components(separatedBy: "\n").enumerated() {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("//") { continue }
                if has(countAssignment, line) {
                    out.append("\(name):\(i + 1) assigns a backlog count; read BacklogLiveStore.shared.counts instead")
                }
                if has(serviceRead, line) {
                    out.append("\(name):\(i + 1) reads the count once through the service; read BacklogLiveStore.shared.counts instead")
                }
                // A number interpolated into a "… parked" string: the hand-worded count.
                if line.contains("\\(") && line.contains("parked\"") && line.lowercased().contains("backlog") && !line.contains("BacklogSurface.") {
                    out.append("\(name):\(i + 1) words the backlog count by hand; use BacklogSurface.chipText")
                }
            }
        }
        return out
    }
}
