// SupervisorWorkspaceView — the Supervisor workspace (design brief §13).
//
// Layout only: the conversation in the centre (the editor slot, above the
// preview), the re-targeted Brain plus a Tabs · Log · Settings inspector over
// the right column's chat, and one line in the Sessions pane. It re-hosts
// `SupervisorChatView`, `SupervisorSettingsBlock`, `SupervisorLogSection` and
// `SupervisorDelegationChip`; it adds no act, verb, policy or consent path.
// Needs you stays the Sessions pane's (the one inbox list, §13.6).
//
// Constraints carried from the pane (ADR-0114 / ADR-0062): no
// `GeometryReader`, no `.textSelection`, no height animation, no intrinsic
// `minWidth`. The header picks its tier with `ViewThatFits`, as the chat
// header's posture pill does; nothing measures a width.

import AppKit
import MARVINLogic
import SwiftUI

// MARK: - The centre (§13.3, §13.4, §13.9)

@MainActor struct SupervisorWorkspaceCentre: View {
    @Bindable var model: SupervisorModel
    @Environment(MarvinBridge.self) private var bridge
    private let registry = SessionRegistry.shared

    /// The reading column (§13.4) and the set-up form's column (§13.9).
    static let readingWidth: CGFloat = 760
    static let formWidth: CGFloat = 520

    private var strip: SupervisorStrip {
        model.strip(feedConnected: model.fixtureFeedConnected ?? registry.feedConnected, now: registry.now)
    }

    var body: some View {
        VStack(spacing: 0) {
            SupervisorWorkspaceHeader(model: model, strip: strip)
            MarvinDivider()
            notices
            if model.isEnabled || model.tokenError != nil {
                SupervisorChatView(model: model)
                    .frame(maxWidth: Self.readingWidth)
                    .frame(maxWidth: .infinity)
            } else {
                ScrollView {
                    SupervisorSetUpForm(model: model, tabs: openTabs, modelLabel: model.status?.model?.label)
                        .frame(maxWidth: Self.formWidth, alignment: .leading)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                        .padding(.horizontal, 20)
                }
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
        .background(MarvinTheme.panel)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Supervisor workspace")
    }

    /// Persistent notices across the centre, under the header (§13.3). Never
    /// auto-dismissed; a verb sits on its own line (§11, departure 12).
    @ViewBuilder private var notices: some View {
        let failure = strip.failure.flatMap { f in model.dismissedFailure == f.headline + (f.detail ?? "") ? nil : f }
        if failure != nil || model.controlNotice != nil || innerOpen != nil {
            VStack(alignment: .leading, spacing: 4) {
                if let f = failure {
                    PaneNoticeStrip(notice: PaneNotice(kind: .error, headline: f.headline, detail: f.detail),
                                    onDismiss: { model.dismissedFailure = f.headline + (f.detail ?? "") })
                    // Retry is the header's primary control in this state; the
                    // notice keeps only the verb the header lacks (critique, polish).
                    if strip.state != .tokenUnavailable {
                        Button("Open log") { model.inspectorSegment = .log; Task { await model.refreshLedger() } }
                            .rowChip(.neutral)
                            .padding(.leading, 10)
                    }
                }
                if let n = model.controlNotice {
                    PaneNoticeStrip(notice: n, onDismiss: { model.controlNotice = nil })
                }
                if let path = innerOpen {
                    // §13.8 — a file opened from inside the workspace sits under it.
                    HStack(spacing: 6) {
                        Image(systemName: "doc.text").font(.system(size: 10)).foregroundStyle(MarvinTheme.textMuted)
                            .accessibilityHidden(true)
                        Text("Opened \((path as NSString).lastPathComponent) under the workspace")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                        Button("Show") { model.closeWorkspace() }.rowChip(.neutral)
                            .help("Close the workspace to see the file")
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(maxWidth: Self.readingWidth + 24)
            .frame(maxWidth: .infinity)
        }
    }

    private var innerOpen: String? {
        guard let p = model.innerOpenPath, bridge.selectedFilePath == p else { return nil }
        return p
    }

    private var openTabs: [(id: String, title: String)] {
        registry.openTabs.compactMap { id in
            guard !registry.isDraft(id) else { return nil }
            return (id, SupervisorTabTitle.text(registry.entry(id) ?? SessionEntry(id: id), inbox: model.inbox))
        }
    }
}

// MARK: - The header (§13.3)

@MainActor struct SupervisorWorkspaceHeader: View {
    let model: SupervisorModel
    let strip: SupervisorStrip
    @State private var confirmDisable = false
    @State private var charterOpen = false

    var body: some View {
        // Tier 1 → 4: the mode text yields, then the $ text and "N for you",
        // then × moves into ⋯. Kill, Pause / Resume and ⋯ never yield.
        ViewThatFits(in: .horizontal) {
            row(tier: 1)
            row(tier: 2)
            row(tier: 3)
            row(tier: 4)
        }
        .frame(height: MarvinTheme.paneHeaderHeight)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MarvinTheme.background)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Supervisor")
        .accessibilityValue(model.isEnabled ? strip.accessibilityValue : "Off.")
        .accessibilityAddTraits(.isHeader)
        .confirmationDialog("Disable the supervisor?", isPresented: $confirmDisable) {
            Button("Disable supervisor", role: .destructive) { Task { await model.disable() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It stops watching and stops waking. The log is kept.")
        }
        .sheet(isPresented: $charterOpen) {
            SupervisorCharterSheet(model: model, onClose: { charterOpen = false })
        }
    }

    private var enabled: Bool { model.isEnabled }
    private var openItems: Int { model.layout.total }

    private func row(tier: Int) -> some View {
        HStack(spacing: 8) {
            Group {
                if strip.showsProgress {
                    ProgressView().controlSize(.mini).frame(width: 12, height: 12)
                } else {
                    Image(systemName: SupervisorMark.symbol)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .frame(width: 12)
                }
            }
            .accessibilityHidden(true)
            Text("Supervisor")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(MarvinTheme.textPrimary)
                .fixedSize()
            if tier < 2 || !enabled {
                // fixedSize: a tier yields whole, never as "Sha…" (ViewThatFits picks the next).
                Text("· " + (enabled ? SupervisorWorkspace.headerMode(strip) : (model.tokenError != nil ? strip.modeLabel : "off")))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .help(strip.help ?? strip.modeLabel)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: 8)
            if enabled {
                if let m = strip.meter {
                    BudgetMeter(meter: m)
                        .accessibilityElement()
                        .accessibilityLabel("Daily budget")
                        .accessibilityValue(strip.meterAccessibilityValue ?? "")
                    if m.level == "reached" {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(GitDecorationColor.deleted)
                            .accessibilityHidden(true)
                    }
                    if tier < 3, let money = SupervisorWorkspace.money(model.status) {
                        Text(money)
                            .font(.system(size: 10.5, design: .monospaced))
                            .monospacedDigit()
                            .foregroundStyle(MarvinTheme.textMuted)
                            .fixedSize()
                            .accessibilityHidden(true)
                    }
                }
                if tier < 3, openItems > 0 {
                    Button {
                        SupervisorWorkspace.showOldestItem(model)
                    } label: {
                        Label("\(openItems) for you", systemImage: "hand.raised.fill")
                    }
                    .rowChip(.neutral)
                    .fixedSize()
                    .help("Needs you is in the Sessions pane — shows the oldest item (⌥⌘J)")
                    .accessibilityLabel("\(openItems) item\(openItems == 1 ? "" : "s") need you — show in Sessions")
                }
                if strip.showKill {
                    Button { Task { await model.kill() } } label: { Label("Kill", systemImage: "stop.fill") }
                        .rowChip(.tinted(GitDecorationColor.deleted))
                        .fixedSize()
                        .help("Abort the wake in flight and pause (⌃⌥⌘K). Never asks: stopping is never the dangerous direction.")
                        .accessibilityLabel("Kill current wake")
                }
                primaryControl
                optionsMenu(closeInside: tier == 4)
            }
            if tier < 4 || !enabled {
                Button { model.closeWorkspace() } label: { Image(systemName: "xmark") }
                    .paneIconButton(9)
                    .help("Close the supervisor workspace (⌃⌥⌘S)")
                    .accessibilityLabel("Close supervisor workspace")
            }
        }
    }

    @ViewBuilder private var primaryControl: some View {
        switch strip.primary {
        case .pause:
            Button { Task { await model.pause() } } label: { Image(systemName: "pause.fill") }
                .paneIconButton(10)
                .disabled(!strip.controlsEnabled)
                .help("Pause the supervisor (⌃⌥⌘P)")
                .accessibilityLabel("Pause supervisor")
        case .resume(let ok):
            Button { Task { await model.resume() } } label: { Label("Resume", systemImage: "play.fill") }
                .rowChip(.primary)
                .fixedSize()
                .disabled(!ok || !strip.controlsEnabled)
                .help(ok ? "Resume the supervisor (⌃⌥⌘P)" : "Raise the daily cap above today's spend to resume")
                .accessibilityLabel("Resume supervisor")
        case .restart:
            Button { Task { await model.wakeNow() } } label: { Label("Restart", systemImage: "arrow.clockwise") }
                .rowChip(.neutral)
                .fixedSize()
                .help("Resume and wake it now for the queued events")
        case .retry:
            Button("Retry") {
                Task { if strip.state == .tokenUnavailable { await model.refreshStatus() } else { await model.wakeNow() } }
            }
            .rowChip(.neutral)
            .fixedSize()
            .accessibilityLabel(strip.state == .tokenUnavailable ? "Retry reading the token" : "Retry the wake")
        }
    }

    private func optionsMenu(closeInside: Bool) -> some View {
        Menu {
            Button("Kill") { Task { await model.kill() } }
                .disabled(!strip.controlsEnabled)
            Button("Wake now") { Task { await model.wakeNow() } }
                .disabled(!strip.controlsEnabled)
            Divider()
            Button("Settings") { model.inspectorSegment = .settings }
            Button("Charter…") { charterOpen = true }
            Button("Show log") { model.inspectorSegment = .log; Task { await model.refreshLedger() } }
            Divider()
            Button("Disable supervisor…") { confirmDisable = true }
            if closeInside {
                Divider()
                Button("Close workspace") { model.closeWorkspace() }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Supervisor options")
        .accessibilityLabel("Supervisor options")
    }
}

extension SupervisorWorkspace {
    /// "$3.20 / $10" — the header's figure, beside the meter.
    static func money(_ s: SupervisorStatus?) -> String? {
        guard let s else { return nil }
        let spent = String(format: "$%.2f", s.budget.spentUsd)
        let cap = s.budget.capUsd.rounded() == s.budget.capUsd ? "$\(Int(s.budget.capUsd))" : String(format: "$%.2f", s.budget.capUsd)
        return "\(spent) / \(cap)"
    }

    /// The header's "N for you" and ⌥⌘J: Needs you is the Sessions pane's.
    @MainActor static func showOldestItem(_ model: SupervisorModel) {
        MarvinBridge.shared.revealLeftTab("sessions")
        let layout = model.layout
        if let first = layout.tabless.first ?? layout.sessionIds.first.flatMap({ layout.byTab[$0]?.shown.first }) {
            model.expandedCards.insert(first.id)
            VoiceOver.announce("Escalation: \(first.escalatedBecause.label)")
        }
    }
}

// MARK: - The inspector (§13.6)

@MainActor struct SupervisorInspector: View {
    @Bindable var model: SupervisorModel
    /// The Brain pane is hidden: the state moves to one line here (§13.5).
    let showsStateLine: Bool
    @State private var confirmDisable = false
    @State private var charterOpen = false
    private let registry = SessionRegistry.shared

    var body: some View {
        VStack(spacing: 0) {
            if showsStateLine {
                SupervisorBrainLine(face: SupervisorBrainFace.current(model))
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
            }
            // ADR-0134 — the standing merge authorisation is shown at all times, with Revoke.
            SupervisorMergeStrip(model: model)
            MarvinDivider()
            Picker("Supervisor inspector", selection: $model.inspectorSegment) {
                ForEach(SupervisorInspectorSegment.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .accessibilityLabel("Supervisor inspector")
            MarvinDivider()
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    switch model.inspectorSegment {
                    case .tabs: SupervisorTabsList(model: model)
                    case .queue: SupervisorQueueSection(model: model)
                    case .log:
                        SupervisorLogSection(model: model, tabTitle: { id in
                            SupervisorTabTitle.text(registry.entry(id) ?? SessionEntry(id: id), inbox: model.inbox)
                        })
                    case .settings:
                        SupervisorSettingsBlock(model: model, charterOpen: $charterOpen,
                                                confirmDisable: $confirmDisable, leadingDivider: false)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
        .background(MarvinTheme.background)
        .onChange(of: model.inspectorSegment) { _, seg in
            if seg == .log { Task { await model.refreshLedger() } }
            if seg == .queue { Task { await model.refreshQueue() } }
        }
        .confirmationDialog("Disable the supervisor?", isPresented: $confirmDisable) {
            Button("Disable supervisor", role: .destructive) { Task { await model.disable() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It stops watching and stops waking. The log is kept.")
        }
        .sheet(isPresented: $charterOpen) {
            SupervisorCharterSheet(model: model, onClose: { charterOpen = false })
        }
    }
}

/// Tab titles as the Sessions pane writes them, for the workspace's lists.
enum SupervisorTabTitle {
    static func text(_ e: SessionEntry, inbox: [SupervisorInboxItem]) -> String {
        if e.isDraft { return "New chat" }
        if let t = e.title?.replacingOccurrences(of: "\n", with: " "), !t.trimmingCharacters(in: .whitespaces).isEmpty {
            return t.count > 40 ? String(t.prefix(38)) + "…" : t
        }
        if let t = inbox.first(where: { $0.sessionId == e.id })?.tabTitle, !t.isEmpty { return t }
        return String(e.id.prefix(8))
    }
}

// MARK: - Tabs (§13.6): the management view of the delegation chips

@MainActor struct SupervisorTabsList: View {
    let model: SupervisorModel
    private let registry = SessionRegistry.shared

    private struct TabRow: Identifiable {
        let id: String
        let title: String
        let supervisor: SessionSupervisorWire?
        let shared: Bool
        let follow: SupervisorFollow?
    }

    private var rows: [TabRow] {
        let follows = SupervisorChat.openFollows(model.follows)
        return registry.openTabs.compactMap { id in
            guard !registry.isDraft(id) else { return nil }
            let e = registry.entry(id) ?? SessionEntry(id: id)
            return TabRow(id: id, title: SupervisorTabTitle.text(e, inbox: model.inbox), supervisor: e.supervisor,
                          shared: e.supervisor?.sharedCheckout ?? (e.mode == .shared),
                          follow: follows.first { $0.sessionId == id })
        }
    }

    var body: some View {
        let all = rows
        let watched = all.filter { ($0.supervisor?.delegation ?? .off) != .off }
        let unwatched = all.filter { ($0.supervisor?.delegation ?? .off) == .off }
        VStack(alignment: .leading, spacing: 6) {
            if all.isEmpty {
                Text("No open tabs. Each chat tab you open appears here with what the supervisor may do in it.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !watched.isEmpty {
                PaneSectionHeader("Watching", count: watched.count).accessibilityAddTraits(.isHeader)
                ForEach(watched) { row($0) }
            }
            if !unwatched.isEmpty {
                PaneSectionHeader("Not watched", count: unwatched.count).accessibilityAddTraits(.isHeader)
                ForEach(unwatched) { row($0) }
            }
        }
    }

    private func row(_ r: TabRow) -> some View {
        let level = r.supervisor?.delegation ?? .off
        return HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(r.title)
                    .font(.system(size: 11.5))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(subtitle(r))
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let f = r.follow {
                    // The follow's Stop following stays in the conversation's strip:
                    // one control, one place (§13.6, departure 23).
                    Label(SupervisorChat.followLabel(f), systemImage: SupervisorMark.symbol)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            SupervisorDelegationChip(model: model, sessionId: r.id, tabTitle: r.title, level: level,
                                     sharedCheckout: r.shared, lastActAt: r.supervisor?.lastActAt, showsLabel: true)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .contain)
        .contextMenu {
            Button("Open tab") { model.showTab(r.id) }
        }
    }

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    private func subtitle(_ r: TabRow) -> String {
        var parts: [String] = []
        if let at = r.supervisor?.lastActAt.flatMap(SessionLedger.parseISO) {
            parts.append("last act \(Self.clock.string(from: at))")
        }
        if r.supervisor?.stoppedByUser == true { parts.append("stopped — supervisor waits for you") }
        if r.shared, (r.supervisor?.delegation ?? .off) != .off {
            parts.append("shared checkout · sends wait while another session works")
        }
        if parts.isEmpty { parts.append((r.supervisor?.delegation ?? .off) == .off ? "not watched" : "no supervisor act yet") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - The supervisor Brain (§13.5)

extension SupervisorBrainFace {
    /// The face for the model as it stands now.
    @MainActor static func current(_ model: SupervisorModel) -> SupervisorBrainFace {
        let registry = SessionRegistry.shared
        let strip = model.strip(feedConnected: model.fixtureFeedConnected ?? registry.feedConnected, now: registry.now)
        let following = SupervisorChat.openFollows(model.follows).map { $0.tabTitle ?? "a tab" }
        let open = registry.openTabs.filter { !registry.isDraft($0) }.count
        return make(strip: strip, status: model.status, openTabs: open, following: following, now: registry.now)
    }
}

/// The caption under the re-targeted orb, and the inspector's state line when
/// the Brain pane is hidden. "SUPERVISOR" replaces "STATE" so the orb says
/// whom it describes.
@MainActor struct SupervisorBrainCaption: View {
    let face: SupervisorBrainFace

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: SupervisorMark.symbol).font(.system(size: 8, weight: .medium))
                Text("SUPERVISOR")
                    .font(.system(size: 9, weight: .regular, design: .monospaced))
                    .tracking(2.5)
            }
            .foregroundStyle(.tertiary)
            HStack(spacing: 4) {
                if let g = face.glyph {
                    Image(systemName: g).font(.system(size: 10)).foregroundStyle(toneColor)
                }
                Text(face.state)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(face.summary)
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.horizontal, 12)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Supervisor state")
        .accessibilityValue(face.accessibilityValue)
    }

    private var toneColor: Color {
        switch face.tone {
        case .neutral: return MarvinTheme.textMuted
        case .warning: return .orange
        case .error: return GitDecorationColor.deleted
        }
    }
}

/// One line for the state when the Brain pane is hidden (§13.5).
@MainActor struct SupervisorBrainLine: View {
    let face: SupervisorBrainFace

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: face.glyph ?? SupervisorMark.symbol)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(face.tone == .neutral ? MarvinTheme.textMuted : (face.tone == .warning ? Color.orange : GitDecorationColor.deleted))
                .accessibilityHidden(true)
            Text(face.state).font(.system(size: 11, design: .monospaced)).foregroundStyle(MarvinTheme.textPrimary)
                .lineLimit(1).fixedSize()
            Text("· " + face.summary).font(.system(size: 10.5)).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .frame(height: 22)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Supervisor state")
        .accessibilityValue(face.accessibilityValue)
    }
}

// MARK: - The Sessions pane's one line (§13.7)

@MainActor struct SupervisorPaneLineView: View {
    let model: SupervisorModel
    let line: SupervisorPaneLine
    @State private var hovered = false

    var body: some View {
        HStack(spacing: 6) {
            Button { model.toggleWorkspace() } label: {
                HStack(spacing: 6) {
                    Group {
                        if line.showsProgress {
                            ProgressView().controlSize(.mini).frame(width: 12, height: 12)
                        } else {
                            Image(systemName: line.glyph ?? SupervisorMark.symbol)
                                .font(.system(size: line.glyph == nil ? 11 : 10, weight: .medium))
                                .foregroundStyle(toneColor)
                                .frame(width: 12)
                        }
                    }
                    .accessibilityHidden(true)
                    Text("Supervisor")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(MarvinTheme.textPrimary)
                        .lineLimit(1)
                        .layoutPriority(1)
                    if let w = line.word {
                        Text("· " + w)
                            .font(.system(size: 10.5))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    if let m = line.meter {
                        BudgetMeter(meter: m).accessibilityHidden(true)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(line.sentence + " — open the supervisor workspace (⌃⌥⌘S)")
            .accessibilityLabel("Supervisor")
            .accessibilityValue(line.sentence)
            .accessibilityHint(model.workspaceOpen ? "Closes the supervisor workspace" : "Opens the supervisor workspace")
            switch line.chip {
            case .kill:
                Button { Task { await model.kill() } } label: { Label("Kill", systemImage: "stop.fill") }
                    .rowChip(.tinted(GitDecorationColor.deleted))
                    .fixedSize()
                    .help("Abort the wake in flight and pause (⌃⌥⌘K)")
                    .accessibilityLabel("Kill current wake")
            case .resume(let ok):
                Button("Resume") { Task { await model.resume() } }
                    .rowChip(.primary)
                    .fixedSize()
                    .disabled(!ok)
                    .help("Resume the supervisor (⌃⌥⌘P)")
                    .accessibilityLabel("Resume supervisor")
            case nil:
                EmptyView()
            }
            if line.showsPause {
                Button { Task { await model.pause() } } label: { Image(systemName: "pause.fill") }
                    .paneIconButton(10)
                    .help("Pause the supervisor (⌃⌥⌘P)")
                    .accessibilityLabel("Pause supervisor")
            }
            Button { model.toggleWorkspace() } label: { Image(systemName: "chevron.right") }
                .paneIconButton(9)
                .help(model.workspaceOpen ? "Close the supervisor workspace" : "Open the supervisor workspace")
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                // Open reads as selected, the rail's own state (polish): a
                // chevron that flipped direction said "back", not "open".
                .fill(model.workspaceOpen ? MarvinTheme.rowSelected : (hovered ? MarvinTheme.rowHover : MarvinTheme.elevated))
                .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                    .stroke(MarvinTheme.border, lineWidth: 1))
        )
        .onHover { hovered = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(model.workspaceOpen ? .isSelected : [])
    }

    private var toneColor: Color {
        switch line.tone {
        case .neutral: return MarvinTheme.textMuted
        case .warning: return .orange
        case .error: return GitDecorationColor.deleted
        }
    }
}
