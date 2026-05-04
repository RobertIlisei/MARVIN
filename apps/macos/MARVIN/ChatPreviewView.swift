// ChatPreviewView — Phase 2b dev surface for the native chat.
//
// A small, separate Window scene that hosts the new native
// ChatInputBar. Phase 2b is send-only — the user types, hits ⌘⏎,
// the message goes through ChatService, and event names + cli.event
// excerpts log to a scrolling text area below the input. The web
// chat in the main MARVIN window keeps working independently.
//
// Phase 2c will replace the log area with a real native message list.
// At that point the preview window goes away (or becomes the chat
// island that gets promoted into the main window in Phase 2g).
//
// ## Why a separate window during 2b/c
//
// Two reasons:
//
//   1. Decoupled iteration. The main window's WebView is a working
//      surface the user actively uses. We don't want a half-built
//      native chat panel cluttering it while we're still figuring
//      out streaming render shapes.
//   2. Independent observation. The dev window can run alongside
//      the web chat in the main window, so we can A/B parity
//      between them — type the same message in both and watch the
//      same response stream into both surfaces.
//
// ## Why the message log is a String, not an array of typed events
//
// 2b is send-only — we just need to confirm the SSE stream lands.
// Storing a textual log is the cheapest way to get visible signal
// without locking in an event-list shape that 2c will throw away
// the moment we render structured messages.

import SwiftUI

/// View-model for the preview window. Owns the text input, the
/// in-flight turn task, and the running event log. Phase 2c
/// replaces `eventLog` with a real `[Message]` model and adds
/// streaming-block updates.
@MainActor
@Observable
final class ChatPreviewModel {
    /// Editor text. Bound to ChatInputBar.
    var draft: String = ""

    /// True while a turn is in flight. Disables the editor + Send
    /// button so the user can't queue a second turn (the sidecar
    /// allows it, but the dev panel scope is one turn at a time).
    var isSending: Bool = false

    /// Append-only event log — newest at the bottom. Capped at
    /// `logCap` lines so a long session doesn't grow the in-memory
    /// string unboundedly.
    var eventLog: String = ""

    /// The active stream's task, retained so we can cancel on
    /// teardown / second submit. Phase 2f will surface this as a
    /// proper "Stop turn" button.
    private var activeTask: Task<Void, Never>?

    /// Cap on the log buffer (chars). The log surface is dev-only,
    /// it doesn't need to scroll back forever.
    private let logCap = 32_000

    /// Send the current draft as a turn. No-op when already
    /// sending or the draft is whitespace-only.
    func send(cwd: String?) {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSending else { return }
        draft = ""
        isSending = true
        appendLog("→ POST /api/chat   message=\(trimmed.prefix(80))")
        let request = ChatRequest(
            message: trimmed,
            cwd: cwd
        )
        activeTask = Task { @MainActor in
            defer { isSending = false }
            do {
                let stream = ChatService.shared.streamTurn(request: request)
                for try await event in stream {
                    handle(event: event)
                }
                appendLog("← stream ended cleanly")
            } catch {
                appendLog("× stream failed: \(error)")
            }
        }
    }

    private func handle(event: ChatTurnEvent) {
        switch event {
        case .turnStarted(let s):
            appendLog("← turn.started turnId=\(s.turnId.prefix(8))…")
        case .cliEvent(let data):
            // Pull just the `type` discriminator out for the log —
            // full payloads are noisy. The full Data goes to the
            // structured renderer in Phase 2c.
            let raw = String(data: data, encoding: .utf8) ?? ""
            let kind = extractKind(from: raw)
            appendLog("← cli.event type=\(kind)")
        case .confirmRequest(let c):
            appendLog("← confirm.request tool=\(c.tool)")
        case .turnCompleted(let c):
            let cost = c.costUsd.map { String(format: "$%.4f", $0) } ?? "—"
            appendLog("← turn.completed cost=\(cost) duration=\(c.durationMs ?? 0)ms")
        case .turnError(let e):
            appendLog("× turn.error: \(e.error)")
        case .unknown(let name, _):
            appendLog("? unknown event: \(name)")
        }
    }

    /// Pull the JSON `type` field out of a cli.event payload —
    /// cheaper than full Codable for a log line.
    private func extractKind(from raw: String) -> String {
        guard let typeRange = raw.range(of: "\"type\":\"") else { return "?" }
        let after = raw[typeRange.upperBound...]
        guard let close = after.firstIndex(of: "\"") else { return "?" }
        return String(after[after.startIndex..<close])
    }

    private func appendLog(_ line: String) {
        let timestamp = Date().formatted(date: .omitted, time: .standard)
        let entry = "[\(timestamp)] \(line)\n"
        eventLog += entry
        if eventLog.count > logCap {
            // Drop the oldest 25% so we don't trim every line.
            let cut = eventLog.index(
                eventLog.startIndex,
                offsetBy: eventLog.count - (logCap * 3 / 4)
            )
            eventLog = String(eventLog[cut...])
        }
    }

    func clearLog() {
        eventLog = ""
    }
}

/// The preview window itself. Layout:
///
///   ┌──────────────────────────────────┐
///   │ Phase 2b — native chat preview   │
///   ├──────────────────────────────────┤
///   │                                  │
///   │  event log (read-only ScrollView)│
///   │                                  │
///   ├──────────────────────────────────┤
///   │ [text editor]                    │
///   │                            [Send]│
///   └──────────────────────────────────┘
struct ChatPreviewView: View {
    @Environment(MarvinBridge.self) private var bridge
    @State private var model = ChatPreviewModel()

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            eventLogPane
                .frame(minHeight: 200)
            Divider()
            ChatInputBar(
                text: Bindable(model).draft,
                onSubmit: { model.send(cwd: bridge.projectWorkDir) },
                isSending: model.isSending
            )
            .padding(12)
        }
        .frame(minWidth: 480, minHeight: 360)
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
            Button("Clear log") {
                model.clearLog()
            }
            .controlSize(.small)
            .disabled(model.eventLog.isEmpty)
        }
        .padding(12)
    }

    private var eventLogPane: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(model.eventLog.isEmpty ? "(no events yet — type a message and ⌘⏎)" : model.eventLog)
                    .font(.body.monospaced())
                    .foregroundStyle(model.eventLog.isEmpty ? .tertiary : .primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(12)
                    .id("logEnd")
            }
            .background(Color(nsColor: .textBackgroundColor))
            .onChange(of: model.eventLog) { _, _ in
                // Auto-scroll the log to the bottom when new events
                // land — same behaviour the dev console of every
                // browser has.
                withAnimation(.easeOut(duration: 0.1)) {
                    proxy.scrollTo("logEnd", anchor: .bottom)
                }
            }
        }
    }
}
