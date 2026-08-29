// PlansPanel — browse and act on every plan the session has produced
// (ADR-0046 revision list / ADR-0052 durable spine). The tray strip
// only ever shows the ACTIVE plan; this sheet shows all of them with
// their full step lists and statuses, and is where the user switches
// the active plan, re-opens a plan file, continues execution, or drops
// a stale plan from the list. Mirrors BacklogPanel's sheet conventions.

import MARVINLogic
import SwiftUI

struct PlansPanel: View {
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            MarvinDivider()
            content
        }
        .frame(minWidth: 560, idealWidth: 640, minHeight: 380, idealHeight: 520)
    }

    private var header: some View {
        HStack {
            Image(systemName: "map")
            Text("Session plans").font(.headline)
            if !plans.isEmpty {
                Text("\(plans.count)")
                    .font(.caption.monospacedDigit())
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Color.purple.opacity(0.15), in: Capsule())
            }
            Spacer()
            Button("Close") { onClose() }
                .keyboardShortcut(.escape, modifiers: [])
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    @ViewBuilder private var content: some View {
        if plans.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "map").font(.title2).foregroundStyle(.secondary)
                Text("No plans this session.").font(.callout).foregroundStyle(.secondary)
                Text("Present a plan in Plan mode (or ask for one) and it appears here.")
                    .font(.caption).foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(plans) { plan in planRow(plan) }
                }
                .padding(12)
            }
        }
    }

    private func planRow(_ plan: Plan) -> some View {
        let isActive = plan.id == activePlanId
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: plan.isComplete ? "checkmark.seal.fill" : "map")
                    .foregroundStyle(plan.isComplete ? .green : .purple)
                Text(plan.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(2)
                Text("\(plan.doneCount)/\(plan.steps.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                if isActive {
                    Text("active")
                        .font(.caption2)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.purple.opacity(0.15), in: Capsule())
                }
                Spacer()
            }
            DisclosureGroup(isActive ? "Steps" : "Steps (\(plan.steps.count))") {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(plan.steps) { step in stepRow(step) }
                }
                .padding(.top, 4)
            }
            .font(.caption)
            HStack(spacing: 8) {
                if !isActive {
                    Button("Set active") { onSelect(plan.id) }
                }
                if isActive {
                    Button("Open plan file") { onOpenFile() }
                    if !plan.isComplete {
                        Button("Continue") { onContinue(); onClose() }
                    }
                }
                Button("Remove from list") { onRemove(plan.id) }
                Spacer()
            }
            .controlSize(.small)
        }
        .padding(10)
        .background(
            (isActive ? Color.purple.opacity(0.06) : Color(nsColor: .controlBackgroundColor).opacity(0.5)),
            in: RoundedRectangle(cornerRadius: 6)
        )
    }

    private func stepRow(_ step: PlanStep) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: statusIcon(step.status))
                    .font(.system(size: 10))
                    .foregroundStyle(statusColor(step.status))
                Text(step.content)
                    .font(.system(size: 11))
                    .strikethrough(step.status == "completed", color: .secondary)
                    .foregroundStyle(step.status == "completed" ? .secondary : .primary)
            }
            ForEach(step.subtasks, id: \.content) { sub in
                HStack(spacing: 6) {
                    Image(systemName: statusIcon(sub.status))
                        .font(.system(size: 9))
                        .foregroundStyle(statusColor(sub.status))
                    Text(sub.content)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                .padding(.leading, 18)
            }
        }
    }

    private func statusIcon(_ s: String) -> String {
        switch s {
        case "completed": return "checkmark.circle.fill"
        case "in_progress": return "circle.dotted.circle"
        default: return "circle"
        }
    }
    private func statusColor(_ s: String) -> Color {
        switch s {
        case "completed": return .green
        case "in_progress": return .orange
        default: return .secondary
        }
    }
}
