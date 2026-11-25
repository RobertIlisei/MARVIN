// PracticePane — the Practice tab inside LeftPane (ADR-0105).
//
// The practice loop, managed top to bottom: what the nightly pass found
// across this project's sessions (failures AND the same acts done right),
// the rules the user accepted from those findings and how they are holding,
// the run log, and the schedule. Every verb here is a POST to
// /api/practice/*; nothing changes MARVIN's behaviour without a click.
//
//   Findings  — approve (creates a rule from the kind's template), dismiss
//               with a reason, escalate a regressed rule one tier up.
//   Rules     — change tier, retire, promote to global.
//   Runs      — the log; Run now / Backtest in the header.

import AppKit
import MARVINLogic
import SwiftUI

@MainActor struct PracticePane: View {
    @Environment(MarvinBridge.self) private var bridge

    private enum Section: String, CaseIterable, Identifiable {
        case findings, working, rules, runs
        var id: String { rawValue }
        var label: String {
            switch self {
            case .findings: return "Findings"
            case .working: return "Working"
            case .rules: return "Rules"
            case .runs: return "Runs"
            }
        }
    }

    @State private var view: PracticeView?
    @State private var loadError: String?
    @State private var busy = false
    @State private var section: Section = .findings
    /// The outcome of the last action, with its KIND (ADR-0114).
    ///
    /// This was a `String?` rendered in one tinted strip with one moon icon
    /// and a four-second timer, so "Rule created for x" and a decode failure
    /// were the same pixels — and the failure was the one guaranteed to
    /// vanish before it was read. A notice now carries its kind, and
    /// `PaneNotice.dismissal` keeps a warning or an error on screen until it
    /// is dismissed.
    @State private var notice: PaneNotice?
    /// The one thing the current notice offers to do — retry a failure, or
    /// undo something reversible.
    @State private var action: (() async -> Void)?
    /// The finding whose dismissal can still be taken back.
    @State private var undoable: String?
    @State private var dismissing: PracticeFinding?
    @State private var dismissReason = ""
    @State private var fixing: PracticeFinding?
    @State private var confirmingReset = false
    @State private var fixNote = ""
    @State private var editingRule: PracticeRule?
    @State private var ruleMessage = ""
    @State private var fit: PracticeFit?
    @State private var showFit = false
    @State private var draft: PracticeDraft?
    @State private var draftFor: PracticeFinding?
    @State private var draftForRule: PracticeRule?
    @State private var draftText = ""
    /// The selected row, and which groups are closed (remembered per pane).
    @State private var selection: String?
    @State private var groups = PaneCollapseStore(pane: "practice")

    /// The snapshot harness shows a finding open (`SurfaceSnapshotPaneKit`).
    init(seedSelection: String? = nil) {
        _selection = State(initialValue: seedSelection)
    }

    private var projectId: String? {
        bridge.projectWorkDir.map { ProjectIdSlug.from(workDir: $0) }
    }

    var body: some View {
        VStack(spacing: 0) {
            if projectId == nil {
                practiceHeader(actions: false)
                PaneEmptyView(state: .noProject("repeat failures")).frame(maxHeight: .infinity)
            } else if loadError != nil, view == nil {
                practiceHeader(actions: false)
                PaneEmptyView(
                    state: .couldNotLoad("this project's practice ledger", reason: "Check that MARVIN's server is running, then try again."),
                    actionTitle: "Retry",
                    action: { Task { await refresh() } }
                ).frame(maxHeight: .infinity)
            } else if view == nil {
                practiceHeader(actions: false)
                PaneLoadingView(label: "Reading the practice ledger…")
                Spacer(minLength: 0)
            } else {
                content
            }
            if let notice {
                PaneNoticeStrip(
                    notice: notice,
                    actionTitle: undoable == nil ? "Retry" : "Undo",
                    onAction: action.map { a in { Task { await a() } } },
                    onDismiss: { withAnimation { self.notice = nil; self.action = nil; self.undoable = nil } }
                )
            }
        }
        .task(id: bridge.projectWorkDir) { await refresh() }
        .sheet(item: $dismissing) { finding in dismissSheet(finding) }
        .sheet(item: $fixing) { finding in fixedSheet(finding) }
        .sheet(item: $editingRule) { rule in ruleMessageSheet(rule) }
        .sheet(isPresented: $showFit) { fitSheet }
        .sheet(item: $draftFor) { f in draftSheet(findingId: f.id, rule: nil) }
        .sheet(item: $draftForRule) { r in draftSheet(findingId: r.fingerprint, rule: r) }
        .modifier(PaneGeometryProbe(name: "PracticePane"))
        // A pane absorbs compression and clips; it never negotiates for
        // width. All seven stay mounted in one ZStack, so the widest
        // intrinsic minimum among them becomes the sidebar's, and the
        // overflow pushes the 44pt rail off the left edge (ADR-0114).
        // Nor for height: measured at ~0pt wide its wrapped text claimed
        // 746pt, more than a window has, and the whole column was pushed up
        // under the title bar (2026-10-31; see FindInFilesView).
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .clipped()
    }

    // MARK: - Content
    //
    // The same shape as Skills and Plugins: the header and the picker are fixed,
    // the rows scroll, and every list is groups of rows from the kit. The first
    // version of this pane put the header INSIDE the scroll view because a header
    // outside it laid out taller than its slot and pushed the icon rail off the
    // window (user, 2026-09-03). The scroll list here is the flexible root and is
    // clipped by the pane's own frame; `PaneGeometryProbe` still records sizes.

    /// One group of the current tab, with what the keyboard needs to walk it.
    private struct GroupPlan {
        let id: String
        let startsCollapsed: Bool
        let rows: [(id: String, title: String)]
    }

    private var findingGroups: (live: [PracticeFinding], below: [PracticeFinding], done: [PracticeFinding]) {
        guard let view else { return ([], [], []) }
        let failures = view.findings.filter { !$0.isSuccess }
        let live = failures.filter { $0.state != "confirmed" && $0.state != "dismissed" && $0.state != "observed" }
            .sorted { $0.value > $1.value }
        return (live,
                failures.filter { $0.state == "observed" }.sorted { $0.value > $1.value },
                failures.filter { $0.state == "confirmed" || $0.state == "dismissed" })
    }

    private func plans(for tab: Section) -> [GroupPlan] {
        guard let view else { return [] }
        var out: [GroupPlan] = []
        switch tab {
        case .findings:
            let g = findingGroups
            if !view.starters.isEmpty {
                out.append(GroupPlan(id: "starters", startsCollapsed: false, rows: view.starters.map { (id: "starter:\($0.id)", title: $0.title) }))
            }
            out.append(GroupPlan(id: "findings.live", startsCollapsed: false, rows: g.live.map { (id: $0.id, title: $0.id) }))
            out.append(GroupPlan(id: "findings.below", startsCollapsed: true, rows: g.below.map { (id: $0.id, title: $0.id) }))
            out.append(GroupPlan(id: "findings.done", startsCollapsed: true, rows: g.done.map { (id: $0.id, title: $0.id) }))
        case .working:
            out.append(GroupPlan(id: "working", startsCollapsed: false, rows: view.findings.filter { $0.isSuccess }.map { (id: $0.id, title: $0.id) }))
        case .rules:
            out.append(GroupPlan(id: "rules.mine", startsCollapsed: false, rows: view.rules.filter { !$0.isBuiltin }.map { (id: $0.id, title: $0.title) }))
            out.append(GroupPlan(id: "rules.builtin", startsCollapsed: true, rows: view.rules.filter { $0.isBuiltin }.map { (id: $0.id, title: $0.title) }))
        case .runs:
            out.append(GroupPlan(id: "runs", startsCollapsed: false, rows: view.runs.map { (id: "run:\($0.id)", title: Self.relative($0.at)) }))
        }
        return out
    }

    private func visibleRows(for tab: Section) -> [(id: String, title: String)] {
        plans(for: tab).filter { !groups.isCollapsed($0.id, default: $0.startsCollapsed) }.flatMap { $0.rows }
    }

    @ViewBuilder
    private var content: some View {
        VStack(spacing: 0) {
            practiceHeader(actions: true)
            if let view, !view.config.enabled {
                // ADR-0136: the loop is opt-in. Off, it reads nothing at night
                // and proposes nothing; the built-in gates keep working.
                PaneNoticeStrip(
                    notice: PaneNotice(kind: .info, headline: "Practice is off. Each night it would read this project's sessions and propose rules; MARVIN's built-in gates work either way."),
                    actionTitle: "Turn on",
                    onAction: { Task { await setSchedule(enabled: true, hour: nil) } })
                    .padding(.bottom, PaneSpace.tight)
            }
            // A segmented control cannot shrink: with counts ("Findings 5") the
            // fourth tab was cut off at 260 pt (U4). Counts when they fit,
            // plain labels when they do not.
            ViewThatFits(in: .horizontal) {
                sectionPicker(counts: true)
                sectionPicker(counts: false)
            }
            .padding(.horizontal, PaneSpace.gutter)
            .padding(.bottom, PaneSpace.compact)
            PaneScrollList(
                rows: visibleRows(for: section), selection: $selection,
                onActivate: { id in activate(id) },
                onSpace: nil, onEscape: nil
            ) {
                switch section {
                case .findings: findingsTab
                case .working: workingTab
                case .rules: rulesTab
                case .runs: runsTab
                }
                aboutGroups
            }
        }
    }

    private func sectionPicker(counts: Bool) -> some View {
        Picker("", selection: $section) {
            ForEach(Section.allCases) { s in
                Text(counts ? sectionLabel(s) : s.label).tag(s)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
        .fixedSize(horizontal: true, vertical: false)
    }

    private func sectionLabel(_ s: Section) -> String {
        guard let view else { return s.label }
        switch s {
        case .findings:
            let n = view.findings.filter { !$0.isSuccess && $0.state != "dismissed" && $0.state != "confirmed" && $0.state != "observed" }.count
            return n > 0 ? "\(s.label) \(n)" : s.label
        case .working:
            let n = view.findings.filter { $0.isSuccess }.count
            return n > 0 ? "\(s.label) \(n)" : s.label
        case .rules:
            let n = view.rules.filter { $0.status == "active" }.count
            return n > 0 ? "\(s.label) \(n)" : s.label
        case .runs:
            return s.label
        }
    }

    /// Return on a finding opens it; on a starter adopts it.
    private func activate(_ id: String) {
        guard let view else { return }
        if id.hasPrefix("starter:"), let s = view.starters.first(where: { "starter:\($0.id)" == id }) {
            Task { await adopt(s) }
        }
    }

    // MARK: Header

    /// One verb, and the menu: the review found five actions fighting for one
    /// row ("Run no…"). Run now is the pane's point; the rest wait in the menu.
    private func practiceHeader(actions: Bool) -> some View {
        PaneHeader(title: "Practice", symbol: "moon.zzz",
                   subtitle: actions ? (view?.lastRun.map { "ran \(Self.relative($0.at))" } ?? "never run") : nil) {
            if actions {
                PaneActionButton(
                    title: "Run now", role: .primary, help: "Read every session that changed since the last run and update the findings (ADR-0105).",
                    disabled: busy
                ) { Task { await runNow(force: false) } }
                PaneOverflowMenu(label: "More actions for Practice") {
                    Button("Backtest — re-read every transcript") { Task { await runNow(force: true) } }
                        .disabled(busy)
                        .help("Re-read every transcript from scratch. This is how the weights get tuned: rank what actually cost the most.")
                    Button("Fit weights from outcomes…") { Task { await fitWeights(apply: false) } }
                        .disabled(busy)
                        .help("Fit the five score weights from every ledger's own outcomes (ADR-0105 phase 5). Shows the proposal; nothing changes until you apply.")
                    Divider()
                    Button("Reload") { Task { await refresh() } }.disabled(busy)
                    Button("Open the Practice guide") {
                        NSWorkspace.shared.open(URL(string: "https://github.com/RobertIlisei/MARVIN/blob/main/docs/guides/practice.md")!)
                    }
                    .help("What it looks for, the tiers, verification, and a first-session walkthrough.")
                }
            }
        }
    }

    // MARK: Findings

    @ViewBuilder
    private var findingsTab: some View {
        if let view {
            let g = findingGroups
            let calibrating = view.sessionsSeen < view.config.thresholds.minSessions
            if calibrating {
                coldStartNotice(view)
            }
            if !view.starters.isEmpty {
                PaneGroup(
                    store: groups, id: "starters", title: "Proven in your other projects", count: view.starters.count, tint: Color.accentColor,
                    help: "Rules confirmed in your other projects that this project has no rule for. Adopting one copies it here and starts its own verification clock."
                ) {
                    ForEach(view.starters) { s in starterRow(s) }
                }
            }
            if g.live.isEmpty && g.below.isEmpty && g.done.isEmpty {
                PaneEmptyView(
                    state: .nothingYet("repeat failures",
                        hint: view.lastRun == nil
                            ? "Use Run now to read this project's sessions."
                            : "Either the sessions are clean or there are fewer than three of them."))
            } else {
                PaneGroup(
                    store: groups, id: "findings.live", title: "Needs a decision", count: g.live.count, tint: .orange,
                    help: "Priority: " + PracticeScoreBand.legend
                ) {
                    if g.live.isEmpty { PaneNote(text: "Nothing waiting. Findings that clear the bar appear here, highest priority first.") }
                    ForEach(g.live) { f in findingRow(f) }
                }
                if !g.below.isEmpty {
                    PaneGroup(
                        store: groups, id: "findings.below", title: "Below the proposal bar", count: g.below.count,
                        help: "Seen, but not yet in enough sessions or not valuable enough to propose a rule.", startsCollapsed: true
                    ) {
                        ForEach(g.below) { f in findingRow(f) }
                    }
                }
                if !g.done.isEmpty {
                    PaneGroup(
                        store: groups, id: "findings.done", title: "Confirmed or dismissed", count: g.done.count,
                        help: "Decided. Confirmed means the fix held; dismissed means you said it is not a problem here.", startsCollapsed: true
                    ) {
                        ForEach(g.done) { f in findingRow(f) }
                    }
                }
            }
        }
    }

    /// A project MARVIN has not worked in enough yet. Says what already applies
    /// and how far it is from its first proposal.
    private func coldStartNotice(_ view: PracticeView) -> some View {
        let need = view.config.thresholds.minSessions
        let builtins = view.rules.filter { $0.isBuiltin && $0.status == "active" }.count
        let globals = view.rules.filter { !$0.isBuiltin && $0.isGlobal && $0.status == "active" }.count
        let inForce = "\(builtins) built-in gate\(builtins == 1 ? "" : "s")\(globals > 0 ? " and \(globals) global rule\(globals == 1 ? "" : "s")" : "")"
        return PaneNoticeStrip(notice: PaneNotice(
            kind: .info,
            headline: "New project: \(view.sessionsSeen) of \(need) sessions before the first proposal. Already in force: \(inForce)."))
    }

    private func starterRow(_ s: PracticeStarterRule) -> some View {
        let id = "starter:\(s.id)"
        return PaneListRow(
            rowID: id, title: s.title, leading: .glyph(tierGlyph(s.tier), tierTint(s.tier)),
            secondary: "Confirmed in \(s.confirmedIn.count) project\(s.confirmedIn.count == 1 ? "" : "s") · \(s.tier)",
            selected: selection == id,
            items: [PaneRowItem(id: "adopt", title: "Adopt", role: .primary, enabled: !busy,
                                help: "Copy this rule here and start its own verification clock.", perform: { Task { await adopt(s) } })],
            onSelect: { selection = id },
            showsDetail: selection == id,
            detail: {
                Text(s.fingerprint).font(PaneFont.secondaryMono).foregroundStyle(MarvinTheme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            })
    }

    @ViewBuilder
    private var workingTab: some View {
        if let view {
            let wins = view.findings.filter { $0.isSuccess }
            if wins.isEmpty {
                PaneEmptyView(state: .nothingYet("confirmed practices", hint: "A success needs three sessions to count."))
            } else {
                PaneGroup(
                    store: groups, id: "working", title: "Done right", count: wins.count, tint: GitDecorationColor.added,
                    help: "The same acts done right. These are the denominator for every rate on the Findings tab and the evidence that a rule held."
                ) {
                    ForEach(wins) { f in findingRow(f) }
                }
            }
        }
    }

    private func findingRow(_ f: PracticeFinding) -> some View {
        let tint = stateTint(f.state)
        let band = PracticeScoreBand.band(f.value, proposalBar: view?.config.thresholds.minValue ?? 0.6)
        var trailingText: String?
        var trailingTint = MarvinTheme.textMuted
        switch f.state {
        case "regressed": trailingText = "Regressed"; trailingTint = tint
        case "confirmed", "practice": trailingText = f.isSuccess ? nil : "Confirmed"; trailingTint = tint
        case "fixed": trailingText = "Fixed"; trailingTint = tint
        case "dismissed": trailingText = "Dismissed"
        case "report": trailingText = "Report only"; trailingTint = tint
        default: break
        }
        return PaneListRow(
            rowID: f.id, title: f.id, titleIsIdentifier: true,
            leading: .glyph(stateGlyph(f.state), tint),
            secondary: summary(f, band: ["proposed", "observed"].contains(f.state) ? band : nil),
            trailingText: trailingText, trailingTint: trailingTint,
            selected: selection == f.id,
            items: f.isSuccess ? [] : findingItems(f),
            menuLabel: "More actions for \(f.id)",
            onSelect: { selection = f.id },
            showsDetail: selection == f.id,
            detail: { findingDetail(f) })
    }

    /// One primary verb per finding; everything else is in the menu. The review
    /// found four buttons per card in small grey text.
    private func findingItems(_ f: PracticeFinding) -> [PaneRowItem] {
        var items: [PaneRowItem] = []
        let canApprove = f.template && (f.state == "proposed" || (f.state == "regressed" && f.ruleId == nil))
        if f.state == "regressed", f.ruleId != nil {
            items.append(PaneRowItem(id: "escalate", title: "Escalate tier", systemImage: "arrow.up.circle", role: .primary, enabled: !busy,
                                     help: "The rule is not holding. Move it one tier up and restart verification.", perform: { Task { await escalate(f) } }))
        }
        if canApprove {
            items.append(PaneRowItem(id: "approve", title: "Approve", systemImage: "checkmark.circle", role: .primary, enabled: !busy,
                                     help: "Create a rule from this finding at the template's own tier.", perform: { Task { await approve(f, tier: nil, global: false) } }))
            items.append(PaneRowItem(id: "tier-prompt", title: "Approve as prompt", enabled: !busy, perform: { Task { await approve(f, tier: "prompt", global: false) } }))
            items.append(PaneRowItem(id: "tier-nudge", title: "Approve as nudge", enabled: !busy, perform: { Task { await approve(f, tier: "nudge", global: false) } }))
            items.append(PaneRowItem(id: "tier-deny", title: "Approve as deny", enabled: !busy, perform: { Task { await approve(f, tier: "deny", global: false) } }))
            items.append(PaneRowItem(id: "approve-global", title: "Approve for every project", enabled: !busy, perform: { Task { await approve(f, tier: nil, global: true) } }))
        }
        let decidable = ["proposed", "observed", "report", "regressed"].contains(f.state)
        if f.template && decidable {
            items.append(PaneRowItem(id: "draft", title: "Draft the message…", systemImage: "text.badge.star", enabled: !busy,
                                     help: "Ask a read-only model to write the rule message from this finding's aggregates (ADR-0105 phase 4). One small model call; you accept or discard.",
                                     perform: { draftText = ""; draft = nil; draftFor = f }))
        }
        if decidable {
            items.append(PaneRowItem(id: "fixed", title: "Fixed in MARVIN…", systemImage: "wrench.and.screwdriver", enabled: !busy,
                                     help: "You changed MARVIN's code for this. Verified like a rule: a recurrence after today is a regression, a quiet window confirms it.",
                                     perform: { fixNote = ""; fixing = f }))
            items.append(PaneRowItem(id: "dismiss", title: "Dismiss…", systemImage: "xmark.circle", enabled: !busy,
                                     help: "Silence it, with a reason. It returns if it is seen in twice as many sessions.",
                                     perform: { dismissReason = ""; dismissing = f }))
        }
        return items
    }

    /// The one secondary line of a finding: the verdict if there is one ("was
    /// 31 %, now 5 %"), otherwise how often and when.
    private func summary(_ f: PracticeFinding, band: PracticeScoreBand?) -> String {
        if let v = verification(f) { return v }
        var parts = [band.map { "\($0.label) priority" }].compactMap { $0 }
        parts.append("\(f.distinctSessions) session\(f.distinctSessions == 1 ? "" : "s")")
        if let rate = f.rate { parts.append(String(format: "%.0f%% of sessions", rate * 100)) }
        parts.append("last \(Self.relative(f.lastSeen))")
        return parts.joined(separator: " · ")
    }

    private func verification(_ f: PracticeFinding) -> String? {
        guard let after = f.sessionsAfter, let rec = f.recurrenceAfter, f.ruleId != nil || f.fixNote != nil else { return nil }
        let what = f.ruleId != nil ? "rule" : "fix"
        let now = Self.percent(f.rateAfter ?? (after > 0 ? Double(rec) / Double(after) : 0))
        if let base = f.baseline, base.sessions > 0 {
            return "was \(Self.percent(base.rate)) of sessions, now \(now) (\(rec) of \(after) since \(what))"
        }
        return "now \(now) of sessions (\(rec) of \(after) since \(what)); the rate before was not kept"
    }

    /// What a selected finding adds: the evidence, the whole tally, and — for a
    /// finding with a score — what the score means.
    @ViewBuilder
    private func findingDetail(_ f: PracticeFinding) -> some View {
        VStack(alignment: .leading, spacing: PaneSpace.tight) {
            if !f.latestDetail.isEmpty { Text(f.latestDetail).lineLimit(6) }
            Text(metaLine(f))
            if !f.isSuccess {
                Text("Priority \(PracticeScoreBand.summary(f.value, proposalBar: view?.config.thresholds.minValue ?? 0.6)). \(PracticeScoreBand.legend)")
            }
            if let reason = f.dismissReason, f.state == "dismissed" { Text("Dismissed: \(reason)") }
            if let note = f.fixNote, !note.isEmpty, f.state == "fixed" { Text("Fixed: \(note)") }
            if f.state == "report" || (!f.template && !f.isSuccess) {
                Text("Report only: about MARVIN itself, not a behaviour a rule can change.")
            }
        }
        .font(PaneFont.secondary)
        .foregroundStyle(MarvinTheme.textMuted)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// The extras the secondary line leaves out: what it cost, and when.
    private func metaLine(_ f: PracticeFinding) -> String {
        "\(Self.compact(f.costTotal)) \(f.unit) · first seen \(Self.relative(f.firstSeen)) · last seen \(Self.relative(f.lastSeen))"
    }

    /// One decimal under 10 %, none above: "0.4 %" and "26 %" both read right.
    static func percent(_ r: Double) -> String {
        let p = r * 100
        return p > 0 && p < 10 ? String(format: "%.1f%%", p) : String(format: "%.0f%%", p)
    }

    private func fixedSheet(_ f: PracticeFinding) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Fixed in MARVIN — \(f.id)").font(.headline)
            Text("Starts the verification clock now. If it recurs in a later session the finding comes back as regressed; \(view?.config.verifyWindow ?? 5) quiet sessions confirm it.")
                .font(PaneFont.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextField("What changed? (version, ADR, mechanism)", text: $fixNote)
                .textFieldStyle(.roundedBorder)
            HStack {
                Spacer()
                Button("Cancel") { fixing = nil }
                Button("Mark fixed") { Task { await markFixed(f, note: fixNote); fixing = nil } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(fixNote.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(16)
        .frame(width: 380)
    }

    // MARK: Rules

    @ViewBuilder
    private var rulesTab: some View {
        if let view {
            let mine = view.rules.filter { !$0.isBuiltin }
            let builtins = view.rules.filter { $0.isBuiltin }
            PaneGroup(
                store: groups, id: "rules.mine", title: "Your rules", count: mine.count, tint: Color.accentColor,
                help: "Rules you accepted from findings, enforced at the tier you chose, then measured."
            ) {
                if mine.isEmpty { PaneNote(text: "No rules of your own yet. Approve a finding to create one.") }
                ForEach(mine) { r in ruleRow(r) }
            }
            if !builtins.isEmpty {
                PaneGroup(
                    store: groups, id: "rules.builtin", title: "Built-in gates", count: builtins.count,
                    help: "MARVIN's hand-written gates, as rows. Their logic stays in code; you decide the tier, switch one off, or reword it. Counts are real fires.",
                    startsCollapsed: true
                ) {
                    ForEach(builtins) { r in ruleRow(r) }
                }
            }
        }
    }

    private func ruleRow(_ r: PracticeRule) -> some View {
        let active = r.status == "active"
        var items: [PaneRowItem] = []
        if !active {
            items.append(PaneRowItem(id: "reactivate", title: r.isBuiltin ? "Switch on" : "Reactivate", role: .primary, enabled: !busy,
                                     perform: { Task { await setRule(r, status: "active") } }))
        } else if r.suggestGlobal == true, !r.isGlobal {
            items.append(PaneRowItem(id: "promote", title: "Promote", role: .primary, enabled: !busy,
                                     help: "Confirmed in \(r.confirmedIn ?? 0) projects. Make it a rule in every project.",
                                     perform: { Task { await setRule(r, global: true) } }))
        }
        if active {
            items.append(PaneRowItem(id: "tier-prompt", title: "Tier: prompt", enabled: !busy, perform: { Task { await setRule(r, tier: "prompt") } }))
            items.append(PaneRowItem(id: "tier-nudge", title: "Tier: nudge", enabled: !busy, perform: { Task { await setRule(r, tier: "nudge") } }))
            items.append(PaneRowItem(id: "tier-deny", title: "Tier: deny", enabled: !busy, perform: { Task { await setRule(r, tier: "deny") } }))
            items.append(PaneRowItem(id: "edit", title: "Edit message…", systemImage: "pencil", enabled: !busy, perform: { ruleMessage = r.message; editingRule = r }))
            if !r.isBuiltin {
                items.append(PaneRowItem(id: "draft", title: "Draft the message with the model…", systemImage: "text.badge.star", enabled: !busy,
                                         perform: { draftText = ""; draft = nil; draftForRule = r }))
            }
            if !r.isGlobal && !r.isBuiltin && r.suggestGlobal != true {
                items.append(PaneRowItem(id: "promote-menu", title: "Promote to every project", enabled: !busy, perform: { Task { await setRule(r, global: true) } }))
            }
            items.append(PaneRowItem(id: "retire", title: r.isBuiltin ? "Switch off" : "Retire", role: .destructive, enabled: !busy,
                                     perform: { Task { await setRule(r, status: "retired") } }))
        }
        let scopeWord = r.isBuiltin ? "Built-in" : (r.isGlobal ? "Every project" : nil)
        return PaneListRow(
            rowID: r.id, title: r.title,
            leading: .glyph(active ? tierGlyph(r.tier) : "pause.circle", active ? tierTint(r.tier) : MarvinTheme.textMuted),
            secondary: r.message,
            trailingText: active ? r.tier : "Retired",
            selected: selection == r.id, items: items, menuLabel: "More actions for \(r.title)",
            onSelect: { selection = r.id },
            showsDetail: selection == r.id,
            detail: {
                VStack(alignment: .leading, spacing: PaneSpace.tight) {
                    Text(r.message).lineLimit(8)
                    Text("Fired \(r.metrics.fired)\(r.metrics.bypasses > 0 ? ", bypassed \(r.metrics.bypasses)" : "") · accepted \(Self.relative(r.acceptedAt))\(scopeWord.map { " · \($0)" } ?? "")")
                    if let n = r.confirmedIn, r.suggestGlobal == true { Text("Confirmed in \(n) projects.") }
                    Text(r.fingerprint).font(PaneFont.secondaryMono)
                }
                .font(PaneFont.secondary).foregroundStyle(MarvinTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            })
    }

    // MARK: Runs

    @ViewBuilder
    private var runsTab: some View {
        if let view {
            if view.runs.isEmpty {
                PaneEmptyView(state: .nothingYet("runs", hint: "Run now reads this project's sessions and records what it found."))
            } else {
                PaneGroup(store: groups, id: "runs", title: "Runs", count: view.runs.count, help: "The nightly pass and the runs you started, newest first.") {
                    ForEach(view.runs) { run in runRow(run) }
                }
            }
        }
    }

    private func runRow(_ run: PracticeRun) -> some View {
        let id = "run:\(run.id)"
        return PaneListRow(
            rowID: id, title: "\(Self.relative(run.at)) · \(run.trigger)", leading: .glyph("clock"),
            secondary: "\(run.sessionsRead) read · \(run.findingsNew) new · \(run.proposed) proposed",
            trailingText: run.regressed > 0 ? "\(run.regressed) regressed" : (run.confirmed > 0 ? "\(run.confirmed) confirmed" : nil),
            trailingSymbol: run.regressed > 0 ? "exclamationmark.triangle.fill" : nil,
            trailingTint: run.regressed > 0 ? GitDecorationColor.deleted : MarvinTheme.textMuted,
            selected: selection == id, onSelect: { selection = id }, showsDetail: selection == id,
            detail: {
                Text("\(run.recurring) recurring · \(run.occurrences) occurrences · \(run.sessionsSkippedLive) skipped as live · \(run.durationMs) ms")
                    .font(PaneFont.secondary).foregroundStyle(MarvinTheme.textMuted)
            })
    }

    // MARK: Schedule and guide

    /// Reference, read once, so it follows the rows rather than preceding them.
    @ViewBuilder
    private var aboutGroups: some View {
        if let view {
            PaneGroup(store: groups, id: "about.schedule", title: "Schedule", help: "When the nightly pass runs, how far back it reads, and a reset.", startsCollapsed: true) {
                VStack(alignment: .leading, spacing: PaneSpace.standard) {
                    Toggle(isOn: Binding(
                        get: { view.config.enabled },
                        set: { on in Task { await setSchedule(enabled: on, hour: nil) } }
                    )) { Text("Run nightly").font(PaneFont.secondary) }
                    .toggleStyle(.switch).controlSize(.mini)
                    Stepper(value: Binding(
                        get: { view.config.hour },
                        set: { h in Task { await setSchedule(enabled: nil, hour: h) } }
                    ), in: 0...23) {
                        Text(String(format: "at %02d:00", view.config.hour)).font(PaneFont.secondaryMono)
                    }
                    Stepper(value: Binding(
                        get: { view.config.windowDays ?? 45 },
                        set: { d in Task { await setSchedule(enabled: nil, hour: nil, windowDays: d) } }
                    ), in: 1...365, step: 5) {
                        Text("read the last \(view.config.windowDays ?? 45) days").font(PaneFont.secondaryMono)
                    }
                    .help("Sessions older than this age out of every count. Watermarks stay, so nothing is re-read.")
                    if let fitInfo = view.config.fit {
                        Text("Weights fitted \(Self.relative(fitInfo.at)) · \(fitInfo.method) · \(fitInfo.labelled)/\(fitInfo.samples) labelled · ρ \(String(format: "%.2f", fitInfo.rho))")
                            .font(PaneFont.secondaryMono).foregroundStyle(MarvinTheme.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("Weights: hand-set defaults").font(PaneFont.secondaryMono).foregroundStyle(MarvinTheme.textMuted)
                    }
                    PaneActionButton(title: "Reset findings…", role: .tinted(GitDecorationColor.deleted),
                                     help: "Clear every finding, watermark and run record for this project. Rules stay; the next run re-reads the window and re-attaches findings to their rules.",
                                     disabled: busy) {
                        confirmingReset = true
                    }
                    .confirmationDialog("Reset this project's findings?", isPresented: $confirmingReset) {
                        Button("Reset findings", role: .destructive) { Task { await resetFindings() } }
                    } message: {
                        Text("Findings, watermarks and run records are cleared. Rules are kept. The next run re-reads every session inside the window.")
                    }
                }
                .padding(.horizontal, PaneSpace.gutter)
                .padding(.vertical, PaneSpace.compact)
            }
            PaneGroup(store: groups, id: "about.how", title: "How this works", help: "What Practice looks for and what it will never do.", startsCollapsed: true) {
                VStack(alignment: .leading, spacing: PaneSpace.standard) {
                    Text("Repeat failures mined from this project's own sessions, next to the same acts done right. It proposes, you approve, and an accepted rule is enforced at the tier you choose, then measured.")
                    howEntry("Every night", "Plain code reads this project's session transcripts and counts each failure kind by distinct session, and the same act done right, so a finding carries a rate.")
                    howEntry("Proposed", "Three sessions and a priority of 0.6. Approve makes a rule; Dismiss silences it with a reason; Fixed in MARVIN says you changed MARVIN's code.")
                    howEntry("Priority", PracticeScoreBand.legend)
                    howEntry("Tiers", "prompt = a line in the system prompt. nudge = the call runs, MARVIN sees the message first. deny = the call is refused, twice per turn, then allowed and counted. A deny needs a checkable way out, or it acts as a nudge.")
                    howEntry("Verified", "Each fix and rule keeps the rate it was accepted at. Regressed means two recurring sessions at half that rate or more; five sessions below it confirm. The row shows both: was 31 %, now 5 %.")
                    howEntry("Built-in gates", "MARVIN's own gates are rows too: tier, off, message, fired counts. No row means native behaviour.")
                    howEntry("Never", "No model reads a transcript; nothing changes without your click. Draft message is the only model call, and it sees aggregates.")
                    Text("Full guide: docs/guides/practice.md · design: ADR-0105").font(PaneFont.secondaryMono)
                }
                .font(PaneFont.secondary)
                .foregroundStyle(MarvinTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, PaneSpace.gutter)
                .padding(.vertical, PaneSpace.compact)
            }
        }
    }

    private func howEntry(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(PaneFont.group).foregroundStyle(MarvinTheme.textPrimary)
            Text(body)
        }
    }

    // MARK: State words

    private func stateTint(_ state: String) -> Color {
        switch state {
        case "proposed": return .orange
        case "active": return .blue
        case "regressed": return GitDecorationColor.deleted
        case "confirmed", "practice": return GitDecorationColor.added
        case "fixed": return .teal
        case "report": return .purple
        default: return MarvinTheme.textMuted
        }
    }

    /// The shape says the state; the colour only agrees.
    private func stateGlyph(_ state: String) -> String {
        switch state {
        case "proposed": return "lightbulb.fill"
        case "observed": return "circle.dotted"
        case "active": return "checkmark.circle"
        case "regressed": return "arrow.uturn.down.circle.fill"
        case "confirmed", "practice": return "checkmark.seal.fill"
        case "fixed": return "wrench.and.screwdriver.fill"
        case "dismissed": return "xmark.circle"
        case "report": return "doc.text"
        default: return "circle"
        }
    }

    private func tierGlyph(_ tier: String) -> String {
        switch tier {
        case "deny": return "hand.raised.fill"
        case "nudge": return "bell.fill"
        default: return "text.bubble"
        }
    }

    private func tierTint(_ tier: String) -> Color {
        switch tier {
        case "deny": return GitDecorationColor.deleted
        case "nudge": return .orange
        default: return MarvinTheme.textMuted
        }
    }

    // MARK: - Sheets

    private func dismissSheet(_ f: PracticeFinding) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Dismiss \(f.id)").font(.headline)
            Text("It stays quiet until it has been seen in twice as many sessions as now (\(f.distinctSessions * 2)). The reason is kept with it.")
                .font(PaneFont.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextField("Why is this not a problem here?", text: $dismissReason)
                .textFieldStyle(.roundedBorder)
            HStack {
                Spacer()
                Button("Cancel") { dismissing = nil }
                Button("Dismiss") { Task { await dismiss(f, reason: dismissReason); dismissing = nil } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(dismissReason.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(16)
        .frame(width: 380)
    }

    private func ruleMessageSheet(_ r: PracticeRule) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Message — \(r.title)").font(.headline)
            Text(r.isBuiltin
                 ? "A built-in gate's native message names the file, the query, or the Skill call to run. Replace it only with text that still names the remedy; an edited message is used verbatim."
                 : "This is what the model reads when the rule fires. Name the remedy.")
                .font(PaneFont.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $ruleMessage)
                .font(PaneFont.secondaryMono)
                .frame(minHeight: 120)
            HStack {
                Spacer()
                Button("Cancel") { editingRule = nil }
                Button("Save") { Task { await setRule(r, message: ruleMessage); editingRule = nil } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(ruleMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
        .frame(width: 460)
    }

    private var fitSheet: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Fit the score weights").font(.headline)
            if let fit {
                Text("\(fit.method) · \(fit.labelled) labelled of \(fit.samples) findings · rank correlation \(String(format: "%.2f → %.2f", fit.rhoBefore, fit.rhoAfter))")
                    .font(PaneFont.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text(fit.labelled < 8
                     ? "Fewer than 8 findings have an outcome yet, so this ranks by measured cost share. It gets better as rules confirm or regress."
                     : "Weights that best rank findings by whether they later confirmed, regressed, or were dismissed.")
                    .font(PaneFont.secondary).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                    GridRow { Text("factor").font(PaneFont.group); Text("current").font(PaneFont.group); Text("proposed").font(PaneFont.group) }
                    ForEach([("recurrence", fit.current.recurrence, fit.weights.recurrence),
                             ("cost", fit.current.cost, fit.weights.cost),
                             ("rate", fit.current.rate, fit.weights.rate),
                             ("reliability", fit.current.reliability, fit.weights.reliability),
                             ("actionability", fit.current.actionability, fit.weights.actionability)], id: \.0) { row in
                        GridRow {
                            Text(row.0).font(PaneFont.secondaryMono)
                            Text(String(format: "%.2f", row.1)).font(PaneFont.secondaryMono).foregroundStyle(.secondary)
                            Text(String(format: "%.2f", row.2)).font(PaneFont.secondaryMono)
                                .foregroundStyle(abs(row.1 - row.2) > 0.005 ? Color.orange : Color.primary)
                        }
                    }
                }
            } else {
                Text("Fitting…").font(PaneFont.secondary).foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("Close") { showFit = false }
                Button("Apply") { Task { await fitWeights(apply: true); showFit = false } }
                    .keyboardShortcut(.defaultAction).disabled(fit == nil || busy)
            }
        }
        .padding(16)
        .frame(width: 420)
    }

    private func draftSheet(findingId: String, rule: PracticeRule?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Draft message — \(findingId)").font(.headline)
            Text("A read-only model wrote this from the finding's aggregates — never from a transcript. Edit it, then accept: it becomes the rule's message\(rule == nil ? " when you approve" : "").")
                .font(PaneFont.secondary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let draft {
                TextEditor(text: $draftText).font(PaneFont.secondaryMono).frame(minHeight: 110)
                if !draft.rationale.isEmpty {
                    Text("Rationale: \(draft.rationale)").font(PaneFont.secondary).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
                }
                if let cost = draft.costUsd {
                    Text(String(format: "cost $%.3f", cost)).font(PaneFont.secondaryMono).foregroundStyle(.tertiary)
                }
            } else {
                Text("Asking the model…").font(PaneFont.secondary).foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("Discard") { draftFor = nil; draftForRule = nil }
                if let rule {
                    Button("Save as message") { Task { await setRule(rule, message: draftText); draftForRule = nil } }
                        .keyboardShortcut(.defaultAction).disabled(draft == nil || draftText.isEmpty || busy)
                } else {
                    Button("Approve with this message") {
                        Task { await approveWithMessage(findingId: findingId, message: draftText); draftFor = nil }
                    }
                    .keyboardShortcut(.defaultAction).disabled(draft == nil || draftText.isEmpty || busy)
                }
            }
        }
        .padding(16)
        .frame(width: 480)
        .task(id: findingId) { await requestDraft(findingId: findingId) }
    }

    private static func relative(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter.flexible.date(from: iso) else { return iso }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f.localizedString(for: date, relativeTo: Date())
    }

    private static func compact(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", n / 1_000) }
        return n == n.rounded() ? String(Int(n)) : String(format: "%.1f", n)
    }

    // MARK: - Actions

    private func refresh() async {
        guard let projectId else { view = nil; return }
        busy = true; defer { busy = false }
        do {
            view = try await PracticeService.shared.load(projectId: projectId)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func runNow(force: Bool) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do {
            view = try await PracticeService.shared.run(projectId: projectId, force: force)
            if let last = view?.lastRun {
                flash("\(last.sessionsRead) session\(last.sessionsRead == 1 ? "" : "s") read · \(last.findingsNew) new · \(last.proposed) proposed")
            }
        } catch { fail(error) }
    }

    private func approve(_ f: PracticeFinding, tier: String?, global: Bool) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do {
            view = try await PracticeService.shared.approve(projectId: projectId, id: f.id, tier: tier, global: global)
            flash("Rule created for \(f.id)")
        } catch { fail(error) }
    }

    /// Take back a dismissal. The same transition recurrence would make on
    /// its own, asked for by a person — dismissing used to be a one-way door
    /// behind a required reason (ADR-0114).
    private func undoDismiss(_ id: String) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do {
            view = try await PracticeService.shared.undismiss(projectId: projectId, id: id)
            undoable = nil
            flash("\(id) is back in the findings")
        } catch { fail(error) }
    }

    private func dismiss(_ f: PracticeFinding, reason: String) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do {
            view = try await PracticeService.shared.dismiss(projectId: projectId, id: f.id, reason: reason)
            // A successful mutation used to flash nothing at all, so a silent
            // success and a silent failure looked identical — and the
            // dismissal itself had no reverse anywhere (ADR-0114).
            undoable = f.id
            action = { await undoDismiss(f.id) }
            show(PaneNotice(kind: .success, headline: "Dismissed \(f.id).", detail: "It stays quiet until it recurs in twice as many sessions."))
        } catch { fail(error) }
    }

    private func markFixed(_ f: PracticeFinding, note: String) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do {
            view = try await PracticeService.shared.markFixed(projectId: projectId, id: f.id, note: note)
            flash("Verification clock started for \(f.id)")
        } catch { fail(error) }
    }

    private func escalate(_ f: PracticeFinding) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do {
            view = try await PracticeService.shared.escalate(projectId: projectId, id: f.id)
            flash("Escalated \(f.id)")
        } catch { fail(error) }
    }

    private func setRule(_ r: PracticeRule, tier: String? = nil, status: String? = nil, global: Bool? = nil, message: String? = nil) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do { view = try await PracticeService.shared.updateRule(projectId: projectId, id: r.id, tier: tier, status: status, global: global, message: message) }
        catch { fail(error) }
    }

    private func fitWeights(apply: Bool) async {
        busy = true; defer { busy = false }
        if !apply { fit = nil; showFit = true }
        do {
            let result = try await PracticeService.shared.fitWeights(apply: apply)
            fit = result
            if apply { flash("Weights applied (\(result.method))"); await refresh() }
        } catch { fail(error); showFit = false }
    }

    private func requestDraft(findingId: String) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do {
            let d = try await PracticeService.shared.draft(projectId: projectId, id: findingId)
            draft = d; draftText = d.message
        } catch {
            fail(error)
            draftFor = nil; draftForRule = nil
        }
    }

    private func approveWithMessage(findingId: String, message: String) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do {
            view = try await PracticeService.shared.approve(projectId: projectId, id: findingId, tier: nil, global: false, message: message)
            flash("Rule created for \(findingId)")
        } catch { fail(error) }
    }

    private func adopt(_ s: PracticeStarterRule) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do {
            view = try await PracticeService.shared.adopt(projectId: projectId, ruleId: s.ruleId)
            flash("Adopted \(s.title) — verification starts now")
        } catch { fail(error) }
    }

    private func setSchedule(enabled: Bool?, hour: Int?, windowDays: Int? = nil) async {
        do {
            _ = try await PracticeService.shared.updateConfig(enabled: enabled, hour: hour, windowDays: windowDays)
            await refresh()
        } catch { fail(error) }
    }

    private func resetFindings() async {
        guard let projectId else { return }
        busy = true
        defer { busy = false }
        do {
            view = try await PracticeService.shared.resetFindings(projectId: projectId)
            flash("findings cleared — run the pass to re-read the window")
        } catch { fail(error) }
    }

    /// Something worked. Says so, and gets out of the way on its own.
    private func flash(_ text: String) {
        undoable = nil
        action = nil
        show(PaneNotice(kind: .success, text: text))
    }

    /// Something failed. Stays until dismissed, because it is the message
    /// that mattered — and carries Retry when there is something to retry.
    private func fail(_ error: Error, retry again: (() async -> Void)? = nil) {
        undoable = nil
        action = again
        show(PaneNotice(kind: .error, text: error.localizedDescription))
    }

    private func show(_ n: PaneNotice) {
        withAnimation { notice = n }
        guard case .auto(let seconds) = n.dismissal else { return }
        Task {
            try? await Task.sleep(for: .seconds(seconds))
            withAnimation { if notice == n { notice = nil } }
        }
    }
}

/// Layout probe (CLAUDE.md ▸ "Measure before theorising"). Logs the pane's
/// measured size to the unified log without inserting a view, so the next
/// "the pane broke" report can be answered with numbers:
///   log show --last 10m --predicate 'process == "MARVIN" && eventMessage CONTAINS "[pane-probe]"'
@MainActor struct PaneGeometryProbe: ViewModifier {
    let name: String
    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content.onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .global)
            } action: { frame in
                NSLog("[pane-probe] %@ origin=(%.0f,%.0f) size=(%.0f,%.0f)", name, frame.origin.x, frame.origin.y, frame.size.width, frame.size.height)
            }
        } else {
            content
        }
    }
}

/// The sidecar keys practice data on the registered project id, which is
/// `slugifyWorkDir(workDir)` (projects.ts). Same function, in Swift, so the
/// pane can ask for a project by the path the bridge already holds.
enum ProjectIdSlug {
    static func from(workDir: String) -> String {
        let resolved = (workDir as NSString).standardizingPath
        var out = ""
        var pendingDash = false
        for ch in resolved.dropFirst(resolved.hasPrefix("/") ? 1 : 0) {
            if ch.isASCII && (ch.isLetter || ch.isNumber) {
                if pendingDash { out.append("-"); pendingDash = false }
                out.append(ch.lowercased())
            } else {
                pendingDash = !out.isEmpty || true
            }
        }
        return out.isEmpty ? "default" : out
    }
}

private extension ISO8601DateFormatter {
    static let flexible: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
