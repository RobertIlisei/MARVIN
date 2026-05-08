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

// MARK: - File save (Phase 5c)

/// Wire response for POST /api/files/write/save. Returned on a
/// successful write so the client can refresh its mtime tracking
/// without a re-read round-trip. The route also returns the new
/// `size` after the write — useful for size-aware UI (truncation
/// warning, dirty-indicator with byte delta).
///
/// 409 stale responses come back as a different shape
/// `{ error: "stale", currentMtime, size }` and are decoded on the
/// error path; this struct only models the 2xx success body.
struct FileSaveResponse: Codable, Equatable {
    /// Echo of the absolute path the sidecar wrote to.
    let path: String
    /// New modification timestamp in milliseconds since the unix
    /// epoch — what the client should store as the next save's
    /// `expectedMtime`.
    let mtime: Double
    /// Bytes written. The viewer doesn't surface this directly today
    /// but it's useful for the "truncated" badge re-evaluation: if
    /// the new size still exceeds maxSize the badge stays.
    let size: Int
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

// MARK: - Git status (porcelain v2 + branch)

/// Wire response for GET /api/git/status. Mirrors the
/// `StatusResult` shape from packages/git/src/parse-porcelain-v2.ts.
/// Returned when the cwd is inside a git work tree; the alternate
/// `{ enabled: false, reason: ... }` shape comes back for non-git
/// directories (modeled with the same struct via optional fields).
///
/// Phase 3e — drives the native SourceControlView header (branch +
/// ahead/behind) and per-file row sections. Forward-compatible with
/// `decodeIfPresent` on every non-required field, matching the
/// pattern used elsewhere in this file.
struct GitStatusResponse: Codable, Equatable {
    let enabled: Bool
    /// Set when `enabled: false` — reason the panel renders the
    /// disabled state ("not-a-git-repo" today; future runtimes may
    /// add others). Nil when enabled.
    let reason: String?
    /// Set when the wrapped `git status` invocation failed. The
    /// route returns 502 in that case but we model it so the caller
    /// can render an inline error instead of a hard throw.
    let error: String?
    let branch: GitStatusBranch?
    let files: [GitStatusFile]?
}

/// Branch + upstream metadata. Every field is nullable per the
/// porcelain shape — `oid` is null on a fresh repo with no commits,
/// `name` is null in detached HEAD, `upstream` is null when no
/// remote tracking, and `ahead`/`behind` are null when no upstream.
struct GitStatusBranch: Codable, Equatable {
    let oid: String?
    let name: String?
    let upstream: String?
    let ahead: Int?
    let behind: Int?
}

/// Per-file entry from the porcelain v2 stream. `indexStatus` and
/// `workingStatus` are the two single-character codes git emits:
/// "." (no change), "M" (modified), "A" (added), "D" (deleted),
/// "R" (renamed), "C" (copied), "U" (unmerged), "T" (type-changed),
/// "?" (untracked/ignored).
///
/// `entryType` is the renderer-friendly disambiguator the parser
/// adds: `ordinary | rename-copy | unmerged | untracked | ignored`.
/// Phase 3e routes rows into sections by this field, not by the
/// raw status codes.
struct GitStatusFile: Codable, Equatable {
    let path: String
    let indexStatus: String
    let workingStatus: String
    let renamedFrom: String?
    let ordinary: Bool
    let entryType: String
}

// MARK: - Git diff (unified)

/// Wire response for GET /api/git/diff. The `mode` echoes back what
/// the caller asked for (`working` / `staged` / `head`); `diff` is
/// the raw unified diff text from `git diff`. Phase 3f renders this
/// in a native sheet with monospace font + per-line tinting; the
/// Monaco-quality side-by-side renderer is deferred to Phase 5.
///
/// `binary` is true when git's numstat reports a binary file —
/// `diff` is empty in that case, and the viewer should render a
/// "binary file" placeholder rather than attempting to display
/// nothing. `truncated` is true when the diff exceeded the route's
/// 2 MB cap; same handling as binary (placeholder + read-only).
struct GitDiffResponse: Codable, Equatable {
    let path: String
    let mode: String
    let diff: String
    let binary: Bool
    let truncated: Bool
}

// MARK: - Git mutations (Phase 3g)

/// Generic "operation succeeded" body shape. The mutation routes
/// emit slightly different keys (`staged`, `unstaged`, `discarded`)
/// alongside the count, but the count itself is what the UI surfaces.
/// Phase 3g treats the success path as opaque — the SCM panel
/// re-fetches /api/git/status after every mutation, so we don't
/// rely on the response body for state.
struct GitMutationOk: Codable, Equatable {
    let ok: Bool
}

/// 409 needs-confirm response body. Returned when the mutation hits
/// a `confirm`-class policy decision (working-tree discard,
/// commit --amend on pushed HEAD, etc.). The `op` echo is what the
/// UI re-sends to /api/git/confirm to mint a token.
///
/// Modeled with the same struct that decodes other 4xx git error
/// shapes — `severity` and `op` are nullable so a `policy-deny`
/// (403) or `token-rejected` (409 from the confirm route) response
/// also decodes cleanly with the optional fields nil.
struct GitErrorResponse: Codable, Equatable {
    let error: String
    let severity: String?
    let reason: String?
    /// Op echo. Stored as raw ChatJSON so the confirm-token request
    /// can re-send the exact same shape the server expects without
    /// the Swift client needing a faithful Codable model of every
    /// op variant.
    let op: ChatJSON?
}

/// Response from POST /api/git/confirm — the minted token + its
/// metadata. The token is consumed once via the X-Marvin-Confirmed
/// header on a subsequent call to the original mutation route.
/// `expiresIn` is a number of seconds; the registry's default
/// today is 60s.
struct GitConfirmTokenResponse: Codable, Equatable {
    let token: String
    let expiresIn: Int
    let severity: String?
    let reason: String?
}
