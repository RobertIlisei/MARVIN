// ProjectsService — ADR-0021 M2.
// Loads and manages the project registry via the sidecar API,
// replacing the web side's `useProjects()` hook + `projects-changed`
// bridge message. After M2 the File → Open Recent menu and drag-drop
// folder registration both go through this service; the WebView never
// hears about them.
//
// MarvinBridge.projects / activeProjectId / projectName / projectWorkDir
// are the observable state that SwiftUI views read; ProjectsService
// writes them after every mutation so views get one consistent update.

import Foundation

@MainActor
@Observable
final class ProjectsService {
    static let shared = ProjectsService()

    private(set) var projects: [BridgeProject] = []
    private(set) var activeProjectId: String? = nil

    private init() {
        Task { await load() }
    }

    // MARK: - Public mutations

    /// Register a new project directory and make it active.
    /// No-op validation — the sidecar's `verifyWorkDir` returns 400
    /// on invalid paths; the caller should surface the error.
    func addProject(workDir: String, name: String? = nil) async throws {
        var body: [String: Any] = ["workDir": workDir, "setActive": true]
        if let name { body["name"] = name }
        let data = try JSONSerialization.data(withJSONObject: body)
        var req = request("http://localhost:3030/api/projects", method: "POST")
        req.httpBody = data
        let (_, resp) = try await URLSession.shared.data(for: req)
        try checkHTTP(resp)
        await load()
    }

    /// Remove a registered project by id. Does NOT delete the directory.
    func removeProject(id: String) async throws {
        let req = request(
            "http://localhost:3030/api/projects?id=\(id)",
            method: "DELETE"
        )
        let (_, resp) = try await URLSession.shared.data(for: req)
        try checkHTTP(resp)
        await load()
    }

    /// Switch the active project. Applies locally first for instant
    /// UI response, then persists via the sidecar.
    func setActive(id: String) async throws {
        // Instant local feedback — ChatPreviewView's onChange fires here.
        applyLocalSelection(id: id)
        let body = try JSONSerialization.data(withJSONObject: ["id": id])
        var req = request("http://localhost:3030/api/projects/active", method: "PUT")
        req.httpBody = body
        let (_, resp) = try await URLSession.shared.data(for: req)
        try checkHTTP(resp)
    }

    // MARK: - Private

    /// Load the project list from the sidecar with exponential backoff.
    /// Attempt 0 = immediate, attempts 1/2/3 = 1s/2s/4s delays.
    /// Called on init and after every mutation.
    private func load(attempt: Int = 0) async {
        if attempt > 0 {
            let delaySecs = Double(1 << (attempt - 1)) // 1, 2, 4
            try? await Task.sleep(for: .seconds(delaySecs))
        }
        do {
            let req = request("http://localhost:3030/api/projects")
            let (data, resp) = try await URLSession.shared.data(for: req)
            try checkHTTP(resp)

            struct Wire: Codable {
                struct Project: Codable {
                    let id: String; let name: String; let workDir: String
                }
                let projects: [Project]; let active: String?
            }
            let parsed = try JSONDecoder().decode(Wire.self, from: data)
            let loaded = parsed.projects.map {
                BridgeProject(id: $0.id, name: $0.name, workDir: $0.workDir)
            }
            projects = loaded
            activeProjectId = parsed.active
            MarvinBridge.shared.applyProjectsLoad(projects: loaded, activeId: parsed.active)
            NSLog("[ProjectsService] loaded \(loaded.count) projects, active=\(parsed.active ?? "none")")
        } catch {
            guard attempt < 3 else {
                NSLog("[ProjectsService] load failed after 3 retries: \(error)")
                return
            }
            NSLog("[ProjectsService] load attempt \(attempt) failed, retrying: \(error)")
            await load(attempt: attempt + 1)
        }
    }

    private func applyLocalSelection(id: String) {
        activeProjectId = id
        MarvinBridge.shared.applyLocalProjectSelection(id: id)
    }

    // MARK: - URL helpers

    private func request(_ urlString: String, method: String = "GET") -> URLRequest {
        var req = URLRequest(url: URL(string: urlString)!)
        req.httpMethod = method
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        if method == "POST" || method == "PUT" {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private func checkHTTP(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw URLError(.badServerResponse,
                           userInfo: [NSLocalizedDescriptionKey: "HTTP \(code)"])
        }
    }
}
