// PlanStepRows — the step list and the progress bar every plan surface shares:
// the Plans panel, the tray checklist, and (through `PlanProgressMeter`) the
// plan card.
//
// What a step looks like is decided in `MARVINLogic/PlanBrowse.swift`: its
// state is a glyph AND a word (never colour alone), a long step shows its
// lead with the whole text one click away, and a `superseded` step
// (ADR-0106) wears its own glyph and the word "superseded" so it can never be
// read as done. Sub-steps nest under their step and fold; a finished step's
// sub-steps start folded.
//
// This only DISPLAYS a plan. The file under `.marvin/plans/` is the app's
// projection (ADR-0052 / ADR-0116) and nothing here writes it.

import MARVINLogic
import SwiftUI

/// "3 / 12" and a quiet bar. The bar is a scaled capsule, not a geometry
/// measurement — no view is inserted to learn a width.
@MainActor struct PlanProgressMeter: View {
    let done: Int
    let total: Int
    var tint: Color = .accentColor
    var barWidth: CGFloat = 56

    var body: some View {
        HStack(spacing: 6) {
            Text(PlanProgressText.text(done: done, total: total))
                .font(.system(size: 10.5).monospacedDigit())
                .foregroundStyle(MarvinTheme.textMuted)
                .fixedSize()
            Capsule()
                .fill(Color.secondary.opacity(0.28))
                .frame(width: barWidth, height: 3)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(tint.opacity(0.7))
                        .scaleEffect(x: max(PlanProgressText.fraction(done: done, total: total), done > 0 ? 0.04 : 0),
                                     anchor: .leading)
                }
                .clipShape(Capsule())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(done) of \(total) steps done")
    }
}

/// One state glyph with its word as the accessible label.
@MainActor struct PlanStateGlyph: View {
    let state: PlanStepState
    var tint: Color = .accentColor
    var size: CGFloat = 11

    var body: some View {
        Image(systemName: state.glyph)
            .font(.system(size: size))
            .foregroundStyle(color)
            .frame(width: size + 3)
            .help(state.word)
            .accessibilityLabel(state.word)
    }

    private var color: Color {
        switch state {
        case .completed: return .green
        case .inProgress: return tint
        case .pending, .superseded: return MarvinTheme.textMuted
        }
    }
}

/// A plan's steps, each with its sub-steps nested and foldable.
@MainActor struct PlanStepsView: View {
    let steps: [PlanStep]
    /// Show only this many steps, with a "Show all N" below. nil = all.
    var limit: Int? = nil
    var tint: Color = .purple
    var compact = false

    @State private var showAll = false
    /// Steps whose whole text is showing instead of the lead.
    @State private var textOpen: Set<String> = []
    /// Steps whose sub-steps were toggled away from their default.
    @State private var subsToggled: Set<String> = []

    private var shown: [PlanStep] {
        guard let limit, !showAll else { return steps }
        return Array(steps.prefix(limit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 2 : 3) {
            ForEach(shown) { step in
                stepRow(step)
                if !step.subtasks.isEmpty && subsOpen(step) {
                    ForEach(Array(step.subtasks.enumerated()), id: \.offset) { i, sub in
                        subRow(sub, id: "\(step.id)#\(i)")
                    }
                }
            }
            if let limit, steps.count > limit {
                Button(showAll ? "Show fewer" : "Show all \(steps.count)") {
                    MarvinMotion.with(.easeOut(duration: 0.15)) { showAll.toggle() }
                }
                .buttonStyle(.plain)
                .font(.system(size: 10))
                .foregroundStyle(tint)
                .padding(.leading, 28)
            }
        }
    }

    private func subsOpen(_ step: PlanStep) -> Bool {
        PlanBrowse.subStepsStartOpen(step) != subsToggled.contains(step.id)
    }

    private func stepRow(_ step: PlanStep) -> some View {
        let state = PlanStepState(status: step.status)
        let full = state == .inProgress ? (step.activeForm ?? step.content) : step.content
        let open = textOpen.contains(step.id)
        let sub = PlanProgressText.sub(step)
        return HStack(alignment: .firstTextBaseline, spacing: 4) {
            // Disclosure for the sub-steps, in the same column on every row.
            if step.subtasks.isEmpty {
                Color.clear.frame(width: 12, height: 1)
            } else {
                Button { toggleSubs(step.id) } label: {
                    Image(systemName: subsOpen(step) ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 12)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(subsOpen(step) ? "Fold sub-steps" : "Show sub-steps")
            }
            PlanStateGlyph(state: state, tint: tint, size: compact ? 11 : 12)
            stepText(full, id: step.id, open: open, state: state, size: compact ? 11 : 12,
                     weight: state == .inProgress ? .semibold : .regular)
            Spacer(minLength: 0)
            if !step.subtasks.isEmpty, sub.total > 0 {
                Text("\(sub.done)/\(sub.total)")
                    .font(.system(size: 10).monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .help("Sub-steps done")
            }
        }
    }

    private func subRow(_ sub: TodoItem, id: String) -> some View {
        let state = PlanStepState(status: sub.status)
        let full = state == .inProgress ? (sub.activeForm ?? sub.content) : sub.content
        return HStack(alignment: .firstTextBaseline, spacing: 4) {
            PlanStateGlyph(state: state, tint: tint, size: 10)
            stepText(full, id: id, open: textOpen.contains(id), state: state, size: 10.5, weight: .regular)
            Spacer(minLength: 0)
        }
        .padding(.leading, 34)
    }

    /// The lead, or the whole text once asked for. A superseded step is struck
    /// through AND tagged — the tag is what says it was not done.
    @ViewBuilder
    private func stepText(_ full: String, id: String, open: Bool, state: PlanStepState,
                          size: CGFloat, weight: Font.Weight) -> some View {
        let more = PlanStepDisplay.hasMore(full)
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(open ? PlanStepDisplay.full(full) : PlanStepDisplay.lead(full))
                .font(.system(size: size, weight: weight))
                .strikethrough(state == .superseded, color: .secondary)
                .foregroundStyle(state.isClosed ? MarvinTheme.textMuted : MarvinTheme.textPrimary)
                .lineLimit(open ? nil : 2)
                .fixedSize(horizontal: false, vertical: open)
                .help(PlanStepDisplay.full(full))
            if state == .superseded {
                Text("superseded")
                    .font(.system(size: 9.5))
                    .foregroundStyle(MarvinTheme.textMuted)
                    .padding(.horizontal, 4)
                    .background(RoundedRectangle(cornerRadius: MarvinTheme.Radius.badge).fill(Color.secondary.opacity(0.22)))
                    .fixedSize()
            }
            if more {
                Button(open ? "less" : "more") {
                    if open { textOpen.remove(id) } else { textOpen.insert(id) }
                }
                .buttonStyle(.plain)
                .font(.system(size: 10))
                .foregroundStyle(tint)
                .fixedSize()
                .accessibilityLabel(open ? "Show the lead only" : "Show the whole step")
            }
        }
    }

    private func toggleSubs(_ id: String) {
        MarvinMotion.with(.easeOut(duration: 0.15)) {
            if subsToggled.contains(id) { subsToggled.remove(id) } else { subsToggled.insert(id) }
        }
    }
}
