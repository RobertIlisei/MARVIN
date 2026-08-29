// FileSystemWatcher — FSEvents on the active project, so the file explorer
// shows what the agent just did without being told to look.
//
// ## Why this exists
//
// The tree fetched once on appear and once per project switch, and nothing
// else. An agent that created, renamed or deleted a file left the explorer
// showing the old world until the user hit refresh (user, 2026-08-29: "on
// antigravity … those are automatically propagated … but on marvin I need to
// manually refresh"). The header comment in `FileTreeView` still described a
// "15s refresh poll" — that poll had been removed, so the tree was static.
//
// ## Why FSEvents and not a timer
//
// A poll is wrong in both directions: too slow to feel live (an agent writes
// a file and the user waits out the interval), and pure waste the rest of the
// time — a 1s poll on an idle project is 3,600 whole-tree fetches an hour.
// FSEvents is the OS telling us, once, that something under this directory
// changed. `latency` lets the kernel coalesce a burst — an agent writing 40
// files arrives as one or two callbacks, not 40.
//
// ## What it deliberately ignores
//
// Directory churn the tree does not render anyway: `node_modules`, `.git`,
// build output, `graphify-out`. Mirrors `IGNORE_DIR_NAMES` in
// `sidecar/packages/tools/src/fs-constants.ts`, which is what the tree
// endpoint filters on — a refresh triggered by a path the tree will not show
// is a refetch that cannot change anything on screen. `.git` matters most:
// every `git status` the app already runs writes lock files inside it, so
// without this the watcher would retrigger off MARVIN's own polling.

// Lives in MARVINLogic rather than the app target so `MARVINTests` can link
// it (ADR-0022) — the plumbing below is the risky part (a C callback, an
// Unmanaged retain/release pair, a pointer cast), and "it compiled" is not
// evidence that it fires.

import CoreServices
import Foundation

public final class FileSystemWatcher {
    /// Directory names whose contents never reach the tree. Keep in step with
    /// `IGNORE_DIR_NAMES` (`fs-constants.ts`); a name missing here costs
    /// pointless refreshes, never correctness.
    private static let ignoredComponents: Set<String> = [
        "node_modules", ".git", ".next", ".turbo", "dist", "build", "out",
        ".venv", "venv", "__pycache__", "coverage", ".parcel-cache", ".cache",
        ".pytest_cache", ".mypy_cache", ".ruff_cache", "target", "vendor",
        "graphify-out", ".build", ".swiftpm", "DerivedData",
    ]

    /// Kernel-side coalescing window. Long enough that a burst of agent writes
    /// is one callback; short enough that a single `touch` feels immediate.
    private static let latency: CFTimeInterval = 0.35

    private var stream: FSEventStreamRef?
    private let path: String
    private let onChange: () -> Void
    /// Serial queue the stream is scheduled on — never the main queue, so a
    /// noisy tree cannot compete with the UI for the main run loop.
    private let queue = DispatchQueue(label: "net.marvin.fswatch", qos: .utility)

    public init(path: String, onChange: @escaping () -> Void) {
        self.path = path
        self.onChange = onChange
    }

    deinit { stopStream() }

    public func start() {
        stopStream()
        guard !path.isEmpty, FileManager.default.fileExists(atPath: path) else { return }

        // `self` is handed to a C callback, so it must be retained for the
        // stream's lifetime and released in the release callback — the stream
        // outlives any Swift reference the caller keeps if `stop()` is missed.
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passRetained(self).toOpaque(),
            retain: nil,
            release: { info in
                guard let info else { return }
                Unmanaged<FileSystemWatcher>.fromOpaque(info).release()
            },
            copyDescription: nil
        )

        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info else { return }
            let watcher = Unmanaged<FileSystemWatcher>.fromOpaque(info).takeUnretainedValue()
            // With `kFSEventStreamCreateFlagUseCFTypes` the paths argument is a
            // CFArray of CFString — NOT the `char **` the classic C signature
            // suggests. Reading it as a C array compiles cleanly and then
            // decodes garbage, so `isRelevant` would reject every real path and
            // the tree would never refresh. Confirmed against a standalone
            // FSEvents probe, which printed the real path only under the
            // CFArray reading.
            guard let list = unsafeBitCast(paths, to: CFArray.self) as? [String] else {
                watcher.fire()  // can't inspect the batch — refreshing is the safe side
                return
            }
            _ = count
            // One refresh per batch, and only when a path is something the
            // tree would actually render.
            if list.contains(where: { watcher.isRelevant($0) }) {
                watcher.fire()
            }
        }

        // `NoDefer` — deliver at the START of the latency window, so the first
        // change of a burst lands immediately and the rest are coalesced
        // behind it. WatchRoot so a rename of the project directory itself is
        // still reported rather than silently detaching the stream.
        let flags = UInt32(
            kFSEventStreamCreateFlagUseCFTypes
                | kFSEventStreamCreateFlagNoDefer
                | kFSEventStreamCreateFlagWatchRoot
        )
        guard let created = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            [path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            Self.latency,
            flags
        ) else {
            // The retain above is balanced by the release callback only when a
            // stream exists to own it.
            Unmanaged.passUnretained(self).release()
            return
        }

        stream = created
        FSEventStreamSetDispatchQueue(created, queue)
        FSEventStreamStart(created)
    }

    public func stop() { stopStream() }

    private func stopStream() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    /// True when a changed path is one the tree could show. Exposed so the
    /// ignore list is testable without provoking real filesystem events.
    public func isRelevant(_ changed: String) -> Bool {
        for component in changed.split(separator: "/") {
            if Self.ignoredComponents.contains(String(component)) { return false }
        }
        return true
    }

    private func fire() {
        let handler = onChange
        DispatchQueue.main.async { handler() }
    }
}
