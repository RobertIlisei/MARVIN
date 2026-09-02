// PracticeService — ADR-0105.
// Reads and mutates the practice loop over the sidecar's /api/practice
// routes. @MainActor singleton, mirroring BacklogService conventions
// (x-marvin-client header, JSON, no-store).

import Foundation

struct PracticeSessionEntry: Codable, Equatable {
    let count: Int
    let cost: Double
    let lastAt: String
    let detail: String
}

struct PracticeFinding: Codable, Identifiable, Equatable {
    let id: String
    let kind: String
    /// failure | success
    let polarity: String
    /// observed | proposed | active | regressed | confirmed | dismissed | report | practice
    let state: String
    let firstSeen: String
    let lastSeen: String
    let sessions: [String: PracticeSessionEntry]
    let distinctSessions: Int
    let costTotal: Double
    let rate: Double?
    let value: Double
    let dismissReason: String?
    let ruleId: String?
    let sessionsAfter: Int?
    let recurrenceAfter: Int?
    /// Cost unit label, e.g. "commits", "seconds waited".
    let unit: String
    /// False for report-only kinds — no rule can be made from them.
    let template: Bool

    var isSuccess: Bool { polarity == "success" }
    var latestDetail: String {
        sessions.values.max(by: { $0.lastAt < $1.lastAt })?.detail ?? ""
    }
}

struct PracticeRuleMetrics: Codable, Equatable {
    let fired: Int
    let lastFiredAt: String?
    let bypasses: Int
}

struct PracticeRuleScope: Codable, Equatable {
    let projectId: String?
}

struct PracticeRule: Codable, Identifiable, Equatable {
    let id: String
    let fingerprint: String
    let title: String
    /// prompt | nudge | deny
    let tier: String
    let message: String
    /// active | retired
    let status: String
    let scope: PracticeRuleScope
    let metrics: PracticeRuleMetrics
    let acceptedAt: String
    let updatedAt: String

    var isGlobal: Bool { scope.projectId == nil }
}

struct PracticeRun: Codable, Identifiable, Equatable {
    let at: String
    let durationMs: Int
    let sessionsRead: Int
    let sessionsSkippedLive: Int
    let occurrences: Int
    let findingsNew: Int
    let recurring: Int
    let proposed: Int
    let confirmed: Int
    let regressed: Int
    let trigger: String
    var id: String { at }
}

struct PracticeThresholds: Codable, Equatable {
    var minSessions: Int
    var minValue: Double
}

struct PracticeConfig: Codable, Equatable {
    var enabled: Bool
    var hour: Int
    var thresholds: PracticeThresholds
    var verifyWindow: Int
}

struct PracticeView: Codable, Equatable {
    let projectId: String
    let config: PracticeConfig
    let findings: [PracticeFinding]
    let rules: [PracticeRule]
    let runs: [PracticeRun]
    let lastRun: PracticeRun?
}

@MainActor
final class PracticeService {
    static let shared = PracticeService()

    private let baseURL = ServerConfig.baseURL
    private let session: URLSession
    private init() {
        let config = URLSessionConfiguration.default
        // A backtest over a few hundred transcripts is I/O bound; give it room.
        config.timeoutIntervalForRequest = 120
        self.session = URLSession(configuration: config)
    }

    private struct RunResponse: Decodable { let run: PracticeRun; let view: PracticeView }
    private struct MutationResponse: Decodable { let ok: Bool; let error: String?; let view: PracticeView? }
    private struct ConfigResponse: Decodable { let config: PracticeConfig }

    func load(projectId: String) async throws -> PracticeView {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/practice"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "projectId", value: projectId)]
        var req = URLRequest(url: comps.url!)
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        let (data, response) = try await session.data(for: req)
        try Self.check(response, data)
        return try JSONDecoder().decode(PracticeView.self, from: data)
    }

    func run(projectId: String, force: Bool) async throws -> PracticeView {
        let data = try await post("api/practice/run", ["projectId": projectId, "force": force])
        return try JSONDecoder().decode(RunResponse.self, from: data).view
    }

    func approve(projectId: String, id: String, tier: String?, global: Bool) async throws -> PracticeView {
        var body: [String: Any] = ["projectId": projectId, "id": id, "action": "approve", "global": global]
        if let tier { body["tier"] = tier }
        return try await mutate("api/practice/findings", body)
    }

    func dismiss(projectId: String, id: String, reason: String) async throws -> PracticeView {
        try await mutate("api/practice/findings", ["projectId": projectId, "id": id, "action": "dismiss", "reason": reason])
    }

    func escalate(projectId: String, id: String) async throws -> PracticeView {
        try await mutate("api/practice/findings", ["projectId": projectId, "id": id, "action": "escalate"])
    }

    func updateRule(projectId: String, id: String, tier: String? = nil, status: String? = nil, global: Bool? = nil) async throws -> PracticeView {
        var body: [String: Any] = ["projectId": projectId, "id": id]
        if let tier { body["tier"] = tier }
        if let status { body["status"] = status }
        if let global { body["global"] = global }
        return try await mutate("api/practice/rules", body)
    }

    func updateConfig(enabled: Bool? = nil, hour: Int? = nil) async throws -> PracticeConfig {
        var config: [String: Any] = [:]
        if let enabled { config["enabled"] = enabled }
        if let hour { config["hour"] = hour }
        let data = try await post("api/practice", ["config": config])
        return try JSONDecoder().decode(ConfigResponse.self, from: data).config
    }

    // MARK: - Plumbing

    private func mutate(_ path: String, _ body: [String: Any]) async throws -> PracticeView {
        let data = try await post(path, body)
        let res = try JSONDecoder().decode(MutationResponse.self, from: data)
        guard res.ok, let view = res.view else {
            throw PracticeError.server(res.error ?? "request failed")
        }
        return view
    }

    private func post(_ path: String, _ body: [String: Any]) async throws -> Data {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: req)
        try Self.check(response, data)
        return data
    }

    private static func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw PracticeError.server("bad response") }
        guard (200..<300).contains(http.statusCode) else {
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw PracticeError.server(body?["error"] as? String ?? "HTTP \(http.statusCode)")
        }
    }
}

enum PracticeError: LocalizedError {
    case server(String)
    var errorDescription: String? {
        switch self {
        case .server(let message): return message
        }
    }
}
