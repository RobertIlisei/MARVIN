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

import SwiftUI

struct PracticePane: View {
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
    @State private var toast: String?
    @State private var dismissing: PracticeFinding?
    @State private var dismissReason = ""
    @State private var showConfirmed = false

    private var projectId: String? {
        bridge.projectWorkDir.map { ProjectIdSlug.from(workDir: $0) }
    }

    var body: some View {
        VStack(spacing: 0) {
            if projectId == nil {
                emptyView("Open a project to see what its sessions keep repeating.")
            } else if let err = loadError, view == nil {
                emptyView(err)
            } else {
                content
            }
            if let toast {
                HStack {
                    Image(systemName: "moon.zzz.fill")
                    Text(toast).font(.caption).lineLimit(2)
                    Spacer()
                }
                .padding(8)
                .background(.tint.opacity(0.12))
                .transition(.opacity)
            }
        }
        .task(id: bridge.projectWorkDir) { await refresh() }
        .sheet(item: $dismissing) { finding in dismissSheet(finding) }
        .modifier(PaneGeometryProbe(name: "PracticePane"))
    }

    // MARK: - Content
    //
    // The SAME shape as PluginsPane / SkillsPane: a ScrollView is the root and
    // everything — header, tabs, rows — lives inside its LazyVStack. The first
    // version put the header and the segmented picker OUTSIDE the scroll view
    // in a VStack; the pane then laid out taller and wider than its slot and
    // pushed the icon rail off the window (user, 2026-09-03: "clicking the new
    // pane still breaks the whole marvin UI"). A ScrollView root is flexible in
    // both axes and cannot overflow the slot; the probe above records the
    // measured sizes so the next layout report is numbers, not a reading.

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                header
                Picker("", selection: $section) {
                    ForEach(Section.allCases) { s in
                        Text(sectionLabel(s)).tag(s)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                switch section {
                case .findings: findingsSection
                case .working: workingSection
                case .rules: rulesSection
                case .runs: runsSection
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
    }

    private func sectionLabel(_ s: Section) -> String {
        guard let view else { return s.label }
        switch s {
        case .findings:
            let n = view.findings.filter { !$0.isSuccess && $0.state != "dismissed" && $0.state != "confirmed" }.count
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

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "moon.zzz").foregroundStyle(.tint)
                Text("Practice").font(.headline)
                Spacer()
                Button { Task { await runNow(force: false) } } label: {
                    Label("Run now", systemImage: "play.circle")
                }
                .help("Read every session that changed since the last run and update the findings (ADR-0105).")
                .disabled(busy)
                Button { Task { await runNow(force: true) } } label: {
                    Label("Backtest", systemImage: "clock.arrow.circlepath")
                }
                .help("Re-read every transcript from scratch. This is how the weights get tuned: rank what actually cost the most.")
                .disabled(busy)
                Button { Task { await refresh() } } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
                .labelStyle(.iconOnly)
                .disabled(busy)
            }
            Text("Repeat failures mined from this project's own sessions, next to the same acts done right. It proposes, you approve, and an accepted rule is enforced at the tier you choose — then measured.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let view {
                HStack(spacing: 10) {
                    Toggle(isOn: Binding(
                        get: { view.config.enabled },
                        set: { on in Task { await setSchedule(enabled: on, hour: nil) } }
                    )) { Text("Nightly").font(.caption) }
                    .toggleStyle(.switch).controlSize(.mini)
                    Stepper(value: Binding(
                        get: { view.config.hour },
                        set: { h in Task { await setSchedule(enabled: nil, hour: h) } }
                    ), in: 0...23) {
                        Text(String(format: "at %02d:00", view.config.hour)).font(.caption.monospaced())
                    }
                    .controlSize(.mini)
                    Spacer(minLength: 0)
                }
                Text(view.lastRun.map { "last run \(Self.relative($0.at)) · \($0.sessionsRead) read · \($0.proposed) proposed" } ?? "never run")
                    .font(.caption2.monospaced()).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Findings

    @ViewBuilder
    private var findingsSection: some View {
        if let view {
            let failures = view.findings.filter { !$0.isSuccess }
            let live = failures.filter { $0.state != "confirmed" && $0.state != "dismissed" }
            let done = failures.filter { $0.state == "confirmed" || $0.state == "dismissed" }
            if failures.isEmpty {
                Text(view.lastRun == nil
                     ? "Nothing yet — run the pass to read this project's sessions."
                     : "No repeat failures found. Either the sessions are clean or there are fewer than three of them.")
                    .font(.caption).foregroundStyle(.tertiary).padding(.vertical, 6)
            }
            ForEach(live) { f in findingRow(f) }
            if !done.isEmpty {
                DisclosureGroup(isExpanded: $showConfirmed) {
                    ForEach(done) { f in findingRow(f) }
                } label: {
                    Text("\(done.count) confirmed or dismissed").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var workingSection: some View {
        if let view {
            let wins = view.findings.filter { $0.isSuccess }
            if wins.isEmpty {
                Text("No confirmed practices yet. A success needs three sessions to count.")
                    .font(.caption).foregroundStyle(.tertiary).padding(.vertical, 6)
            }
            Text("The same acts done right. These are the denominator for every rate on the Findings tab and the evidence that a rule held.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(wins) { f in findingRow(f) }
        }
    }

    private func findingRow(_ f: PracticeFinding) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                stateChip(f.state)
                Text(f.id).font(.caption.monospaced().bold())
                Spacer()
                Text(String(format: "%.2f", f.value))
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                    .help("Value: recurrence, cost, rate, reliability, actionability, minus decay (ADR-0105 §3).")
            }
            Text(f.latestDetail.isEmpty ? "—" : f.latestDetail)
                .font(.caption).foregroundStyle(.secondary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            Text(metaLine(f))
                .font(.caption2.monospaced()).foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
            if !f.isSuccess { findingActions(f) }
            if let reason = f.dismissReason, f.state == "dismissed" {
                Text("dismissed: \(reason)").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.06)))
    }

    private func metaLine(_ f: PracticeFinding) -> String {
        var parts = ["\(f.distinctSessions) session\(f.distinctSessions == 1 ? "" : "s")"]
        if let rate = f.rate { parts.append(String(format: "%.0f%% of the time", rate * 100)) }
        parts.append("\(Self.compact(f.costTotal)) \(f.unit)")
        if let after = f.sessionsAfter, let rec = f.recurrenceAfter, f.ruleId != nil {
            parts.append("\(rec) of \(after) since rule")
        }
        parts.append("last \(Self.relative(f.lastSeen))")
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func findingActions(_ f: PracticeFinding) -> some View {
        HStack(spacing: 8) {
            switch f.state {
            case "proposed", "observed":
                if f.template {
                    Menu {
                        Button("Approve at the template tier") { Task { await approve(f, tier: nil, global: false) } }
                        Button("Approve as prompt") { Task { await approve(f, tier: "prompt", global: false) } }
                        Button("Approve as nudge") { Task { await approve(f, tier: "nudge", global: false) } }
                        Button("Approve as deny") { Task { await approve(f, tier: "deny", global: false) } }
                        Divider()
                        Button("Approve for every project") { Task { await approve(f, tier: nil, global: true) } }
                    } label: {
                        Label("Approve", systemImage: "checkmark.circle")
                    }
                    .menuStyle(.borderlessButton).fixedSize()
                    .disabled(busy || f.state == "observed")
                    .help(f.state == "observed" ? "Under the proposal threshold — needs more sessions." : "Create a rule from this finding.")
                } else {
                    Text("report only — about MARVIN itself, not a behaviour a rule can change")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                Button("Dismiss") { dismissReason = ""; dismissing = f }
                    .buttonStyle(.link).font(.caption).disabled(busy)
            case "report":
                Text("report only — about MARVIN itself, not a behaviour a rule can change")
                    .font(.caption2).foregroundStyle(.tertiary)
                Button("Dismiss") { dismissReason = ""; dismissing = f }
                    .buttonStyle(.link).font(.caption).disabled(busy)
            case "regressed":
                Button { Task { await escalate(f) } } label: {
                    Label("Escalate tier", systemImage: "arrow.up.circle")
                }
                .help("The rule is not holding. Move it one tier up and restart verification.")
                .disabled(busy)
                Button("Dismiss") { dismissReason = ""; dismissing = f }
                    .buttonStyle(.link).font(.caption).disabled(busy)
            default:
                EmptyView()
            }
        }
    }

    // MARK: - Rules

    @ViewBuilder
    private var rulesSection: some View {
        if let view {
            if view.rules.isEmpty {
                Text("No rules yet. Approve a finding to create one.")
                    .font(.caption).foregroundStyle(.tertiary).padding(.vertical, 6)
            }
            ForEach(view.rules) { r in ruleRow(r) }
        }
    }

    private func ruleRow(_ r: PracticeRule) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                tierChip(r.tier)
                Text(r.title).font(.caption.bold())
                if r.isGlobal {
                    Text("global").font(.caption2).padding(.horizontal, 4)
                        .background(Capsule().fill(Color.secondary.opacity(0.15)))
                }
                if r.status == "retired" {
                    Text("retired").font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer()
                Text(r.fingerprint).font(.caption2.monospaced()).foregroundStyle(.tertiary)
            }
            Text(r.message).font(.caption).foregroundStyle(.secondary)
                .lineLimit(4).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Text("fired \(r.metrics.fired)\(r.metrics.bypasses > 0 ? " · bypassed \(r.metrics.bypasses)" : "") · accepted \(Self.relative(r.acceptedAt))")
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if r.status == "active" {
                    Menu {
                        Button("Tier: prompt") { Task { await setRule(r, tier: "prompt") } }
                        Button("Tier: nudge") { Task { await setRule(r, tier: "nudge") } }
                        Button("Tier: deny") { Task { await setRule(r, tier: "deny") } }
                        Divider()
                        if !r.isGlobal { Button("Promote to every project") { Task { await setRule(r, global: true) } } }
                        Button("Retire", role: .destructive) { Task { await setRule(r, status: "retired") } }
                    } label: { Label("Edit", systemImage: "slider.horizontal.3") }
                    .menuStyle(.borderlessButton).fixedSize().disabled(busy)
                } else {
                    Button("Reactivate") { Task { await setRule(r, status: "active") } }
                        .buttonStyle(.link).font(.caption).disabled(busy)
                }
            }
            .font(.caption2.monospaced()).foregroundStyle(.tertiary)
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.06)))
    }

    // MARK: - Runs

    @ViewBuilder
    private var runsSection: some View {
        if let view {
            if view.runs.isEmpty {
                Text("No runs yet.").font(.caption).foregroundStyle(.tertiary).padding(.vertical, 6)
            }
            ForEach(view.runs) { run in
                Text("\(Self.relative(run.at)) · \(run.trigger) · \(run.sessionsRead) read · \(run.findingsNew) new · \(run.recurring) recurring · \(run.proposed) proposed" +
                     (run.regressed > 0 ? " · \(run.regressed) regressed" : "") +
                     (run.confirmed > 0 ? " · \(run.confirmed) confirmed" : "") +
                     " · \(run.durationMs) ms")
                    .font(.caption2.monospaced()).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Sheets

    private func dismissSheet(_ f: PracticeFinding) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Dismiss \(f.id)").font(.headline)
            Text("It stays quiet until it has been seen in twice as many sessions as now (\(f.distinctSessions * 2)). The reason is kept with it.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
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

    // MARK: - Chips + helpers

    private func stateChip(_ state: String) -> some View {
        let color: Color = switch state {
        case "proposed": .orange
        case "active": .blue
        case "regressed": .red
        case "confirmed", "practice": .green
        case "dismissed": .gray
        case "report": .purple
        default: .secondary
        }
        return Text(state).font(.caption2.bold())
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.18)))
            .foregroundStyle(color)
    }

    private func tierChip(_ tier: String) -> some View {
        let color: Color = switch tier {
        case "deny": .red
        case "nudge": .orange
        default: .secondary
        }
        return Text(tier).font(.caption2.bold())
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.18)))
            .foregroundStyle(color)
    }

    private func emptyView(_ text: String) -> some View {
        VStack {
            Spacer()
            Text(text).font(.caption).foregroundStyle(.tertiary).multilineTextAlignment(.center).padding()
            Spacer()
        }
        .frame(maxWidth: .infinity)
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
        } catch { flash(error.localizedDescription) }
    }

    private func approve(_ f: PracticeFinding, tier: String?, global: Bool) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do {
            view = try await PracticeService.shared.approve(projectId: projectId, id: f.id, tier: tier, global: global)
            flash("Rule created for \(f.id)")
        } catch { flash(error.localizedDescription) }
    }

    private func dismiss(_ f: PracticeFinding, reason: String) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do { view = try await PracticeService.shared.dismiss(projectId: projectId, id: f.id, reason: reason) }
        catch { flash(error.localizedDescription) }
    }

    private func escalate(_ f: PracticeFinding) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do {
            view = try await PracticeService.shared.escalate(projectId: projectId, id: f.id)
            flash("Escalated \(f.id)")
        } catch { flash(error.localizedDescription) }
    }

    private func setRule(_ r: PracticeRule, tier: String? = nil, status: String? = nil, global: Bool? = nil) async {
        guard let projectId else { return }
        busy = true; defer { busy = false }
        do { view = try await PracticeService.shared.updateRule(projectId: projectId, id: r.id, tier: tier, status: status, global: global) }
        catch { flash(error.localizedDescription) }
    }

    private func setSchedule(enabled: Bool?, hour: Int?) async {
        do {
            _ = try await PracticeService.shared.updateConfig(enabled: enabled, hour: hour)
            await refresh()
        } catch { flash(error.localizedDescription) }
    }

    private func flash(_ text: String) {
        withAnimation { toast = text }
        Task {
            try? await Task.sleep(for: .seconds(4))
            withAnimation { if toast == text { toast = nil } }
        }
    }
}

/// Layout probe (CLAUDE.md ▸ "Measure before theorising"). Logs the pane's
/// measured size to the unified log without inserting a view, so the next
/// "the pane broke" report can be answered with numbers:
///   log show --last 10m --predicate 'process == "MARVIN" && eventMessage CONTAINS "[pane-probe]"'
struct PaneGeometryProbe: ViewModifier {
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
