// BranchService — ADR-0021 M3.
// Polls GET /api/files/status?cwd= every 15s, replacing the web
// side's `branch-changed` bridge message. Also triggers an immediate
// poll on marvin.turnCompleted (posted by ChatPreviewModel when the
// SSE stream ends) so the dirty pip updates right after a turn that
// wrote files, without waiting for the next 15s cycle.
// Visibility-aware. Keeps last-known branch on transient errors;
// clears after 3 consecutive failures.

import Foundation
import AppKit

@MainActor
final class BranchService {
    static let shared = BranchService()

    private var pollingTask: Task<Void, Never>?
    private var currentWorkDir: String? = nil
    private var consecutiveFailures: Int = 0
    private var turnObserver: Any?

    private init() {
        // Observe turn completion to kick an immediate branch refresh.
        // The dirty-file count changes right after a turn writes files —
        // waiting up to 15s for the next poll would feel stale.
        turnObserver = NotificationCenter.default.addObserver(
            forName: .marvinTurnCompleted,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.kickImmediatePoll()
            }
        }
    }

    // MARK: - External triggers

    /// Called by ProjectsService when the active project changes.
    /// Resets the branch display and starts polling the new workDir.
    func onProjectChanged(to workDir: String) {
        currentWorkDir = workDir
        consecutiveFailures = 0
        restartPolling()
    }

    // MARK: - Polling

    private func restartPolling() {
        pollingTask?.cancel()
        pollingTask = Task {
            await poll()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { break }
                await poll()
            }
        }
    }

    /// Restart the polling loop immediately (used after turn completion).
    private func kickImmediatePoll() {
        guard pollingTask != nil else { return }
        restartPolling()
    }

    private func poll() async {
        guard NSApp.isActive else { return }
        guard let cwd = currentWorkDir,
              let encoded = cwd.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(ServerConfig.baseURLString)/api/files/status?cwd=\(encoded)")
        else { return }

        do {
            var req = URLRequest(url: url)
            req.setValue("1", forHTTPHeaderField: "x-marvin-client")
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }

            struct Wire: Codable {
                let isGit: Bool
                let branch: String?
                let status: [String: String]?
            }
            let w = try JSONDecoder().decode(Wire.self, from: data)
            let b = MarvinBridge.shared
            if w.isGit {
                b.branch = w.branch.flatMap { $0.isEmpty ? nil : $0 }
                b.branchDirtyCount = w.status?.count ?? 0
            } else {
                b.branch = nil
                b.branchDirtyCount = 0
            }
            consecutiveFailures = 0
        } catch {
            consecutiveFailures += 1
            if consecutiveFailures >= 3 {
                MarvinBridge.shared.branch = nil
                MarvinBridge.shared.branchDirtyCount = 0
                NSLog("[BranchService] 3 consecutive failures, cleared branch: \(error)")
            }
        }
    }
}
