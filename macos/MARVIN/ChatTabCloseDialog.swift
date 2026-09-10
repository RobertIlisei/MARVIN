// ChatTabCloseDialog — what to do with an isolated tab's worktree when the
// tab closes (ADR-0107). Kept out of ChatPreviewView.swift so that file does
// not grow another modal; the decision itself is `TabCloseDecision` in
// MARVINLogic and is pinned by tests.

import MARVINLogic
import SwiftUI

struct TabCloseChoice: Identifiable, Equatable {
    let id: String              // marvinSessionId
    let outcome: TabCloseDecision.Outcome
    let branch: String?
    /// ADR-0111 — the branch a merge would land on, named on the button.
    var target: String? = nil
}

extension View {
    /// A confirmation dialog for `choice`. `onAction` receives the picked
    /// worktree action (nil for "stop the turn first" / cancel paths).
    func tabCloseDialog(
        choice: Binding<TabCloseChoice?>,
        onStop: @escaping (String) -> Void,
        onAction: @escaping (String, TabCloseDecision.Action) -> Void
    ) -> some View {
        confirmationDialog(
            titleFor(choice.wrappedValue),
            isPresented: Binding(get: { choice.wrappedValue != nil }, set: { if !$0 { choice.wrappedValue = nil } }),
            titleVisibility: .visible,
            presenting: choice.wrappedValue
        ) { c in
            switch c.outcome {
            case .stopTurnFirst:
                Button("Stop the turn") { onStop(c.id) }
                Button("Cancel", role: .cancel) {}
            case .offer(let actions, _):
                ForEach(actions, id: \.rawValue) { action in
                    switch action {
                    case .keepBranch:
                        Button("Keep for integration") { onAction(c.id, .keepBranch) }
                    case .merge:
                        Button("Merge into \(c.target ?? "my branch")") { onAction(c.id, .merge) }
                    case .discard:
                        Button("Discard the branch", role: .destructive) { onAction(c.id, .discard) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            case .closeNow:
                Button("Close") { onAction(c.id, .keepBranch) }
                Button("Cancel", role: .cancel) {}
            case .reclaimSilently:
                // Not normally presented (the caller discards without asking);
                // if it is, the honest button is the discard.
                Button("Close and discard the empty branch") { onAction(c.id, .discard) }
                Button("Cancel", role: .cancel) {}
            }
        } message: { c in
            switch c.outcome {
            case .stopTurnFirst:
                Text("This tab has a turn running. Stop it before closing.")
            case .offer(_, let note):
                Text(note)
            default:
                Text("")
            }
        }
    }

    private func titleFor(_ c: TabCloseChoice?) -> String {
        guard let c else { return "" }
        switch c.outcome {
        case .stopTurnFirst: return "Stop the running turn?"
        case .offer: return "Close tab — what about \(c.branch ?? "its worktree")?"
        default: return "Close tab"
        }
    }
}
