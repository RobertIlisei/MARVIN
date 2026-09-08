// PTYProcess — a child process on a pseudo-terminal (ADR-0078).
//
// This is what makes the terminal a terminal. The previous pane ran every
// command as a fresh `$SHELL -c` through the sidecar: `cd` never persisted,
// Ctrl-C did nothing, no colours, no `vim`. A PTY gives the shell what it
// expects — a tty on fds 0/1/2, a window size, job control — so it behaves
// exactly as in Terminal.app.
//
// ## The load-bearing detail (corrected 2026-09-09)
//
// The child must ACQUIRE the slave as its controlling terminal, and that
// takes a session leader opening the tty — or `ioctl(TIOCSCTTY)`. The first
// version used `posix_spawn` with `POSIX_SPAWN_SETSID` and opened the slave
// as fd 0 through a file action, on the belief that the open happened after
// `setsid`. Measured on 2026-09-09: it does not. `cat` spawned that way ends
// with no controlling tty (`ps` tty `??`, foreground group 0), and so did
// the user's zsh — Ctrl-C echoed as `^C` and stopped nothing, because the
// line discipline's SIGINT had no foreground process group to go to. The
// test suite had passed only because bash-as-`/bin/sh` re-opens its tty by
// name at job-control init and attaches itself; zsh does not.
//
// So this is `forkpty(3)`: `openpty` + `fork` + `login_tty` (`setsid`,
// `TIOCSCTTY`, dup onto 0/1/2), the way every terminal emulator does it.
// The child runs only async-signal-safe calls between the fork and the
// `execve` — signal reset, `chdir`, exec — with every C string and array
// built BEFORE the fork, so nothing in the child touches the allocator or
// the Swift runtime. The tests pin the acquisition with `zsh -f`, the shell
// that does not attach itself.
//
// ## Why in-process (not node-pty in the sidecar)
//
// A second native Mach-O in the bundle blocks notarization; Next cannot
// hold a WebSocket in standalone, so every keystroke would be an HTTP
// round-trip; and a sidecar-owned shell outlives an app crash as an orphan.
// Here the shell is a child of the app and dies with it.
//
// Reads and the exit wait run on two plain blocking threads — `read(2)` on
// the master and `waitpid(2)` on the child — the way every terminal
// emulator does it. A `DispatchSource` process watcher was tried first and
// crashed in `_dispatch_source_merge_evt` on the first exit. Callers hop to
// the main actor themselves. No Foundation `Process` — it cannot attach a
// controlling tty.

import Darwin
import Foundation

/// File scope on purpose: inside the class, `signal` is the static
/// `signal(from:)` and shadows the C call.
private func resetSignalDispositions() {
    for s: Int32 in 1..<32 { signal(s, SIG_DFL) }
}

public final class PTYProcess {
    public enum PTYError: Error, CustomStringConvertible {
        case fork(Int32)

        public var description: String {
            switch self {
            case .fork(let e): return "forkpty failed: \(String(cString: strerror(e)))"
            }
        }
    }

    public let pid: pid_t
    private let master: Int32
    private let queue = DispatchQueue(label: "marvin.pty", qos: .userInteractive)
    private var exited = false
    private let lock = NSLock()

    /// Bytes from the child. Called on a background queue.
    public var onOutput: ((Data) -> Void)?
    /// The child exited. `status` is the raw wait status; use `exitCode`.
    public var onExit: ((Int32) -> Void)?

    /// Spawn `executable` on a new pty.
    ///
    /// - `argv0` lets the shell be a login shell (`-zsh`); the executable
    ///   path is passed separately so `argv[0]` need not be a real path.
    public init(
        executable: String,
        argv0: String? = nil,
        arguments: [String] = [],
        environment: [String: String],
        workingDirectory: String,
        columns: Int,
        rows: Int
    ) throws {
        // Size the pty BEFORE the child starts so its first `ioctl(TIOCGWINSZ)`
        // (zsh's prompt, vim's layout) sees real numbers, not 0×0. `forkpty`
        // applies it to the slave it opens, once, in the parent.
        var size = winsize(ws_row: UInt16(rows), ws_col: UInt16(columns), ws_xpixel: 0, ws_ypixel: 0)

        // Everything the child will hand to execve, built here in the parent.
        let argv: [String] = [argv0 ?? executable] + arguments
        let cArgv: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
        let cEnv: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        let argvBuf = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: cArgv.count)
        argvBuf.initialize(from: cArgv, count: cArgv.count)
        let envBuf = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: cEnv.count)
        envBuf.initialize(from: cEnv, count: cEnv.count)
        let cPath = strdup(executable)
        let cCwd = strdup(workingDirectory)
        defer {
            cArgv.forEach { free($0) }
            cEnv.forEach { free($0) }
            argvBuf.deallocate()
            envBuf.deallocate()
            free(cPath)
            free(cCwd)
        }

        var master: Int32 = -1
        let pid = forkpty(&master, nil, nil, &size)
        guard pid >= 0 else { throw PTYError.fork(errno) }
        if pid == 0 {
            // CHILD. `login_tty` has run: new session, the slave is the
            // controlling tty, fds 0/1/2 point at it. Only async-signal-safe
            // calls from here to execve. The app process ignores SIGPIPE and
            // masks others; the shell must start with defaults or Ctrl-C's
            // SIGINT would be ignored by every program it runs.
            var none = sigset_t()
            sigemptyset(&none)
            sigprocmask(SIG_SETMASK, &none, nil)
            resetSignalDispositions()
            _ = chdir(cCwd) // a missing directory starts the shell where it is; not fatal
            execve(cPath, argvBuf, envBuf)
            _exit(127)
        }

        self.pid = pid
        self.master = master
        _ = ioctl(master, TIOCSWINSZ, &size)
        startReading()
        watchExit()
    }

    private func startReading() {
        let master = self.master
        let thread = Thread { [weak self] in
            var buf = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let n = buf.withUnsafeMutableBytes { Darwin.read(master, $0.baseAddress, $0.count) }
                if n > 0 {
                    let data = Data(buf[0..<n])
                    self?.onOutput?(data)
                    continue
                }
                // 0 = EOF; EIO = slave closed (shell exited); EINTR = retry.
                if n < 0 && errno == EINTR { continue }
                break
            }
        }
        thread.name = "marvin.pty.read"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    private func watchExit() {
        let pid = self.pid
        let thread = Thread { [weak self] in
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
            guard let self else { return }
            self.lock.lock()
            let first = !self.exited
            self.exited = true
            self.lock.unlock()
            if first { self.onExit?(status) }
        }
        thread.name = "marvin.pty.wait"
        thread.start()
    }

    /// Send bytes to the child — keystrokes, including control characters
    /// (0x03 is Ctrl-C; the line discipline turns it into SIGINT for the
    /// foreground group).
    public func write(_ data: Data) {
        guard !data.isEmpty else { return }
        data.withUnsafeBytes { buf in
            var offset = 0
            while offset < buf.count {
                let n = Darwin.write(master, buf.baseAddress! + offset, buf.count - offset)
                if n <= 0 { break }
                offset += n
            }
        }
    }

    public func write(_ text: String) {
        write(Data(text.utf8))
    }

    /// Tell the child the window changed; delivers SIGWINCH.
    public func resize(columns: Int, rows: Int) {
        var size = winsize(ws_row: UInt16(max(1, rows)), ws_col: UInt16(max(1, columns)), ws_xpixel: 0, ws_ypixel: 0)
        _ = ioctl(master, TIOCSWINSZ, &size)
    }

    public var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !exited
    }

    /// Hang up: SIGHUP to the whole session, which is what closing a
    /// Terminal.app window does. Escalates to SIGKILL after `grace`.
    public func terminate(grace: TimeInterval = 1.5) {
        guard isRunning else { return }
        kill(-pid, SIGHUP)
        let pid = self.pid
        queue.asyncAfter(deadline: .now() + grace) { [weak self] in
            if self?.isRunning == true { kill(-pid, SIGKILL) }
        }
    }

    /// Exit code from a raw wait status, or nil if killed by a signal.
    public static func exitCode(from status: Int32) -> Int32? {
        (status & 0x7f) == 0 ? (status >> 8) & 0xff : nil
    }

    /// Terminating signal from a raw wait status, or nil on normal exit.
    public static func signal(from status: Int32) -> Int32? {
        (status & 0x7f) != 0 ? status & 0x7f : nil
    }

    deinit {
        if isRunning { kill(-pid, SIGKILL) }
        close(master)
    }
}
