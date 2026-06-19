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
    /// Opt-in Playwright MCP browser server (ADR-0045). Off by default.
    private(set) var playwrightEnabled: Bool = false
    /// Autonomy mode (ADR-0036): "ask" | "agent" | "plan". Orthogonal to
    /// permissionStrategy. Defaults to "agent" so existing behaviour is
    /// unchanged until the user picks Ask or Plan.
    private(set) var mode: String = "agent"
    /// ADR-0022 follow-up — user-facing thinking mode (Fast / Thinking / Max).
    /// Maps to the SDK's `effort` field server-side. "thinking" matches the
    /// SDK default and MARVIN's prior behaviour, so existing users see no
    /// change in responsiveness until they pick differently.
    private(set) var thinkingMode: String = "high"
    /// Advisor effort (ADR-0033); nil = follow the executor's effort.
    private(set) var advisorThinkingMode: String? = nil
    private(set) var panes: MarvinBridge.PaneState = .init()
    private(set) var themeName: String? = nil
    /// 0 = tab; positive = that many spaces. Default 4 matches VS Code / Cursor.
    private(set) var indentSize: Int = 4
    /// First-launch onboarding has been shown + dismissed. False on a
    /// fresh `brew install` until the user clicks "Get started" in
    /// OnboardingView; true thereafter. The Help menu carries a
    /// "Show Onboarding…" entry that flips this back to false if the
    /// user wants to see the flow again.
    private(set) var hasCompletedOnboarding: Bool = false

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

    /// Opt-in Playwright MCP browser server (ADR-0045).
    func setPlaywrightEnabled(_ v: Bool) {
        playwrightEnabled = v
        UserDefaults.standard.set(v, forKey: "marvin.playwrightEnabled")
        MarvinBridge.shared.playwrightEnabled = v
    }

    /// Autonomy mode (ADR-0036): ask | agent | plan.
    func setMode(_ v: String) {
        guard v == "ask" || v == "agent" || v == "plan" else { return }
        mode = v
        UserDefaults.standard.set(v, forKey: "marvin.mode")
        MarvinBridge.shared.mode = v
    }

    /// User-facing reasoning-effort selection. The full SDK ladder
    /// ("low" | "medium" | "high" | "xhigh" | "max"), mirroring
    /// `ReasoningEffort` in `sdk-runner.ts`. Legacy 3-mode values
    /// ("fast" | "thinking") are still accepted and normalised on the
    /// way in, so older persisted prefs migrate seamlessly. Picking
    /// "xhigh"/"max" while the executor is Sonnet is allowed here — the
    /// runtime silently downgrades to high — but the picker disables
    /// those rungs off-Opus to keep the UX honest.
    func setThinkingMode(_ v: String) {
        let normalised = NativePrefs.normaliseEffort(v)
        guard let level = normalised else { return }
        thinkingMode = level
        UserDefaults.standard.set(level, forKey: "marvin.thinkingMode")
        MarvinBridge.shared.thinkingMode = level
    }

    /// Advisor-specific reasoning effort (ADR-0033). `nil` means
    /// "follow the executor" — the pre-0033 behaviour and the default.
    /// Same ladder + legacy-alias normalisation as the executor's.
    func setAdvisorThinkingMode(_ v: String?) {
        guard let v else {
            advisorThinkingMode = nil
            UserDefaults.standard.removeObject(forKey: "marvin.advisorThinkingMode")
            MarvinBridge.shared.advisorThinkingMode = nil
            return
        }
        guard let level = NativePrefs.normaliseEffort(v) else { return }
        advisorThinkingMode = level
        UserDefaults.standard.set(level, forKey: "marvin.advisorThinkingMode")
        MarvinBridge.shared.advisorThinkingMode = level
    }

    /// Map any accepted input (ladder value or legacy alias) onto the
    /// canonical effort ladder. Returns nil for unrecognised input so
    /// `setThinkingMode` can reject it. Single source of truth for the
    /// legacy→ladder migration, used on both write and load.
    static func normaliseEffort(_ v: String) -> String? {
        switch v.lowercased() {
        case "fast": return "low"
        case "thinking": return "high"
        case "low", "medium", "high", "xhigh", "max": return v.lowercased()
        default: return nil
        }
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

    // MARK: - Open tabs + selected file (per project)
    //
    // These restore the editor state across launches. Keyed per project
    // because file paths are workspace-specific — switching projects
    // must NOT carry tabs across.

    private static func openTabsKey(_ projectId: String) -> String {
        "marvin.openTabs.\(projectId)"
    }
    private static func selectedFileKey(_ projectId: String) -> String {
        "marvin.selectedFile.\(projectId)"
    }

    func openTabs(forProject projectId: String) -> [String] {
        guard !projectId.isEmpty,
              let data = UserDefaults.standard.data(forKey: Self.openTabsKey(projectId)),
              let arr = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        // Filter to existing files. A file deleted while the app was
        // closed shouldn't reappear as a ghost tab on relaunch.
        return arr.filter { FileManager.default.fileExists(atPath: $0) }
    }

    func setOpenTabs(_ tabs: [String], forProject projectId: String) {
        guard !projectId.isEmpty else { return }
        if tabs.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.openTabsKey(projectId))
            return
        }
        if let data = try? JSONEncoder().encode(tabs) {
            UserDefaults.standard.set(data, forKey: Self.openTabsKey(projectId))
        }
    }

    func selectedFile(forProject projectId: String) -> String? {
        guard !projectId.isEmpty else { return nil }
        let path = UserDefaults.standard.string(forKey: Self.selectedFileKey(projectId))
        return path.flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil }
    }

    func setSelectedFile(_ path: String?, forProject projectId: String) {
        guard !projectId.isEmpty else { return }
        if let path, !path.isEmpty {
            UserDefaults.standard.set(path, forKey: Self.selectedFileKey(projectId))
        } else {
            UserDefaults.standard.removeObject(forKey: Self.selectedFileKey(projectId))
        }
    }

    // MARK: - Last active chat session (per project)
    //
    // autoHydrate prefers this over `sessions.first` so the user lands
    // back on the conversation they left, not whichever was most-recently
    // touched (e.g. by a parallel surface or test run).

    private static func lastSessionKey(_ projectId: String) -> String {
        "marvin.lastSession.\(projectId)"
    }

    func lastSessionId(forProject projectId: String) -> String? {
        guard !projectId.isEmpty else { return nil }
        return UserDefaults.standard.string(forKey: Self.lastSessionKey(projectId))
    }

    func setLastSessionId(_ sessionId: String?, forProject projectId: String) {
        guard !projectId.isEmpty else { return }
        if let sessionId, !sessionId.isEmpty {
            UserDefaults.standard.set(sessionId, forKey: Self.lastSessionKey(projectId))
        } else {
            UserDefaults.standard.removeObject(forKey: Self.lastSessionKey(projectId))
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
        playwrightEnabled = d.bool(forKey: "marvin.playwrightEnabled")
        if let m = d.string(forKey: "marvin.mode"), m == "ask" || m == "agent" || m == "plan" {
            mode = m
        }
        if let mode = d.string(forKey: "marvin.thinkingMode"),
           let level = NativePrefs.normaliseEffort(mode) {
            // Normalise legacy fast/thinking → low/high on load so the
            // UI speaks one vocabulary regardless of when the pref was set.
            thinkingMode = level
        }
        if let advMode = d.string(forKey: "marvin.advisorThinkingMode"),
           let advLevel = NativePrefs.normaliseEffort(advMode) {
            advisorThinkingMode = advLevel
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
        hasCompletedOnboarding = d.bool(forKey: "marvin.onboarding.completed")
    }

    // MARK: - Onboarding

    /// Flip the onboarding-done flag. Call from OnboardingView's
    /// "Get started" / "Skip for now" buttons. Idempotent.
    func markOnboardingComplete() {
        hasCompletedOnboarding = true
        UserDefaults.standard.set(true, forKey: "marvin.onboarding.completed")
    }

    /// Reset the flag — Help → Show Onboarding… invokes this so the
    /// user can re-view the flow.
    func resetOnboarding() {
        hasCompletedOnboarding = false
        UserDefaults.standard.removeObject(forKey: "marvin.onboarding.completed")
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
        b.playwrightEnabled   = playwrightEnabled
        b.mode                = mode
        b.thinkingMode        = thinkingMode
        b.advisorThinkingMode = advisorThinkingMode
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
