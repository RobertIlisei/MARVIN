// FilesService — HTTP client for /api/files/* + /api/git/* against
// the Node sidecar at localhost:3030. Phase 3a foundation per
// ADR-0018 §1.
//
// The shape mirrors ChatService (Phase 2) deliberately — same
// loopback baseURL, same x-marvin-client CSRF header, same
// HTTPS-not-needed (loopback only) ATS exception. Keeping the two
// services structurally similar means a future shared "MarvinAPI"
// helper (if/when we want one) can absorb both without a rewrite.
//
// Phase 3a scope: only the read endpoints needed to render a tree
// (GET /api/files/tree) and back it with file viewer data
// (GET /api/files/content) + the working-tree status feed
// (GET /api/files/status). Source-control mutations (stage / unstage
// / commit / discard) and the diff endpoint land in Phase 3e/3f when
// the corresponding UI surfaces start consuming them — adding them
// here pre-emptively would be speculative.

import Foundation

/// Errors surfaced by the files service. Mirrors ChatServiceError's
/// shape so a caller catching one already knows how to render the
/// other.
enum FilesServiceError: Error {
    /// Non-2xx HTTP response. Body is captured (size-capped) for
    /// log surfaces; structured error JSON would also land here as
    /// an opaque blob — pattern-match on status codes, not body.
    case httpStatus(Int, body: String?)
    /// JSON decode failure. The wire shape changed under us, or the
    /// sidecar emitted a malformed response.
    case decode(underlying: Error)
    /// URLSession-level network failure (loopback unreachable,
    /// timeout, etc.).
    case transport(underlying: Error)
}

@MainActor
final class FilesService {
    static let shared = FilesService()

    private let baseURL = URL(string: "http://localhost:3030")!
    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        // File reads are quick (single-shot JSON, not SSE). A 30s
        // ceiling is generous for a tree walk on a large repo and
        // tight enough to fail fast when the sidecar is wedged. The
        // ChatService SSE path uses 0 (disabled) because turns are
        // long-lived; the request shapes diverge enough that
        // reusing one URLSessionConfiguration would muddle both.
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)
    }

    // MARK: - File tree

    /// GET /api/files/tree?cwd=…&depth=…
    ///
    /// Returns the recursive tree from `cwd` down to `depth` levels,
    /// excluding the sandbox's IGNORE_DIR_NAMES (node_modules, dist,
    /// .git, etc.) and rejecting symlinks. Phase 3b consumes this to
    /// drive the native NSOutlineView / OutlineGroup render.
    func fetchTree(
        cwd: String,
        depth: Int? = nil
    ) async throws -> FileTreeResponse {
        let url = baseURL.appendingPathComponent("api/files/tree")
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        var items: [URLQueryItem] = [URLQueryItem(name: "cwd", value: cwd)]
        if let depth { items.append(URLQueryItem(name: "depth", value: String(depth))) }
        comps.queryItems = items
        return try await getJSON(url: comps.url!, as: FileTreeResponse.self)
    }

    // MARK: - File content

    /// GET /api/files/content?cwd=…&path=…
    ///
    /// Returns the file's text contents (or `binary: true` with no
    /// content for non-text files). Phase 3c uses this to drive a
    /// future native file viewer; until the Monaco port in Phase 5
    /// the existing web viewer remains the primary text renderer.
    func fetchContent(cwd: String, path: String) async throws -> FileContentResponse {
        let url = baseURL.appendingPathComponent("api/files/content")
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            URLQueryItem(name: "cwd", value: cwd),
            URLQueryItem(name: "path", value: path),
        ]
        return try await getJSON(url: comps.url!, as: FileContentResponse.self)
    }

    // MARK: - File status

    /// GET /api/files/status?cwd=…
    ///
    /// Working-tree status (porcelain v1, absolute-path keyed). Phase
    /// 3e parses the codes into per-section buckets — at the
    /// foundation layer we just hand the raw map back so future
    /// renderers don't have to round-trip through a Swift-side
    /// abstraction that may not match what the SCM panel needs.
    func fetchStatus(cwd: String) async throws -> FileStatusResponse {
        let url = baseURL.appendingPathComponent("api/files/status")
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "cwd", value: cwd)]
        return try await getJSON(url: comps.url!, as: FileStatusResponse.self)
    }

    // MARK: - Git status (porcelain v2)

    /// GET /api/git/status?cwd=…
    ///
    /// Richer working-tree status than /api/files/status — porcelain
    /// v2 with branch metadata, per-file index/working codes, rename
    /// sources, and entry-type discriminator. Phase 3e drives the
    /// native SourceControlView from this response. The web side
    /// uses ETag for poll efficiency; the native client doesn't poll
    /// today (manual + project-switch refresh) so we don't bother
    /// threading If-None-Match yet.
    func fetchGitStatus(cwd: String) async throws -> GitStatusResponse {
        let url = baseURL.appendingPathComponent("api/git/status")
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "cwd", value: cwd)]
        return try await getJSON(url: comps.url!, as: GitStatusResponse.self)
    }

    // MARK: - Git diff

    /// GET /api/git/diff?cwd=&path=&mode=working|staged|head
    ///
    /// Unified diff text for one repo-relative path. Phase 3f drives
    /// the native DiffSheet from this. The route defaults to
    /// `working` (working tree vs index); SCM rows for staged-only
    /// changes should pass `staged` (index vs HEAD); a "Combined"
    /// affordance maps to `head` (working tree vs HEAD).
    ///
    /// Path MUST be repo-relative (the route's `isSafePathspec`
    /// gate rejects absolute paths). Caller is responsible for
    /// stripping the cwd prefix; SourceControlRow already has a
    /// helper for that.
    func fetchDiff(
        cwd: String,
        path: String,
        mode: String = "working"
    ) async throws -> GitDiffResponse {
        let url = baseURL.appendingPathComponent("api/git/diff")
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            URLQueryItem(name: "cwd", value: cwd),
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "mode", value: mode),
        ]
        return try await getJSON(url: comps.url!, as: GitDiffResponse.self)
    }

    // MARK: - Git mutations (Phase 3g)

    /// Result of a mutation attempt. Auto-class ops resolve to
    /// `.ok`; confirm-class ops bounce back as `.needsConfirm` with
    /// the policy reason + op echo so the caller can mint a token
    /// and retry. Anything else (transport, deny, server error)
    /// throws via `FilesServiceError`.
    enum GitMutationOutcome {
        case ok
        case needsConfirm(severity: String, reason: String, op: ChatJSON)
    }

    /// POST /api/git/stage — body `{ cwd, paths }`. Auto-class for
    /// every path the policy admits; staging is reversible via
    /// /api/git/unstage so it never trips the confirm gate.
    func stage(cwd: String, paths: [String]) async throws -> GitMutationOutcome {
        try await postMutation(
            path: "api/git/stage",
            body: ["cwd": cwd, "paths": paths]
        )
    }

    /// POST /api/git/unstage — body `{ cwd, paths }`. Auto-class —
    /// the working tree is unaffected; only the index moves.
    func unstage(cwd: String, paths: [String]) async throws -> GitMutationOutcome {
        try await postMutation(
            path: "api/git/unstage",
            body: ["cwd": cwd, "paths": paths]
        )
    }

    /// POST /api/git/discard — body `{ cwd, paths, mode }`.
    /// `mode: "staged"` is auto (just unstages); `mode: "working"`
    /// is confirm-class (overwrites uncommitted edits, irreversible).
    /// Pass an `X-Marvin-Confirmed` token via `confirmToken` to
    /// resolve the confirm-class flow.
    func discard(
        cwd: String,
        paths: [String],
        mode: String,
        confirmToken: String? = nil
    ) async throws -> GitMutationOutcome {
        try await postMutation(
            path: "api/git/discard",
            body: ["cwd": cwd, "paths": paths, "mode": mode],
            confirmToken: confirmToken
        )
    }

    /// POST /api/git/commit — body `{ cwd, message, amend? }`.
    /// Normal commits are auto-class; `amend: true` on a pushed
    /// HEAD trips the confirm gate. The route uses `git commit -F -`
    /// internally so the message bytes never hit the argv — we just
    /// pass them through.
    func commit(
        cwd: String,
        message: String,
        amend: Bool = false,
        confirmToken: String? = nil
    ) async throws -> GitMutationOutcome {
        var body: [String: Any] = ["cwd": cwd, "message": message]
        if amend { body["amend"] = true }
        return try await postMutation(
            path: "api/git/commit",
            body: body,
            confirmToken: confirmToken
        )
    }

    /// POST /api/git/confirm — mint a one-shot token for a
    /// confirm-class op. The token is passed back via the
    /// `X-Marvin-Confirmed` header on a retry of the original
    /// mutation. The op echo from the 409 response is what the
    /// caller passes here — verbatim, so the registry's structural
    /// match check passes.
    func mintGitConfirmToken(
        cwd: String,
        op: ChatJSON
    ) async throws -> GitConfirmTokenResponse {
        let url = baseURL.appendingPathComponent("api/git/confirm")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        // Re-encode the op echo via JSONEncoder → JSONSerialization
        // round-trip so the embedded ChatJSON keeps its full
        // structure (object / array / number / etc.) without us
        // having to walk the enum and rebuild it as `Any`.
        let opData = try JSONEncoder().encode(op)
        let opAny = try JSONSerialization.jsonObject(with: opData)
        let body: [String: Any] = [
            "cwd": cwd,
            "op": opAny,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw FilesServiceError.transport(
                underlying: URLError(.badServerResponse)
            )
        }
        guard (200..<300).contains(http.statusCode) else {
            throw FilesServiceError.httpStatus(
                http.statusCode,
                body: String(data: data, encoding: .utf8)
            )
        }
        do {
            return try JSONDecoder().decode(GitConfirmTokenResponse.self, from: data)
        } catch {
            throw FilesServiceError.decode(underlying: error)
        }
    }

    /// Shared POST helper for the four git mutation routes. Handles
    /// the JSON encode, CSRF + (optional) confirm-token headers,
    /// and the auto/needs-confirm/error tri-state in the response.
    /// All four routes share the same envelope shape, so a single
    /// helper keeps the per-route methods declarative.
    private func postMutation(
        path: String,
        body: [String: Any],
        confirmToken: String? = nil
    ) async throws -> GitMutationOutcome {
        let url = baseURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        if let confirmToken {
            req.setValue(confirmToken, forHTTPHeaderField: "X-Marvin-Confirmed")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw FilesServiceError.transport(
                underlying: URLError(.badServerResponse)
            )
        }

        // 409 + needs-confirm → caller's confirm path. Other 4xx /
        // 5xx are real failures; surface the body for the UI.
        if http.statusCode == 409,
           let parsed = try? JSONDecoder().decode(GitErrorResponse.self, from: data),
           parsed.error == "needs-confirm",
           let op = parsed.op {
            return .needsConfirm(
                severity: parsed.severity ?? "warn",
                reason: parsed.reason ?? "policy requires confirmation",
                op: op
            )
        }
        guard (200..<300).contains(http.statusCode) else {
            throw FilesServiceError.httpStatus(
                http.statusCode,
                body: String(data: data, encoding: .utf8)
            )
        }
        return .ok
    }

    // MARK: - Private helpers

    /// Single-shot JSON GET. Adds the CSRF header, decodes into the
    /// requested type, and surfaces typed FilesServiceError cases.
    /// Inlines the body-cap on error to keep error logs from
    /// pulling 4 MB file contents into the surface — anything over
    /// 1 KB gets truncated.
    private func getJSON<T: Decodable>(
        url: URL,
        as: T.Type
    ) async throws -> T {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        // Same CSRF discipline as ChatService — apps/web/src/lib/csrf.ts
        // checks for exactly "x-marvin-client: 1". Read endpoints
        // don't strictly need the header (the guard mostly cares about
        // mutations), but applying it uniformly means we don't have
        // to track which endpoint enforces it as the surface grows.
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw FilesServiceError.transport(underlying: error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw FilesServiceError.transport(
                underlying: URLError(.badServerResponse)
            )
        }
        guard (200..<300).contains(http.statusCode) else {
            var body = String(data: data, encoding: .utf8) ?? ""
            if body.count > 1024 {
                body = String(body.prefix(1024)) + "…"
            }
            throw FilesServiceError.httpStatus(http.statusCode, body: body)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw FilesServiceError.decode(underlying: error)
        }
    }
}
