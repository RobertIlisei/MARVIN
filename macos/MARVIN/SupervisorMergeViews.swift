// SupervisorMergeViews — the standing merge authorisation (ADR-0134, plan [6.6]).
//
// Three surfaces, one rule: the click on the card is the consent.
//  - `SupervisorMergeCardView`: the card a `queue` item of kind `merge` draws —
//    the target and the gate command in FULL, the holds with their time zone,
//    the validity. Approving it is the only thing that creates the authorisation.
//  - `SupervisorMergeStrip`: one line shown at all times above the inspector —
//    on or off, when it expires, Revoke in one click.
//  - `SupervisorMergeSection`: in the Queue segment — the authorisation in
//    full, what the pass is doing, each branch with its prediction, gate exit
//    and commit, each hold and who placed it, and the user's own acts.

import MARVINLogic
import SwiftUI

// MARK: - The card

@MainActor struct SupervisorMergeCardView: View {
    let model: SupervisorModel
    let item: SupervisorInboxItem
    let proposal: SupervisorMergeProposal
    let replaces: SupervisorMergeReplaces?
    let enabled: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(replaces == nil ? "Start a standing merge?" : "Replace the standing merge?")
                .font(.system(size: 11.5, weight: .medium))
            ForEach(SupervisorMergePresentation.cardLines(proposal, replaces: replaces), id: \.self) { line in
                Text(line).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Text("Target: \(proposal.target)")
                .font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
            Text(proposal.gate)
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).fill(MarvinTheme.background))
                .accessibilityLabel("Gate command: \(proposal.gate)")
            HStack(spacing: 6) {
                if let a = item.actions.first(where: { $0.role == "consent" }) {
                    Button(a.label) { Task { await model.act(item, actionId: a.id) } }.rowChip(.primary)
                }
                if let d = item.actions.first(where: { $0.role == "dismiss" }) {
                    Button(d.label) { Task { await model.act(item, actionId: d.id) } }.rowChip(.neutral)
                }
                if model.inFlight.contains(item.id) { ProgressView().controlSize(.mini) }
                Spacer(minLength: 0)
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
}

// MARK: - The always-visible line

@MainActor struct SupervisorMergeStrip: View {
    let model: SupervisorModel

    var body: some View {
        HStack(spacing: 8) {
            Text(SupervisorMergePresentation.statusLine(model.merge))
                .font(.system(size: 10.5))
                .foregroundStyle(model.merge?.authorisation?.expired == false ? MarvinTheme.textPrimary : .secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if model.merge?.authorisation != nil {
                Button("Revoke") { Task { await model.mergeAct { SupervisorMergePresentation.revokeBody(projectId: $0) } } }
                    .rowChip(.neutral)
                    .help("Ends the standing merge now. A gate run in flight is stopped and nothing moves.")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - The workspace section

@MainActor struct SupervisorMergeSection: View {
    let model: SupervisorModel
    @State private var sheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            PaneSectionHeader("Standing merge", count: model.merge?.branches.filter { $0.status == "merged" }.count ?? 0)
                .accessibilityAddTraits(.isHeader)
            if let err = model.mergeError {
                PaneNoticeStrip(notice: PaneNotice(kind: .error, headline: "Refused", detail: err),
                                onDismiss: { model.mergeError = nil })
                    .padding(.horizontal, -10)
            }
            if let m = model.merge {
                authorisation(m)
                if let r = m.running {
                    Text(SupervisorMergePresentation.runningLine(r)).font(.system(size: 11, weight: .medium)).foregroundStyle(Color.accentColor)
                }
                if let w = SupervisorMergePresentation.waitingForCheckout(m) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(w.reason).font(.system(size: 10.5)).foregroundStyle(.yellow).fixedSize(horizontal: false, vertical: true)
                        Button("Check again") { Task { await model.mergeAct { SupervisorMergePresentation.retryBody(projectId: $0) } } }.rowChip(.neutral)
                    }
                }
                ForEach(m.holds, id: \.branch) { h in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(SupervisorMergePresentation.holdLine(h)).font(.system(size: 10.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        Button("Release") { Task { await model.mergeAct { SupervisorMergePresentation.releaseHoldBody(projectId: $0, branch: h.branch) } } }.rowChip(.neutral)
                    }
                }
                if !m.branches.isEmpty {
                    Text(SupervisorMergePresentation.summary(m)).font(.system(size: 10.5)).foregroundStyle(.secondary)
                    ForEach(m.branches) { b in branchRow(b) }
                }
            } else {
                Text("Reading the standing merge…").font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
        .task { await model.refreshMerge() }
        .sheet(isPresented: $sheet) {
            SupervisorMergeSheet(replacing: model.merge?.authorisation != nil, onClose: { sheet = false }) { body in
                await model.mergeAct(body, raisesCard: true)
                sheet = false
            }
        }
    }

    private func authorisation(_ m: SupervisorMergeView) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(SupervisorMergePresentation.statusLine(m)).font(.system(size: 11.5, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button(m.authorisation == nil ? "Set up…" : "Change…") { sheet = true }.rowChip(.neutral)
            }
            if let a = m.authorisation {
                Text(a.gate).font(.system(size: 10.5, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Text("Time limit \(a.timeoutSeconds / 60) min per gate run.").font(.system(size: 10.5)).foregroundStyle(.secondary)
                ForEach(a.holds, id: \.pathGlob) { h in
                    Text("Hold: \(SupervisorMergePresentation.ruleLine(h, timeZone: a.timeZone))").font(.system(size: 10.5)).foregroundStyle(.secondary)
                }
            }
            if model.mergeCardRaised {
                Text("A card in Needs you shows it in full — nothing starts until you approve that card.").font(.system(size: 10.5)).foregroundStyle(.secondary)
            }
        }
    }

    private func branchRow(_ b: SupervisorMergeView.Branch) -> some View {
        let s = SupervisorMergePresentation.rowState(b)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(b.branch).font(.system(size: 11, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                Text(s.label).font(.system(size: 10.5, weight: .medium)).foregroundStyle(color(s.tone))
            }
            Text(s.reason).font(.system(size: 10.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            let facts = SupervisorMergePresentation.factsLine(b)
            if !facts.isEmpty { Text(facts).font(.system(size: 10.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            if let r = b.report { Text(r).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).lineLimit(6).textSelection(.enabled) }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private func color(_ t: SupervisorMergePresentation.Tone) -> Color {
        switch t {
        case .needsYou: return .orange
        case .held: return .yellow
        case .active: return .accentColor
        case .done: return MarvinTheme.textMuted
        case .neutral: return MarvinTheme.textPrimary
        }
    }
}

/// Type the target and the gate; Review raises a card that shows them in full. Nothing is authorised from this sheet.
@MainActor struct SupervisorMergeSheet: View {
    let replacing: Bool
    let onClose: () -> Void
    let onReview: (@escaping (String) -> [String: Any]) async -> Void
    @State private var target = ""
    @State private var gate = ""
    @State private var holdsText = ""
    @State private var validDays = SupervisorMergePresentation.defaultValidDays
    @State private var timeoutMinutes = SupervisorMergePresentation.defaultTimeoutMinutes
    @State private var busy = false

    private var parsed: SupervisorMergePresentation.HoldParse { SupervisorMergePresentation.parseHolds(holdsText) }
    private var error: String? {
        parsed.error ?? SupervisorMergePresentation.formError(target: target, gate: gate, validDays: validDays, timeoutMinutes: timeoutMinutes)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(replacing ? "Replace the standing merge" : "Set up a standing merge").font(.headline)
            Text("Finished tab branches merge into one local branch, each only after your gate command exits 0, in a scratch copy — never pushed, tagged or sent as a merge request. This raises a card in Needs you that shows everything in full; it starts when you approve that card, and any change needs a new approval.")
                .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextField("Branch to merge into", text: $target).textFieldStyle(.roundedBorder).accessibilityLabel("Target branch")
            TextEditor(text: $gate)
                .font(.system(size: 12, design: .monospaced)).frame(height: 70)
                .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).stroke(MarvinTheme.border, lineWidth: 1))
                .accessibilityLabel("Gate command")
            HStack {
                Stepper("Valid for \(validDays) day\(validDays == 1 ? "" : "s")", value: $validDays, in: 1...SupervisorMergePresentation.maxValidDays)
                Stepper("Gate limit \(timeoutMinutes) min", value: $timeoutMinutes, in: SupervisorMergePresentation.minTimeoutMinutes...SupervisorMergePresentation.maxTimeoutMinutes, step: 15)
            }.font(.system(size: 11.5))
            Text("Holds, one per line: a path pattern, a bar, a window in this Mac's local time (\(TimeZone.current.identifier)), e.g. scripts/gate/** | 21:00-07:00")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $holdsText)
                .font(.system(size: 12, design: .monospaced)).frame(height: 48)
                .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).stroke(MarvinTheme.border, lineWidth: 1))
                .accessibilityLabel("Holds")
            if let e = error, !(target.isEmpty && gate.isEmpty) { Text(e).font(.system(size: 11)).foregroundStyle(.orange) }
            HStack {
                Spacer()
                Button("Cancel", action: onClose).keyboardShortcut(.cancelAction)
                Button("Review on a card") {
                    busy = true
                    let (t, g, d, m, h) = (target, gate, validDays, timeoutMinutes, parsed.holds)
                    Task { await onReview { SupervisorMergePresentation.proposeBody(projectId: $0, target: t, gate: g, validDays: d, timeoutMinutes: m, holds: h) }; busy = false }
                }
                .disabled(error != nil || busy)
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}
