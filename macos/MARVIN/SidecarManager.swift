// SidecarManager — spawn / monitor / tear down the bundled sidecar.
//
// Per ADR-0023, MARVIN.app/Contents/Resources/ ships the Next.js
// sidecar (server.js + .next + node_modules) plus a pinned Node 22
// binary. When the app is installed via Homebrew (or any path that
// drops MARVIN.app into /Applications), the SwiftUI process spawns
// the sidecar as a child process — quitting MARVIN cleans it up.
//
// In dev (running from `swift run` or Xcode), the bundled payload
// isn't present; the manager falls back to "external sidecar
// expected at localhost:3030" — which is what the existing dev loop
// (`pnpm dev` from the source repo) provides.
//
// Detection rule: bundled mode iff
//   Contents/Resources/node          exists + executable
//   Contents/Resources/sidecar/sidecar/server.js  exists
// (The double "sidecar/sidecar" path is correct — the Next standalone
// build with outputFileTracingRoot=.. emits the package directory at
// standalone/sidecar/, and bundle-sidecar.sh copies the standalone tree
// into Resources/sidecar/, so the entry sits at Resources/sidecar/sidecar/server.js.
// Resources/sidecar/node_modules/ is the deps tree Node walks up to.)

import AppKit
import Foundation

@MainActor
final class SidecarManager {
    static let shared = SidecarManager()
    private init() {}

    /// The running sidecar `Process`, if we spawned one. `nil` in dev
    /// mode (no bundled payload) or if the spawn failed.
    private var process: Process?

    /// File handle for the sidecar log. We capture stdout + stderr to
    /// `~/Library/Logs/MARVIN/sidecar.log` so the user (and the
    /// "Restart sidecar" surface, when we add it) has somewhere to
    /// look when the sidecar misbehaves.
    private var logHandle: FileHandle?

    /// The resolved sidecar log path. Exposed so the menu bar /
    /// settings can offer "Open log file…".
    var logPath: URL? {
        let logsDir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("Logs/MARVIN", isDirectory: true)
        return logsDir?.appendingPathComponent("sidecar.log")
    }

    /// Returns true if MARVIN.app was built with the bundled sidecar
    /// payload — i.e. this is a real install (Homebrew or
    /// `bin/marvin install-macos-app`), not a dev `swift run`.
    var isBundled: Bool {
        bundledNodeURL != nil && bundledServerURL != nil
    }

    private var bundledNodeURL: URL? {
        guard let resourceURL = Bundle.main.resourceURL else { return nil }
        let candidate = resourceURL.appendingPathComponent("node")
        guard FileManager.default.isExecutableFile(atPath: candidate.path) else { return nil }
        return candidate
    }

    private var bundledServerURL: URL? {
        guard let resourceURL = Bundle.main.resourceURL else { return nil }
        // Next standalone with outputFileTracingRoot=.. emits the
        // entry under sidecar/sidecar/ (package-name nested inside
        // the trace root). bundle-sidecar.sh preserves that layout.
        let candidate = resourceURL
            .appendingPathComponent("sidecar")
            .appendingPathComponent("sidecar")
            .appendingPathComponent("server.js")
        guard FileManager.default.fileExists(atPath: candidate.path) else { return nil }
        return candidate
    }

    /// Start the bundled sidecar. No-op (returns silently) when running
    /// in dev mode or the payload is absent. Idempotent — calling twice
    /// keeps the first process.
    func start() {
        guard process == nil else { return }
        guard let nodeURL = bundledNodeURL, let serverURL = bundledServerURL else {
            // Dev mode — caller (the SwiftUI offline view) will guide
            // the user to start the sidecar manually with `pnpm dev`.
            NSLog("SidecarManager: bundled payload absent — assuming external sidecar at :\(ServerConfig.port)")
            return
        }

        // Open / create the log file. We append rather than truncate
        // so a crash report kept across sessions stays readable. If
        // the file grows past 10 MB, rotate it once at startup.
        if let logURL = logPath {
            let dir = logURL.deletingLastPathComponent()
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            rotateLogIfNeeded(at: logURL)
            FileManager.default.createFile(
                atPath: logURL.path,
                contents: nil,
                attributes: nil
            )
            // Open for appending. If the rotate left a fresh empty
            // file, this still works.
            if let handle = try? FileHandle(forWritingTo: logURL) {
                _ = try? handle.seekToEnd()
                logHandle = handle
                let stamp = "[\(ISO8601DateFormatter().string(from: Date()))] starting bundled sidecar\n"
                try? logHandle?.write(contentsOf: Data(stamp.utf8))
            }
        }

        let proc = Process()
        proc.executableURL = nodeURL
        proc.arguments = [serverURL.path]
        // Working directory must be the sidecar package dir so Next's
        // standalone server.js resolves its `.next/` neighbour.
        proc.currentDirectoryURL = serverURL.deletingLastPathComponent()

        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(ServerConfig.port)
        env["HOSTNAME"] = "127.0.0.1"
        env["NODE_ENV"] = "production"
        // The SDK runner reads MARVIN_DATA_DIR for transcripts / cost
        // tracker / projects.json. Default matches the dev loop's
        // ~/.marvin layout so a brew install picks up an existing dev
        // user's data without surprise.
        if env["MARVIN_DATA_DIR"] == nil {
            let home = FileManager.default.homeDirectoryForCurrentUser
            env["MARVIN_DATA_DIR"] = home.appendingPathComponent(".marvin").path
        }
        // The bundled sidecar shouldn't fall through to Next's image
        // optimizer (we ship `images.unoptimized: true` in next.config),
        // but belt-and-braces: tell it not to look for sharp.
        env["NEXT_SHARP_PATH"] = ""
        proc.environment = env

        // Pipe stdout + stderr to the log file. Single Pipe → both
        // streams keep ordering relative to the sidecar's own writes.
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        if let logHandle {
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                try? logHandle.write(contentsOf: data)
            }
        }

        do {
            try proc.run()
            self.process = proc
            NSLog("SidecarManager: spawned pid=\(proc.processIdentifier) (\(serverURL.path))")
        } catch {
            NSLog("SidecarManager: spawn failed — \(error.localizedDescription)")
            logHandle?.closeFile()
            logHandle = nil
        }
    }

    /// Stop the bundled sidecar. SIGTERM with a 3 s grace, then
    /// SIGKILL. Safe to call from `applicationWillTerminate` —
    /// blocking the main thread up to 3 s on quit is acceptable for
    /// a cleanup path that prevents a leaked Node process.
    func stop() {
        guard let proc = process, proc.isRunning else {
            process = nil
            logHandle?.closeFile()
            logHandle = nil
            return
        }

        proc.terminate()  // SIGTERM
        let deadline = Date().addingTimeInterval(3.0)
        while proc.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        if proc.isRunning {
            // Hardcoded SIGKILL — Process has no .kill(), but the pid
            // is exposed.
            kill(proc.processIdentifier, SIGKILL)
        }
        process = nil
        logHandle?.closeFile()
        logHandle = nil
    }

    /// Rotate the sidecar log if it's grown past 10 MB. We keep one
    /// previous log (`sidecar.log.1`) and discard older ones —
    /// MARVIN's debugging signal is "what just happened", not "what
    /// happened three weeks ago," so a tiny ring is right.
    private func rotateLogIfNeeded(at url: URL) {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
        guard size > 10 * 1024 * 1024 else { return }
        let prev = url.appendingPathExtension("1")
        try? FileManager.default.removeItem(at: prev)
        try? FileManager.default.moveItem(at: url, to: prev)
    }
}
