// SupervisorViews — the supervisor's settings, log and set-up (ADR-0127
// milestone 6; design brief §5–§9), hosted since brief §13 by the Supervisor
// workspace, plus the Sessions pane's off line.
//
// Built from the ADR-0114 vocabulary and nothing else: `PaneSectionHeader`,
// row chips, `paneIconButton`, `PaneEnableToggle`, `PaneNoticeStrip`. No new
// colour, radius, shadow or material (brief §3). The supervisor's one mark is
// the `binoculars` glyph and the word "supervisor"; no hue is reserved for it.
//
// ADR-0114 / ADR-0062 constraints hold throughout: no `GeometryReader`, no
// `.textSelection`, no height animation, no intrinsic `minWidth`, and one
// layout for 260 and 420 pt. Every decision drawn here comes from
// `SupervisorStrip`, `SupervisorActChips` and friends in MARVINLogic.

import AppKit
import MARVINLogic
import SwiftUI

/// The one mark (brief §3).
enum SupervisorMark {
    static let symbol = "binoculars"
}

// MARK: - Off line (§6.7)

@MainActor struct SupervisorOffLine: View {
    let model: SupervisorModel

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: SupervisorMark.symbol)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(MarvinTheme.textMuted)
                .frame(width: 12)
                .accessibilityHidden(true)
            Text("Supervisor · off")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
            Button("Set up…") { model.openWorkspace() }
                .rowChip(.neutral)
                .help("Start a supervisor that watches the tabs you delegate. It starts in shadow, where it only proposes.")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 3)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Supervisor, off")
    }
}

// MARK: - Set-up form (§6.7; inline in the workspace since §13.9)

@MainActor struct SupervisorSetUpForm: View {
    let model: SupervisorModel
    /// Open tabs as (id, title).
    let tabs: [(id: String, title: String)]
    let modelLabel: String?

    @State private var charter = ""
    @State private var capUsd: Double = 20  // the server's DEFAULT_CAPS, measured in plan [7.1]
    @State private var levels: [String: SupervisorDelegation] = [:]
    @State private var included: Set<String> = []
    @State private var starting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: SupervisorMark.symbol).foregroundStyle(MarvinTheme.textMuted)
                Text("Set up the supervisor").font(.headline)
            }
            Text("It watches the tabs you delegate and answers what their plans already decide. It starts in shadow, where it only proposes — every answer stays yours until you switch a category on.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 4) {
                Text("Charter").font(.system(size: 11, weight: .semibold))
                TextEditor(text: $charter)
                    .font(.system(size: 12))
                    .frame(height: 72)
                    .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).stroke(MarvinTheme.border, lineWidth: 1))
                    .accessibilityLabel("Charter")
                Text("What should it know about your goals?")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                Text("Daily cap").font(.system(size: 11, weight: .semibold))
                TextField("Daily cap", value: $capUsd, format: .currency(code: "USD"))
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 90)
                    .accessibilityLabel("Daily cap in dollars")
                Stepper("Daily cap", value: $capUsd, in: 1...1000, step: 5).labelsHidden()
                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Tabs to delegate").font(.system(size: 11, weight: .semibold))
                if tabs.isEmpty {
                    Text("No open tabs. You can delegate tabs later from the workspace's Tabs list.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                ForEach(tabs, id: \.id) { tab in
                    HStack(spacing: 8) {
                        Toggle(tab.title, isOn: Binding(
                            get: { included.contains(tab.id) },
                            set: { on in if on { included.insert(tab.id) } else { included.remove(tab.id) } }))
                            .toggleStyle(.checkbox)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Picker("Delegation for \(tab.title)", selection: Binding(
                            get: { levels[tab.id] ?? .answerQuestions },
                            set: { levels[tab.id] = $0 })) {
                            ForEach([SupervisorDelegation.observe, .answerQuestions, .answerConfirms], id: \.self) {
                                Text($0.title).tag($0)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 160)
                        .disabled(!included.contains(tab.id))
                    }
                }
            }

            HStack(spacing: 6) {
                Text("Model").font(.system(size: 11, weight: .semibold))
                Text(modelLabel ?? "Supervisor role default (Sonnet)")
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
            }

            HStack(spacing: 10) {
                // No default button and no Return binding (§13.9): nothing here
                // can switch on autonomy, and starting is never a keystroke away.
                // The workspace's × closes it; there is no Cancel.
                Button("Start in shadow") {
                    starting = true
                    let picks = tabs.filter { included.contains($0.id) }.map { ($0.id, levels[$0.id] ?? .answerQuestions) }
                    Task {
                        await model.startInShadow(charter: charter, capUsd: capUsd, delegations: picks)
                        starting = false
                    }
                }
                .disabled(starting)
                if starting { ProgressView().controlSize(.small) }
                Spacer(minLength: 0)
            }
        }
        .onAppear { included = Set(tabs.map(\.id)) }
    }
}

// MARK: - Budget meter (§6.1; the workspace header and the pane line, §13)

/// A 4 pt bar, radius 3 (badge). Muted below 80 %, orange from 80 %, red at the
/// cap — where a glyph also appears, so colour is never the only signal.
@MainActor struct BudgetMeter: View {
    let meter: SupervisorStrip.Meter
    static let width: CGFloat = 56

    var body: some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: MarvinTheme.Radius.badge).fill(MarvinTheme.border)
            RoundedRectangle(cornerRadius: MarvinTheme.Radius.badge)
                .fill(fill)
                .frame(width: max(2, Self.width * meter.fraction))
        }
        .frame(width: Self.width, height: 4)
    }

    private var fill: Color {
        switch meter.level {
        case "reached": return GitDecorationColor.deleted
        case "near": return .orange
        default: return MarvinTheme.textMuted
        }
    }
}

// MARK: - Settings block (§6.1, expanded)

@MainActor struct SupervisorSettingsBlock: View {
    let model: SupervisorModel
    @Binding var charterOpen: Bool
    @Binding var confirmDisable: Bool
    /// The strip drew a rule above the block; the inspector has its own.
    var leadingDivider = true
    @State private var capDraft: Double? = nil

    var body: some View {
        let s = model.status
        VStack(alignment: .leading, spacing: 8) {
            if leadingDivider { MarvinDivider() }
            Text("Autonomy").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(MarvinTheme.textMuted)
            ForEach(SupervisorStatus.categories, id: \.self) { cat in
                autonomyRow(cat, s)
            }
            MarvinDivider()
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text("Charter").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(MarvinTheme.textMuted)
                    Spacer(minLength: 0)
                    Button("Edit…") { charterOpen = true }.rowChip(.neutral)
                }
                Text((s?.charter?.text).flatMap { $0.isEmpty ? nil : $0 } ?? "No charter yet.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .truncationMode(.tail)
            }
            HStack(spacing: 6) {
                Text("Daily cap").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(MarvinTheme.textMuted)
                Spacer(minLength: 0)
                TextField("Daily cap", value: Binding(get: { capDraft ?? s?.budget.capUsd ?? 10 }, set: { capDraft = $0 }),
                          format: .number.precision(.fractionLength(0...2)))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11, design: .monospaced))
                    .frame(width: 56)
                    .onSubmit { if let v = capDraft { Task { await model.setCap(v); capDraft = nil } } }
                    .accessibilityLabel("Daily cap in dollars")
                Stepper("Daily cap", onIncrement: { Task { await model.setCap((s?.budget.capUsd ?? 10) + 5) } },
                        onDecrement: { Task { await model.setCap(max(1, (s?.budget.capUsd ?? 10) - 5)) } })
                    .labelsHidden()
                    .accessibilityLabel("Daily cap")
            }
            modelPicker(s)
            HStack(spacing: 6) {
                Text("Personality").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(MarvinTheme.textMuted)
                Spacer(minLength: 0)
                Picker("Personality", selection: Binding(
                    get: { s?.personality ?? "ultron" },
                    set: { v in Task { await model.setPersonality(v) } })) {
                    ForEach(SupervisorStatus.personalities, id: \.id) { Text($0.title).tag($0.id) }
                }
                .labelsHidden()
                .controlSize(.small)
                .fixedSize()
                .accessibilityLabel("Supervisor personality")
                .help("The voice it speaks to you in. Takes effect from its next wake; its rules stay the same.")
            }
            HStack {
                Button("Disable supervisor…") { confirmDisable = true }.rowChip(.neutral)
                Spacer(minLength: 0)
            }
        }
        .padding(.top, 2)
    }

    // MARK: Model (the user's own pick; no verb of the supervisor's reaches it)

    private func modelPicker(_ s: SupervisorStatus?) -> some View {
        let open = model.modelPickerOpen
        let current = s?.model?.label ?? s?.model?.resolved ?? "default"
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Model").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(MarvinTheme.textMuted)
                Spacer(minLength: 0)
                Button {
                    if open { model.modelPickerOpen = false } else { model.openModelPicker() }
                } label: {
                    HStack(spacing: 4) {
                        Text(current).font(.system(size: 11, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                        Image(systemName: open ? "chevron.up" : "chevron.down").font(.system(size: 8, weight: .semibold))
                            .accessibilityHidden(true)
                    }
                }
                .rowChip(.neutral)
                .help(SupervisorModelPicker.help)
                .accessibilityLabel(SupervisorModelPicker.accessibilityLabel)
                .accessibilityValue(current)
                .accessibilityHint(open ? "Closes the list" : "Opens the list of models")
            }
            if open {
                SupervisorModelList(model: model, status: s)
                Text(SupervisorModelPicker.help)
                    .font(.system(size: 10.5))
                    .foregroundStyle(MarvinTheme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func autonomyRow(_ cat: String, _ s: SupervisorStatus?) -> some View {
        let on = s?.autonomy[cat] == "autonomous"
        let line = SupervisorStatsLine(stats: s?.stats?[cat], bar: s?.suggestedBar)
        let confirmsLocked = cat == "confirms" && s?.confirmsEligible != true
        let name = cat.prefix(1).uppercased() + cat.dropFirst()
        return HStack(alignment: .top, spacing: 8) {
            PaneEnableToggle(isOn: on, name: "\(name) autonomy",
                             help: confirmsLocked ? "Set a tab to answer confirms first" : (on ? "Back to shadow" : "Let it act on \(cat)")) { want in
                Task { await model.setAutonomy(cat, autonomous: want) }
            }
            .disabled(confirmsLocked)
            .accessibilityValue("\(on ? "autonomous" : "shadow"). \(line.text)")
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.system(size: 11)).foregroundStyle(MarvinTheme.textPrimary)
                Text(confirmsLocked ? "needs a tab at answer confirms" : line.text + (line.belowBar ? " · below suggested bar" : ""))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let w = line.warning {
                    Label(w, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

/// The open model list: Default, then the active provider's live models by
/// tier. Arrow keys move a cursor, Return picks, Escape closes; each row is
/// also a button for the pointer and for VoiceOver.
@MainActor struct SupervisorModelList: View {
    let model: SupervisorModel
    let status: SupervisorStatus?
    @FocusState private var focused: Bool

    private var rows: [SupervisorModelPicker.Entry] {
        var all = model.modelChoices
        if let stale = SupervisorModelPicker.staleEntry(choice: SupervisorModelPicker.selection(status?.model), in: all) { all.append(stale) }
        return all
    }

    var body: some View {
        let choice = SupervisorModelPicker.selection(status?.model)
        let all = rows
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SupervisorModelOption(title: SupervisorModelPicker.defaultTitle(status?.model), selected: choice == nil,
                                      cursor: model.modelCursor == "") { Task { await model.setModel(nil) } }
                if all.isEmpty {
                    Text(model.modelListFailed ? "The model list didn't load." : "Loading the model list…")
                        .font(.system(size: 11))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                }
                ForEach(SupervisorModelPicker.groups(all)) { group in
                    Text(group.title)
                        .font(.system(size: 9.5, weight: .semibold))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .padding(.horizontal, 10)
                        .padding(.top, 6)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(group.entries) { entry in
                        SupervisorModelOption(title: entry.displayName, selected: choice == entry.id,
                                              cursor: model.modelCursor == entry.id) { Task { await model.setModel(entry.id) } }
                    }
                }
            }
            .padding(.vertical, 3)
        }
        .frame(maxHeight: 220)
        .background(RoundedRectangle(cornerRadius: MarvinTheme.Radius.card, style: .continuous).fill(MarvinTheme.panel))
        .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.card, style: .continuous).stroke(MarvinTheme.border, lineWidth: 1))
        .focusable()
        .focused($focused)
        .onAppear { focused = true }
        .onKeyPress(.upArrow) { model.modelCursor = SupervisorModelPicker.step(from: model.modelCursor, by: -1, in: SupervisorModelPicker.keys(all)); return .handled }
        .onKeyPress(.downArrow) { model.modelCursor = SupervisorModelPicker.step(from: model.modelCursor, by: 1, in: SupervisorModelPicker.keys(all)); return .handled }
        .onKeyPress(.return) { let id = SupervisorModelPicker.modelID(forKey: model.modelCursor); Task { await model.setModel(id) }; return .handled }
        .onKeyPress(.escape) { model.modelPickerOpen = false; return .handled }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Supervisor models")
    }
}

@MainActor private struct SupervisorModelOption: View {
    let title: String
    let selected: Bool
    let cursor: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .semibold))
                    .frame(width: 10)
                    .opacity(selected ? 1 : 0)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .paneRow(selected: cursor, hovering: hovering)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityHint("Sets the supervisor's model from the next wake")
    }
}

@MainActor struct SupervisorCharterSheet: View {
    let model: SupervisorModel
    let onClose: () -> Void
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Charter").font(.headline)
            Text("What the supervisor should know about your goals. It cites the charter as a ground; it never grants an act.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $text)
                .font(.system(size: 12))
                .frame(height: 160)
                .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).stroke(MarvinTheme.border, lineWidth: 1))
                .accessibilityLabel("Charter")
            HStack {
                Spacer()
                Button("Cancel", action: onClose).keyboardShortcut(.cancelAction)
                Button("Save") { Task { await model.setCharter(text); onClose() } }
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { text = model.status?.charter?.text ?? "" }
    }
}

// MARK: - Supervisor log (§6.6)

@MainActor struct SupervisorLogSection: View {
    let model: SupervisorModel
    let tabTitle: (String) -> String
    @State private var expandedRows: Set<Int> = []

    private static let filters: [(String, String?)] = [("All", nil), ("Acts", "act"), ("Escalations", "escalate"),
                                                       ("Refusals", "refuse"), ("Proposals", "propose")]

    var body: some View {
        // The workspace inspector's Log segment (brief §13.6): always open;
        // the segment picker is its header.
        VStack(alignment: .leading, spacing: 4) {
            filterRow
            if model.ledger.isEmpty {
                Text("Nothing logged yet. Every proposal, act, refusal and escalation lands here.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(model.ledger) { e in row(e) }
            if model.ledgerHasMore {
                Button("Show 50 earlier") { Task { await model.refreshLedger(earlier: true) } }
                    .rowChip(.neutral)
            }
        }
    }

    private var filterRow: some View {
        WrapLayout(spacing: 4, lineSpacing: 4) {
            ForEach(Self.filters, id: \.0) { f in
                Button(f.0) {
                    model.ledgerFilter = f.1
                    Task { await model.refreshLedger() }
                }
                .rowChip(model.ledgerFilter == f.1 ? .primary : .neutral)
                .accessibilityAddTraits(model.ledgerFilter == f.1 ? .isSelected : [])
            }
            if let t = model.ledgerTabFilter {
                Button("\(tabTitle(t)) ✕") {
                    model.ledgerTabFilter = nil
                    Task { await model.refreshLedger() }
                }
                .rowChip(.neutral)
                .accessibilityLabel("Clear the tab filter \(tabTitle(t))")
            }
        }
        .padding(.horizontal, 14)
    }

    private func row(_ e: SupervisorLedgerEntry) -> some View {
        let expanded = expandedRows.contains(e.seq)
        let glyph = SupervisorLedgerGlyph.for(decision: e.decision, actor: e.actor)
        let tab = e.tabTitle ?? e.sessionId.map(tabTitle) ?? (e.actor == "supervisor" ? "supervisor" : e.actor)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Image(systemName: glyph)
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(e.decision == "escalate" ? Color.orange : (e.actor == "supervisor" ? MarvinTheme.textPrimary : MarvinTheme.textMuted))
                    .frame(width: 12)
                    .accessibilityHidden(true)
                Text(e.verb).font(.system(size: 11, design: .monospaced)).foregroundStyle(MarvinTheme.textPrimary).lineLimit(1)
                Text("·").foregroundStyle(MarvinTheme.textMuted)
                Text(tab).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
                Text(clock(e.at)).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(MarvinTheme.textMuted)
            }
            Text(line2(e))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(expanded ? 4 : 1)
                .truncationMode(.tail)
                .padding(.leading, 17)
            if expanded { detail(e).padding(.leading, 17) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture { toggle(e.seq) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(spokenDecision(e)) \(e.verb), \(tab), \(clock(e.at))")
        .accessibilityValue(line2(e))
        .accessibilityAction(named: expanded ? "Collapse" : "Expand") { toggle(e.seq) }
        .contextMenu {
            if let sid = e.sessionId {
                Button("Show log for this tab") {
                    model.ledgerTabFilter = sid
                    Task { await model.refreshLedger() }
                }
                Button("Open tab") { model.showTab(sid) }
            }
            Button("Copy line as JSON") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(Self.json(e), forType: .string)
            }
        }
    }

    private func toggle(_ seq: Int) {
        if expandedRows.contains(seq) { expandedRows.remove(seq) } else { expandedRows.insert(seq) }
    }

    private func line2(_ e: SupervisorLedgerEntry) -> String {
        var text = e.reason?.text ?? e.argSummary ?? ""
        if let p = e.pairing, p.agreement != "pending", e.mode == "shadow" {
            let ans = p.actualAnswer?.joined(separator: ", ") ?? "—"
            text += " · you answered \(ans) \(p.agreement == "agree" ? "✓" : "✗")"
        }
        return text
    }

    @ViewBuilder
    private func detail(_ e: SupervisorLedgerEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let s = e.argSummary { Text(s).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary) }
            if let d = e.argDigest { Text("digest \(d.prefix(12))").font(.system(size: 10.5, design: .monospaced)).foregroundStyle(MarvinTheme.textMuted) }
            Text([e.mode, e.wakeId.map { "wake \($0.prefix(8))" }, e.costUsd.map { String(format: "$%.3f", $0) }]
                .compactMap { $0 }.joined(separator: " · "))
                .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(MarvinTheme.textMuted)
            if !e.grounds.isEmpty { SupervisorGroundsList(grounds: e.grounds) }
        }
    }

    private func spokenDecision(_ e: SupervisorLedgerEntry) -> String {
        switch e.decision {
        case "act": return "Acted"
        case "propose": return "Proposed"
        case "escalate": return "Escalated"
        case "refuse": return "Refused"
        case "drop": return "Dropped"
        default: return e.actor == "user" ? "You" : "Runtime"
        }
    }

    private func clock(_ iso: String) -> String {
        guard let d = SessionLedger.parseISO(iso) else { return "" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }

    private static func json(_ e: SupervisorLedgerEntry) -> String {
        var d: [String: Any] = ["seq": e.seq, "at": e.at, "actor": e.actor, "verb": e.verb]
        d["decision"] = e.decision
        d["sessionId"] = e.sessionId
        d["mode"] = e.mode
        d["argDigest"] = e.argDigest
        d["argSummary"] = e.argSummary
        d["reason"] = e.reason.map { ["code": $0.code, "text": $0.text] }
        let data = (try? JSONSerialization.data(withJSONObject: d, options: [.sortedKeys])) ?? Data()
        return String(data: data, encoding: .utf8) ?? ""
    }
}

// MARK: - Grounds (§6.2 item 4)

@MainActor struct SupervisorGroundsList: View {
    let grounds: [SupervisorGround]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(grounds) { g in
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    ProvenanceBadge(ground: g)
                    // The citation sits under its label: side by side, both
                    // were squeezed to a few characters at 260 pt.
                    VStack(alignment: .leading, spacing: 1) {
                    Text(g.displayLabel)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if let t = g.openTarget {
                        Button(g.citation) { MarvinBridge.shared.openFileFromChat(path: t.path, line: t.line) }
                            .buttonStyle(.link)
                            .font(.system(size: 10.5, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .accessibilityLabel("Open \(g.citation)")
                    } else {
                        Text(g.citation)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(MarvinTheme.textMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(g.isResolved ? (g.isStrong ? "Strong" : "Weak") : "Unresolved") ground: \(g.displayLabel), \(g.citation)")
            }
        }
    }
}

/// `strong` filled with `rowSelected`, `weak` outlined — the difference does
/// not depend on colour. An unresolved ground carries a strike glyph.
@MainActor struct ProvenanceBadge: View {
    let ground: SupervisorGround

    var body: some View {
        HStack(spacing: 2) {
            if !ground.isResolved {
                Image(systemName: "strikethrough").font(.system(size: 8, weight: .semibold))
            }
            Text(!ground.isResolved ? "did not resolve" : (ground.isStrong ? "strong" : "weak"))
                .font(.system(size: 10, design: .monospaced))
        }
        .foregroundStyle(ground.isStrong ? MarvinTheme.textPrimary : MarvinTheme.textMuted)
        .padding(.horizontal, 4)
        .padding(.vertical, 0.5)
        .background(
            RoundedRectangle(cornerRadius: MarvinTheme.Radius.badge)
                .fill(ground.isStrong ? MarvinTheme.rowSelected : Color.clear)
                .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.badge)
                    .stroke(ground.isStrong ? Color.clear : MarvinTheme.border, lineWidth: 1))
        )
        .fixedSize()
    }
}

// MARK: - The chat's note after an answer from elsewhere (plan M6 required fix)

@MainActor struct ExternalAnswerNoteRow: View {
    let note: ExternalAnswer.Note
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: note.bySupervisor ? SupervisorMark.symbol : "checkmark.circle")
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(MarvinTheme.textMuted)
                .accessibilityHidden(true)
            Text(note.text)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(note.bySupervisor ? "— not by you" : "— the question here is closed")
                .font(.system(size: 11))
                .foregroundStyle(MarvinTheme.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
            }
            .paneIconButton(8)
            .help("Dismiss")
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(note.bySupervisor ? "Answered by the supervisor, not by you" : note.text)
    }
}
