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

    /// The active stream's task, retained so we can cancel on
    /// teardown / second submit. Phase 2f surfaces this as a
    /// proper "Stop turn" button.
    private var activeTask: Task<Void, Never>?

    /// Send the current draft as a turn. No-op when already
    /// sending or the draft is whitespace-only.
    func send(cwd: String?) {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSending else { return }
        draft = ""
        isSending = true
        lastError = nil
        // Optimistic user echo. The wire never sends a `user` event
        // for what we just typed (the SDK's `user` cli.events carry
        // tool_results, not user inputs), so we have to add it
        // ourselves before the assistant starts streaming.
        messages.append(.userText(trimmed))

        // Phase 2e — the preview always submits with
        // permissionStrategy: "gated" so confirm.request flows fire
        // and the new confirm sheet path is exercisable. The web
        // chat in the main window keeps using the user's pref
        // (sent on its own POST bodies). Phase 2f wires a Settings
        // toggle to surface this here so the dev surface and the
        // user's daily mode can match again.
        let request = ChatRequest(
            message: trimmed,
            cwd: cwd,
            permissionStrategy: "gated"
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

    /// Stop the in-flight turn locally. Tears down the SSE
    /// subscription but does NOT cancel the underlying agent run on
    /// the sidecar — Phase 2f wires the explicit /api/chat/cancel
    /// path. For 2c this is enough to recover the UI when a stream
    /// hangs, which is rare against a healthy local sidecar.
    func cancel() {
        activeTask?.cancel()
        activeTask = nil
        isSending = false
    }

    func clear() {
        cancel()
        messages.removeAll()
        pendingConfirms.removeAll()
        resolvedConfirms.removeAll()
        lastError = nil
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
        case .turnStarted:
            // Nothing to do for the list — Phase 2f might surface
            // turnId for retry.
            break
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
            // isStreaming to false on the assistant message. No
            // additional list mutation needed here.
            break
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
                Button("Stop") {
                    model.cancel()
                }
                .controlSize(.small)
                .help("Stops receiving events locally. Phase 2f wires explicit /api/chat/cancel.")
            }
            Button("Clear") {
                model.clear()
            }
            .controlSize(.small)
            .disabled(model.messages.isEmpty && !model.isSending)
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
            Button("dismiss") { model.lastError = nil }
                .controlSize(.small)
                .buttonStyle(.borderless)
        }
        .padding(10)
        .background(Color.orange.opacity(0.08))
    }
}
