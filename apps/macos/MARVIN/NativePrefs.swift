// NativePrefs — persisted user preferences, UserDefaults-backed.
// ADR-0021 M1: replaces the web side's localStorage as the source of
// truth for personality, models, permission strategy, panes, theme.
//
// Previously these five pref families lived in the React app's
// localStorage and were mirrored to MarvinBridge via WKScriptMessageHandler
// bridge messages (permission-changed, panes-changed, etc.). After M1
// the write path is: native UI → NativePrefs → UserDefaults + MarvinBridge.
// Bridge messages for these types are silenced via `nativePrefsTakeover`.
//
// One-shot migration: on first launch after M1, `runMigrationIfNeeded()`
// reads the still-mounted WebView's localStorage via evaluateJavaScript
// and seeds UserDefaults. Gated by `marvin.migrated_prefs_v1`. After M5
// (WebView deletion) the migration function can be removed — all users
// will have the flag set.

import Foundation
import SwiftUI

@MainActor
@Observable
final class NativePrefs {
    static let shared = NativePrefs()

    // MARK: - In-memory prefs (authoritative after init)

    private(set) var personality: String = "marvin"
    private(set) var executorModel: String? = nil
    private(set) var advisorModel: String? = nil
    private(set) var permissionStrategy: String = "auto"
    private(set) var panes: MarvinBridge.PaneState = .init()
    private(set) var themeName: String? = nil
    /// 0 = tab; positive = that many spaces. Default 4 matches VS Code / Cursor.
    private(set) var indentSize: Int = 4

    private init() {
        loadFromDefaults()
        // Silence the bridge's pref message handlers so the web side
        // can no longer overwrite UserDefaults-backed values via
        // WKScriptMessageHandler (permission-changed, panes-changed, etc.)
        MarvinBridge.shared.nativePrefsTakeover = true
        pushToBridge()
    }

    // MARK: - Setters (write UserDefaults + sync bridge)

    func setPersonality(_ v: String) {
        guard v == "marvin" || v == "neutral" else { return }
        personality = v
        UserDefaults.standard.set(v, forKey: "marvin.personality")
        MarvinBridge.shared.personality = v
    }

    func setExecutorModel(_ v: String?) {
        executorModel = v
        if let v { UserDefaults.standard.set(v, forKey: "marvin.model.executor") }
        else { UserDefaults.standard.removeObject(forKey: "marvin.model.executor") }
        MarvinBridge.shared.executorModel = v
    }

    func setAdvisorModel(_ v: String?) {
        advisorModel = v
        if let v { UserDefaults.standard.set(v, forKey: "marvin.model.advisor") }
        else { UserDefaults.standard.removeObject(forKey: "marvin.model.advisor") }
        MarvinBridge.shared.advisorModel = v
    }

    func setModels(executor: String?, advisor: String?) {
        setExecutorModel(executor)
        setAdvisorModel(advisor)
    }

    func setPermissionStrategy(_ v: String) {
        guard v == "auto" || v == "gated" else { return }
        permissionStrategy = v
        UserDefaults.standard.set(v, forKey: "marvin.permissionStrategy")
        MarvinBridge.shared.permissionStrategy = v
    }

    func togglePane(_ key: String) {
        var next = panes
        switch key {
        case "files":    next.files    = !next.files
        case "brain":    next.brain    = !next.brain
        case "graph":    next.graph    = !next.graph
        case "preview":  next.preview  = !next.preview
        case "terminal": next.terminal = !next.terminal
        case "problems": next.problems = !next.problems
        default: return
        }
        setPanes(next)
    }

    func setPanes(_ next: MarvinBridge.PaneState) {
        panes = next
        if let str = PanesCodable(from: next).jsonString {
            UserDefaults.standard.set(str, forKey: "marvin.panes")
        }
        MarvinBridge.shared.panes = next
    }

    func setIndentSize(_ v: Int) {
        let clamped = v <= 0 ? 0 : min(v, 8)
        indentSize = clamped
        UserDefaults.standard.set(clamped, forKey: "marvin.indentSize")
        MarvinBridge.shared.indentSize = clamped
    }

    // MARK: - Recent files (MRU per project)

    private static func recentFilesKey(_ projectId: String) -> String {
        "marvin.recentFiles.\(projectId)"
    }

    func recentFiles(forProject projectId: String) -> [String] {
        guard !projectId.isEmpty else { return [] }
        guard let data = UserDefaults.standard.data(forKey: Self.recentFilesKey(projectId)),
              let arr = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return arr
    }

    func recordOpenedFile(_ path: String, forProject projectId: String) {
        guard !projectId.isEmpty, !path.isEmpty else { return }
        var current = recentFiles(forProject: projectId)
        current.removeAll { $0 == path }
        current.insert(path, at: 0)
        if current.count > 12 { current = Array(current.prefix(12)) }
        if let data = try? JSONEncoder().encode(current) {
            UserDefaults.standard.set(data, forKey: Self.recentFilesKey(projectId))
        }
    }

    func setTheme(_ v: String?) {
        themeName = (v == "light" || v == "dark") ? v : nil
        if let themeName { UserDefaults.standard.set(themeName, forKey: "marvin.theme") }
        else { UserDefaults.standard.removeObject(forKey: "marvin.theme") }
        MarvinBridge.shared.themeName = themeName
    }

    // MARK: - Migration

    private static let migrationFlagKey = "marvin.migrated_prefs_v1"

    var migrationComplete: Bool {
        UserDefaults.standard.bool(forKey: Self.migrationFlagKey)
    }

    /// ADR-0021 M5: WebView removed. Migration no longer possible or needed —
    /// all users reached M5 with the flag set, or default prefs are acceptable.
    func runMigrationIfNeeded() async {
        UserDefaults.standard.set(true, forKey: Self.migrationFlagKey)
    }

    // MARK: - Private

    private func loadFromDefaults() {
        let d = UserDefaults.standard
        if let p = d.string(forKey: "marvin.personality"), p == "marvin" || p == "neutral" {
            personality = p
        }
        executorModel = d.string(forKey: "marvin.model.executor").flatMap { $0.isEmpty ? nil : $0 }
        advisorModel  = d.string(forKey: "marvin.model.advisor").flatMap  { $0.isEmpty ? nil : $0 }
        if let perm = d.string(forKey: "marvin.permissionStrategy"), perm == "auto" || perm == "gated" {
            permissionStrategy = perm
        }
        if let str = d.string(forKey: "marvin.panes"),
           let data = str.data(using: .utf8),
           let pc = try? JSONDecoder().decode(PanesCodable.self, from: data) {
            panes = pc.toState()
        }
        if let t = d.string(forKey: "marvin.theme"), t == "light" || t == "dark" {
            themeName = t
        }
        let saved = d.integer(forKey: "marvin.indentSize")
        if saved > 0 || d.object(forKey: "marvin.indentSize") != nil {
            indentSize = max(0, min(saved, 8))
        }
    }

    /// Push initial values to MarvinBridge so views still reading
    /// bridge.* see the correct state before the first bridge message
    /// from the (still-mounted) WebView would arrive.
    private func pushToBridge() {
        let b = MarvinBridge.shared
        b.personality         = personality
        b.executorModel       = executorModel
        b.advisorModel        = advisorModel
        b.permissionStrategy  = permissionStrategy
        b.panes               = panes
        b.themeName           = themeName
        b.indentSize          = indentSize
    }
}

// MARK: - PanesCodable

private struct PanesCodable: Codable {
    var files: Bool; var brain: Bool; var graph: Bool
    var preview: Bool; var terminal: Bool
    var problems: Bool?  // optional for backward-compat with old UserDefaults payloads

    init(from s: MarvinBridge.PaneState) {
        files = s.files; brain = s.brain; graph = s.graph
        preview = s.preview; terminal = s.terminal; problems = s.problems
    }

    func toState() -> MarvinBridge.PaneState {
        var s = MarvinBridge.PaneState()
        s.files = files; s.brain = brain; s.graph = graph
        s.preview = preview; s.terminal = terminal; s.problems = problems ?? false
        return s
    }

    var jsonString: String? {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) }
    }
}
