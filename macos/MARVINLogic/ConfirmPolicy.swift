// ConfirmPolicy — which button a destructive prompt makes the default, which
// actions ask before they run, and when closing a sheet would lose work.
//
// The audit (P1: W2, K1, K2, C2) found four places where the Return key or one
// click did something hard to undo: Return confirmed a `danger` git sheet
// (discard, force-push), "Reject all" restored baselines on disk with no
// question, Esc closed the backlog sheet over an unsaved edit, and one click on
// the posture pill escalated auto → full auto. The decisions live here so they
// can be asserted; the views only draw them.

import Foundation

/// Which button Return activates on a confirmation sheet.
public enum ConfirmDefaultButton: Equatable, Sendable {
    case confirm
    case cancel
}

public enum GitConfirmPolicy {
    /// macOS convention for a destructive sheet: Cancel is the default, so a
    /// stray Return is safe. `warn` and `info` keep Return = confirm, because
    /// there the confirm is the point of the sheet and not the hazard.
    public static func defaultButton(severity: String?) -> ConfirmDefaultButton {
        severity == "danger" ? .cancel : .confirm
    }
}

/// What a Review Changes "reject" is about to revert.
public enum ReviewRejectScope: Equatable, Sendable {
    case all(files: Int)
    case file(path: String)
    case hunk

    /// A single hunk is small, visible on screen and one click from its
    /// neighbour; asking each time would train the user to click through.
    /// A whole file, or every file, is the reach worth a question.
    public var needsConfirmation: Bool {
        switch self {
        case .all, .file: return true
        case .hunk: return false
        }
    }

    public var title: String {
        switch self {
        case .all(let n): return "Reject changes in \(n) file\(n == 1 ? "" : "s")?"
        case .file(let path): return "Reject changes to \((path as NSString).lastPathComponent)?"
        case .hunk: return "Reject this change?"
        }
    }

    public var message: String {
        "MARVIN’s edits are reverted on disk to where they stood before the agent touched them. "
            + "Your own uncommitted edits are kept. This cannot be undone from here."
    }

    public var confirmLabel: String {
        switch self {
        case .all: return "Reject All"
        case .file: return "Reject File"
        case .hunk: return "Reject"
        }
    }
}

/// Esc / Close on a sheet that holds an editable draft.
public enum UnsavedCloseDecision: Equatable, Sendable {
    case close
    case askDiscard

    public static func decide(isDirty: Bool) -> UnsavedCloseDecision {
        isDirty ? .askDiscard : .close
    }
}
