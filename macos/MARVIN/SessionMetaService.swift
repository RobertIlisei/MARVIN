// SessionMetaService — the per-session tree/lane/title record and the
// close-tab action (ADR-0107). Same shape as `PlanStateService`: static
// funcs, the `x-marvin-client` header on every mutating call, and errors
// surfaced as thrown values the caller can name in the UI.

import Foundation
import MARVINLogic

enum SessionMetaService {
    struct MetaWire: Decodable {
        let marvinSessionId: String
        let tree: SessionTreeWire
        let title: String?
        let closedAt: String?
        struct LastTurn: Decodable { let turnId: String; let outcome: String? }
        let lastTurn: LastTurn?
    }

    struct CloseResponse: Decodable {
        let ok: Bool
        let message: String?
        struct Worktree: Decodable { let slug: String; let branch: String; let action: String }
        let worktree: Worktree?
    }

    enum Failure: Error, LocalizedError {
        case http(Int, code: String?, message: String)
        var errorDescription: String? {
            switch self {
            case .http(_, _, let message): return message
            }
        }
        var code: String? {
            if case .http(_, let c, _) = self { return c }
            return nil
        }
    }

    private static var baseURL: URL { ServerConfig.baseURL }

    static func load(projectId: String, sessionId: String) async -> MetaWire? {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/sessions/meta"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "projectId", value: projectId), URLQueryItem(name: "sessionId", value: sessionId)]
        guard let url = comps.url else { return nil }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
        else { return nil }
        struct Envelope: Decodable { let meta: MetaWire? }
        return (try? JSONDecoder().decode(Envelope.self, from: data))?.meta
    }

    /// Switch a tab's tree. Leaving a worktree takes an optional action for
    /// the tree it leaves behind (merge / keep / discard); entering one cuts a
    /// fresh worktree from HEAD or reopens a kept one.
    static func setTree(projectId: String, sessionId: String, mode: SessionMode,
                        worktreeAction: TabCloseDecision.Action? = nil) async throws -> MetaWire {
        var body: [String: Any] = ["projectId": projectId, "sessionId": sessionId, "tree": mode.rawValue]
        if let worktreeAction { body["worktreeAction"] = worktreeAction.rawValue }
        return try await put(body)
    }

    static func setLane(projectId: String, sessionId: String, lane: [String]) async throws -> MetaWire {
        try await put(["projectId": projectId, "sessionId": sessionId, "lane": lane])
    }

    static func setTitle(projectId: String, sessionId: String, title: String) async throws -> MetaWire {
        try await put(["projectId": projectId, "sessionId": sessionId, "title": title])
    }

    static func reopen(projectId: String, sessionId: String) async throws -> MetaWire {
        try await put(["projectId": projectId, "sessionId": sessionId, "reopen": true])
    }

    /// POST /api/sessions/resume — a server-initiated turn picks up where a
    /// restart cut the session off. 202 on success.
    static func resume(projectId: String, sessionId: String) async throws {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/sessions/resume"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["projectId": projectId, "marvinSessionId": sessionId])
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw failure(status: status, data: data) }
    }

    private static func put(_ body: [String: Any]) async throws -> MetaWire {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/sessions/meta"))
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw failure(status: status, data: data) }
        struct Envelope: Decodable { let meta: MetaWire }
        return try JSONDecoder().decode(Envelope.self, from: data).meta
    }

    /// Close a tab, deciding its worktree's fate. `commitFirst` lets a merge
    /// commit uncommitted work in the worktree before folding it in.
    static func close(projectId: String, sessionId: String, action: TabCloseDecision.Action,
                      commitFirst: Bool = false) async throws -> CloseResponse {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/sessions/close"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "projectId": projectId, "marvinSessionId": sessionId,
            "worktree": action.rawValue, "commitFirst": commitFirst,
        ] as [String: Any])
        // A merge is real git work on the user's repository — `git status`,
        // `git merge`, a checkout of every changed file — and it is served
        // synchronously. `URLSession`'s default request timeout is 60 s, which
        // a merge into a large repository can exceed; the request would then
        // fail while the merge went on to SUCCEED server-side, and the user
        // would be told the close failed for work that actually landed.
        req.timeoutInterval = 600
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw failure(status: status, data: data) }
        return try JSONDecoder().decode(CloseResponse.self, from: data)
    }

    private static func failure(status: Int, data: Data) -> Failure {
        struct Err: Decodable { let error: String?; let code: String? }
        let parsed = try? JSONDecoder().decode(Err.self, from: data)
        return .http(status, code: parsed?.code, message: parsed?.error ?? "HTTP \(status)")
    }
}
