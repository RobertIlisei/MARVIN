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
                    case .merge:
                        Button("Merge into my branch") { onAction(c.id, .merge) }
                    case .keepBranch:
                        Button("Keep the branch, close the tab") { onAction(c.id, .keepBranch) }
                    case .discard:
                        Button("Discard the branch", role: .destructive) { onAction(c.id, .discard) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            case .closeNow, .reclaimSilently:
                Button("Close") { onAction(c.id, .keepBranch) }
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
