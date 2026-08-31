// LSPService — one per project; routes the editor's open buffers to the
// right language server and merges what comes back (ADR-0099).
//
// The CLI runners in `DiagnosticsService` and the servers here are two
// producers answering different questions, and both write into the same
// Problems list:
//
//   • A runner sees the WHOLE project, including files nobody opened, but
//     reads from DISK and takes seconds to minutes.
//   • A server sees the OPEN BUFFER, live and range-accurate, but knows
//     nothing about the module three directories over.
//
// `MarvinBridge` holds them separately and merges on read, so a slow `tsc`
// finishing cannot erase what a server published two seconds ago.

import Foundation
import MARVINLogic

@MainActor
@Observable
final class LSPService {
    static let shared = LSPService()

    /// Live clients, keyed by server id. One per language, per project.
    private var clients: [String: LSPClient] = [:]
    /// Servers we looked for and could not find — reported once, in the
    /// panel, rather than swallowed.
    private(set) var unavailable: [String: String] = [:]
    /// Crash counter per server id. Three strikes and we stop respawning:
    /// an editor that restarts a crashing subprocess forever is a battery
    /// bug, and the user deserves to be told rather than to hear the fans.
    private var strikes: [String: Int] = [:]
    private static let maxStrikes = 3

    private var root: String?
    private var changeDebounce: [String: Task<Void, Never>] = [:]
    /// Full-document sync at 150 ms. Incremental sync is an optimisation
    /// with an entire desync bug class behind it (ADR-0099).
    private static let debounceNanos: UInt64 = 150_000_000

    var activeServerIds: [String] { clients.keys.sorted() }
    var readyServerIds: [String] { clients.filter { $0.value.isReady }.map(\.key).sorted() }

    // MARK: - Project lifecycle

    func activate(root newRoot: String) {
        guard newRoot != root else { return }
        shutdown()
        root = newRoot
    }

    func shutdown() {
        for task in changeDebounce.values { task.cancel() }
        changeDebounce.removeAll()
        for client in clients.values { client.stop() }
        clients.removeAll()
        strikes.removeAll()
        unavailable.removeAll()
        // A dead server's opinion must not outlive it, or the panel
        // attributes stale findings to the current project.
        MarvinBridge.shared.clearLSPDiagnostics()
    }

    // MARK: - Editor events

    func didOpen(path: String, text: String) {
        guard let client = client(for: path) else { return }
        client.didOpen(path: path, text: text)
    }

    /// Debounced: a keystroke is not a document version worth a round trip,
    /// but 150 ms of quiet is.
    func didChange(path: String, text: String) {
        guard client(for: path) != nil else { return }
        changeDebounce[path]?.cancel()
        changeDebounce[path] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.debounceNanos)
            guard !Task.isCancelled, let self else { return }
            self.client(for: path)?.didChange(path: path, text: text)
            self.changeDebounce.removeValue(forKey: path)
        }
    }

    func didClose(path: String) {
        changeDebounce[path]?.cancel()
        changeDebounce.removeValue(forKey: path)
        clients.values.first { $0.spec.fileExtensions.contains(ext(path)) }?
            .didClose(path: path)
        // The file is gone from the editor, so its diagnostics are gone
        // too — a server only republishes for documents it still holds.
        MarvinBridge.shared.applyLSPDiagnostics(file: path, items: [])
    }

    /// Go to Definition. Silent when no server handles this language —
    /// the command is disabled in that case, so reaching here means the
    /// server simply had no answer.
    func definition(
        path: String, line: Int, column: Int,
        completion: @escaping (_ path: String, _ line: Int) -> Void
    ) {
        client(for: path)?.definition(
            path: path, line: line, column: column, completion: completion
        )
    }

    /// True when a READY server covers this file — what gates the menu item.
    func hasReadyServer(for path: String) -> Bool {
        guard let spec = LSPServerSpec.forFile(path) else { return false }
        return clients[spec.id]?.isReady == true
    }

    // MARK: - Client resolution

    private func ext(_ path: String) -> String {
        (path as NSString).pathExtension.lowercased()
    }

    /// The client for this file's language, started on first use. Servers
    /// are launched lazily: opening a Markdown file should not spawn a
    /// Swift compiler.
    private func client(for path: String) -> LSPClient? {
        guard let root, let spec = LSPServerSpec.forFile(path) else { return nil }
        if let existing = clients[spec.id] { return existing }
        guard (strikes[spec.id] ?? 0) < Self.maxStrikes else { return nil }
        guard LSPClient.resolve(spec, root: root) != nil else {
            noteUnavailable(spec, root: root, reason: "not installed")
            return nil
        }

        let client = LSPClient(spec: spec, root: root)
        client.onDiagnostics = { path, items in
            MarvinBridge.shared.applyLSPDiagnostics(file: path, items: items)
        }
        client.onExit = { [weak self] reason in
            guard let self else { return }
            self.clients.removeValue(forKey: spec.id)
            let n = (self.strikes[spec.id] ?? 0) + 1
            self.strikes[spec.id] = n
            if n >= Self.maxStrikes {
                self.unavailable[spec.id] =
                    "crashed \(n)× — not restarting. Last: \(reason)"
                self.publishUnavailable(root: root)
            }
        }
        guard client.start() else {
            noteUnavailable(spec, root: root, reason: "failed to start")
            return nil
        }
        unavailable.removeValue(forKey: spec.id)
        clients[spec.id] = client
        return client
    }

    private func noteUnavailable(_ spec: LSPServerSpec, root: String, reason: String) {
        guard unavailable[spec.id] == nil else { return }
        unavailable[spec.id] = reason
        publishUnavailable(root: root)
    }

    /// Surface a missing or dead server AS a diagnostic. Returning nothing
    /// is indistinguishable from "no problems" — the exact failure that
    /// made the Problems panel look dead for months.
    private func publishUnavailable(root: String) {
        let items = unavailable.map { id, reason in
            DiagnosticItem(
                severity: .info,
                message: "Language server \(id) \(reason). "
                    + "Live diagnostics for that language are off; the "
                    + "project-wide runner still covers it.",
                filePath: root, line: 0, col: 0, source: "lsp"
            )
        }
        MarvinBridge.shared.applyLSPDiagnostics(
            file: root + "/\u{200B}lsp", items: items
        )
    }
}
