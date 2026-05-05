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
import WebKit

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

    /// One-shot migration: read five pref keys from the WebView's
    /// localStorage and write to UserDefaults. Runs while the WebView
    /// is still mounted (M1–M4). No-ops if the migration flag is set
    /// or if the WebView isn't available. On failure (JS error, page
    /// not loaded) skips gracefully — next launch retries.
    func runMigrationIfNeeded() async {
        guard !migrationComplete else { return }
        guard let webView = WebViewCommands.shared.webView else {
            NSLog("[NativePrefs] migration skipped — WebView not mounted yet")
            return
        }
        let js = """
        (function(){
          return JSON.stringify({
            personality: localStorage.getItem('marvin.personality'),
            executor:    localStorage.getItem('marvin.model.executor'),
            advisor:     localStorage.getItem('marvin.model.advisor'),
            permission:  localStorage.getItem('marvin.permissionStrategy'),
            panes:       localStorage.getItem('marvin.panes')
          });
        })()
        """
        do {
            let result = try await webView.evaluateJavaScript(js)
            guard let jsonStr = result as? String,
                  let data = jsonStr.data(using: .utf8),
                  let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else {
                NSLog("[NativePrefs] migration: couldn't parse localStorage JSON")
                UserDefaults.standard.set(true, forKey: Self.migrationFlagKey)
                return
            }
            if let p = dict["personality"] as? String { setPersonality(p) }
            if let e = dict["executor"] as? String, !e.isEmpty { setExecutorModel(e) }
            if let a = dict["advisor"] as? String, !a.isEmpty { setAdvisorModel(a) }
            if let perm = dict["permission"] as? String { setPermissionStrategy(perm) }
            if let panesStr = dict["panes"] as? String,
               let pd = panesStr.data(using: .utf8),
               let pc = try? JSONDecoder().decode(PanesCodable.self, from: pd) {
                setPanes(pc.toState())
            }
            UserDefaults.standard.set(true, forKey: Self.migrationFlagKey)
            NSLog("[NativePrefs] localStorage → UserDefaults migration complete — permissionStrategy=\(permissionStrategy)")
        } catch {
            NSLog("[NativePrefs] migration evaluateJavaScript failed: \(error) — will retry next launch")
        }
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
    }
}

// MARK: - PanesCodable

private struct PanesCodable: Codable {
    var files: Bool; var brain: Bool; var graph: Bool
    var preview: Bool; var terminal: Bool

    init(from s: MarvinBridge.PaneState) {
        files = s.files; brain = s.brain; graph = s.graph
        preview = s.preview; terminal = s.terminal
    }

    func toState() -> MarvinBridge.PaneState {
        var s = MarvinBridge.PaneState()
        s.files = files; s.brain = brain; s.graph = graph
        s.preview = preview; s.terminal = terminal
        return s
    }

    var jsonString: String? {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) }
    }
}
