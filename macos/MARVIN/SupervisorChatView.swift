import MARVINLogic
import SwiftUI

/// ADR-0128 / brief §12 — the pinned Supervisor tab: the user's conversation
/// with the project's supervisor. It talks only to `/api/supervisor/message`
/// (through `SupervisorModel`), never to `/api/chat`, and it holds no consent
/// control: from [7.2] the only buttons here are the inbox's own cards.
@MainActor struct SupervisorChatView: View {
    @Bindable var model: SupervisorModel
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 0) {
            conversation
                .frame(minHeight: 140, idealHeight: 140, maxHeight: .infinity)
            if let notice = pausedNotice {
                // No ✕: the notice goes when the supervisor resumes.
                PaneNoticeStrip(notice: notice, onDismiss: {})
                    .padding(.horizontal, 12)
                    .padding(.top, 6)
            }
            if let err = model.chatError {
                PaneNoticeStrip(notice: PaneNotice(kind: .error, headline: err), onDismiss: { model.chatError = nil })
                    .padding(.horizontal, 12)
                    .padding(.top, 6)
            }
            composer
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 8)
        }
        .task(id: model.projectId) { await model.refreshChat() }
        .sheet(item: Binding(get: { model.chatSheet }, set: { model.chatSheet = $0 })) { sheet in
            chatSheet(sheet)
        }
    }

    /// A card's sheets, opened from here (the Sessions pane holds its own for the same items).
    @ViewBuilder private func chatSheet(_ sheet: SupervisorCardSheet) -> some View {
        let close = { model.chatSheet = nil }
        switch sheet {
        case .answer(let item):
            if let req = item.asQuestionConfirm {
                AskQuestionSheet(request: req, onSubmit: { updated in
                    let answers = updated["answers"] ?? [:]
                    close()
                    Task { await model.act(item, actionId: "answer-edit", edits: ["answers": answers]) }
                }, onSkip: close)
            }
        case .newTabEdit(let item): SupervisorNewTabEditSheet(model: model, item: item, onClose: close)
        case .sendEdit(let item): SupervisorSendEditSheet(model: model, item: item, onClose: close)
        case .raiseCap(let item): SupervisorRaiseCapSheet(model: model, item: item, onClose: close)
        }
    }

    // MARK: - The conversation (§12.2)

    private var waiting: Set<String> { Set(SupervisorChat.waiting(model.chat)) }

    @ViewBuilder private var conversation: some View {
        if model.chat.isEmpty {
            emptyState
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(model.chat) { m in
                            row(m).id(m.id)
                        }
                        if working {
                            workingRow.id("working")
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .onChange(of: model.chat.last?.id) { _, last in
                    guard let last else { return }
                    MarvinMotion.with(MarvinTheme.transition) { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
        }
    }

    @ViewBuilder private func row(_ m: SupervisorChatMessage) -> some View {
        if m.isReply {
            replyRow(m)
        } else {
            VStack(alignment: .trailing, spacing: 2) {
                // The user's words are drawn as the user's: the transcript's own bubble.
                ChatMessageRow(message: ChatMessage(id: "sup-\(m.id)", role: .user,
                                                    blocks: [.text(id: m.id, text: m.text)],
                                                    isStreaming: false, createdAt: Date()))
                if let state = SupervisorChat.unanswered(m.id, retry: model.status?.messageRetry) {
                    unansweredLine(state)
                } else if waiting.contains(m.id) && !working {
                    Text("Waiting for the next wake")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("You: \(m.text)")
        }
    }

    /// ADR-0128 §6 — a message the supervisor could not answer is never left silent.
    @ViewBuilder private func unansweredLine(_ state: SupervisorChat.Unanswered) -> some View {
        switch state {
        case .retrying(let attempt):
            Text("Couldn't answer yet — retrying (attempt \(attempt + 1))")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .failed:
            VStack(alignment: .trailing, spacing: 4) {
                Label("The supervisor couldn't answer this", systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                // Restart re-queues every unanswered message (the strip's own verb).
                Button("Retry") { Task { await model.wakeNow() } }
                    .rowChip(.neutral)
                    .help("Wake the supervisor again for the messages it has not answered")
            }
        }
    }

    /// [7.2] — the cards a reply lists, under it, in the reply's text column. Each is the inbox item itself.
    @ViewBuilder private func cards(_ m: SupervisorChatMessage) -> some View {
        let ids = m.items ?? []
        if !ids.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(ids, id: \.self) { id in
                    switch SupervisorChat.card(id, items: model.chatItems) {
                    case .open(let item):
                        SupervisorEscalationCard(model: model, item: item, enabled: model.tokenError == nil, surface: .chat)
                    case .settled(_, let line):
                        Label(line, systemImage: "checkmark.circle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .accessibilityLabel("Card settled: \(line)")
                    case .missing:
                        EmptyView()
                    }
                }
            }
            .padding(.leading, 66)
            .padding(.bottom, 6)
        }
    }

    /// Like an assistant turn: the 56 pt gutter, never right-aligned, never filled (discovery answer, §12).
    private func replyRow(_ m: SupervisorChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            replyText(m)
            cards(m)
        }
    }

    private func replyText(_ m: SupervisorChatMessage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            HStack(spacing: 3) {
                Image(systemName: "binoculars").font(.system(size: 9))
                Text("SUPERVISOR").font(.caption2.monospaced()).tracking(1)
            }
            .foregroundStyle(MarvinTheme.textMuted)
            .frame(width: 56, alignment: .topTrailing)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                // Every link removed (ADR-0128 §3): plain `Text` over an AttributedString with no
                // `.link` run, so nothing in a reply is clickable — `RichText` would autolink.
                Text(SupervisorChat.neutralisedReply(m.text))
                    .font(.body)
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(Self.time(m.at))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Supervisor reply, not from you: \(m.text)")
    }

    // MARK: - The working indicator (§12.4)

    private var working: Bool {
        guard !(model.status?.run == "paused") else { return false }
        // A message the retry is backing off on, or gave up on, shows its own line, not a spinner.
        let retrying = Set(model.status?.messageRetry?.messageIds ?? [])
        return model.status?.currentWake != nil || !waiting.subtracting(retrying).isEmpty
    }

    private var workingRow: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text("Supervisor is reading…").font(.caption).foregroundStyle(.secondary)
        }
        .padding(.leading, 66)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private var pausedNotice: PaneNotice? {
        guard model.status?.run == "paused" else { return nil }
        return PaneNotice(kind: .warning, headline: "Paused — your message waits until you resume")
    }

    // MARK: - The empty conversation (§12.5)

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "binoculars")
                .font(.system(size: 22))
                .foregroundStyle(MarvinTheme.textMuted)
            Text("Talk to the supervisor").font(.headline)
            Text("Ask it about your tabs, or for a tab to be opened. What it may not do on its own comes back as a card you click.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    // MARK: - The composer (§12.3)

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            ZStack(alignment: .topLeading) {
                if draft.isEmpty {
                    Text("Message the supervisor — it can propose, never consent for you")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 5)
                        .padding(.top, 1)
                        .allowsHitTesting(false)
                }
                // Return sends and never reaches anything else (ADR-0128 §1); ⇧Return is a newline.
                ChatTextEditor(text: $draft, onSubmit: submit, isDisabled: model.chatSending)
                    .frame(minHeight: 22, maxHeight: 120)
                    .accessibilityLabel("Message the supervisor")
            }
            Button(action: submit) {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 20))
            }
            .buttonStyle(.plain)
            .disabled(SupervisorChat.sendable(draft) == nil || model.chatSending)
            .accessibilityLabel("Send to the supervisor")
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(MarvinTheme.border, lineWidth: 1)
        )
    }

    private func submit() {
        let text = draft
        guard SupervisorChat.sendable(text) != nil else { return }
        Task {
            // A refused send keeps the text: nothing the user typed is lost (§12.3).
            if await model.sendChat(text) { draft = "" }
        }
    }

    private static func time(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
        return d.formatted(date: .omitted, time: .shortened)
    }
}
