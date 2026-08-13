// BacklogService — ADR-0044.
// Reads/mutates the project backlog over the sidecar's /api/backlog routes,
// which delegate to the shared `backlog.ts` store (the same code the
// marvin-backlog MCP tool writes through). @MainActor singleton, mirroring
// BranchService / ChatService conventions (x-marvin-client header, JSON).

import Foundation

struct BacklogItem: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let body: String
    let status: String     // provisional | open | doing | done | dismissed
    let severity: String   // low | med | high
    let created: String
}

/// One groom finding (ADR-0063) — something that looks wrong with a backlog
/// item. A HEURISTIC, not a verdict: the panel surfaces it next to the item and
/// the user decides. Nothing here is ever applied automatically.
struct BacklogFinding: Codable, Identifiable, Equatable {
    /// duplicate | dangling-reference | unreviewed | aging-high-severity | stale
    let kind: String
    /// The backlog item this is about — matches `BacklogItem.id`.
    let id: String
    let title: String
    let severity: String
    let status: String
    /// Other items in the same duplicate cluster; empty for other kinds.
    let relatedIds: [String]
    /// What was observed, one line.
    let detail: String
    /// What the user might do about it.
    let suggestion: String

    /// An item can draw more than one finding, so the item id alone isn't
    /// unique in a ForEach.
    var findingId: String { "\(kind)|\(id)" }

    /// Short label for the row badge.
    var badge: String {
        switch kind {
        case "duplicate": return "duplicate"
        case "dangling-reference": return "file gone"
        case "unreviewed": return "unreviewed"
        case "aging-high-severity": return "aging high"
        case "stale": return "stale"
        default: return kind
        }
    }
}

@MainActor
final class BacklogService {
    static let shared = BacklogService()

    private let baseURL = ServerConfig.baseURL
    private let session: URLSession
    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        self.session = URLSession(configuration: config)
    }

    private struct ListResponse: Codable { let items: [BacklogItem] }
    private struct GroomResponse: Codable {
        let scanned: Int
        let live: Int
        let truncated: Bool
        let findings: [BacklogFinding]
    }
    /// POST /api/backlog. `related` is optional so an older sidecar bundle
    /// (one without the ADR-0044 addendum) still decodes.
    private struct AddResponse: Codable { let related: [BacklogItem]? }
    private struct PromoteResponse: Codable { let ok: Bool?; let url: String?; let error: String? }

    /// Fetch backlog items, optionally filtered by status.
    func fetch(workDir: String, status: String? = nil) async throws -> [BacklogItem] {
        var comps = URLComponents(
            url: baseURL.appendingPathComponent("api/backlog"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [URLQueryItem(name: "workDir", value: workDir)]
        if let status { comps.queryItems?.append(URLQueryItem(name: "status", value: status)) }
        guard let url = comps.url else { throw URLError(.badURL) }

        var req = URLRequest(url: url)
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        let (data, resp) = try await session.data(for: req)
        try Self.ensure2xx(resp)
        return try JSONDecoder().decode(ListResponse.self, from: data).items
    }

    /// Count of active items — drives the tray chip. Includes `provisional`
    /// (ADR-0047) so auto-captured items nudge the user to review them.
    func openCount(workDir: String) async -> Int {
        guard let items = try? await fetch(workDir: workDir) else { return 0 }
        return items.filter { $0.status == "provisional" || $0.status == "open" || $0.status == "doing" }.count
    }

    /// Review the backlog (ADR-0063) and return what looks wrong.
    ///
    /// READ-ONLY — the route has no write path. Findings are heuristics for the
    /// user to judge; the panel renders them beside the items and resolving is
    /// still an explicit action through the existing mutating calls.
    func groom(workDir: String) async throws -> (findings: [BacklogFinding], truncated: Bool) {
        var comps = URLComponents(
            url: baseURL.appendingPathComponent("api/backlog/groom"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [URLQueryItem(name: "workDir", value: workDir)]
        var req = URLRequest(url: comps.url!)
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        let (data, resp) = try await session.data(for: req)
        try Self.ensure2xx(resp)
        let decoded = try JSONDecoder().decode(GroomResponse.self, from: data)
        return (decoded.findings, decoded.truncated)
    }

    /// Manually add an item from the panel.
    ///
    /// Returns the LIVE items that look like the same work (ADR-0044 addendum)
    /// — exact-title dedup can't see a reworded duplicate, so the panel warns
    /// instead. Advisory: the item is written regardless, and nothing else is
    /// touched. Empty for the common case.
    @discardableResult
    func add(
        workDir: String,
        title: String,
        body: String?,
        severity: String?
    ) async throws -> [BacklogItem] {
        let data = try await mutate(method: "POST", path: "api/backlog", payload: [
            "workDir": workDir,
            "title": title,
            "body": body ?? "",
            "severity": severity ?? "med",
        ])
        // Tolerate a sidecar that predates the field — an older bundle just
        // means no hint, not a failed add.
        return (try? JSONDecoder().decode(AddResponse.self, from: data))?.related ?? []
    }

    /// Set an item's status (done / dismissed / doing / open).
    func setStatus(workDir: String, id: String, status: String, note: String? = nil) async throws {
        var payload: [String: String] = ["workDir": workDir, "id": id, "status": status]
        if let note { payload["note"] = note }
        try await mutate(method: "PATCH", path: "api/backlog", payload: payload)
    }

    /// Field edit from the detail view — severity and/or body REPLACE the
    /// stored values (PATCH without a status change). Title is immutable:
    /// the slug/id/filename derive from it.
    func update(workDir: String, id: String, severity: String? = nil, body: String? = nil) async throws {
        var payload: [String: String] = ["workDir": workDir, "id": id]
        if let severity { payload["severity"] = severity }
        if let body { payload["body"] = body }
        try await mutate(method: "PATCH", path: "api/backlog", payload: payload)
    }

    /// Optional export — file the item as a GitHub issue. Returns the issue URL.
    func promoteIssue(workDir: String, id: String) async throws -> String {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/backlog/promote-issue"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["workDir": workDir, "id": id])
        let (data, resp) = try await session.data(for: req)
        let parsed = try? JSONDecoder().decode(PromoteResponse.self, from: data)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let url = parsed?.url, !url.isEmpty else {
            throw BacklogError.message(parsed?.error ?? "GitHub export failed")
        }
        return url
    }

    // MARK: - Internals

    @discardableResult
    private func mutate(method: String, path: String, payload: [String: String]) async throws -> Data {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, resp) = try await session.data(for: req)
        try Self.ensure2xx(resp)
        return data
    }

    private static func ensure2xx(_ resp: URLResponse) throws {
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }

    enum BacklogError: LocalizedError {
        case message(String)
        var errorDescription: String? { if case let .message(m) = self { return m }; return nil }
    }
}
