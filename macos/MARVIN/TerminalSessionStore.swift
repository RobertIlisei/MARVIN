// TerminalSessionStore — the shell sessions, owned outside the view (ADR-0078).
//
// A SwiftUI pane is destroyed every time it is hidden. Keeping the shell in
// `@State` would kill it on every pane toggle — precisely the persistence
// the PTY exists to provide. So sessions live here, keyed by project
// workDir, and the view only attaches to one. `applicationWillTerminate`
// tears them all down so no shell outlives the app.
//
// Since 2026-09-09 a project holds SEVERAL sessions — tabs — and one of them
// is active. Switching tabs swaps which session the pane shows and never
// touches a shell; only closing a tab hangs its shell up. (User: "open
// multiple terminals … switch between them without killing them".)

import AppKit
import Foundation
import MARVINLogic
import SwiftTerm

@MainActor
@Observable
final class TerminalSession: Identifiable {
    let id = UUID()
    let workDir: String
    /// 1-based, per project, never reused — the tab's label.
    let number: Int
    /// The SwiftTerm view is owned here too: its scrollback IS the session.
    let view: TerminalView
    private(set) var process: PTYProcess?
    private(set) var exitStatus: Int32?
    /// Bytes that arrived before the view was in a window. Fed on attach.
    private var pending = Data()
    private var attached = false

    init(workDir: String, number: Int = 1) {
        self.workDir = workDir
        self.number = number
        self.view = TerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 400))
        start()
    }

    var isRunning: Bool { process?.isRunning ?? false }

    /// Spawn (or respawn after exit) the user's login shell on a pty.
    func start() {
        exitStatus = nil
        let source = ProcessInfo.processInfo.environment
        let shell = TerminalEnvironment.shell(from: source)
        let cols = max(20, view.getTerminal().cols)
        let rows = max(5, view.getTerminal().rows)
        let env = TerminalEnvironment.make(from: source, columns: cols, rows: rows)
        do {
            let p = try PTYProcess(
                executable: shell.path,
                argv0: shell.argv0,
                environment: env,
                workingDirectory: workDir,
                columns: cols,
                rows: rows
            )
            p.onOutput = { [weak self] data in
                Task { @MainActor [weak self] in self?.receive(data) }
            }
            p.onExit = { [weak self] status in
                Task { @MainActor [weak self] in self?.exited(status) }
            }
            process = p
        } catch {
            view.feed(text: "\r\n[MARVIN] could not start \(shell.path): \(error)\r\n")
        }
    }

    private func receive(_ data: Data) {
        guard attached else { pending.append(data); return }
        view.feed(byteArray: ArraySlice(data))
    }

    private func exited(_ status: Int32) {
        exitStatus = status
        let code = PTYProcess.exitCode(from: status).map { "exit \($0)" }
            ?? PTYProcess.signal(from: status).map { "signal \($0)" } ?? "ended"
        view.feed(text: "\r\n\u{1b}[2m[shell \(code) — press ⏎ to restart]\u{1b}[0m\r\n")
    }

    /// Called by the view host once the SwiftTerm view is on screen.
    func markAttached() {
        attached = true
        if !pending.isEmpty {
            view.feed(byteArray: ArraySlice(pending))
            pending.removeAll()
        }
    }

    func send(_ bytes: ArraySlice<UInt8>) {
        if let p = process, p.isRunning {
            p.write(Data(bytes))
        } else if bytes.contains(0x0D) || bytes.contains(0x0A) {
            // Enter on a dead shell restarts it — the affordance the exit line promises.
            view.feed(text: "\r\n")
            start()
        }
    }

    /// Type a command as if the user had — build tasks use this.
    func run(command: String) {
        send(ArraySlice(Array("\(command)\n".utf8)))
    }

    func resize(columns: Int, rows: Int) {
        process?.resize(columns: columns, rows: rows)
    }

    func interrupt() { send([0x03]) }

    /// Ctrl-L: the shell redraws a clean screen. Honest, unlike wiping the
    /// buffer behind a running program's back.
    func clear() { send([0x0C]) }

    func terminate() {
        process?.terminate()
        process = nil
    }
}

@MainActor
@Observable
final class TerminalSessionStore {
    static let shared = TerminalSessionStore()
    /// Every session per project, in tab order.
    private(set) var sessions: [String: [TerminalSession]] = [:]
    /// The tab the pane shows, per project.
    private(set) var activeIds: [String: UUID] = [:]
    /// Next tab number per project. Numbers are never reused, so a closed
    /// "2" does not come back as a different shell called "2".
    private var counters: [String: Int] = [:]

    /// All tabs for a project, in order.
    func sessions(for workDir: String) -> [TerminalSession] {
        sessions[workDir] ?? []
    }

    /// The ACTIVE session for a project, created on first use. Every caller
    /// that types into "the terminal" — build tasks, the file tree's "open
    /// here", the command registry — lands in the tab the user is looking at.
    func session(for workDir: String) -> TerminalSession {
        let list = sessions(for: workDir)
        if let id = activeIds[workDir], let s = list.first(where: { $0.id == id }) { return s }
        if let s = list.first {
            activeIds[workDir] = s.id
            return s
        }
        return newSession(for: workDir)
    }

    /// Open another tab for a project and make it active.
    @discardableResult
    func newSession(for workDir: String) -> TerminalSession {
        let n = (counters[workDir] ?? 0) + 1
        counters[workDir] = n
        let s = TerminalSession(workDir: workDir, number: n)
        sessions[workDir, default: []].append(s)
        activeIds[workDir] = s.id
        return s
    }

    /// Show a tab. Never touches a shell.
    func activate(_ s: TerminalSession) {
        activeIds[s.workDir] = s.id
    }

    func isActive(_ s: TerminalSession) -> Bool {
        activeIds[s.workDir] == s.id
    }

    /// Close ONE tab: hang its shell up and drop it. The other tabs, and the
    /// other projects, are untouched. The neighbour becomes active.
    func close(_ s: TerminalSession) {
        s.terminate()
        var list = sessions(for: s.workDir)
        let idx = list.firstIndex { $0.id == s.id }
        list.removeAll { $0.id == s.id }
        sessions[s.workDir] = list.isEmpty ? nil : list
        if activeIds[s.workDir] == s.id {
            let next = list.isEmpty ? nil : list[min(idx ?? 0, list.count - 1)]
            activeIds[s.workDir] = next?.id
        }
    }

    /// Is there a live shell for THIS project?
    ///
    /// Scoped to one `workDir`, never a global count. The store is keyed by
    /// project, and several sessions can be running at once — a session-stop
    /// that counted every shell would be offering to close another project's
    /// terminal, which is precisely what stopping ONE session must not do.
    func isRunning(workDir: String) -> Bool {
        sessions(for: workDir).contains { $0.isRunning }
    }

    /// Terminate every shell for one project, leaving every other alone.
    func terminate(workDir: String) {
        for s in sessions(for: workDir) { s.terminate() }
    }

    /// Hang up every shell. Called from `applicationWillTerminate`.
    func terminateAll() {
        for list in sessions.values {
            for s in list { s.terminate() }
        }
        sessions.removeAll()
        activeIds.removeAll()
    }
}
