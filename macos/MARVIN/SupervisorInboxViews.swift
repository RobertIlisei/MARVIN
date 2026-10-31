// SupervisorInboxViews — "Needs you is the inbox" (ADR-0127 milestone 6;
// design brief §6.2–§6.5).
//
// The act leads, the advice follows, the grounds are one disclosure away. An
// escalation's headline is the server's deterministic description of the act,
// never the supervisor's prose; the recommendation sits under it, smaller and
// muted. Consent chips carry the server's act verb ("Allow push", "Merge"),
// never "Accept"; an outward or destructive act shows its chip only once the
// card shows the full act; and no chip is a default button or answers Return
// (audit W2, C8). There is no batch path anywhere.

import AppKit
import MARVINLogic
import SwiftUI

// MARK: - Escalation card (§6.2)

/// Where a card is drawn: its sheets open from the surface that holds it (ADR-0128 §3 — one item, two views).
enum SupervisorCardSurface { case pane, chat }

/// A card's sheets, as one value the Supervisor tab presents.
enum SupervisorCardSheet: Identifiable {
    case answer(SupervisorInboxItem), newTabEdit(SupervisorInboxItem), sendEdit(SupervisorInboxItem), raiseCap(SupervisorInboxItem)
    var id: String {
        switch self {
        case .answer(let i): return "answer-\(i.id)"
        case .newTabEdit(let i): return "newtab-\(i.id)"
        case .sendEdit(let i): return "send-\(i.id)"
        case .raiseCap(let i): return "cap-\(i.id)"
        }
    }
}

@MainActor struct SupervisorEscalationCard: View {
    let model: SupervisorModel
    let item: SupervisorInboxItem
    let enabled: Bool
    var surface: SupervisorCardSurface = .pane
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var expanded: Bool { model.expandedCards.contains(item.id) }
    private var fullAct: Bool { model.fullActShown.contains(item.id) || expanded }
    private var groundsOpen: Bool { model.groundsShown.contains(item.id) }
    private var busy: Bool { model.inFlight.contains(item.id) }
    private var chips: SupervisorActChips { SupervisorActChips(actions: item.actions, expanded: expanded) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            whyLine
            rawAct
            if let note = SupervisorChat.sendNote(item) {
                Text(note)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            recommendation
            if !item.grounds.isEmpty { groundsDisclosure }
            chipRow
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
        .opacity(enabled ? 1 : 0.55)
        .disabled(!enabled || busy)
        .transition(reduceMotion ? .identity : .opacity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(accessibilityValue)
        .accessibilityActions {
            ForEach(chips.chips) { a in
                Button(a.label) { perform(a) }
            }
            if chips.showReviewAct { Button("Show full act") { reviewAct() } }
            if !item.grounds.isEmpty { Button("Show grounds") { model.groundsShown.insert(item.id) } }
            if let sid = item.sessionId { Button("Open tab") { MarvinBridge.shared.requestChatTab(.select(sid)) } }
            if item.question != nil { Button("Answer differently") { present(.answer(item)) } }
        }
    }

    // 1. Why it is here — the server's reason label.
    private var whyLine: some View {
        HStack(spacing: 4) {
            Image(systemName: SupervisorInboxItem.glyph(forKind: item.kind))
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundStyle(item.escalatedBecause.code == "human-only" ? MarvinTheme.textPrimary : .orange)
                .accessibilityHidden(true)
            Text(item.escalatedBecause.label)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(MarvinTheme.textPrimary)
                .lineLimit(2)
            if let h = item.heuristic {
                Text("heuristic: \(h.matched)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(MarvinTheme.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if !enabled {
                Text("reconnecting…")
                    .font(.system(size: 10.5))
                    .foregroundStyle(MarvinTheme.textMuted)
                    .lineLimit(1)
            }
        }
    }

    // 2. The raw act — it leads the card.
    @ViewBuilder
    private var rawAct: some View {
        if let qs = item.question?.questions, let q = qs.first {
            VStack(alignment: .leading, spacing: 4) {
                Text(q.question)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(fullAct ? nil : 3)
                    .fixedSize(horizontal: false, vertical: true)
                if qs.count > 1 {
                    Text("\(qs.count) questions").font(.system(size: 11)).foregroundStyle(.secondary)
                } else if let rec = recommendedOption(q) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(rec.label).font(.system(size: 11, weight: .medium)).foregroundStyle(MarvinTheme.textPrimary)
                        if let d = rec.description, !d.isEmpty {
                            Text(d).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).stroke(MarvinTheme.border, lineWidth: 1))
                    if q.options.count > 1 {
                        Text("+\(q.options.count - 1) other option\(q.options.count == 2 ? "" : "s")")
                            .font(.system(size: 10.5)).foregroundStyle(MarvinTheme.textMuted)
                    }
                }
            }
        } else if let act = item.rawAct {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(act.toolName)
                        .font(.system(size: 10.5, design: .monospaced))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(RoundedRectangle(cornerRadius: MarvinTheme.Radius.badge).fill(Color.orange.opacity(0.16)))
                        .fixedSize()
                    if act.outward || act.destructive {
                        Label(act.destructive ? "destroys work" : "leaves this Mac",
                              systemImage: act.destructive ? "trash" : "arrow.up.forward.app")
                            .font(.system(size: 10.5))
                            .foregroundStyle(.orange)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                Text(act.summary)
                    .font(.system(size: 11))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(fullAct ? nil : 3)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                if let p = item.preview { previewLine(p) }
                if let paths = act.paths, !paths.isEmpty {
                    Text(paths.joined(separator: "\n"))
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(fullAct ? nil : 2)
                        .truncationMode(.middle)
                }
                if fullAct {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(act.input?.prettyText ?? act.summary)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let d = act.digest {
                            Text("digest \(d)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(MarvinTheme.textMuted)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).fill(MarvinTheme.background))
                } else {
                    Button("Show full act") { model.fullActShown.insert(item.id) }
                        .buttonStyle(.link)
                        .font(.system(size: 10.5))
                }
            }
        } else if let pc = item.postureChange {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(pc.widenedDimensions, id: \.self) { dim in
                    Label("\(dim): \(value(pc.from?[dim])) → \(value(pc.to?[dim]))", systemImage: "arrow.up.right")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(MarvinTheme.textPrimary)
                }
            }
        }
    }

    private func previewLine(_ p: SupervisorInboxItem.Preview) -> some View {
        let text: String
        switch p.verdict {
        case "clean": text = "clean · +\(p.added) −\(p.removed)"
        case "behind": text = "behind by \(p.behind ?? 0) · +\(p.added) −\(p.removed)"
        case "conflict": text = "conflicts in " + p.conflictFiles.joined(separator: ", ")
        default: text = "preview unavailable"
        }
        return Label(text, systemImage: p.verdict == "conflict" ? "exclamationmark.triangle.fill" : "arrow.triangle.merge")
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(p.verdict == "conflict" ? Color.orange : .secondary)
            .lineLimit(2)
    }

    // 3. The recommendation — subordinate to the act.
    @ViewBuilder
    private var recommendation: some View {
        if let r = item.recommendation {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Image(systemName: SupervisorMark.symbol)
                        .font(.system(size: 9.5))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .accessibilityHidden(true)
                    (Text("Supervisor recommends ") + Text(verb(r.actionId)).fontWeight(.semibold))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !r.text.isEmpty {
                    Text(r.text)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(expanded ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 14)
                }
            }
        }
    }

    // 4. Grounds — one disclosure away.
    private var groundsDisclosure: some View {
        VStack(alignment: .leading, spacing: 3) {
            Button {
                if groundsOpen { model.groundsShown.remove(item.id) } else { model.groundsShown.insert(item.id) }
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: groundsOpen ? "chevron.down" : "chevron.right").font(.system(size: 8, weight: .semibold))
                    Text("Grounds · \(item.grounds.count) (\(item.strongGroundCount) strong)").font(.system(size: 10.5))
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Grounds, \(item.grounds.count), \(item.strongGroundCount) strong")
            if groundsOpen { SupervisorGroundsList(grounds: item.grounds).padding(.leading, 10) }
        }
    }

    // 5. Act chips, on their own line, at every width.
    private var chipRow: some View {
        HStack(spacing: 6) {
            ForEach(chips.chips) { a in
                Button(a.label) { perform(a) }
                    .rowChip(a.id == chips.primaryId ? .primary : .neutral)
                    .help(help(a))
            }
            if chips.showReviewAct {
                Button("Review act…") { reviewAct() }
                    .rowChip(.neutral)
                    .help("Shows the whole act first. Its consent chip appears once you have seen it.")
            }
            if busy { ProgressView().controlSize(.mini) }
            moreMenu
            Spacer(minLength: 0)
        }
    }

    private var moreMenu: some View {
        Menu {
            if let sid = item.sessionId {
                Button("Open tab") { MarvinBridge.shared.requestChatTab(.select(sid)) }
            }
            if item.question != nil {
                Button("Answer differently…") { present(.answer(item)) }
            }
            if let act = item.rawAct {
                Button("Copy act") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(act.input?.prettyText ?? act.summary, forType: .string)
                }
            }
            ForEach(chips.menu) { a in
                Button(a.label) { perform(a) }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("More")
        .accessibilityLabel("More for this escalation")
    }

    private func reviewAct() {
        model.expandedCards.insert(item.id)
        model.fullActShown.insert(item.id)
    }

    private func perform(_ a: SupervisorInboxItem.Action) {
        switch a.id {
        case "answer-edit": present(.answer(item))
        case "edit": present(SupervisorChat.sendText(item) != nil ? .sendEdit(item) : .newTabEdit(item))
        case "raise-cap": present(.raiseCap(item))
        default: Task { await model.act(item, actionId: a.id) }
        }
    }

    private func present(_ sheet: SupervisorCardSheet) {
        if surface == .chat { model.chatSheet = sheet; return }
        switch sheet {
        case .answer(let i): model.answerSheetItem = i
        case .newTabEdit(let i): model.newTabEditItem = i
        case .sendEdit(let i): model.sendEditItem = i
        case .raiseCap(let i): model.raiseCapItem = i
        }
    }

    private func verb(_ actionId: String) -> String {
        item.actions.first { $0.id == actionId }?.label ?? actionId.capitalized
    }

    private func help(_ a: SupervisorInboxItem.Action) -> String {
        switch a.role {
        case "consent": return "\(a.label) — performed as you, on this act."
        case "refuse": return "\(a.label) — the tab is told no and carries on."
        case "edit": return "Change it before it runs."
        default: return a.label
        }
    }

    private func recommendedOption(_ q: SupervisorInboxItem.Question) -> SupervisorInboxItem.Question.Option? {
        let a = item.actions.first { $0.recommended && $0.id == "answer" }
        let label = a?.label.replacingOccurrences(of: "Answer: ", with: "")
        return q.options.first { $0.label == label } ?? q.options.first
    }

    private func value(_ v: SupervisorJSON?) -> String {
        switch v {
        case .string(let s): return s
        case .some(let x): return x.prettyText
        case nil: return "?"
        }
    }

    private var accessibilityLabel: String {
        let tab = item.tabTitle.map { "\($0) tab" } ?? "supervisor"
        let act = item.question?.questions.first?.question ?? item.rawAct?.summary ?? item.newTab?.firstMessage ?? ""
        return "Escalation, \(tab): \(item.escalatedBecause.label). \(act)"
    }

    private var accessibilityValue: String {
        var parts: [String] = []
        if let r = item.recommendation { parts.append("Supervisor recommends: \(verb(r.actionId)).") }
        if !item.grounds.isEmpty {
            parts.append("\(item.grounds.count) ground\(item.grounds.count == 1 ? "" : "s"), \(item.strongGroundCount) strong.")
        }
        return parts.joined(separator: " ")
    }
}

// MARK: - Supervisor rows in Needs you (§6.3)

@MainActor struct SupervisorInboxRow: View {
    let model: SupervisorModel
    let item: SupervisorInboxItem
    let enabled: Bool
    var focused = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: SupervisorMark.symbol)
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(MarvinTheme.textMuted)
                    .frame(width: 10)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Supervisor").font(.system(size: 11)).foregroundStyle(MarvinTheme.textPrimary).lineLimit(1)
                    Text(subtitle)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
            }
            Group {
                if item.kind == "new-tab", let nt = item.newTab {
                    SupervisorNewTabCard(model: model, item: item, newTab: nt, enabled: enabled)
                } else if item.kind == "guardrail" {
                    guardrailStrip
                } else {
                    SupervisorEscalationCard(model: model, item: item, enabled: enabled)
                }
            }
            .padding(.leading, 16)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .stroke(focused ? Color.accentColor.opacity(0.6) : Color.clear, lineWidth: 1)
        )
    }

    private var subtitle: String {
        switch item.kind {
        case "new-tab": return "Open a new tab"
        case "guardrail": return item.escalatedBecause.label
        default: return item.escalatedBecause.label
        }
    }

    private var guardrailStrip: some View {
        let verb = item.guardrail?.verb
        let title: String
        switch verb {
        case "raise-cap": title = "Raise cap…"
        case "resume": title = "Resume"
        case "open-tab": title = "Open tab"
        default: title = item.actions.first?.label ?? "Open log"
        }
        // The verb sits on its own line (§5): beside the notice it took the
        // width the text needed and wrapped the detail one word per line at 260.
        return VStack(alignment: .leading, spacing: 4) {
            PaneNoticeStrip(
                notice: PaneNotice(kind: item.escalatedBecause.code == "budget" ? .warning : .error,
                                   headline: item.escalatedBecause.label, detail: item.guardrail?.detail),
                onDismiss: {
                    if let d = item.actions.first(where: { $0.role == "dismiss" }) { Task { await model.act(item, actionId: d.id) } }
                }
            )
            .padding(.horizontal, -10)
            Button(title) {
                if verb == "raise-cap" { model.raiseCapItem = item; return }
                if let a = item.actions.first(where: { $0.role == "consent" }) ?? item.actions.first {
                    Task { await model.act(item, actionId: a.id) }
                } else {
                    model.logExpanded = true
                }
            }
            .rowChip(.primary)
        }
        .disabled(!enabled)
    }
}

/// The new-tab proposal (ADR-0127 §4 item 7): the brief, the tree and the
/// posture are the act being consented to, so they lead.
@MainActor struct SupervisorNewTabCard: View {
    let model: SupervisorModel
    let item: SupervisorInboxItem
    let newTab: SupervisorInboxItem.NewTab
    let enabled: Bool
    @State private var showAll = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .top, spacing: 6) {
                DashedRule()
                    .frame(width: 1)
                    .accessibilityHidden(true)
                Text(newTab.firstMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(showAll ? nil : 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !showAll, newTab.firstMessage.count > 160 {
                Button("Show all") { showAll = true }.buttonStyle(.link).font(.system(size: 10.5))
            }
            Text(treeLine)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            postureLine
            if let r = newTab.requestedBy {
                Text("Asked for by: " + (r.kind == "user-message" ? "your message" : r.kind) + (r.at.flatMap(clock).map { ", \($0)" } ?? ""))
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
            }
            let chips = SupervisorActChips(actions: item.actions, expanded: true)
            HStack(spacing: 6) {
                ForEach(chips.chips) { a in
                    Button(a.label) {
                        if a.id == "edit" { model.newTabEditItem = item } else { Task { await model.act(item, actionId: a.id) } }
                    }
                    .rowChip(a.id == chips.primaryId ? .primary : .neutral)
                }
                if model.inFlight.contains(item.id) { ProgressView().controlSize(.mini) }
                Menu {
                    ForEach(chips.menu) { a in Button(a.label) { Task { await model.act(item, actionId: a.id) } } }
                } label: { Image(systemName: "ellipsis") }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .accessibilityLabel("More for this proposal")
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
        .accessibilityLabel("Proposal from the supervisor: open a new tab. First message: \(newTab.firstMessage)")
    }

    private var treeLine: String {
        let base = newTab.tree?.baseRef ?? "the current branch"
        let sha = newTab.tree?.baseSha.map { " @ \($0.prefix(7))" } ?? ""
        return "Tree: fresh worktree from \(base)\(sha)"
    }

    private var postureLine: some View {
        let p = newTab.posture
        let wider = Set(newTab.wider ?? [])
        let segments: [(String, String)] = [
            ("permissionStrategy", p?.strategy ?? "?"), ("mode", (p?.mode ?? "?").capitalized),
            ("model", p?.modelLabel ?? p?.model ?? "default"), ("thinkingMode", p?.effort ?? "?"),
        ]
        return WrapLayout(spacing: 3, lineSpacing: 2) {
            Text("Posture:").font(.system(size: 10.5)).foregroundStyle(.secondary)
            ForEach(Array(segments.enumerated()), id: \.element.0) { i, seg in
                HStack(spacing: 2) {
                    if i > 0 { Text("·").font(.system(size: 10.5)).foregroundStyle(MarvinTheme.textMuted) }
                    if wider.contains(seg.0) {
                        Image(systemName: "arrow.up.right").font(.system(size: 8, weight: .bold)).foregroundStyle(.orange)
                    }
                    Text(seg.1).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(MarvinTheme.textPrimary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(wider.contains(seg.0) ? "\(seg.1), wider than the requesting tab" : seg.1)
            }
        }
    }

    private func clock(_ iso: String) -> String? {
        guard let d = SessionLedger.parseISO(iso) else { return nil }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }
}

/// A 1 pt dashed leading rule — the quoted-brief marker.
@MainActor struct DashedRule: View {
    var body: some View {
        Rectangle()
            .fill(Color.clear)
            .overlay(
                Path { p in p.move(to: .zero); p.addLine(to: CGPoint(x: 0, y: 400)) }
                    .stroke(MarvinTheme.textMuted.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
            )
            .clipped()
    }
}

// MARK: - Shadow "would answer" (§6.4)

@MainActor struct SupervisorProposalLine: View {
    let model: SupervisorModel
    let proposal: SupervisorProposalWire
    let revealedOnServer: Bool

    private var revealed: Bool { revealedOnServer || model.revealed.contains(proposal.ledgerId) }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Image(systemName: SupervisorMark.symbol)
                    .font(.system(size: 9.5))
                    .foregroundStyle(MarvinTheme.textMuted)
                    .accessibilityHidden(true)
                if revealed, let a = proposal.answer {
                    Text("Supervisor would answer ") .font(.system(size: 10.5)).foregroundStyle(.secondary)
                        + Text(a.joined(separator: ", ")).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(.secondary)
                } else if revealed {
                    Text("Supervisor would \(proposal.actionId)").font(.system(size: 10.5)).foregroundStyle(.secondary)
                } else {
                    Text("Supervisor proposed an answer").font(.system(size: 10.5)).foregroundStyle(.secondary)
                    Text("·").foregroundStyle(MarvinTheme.textMuted)
                    Button("Reveal") { Task { await model.reveal(ledgerId: proposal.ledgerId) } }
                        .buttonStyle(.link)
                        .font(.system(size: 10.5))
                        .help("Blind until you look: revealing is recorded, so agreement can be read with and without it.")
                }
                Spacer(minLength: 0)
            }
            if revealed, !proposal.grounds.isEmpty {
                SupervisorGroundsList(grounds: proposal.grounds).padding(.leading, 14)
            }
        }
        .padding(.leading, 16)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Delegation chip (§6.5)

@MainActor struct SupervisorDelegationChip: View {
    let model: SupervisorModel
    let sessionId: String
    let tabTitle: String
    let level: SupervisorDelegation
    let sharedCheckout: Bool
    let lastActAt: String?

    var body: some View {
        Menu {
            ForEach(SupervisorDelegation.allCases, id: \.self) { l in
                Button {
                    Task { await model.delegate(sessionId, l) }
                } label: {
                    if l == level { Label(l.title, systemImage: "checkmark") } else { Text(l.title) }
                    Text(l.consequence + (sharedCheckout && l != .off ? ". Sends wait while another session works in this checkout" : ""))
                }
            }
        } label: {
            Image(systemName: level.glyph)
                .font(.system(size: 10, weight: level == .answerConfirms ? .semibold : .regular))
                .foregroundStyle(level == .answerConfirms ? MarvinTheme.textPrimary : MarvinTheme.textMuted)
                .frame(width: 18, height: 16)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .padding(3)
        .help("Supervisor delegation: \(level.spoken)" + (lastActAt.map { " · last act \($0.prefix(16).replacingOccurrences(of: "T", with: " "))" } ?? ""))
        .accessibilityLabel("Delegation for \(tabTitle)")
        .accessibilityValue(level.spoken)
    }
}

// MARK: - Sheets the inbox opens

/// "Edit…" on a new-tab proposal: the first message can change, and the
/// posture can only narrow — never widen past what the card shows (§6.3).
@MainActor struct SupervisorNewTabEditSheet: View {
    let model: SupervisorModel
    let item: SupervisorInboxItem
    let onClose: () -> Void
    @State private var message = ""
    @State private var mode = "agent"
    @State private var strategy = "gated"

    private static let modes = ["agent", "plan", "ask"]          // widest first
    private static let strategies = ["full", "auto", "gated"]    // widest first

    var body: some View {
        let proposed = item.newTab?.posture
        let modeChoices = Array(Self.modes.drop { $0 != (proposed?.mode ?? "agent") })
        let strategyChoices = Array(Self.strategies.drop { $0 != (proposed?.strategy ?? "gated") })
        VStack(alignment: .leading, spacing: 12) {
            Text("Edit the new tab").font(.headline)
            Text("You can change the first message and narrow the posture. Opening the tab stays your click.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $message)
                .font(.system(size: 12))
                .frame(height: 140)
                .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).stroke(MarvinTheme.border, lineWidth: 1))
                .accessibilityLabel("First message")
            HStack(spacing: 12) {
                Picker("Mode", selection: $mode) { ForEach(modeChoices, id: \.self) { Text($0.capitalized).tag($0) } }
                    .frame(width: 150)
                Picker("Strategy", selection: $strategy) { ForEach(strategyChoices, id: \.self) { Text($0).tag($0) } }
                    .frame(width: 170)
            }
            HStack {
                Spacer()
                Button("Cancel", action: onClose).keyboardShortcut(.cancelAction)
                Button("Save") {
                    let id = item.actions.first { $0.id == "edit" }?.id ?? "edit"
                    Task {
                        await model.act(item, actionId: id, edits: ["firstMessage": message,
                                                                    "posture": ["mode": mode, "permissionStrategy": strategy]])
                        onClose()
                    }
                }
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear {
            message = item.newTab?.firstMessage ?? ""
            mode = proposed?.mode ?? "agent"
            strategy = proposed?.strategy ?? "gated"
        }
    }
}

/// [7.2] — a send card's "Edit…": the text only, never the tab or the kind (ADR-0128 §4).
/// The words stay the supervisor's, marked edited; the server checks them again when sent.
@MainActor struct SupervisorSendEditSheet: View {
    let model: SupervisorModel
    let item: SupervisorInboxItem
    let onClose: () -> Void
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Edit the message").font(.headline)
            Text("It goes to \(item.tabTitle ?? "the tab") as the supervisor's message, marked as edited by you. Sending stays your click.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $text)
                .font(.system(size: 12))
                .frame(height: 140)
                .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).stroke(MarvinTheme.border, lineWidth: 1))
                .accessibilityLabel("Message to the tab")
            HStack {
                Spacer()
                Button("Cancel", action: onClose).keyboardShortcut(.cancelAction)
                // No default action: Return never consents (brief §9.1).
                Button("Send to the tab") {
                    Task {
                        await model.act(item, actionId: "edit", edits: ["text": text])
                        onClose()
                    }
                }
                .disabled(SupervisorChat.sendable(text) == nil)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { text = SupervisorChat.sendText(item) ?? "" }
    }
}

/// "Raise cap…" — the user's own act, applied at once and ledgered.
@MainActor struct SupervisorRaiseCapSheet: View {
    let model: SupervisorModel
    let item: SupervisorInboxItem?
    let onClose: () -> Void
    @State private var cap: Double = 20

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Raise the daily cap").font(.headline)
            Text("Today's spend is \(String(format: "$%.2f", model.status?.budget.spentUsd ?? 0)). The supervisor resumes once the cap is above it.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                TextField("Daily cap", value: $cap, format: .currency(code: "USD"))
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 100)
                    .accessibilityLabel("New daily cap in dollars")
                Stepper("Daily cap", value: $cap, in: 1...1000, step: 5).labelsHidden()
            }
            HStack {
                Spacer()
                Button("Cancel", action: onClose).keyboardShortcut(.cancelAction)
                Button("Raise cap") {
                    Task {
                        if let item, item.actions.contains(where: { $0.id == "raise-cap" }) {
                            await model.act(item, actionId: "raise-cap", edits: ["capUsd": cap])
                        } else {
                            await model.setCap(cap)
                        }
                        onClose()
                    }
                }
            }
        }
        .padding(20)
        .frame(width: 380)
        .onAppear { cap = max(20, ((model.status?.budget.capUsd ?? 10) * 2).rounded()) }
    }
}

extension SupervisorInboxItem {
    /// The inbox question as the confirm the existing AskQuestionSheet reads,
    /// so "Answer…" uses the one question form the app has (§6.2).
    var asQuestionConfirm: ConfirmRequest? {
        guard let qs = question?.questions, !qs.isEmpty else { return nil }
        let questionsJSON: [[String: Any]] = qs.map { q in
            var d: [String: Any] = ["question": q.question, "header": q.header ?? "Choose", "multiSelect": q.multiSelect ?? false]
            d["options"] = q.options.map { ["label": $0.label, "description": $0.description ?? ""] }
            return d
        }
        guard let data = try? JSONSerialization.data(withJSONObject: ["questions": questionsJSON]),
              let input = try? JSONDecoder().decode(ChatJSON.self, from: data) else { return nil }
        return ConfirmRequest(turnId: linkedConfirm?.turnId ?? "", toolUseId: linkedConfirm?.toolUseId ?? id,
                              toolName: "AskUserQuestion", input: input, reason: nil, title: nil,
                              description: nil, displayName: nil)
    }
}
