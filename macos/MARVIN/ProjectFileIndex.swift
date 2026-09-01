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

    /// Candidate absolute paths for a mention. Empty until the index loads.
    func candidates(for mention: String) -> [String] {
        guard let workDir else { return [] }
        return FileMentionResolver.candidates(
            for: mention,
            workDir: workDir,
            index: byBasename,
            relativePaths: relativePaths
        )
    }

    /// Load (or reload) for `cwd`. Idempotent; a second call for the same
    /// project while one is in flight does nothing.
    func ensureLoaded(cwd: String?) {
        guard let cwd, !cwd.isEmpty else {
            workDir = nil
            byBasename = [:]
            relativePaths = []
            generation += 1
            return
        }
        guard cwd != workDir, !loading else { return }
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
            generation += 1
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
