// TerminalSessionStore — the shell sessions, owned outside the view (ADR-0078).
//
// A SwiftUI pane is destroyed every time it is hidden. Keeping the shell in
// `@State` would kill it on every pane toggle — precisely the persistence
// the PTY exists to provide. So sessions live here, keyed by project
// workDir, and the view only attaches to one. `applicationWillTerminate`
// tears them all down so no shell outlives the app.

import AppKit
import Foundation
import MARVINLogic
import SwiftTerm

@MainActor
@Observable
final class TerminalSession: Identifiable {
    let id = UUID()
    let workDir: String
    /// The SwiftTerm view is owned here too: its scrollback IS the session.
    let view: TerminalView
    private(set) var process: PTYProcess?
    private(set) var exitStatus: Int32?
    /// Bytes that arrived before the view was in a window. Fed on attach.
    private var pending = Data()
    private var attached = false

    init(workDir: String) {
        self.workDir = workDir
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
    private(set) var sessions: [String: TerminalSession] = [:]

    /// The session for a project, created on first use.
    func session(for workDir: String) -> TerminalSession {
        if let s = sessions[workDir] { return s }
        let s = TerminalSession(workDir: workDir)
        sessions[workDir] = s
        return s
    }

    /// Hang up every shell. Called from `applicationWillTerminate`.
    func terminateAll() {
        for s in sessions.values { s.terminate() }
        sessions.removeAll()
    }
}
