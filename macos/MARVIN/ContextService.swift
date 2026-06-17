// ContextService — fetches the per-category context-window estimate from
// `GET /api/context` for the status-bar context panel.
//
// The headline resident/window number is exact and comes from the live SDK
// usage already on MarvinBridge (`residentContextTokens`). This service only
// supplies the ESTIMATED fixed prefix (system prompt, tools, project-context
// sections) plus the model's context-window size, so the panel can break the
// total down and derive the transcript remainder.

import Foundation

/// Response shape of `GET /api/context`.
struct ContextEstimate: Codable, Sendable, Equatable {
    let model: String?
    let contextWindow: Int
    let estimate: Estimate

    struct Estimate: Codable, Sendable, Equatable {
        let systemPrompt: Int
        let tools: Int
        let projectContext: ProjectContext
    }

    struct ProjectContext: Codable, Sendable, Equatable {
        let total: Int
        let sections: [Section]
    }

    struct Section: Codable, Sendable, Equatable, Identifiable {
        let label: String
        let approxTokens: Int
        var id: String { label }
    }
}

@MainActor
final class ContextService {
    static let shared = ContextService()

    private let baseURL = ServerConfig.baseURL

    /// Fetch the context estimate for a project. `model` should be the
    /// resolved running model id (with any `[1m]` marker) so the window size
    /// is correct; `personality` selects the system-prompt variant.
    func fetch(
        workDir: String,
        model: String?,
        personality: String?
    ) async throws -> ContextEstimate {
        var comps = URLComponents(
            url: baseURL.appendingPathComponent("api/context"),
            resolvingAgainstBaseURL: false
        )!
        var items = [URLQueryItem(name: "workDir", value: workDir)]
        if let model, !model.isEmpty {
            items.append(URLQueryItem(name: "model", value: model))
        }
        if let personality, !personality.isEmpty {
            items.append(URLQueryItem(name: "personality", value: personality))
        }
        comps.queryItems = items

        var req = URLRequest(url: comps.url!)
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard
            let http = response as? HTTPURLResponse,
            (200..<300).contains(http.statusCode)
        else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(ContextEstimate.self, from: data)
    }
}
