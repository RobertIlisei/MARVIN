// PlanPauseBannerView — the tray row under an idle plan with steps left.
//
// Split out of `ChatPreviewView.continuePlanChip` so the snapshot harness can
// mount both states without a session. Which state it is comes from
// `MARVINLogic.PlanPauseBanner`: "Paused" with Continue when only the user
// resumes the tab, "Waiting on a background job" with no Continue when a
// running job's exit will (ADR-0038) — pressing Continue there started a
// second turn on top of that wake (2026-10-31).

import MARVINLogic
import SwiftUI

@MainActor struct PlanPauseBannerView: View {
    let state: PlanPauseBanner
    let done: Int
    let total: Int
    /// "Next: …" — the first unfinished step; nil when there is none.
    let next: String?
    /// What there is to review while paused; unused while waiting.
    let reviewDetail: String?
    let continueDisabled: Bool
    let onContinue: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: waiting == nil ? "pause.circle.fill" : "hourglass")
                .font(.system(size: 11))
                .foregroundStyle(.purple)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(waiting == nil ? "Paused — \(done)/\(total) steps done"
                                    : "Waiting on a background job — \(done)/\(total) steps done")
                    .font(.system(size: 11, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if let w = waiting {
                    Text(w.name)
                        .font(.system(size: 11))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let next {
                    Text("Next: \(next)")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let detail = waiting?.detail ?? reviewDetail {
                    Text(detail)
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            if waiting == nil {
                Button {
                    onContinue()
                } label: {
                    Label("Continue", systemImage: "arrow.right.circle.fill")
                        .font(.system(size: 11))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(continueDisabled)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.purple.opacity(0.07))
    }

    private var waiting: (name: String, detail: String)? {
        if case .waitingOnJob(let name, let detail) = state { return (name, detail) }
        return nil
    }
}
