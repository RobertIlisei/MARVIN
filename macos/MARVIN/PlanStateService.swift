// PlanStateService — ADR-0052. The client half of durable per-session
// plan state.
//
// ADR-0046 made the plan the session's durable spine, but durability was
// client memory + transcript scraping on rehydrate — and ADR-0048's
// tail-first hydration (last 200 events) silently dropped any plan whose
// `# Plan` presentation had scrolled past the tail. The observed result
// (2026-07-02): a chat switch mid-plan degraded the strip to a tier-1 task
// list, froze the saved plan file, and stopped the ADR-0051 plan-context
// injection for the rest of the day.
//
// Now the spine itself is persisted: `ChatPreviewModel` PUTs
// `{plans, activePlanId}` (debounced) whenever the spine mutates, and GETs
// it back on hydrate — the stored spine is authoritative; transcript
// scraping remains only as a fallback for sessions predating this store.

import Foundation

/// Wire shape for the stored spine. Mirrors the client model exactly —
/// the server treats it as opaque JSON (identity hygiene + size cap only).
struct PlanStateWire: Codable {
    var plans: [Plan]
    var activePlanId: String?
}

enum PlanStateService {
    private static func url(projectId: String, sessionId: String) -> URL? {
        guard
            let p = projectId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
            let s = sessionId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return nil }
        return URL(string: "\(ServerConfig.baseURLString)/api/sessions/plans?projectId=\(p)&sessionId=\(s)")
    }

    /// Fetch the stored spine. nil = nothing stored (or unreachable) —
    /// callers fall back to transcript scraping.
    static func load(projectId: String, sessionId: String) async -> PlanStateWire? {
        guard let url = url(projectId: projectId, sessionId: sessionId) else { return nil }
        var req = URLRequest(url: url)
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode)
        else { return nil }
        struct Envelope: Codable { let state: PlanStateWire? }
        return (try? JSONDecoder().decode(Envelope.self, from: data))?.state
    }

    /// Persist the spine. Best-effort: a failed save costs nothing now and
    /// the next mutation retries; the transcript remains the deep fallback.
    static func save(projectId: String, sessionId: String, state: PlanStateWire) async {
        guard let url = url(projectId: projectId, sessionId: sessionId),
              let body = try? JSONEncoder().encode(state) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.httpBody = body
        _ = try? await URLSession.shared.data(for: req)
    }
}
