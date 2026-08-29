// UpdateCheck — is a newer MARVIN published? (ADR-0086)
//
// MARVIN had no update path at all: a user on 0.1.65 stayed on 0.1.65 until
// they happened to run `brew upgrade`. Every other desktop app tells you.
//
// The check reads the GitHub Releases API for the newest tag and compares it
// to the running bundle's `CFBundleShortVersionString`. This file is the pure
// half — version parsing and the decision — so the rules are test-pinned:
//
//   * versions are compared NUMERICALLY, component by component, so 0.1.9 <
//     0.1.10 (a string compare gets that backwards, which is exactly the bug
//     that would make an update prompt fire never or forever);
//   * the running build's `+sha` suffix is ignored — `0.1.71+abc` is 0.1.71;
//   * a running version NEWER than the latest release is a dev build, and
//     must never be told to "update" to something older.

import Foundation

public struct SemanticVersion: Comparable, Equatable, CustomStringConvertible {
    public let components: [Int]
    public let raw: String

    /// Parse `v0.1.71`, `0.1.71`, `0.1.71+a43b044`, `0.1.71-rc.1`.
    /// Returns nil when there is no leading numeric component at all.
    public init?(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var core = trimmed.hasPrefix("v") || trimmed.hasPrefix("V")
            ? String(trimmed.dropFirst())
            : trimmed
        // Build metadata (+sha) and pre-release (-rc.1) are not ordering
        // information we want here; the numeric core is.
        if let plus = core.firstIndex(of: "+") { core = String(core[core.startIndex..<plus]) }
        if let dash = core.firstIndex(of: "-") { core = String(core[core.startIndex..<dash]) }
        let parts = core.split(separator: ".").map { Int($0) }
        guard let first = parts.first, first != nil, !parts.contains(where: { $0 == nil }) else {
            return nil
        }
        components = parts.compactMap { $0 }
        raw = trimmed
    }

    public var description: String { raw }

    public static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        let n = max(lhs.components.count, rhs.components.count)
        for i in 0..<n {
            let l = i < lhs.components.count ? lhs.components[i] : 0
            let r = i < rhs.components.count ? rhs.components[i] : 0
            if l != r { return l < r }
        }
        return false
    }

    public static func == (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        !(lhs < rhs) && !(rhs < lhs)
    }
}

public struct UpdateDecision: Equatable {
    public let updateAvailable: Bool
    public let current: String
    public let latest: String

    public init(updateAvailable: Bool, current: String, latest: String) {
        self.updateAvailable = updateAvailable
        self.current = current
        self.latest = latest
    }
}

public enum UpdateCheck {
    /// Should the user be told about `latest`?
    ///
    /// False when either side is unparseable — an update prompt built on a
    /// version string nobody understands is worse than no prompt.
    public static func decide(current: String, latest: String) -> UpdateDecision {
        guard let c = SemanticVersion(current), let l = SemanticVersion(latest) else {
            return UpdateDecision(updateAvailable: false, current: current, latest: latest)
        }
        return UpdateDecision(updateAvailable: c < l, current: c.raw, latest: l.raw)
    }

    /// How long to wait between background checks. Deliberately a day: this
    /// is a courtesy, not a telemetry beacon, and a release lands at most a
    /// few times a week.
    public static let checkInterval: TimeInterval = 24 * 60 * 60

    /// True when `now` is at least `checkInterval` past `last`. A nil `last`
    /// (never checked) is due.
    public static func isDue(last: Date?, now: Date = Date()) -> Bool {
        guard let last else { return true }
        return now.timeIntervalSince(last) >= checkInterval
    }

    /// The user dismissed this version — don't ask again until a newer one
    /// ships. Skipping is per-version, never permanent.
    public static func shouldPrompt(decision: UpdateDecision, skipped: String?) -> Bool {
        guard decision.updateAvailable else { return false }
        guard let skipped, let s = SemanticVersion(skipped), let l = SemanticVersion(decision.latest)
        else { return true }
        return s < l
    }
}
