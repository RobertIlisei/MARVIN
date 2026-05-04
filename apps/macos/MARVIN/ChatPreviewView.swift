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

        let request = ChatRequest(message: trimmed, cwd: cwd)
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
        lastError = nil
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
            // Phase 2e replaces this with a modal sheet. For now,
            // surface as an inline system row so we know one fired.
            messages.append(ChatMessage(
                id: "confirm-\(c.confirmId)",
                role: .system,
                blocks: [.text(
                    id: UUID().uuidString,
                    text: "confirm requested · tool: \(c.tool)"
                )],
                isStreaming: false,
                createdAt: Date()
            ))
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
