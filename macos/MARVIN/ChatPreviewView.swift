// ChatPreviewView — Phase 2b/c dev surface for the native chat.
//
// A separate Window scene hosting the native ChatInputBar +
// (Phase 2c) the structured message list. The main MARVIN window's
// WebView keeps rendering the existing web chat independently;
// Phase 2g promotes this content into the main window once the
// remaining sub-phases (cards, confirms, cancel/retry) reach
// parity.
//
// ## Why a separate window during 2b/c
//
//   1. Decoupled iteration. The main window's WebView is a working
//      surface the user actively uses. We don't want a half-built
//      native chat panel cluttering it while we're still figuring
//      out streaming render shapes.
//   2. Independent observation. The dev window can run alongside
//      the web chat in the main window, so we can A/B parity
//      between them — type the same message in both, watch the
//      same response stream into both surfaces.

import SwiftUI

/// View-model for the preview window. Owns the text input, the
/// in-flight turn task, the rendered message list, and a terminal-
/// state surface for stream errors. Phase 2c — replaces 2b's
/// String-based event log with a structured ChatMessage list driven
/// by ChatStreamReducer.
/// Permission strategy values the sidecar accepts. Mirrors the
/// PermissionStrategy union in apps/web/src/app/api/chat/route.ts.
/// Phase 2g.1 — used by the native chat's send path; user picks
/// in Settings (defaults to .auto, the same as the web app's
/// out-of-the-box behaviour).
enum NativePermissionStrategy: String, CaseIterable, Identifiable {
    case auto
    case gated
    var id: String { rawValue }
}

@MainActor
@Observable
final class ChatPreviewModel {
    /// Editor text. Bound to ChatInputBar.
    var draft: String = ""

    /// Phase 5e — pre-send attachment chips (file mentions, image
    /// paste, selected snippets). Serialised into the message text
    /// on submit; the chip strip clears alongside the draft.
    var attachments: [ChatAttachment] = []

    /// True while a turn is in flight. Disables the editor + Send
    /// button so the user can't queue a second turn (the sidecar
    /// allows it, but the dev panel scope is one turn at a time;
    /// 2f will lift this when it adds proper stop / retry).
    var isSending: Bool = false

    /// The full message list rendered by the native chat view.
    /// Each user submit appends a user-side ChatMessage immediately
    /// (optimistic echo), then ChatStreamReducer mutates the list
    /// as cli.event payloads land.
    var messages: [ChatMessage] = []

    /// Last terminal failure for the most-recent turn, surfaced as
    /// a banner in the view. Cleared on next submit.
    var lastError: String? = nil

    /// Pending confirm requests, oldest first. The view renders a
    /// sheet for the head of the queue; once the user decides, we
    /// remove it and the next one (if any) automatically presents.
    /// Phase 2e — a turn can fire several confirms in sequence
    /// (e.g. multiple Bash + Edit calls); queueing keeps the UX
    /// clean instead of stacking N modal sheets.
    var pendingConfirms: [ConfirmRequest] = []

    /// Set of toolUseIds the user has explicitly responded to in
    /// this preview session. Phase 2e doesn't surface "Allow always"
    /// (the API has no concept), but we track responded ids so the
    /// inline tool card can reflect "approved" / "denied" status
    /// without re-rendering the sheet on a duplicate event.
    var resolvedConfirms: [String: ChatService.ConfirmDecision] = [:]

    /// The active marvinSessionId, captured from the most-recent
    /// turn.started event. Cancel uses this to address /api/chat/
    /// cancel — that endpoint keys on marvinSessionId, not turnId.
    /// Cleared when the user resets.
    private(set) var marvinSessionId: String? = nil

    /// Phase 2h — the (projectId, sessionId) pair that the current
    /// in-memory message list reflects. Set when hydrate succeeds;
    /// the view's bridge-change observer compares the bridge's
    /// reported pair against this to decide whether to re-hydrate.
    /// Without this, every redundant `session-changed` from the web
    /// would re-fetch the same transcript and zap any in-progress
    /// state.
    private(set) var loadedProjectId: String? = nil
    private(set) var loadedSessionId: String? = nil

    /// Phase 2h — the live-tail Task. Distinct from `activeTask`
    /// (which owns a POST-driven turn we initiated) because the
    /// resume tail can run in parallel with no local turn — we're
    /// just listening to whatever the sidecar's bus emits.
    private var resumeTask: Task<Void, Never>?

    /// Phase 2h — true while we're fetching the transcript JSON.
    /// Surfaces a thin "loading" affordance so the user doesn't
    /// see an empty list and assume the project has no history.
    private(set) var isHydrating: Bool = false

    /// Past sessions for the active project — drives the header's
    /// Sessions menu. Sourced from GET /api/sessions and refreshed
    /// when the user opens the menu (so newly-completed turns from
    /// a parallel surface show up without a relaunch).
    private(set) var sessions: [SessionSummary] = []
    private var sessionsFetchTask: Task<Void, Never>?

    /// Auto-hydrate: fetch sessions and load the latest one. Called
    /// when no session is set (post-WebView-removal M5, activeMarvinSessionId
    /// is always nil, so this is the primary path for recovering history).
    /// Awaitable — callers don't need to sleep and poll.
    func autoHydrate(projectId: String) async {
        guard loadedSessionId == nil else { return }
        do {
            let res = try await ChatService.shared.fetchSessions(projectId: projectId)
            sessions = res.sessions
            guard loadedSessionId == nil,
                  let latest = sessions.first else { return }
            // Call hydrate directly — selectSession guards on loadedProjectId
            // which is nil until hydrate sets it, causing the first load to no-op.
            hydrate(projectId: projectId, sessionId: latest.sessionId)
        } catch {
            NSLog("[ChatPreview] auto-hydrate failed: \(error)")
        }
    }

    /// Refresh the sessions list for `projectId`. Idempotent: a
    /// fetch in flight isn't re-started; subsequent calls await
    /// the existing task. Called on menu-open + after a turn
    /// completes (so a fresh turn shows up in history without a
    /// relaunch).
    func refreshSessions(projectId: String) {
        sessionsFetchTask?.cancel()
        sessionsFetchTask = Task { @MainActor in
            do {
                let res = try await ChatService.shared.fetchSessions(
                    projectId: projectId
                )
                guard !Task.isCancelled else { return }
                sessions = res.sessions
            } catch is CancellationError {
                /* quiet */
            } catch {
                NSLog("[ChatPreview] refreshSessions failed: \(error)")
            }
        }
    }

    /// Pick a past session — re-route hydrate to that sessionId.
    /// `fallbackProjectId` is passed by the view (from the bridge)
    /// so this works even before the first hydrate has set loadedProjectId.
    func selectSession(_ sessionId: String, fallbackProjectId: String? = nil) {
        guard let projectId = loadedProjectId ?? fallbackProjectId else { return }
        if loadedSessionId == sessionId { return }
        loadedSessionId = nil
        hydrate(projectId: projectId, sessionId: sessionId)
    }

    /// The last user-typed message, retained so the retry button
    /// can resubmit on stream errors without the user retyping.
    /// Cleared on successful completion (turn.completed) and on
    /// reset.
    private(set) var lastSentMessage: String? = nil

    /// The active stream's task, retained so we can cancel on
    /// teardown / second submit. Phase 2f wires the explicit
    /// /api/chat/cancel call alongside; the local task cancel
    /// alone only stops receiving events.
    private var activeTask: Task<Void, Never>?

    /// Send the current draft as a turn. No-op when already
    /// sending or both the draft AND attachments are empty.
    /// Phase 5e — attachments serialise into the message text
    /// (each chip becomes a `@/abs/path` token or a fenced
    /// snippet) so the agent loop sees them as part of the
    /// prompt, no /api/chat schema change required.
    func send(cwd: String?) {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachmentText = attachments
            .map { $0.messageFragment }
            .joined(separator: "\n")
        let composed: String
        if attachmentText.isEmpty {
            composed = trimmed
        } else if trimmed.isEmpty {
            composed = attachmentText
        } else {
            composed = "\(attachmentText)\n\n\(trimmed)"
        }
        guard !composed.isEmpty, !isSending else { return }
        draft = ""
        attachments = []
        sendInternal(message: composed, cwd: cwd)
    }

    /// Phase 2f — re-submit the last user message after an error.
    /// No-op if there's no last message, or if a turn is already
    /// in flight (defensive — the retry button is hidden when
    /// isSending, but state can race).
    func retry(cwd: String?) {
        guard let lastSentMessage, !isSending else { return }
        sendInternal(message: lastSentMessage, cwd: cwd)
    }

    private func sendInternal(message: String, cwd: String?) {
        isSending = true
        lastError = nil
        lastSentMessage = message
        // Optimistic user echo. The wire never sends a `user` event
        // for what we just typed (the SDK's `user` cli.events carry
        // tool_results, not user inputs), so we have to add it
        // ourselves before the assistant starts streaming.
        messages.append(.userText(message))

        // Phase 2g.1 — read permission strategy from UserDefaults
        // instead of hardcoding gated. The user picks via the
        // Settings panel (default: auto). Phase 2e hardcoded gated
        // so the confirm sheet path was exercisable while the
        // native chat lived in a side preview window; now that
        // Phase 2g.3 promotes it to the main chat surface, gated-
        // by-default would mean every tool call hit a confirm
        // prompt for users running in auto-mode — frustrating UX.
        let strategy = UserDefaults.standard.string(
            forKey: "marvin.permissionStrategy"
        ) ?? NativePermissionStrategy.auto.rawValue
        // Phase 2h — pass the captured/hydrated marvinSessionId so
        // the server appends to the same session the web has been
        // writing to. Without this, every native send minted a fresh
        // session and the project ended up with two parallel JSONLs
        // (web-driven + native-driven) that never converged. Nil on
        // the very first turn for a brand-new project — server mints
        // one, we capture it via turn.started, future turns continue
        // the same id.
        let request = ChatRequest(
            message: message,
            cwd: cwd,
            projectId: loadedProjectId,
            marvinSessionId: marvinSessionId,
            permissionStrategy: strategy
        )
        activeTask = Task { @MainActor in
            defer { isSending = false }
            do {
                let stream = ChatService.shared.streamTurn(request: request)
                for try await event in stream {
                    handle(event: event)
                }
            } catch {
                lastError = "\(error)"
            }
        }
    }

    /// Phase 2f — explicit user cancel. Tears down the local SSE
    /// subscription AND POSTs /api/chat/cancel so the agent on the
    /// sidecar actually stops (not just our consumer). The /cancel
    /// is fire-and-forget — failure is logged but doesn't block
    /// the local teardown; a refreshed window can always re-issue.
    func cancel() {
        activeTask?.cancel()
        activeTask = nil
        isSending = false
        // ADR-0021 M4: brief cancelling state → idle.
        MarvinBridge.shared.marvinState = "cancelling"
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(400))
            MarvinBridge.shared.marvinState = "idle"
            MarvinBridge.shared.isBusy = false
        }
        if let id = marvinSessionId {
            Task { @MainActor in
                do {
                    _ = try await ChatService.shared.cancelTurn(marvinSessionId: id)
                } catch {
                    NSLog("[ChatPreview] cancelTurn failed: \(error)")
                }
            }
        }
    }

    func clear() {
        cancel()
        resumeTask?.cancel()
        resumeTask = nil
        messages.removeAll()
        pendingConfirms.removeAll()
        resolvedConfirms.removeAll()
        lastError = nil
        marvinSessionId = nil
        lastSentMessage = nil
        loadedProjectId = nil
        loadedSessionId = nil
        isHydrating = false
    }

    /// Phase 2h — fetch the transcript for `(projectId, sessionId)`,
    /// replay it through the same `ChatStreamReducer` the live SSE
    /// stream uses, then attach to any in-flight turn via
    /// /api/chat/resume so we don't miss events emitted between
    /// hydrate and attach.
    ///
    /// Idempotent: re-calling with a (projectId, sessionId) that
    /// matches `(loadedProjectId, loadedSessionId)` is a no-op. The
    /// caller (the bridge-change observer in ChatPreviewView) is
    /// expected to gate this anyway, but the inner guard makes the
    /// function safe to call from multiple sites without state
    /// double-loading.
    func hydrate(projectId: String, sessionId: String) {
        // Skip when nothing changed — protects in-progress drafts /
        // streams from a redundant session-changed echo.
        if loadedProjectId == projectId, loadedSessionId == sessionId {
            return
        }

        // Cancel any in-flight turn from the previous session so the
        // user doesn't see foreign events landing into the freshly
        // hydrated list.
        cancel()
        resumeTask?.cancel()
        resumeTask = nil

        loadedProjectId = projectId
        loadedSessionId = sessionId
        isHydrating = true
        lastError = nil
        // Wipe state before replay — replay rebuilds the list from
        // scratch. We don't preserve `lastSentMessage` across
        // hydrate because retry semantics belong to the in-memory
        // turn, not the hydrated transcript.
        messages.removeAll()
        pendingConfirms.removeAll()
        resolvedConfirms.removeAll()
        marvinSessionId = sessionId
        lastSentMessage = nil

        Task { @MainActor in
            defer { isHydrating = false }
            do {
                let record = try await ChatService.shared.fetchSession(
                    projectId: projectId,
                    sessionId: sessionId
                )
                // Drop the result if the session changed under us
                // mid-fetch (user clicked another project). The
                // observer will re-fire hydrate for the new pair.
                guard loadedSessionId == sessionId else { return }
                if let record {
                    replay(record: record)
                }
                // Whether we hydrated or not, attempt to tail any
                // live turn. 204 → harmless no-op.
                attachLive(marvinSessionId: sessionId)
            } catch {
                lastError = "Hydrate failed: \(error)"
            }
        }
    }

    /// Replay a stored SessionRecord into the message list using
    /// the same reducer the live stream uses. Phase 2h.
    private func replay(record: SessionRecord) {
        let encoder = JSONEncoder()
        var rebuilt: [ChatMessage] = []

        for turn in record.turns {
            switch turn {
            case let .turnUser(_, message):
                // The optimistic-echo we mint locally on send isn't
                // in the wire, so the JSONL is the only place a
                // user-side row exists for replay. Reuse the same
                // factory `send` uses for visual parity.
                rebuilt.append(.userText(message))
            case let .cliEvent(_, event):
                // Re-encode the inner event to Data and feed the
                // reducer the same bytes a live cli.event would
                // carry — single source of truth for the rendering
                // pipeline.
                if let data = try? encoder.encode(event) {
                    rebuilt = ChatStreamReducer.apply(rebuilt, cliEventData: data)
                }
            case let .turnError(_, err):
                // Match the live path's surface: a banner on the
                // most recent terminal failure. We don't replay a
                // separate row because the row UI for errors is
                // inline (and historical errors aren't actionable).
                lastError = err
            case .turnStarted, .turnCompleted, .confirmRequest,
                 .confirmDecision, .unknown:
                // turn.started — we already have marvinSessionId
                // set from the hydrate args; no row needed.
                // turn.completed — the cli.event `result` already
                // appended a "completed in Nms" row via the reducer.
                // confirm.* — historical confirms are settled by
                // the time we replay, no sheet to raise.
                // unknown — forward-compat skip.
                break
            }
        }

        // Tool calls whose tool_result never landed (interrupted
        // turn) end up with `result: nil`. The reducer keeps them in
        // place — the user sees the "running…" pip, which is wrong
        // for replayed history. Force-clear streaming flags on every
        // assistant message after replay; live streaming flags
        // re-enable themselves when the resume tail lands a fresh
        // assistant.
        for i in rebuilt.indices where rebuilt[i].isStreaming {
            rebuilt[i].isStreaming = false
        }

        messages = rebuilt
    }

    /// Phase 2h — attach to a live turn's event bus via
    /// /api/chat/resume. 204 collapses to a clean finish; otherwise
    /// events feed through the same `handle(event:)` path as a POST-
    /// driven turn so the merge logic in the reducer stays consistent.
    private func attachLive(marvinSessionId: String) {
        resumeTask?.cancel()
        resumeTask = Task { @MainActor in
            do {
                let stream = ChatService.shared.attachLive(
                    marvinSessionId: marvinSessionId
                )
                for try await event in stream {
                    // Drop late events for a session we've since
                    // navigated away from.
                    guard loadedSessionId == marvinSessionId else { break }
                    handle(event: event)
                }
            } catch {
                NSLog("[ChatPreview] attachLive failed: \(error)")
            }
        }
    }

    /// Respond to the head of the pending-confirms queue. Called
    /// from the ConfirmSheet view's button actions. Best-effort —
    /// network failure is logged + the confirm stays pending so the
    /// user can retry. The SDK timeout / explicit cancel will
    /// eventually unwind a stuck confirm.
    func respond(
        to request: ConfirmRequest,
        decision: ChatService.ConfirmDecision,
        denyMessage: String? = nil
    ) {
        Task { @MainActor in
            do {
                try await ChatService.shared.respondToConfirm(
                    turnId: request.turnId,
                    toolUseId: request.toolUseId,
                    decision: decision,
                    denyMessage: denyMessage
                )
                resolvedConfirms[request.toolUseId] = decision
                pendingConfirms.removeAll { $0.toolUseId == request.toolUseId }
            } catch {
                lastError = "Confirm response failed: \(error)"
            }
        }
    }

    /// ADR-0021 M4 — peek at a cliEvent payload to derive marvinState.
    /// Returns "tool" when the assistant message has a tool_use block,
    /// "writing" for a text block, nil for all other event types.
    private func marvinStateForCLIEvent(_ data: Data) -> String? {
        struct Peek: Codable {
            let type: String
            struct Msg: Codable {
                struct Block: Codable { let type: String }
                let content: [Block]?
            }
            let message: Msg?
        }
        guard let env = try? JSONDecoder().decode(Peek.self, from: data),
              env.type == "assistant",
              let blocks = env.message?.content else { return nil }
        if blocks.contains(where: { $0.type == "tool_use" }) { return "tool" }
        if blocks.contains(where: { $0.type == "text" }) { return "writing" }
        return nil
    }

    private func handle(event: ChatTurnEvent) {
        let b = MarvinBridge.shared
        switch event {
        case .turnStarted(let s):
            // Phase 2f — capture the marvinSessionId so cancel can
            // address /api/chat/cancel (which keys on it, not turnId).
            marvinSessionId = s.marvinSessionId
            // ADR-0021 M4: drive brain profile natively from SSE.
            b.marvinState = "thinking"
            b.isBusy = true
        case .cliEvent(let data):
            messages = ChatStreamReducer.apply(messages, cliEventData: data)
            // ADR-0021 M4: detect tool vs writing from cliEvent shape.
            if let s = marvinStateForCLIEvent(data) { b.marvinState = s }
        case .confirmRequest(let c):
            // Phase 2e — queue the confirm; the view's sheet
            // modifier reacts to pendingConfirms.first and presents
            // a modal. We DON'T add a message row for it because
            // the toolCall block already shows "running…" status;
            // duplicating that into a system row would be noise.
            //
            // De-dup against existing pending entries (defensive —
            // the SDK shouldn't re-emit confirms for the same
            // toolUseId, but if it does we don't want a sheet
            // reappearing after the user already decided).
            if !pendingConfirms.contains(where: { $0.toolUseId == c.toolUseId }) {
                pendingConfirms.append(c)
            }
        case .turnCompleted:
            // Post a notification entry for the bell log.
            let prompt = lastSentMessage.flatMap { s in
                s.count > 60 ? String(s.prefix(60)) + "…" : s
            } ?? "Turn completed"
            b.appendNotification(prompt)
            lastSentMessage = nil
            // ADR-0021 M4: reset brain to idle natively.
            b.marvinState = "idle"
            b.isBusy = false
            // ADR-0021 M3: kick BranchService for dirty-count refresh.
            NotificationCenter.default.post(name: .marvinTurnCompleted, object: nil)
        case .turnError(let e):
            lastError = e.error
            // ADR-0021 M4: signal error state natively.
            b.marvinState = "error"
            b.isBusy = false
        case .unknown:
            break
        }
    }
}

/// The preview window itself. Layout:
///
///   ┌──────────────────────────────────┐
///   │ Phase 2 preview · project        │
///   ├──────────────────────────────────┤
///   │ you   │ message text             │
///   │ marvin│ assistant text           │
///   │       │ ╭──────────────╮         │
///   │       │ │ Bash: npm test│        │
///   │       │ ╰──────────────╯         │
///   │ —     │ completed in 4123ms      │
///   ├──────────────────────────────────┤
///   │ ⚠ error banner (if any)          │
///   ├──────────────────────────────────┤
///   │ [text editor]              [Send]│
///   └──────────────────────────────────┘
struct ChatPreviewView: View {
    @Environment(MarvinBridge.self) private var bridge
    @State private var model = ChatPreviewModel()

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            messagesPane
                .frame(minHeight: 240)
            if let err = model.lastError {
                errorBanner(err)
            }
            Divider()
            ChatInputBar(
                text: Bindable(model).draft,
                onSubmit: { model.send(cwd: bridge.projectWorkDir) },
                isSending: model.isSending,
                attachments: Bindable(model).attachments
            )
            .environment(bridge)
            .padding(.horizontal, 12)
            .padding(.top, 12)
            .padding(.bottom, 4)
            // Phase 5e — agents footer below the chat input. Mirrors
            // Cursor / Continue / Aider: the model picker lives in
            // the chat surface, not the global toolbar, because
            // switching executor / advisor is a per-turn decision
            // and that's where the user's attention already is.
            ChatAgentsFooter()
                .environment(bridge)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
        }
        .frame(minWidth: 280, minHeight: 200)
        .preferredColorScheme(bridge.preferredColorScheme)
        // Phase 2h — hydrate the message list when the bridge
        // reports a (projectId, marvinSessionId) we haven't loaded
        // yet. Three triggers funnel through the same code path:
        //   1. .onAppear catches the initial mount when the bridge
        //      already has a session id (web side raced ahead).
        //   2. .onChange of activeMarvinSessionId catches the most
        //      common case — web typed the first turn, captured the
        //      sid, announced it.
        //   3. .onChange of activeProjectId catches a project switch
        //      when the new project's session is the same id (rare
        //      but possible on a slug collision).
        // The model's hydrate method is itself idempotent against
        // the (loadedProjectId, loadedSessionId) it tracks — these
        // observers can fire redundantly without re-fetching.
        .onAppear { syncHydrateFromBridge() }
        .onChange(of: bridge.activeMarvinSessionId) { _, _ in
            syncHydrateFromBridge()
        }
        .onChange(of: bridge.activeProjectId) { _, _ in
            syncHydrateFromBridge()
        }
        // Phase 2e — present the head of the confirm queue as a
        // modal sheet. We use isPresented bound to "is there a
        // pending confirm" (set: false denies the head) so the user
        // can dismiss with Esc and the model unwinds correctly. We
        // can't use .sheet(item:) here because that needs a
        // settable Binding<ConfirmRequest?> and the model exposes
        // an Array; the isPresented+head pattern reads more
        // explicitly than the binding gymnastics anyway.
        .sheet(isPresented: confirmSheetPresented) {
            if let request = model.pendingConfirms.first {
                ConfirmSheet(
                    request: request,
                    onAllow: {
                        model.respond(to: request, decision: .allow)
                    },
                    onDeny: { reason in
                        model.respond(to: request, decision: .deny, denyMessage: reason)
                    }
                )
            }
        }
    }

    /// Phase 2h — react to a (projectId, sessionId) bridge change.
    /// Three outcomes:
    ///
    ///   1. Both non-nil → hydrate. The model dedupes when the pair
    ///      already matches, so this is safe to fire redundantly.
    ///   2. sid nil, but model has a loaded session → web fired a
    ///      "new session" reset (⌘⇧N). Clear the native list to
    ///      match. Without this, a new-session in web leaves stale
    ///      history sitting on the native side.
    ///   3. Both nil from the start (no project active) → no-op;
    ///      the empty initial state is already correct.
    private func syncHydrateFromBridge() {
        if let pid = bridge.activeProjectId,
           let sid = bridge.activeMarvinSessionId {
            model.hydrate(projectId: pid, sessionId: sid)
            return
        }
        // sid went nil with state to clear → match the web reset.
        if model.loadedSessionId != nil || !model.messages.isEmpty {
            model.clear()
        }
        // Post-M5: activeMarvinSessionId is always nil (set only by the
        // now-removed WebView). Fetch sessions directly and pick the
        // latest — await the result instead of sleeping + polling.
        if let pid = bridge.activeProjectId,
           bridge.activeMarvinSessionId == nil,
           model.loadedSessionId == nil {
            Task { await model.autoHydrate(projectId: pid) }
        }
    }

    /// Two-way Binding into the head of pendingConfirms. `false`
    /// from the system (Esc / outside-click) denies the head with
    /// no message — matches the web's "card dismiss → deny"
    /// fallback. `true` is a no-op (we don't programmatically
    /// re-present; the next confirm queue head presents naturally
    /// via state observation).
    /// Sessions menu — shows past transcripts for the active
    /// project, lets the user pick one to load. Refreshes its list
    /// each time it opens so a turn that just completed in another
    /// surface (or just landed) shows up without a relaunch. Hidden
    /// when no project is active (the menu would have nothing useful).
    private var sessionsMenu: some View {
        Menu {
            if model.sessions.isEmpty {
                Button("(no past sessions)") {}
                    .disabled(true)
            } else {
                ForEach(model.sessions) { summary in
                    Button {
                        model.selectSession(
                            summary.sessionId,
                            fallbackProjectId: bridge.activeProjectId
                        )
                    } label: {
                        sessionLabel(for: summary)
                    }
                }
            }
            Divider()
            Button("Refresh") {
                if let pid = bridge.activeProjectId {
                    model.refreshSessions(projectId: pid)
                }
            }
        } label: {
            Image(systemName: "clock.arrow.circlepath")
        }
        .menuStyle(.borderlessButton)
        .controlSize(.small)
        .menuIndicator(.hidden)
        .frame(width: 28)
        .disabled(bridge.activeProjectId == nil)
        .help("Past sessions for this project")
        .onAppear {
            if let pid = bridge.activeProjectId {
                model.refreshSessions(projectId: pid)
            }
        }
        .onChange(of: bridge.activeProjectId) { _, pid in
            if let pid {
                model.refreshSessions(projectId: pid)
            }
        }
    }

    /// Format a session-summary label: "M/D · 12 turns · first 60 chars".
    /// Concise enough to fit the menu width even with long first-user
    /// messages. We trim the user message at 60 chars (vs the wire's
    /// 120) because menu items get truncated anyway and the date +
    /// turn count carry most of the disambiguation value.
    private func sessionLabel(for s: SessionSummary) -> Text {
        let preview = (s.firstUserMessage ?? "(no preview)")
            .replacingOccurrences(of: "\n", with: " ")
        let trimmed = preview.count > 60
            ? String(preview.prefix(57)) + "…"
            : preview
        let date = friendlyDate(s.updatedAt)
        return Text("\(date) · \(s.turnCount)t · \(trimmed)")
    }

    /// "M/D" or "M/D HH:mm" for an ISO timestamp. Falls through to
    /// the raw string on parse failure (defensive — the route emits
    /// strict ISO 8601 today). Today's sessions get the time so users
    /// can disambiguate multiple same-day starts; older ones drop it.
    private func friendlyDate(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        guard let date = parser.date(from: iso) else { return iso }
        let cal = Calendar.current
        let formatter = DateFormatter()
        formatter.dateFormat = cal.isDateInToday(date) ? "HH:mm" : "M/d"
        return formatter.string(from: date)
    }

    private var confirmSheetPresented: Binding<Bool> {
        Binding(
            get: { !model.pendingConfirms.isEmpty },
            set: { isPresenting in
                guard !isPresenting,
                      let head = model.pendingConfirms.first else { return }
                model.respond(to: head, decision: .deny)
            }
        )
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(bridge.projectName ?? "no project active")
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let sid = model.loadedSessionId {
                    Text(sid.prefix(8))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            sessionsMenu
            if model.isSending {
                // Phase 2f — Stop also POSTs /api/chat/cancel so
                // the agent actually halts on the sidecar, not just
                // our local SSE consumer. ⌘. is the macOS-conventional
                // shortcut for "cancel running operation".
                Button("Stop") {
                    model.cancel()
                }
                .keyboardShortcut(".", modifiers: [.command])
                .controlSize(.small)
                .help("Cancel the in-flight turn. ⌘.")
            }
            // Phase 2f — Clear (⌘⇧N) wipes the list, cancels any
            // in-flight turn, and resets the bridge state captured
            // from the last turn.started. Mirrors ⌘⇧N's "new session"
            // intent on the main window (Phase 1d.25 dispatches that
            // shortcut to the web chat); this one handles the native
            // preview's state when the preview window has focus.
            Button("New") {
                model.clear()
            }
            .keyboardShortcut("n", modifiers: [.command, .shift])
            .controlSize(.small)
            .disabled(model.messages.isEmpty && !model.isSending)
            .help("Reset preview state. ⌘⇧N")
        }
        .padding(12)
    }

    private var messagesPane: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.messages.isEmpty {
                        emptyState
                    } else {
                        ForEach(model.messages) { msg in
                            ChatMessageRow(message: msg)
                                .padding(.horizontal, 12)
                                .id(msg.id)
                            Divider()
                                .opacity(0.4)
                        }
                    }
                    Color.clear.frame(height: 1).id("listEnd")
                }
                .padding(.vertical, 8)
            }
            .background(Color(nsColor: .textBackgroundColor).opacity(0.4))
            .onChange(of: model.messages.count) { _, _ in
                // Auto-scroll to the latest message on append. We
                // don't animate the scroll because streaming
                // updates are frequent enough that animation thrash
                // would be worse than an instant jump.
                proxy.scrollTo("listEnd", anchor: .bottom)
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("(no messages yet — type a message and ⌘⏎)")
                .font(.body.monospaced())
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Stream error")
                    .font(.caption.weight(.semibold))
                Text(message)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Spacer()
            // Phase 2f — Retry resubmits the last user message
            // through the same path send() uses. Disabled when
            // there's nothing to retry (e.g. the error came from
            // an empty draft) and while a turn is somehow still
            // in flight (defensive — shouldn't happen because we
            // only set lastError after the catch).
            if model.lastSentMessage != nil {
                Button("Retry") {
                    model.retry(cwd: bridge.projectWorkDir)
                }
                .controlSize(.small)
                .disabled(model.isSending)
                .help("Resubmit the last message through /api/chat.")
            }
            Button("dismiss") { model.lastError = nil }
                .controlSize(.small)
                .buttonStyle(.borderless)
        }
        .padding(10)
        .background(Color.orange.opacity(0.08))
    }
}
