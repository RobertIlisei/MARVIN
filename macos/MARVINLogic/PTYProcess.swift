// PTYProcess — a child process on a pseudo-terminal (ADR-0078).
//
// This is what makes the terminal a terminal. The previous pane ran every
// command as a fresh `$SHELL -c` through the sidecar: `cd` never persisted,
// Ctrl-C did nothing, no colours, no `vim`. A PTY gives the shell what it
// expects — a tty on fds 0/1/2, a window size, job control — so it behaves
// exactly as in Terminal.app.
//
// ## The load-bearing detail
//
// `POSIX_SPAWN_SETSID` makes the child a session leader, and THEN opening
// the slave as fd 0 makes that tty the child's CONTROLLING terminal (BSD
// semantics: the first tty a session leader opens becomes controlling).
// Without both, there is no foreground process group and Ctrl-C is
// silently swallowed while everything else looks perfect. The test suite
// pins this: `sleep 30` must die on 0x03.
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

public final class PTYProcess {
    public enum PTYError: Error, CustomStringConvertible {
        case openpt(Int32)
        case grantpt(Int32)
        case unlockpt(Int32)
        case ptsname
        case spawn(Int32)

        public var description: String {
            switch self {
            case .openpt(let e): return "posix_openpt failed: \(String(cString: strerror(e)))"
            case .grantpt(let e): return "grantpt failed: \(String(cString: strerror(e)))"
            case .unlockpt(let e): return "unlockpt failed: \(String(cString: strerror(e)))"
            case .ptsname: return "ptsname failed"
            case .spawn(let e): return "posix_spawn failed: \(String(cString: strerror(e)))"
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
        let master = posix_openpt(O_RDWR | O_NOCTTY)
        guard master >= 0 else { throw PTYError.openpt(errno) }
        guard grantpt(master) == 0 else { let e = errno; close(master); throw PTYError.grantpt(e) }
        guard unlockpt(master) == 0 else { let e = errno; close(master); throw PTYError.unlockpt(e) }
        guard let slavePath = ptsname(master).map({ String(cString: $0) }) else { close(master); throw PTYError.ptsname }

        // Size the pty BEFORE the child starts so its first `ioctl(TIOCGWINSZ)`
        // (zsh's prompt, vim's layout) sees real numbers, not 0×0.
        var size = winsize(ws_row: UInt16(rows), ws_col: UInt16(columns), ws_xpixel: 0, ws_ypixel: 0)
        _ = ioctl(master, TIOCSWINSZ, &size)

        var attrs: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attrs)
        defer { posix_spawnattr_destroy(&attrs) }
        // SETSID: new session, so the slave becomes the controlling tty when
        // opened below. SETSIGDEF/SETSIGMASK: the app process ignores
        // SIGPIPE and masks others; the shell must start with defaults or
        // Ctrl-C's SIGINT would be ignored by every program it runs.
        var all = sigset_t()
        sigfillset(&all)
        var none = sigset_t()
        sigemptyset(&none)
        posix_spawnattr_setsigdefault(&attrs, &all)
        posix_spawnattr_setsigmask(&attrs, &none)
        posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))

        var actions: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        // Open the slave as fd 0 in the CHILD (after setsid) — that open is
        // what attaches the controlling terminal. Then dup it onto 1 and 2.
        posix_spawn_file_actions_addopen(&actions, 0, slavePath, O_RDWR, 0)
        posix_spawn_file_actions_adddup2(&actions, 0, 1)
        posix_spawn_file_actions_adddup2(&actions, 0, 2)
        posix_spawn_file_actions_addclose(&actions, master)
        posix_spawn_file_actions_addchdir_np(&actions, workingDirectory)

        let argv: [String] = [argv0 ?? executable] + arguments
        let cArgv: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
        let cEnv: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            cArgv.forEach { free($0) }
            cEnv.forEach { free($0) }
        }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, executable, &actions, &attrs, cArgv, cEnv)
        guard rc == 0 else { close(master); throw PTYError.spawn(rc) }

        self.pid = pid
        self.master = master
        // The pre-spawn size does not survive the child's open of the slave
        // (observed: `stty size` read 0×0 until the first resize). Set it
        // again now; the child is still in exec and has not asked yet.
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
