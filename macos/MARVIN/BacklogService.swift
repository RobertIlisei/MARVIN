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
    let status: String     // open | doing | done | dismissed
    let severity: String   // low | med | high
    let created: String
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

    /// Count of active (open + doing) items — drives the tray chip.
    func openCount(workDir: String) async -> Int {
        guard let items = try? await fetch(workDir: workDir) else { return 0 }
        return items.filter { $0.status == "open" || $0.status == "doing" }.count
    }

    /// Manually add an item from the panel.
    func add(workDir: String, title: String, body: String?, severity: String?) async throws {
        try await mutate(method: "POST", path: "api/backlog", payload: [
            "workDir": workDir,
            "title": title,
            "body": body ?? "",
            "severity": severity ?? "med",
        ])
    }

    /// Set an item's status (done / dismissed / doing / open).
    func setStatus(workDir: String, id: String, status: String, note: String? = nil) async throws {
        var payload: [String: String] = ["workDir": workDir, "id": id, "status": status]
        if let note { payload["note"] = note }
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

    private func mutate(method: String, path: String, payload: [String: String]) async throws {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (_, resp) = try await session.data(for: req)
        try Self.ensure2xx(resp)
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
