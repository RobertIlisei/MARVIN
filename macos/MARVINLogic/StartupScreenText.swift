// StartupScreenText — what the two start-up screens say (UX review F-02, F-03).
//
// "Connecting" was a spinner with one fixed line, however long it took, and
// "Sidecar not reachable" told the owner of an installed app to run
// `bin/marvin start` from a repository clone they do not have. The words live
// here so they can be asserted; the views only draw them.

import Foundation

public enum StartupScreenText {

    // MARK: - Connecting

    public struct Connecting: Equatable, Sendable {
        public let headline: String
        /// Nil in the first seconds: a quick start needs no commentary.
        public let detail: String?
        /// From the slow threshold on, the log is worth offering.
        public let offersLog: Bool
    }

    /// After this long the screen stops describing a normal start.
    public static let slowAfter: TimeInterval = 20
    private static let chattyAfter: TimeInterval = 5

    public static func connecting(elapsed: TimeInterval, tabCount: Int?) -> Connecting {
        let headline = "Connecting to the MARVIN sidecar\u{2026}"
        guard elapsed >= chattyAfter else {
            return Connecting(headline: headline, detail: nil, offersLog: false)
        }
        let seconds = duration(elapsed)
        if elapsed >= slowAfter {
            return Connecting(
                headline: headline,
                detail: "This is taking longer than usual (\(seconds)). The sidecar may have failed to start. "
                    + "The log says why; Retry tries again.",
                offersLog: true
            )
        }
        var detail = "Still starting (\(seconds))."
        if let n = tabCount, n > 0 {
            detail += n == 1
                ? " Your tab is restored as soon as it answers."
                : " Your \(n) tabs are restored as soon as it answers."
        }
        return Connecting(headline: headline, detail: detail, offersLog: false)
    }

    private static func duration(_ t: TimeInterval) -> String {
        let s = Int(t)
        return s < 60 ? "\(s) s" : "\(s / 60) min"
    }

    /// The tabs a relaunch will restore, from what is saved under
    /// `marvin.chatTabs.<project>` (the key `SessionRegistry` persists). Which
    /// project is active is not known until the sidecar answers, so with no
    /// `activeProjectId` a count is given only when exactly one project has
    /// saved tabs; otherwise nil, which is "unknown", never a guess.
    public static func savedTabCount(saved: [String: [String]], activeProjectId: String?) -> Int? {
        if let id = activeProjectId, let tabs = saved[id] {
            return ChatTabsMigration.dedupe(tabs).count
        }
        guard activeProjectId == nil, saved.count == 1, let only = saved.values.first else { return nil }
        return ChatTabsMigration.dedupe(only).count
    }

    // MARK: - Offline

    public struct Offline: Equatable, Sendable {
        public let headline: String
        public let explanation: String
        /// What the person can do from this screen, in words that name the buttons.
        public let steps: [String]
        /// Development builds only: the repository command.
        public let showsDeveloperCommand: Bool
        public let developerCommand: String
    }

    public static func offline(isBundled: Bool, logPath: String) -> Offline {
        if isBundled {
            return Offline(
                headline: "Sidecar not reachable",
                explanation: "MARVIN runs its tabs through a small local service, the sidecar, which starts "
                    + "with the app. It is not answering. Your tabs and their history are saved on this Mac.",
                steps: [
                    "Retry checks again now; MARVIN keeps trying every few seconds on its own.",
                    "If it keeps failing, Show Log opens \(logPath), which says why the sidecar did not start.",
                    "Quitting and opening MARVIN again starts a fresh sidecar.",
                ],
                showsDeveloperCommand: false,
                developerCommand: ""
            )
        }
        return Offline(
            headline: "Sidecar not reachable",
            explanation: "This build does not bundle the sidecar, so it has to be running separately.",
            steps: [],
            showsDeveloperCommand: true,
            developerCommand: "bin/marvin start"
        )
    }
}
