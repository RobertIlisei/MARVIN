// SupervisorService — the app's side of the ADR-0127 supervisor routes
// (milestone 6), and the observable state the Sessions pane draws.
//
// Every supervisor route needs the per-boot capability token, GET included,
// because the state names the tabs and the charter (ADR-0127 §5). The sidecar
// writes it fresh at every boot to `<MARVIN_DATA_DIR>/supervisor/token`, mode
// 0600; the app reads it from there and nowhere else, sends it only to the
// loopback sidecar in `x-marvin-supervisor-token`, and re-reads it once after a
// 403 (a restarted sidecar has a new one). An unreadable token is a state of
// its own on screen (brief §7, "Token unavailable"), never a silent failure.
//
// The project feed carries ids and states only (`supervisor.state`,
// `supervisor.inbox`, `supervisor.ledger`); this model fetches what moved.
// Updates apply in place, keyed by id — no list-wide refetch per event beyond
// the one route that changed.

import AppKit
import Foundation
import MARVINLogic

enum SupervisorServiceError: Error, LocalizedError {
    case token(String)
    case refused(status: Int, message: String, code: String?)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .token(let path): return "MARVIN couldn't read the supervisor token at \(path)"
        case .refused(_, let message, _): return message
        case .transport(let m): return m
        }
    }
}

/// Network calls, stateless apart from the cached token.
@MainActor
final class SupervisorService {
    static let shared = SupervisorService()
    private init() {}

    private let baseURL = ServerConfig.baseURL
    private var cachedToken: String?

    /// Where the sidecar writes the token: the same data dir it resolves.
    var tokenPath: String {
        SupervisorToken.path(environment: ProcessInfo.processInfo.environment,
                             home: FileManager.default.homeDirectoryForCurrentUser.path)
    }

    /// Read (or re-read) the token. nil when the file is missing, unreadable,
    /// or not a well-formed token — the caller shows "Token unavailable".
    func token(reload: Bool = false) -> String? {
        // The snapshot harness talks to a stand-in sidecar; the user's real
        // token must never be read in a snapshot run, whatever a fixture does.
        if ProcessInfo.processInfo.environment["MARVIN_SNAPSHOT_VIEW"] != nil { return nil }
        if !reload, let cachedToken { return cachedToken }
        guard let raw = try? String(contentsOfFile: tokenPath, encoding: .utf8),
              let t = SupervisorToken.parse(raw) else {
            cachedToken = nil
            return nil
        }
        cachedToken = t
        return t
    }

    private func request(_ path: String, method: String = "GET", query: [URLQueryItem] = [],
                         body: [String: Any]? = nil, token: String) -> URLRequest {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.timeoutInterval = 15
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.setValue(token, forHTTPHeaderField: "x-marvin-supervisor-token")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    /// One call, with the token, retried once on 403 after re-reading it.
    private func call(_ path: String, method: String = "GET", query: [URLQueryItem] = [],
                      body: [String: Any]? = nil) async throws -> Data {
        guard let first = token() else { throw SupervisorServiceError.token(tokenPath) }
        var (data, status) = try await send(request(path, method: method, query: query, body: body, token: first))
        if status == 403, let fresh = token(reload: true), fresh != first {
            (data, status) = try await send(request(path, method: method, query: query, body: body, token: fresh))
        }
        guard (200..<300).contains(status) else {
            struct Err: Decodable { let error: String?; let code: String? }
            let e = try? JSONDecoder().decode(Err.self, from: data)
            if status == 403, e?.code == nil, token(reload: true) == nil { throw SupervisorServiceError.token(tokenPath) }
            throw SupervisorServiceError.refused(status: status, message: e?.error ?? "HTTP \(status)", code: e?.code)
        }
        return data
    }

    private func send(_ req: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            return (data, (resp as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw SupervisorServiceError.transport(error.localizedDescription)
        }
    }

    // MARK: - Routes

    func status(projectId: String) async throws -> SupervisorStatus {
        let data = try await call("api/supervisor", query: [URLQueryItem(name: "projectId", value: projectId)])
        guard let s = SupervisorStatus.decodeEnvelope(data) else { throw SupervisorServiceError.transport("unreadable status") }
        return s
    }

    /// POST /api/supervisor `{projectId, action, …}` → the new status.
    func control(projectId: String, action: String, extra: [String: Any] = [:]) async throws -> SupervisorStatus {
        var body = extra
        body["projectId"] = projectId
        body["action"] = action
        let data = try await call("api/supervisor", method: "POST", body: body)
        guard let s = SupervisorStatus.decodeEnvelope(data) else { throw SupervisorServiceError.transport("unreadable status") }
        return s
    }

    func inbox(projectId: String) async throws -> [SupervisorInboxItem] {
        let data = try await call("api/supervisor/inbox", query: [URLQueryItem(name: "projectId", value: projectId),
                                                                 URLQueryItem(name: "state", value: "open")])
        guard let items = SupervisorInboxItem.decodeList(data) else { throw SupervisorServiceError.transport("unreadable inbox") }
        return items
    }

    /// The user's decision on an item — recorded `actor: "user"` server-side.
    func act(projectId: String, itemId: String, actionId: String, edits: [String: Any]? = nil) async throws -> String? {
        var body: [String: Any] = ["projectId": projectId, "id": itemId, "actionId": actionId]
        if let edits { body["edits"] = edits }
        let data = try await call("api/supervisor/inbox", method: "POST", body: body)
        struct Out: Decodable { struct O: Decodable { let message: String?; let marvinSessionId: String? }; let outcome: O? }
        return (try? JSONDecoder().decode(Out.self, from: data))?.outcome?.message
    }

    func ledger(projectId: String, before: Int? = nil, limit: Int = 20, sessionId: String? = nil,
                decision: String? = nil) async throws -> SupervisorLedgerPage {
        var q = [URLQueryItem(name: "projectId", value: projectId), URLQueryItem(name: "limit", value: String(limit))]
        if let before { q.append(URLQueryItem(name: "before", value: String(before))) }
        if let sessionId { q.append(URLQueryItem(name: "sessionId", value: sessionId)) }
        if let decision { q.append(URLQueryItem(name: "decision", value: decision)) }
        let data = try await call("api/supervisor/ledger", query: q)
        do { return try JSONDecoder().decode(SupervisorLedgerPage.self, from: data) }
        catch { throw SupervisorServiceError.transport("unreadable ledger") }
    }

    func reveal(projectId: String, ledgerId: String) async throws {
        _ = try await call("api/supervisor/reveal", method: "POST", body: ["projectId": projectId, "ledgerId": ledgerId])
    }
}

/// What the Sessions pane draws for the supervisor, in one observable place.
@MainActor
@Observable
final class SupervisorModel {
    static let shared = SupervisorModel()
    init() {}

    private(set) var projectId: String?
    var status: SupervisorStatus?
    var inbox: [SupervisorInboxItem] = []
    var ledger: [SupervisorLedgerEntry] = []
    var ledgerHasMore = false
    var ledgerTodayCount = 0
    /// nil = All; else a ledger `decision` (act, escalate, refuse, propose).
    var ledgerFilter: String? = nil
    var ledgerTabFilter: String? = nil
    /// Path of the token the app could not read; nil when it reads.
    var tokenError: String?
    /// A control call that did not reach the sidecar (brief §8).
    var controlNotice: PaneNotice?
    /// The failure notice the user dismissed; a different failure shows again.
    var dismissedFailure: String?
    /// Items whose consent is in flight: the chip spins, the card disables.
    var inFlight: Set<String> = []
    /// A refusal from the server, shown in the card; the card stays.
    var itemErrors: [String: String] = [:]
    /// UI state that the keyboard, VoiceOver and the snapshot fixtures all
    /// need to reach, so it lives here rather than in view `@State`.
    var expandedCards: Set<String> = []
    var expandedTabs: Set<String> = []
    var fullActShown: Set<String> = []
    var groundsShown: Set<String> = []
    var stripExpanded = false
    var logExpanded = false
    var setUpOpen = false
    var revealed: Set<String> = []
    /// "Answer…" / "Answer differently…" — AskQuestionSheet, nothing pre-selected.
    var answerSheetItem: SupervisorInboxItem?
    /// A new-tab proposal's "Edit…" sheet.
    var newTabEditItem: SupervisorInboxItem?
    /// A budget guardrail's "Raise cap…" prompt.
    var raiseCapItem: SupervisorInboxItem?
    /// Tab-level "answered in tab" notes for VoiceOver.
    private var announcer = SupervisorAnnouncer()
    private var lastStripState: SupervisorStripState = .off

    /// Fixtures set this so the harness never touches the network — nor reads
    /// the real token from the user's data dir.
    var offline = false
    /// Fixtures pin the feed's state; nil = the registry's live value.
    var fixtureFeedConnected: Bool? = nil

    var layout: SupervisorInboxLayout { SupervisorInboxLayout(items: inbox, expandedTabs: expandedTabs) }

    func strip(feedConnected: Bool, now: Date = Date()) -> SupervisorStrip {
        SupervisorStrip.make(status: status, feedConnected: feedConnected, tokenError: tokenError, now: now)
    }

    var isEnabled: Bool { (status?.mode ?? "off") != "off" }

    // MARK: - Lifecycle

    func start(projectId pid: String) {
        guard projectId != pid else { return }
        projectId = pid
        status = nil
        inbox = []
        ledger = []
        announcer = SupervisorAnnouncer()
        expandedCards = []
        expandedTabs = []
        refreshAll()
    }

    func refreshAll() {
        Task { await refreshStatus(); await refreshInbox(); if logExpanded { await refreshLedger() } }
    }

    func refreshStatus() async {
        guard !offline, let pid = projectId else { return }
        do {
            let s = try await SupervisorService.shared.status(projectId: pid)
            guard projectId == pid else { return }
            tokenError = nil
            setStatus(s)
        } catch SupervisorServiceError.token(let path) {
            tokenError = path
            announceStripChange()
        } catch {
            NSLog("[SupervisorModel] status failed: \(error)")
        }
    }

    func refreshInbox() async {
        guard !offline, let pid = projectId, isEnabled || !inbox.isEmpty else { return }
        do {
            let items = try await SupervisorService.shared.inbox(projectId: pid)
            guard projectId == pid else { return }
            applyInbox(items)
        } catch SupervisorServiceError.token(let path) {
            tokenError = path
        } catch {
            NSLog("[SupervisorModel] inbox failed: \(error)")
        }
    }

    func refreshLedger(earlier: Bool = false) async {
        guard !offline, let pid = projectId else { return }
        do {
            let page = try await SupervisorService.shared.ledger(
                projectId: pid, before: earlier ? ledger.last?.seq : nil, limit: earlier ? 50 : 20,
                sessionId: ledgerTabFilter, decision: ledgerFilter)
            guard projectId == pid else { return }
            ledger = earlier ? ledger + page.entries : page.entries
            ledgerHasMore = page.hasMore
            ledgerTodayCount = page.todayCount
        } catch {
            NSLog("[SupervisorModel] ledger failed: \(error)")
        }
    }

    // MARK: - Feed

    func apply(feed event: SupervisorFeedEvent) {
        switch event {
        case .state(let revision, _):
            if revision != status?.revision { Task { await refreshStatus() } }
        case .inbox(_, let id, _, let state, let resolvedBy):
            if state != "open" {
                // Leaves in place (opacity fade); focus moves on in the view.
                if let gone = inbox.first(where: { $0.id == id }) {
                    inbox.removeAll { $0.id == id }
                    if resolvedBy == "tab" {
                        VoiceOver.announce("Answered in tab: \(gone.tabTitle ?? "a tab")")
                    }
                }
            }
            Task { await refreshInbox() }
        case .ledger:
            if logExpanded { Task { await refreshLedger() } }
            else { ledgerTodayCount += 1 }
        }
    }

    private func setStatus(_ s: SupervisorStatus) {
        status = s
        announceStripChange()
    }

    private func announceStripChange() {
        let next = strip(feedConnected: true).state
        if let text = SupervisorStrip.announcement(from: lastStripState, to: next) { VoiceOver.announce(text) }
        lastStripState = next
    }

    private func applyInbox(_ items: [SupervisorInboxItem]) {
        inbox = items
        if let text = announcer.note(open: items.filter(\.isOpen)) { VoiceOver.announce(text) }
    }

    // MARK: - Controls (brief §8: the route at once, optimistic only in the glyph)

    func control(_ action: String, extra: [String: Any] = [:], failureVerb: String) async {
        guard let pid = projectId else { return }
        do {
            let s = try await SupervisorService.shared.control(projectId: pid, action: action, extra: extra)
            controlNotice = nil
            setStatus(s)
        } catch SupervisorServiceError.token(let path) {
            tokenError = path
            announceStripChange()
        } catch SupervisorServiceError.refused(_, let message, _) {
            controlNotice = PaneNotice(kind: .error, headline: "\(failureVerb) was refused", detail: message)
        } catch {
            controlNotice = PaneNotice(kind: .error,
                                       headline: "\(failureVerb) didn't reach the sidecar — the supervisor may still be running",
                                       detail: error.localizedDescription)
        }
    }

    func pause() async { await control("pause", failureVerb: "Pause") }
    func resume() async { await control("resume", failureVerb: "Resume") }
    func kill() async { await control("kill", failureVerb: "Kill") }
    func wakeNow() async { await control("wakeNow", failureVerb: "Restart") }
    func disable() async { await control("disable", failureVerb: "Disable") }
    func setCap(_ usd: Double) async { await control("cap", extra: ["capUsd": usd], failureVerb: "Raising the cap") }
    func setCharter(_ text: String) async { await control("charter", extra: ["text": text], failureVerb: "Saving the charter") }
    func setAutonomy(_ category: String, autonomous: Bool) async {
        await control("autonomy", extra: ["category": category, "value": autonomous ? "autonomous" : "shadow"],
                      failureVerb: "Switching \(category)")
    }
    /// Setting a level is the user's own limit on the supervisor: it applies
    /// at once, with no confirmation (brief §6.5). The server names the field
    /// `marvinSessionId` for this action.
    func delegate(_ sessionId: String, _ level: SupervisorDelegation) async {
        await control("delegate", extra: ["marvinSessionId": sessionId, "level": level.rawValue], failureVerb: "Setting delegation")
        SessionRegistry.shared.refreshSnapshot()
    }
    /// "Start in shadow" — the set-up sheet's only path; there is no path to autonomy from it.
    func startInShadow(charter: String, capUsd: Double, delegations: [(String, SupervisorDelegation)]) async {
        await control("start", extra: [
            "charter": charter,
            "capUsd": capUsd,
            "delegations": delegations.map { ["sessionId": $0.0, "level": $0.1.rawValue] },
        ], failureVerb: "Starting the supervisor")
        SessionRegistry.shared.refreshSnapshot()
        await refreshInbox()
    }

    // MARK: - Inbox

    /// The click on the raw act is the consent (brief §2). No batch path exists.
    func act(_ item: SupervisorInboxItem, actionId: String, edits: [String: Any]? = nil) async {
        guard let pid = projectId, !inFlight.contains(item.id) else { return }
        inFlight.insert(item.id)
        itemErrors[item.id] = nil
        defer { inFlight.remove(item.id) }
        do {
            _ = try await SupervisorService.shared.act(projectId: pid, itemId: item.id, actionId: actionId, edits: edits)
            inbox.removeAll { $0.id == item.id }
            await refreshInbox()
            SessionRegistry.shared.refreshSnapshot()
        } catch SupervisorServiceError.token(let path) {
            tokenError = path
        } catch {
            itemErrors[item.id] = error.localizedDescription
        }
    }

    func reveal(ledgerId: String) async {
        guard let pid = projectId else { return }
        revealed.insert(ledgerId)
        do { try await SupervisorService.shared.reveal(projectId: pid, ledgerId: ledgerId) }
        catch { NSLog("[SupervisorModel] reveal failed: \(error)") }
        SessionRegistry.shared.refreshSnapshot()
    }
}
