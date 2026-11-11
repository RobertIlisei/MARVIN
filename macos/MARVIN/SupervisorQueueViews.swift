// SupervisorQueueViews — the approved queue (ADR-0133, plan [5.6]).
//
// Two surfaces, one rule: the click on a card is the consent.
//  - `SupervisorQueueCardView`: the approval card a `queue` inbox item draws —
//    the proposed entries with each brief's first lines (approve all, or the
//    ones you tick), the guard command in FULL, or a held entry's two lines.
//  - `SupervisorQueueSection`: the Queue segment of the Supervisor workspace —
//    the order, your cap, the guard's last run, each hold and why. The only
//    settings here are yours: the cap, a release, a removal and a guard card
//    to review. Nothing here approves an entry.

import MARVINLogic
import SwiftUI

// MARK: - The card

@MainActor struct SupervisorQueueCardView: View {
    let model: SupervisorModel
    let item: SupervisorInboxItem
    let card: SupervisorQueueCard
    let enabled: Bool
    @State private var selection: SupervisorQueueSelection
    @State private var expanded: Set<String> = []

    init(model: SupervisorModel, item: SupervisorInboxItem, card: SupervisorQueueCard, enabled: Bool) {
        self.model = model; self.item = item; self.card = card; self.enabled = enabled
        _selection = State(initialValue: SupervisorQueueSelection(card: card))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch card.kind {
            case "guard": guardBody
            case "hold": holdBody
            default: entriesBody
            }
            if let err = model.itemErrors[item.id] {
                PaneNoticeStrip(notice: PaneNotice(kind: .error, headline: "Refused", detail: err),
                                onDismiss: { model.itemErrors[item.id] = nil })
                    .padding(.horizontal, -10)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: MarvinTheme.Radius.card, style: .continuous)
                .fill(MarvinTheme.elevated)
                .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.card, style: .continuous)
                    .stroke(MarvinTheme.border, lineWidth: 1))
        )
        .disabled(!enabled || model.inFlight.contains(item.id))
        .accessibilityElement(children: .contain)
    }

    // The entries: a list you approve once.
    private var entriesBody: some View {
        let entries = card.entries ?? []
        return VStack(alignment: .leading, spacing: 6) {
            Text("Approve \(entries.count) brief\(entries.count == 1 ? "" : "s") as a list. The runtime opens each in a fresh worktree, in this order, as slots free — you are not asked again per tab.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(card.warnings ?? [], id: \.self) { w in
                PaneNoticeStrip(notice: PaneNotice(kind: .warning, headline: "No scope check", detail: w), onDismiss: nil)
                    .padding(.horizontal, -10)
            }
            ForEach(Array(entries.enumerated()), id: \.element.id) { i, e in
                entryRow(i + 1, e)
            }
            if !selection.orphans.isEmpty {
                Text("\(selection.orphans.joined(separator: ", ")) would wait for an entry you left out — tick that one too.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                Button(selection.buttonTitle) {
                    let a = selection.action
                    Task { await model.act(item, actionId: a.actionId, edits: a.edits) }
                }
                .rowChip(.primary)
                .disabled(!selection.canApprove)
                dismissChip
                if model.inFlight.contains(item.id) { ProgressView().controlSize(.mini) }
                Spacer(minLength: 0)
            }
        }
    }

    private func entryRow(_ n: Int, _ e: SupervisorQueueCard.Entry) -> some View {
        let on = selection.contains(e.id)
        let wider = Set(e.wider ?? [])
        return HStack(alignment: .top, spacing: 6) {
            Toggle(isOn: Binding(get: { on }, set: { _ in selection.toggle(e.id) })) { EmptyView() }
                .toggleStyle(.checkbox)
                .labelsHidden()
                .accessibilityLabel("Approve \(e.title)")
            VStack(alignment: .leading, spacing: 2) {
                Text("\(n). \(e.title)").font(.system(size: 11.5, weight: .medium)).foregroundStyle(MarvinTheme.textPrimary)
                Text(expanded.contains(e.id) ? e.brief : SupervisorQueuePresentation.head(e.brief))
                    .font(.system(size: 11))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(expanded.contains(e.id) ? nil : 3)
                    .fixedSize(horizontal: false, vertical: true)
                if e.brief.count > 160 || e.brief.contains("\n") {
                    Button(expanded.contains(e.id) ? "Show less" : "Show all") {
                        if expanded.contains(e.id) { expanded.remove(e.id) } else { expanded.insert(e.id) }
                    }.buttonStyle(.link).font(.system(size: 10.5))
                }
                HStack(spacing: 4) {
                    if !wider.isEmpty {
                        Image(systemName: "arrow.up.right").font(.system(size: 8, weight: .bold)).foregroundStyle(.orange)
                            .accessibilityLabel("wider than the base tab: \(wider.sorted().joined(separator: ", "))")
                    }
                    Text(SupervisorQueuePresentation.postureLine(e.posture))
                        .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                }
                if let after = e.after, !after.isEmpty {
                    Text("after \(after.joined(separator: ", ")) is merged").font(.system(size: 10.5)).foregroundStyle(.secondary)
                }
                if let s = e.scopeRef {
                    Text("scope: \(s.path) › \(s.heading)").font(.system(size: 10.5)).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
        }
        .opacity(on ? 1 : 0.55)
    }

    // The guard: the whole command, because that exact text is what you approve.
    private var guardBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(card.previous == nil ? "Run this command before each queued tab opens?" : "Replace the guard command?")
                .font(.system(size: 11.5, weight: .medium))
            Text("A non-zero exit holds the queue. It runs on your machine, in the project folder, with the project's environment variables and a 30 second limit. The supervisor cannot change it; this click can.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(card.command ?? "")
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).fill(MarvinTheme.background))
                .accessibilityLabel("Command: \(card.command ?? "")")
            if let prev = card.previous {
                Text("Replaces: \(prev)")
                    .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            HStack(spacing: 6) {
                if let a = item.actions.first(where: { $0.role == "consent" }) {
                    Button(a.label) { Task { await model.act(item, actionId: a.id) } }.rowChip(.primary)
                }
                dismissChip
                if model.inFlight.contains(item.id) { ProgressView().controlSize(.mini) }
                Spacer(minLength: 0)
            }
        }
    }

    // A held entry: nothing to approve, two lines to read.
    private var holdBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("“\(card.entryId ?? "")” did not open").font(.system(size: 11.5, weight: .medium))
            Text(card.detail ?? "")
                .font(.system(size: 11))
                .foregroundStyle(MarvinTheme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) { dismissChip; Spacer(minLength: 0) }
        }
    }

    @ViewBuilder private var dismissChip: some View {
        if let d = item.actions.first(where: { $0.role == "dismiss" }) {
            Button(d.label) { Task { await model.act(item, actionId: d.id) } }.rowChip(.neutral)
        }
    }
}

// MARK: - The workspace's Queue segment

@MainActor struct SupervisorQueueSection: View {
    let model: SupervisorModel
    @State private var guardSheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // ADR-0134 — the standing merge sits above the queue it shares a segment with.
            SupervisorMergeSection(model: model)
            MarvinDivider()
            if let q = model.queue {
                capRow(q)
                guardRow(q)
                if let err = model.queueError {
                    PaneNoticeStrip(notice: PaneNotice(kind: .error, headline: "Refused", detail: err),
                                    onDismiss: { model.queueError = nil })
                        .padding(.horizontal, -10)
                }
                PaneSectionHeader("Queue", count: q.entries.filter { $0.status == "queued" || $0.status == "opening" }.count)
                    .accessibilityAddTraits(.isHeader)
                let rows = SupervisorQueuePresentation.ordered(q.entries)
                if rows.isEmpty {
                    Text("Nothing queued. Ask the supervisor for a queue; you approve the list once on its card, and the runtime opens each brief as a slot frees.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(rows) { e in entryRow(e) }
            } else {
                Text("Reading the queue…").font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
        .task { await model.refreshQueue() }
        .sheet(isPresented: $guardSheet) {
            SupervisorGuardSheet(current: model.queue?.guardRef?.command, onClose: { guardSheet = false }) { command in
                await model.queueAct { SupervisorQueuePresentation.proposeGuardBody(projectId: $0, command: command) }
                guardSheet = false
            }
        }
    }

    private func capRow(_ q: SupervisorQueueView) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(SupervisorQueuePresentation.capLine(q)).font(.system(size: 11.5, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Stepper("Cap", value: Binding(get: { q.cap }, set: { n in
                    Task { await model.queueAct { SupervisorQueuePresentation.capBody(projectId: $0, cap: n) } }
                }), in: 0...SupervisorQueuePresentation.maxCap)
                    .labelsHidden()
                    .accessibilityLabel("Open-tab cap")
                    .accessibilityValue("\(q.cap)")
            }
            Text("Every open tab in the project counts, whoever opened it; the queue never closes one to make room. \(SupervisorQueuePresentation.summary(q)).")
                .font(.system(size: 10.5)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if q.capLowered != nil {
                Button("Restore my cap") { Task { await model.queueAct { SupervisorQueuePresentation.restoreCapBody(projectId: $0) } } }
                    .rowChip(.neutral)
                    .help("The supervisor lowered the cap during an alarm. This puts it back to your number.")
            }
        }
    }

    private func guardRow(_ q: SupervisorQueueView) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Guard command").font(.system(size: 11.5, weight: .medium))
                Spacer(minLength: 4)
                Button(q.guardRef == nil ? "Set…" : "Change…") { guardSheet = true }.rowChip(.neutral)
            }
            if let g = q.guardRef {
                Text(g.command)
                    .font(.system(size: 10.5, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(SupervisorQueuePresentation.guardLine(q)).font(.system(size: 10.5)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func entryRow(_ e: SupervisorQueueView.Entry) -> some View {
        let s = SupervisorQueuePresentation.rowState(e)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let p = e.position { Text("\(p).").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary) }
                Text(e.title).font(.system(size: 11.5, weight: .medium)).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                Text(s.label).font(.system(size: 10.5, weight: .medium)).foregroundStyle(color(s.tone))
            }
            if let r = s.reason {
                Text(r).font(.system(size: 10.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Text(e.briefHead).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(2)
            if !e.after.isEmpty {
                Text("after \(e.after.joined(separator: ", ")) is merged").font(.system(size: 10.5)).foregroundStyle(.secondary)
            }
            if e.status == "queued" || e.status == "failed" {
                HStack(spacing: 6) {
                    if e.hold != nil || e.status == "failed" {
                        Button(e.status == "failed" ? "Try again" : "Release") {
                            Task { await model.queueAct { SupervisorQueuePresentation.releaseBody(projectId: $0, id: e.id) } }
                        }.rowChip(.neutral)
                    }
                    Button("Remove") { Task { await model.queueAct { SupervisorQueuePresentation.removeBody(projectId: $0, id: e.id) } } }
                        .rowChip(.neutral)
                }
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private func color(_ t: SupervisorQueuePresentation.Tone) -> Color {
        switch t {
        case .needsYou: return .orange
        case .held: return .yellow
        case .active: return .accentColor
        case .done: return MarvinTheme.textMuted
        case .neutral: return MarvinTheme.textPrimary
        }
    }
}

/// Type the command; Review raises a card that shows it in full. Nothing is set from this sheet.
@MainActor struct SupervisorGuardSheet: View {
    let current: String?
    let onClose: () -> Void
    let onReview: (String) async -> Void
    @State private var text = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(current == nil ? "Set the guard command" : "Change the guard command").font(.headline)
            Text("Run before each queued tab opens; a non-zero exit holds the queue. This raises a card in Needs you that shows the command in full — the command is set when you approve that card, and a changed command waits for a new approval.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $text)
                .font(.system(size: 12, design: .monospaced))
                .frame(height: 80)
                .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).stroke(MarvinTheme.border, lineWidth: 1))
                .accessibilityLabel("Guard command")
            HStack {
                Spacer()
                Button("Cancel", action: onClose).keyboardShortcut(.cancelAction)
                Button("Review on a card") {
                    busy = true
                    Task { await onReview(text); busy = false }
                }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
            }
        }
        .padding(20)
        .frame(width: 480)
    }
}
