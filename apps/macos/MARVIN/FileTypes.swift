// FileTypes — Codable models for the file-tree + source-control wire
// between the SwiftUI shell and the Node sidecar at apps/web. Phase
// 3a foundation per docs/decisions/0018-phase-3-files-source-control-native.md.
//
// We deliberately keep the type set narrow at the foundation layer:
// just the shapes Phase 3b (read-only tree) and 3c (selection wiring)
// need. Source-control specific types (porcelain v2 status, unified
// diff envelope, log entries) get added in 3e/3f when they're first
// consumed — adding them now would be speculative and the wire
// contract's "decide as it comes up" clause in ADR-0018 §5 covers it.
//
// Forward compatibility: every Codable struct uses
// `decodeIfPresent` for non-required fields — the sidecar can add
// new fields without breaking the Swift client (same convention as
// ChatTypes.swift in Phase 2).

import Foundation

// MARK: - File tree

/// One node in the file tree returned by GET /api/files/tree. Recursive
/// — a `dir` node carries its children inline. Identifiable so
/// SwiftUI's OutlineGroup can diff rows by stable id without an
/// `.id()` modifier per cell. The absolute path is the natural id —
/// it's unique and stable across walks.
struct FileNode: Codable, Identifiable, Equatable {
    /// Last path segment ("README.md", "src", …). Used as the row
    /// label; the full path lives in `path` for ops.
    let name: String
    /// Absolute path on disk. Sandbox-checked by the sidecar before
    /// emission, so any path the Swift side sees has already passed
    /// the symlink / escape policies in
    /// packages/runtime/src/fs-sandbox.ts.
    let path: String
    /// Discriminator — "file" or "dir". The wire today doesn't carry
    /// other types (symlinks are rejected upstream); we keep the raw
    /// String here rather than mapping to a Swift enum so a future
    /// "submodule" or "lfs" type doesn't need a Swift release to
    /// surface.
    let type: String
    /// Children for `dir` nodes; nil / empty for `file` nodes. The
    /// sidecar walks to its configured depth cap (default 10) and
    /// emits the full subtree inline; lazy-load-on-expand is a
    /// future change per ADR-0018 §4.
    let children: [FileNode]?

    var id: String { path }
    var isDirectory: Bool { type == "dir" }
}

/// Wire response for GET /api/files/tree.
struct FileTreeResponse: Codable, Equatable {
    /// Absolute root the walk started from. Echoed so the client
    /// doesn't have to re-resolve the cwd argument it sent.
    let root: String
    let tree: [FileNode]
    /// True when the walk hit the entry cap (default 20000) before
    /// finishing. The native tree should surface a banner when this
    /// flips so the user knows the listing is incomplete.
    let truncated: Bool
    /// Total entries emitted. Useful for the truncated banner ("17532
    /// of ~ files shown") and for telemetry once we add it.
    let count: Int
}

// MARK: - File content

/// Wire response for GET /api/files/content. Drives the file viewer
/// island — Phase 3b/c stays read-only on this; writes go through
/// /api/files/write in a later sub-phase or via the existing web
/// FileViewer until the native Monaco port lands in Phase 5.
struct FileContentResponse: Codable, Equatable {
    /// Absolute path the sidecar resolved (after sandbox checks).
    let path: String
    let size: Int
    /// Modification timestamp in milliseconds since the unix epoch.
    /// JSONDecoder reads this as Double; we store as Int64 by
    /// truncating — sub-millisecond precision isn't useful here.
    let mtime: Double
    /// Server-side cap. Files larger than this come back with
    /// `truncated: true` and `content` set to the first `maxSize`
    /// bytes. The Swift viewer should mount read-only in that case.
    let maxSize: Int
    /// True when the sidecar's binary heuristic flipped (>30% non-
    /// printable bytes in the first 4 KB). Binary files come back
    /// with `content: nil` — the caller should fall back to /raw or
    /// a "binary file, N bytes" placeholder.
    let binary: Bool
    let truncated: Bool
    /// UTF-8 decoded contents. Nil for binary files.
    let content: String?
}

// MARK: - File status (working-tree)

/// Wire response for GET /api/files/status. The `status` map is
/// keyed by ABSOLUTE path with the porcelain v1 two-char code
/// (trimmed) as the value: "M ", " M", "??", "A ", "MM", etc.
///
/// Phase 3a only models the shape; Phase 3e parses the codes into
/// per-section buckets (untracked / unstaged-modified / staged-
/// modified) for the SCM panel.
struct FileStatusResponse: Codable, Equatable {
    let isGit: Bool
    let branch: String?
    let status: [String: String]
}
