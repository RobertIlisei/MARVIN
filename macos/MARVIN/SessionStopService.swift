// SessionStopService — "stop everything this session has running".
//
// Distinct from the Stop button, which aborts the in-flight turn and nothing
// else. That is correct for what it is ("stop talking, I want to say
// something"), but a turn can leave work behind that outlives it:
// `run_in_background` jobs are their own child processes, and a scheduled
// wakeup will start a NEW turn later, by itself. Pressing Stop and walking
// away leaves both running — and a wakeup firing minutes after the user
// ended the session is the worst kind of surprise, because the session they
// thought was over starts talking again.
//
// Two calls, and the split is the whole safety story: `preview` reports what
// WOULD be stopped so the confirmation can name it, and `stop` does it. A
// user who confirms "everything" has agreed to nothing in particular; a user
// who confirms "the running turn, 1 background job and 2 scheduled wakeups"
// has actually been told what they are about to lose.

import Foundation

@MainActor
enum SessionStopService {
    struct Scope: Decodable {
        let turnRunning: Bool
        let jobs: [Job]
        let wakeups: [Wakeup]
        /// Server-rendered one-liner for the confirmation. Nil when there is
        /// nothing to stop, which the caller reports instead of prompting.
        let summary: String?

        struct Job: Decodable { let id: String; let command: String }
        struct Wakeup: Decodable { let id: String; let reason: String }
    }

    struct Result: Decodable {
        let turnCancelled: Bool
        let jobsCancelled: Int
        let wakeupsCancelled: Int
        let failed: [String]
    }

    static func preview(sessionId: String, projectId: String?) async -> Scope? {
        var comps = URLComponents(
            string: "\(ServerConfig.baseURLString)/api/session/stop-all"
        )
        comps?.queryItems = [URLQueryItem(name: "marvinSessionId", value: sessionId)]
        if let projectId, !projectId.isEmpty {
            comps?.queryItems?.append(URLQueryItem(name: "projectId", value: projectId))
        }
        guard let url = comps?.url else { return nil }
        var req = URLRequest(url: url)
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return try? JSONDecoder().decode(Scope.self, from: data)
    }

    static func stop(sessionId: String, projectId: String?) async -> Result? {
        guard let url = URL(
            string: "\(ServerConfig.baseURLString)/api/session/stop-all"
        ) else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload: [String: String] = ["marvinSessionId": sessionId]
        if let projectId, !projectId.isEmpty { payload["projectId"] = projectId }
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return try? JSONDecoder().decode(Result.self, from: data)
    }
}
