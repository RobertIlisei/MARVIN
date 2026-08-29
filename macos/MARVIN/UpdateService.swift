// UpdateService — tell the user when a newer MARVIN has shipped (ADR-0086).
//
// Checks the GitHub Releases API for the newest tag, compares it to the
// running bundle, and surfaces a prompt. Runs once shortly after launch and
// then daily, matching what every other desktop app does.
//
// Three deliberate limits:
//   * **No auto-install.** MARVIN is a long-running app that holds live agent
//     turns; swapping the bundle underneath one would kill work in flight
//     (ADR-0038: a SIGTERM'd background job fires no completion turn). The
//     prompt hands over the one command instead.
//   * **Anonymous, unauthenticated.** One GET a day to a public endpoint. No
//     identifiers, nothing sent about the user or their projects.
//   * **Silent on failure.** Offline, rate-limited, or a shape we don't
//     understand — the answer is "say nothing", never a banner.
//
// The comparison itself lives in `MARVINLogic.UpdateCheck`, tested there.

import AppKit
import Foundation
import MARVINLogic

@MainActor
@Observable
final class UpdateService {
    static let shared = UpdateService()

    private static let releasesURL =
        "https://api.github.com/repos/RobertIlisei/MARVIN/releases/latest"
    private static let lastCheckKey = "marvin.update.lastCheckAt"
    private static let skippedKey = "marvin.update.skippedVersion"

    /// Set when a newer release exists and the user hasn't skipped it.
    private(set) var pending: UpdateDecision?
    private var task: Task<Void, Never>?

    private init() {}

    /// The running bundle's version, without the `+sha` build suffix.
    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    /// Start the daily cadence. Idempotent; safe to call on every launch.
    func start() {
        guard task == nil else { return }
        task = Task { @MainActor in
            // A few seconds after launch: the user is opening a project, and
            // an update prompt competing with that is noise.
            try? await Task.sleep(for: .seconds(8))
            while !Task.isCancelled {
                await checkIfDue()
                try? await Task.sleep(for: .seconds(UpdateCheck.checkInterval))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func checkIfDue() async {
        let last = UserDefaults.standard.object(forKey: Self.lastCheckKey) as? Date
        guard UpdateCheck.isDue(last: last) else { return }
        await check(userInitiated: false)
    }

    /// Fetch the newest release and decide. `userInitiated` bypasses both the
    /// daily gate and a previously skipped version — an explicit "check for
    /// updates" must always answer.
    func check(userInitiated: Bool) async {
        guard let url = URL(string: Self.releasesURL) else { return }
        var req = URLRequest(url: url)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 10
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }
            struct Release: Decodable { let tag_name: String? }
            guard let tag = (try? JSONDecoder().decode(Release.self, from: data))?.tag_name else { return }
            UserDefaults.standard.set(Date(), forKey: Self.lastCheckKey)
            let decision = UpdateCheck.decide(current: currentVersion, latest: tag)
            let skipped = userInitiated ? nil : UserDefaults.standard.string(forKey: Self.skippedKey)
            pending = UpdateCheck.shouldPrompt(decision: decision, skipped: skipped) ? decision : nil
            if userInitiated, pending == nil {
                MarvinBridge.shared.appendNotification(
                    decision.updateAvailable
                        ? "Update \(decision.latest) available."
                        : "MARVIN \(decision.current) is up to date."
                )
            }
        } catch {
            // Offline / rate-limited / unparseable — stay silent (see header).
        }
    }

    /// Don't ask again until something newer than this ships.
    func skip(_ version: String) {
        UserDefaults.standard.set(version, forKey: Self.skippedKey)
        pending = nil
    }

    func dismiss() { pending = nil }

    /// Open the release page; the user upgrades with brew or the zip.
    func openReleasePage(_ version: String) {
        let tag = version.hasPrefix("v") ? version : "v\(version)"
        if let url = URL(string: "https://github.com/RobertIlisei/MARVIN/releases/tag/\(tag)") {
            NSWorkspace.shared.open(url)
        }
        pending = nil
    }

    /// The upgrade command, for the prompt's copy button.
    static let upgradeCommand = "brew upgrade --cask marvin-ai"
}
