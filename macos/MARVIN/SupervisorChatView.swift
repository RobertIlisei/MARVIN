import MARVINLogic
import SwiftUI

/// ADR-0128 / brief §12 — the user's conversation with the project's
/// supervisor, hosted in the centre of the Supervisor workspace (brief §13). It talks only to `/api/supervisor/message`
/// (through `SupervisorModel`), never to `/api/chat`, and it holds no consent
/// control: from [7.2] the only buttons here are the inbox's own cards.
@MainActor struct SupervisorChatView: View {
    @Bindable var model: SupervisorModel
    @Environment(MarvinBridge.self) private var bridge
    @State private var draft = ""
    /// ADR-0129 — the chips: images go as image content, other files as backticked paths.
    @State private var attachments: [ChatAttachment] = []
    /// Images the composer saved from the clipboard; removed once the server holds its own copy.
    @State private var ownedImages: Set<String> = []
    @State private var atPickerOpen = false
    @State private var isDropTargeted = false
    @AppStorage("marvin.supervisor.editorHeight") private var editorHeight: Double = 64

    /// `draft` and `attachments` seed the composer (the surface snapshots); the tab opens empty.
    init(model: SupervisorModel, draft: String = "", attachments: [ChatAttachment] = []) {
        _model = Bindable(model)
        _draft = State(initialValue: draft)
        _attachments = State(initialValue: attachments)
    }

    var body: some View {
        VStack(spacing: 0) {
            conversation
                .frame(minHeight: 140, idealHeight: 140, maxHeight: .infinity)
            if let paused = SupervisorChat.pausedNotice(model.status, budgetCard: budgetItem != nil) {
                // No ✕: the notice goes when the supervisor resumes. Its verb sits on its own line (§11, departure 12).
                VStack(alignment: .leading, spacing: 4) {
                    PaneNoticeStrip(notice: PaneNotice(kind: .warning, headline: paused.headline))
                        .padding(.horizontal, -10)
                    // Resume is the workspace header's primary control in this state
                    // (brief §13.17, departure 30); the notice keeps the words.
                }
                .padding(.horizontal, 12)
                .padding(.top, 6)
            }
            if !SupervisorChat.openFollows(model.follows).isEmpty {
                followStrip
                    .padding(.horizontal, 12)
                    .padding(.top, 6)
            }
            if let err = model.chatError {
                PaneNoticeStrip(notice: PaneNotice(kind: .error, headline: err), onDismiss: { model.chatError = nil })
                    .padding(.horizontal, 2)
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

    /// ADR-0128 §7 — the budget guardrail, drawn at the foot of the conversation.
    private var budgetItem: SupervisorInboxItem? { SupervisorChat.budgetGuardrail(model.inbox) }

    @ViewBuilder private var conversation: some View {
        if model.chat.isEmpty && model.chatPending == nil && budgetItem == nil {
            emptyState
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(model.chat) { m in
                            row(m).id(m.id)
                        }
                        // §12.6 — the bubble shows at once, before the route answers.
                        if let pending = model.chatPending {
                            row(SupervisorChatMessage(id: "pending", at: "", from: "user", text: pending), pendingImages: model.chatPendingImages).id("pending")
                        }
                        if working {
                            workingRow.id("working")
                        }
                        if let budget = budgetItem {
                            // The conversation's foot, not a reply's card: the full column, so its
                            // detail is not cut at 260 (it truncated at the reply indent).
                            SupervisorItemCard(model: model, item: budget, enabled: model.tokenError == nil, surface: .chat)
                                .padding(.vertical, 6)
                                .id("budget")
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

    @ViewBuilder private func row(_ m: SupervisorChatMessage, pendingImages: [String] = []) -> some View {
        if m.isReply {
            replyRow(m)
        } else {
            VStack(alignment: .trailing, spacing: 2) {
                // The user's words are drawn as the user's: the transcript's own bubble, which
                // renders each `@/path` image token as the picture (ADR-0129).
                let images = pendingImages + (m.attachments ?? []).compactMap(\.path)
                ChatMessageRow(message: ChatMessage(id: "sup-\(m.id)", role: .user,
                                                    blocks: [.text(id: m.id, text: SupervisorComposer.bubbleText(m.text, imagePaths: images))],
                                                    isStreaming: false, createdAt: Date()))
                if m.id == "pending" {
                    Text("Sending…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if let state = SupervisorChat.unanswered(m.id, retry: model.status?.messageRetry) {
                    unansweredLine(state)
                } else if waiting.contains(m.id) && !working {
                    Text(SupervisorChat.waitingLine(paused: model.status?.run == "paused"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(SupervisorChat.accessibilityLabel(m, reportTab: nil))
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
                // The glyph carries the hue; the words stay legible (orange text is ~2:1 on light chrome).
                Label {
                    Text("The supervisor couldn't answer this").foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                }
                .font(.caption)
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
                        SupervisorItemCard(model: model, item: item, enabled: model.tokenError == nil, surface: .chat)
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
            refLinks(m)
            cards(m)
        }
    }

    /// [7.3] — the reply's server-resolved refs, as links. The only links in a reply:
    /// its own text stays inert (ADR-0128 §3), and each label is the server's.
    @ViewBuilder private func refLinks(_ m: SupervisorChatMessage) -> some View {
        let refs = (m.refs ?? []).filter { SupervisorChat.refTarget($0) != nil }
        if !refs.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(refs, id: \.self) { ref in
                    Button { model.open(ref: ref) } label: {
                        Label(ref.label, systemImage: SupervisorChat.refSymbol(ref))
                            .font(.caption)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .buttonStyle(.link)
                    .help(ref.kind == "tab" ? "Open this tab" : ref.kind == "item" ? "Show this card in Needs you" : "Show the supervisor's log")
                    .accessibilityLabel("\(ref.kind == "tab" ? "Tab" : ref.kind == "item" ? "Card" : "Log line"): \(ref.label)")
                }
            }
            .padding(.leading, 66)
            .padding(.bottom, 6)
        }
    }

    // MARK: - [7.3] Follows

    /// One chip per open follow: what it waits for, and the user's Stop following.
    private var followStrip: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(SupervisorChat.openFollows(model.follows)) { f in
                // The label keeps its full lines and the chip sits under it (§11, departure 12):
                // beside it at 260 the label lost "until it is ready to merge" to an ellipsis.
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "eye").font(.system(size: 10))
                            .foregroundStyle(MarvinTheme.textMuted)
                            .accessibilityHidden(true)
                        Text(SupervisorChat.followLabel(f))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    Button("Stop following") { Task { await model.stopFollowing(f) } }
                        .rowChip(.neutral)
                        .disabled(model.tokenError != nil)
                        .help("The supervisor stops reporting on this tab. Nothing else changes.")
                        .padding(.leading, 16)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(SupervisorChat.followLabel(f))
                .accessibilityAction(named: "Stop following") { Task { await model.stopFollowing(f) } }
            }
        }
    }

    private func replyText(_ m: SupervisorChatMessage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            // The 56 pt gutter keeps the text column; the label heads it, as §6.8's does
            // above a bubble — in the gutter it wrapped to SU-PER-VISOR (§11, departure 14).
            Color.clear.frame(width: 56, height: 1)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    // [7.3] — a report is the one reply no message of yours asked for: its label says so.
                    Image(systemName: m.isReport ? "eye" : "binoculars").font(.caption2)
                    Text(m.isReport ? "report" : "supervisor")
                        .font(.caption2.monospaced())
                        .tracking(2)
                        .textCase(.uppercase)
                        .lineLimit(1)
                }
                .foregroundStyle(MarvinTheme.textMuted)
                .accessibilityHidden(true)
                if let tab = SupervisorChat.reportTab(m, follows: model.follows) {
                    Text("On \(tab), which you asked it to follow")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                // ADR-0128 §3 — Markdown with no actionable element: `inert` strips every link,
                // detected ones included, and shows a hidden URL as text. Code blocks keep Copy.
                MarkdownView(text: m.text, fillWidth: true, inert: true)
                Text(Self.time(m.at))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(SupervisorChat.accessibilityLabel(m, reportTab: SupervisorChat.reportTab(m, follows: model.follows)))
        // The transcript's own command: the whole reply, from the record, not from the rendered view.
        .contextMenu {
            Button("Copy Message") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(m.text, forType: .string)
            }
        }
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

    private var imagePaths: [String] {
        attachments.compactMap { if case .image(let p) = $0.kind { return p } else { return nil } }
    }

    private var filePaths: [String] {
        attachments.compactMap { if case .file(let p) = $0.kind { return p } else { return nil } }
    }

    private var composed: String { SupervisorComposer.compose(draft, files: filePaths, workDir: bridge.projectWorkDir) }

    private var canSend: Bool {
        SupervisorComposer.sendable(composed, images: imagePaths.count) != nil && !model.chatSending
    }

    /// ADR-0129 — a pasted or dropped file becomes a chip, the main chat's way: images as images.
    private func attach(_ url: URL) {
        let att = FileTypeIcon.kind(for: url.path) == .image
            ? ChatAttachment(kind: .image(absPath: url.path))
            : ChatAttachment(kind: .file(absPath: url.path))
        attachments.append(att)
    }

    private var composer: some View {
        VStack(spacing: 4) {
            ChatAttachmentsBar(attachments: $attachments)
                // Inside the box's rounded border: flush, the first chip was cut at its edge (snapshot, 260 pt).
                .padding(.horizontal, 8)
                .padding(.top, attachments.isEmpty ? 0 : 6)
            ComposerResizeHandle(height: $editorHeight, range: 44...400)
            HStack(alignment: .bottom, spacing: 4) {
                ZStack(alignment: .topLeading) {
                    // Return sends and never reaches anything else (ADR-0128 §1); ⇧Return is a newline.
                    // Transparent: the editor's own fill drew an opaque block over the placeholder
                    // (backlog, [7.3] renders).
                    ChatTextEditor(
                        text: $draft, onSubmit: submit, isDisabled: model.chatSending,
                        onImagePaste: { image in
                            guard let url = ClipboardImage.savePNG(image) else { return false }
                            ownedImages.insert(url.path)
                            attachments.append(ChatAttachment(kind: .image(absPath: url.path)))
                            return true
                        },
                        onFilePaste: { urls in
                            urls.forEach(attach)
                            return true
                        },
                        onAtTrigger: {
                            guard bridge.projectWorkDir != nil else { return false }
                            atPickerOpen = true
                            return true
                        },
                        transparent: true,
                        focusToken: model.composerFocusToken
                    )
                    .frame(minHeight: 44, idealHeight: editorHeight, maxHeight: editorHeight)
                    .accessibilityLabel("Message the supervisor")
                    .help("⏎ send · ⇧⏎ new line · paste or drop an image or file · @ a project file")
                    if draft.isEmpty && attachments.isEmpty {
                        // Drawn over the editor, inset to its text (6 pt container + 5 pt line padding, 8 pt top).
                        Text("Message the supervisor — it can propose, never consent for you")
                            .font(.body)
                            // .secondary, not the chat's .tertiary: this placeholder carries the consent rule (~2:1 → ~4.5:1).
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .padding(.leading, 11)
                            .padding(.trailing, 4)
                            .padding(.top, 8)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .opacity(model.chatSending ? 0.55 : 1)
                VStack(spacing: 6) {
                    Button { atPickerOpen = true } label: {
                        Image(systemName: "paperclip").font(.system(size: 13))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .disabled(bridge.projectWorkDir == nil || model.chatSending)
                    .help("Attach a project file (or type @)")
                    .accessibilityLabel("Attach a project file")
                    Button(action: submit) {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 20))
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .accessibilityLabel("Send to the supervisor")
                }
                .padding(.trailing, 6)
                .padding(.bottom, 6)
            }
        }
        // The chat composer's box: elevated fill, radius 10, a hairline border — the accent while a file hovers.
        .background(MarvinTheme.elevated, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(isDropTargeted ? Color.accentColor : MarvinTheme.border, lineWidth: isDropTargeted ? 2 : 1)
        )
        .onDrop(of: [.fileURL], isTargeted: $isDropTargeted) { providers in
            var accepted = false
            for provider in providers where provider.canLoadObject(ofClass: URL.self) {
                accepted = true
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url, url.isFileURL else { return }
                    Task { @MainActor in attach(url) }
                }
            }
            return accepted
        }
        .sheet(isPresented: $atPickerOpen) {
            FileMentionPicker { picked in
                if let picked { attachments.append(ChatAttachment(kind: .file(absPath: picked))) }
                atPickerOpen = false
            }
        }
    }

    private func submit() {
        let text = composed
        let images = imagePaths
        guard SupervisorComposer.sendable(text, images: images.count) != nil else { return }
        Task {
            // A refused send keeps the text and the chips: nothing the user gave is lost (§12.3).
            guard await model.sendChat(text, imagePaths: images) else { return }
            draft = ""
            attachments = []
            // The server holds its own copy now; the clipboard copies the composer made are spent.
            for p in images where ownedImages.contains(p) { try? FileManager.default.removeItem(atPath: p) }
            ownedImages.subtract(images)
        }
    }

    private static func time(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
        return d.formatted(date: .omitted, time: .shortened)
    }
}
