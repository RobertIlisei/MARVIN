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

    /// GET /api/models → the live list for the active provider. No supervisor
    /// token: the list is not the supervisor's, and neither is the role store.
    func modelEntries() async throws -> [SupervisorModelPicker.Entry] {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/models"))
        req.timeoutInterval = 15
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        let (data, status) = try await send(req)
        guard (200..<300).contains(status) else { throw SupervisorServiceError.refused(status: status, message: "HTTP \(status)", code: nil) }
        struct Wire: Decodable {
            struct Model: Decodable { let id: String; let displayName: String; let tier: String }
            let models: [Model]
        }
        let wire = try JSONDecoder().decode(Wire.self, from: data)
        return wire.models.map { .init(id: $0.id, displayName: $0.displayName, tier: $0.tier) }
    }

    /// PATCH /api/models/roles `{role: "supervisor", model}` — one role, one
    /// key; nil puts it back on the default. The user's click, never a verb.
    func setSupervisorModel(_ id: String?) async throws {
        try await patchSupervisorRole(["model": id.map { $0 as Any } ?? NSNull()])
    }

    /// PATCH /api/models/roles `{role: "supervisor", effort}` — a rung of the
    /// ladder, or nil for Default. Raising it widens the posture, so like the
    /// model it is the user's click, never a verb.
    func setSupervisorEffort(_ rung: String?) async throws {
        try await patchSupervisorRole(["effort": rung.map { $0 as Any } ?? NSNull()])
    }

    private func patchSupervisorRole(_ field: [String: Any]) async throws {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/models/roles"))
        req.httpMethod = "PATCH"
        req.timeoutInterval = 15
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: field.merging(["role": "supervisor"]) { a, _ in a })
        let (data, status) = try await send(req)
        guard (200..<300).contains(status) else {
            struct Err: Decodable { let error: String? }
            let message = (try? JSONDecoder().decode(Err.self, from: data))?.error ?? "HTTP \(status)"
            throw SupervisorServiceError.refused(status: status, message: message, code: nil)
        }
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

    func inbox(projectId: String, state: String = "open") async throws -> [SupervisorInboxItem] {
        let data = try await call("api/supervisor/inbox", query: [URLQueryItem(name: "projectId", value: projectId),
                                                                 URLQueryItem(name: "state", value: state)])
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

    // ADR-0128 — the Supervisor tab. Never `/api/chat`: the conversation is the supervisor's routes only.
    func conversation(projectId: String) async throws -> [SupervisorChatMessage] {
        let data = try await call("api/supervisor/message", query: [URLQueryItem(name: "projectId", value: projectId)])
        do { return try JSONDecoder().decode(SupervisorConversation.self, from: data).messages }
        catch { throw SupervisorServiceError.transport("unreadable conversation") }
    }

    /// ADR-0129 — `images` reach the model as image content; `imageText` is their on-device recognised
    /// text, which the route scans for secrets and drops.
    func sendMessage(projectId: String, text: String, images: [SupervisorImageUpload.Prepared] = []) async throws {
        var body: [String: Any] = ["projectId": projectId, "text": text]
        if !images.isEmpty {
            body["images"] = images.map { ["mediaType": $0.mediaType, "data": $0.base64] }
            body["imageText"] = images.map(\.recognisedText)
        }
        _ = try await call("api/supervisor/message", method: "POST", body: body)
    }

    // [7.3] — what the supervisor follows for the user, and the user's Stop following.
    func follows(projectId: String) async throws -> [SupervisorFollow] {
        let data = try await call("api/supervisor/follows", query: [URLQueryItem(name: "projectId", value: projectId)])
        do { return try JSONDecoder().decode(SupervisorFollows.self, from: data).follows }
        catch { throw SupervisorServiceError.transport("unreadable follows") }
    }

    func stopFollow(projectId: String, id: String) async throws {
        _ = try await call("api/supervisor/follows", method: "POST", body: ["projectId": projectId, "id": id, "action": "stop"])
    }

    // ADR-0133 — the approved queue. Reading it, and the user's own settings (cap, release, remove, a
    // guard-command card). An entry is approved only by the click on its inbox card, never here.
    func queue(projectId: String) async throws -> SupervisorQueueView {
        let data = try await call("api/supervisor/queue", query: [URLQueryItem(name: "projectId", value: projectId)])
        guard let q = SupervisorQueueView.decode(data) else { throw SupervisorServiceError.transport("unreadable queue") }
        return q
    }

    func queueAction(_ body: [String: Any]) async throws {
        _ = try await call("api/supervisor/queue", method: "POST", body: body)
    }

    // ADR-0131 — project notices: the user's side of `/api/notices` (token-gated like the supervisor's routes).
    func notices(projectId: String) async throws -> [ProjectNotice] {
        let data = try await call("api/notices", query: [URLQueryItem(name: "projectId", value: projectId)])
        guard let list = ProjectNotices.decodeList(data) else { throw SupervisorServiceError.transport("unreadable notices") }
        return list
    }

    func postNotice(projectId: String, text: String, ttlHours: Int) async throws {
        _ = try await call("api/notices", method: "POST", body: ["projectId": projectId, "text": text, "ttlHours": ttlHours])
    }

    func retireNotice(projectId: String, id: String) async throws {
        _ = try await call("api/notices", method: "DELETE", query: [URLQueryItem(name: "projectId", value: projectId), URLQueryItem(name: "id", value: id)])
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
    /// The Settings block's model list (GET /api/models); empty until it loads.
    var modelChoices: [SupervisorModelPicker.Entry] = []
    var modelListFailed = false
    var effortPickerOpen = false
    /// The effort row the arrow keys are on; "" is Default.
    var effortCursor = ""
    /// The list is open, and which row the arrow keys are on ("" = Default).
    var modelPickerOpen = false
    var modelCursor: String = ""
    /// UI state that the keyboard, VoiceOver and the snapshot fixtures all
    /// need to reach, so it lives here rather than in view `@State`.
    var expandedCards: Set<String> = []
    var expandedTabs: Set<String> = []
    var fullActShown: Set<String> = []
    var groundsShown: Set<String> = []
    /// The inspector shows the log: live ledger lines are fetched, not just counted.
    private var logShown: Bool { workspaceOpen && inspectorSegment == .log }
    var revealed: Set<String> = []
    /// "Answer…" / "Answer differently…" — AskQuestionSheet, nothing pre-selected.
    var answerSheetItem: SupervisorInboxItem?
    /// A new-tab proposal's "Edit…" sheet.
    var newTabEditItem: SupervisorInboxItem?
    /// A budget guardrail's "Raise cap…" prompt.
    var raiseCapItem: SupervisorInboxItem?
    /// [7.2] — a send card's "Edit…" sheet (text only; never the tab or the kind).
    var sendEditItem: SupervisorInboxItem?
    /// [7.2] — the same sheets, opened from a card in the Supervisor tab, which is mounted apart from the pane.
    var chatSheet: SupervisorCardSheet?
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

    // MARK: - The Supervisor tab (ADR-0128, brief §12)

    /// The conversation, oldest first, as the GET returns it.
    var chat: [SupervisorChatMessage] = []
    var chatSending = false
    /// Brief §12.6 — the message being sent, drawn as its bubble until the route answers.
    var chatPending: String?
    /// ADR-0129 — the images of the message in flight, drawn in its bubble before the route answers.
    var chatPendingImages: [String] = []
    /// The server's reason for a refused send; the text stays in the composer.
    var chatError: String?
    /// Brief §13 — the Supervisor workspace is open: the conversation in the
    /// centre and, while enabled, the Brain and inspector on the right.
    var workspaceOpen = false
    /// §13.6 — the inspector's segment. Tabs by default; never restored to Settings.
    var inspectorSegment: SupervisorInspectorSegment = .tabs {
        didSet { if let pid = projectId { UserDefaults.standard.set(inspectorSegment.rawValue, forKey: Self.segmentKey(pid)) } }
    }
    /// §13.8 — a file the workspace itself opened (a ground, a log link): the
    /// editor shows it UNDER the workspace instead of dismissing it.
    var innerOpenPath: String?
    /// Bumped on every open: the composer takes focus (§13.8).
    var composerFocusToken = 0
    private static func segmentKey(_ pid: String) -> String { "marvin.supervisor.inspector.\(pid)" }

    func openWorkspace(segment: SupervisorInspectorSegment? = nil) {
        if let segment { inspectorSegment = segment }
        workspaceOpen = true
        composerFocusToken &+= 1
        // The desk's inbox is the Sessions pane (§13.8, open decision 1).
        MarvinBridge.shared.selectLeftTabIfVisible("sessions")
        if inspectorSegment == .log { Task { await refreshLedger() } }
        if inspectorSegment == .queue { Task { await refreshQueue() } }
        Task { await refreshChat() }
    }

    func closeWorkspace() {
        workspaceOpen = false
        innerOpenPath = nil
    }

    func toggleWorkspace() { workspaceOpen ? closeWorkspace() : openWorkspace() }

    /// Navigation away from the workspace (a ref, a card's ⋯ › Open tab, a pane
    /// row): the tab's chat is under the inspector, so the workspace closes.
    /// Consent chips never call this (§13.4).
    func showTab(_ id: String) {
        closeWorkspace()
        MarvinBridge.shared.requestChatTab(.select(id))
    }
    /// [7.2] — the inbox items replies list, by id, in any state: open ones are cards, settled ones one line.
    var chatItems: [String: SupervisorInboxItem] = [:]
    /// [7.3] — `GET /api/supervisor/follows`: open follows first, then recently ended.
    var follows: [SupervisorFollow] = []
    /// ADR-0133 — `GET /api/supervisor/queue`: order, cap, holds and the reason for each.
    var queue: SupervisorQueueView?
    /// The server's refusal of a queue setting (a cap out of range, an unknown entry).
    var queueError: String?

    func refreshQueue() async {
        guard !offline, let pid = projectId else { return }
        do {
            let q = try await SupervisorService.shared.queue(projectId: pid)
            guard projectId == pid else { return }
            queue = q
        } catch SupervisorServiceError.token(let path) {
            tokenError = path
        } catch {
            NSLog("[SupervisorModel] queue failed: \(error)")
        }
    }

    /// The user's own queue settings. The approval of an entry is the inbox card's click, not this.
    func queueAct(_ body: (String) -> [String: Any]) async {
        guard let pid = projectId else { return }
        do {
            try await SupervisorService.shared.queueAction(body(pid))
            queueError = nil
        } catch SupervisorServiceError.refused(_, let message, _) {
            queueError = message
        } catch SupervisorServiceError.token(let path) {
            tokenError = path
        } catch {
            queueError = "The sidecar did not answer."
        }
        await refreshQueue()
        await refreshInbox()
    }

    /// Brief §12.1 — the pinned tab exists only while the supervisor is on.
    var chatTabVisible: Bool { SupervisorChat.tabVisible(mode: status?.mode) }

    func refreshChat() async {
        guard !offline, let pid = projectId, chatTabVisible else { return }
        do {
            let lines = try await SupervisorService.shared.conversation(projectId: pid)
            guard projectId == pid else { return }
            chat = lines
            await refreshChatItems()
            await refreshFollows()
        } catch SupervisorServiceError.token(let path) {
            tokenError = path
        } catch {
            NSLog("[SupervisorModel] conversation failed: \(error)")
        }
    }

    /// [7.3] — the follow chips. Ended ones stay listed so a report can still name its tab.
    func refreshFollows() async {
        guard !offline, let pid = projectId, chatTabVisible else { return }
        do {
            let all = try await SupervisorService.shared.follows(projectId: pid)
            guard projectId == pid else { return }
            follows = all
        } catch {
            NSLog("[SupervisorModel] follows failed: \(error)")
        }
    }

    /// The user's *Stop following* — a record ends; no confirm, nothing else changes.
    func stopFollowing(_ f: SupervisorFollow) async {
        guard let pid = projectId else { return }
        do {
            try await SupervisorService.shared.stopFollow(projectId: pid, id: f.id)
            chatError = nil
            VoiceOver.announce("Stopped following \(f.tabTitle ?? "the tab")")
        } catch SupervisorServiceError.refused(_, let message, _) {
            chatError = message
        } catch {
            chatError = "Could not stop following — the sidecar did not answer."
        }
        await refreshFollows()
    }

    /// [7.3] — a ref under a reply: a tab opens; a card or a log line is shown in the Sessions pane.
    func open(ref: SupervisorChatMessage.Ref) {
        switch SupervisorChat.refTarget(ref) {
        case .tab(let id):
            showTab(id)
        case .item(let id):
            // Needs you is the one inbox (§13.7): the card opens there.
            expandedCards.insert(id)
            MarvinBridge.shared.revealLeftTab("sessions")
        case .ledger:
            inspectorSegment = .log
            Task { await refreshLedger() }
        case nil:
            break
        }
    }

    /// The cards the conversation names. Settled ones too: a card settled in Needs you collapses here.
    func refreshChatItems() async {
        let ids = SupervisorChat.cardIds(chat)
        guard !offline, let pid = projectId, !ids.isEmpty else { return }
        do {
            let all = try await SupervisorService.shared.inbox(projectId: pid, state: "all")
            guard projectId == pid else { return }
            let wanted = Set(ids)
            chatItems = Dictionary(all.filter { wanted.contains($0.id) }.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        } catch {
            NSLog("[SupervisorModel] chat cards failed: \(error)")
        }
    }

    /// True when the server took it; false keeps the text in the composer with `chatError`.
    /// ADR-0129 — `imagePaths` are the composer's image chips; they are scaled, encoded and sent as image content.
    func sendChat(_ raw: String, imagePaths: [String] = []) async -> Bool {
        guard let pid = projectId, let text = SupervisorComposer.sendable(raw, images: imagePaths.count), !chatSending else { return false }
        chatSending = true
        chatPending = text
        chatPendingImages = imagePaths
        defer { chatSending = false; chatPending = nil; chatPendingImages = [] }
        do {
            var images: [SupervisorImageUpload.Prepared] = []
            if !imagePaths.isEmpty {
                switch await SupervisorImageUpload.prepare(paths: imagePaths) {
                case .success(let p): images = p
                case .failure(.unreadable(let name)):
                    chatError = "\(name) could not be read as an image — it was not sent."
                    VoiceOver.announce(chatError ?? "")
                    return false
                case .failure(.tooLarge(let name)):
                    chatError = "\(name) is too large to send, even compressed."
                    VoiceOver.announce(chatError ?? "")
                    return false
                }
            }
            try await SupervisorService.shared.sendMessage(projectId: pid, text: text, images: images)
            chatError = nil
            await refreshChat()
            return true
        } catch SupervisorServiceError.refused(_, let message, _) {
            chatError = message
        } catch {
            chatError = "The message did not reach the sidecar — it was not sent."
        }
        VoiceOver.announce(chatError ?? "")
        return false
    }

    // MARK: - Lifecycle

    func start(projectId pid: String) {
        guard projectId != pid else { return }
        projectId = pid
        status = nil
        inbox = []
        ledger = []
        chat = []
        chatSending = false
        chatError = nil
        workspaceOpen = false
        innerOpenPath = nil
        inspectorSegment = SupervisorInspectorSegment.restored(UserDefaults.standard.string(forKey: Self.segmentKey(pid)))
        chatItems = [:]
        follows = []
        queue = nil
        queueError = nil
        chatSheet = nil
        announcer = SupervisorAnnouncer()
        expandedCards = []
        expandedTabs = []
        refreshAll()
    }

    func refreshAll() {
        Task { await refreshStatus(); await refreshInbox(); if logShown { await refreshLedger() } }
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
            // One item, two places (ADR-0128 §3): a card in the conversation settles with it.
            if chatItems[id] != nil { Task { await refreshChatItems() } }
        case .ledger:
            if logShown { Task { await refreshLedger() } }
            else { ledgerTodayCount += 1 }
        case .message(_, let from):
            if SupervisorChat.needsReload(after: event) {
                Task { await refreshChat() }
                if from == "supervisor" { VoiceOver.announce("Supervisor replied") }
            }
        case .follow:
            Task { await refreshFollows() }
        case .queue:
            // Read only while the workspace shows it, or once it has been read.
            if inspectorSegment == .queue || queue != nil { Task { await refreshQueue() } }
        }
    }

    private func setStatus(_ s: SupervisorStatus) {
        // §13.8 — disabling closes the workspace; it does not swap to the set-up form.
        if !SupervisorWorkspace.staysOpen(after: status?.mode, s.mode) { closeWorkspace() }
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

    func openModelPicker() {
        modelCursor = SupervisorModelPicker.cursorKey(choice: SupervisorModelPicker.selection(status?.model))
        modelPickerOpen = true
        Task { await loadModelChoices() }
    }

    func openEffortPicker() {
        effortCursor = SupervisorEffortPicker.cursorKey(choice: SupervisorEffortPicker.selection(status?.model?.effort))
        effortPickerOpen = true
    }

    /// The user's pick (nil = Default). Takes effect on the next wake.
    func setEffort(_ rung: String?) async {
        effortPickerOpen = false
        do {
            try await SupervisorService.shared.setSupervisorEffort(rung)
            controlNotice = nil
            await refreshStatus()
        } catch SupervisorServiceError.refused(_, let message, _) {
            controlNotice = PaneNotice(kind: .error, headline: "Changing the effort was refused", detail: message)
        } catch {
            controlNotice = PaneNotice(kind: .error,
                                       headline: "Changing the effort didn't reach the sidecar — the supervisor keeps its current one",
                                       detail: error.localizedDescription)
        }
    }

    func loadModelChoices() async {
        guard !offline else { return }
        do {
            modelChoices = try await SupervisorService.shared.modelEntries()
            modelListFailed = false
        } catch {
            modelListFailed = true
            NSLog("[SupervisorModel] model list failed: \(error)")
        }
    }

    /// The user's pick (nil = Default). Takes effect on the next wake; the
    /// status is refetched so the block shows what the server now holds.
    func setModel(_ id: String?) async {
        modelPickerOpen = false
        do {
            try await SupervisorService.shared.setSupervisorModel(id)
            controlNotice = nil
            await refreshStatus()
        } catch SupervisorServiceError.refused(_, let message, _) {
            controlNotice = PaneNotice(kind: .error, headline: "Changing the model was refused", detail: message)
        } catch {
            controlNotice = PaneNotice(kind: .error,
                                       headline: "Changing the model didn't reach the sidecar — the supervisor keeps its current one",
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
    func setPersonality(_ personality: String) async { await control("personality", extra: ["personality": personality], failureVerb: "Changing the personality") }
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
            if chatItems[item.id] != nil { await refreshChatItems() }
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
