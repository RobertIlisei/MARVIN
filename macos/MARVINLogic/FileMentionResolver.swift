// FileMentionResolver — turning a filename a model mentioned into a real file.
//
// Models name files the way people do: `sdk-runner.ts`, not
// `sidecar/packages/runtime/src/sdk-runner.ts`. MARVIN's chat only linked
// mentions that resolved literally under `workDir`, so a bare basename — by
// far the common case — stayed plain text and clicking it did nothing (user,
// 2026-09-01, against a reference IDE that opens the file).
//
// The rule is deliberately conservative about which mention becomes a link,
// because a link that opens the wrong file is worse than no link:
//
//   1. An exact relative path wins outright. If the model said
//      `sidecar/src/index.ts` and that exists, nothing else is considered.
//   2. Otherwise match on the FULL trailing path segment, not a substring:
//      `runner.ts` must not match `sdk-runner.ts`. Suffix matching on raw
//      strings is what makes "helpfully" resolved links land on the wrong
//      file.
//   3. Several matches are kept, in a stable order, and handed to the caller
//      to disambiguate. Silently picking the shortest would be a guess
//      wearing a link's clothes.
//
// Pure (ADR-0022) so the matching rules are pinned without a project on disk.

import Foundation

public enum FileMentionResolver {
    /// Candidate absolute paths for `mention`, best first. Empty means "do
    /// not link this".
    ///
    /// `index` maps a lowercased basename to the relative paths carrying it.
    /// `relativePaths` is only consulted for an exact hit, so the common case
    /// costs one dictionary lookup.
    public static func candidates(
        for mention: String,
        workDir: String,
        index: [String: [String]],
        relativePaths: Set<String>
    ) -> [String] {
        let trimmed = mention.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return [] }

        // An absolute path is already an answer.
        if trimmed.hasPrefix("/") { return [trimmed] }

        let cleaned = trimmed.hasPrefix("./") ? String(trimmed.dropFirst(2)) : trimmed

        // 1. Exact relative path.
        if relativePaths.contains(cleaned) {
            return [absolute(cleaned, in: workDir)]
        }

        // 2. Basename lookup, then keep only those whose trailing segments
        //    match the mention segment-for-segment.
        let basename = (cleaned as NSString).lastPathComponent.lowercased()
        guard let bucket = index[basename] else { return [] }
        let wanted = cleaned.split(separator: "/").map(String.init)
        let matches = bucket.filter { hasTrailingSegments(wanted, in: $0) }
        guard !matches.isEmpty else { return [] }

        // Shallowest first, then alphabetical — a stable order, so a picker
        // does not reshuffle between renders. This is presentation order, not
        // a choice: every match is still offered.
        let sorted = matches.sorted {
            let a = $0.split(separator: "/").count, b = $1.split(separator: "/").count
            return a == b ? $0 < $1 : a < b
        }
        return sorted.map { absolute($0, in: workDir) }
    }

    /// True when `path` ends with exactly the segments in `wanted`.
    ///
    /// Segment-wise, never a string suffix: `runner.ts` must not match
    /// `sdk-runner.ts`, and `src/index.ts` must not match `websrc/index.ts`.
    public static func hasTrailingSegments(_ wanted: [String], in path: String) -> Bool {
        let segments = path.split(separator: "/").map(String.init)
        guard wanted.count <= segments.count else { return false }
        return Array(segments.suffix(wanted.count)) == wanted
    }

    private static func absolute(_ relative: String, in workDir: String) -> String {
        (workDir as NSString).appendingPathComponent(relative)
    }

    /// Build the basename index from a project's relative paths.
    public static func buildIndex(_ relativePaths: [String]) -> [String: [String]] {
        var out: [String: [String]] = [:]
        for path in relativePaths {
            let key = (path as NSString).lastPathComponent.lowercased()
            out[key, default: []].append(path)
        }
        return out
    }
}
