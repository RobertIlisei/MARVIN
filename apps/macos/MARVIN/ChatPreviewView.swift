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
    /// sending or the draft is whitespace-only.
    func send(cwd: String?) {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSending else { return }
        draft = ""
        sendInternal(message: trimmed, cwd: cwd)
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
        let request = ChatRequest(
            message: message,
            cwd: cwd,
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
        messages.removeAll()
        pendingConfirms.removeAll()
        resolvedConfirms.removeAll()
        lastError = nil
        marvinSessionId = nil
        lastSentMessage = nil
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

    private func handle(event: ChatTurnEvent) {
        switch event {
        case .turnStarted(let s):
            // Phase 2f — capture the marvinSessionId so cancel can
            // address /api/chat/cancel (which keys on it, not turnId).
            marvinSessionId = s.marvinSessionId
        case .cliEvent(let data):
            messages = ChatStreamReducer.apply(messages, cliEventData: data)
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
            // The reducer-side `result` cli.event already mutated
            // isStreaming to false on the assistant message. Clear
            // lastSentMessage on a clean completion so the retry
            // button doesn't offer to resubmit a turn that already
            // succeeded. (Errors keep lastSentMessage so retry
            // works on transient failures.)
            lastSentMessage = nil
        case .turnError(let e):
            lastError = e.error
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
                isSending: model.isSending
            )
            .padding(12)
        }
        .frame(minWidth: 520, minHeight: 420)
        .preferredColorScheme(bridge.preferredColorScheme)
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

    /// Two-way Binding into the head of pendingConfirms. `false`
    /// from the system (Esc / outside-click) denies the head with
    /// no message — matches the web's "card dismiss → deny"
    /// fallback. `true` is a no-op (we don't programmatically
    /// re-present; the next confirm queue head presents naturally
    /// via state observation).
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
                Text("Native chat — Phase 2 preview")
                    .font(.callout.weight(.semibold))
                Text(bridge.projectName ?? "no project active")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            Spacer()
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
