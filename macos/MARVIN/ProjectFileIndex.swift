// ProjectFileIndex — every file in the active project, by basename.
//
// Chat mentions files the way people do — `sdk-runner.ts`, not
// `sidecar/packages/runtime/src/sdk-runner.ts`. Linking those means being
// able to answer "where does that live", which needs the project's file list.
//
// Loaded ONCE per project from `/api/files/tree` (the same call Quick Open
// makes) and cached. Chat renders on every streamed token, so resolution has
// to be a dictionary lookup — walking the tree per render would re-typeset
// the transcript against a filesystem walk.
//
// A miss is silent by design: the index not being ready yet means a mention
// renders as plain text, which is what it did before. It is never a reason to
// block a render or show an error.

import Foundation
import MARVINLogic
import Observation

@MainActor
@Observable
final class ProjectFileIndex {
    static let shared = ProjectFileIndex()
    private init() {}

    /// Bumped whenever the index changes, so SwiftUI re-renders the transcript
    /// once the file list arrives and previously-plain mentions become links.
    private(set) var generation = 0

    private var workDir: String?
    private var byBasename: [String: [String]] = [:]
    private var relativePaths: Set<String> = []
    private var loading = false
    /// Memoised lookups, cleared on every (re)load.
    private var resolveCache: [String: [String]] = [:]
    private var refreshTask: Task<Void, Never>?

    /// Candidate absolute paths for a mention. Empty until the index loads.
    ///
    /// Falls back to a disk check for a literal relative path when the index
    /// has nothing. The index is a snapshot, and the files MARVIN mentions
    /// most are the ones it just WROTE — an audit report it generated this
    /// turn cannot be in a snapshot taken when the project opened, so those
    /// mentions rendered as plain text with no icon and no click (user,
    /// 2026-09-01). Refreshing on every turn (below) closes the bare-basename
    /// case; this closes the exact-path case immediately, without waiting for
    /// a refresh.
    ///
    /// Results are memoised because chat re-renders on every streamed token
    /// and this would otherwise be a `stat` per mention per frame. The cache
    /// is dropped whenever the index reloads, so a file appearing later is
    /// not remembered as absent forever.
    func candidates(for mention: String) -> [String] {
        guard let workDir else { return [] }
        if let hit = resolveCache[mention] { return hit }
        var out = FileMentionResolver.candidates(
            for: mention,
            workDir: workDir,
            index: byBasename,
            relativePaths: relativePaths
        )
        if out.isEmpty, !mention.hasPrefix("/") {
            let literal = (workDir as NSString).appendingPathComponent(mention)
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: literal, isDirectory: &isDir), !isDir.boolValue {
                out = [literal]
            }
        }
        resolveCache[mention] = out
        return out
    }

    /// Load (or reload) for `cwd`. Idempotent; a second call for the same
    /// project while one is in flight does nothing.
    func ensureLoaded(cwd: String?, force: Bool = false) {
        guard let cwd, !cwd.isEmpty else {
            workDir = nil
            byBasename = [:]
            relativePaths = []
            resolveCache = [:]
            generation += 1
            return
        }
        // `force` is for a reload of the SAME project after a turn wrote
        // files. It must not clear `workDir` first: the old index stays
        // serviceable while the new one loads, so mentions do not flicker
        // from link to plain text and back.
        guard force || cwd != workDir, !loading else { return }
        loading = true
        Task { @MainActor in
            defer { loading = false }
            guard let response = try? await FilesService.shared.fetchTree(cwd: cwd) else { return }
            var collected: [String] = []
            collected.reserveCapacity(4_000)
            Self.walk(response.tree, cwd: cwd, into: &collected)
            workDir = cwd
            relativePaths = Set(collected)
            byBasename = FileMentionResolver.buildIndex(collected)
            resolveCache = [:]
            generation += 1
        }
    }

    /// Reload after a turn that may have written files.
    ///
    /// Debounced, because a turn completing is not the only thing that fires
    /// and re-walking the tree is a real cost on a large project.
    func refreshAfterTurn(cwd: String?) {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            ensureLoaded(cwd: cwd, force: true)
        }
    }

    /// Flatten the tree to project-RELATIVE paths — the form a model writes
    /// and the form the resolver matches against.
    private static func walk(_ nodes: [FileNode], cwd: String, into out: inout [String]) {
        for node in nodes {
            if node.isDirectory {
                if let children = node.children { walk(children, cwd: cwd, into: &out) }
            } else if let rel = WorkspaceRelativePath.of(node.path, in: cwd), !rel.isEmpty {
                out.append(rel)
            }
        }
    }
}
