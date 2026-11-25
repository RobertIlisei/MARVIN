// PlansPanel — browse and act on every plan the session has produced
// (ADR-0046 revision list / ADR-0052 durable spine). The tray strip only ever
// shows the ACTIVE plan; this sheet shows all of them, grouped (Active /
// Recent / Older), searchable, and is where the user switches the active
// plan, re-opens a plan file, continues execution, or drops a plan from the
// list.
//
// The plan file under `.marvin/plans/` is the app's projection of the spine
// (ADR-0116): this panel reads it for a modification time and never writes
// it. Grouping, freshness, progress and the step display are decided in
// `MARVINLogic/PlanBrowse.swift`; this draws the result.

import MARVINLogic
import SwiftUI

extension Notification.Name {
    /// Posted by View → Plans (⌥⌘P). Opens the plans panel; the chat view
    /// that owns the session's plans presents it.
    static let marvinRequestPlansPanel = Notification.Name("marvin.requestPlansPanel")
}

@MainActor struct PlansPanel: View {
    let plans: [Plan]
    let activePlanId: String?
    /// Make this plan active (focuses its file too — model.selectPlan).
    let onSelect: (String) -> Void
    /// Re-open the ACTIVE plan's saved markdown in the editor.
    let onOpenFile: () -> Void
    /// Resume executing the ACTIVE plan (ADR-0050 anchored continue).
    let onContinue: () -> Void
    /// Remove a plan from the session list (does not delete its file).
    let onRemove: (String) -> Void
    let onClose: () -> Void
    /// When each plan last changed, by id. Empty = read the plan file's
    /// modification time. A fixture can pass dates instead of files.
    var updatedAt: [String: Date] = [:]

    @State private var query = ""
    @State private var expandedToggled: Set<String> = []
    @AppStorage("marvin.plans.folded") private var foldedRaw = ""
    @FocusState private var searchFocused: Bool

    private func updated(_ plan: Plan) -> Date? {
        if let d = updatedAt[plan.id] { return d }
        guard let path = plan.path,
              let attrs = try? FileManager.default.attributesOfItem(atPath: path) else { return nil }
        return attrs[.modificationDate] as? Date
    }

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "Plans", symbol: "map", uppercase: false, subtitle: subtitle) {
                Button(action: onClose) { Image(systemName: "xmark") }
                    .paneIconButton(10)
                    .help("Close (Esc)")
                    .accessibilityLabel("Close the plans")
            }
            MarvinDivider()
            if !plans.isEmpty {
                HStack(spacing: 8) {
                    PaneSearchField(text: $query, prompt: "Search plans", width: nil, focus: $searchFocused)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                MarvinDivider()
            }
            content
        }
        .frame(minWidth: 560, idealWidth: 680, maxWidth: .infinity,
               minHeight: 380, idealHeight: 560, maxHeight: .infinity)
        .background(MarvinTheme.panel)
        .background(PaneWindowMemory(key: "marvin.plans.windowSize", minWidth: 560, minHeight: 380))
        .background {
            VStack {
                Button("Search") { searchFocused = true }.keyboardShortcut("f", modifiers: .command)
                Button("Close") { onClose() }.keyboardShortcut("w", modifiers: .command)
                Button("Close") { onClose() }.keyboardShortcut(.cancelAction)
            }
            .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
        }
    }

    private var subtitle: String? {
        guard !plans.isEmpty else { return nil }
        let open = plans.filter { !$0.isComplete }.count
        return open > 0 ? "\(plans.count) · \(open) unfinished" : "\(plans.count)"
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        let sections = PlanBrowse.sections(plans, activeId: activePlanId, updated: updated(_:), query: query)
        if plans.isEmpty {
            PaneEmptyView(state: PaneEmptyState(
                headline: "No plans this session",
                hint: "Present a plan in Plan mode (or ask for one) and it appears here.",
                symbol: "map"))
                .frame(maxHeight: .infinity)
        } else if sections.isEmpty {
            PaneEmptyView(
                state: PaneEmptyState(
                    headline: "No results for “\(query.trimmingCharacters(in: .whitespaces))”",
                    hint: "Plans match on their title or the text of a step.",
                    symbol: "magnifyingglass"),
                actionTitle: "Clear Search", action: { query = "" })
                .frame(maxHeight: .infinity)
        } else {
            let now = Date()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(sections) { section in
                        // A search shows its matches; it never hides them in a folded group.
                        let folded = query.isEmpty && isFolded(section.kind)
                        Button { toggleFold(section.kind) } label: {
                            PaneSectionHeader(section.kind.title, count: section.plans.count, collapsed: folded)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(section.kind.title), \(section.plans.count) plans, \(folded ? "folded" : "unfolded")")
                        if !folded {
                            ForEach(section.plans) { plan in
                                PlanRowCard(
                                    plan: plan,
                                    isActive: plan.id == activePlanId,
                                    updated: updated(plan),
                                    now: now,
                                    expanded: PlanBrowse.startsExpanded(plan, isActive: plan.id == activePlanId)
                                        != expandedToggled.contains(plan.id),
                                    onToggle: { toggle(plan.id) },
                                    onSelect: { onSelect(plan.id) },
                                    onOpenFile: onOpenFile,
                                    onContinue: { onContinue(); onClose() },
                                    onRemove: { onRemove(plan.id) })
                            }
                        }
                    }
                }
                .padding(.bottom, 12)
            }
        }
    }

    private func toggle(_ id: String) {
        MarvinMotion.with(.easeOut(duration: 0.15)) {
            if expandedToggled.contains(id) { expandedToggled.remove(id) } else { expandedToggled.insert(id) }
        }
    }

    private func isFolded(_ kind: PlanGroupKind) -> Bool {
        BrowseDisclosure(raw: foldedRaw).isCollapsed("plans:\(kind.rawValue)", defaultCollapsed: kind.startsCollapsed)
    }

    private func toggleFold(_ kind: PlanGroupKind) {
        var d = BrowseDisclosure(raw: foldedRaw)
        d.toggle("plans:\(kind.rawValue)", defaultCollapsed: kind.startsCollapsed)
        foldedRaw = d.raw
    }
}

/// One plan: a line (title, progress, freshness, one action, a menu) and,
/// when open, its steps. A finished plan is just the line.
@MainActor private struct PlanRowCard: View {
    let plan: Plan
    let isActive: Bool
    let updated: Date?
    let now: Date
    let expanded: Bool
    let onToggle: () -> Void
    let onSelect: () -> Void
    let onOpenFile: () -> Void
    let onContinue: () -> Void
    let onRemove: () -> Void

    @State private var hovering = false

    private var stale: Bool { PlanFreshness.isStale(updated: updated, complete: plan.isComplete, now: now) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                Button(action: onToggle) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 14, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "Fold the steps of \(plan.title)" : "Show the steps of \(plan.title)")
                Image(systemName: plan.isComplete ? "checkmark.seal.fill" : "map")
                    .font(.system(size: 11))
                    .foregroundStyle(plan.isComplete ? Color.green : Color.purple)
                    .accessibilityLabel(plan.isComplete ? "Finished" : "Plan")
                VStack(alignment: .leading, spacing: 2) {
                    Text(plan.title)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(expanded ? 2 : 1)
                        .truncationMode(.tail)
                        .help(plan.title)
                    if !plan.steps.isEmpty {
                        HStack(spacing: 8) {
                            PlanProgressMeter(done: plan.doneCount, total: plan.steps.count, tint: .purple)
                            if let label = PlanFreshness.label(updated: updated, now: now) {
                                HStack(spacing: 3) {
                                    if stale {
                                        Image(systemName: "clock.badge.exclamationmark")
                                            .foregroundStyle(.orange)
                                            .accessibilityLabel("Stale")
                                    }
                                    Text(label)
                                }
                                .font(.system(size: 10.5))
                                .foregroundStyle(stale ? Color.orange : MarvinTheme.textMuted)
                                .help(stale ? "Unfinished and untouched for a while — its tab may have stopped." : "")
                            }
                        }
                    }
                }
                Spacer(minLength: 6)
                trailing
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                    .fill(isActive ? Color.purple.opacity(0.08) : (hovering ? MarvinTheme.rowHover : .clear))
            )
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .onTapGesture(perform: onToggle)

            if expanded {
                if plan.steps.isEmpty {
                    Text("This plan has no tracked steps yet.")
                        .font(.system(size: 11)).foregroundStyle(.tertiary).padding(.leading, 36)
                } else {
                    PlanStepsView(steps: plan.steps, tint: .purple)
                        .padding(.leading, 20)
                        .padding(.trailing, 14)
                        .padding(.bottom, 6)
                }
            }
        }
    }

    /// One visible action; the rest in the menu.
    @ViewBuilder private var trailing: some View {
        HStack(spacing: 4) {
            if isActive {
                Text("active")
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(.purple)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Color.purple.opacity(0.15)))
            }
            if isActive && !plan.isComplete {
                Button("Continue", action: onContinue).rowChip(.primary)
                    .help("Resume executing this plan")
            } else if !isActive {
                Button("Make active", action: onSelect).rowChip(.neutral)
                    .help("Make this the plan the tab works from")
            }
            Menu {
                if isActive { Button("Open plan file", action: onOpenFile) }
                Button("Remove from list", role: .destructive, action: onRemove)
            } label: {
                Image(systemName: "ellipsis").frame(width: 20, height: 16)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("More: open the plan file, remove from the list")
            .accessibilityLabel("More actions for \(plan.title)")
        }
    }
}
