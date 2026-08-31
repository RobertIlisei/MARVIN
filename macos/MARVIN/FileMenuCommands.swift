// FileMenuCommands — the notification surface between `CommandRegistry`
// (which owns no state) and the views that hold the editor's state.
//
// `FileViewerModel` and `FileTreeView`'s sheet state are `@State` inside
// their views, which is correct — they are view state, and hoisting them
// into a singleton so a menu item could reach them would be the tail
// wagging the dog. A notification is the smaller price: the command posts,
// the view that owns the state acts.
//
// The alternative considered and rejected was the AppKit responder chain
// (`NSApp.sendAction`). It works for commands aimed at the focused text
// view — `EditorCommands` uses exactly that — but Save All and Revert are
// aimed at a SwiftUI view that is not in the responder chain at all.

import AppKit
import Foundation

extension Notification.Name {
    /// Posted by File-menu commands; observed by `FileViewerView`, which
    /// owns the buffers. `userInfo["command"]` is a `FileCommand.rawValue`.
    static let marvinFileCommand = Notification.Name("marvin.fileCommand")
    /// Posted by "New Text File"; observed by `FileTreeView`, which owns
    /// the naming sheet and the create flow.
    static let marvinRequestNewFile = Notification.Name("marvin.requestNewFile")
    /// Posted by "Stop Session & All Work"; observed by `AppStatusBar`, which
    /// presents the Activity popover. The popover owns the confirmation and
    /// the list of what is running, so the menu command opens it rather than
    /// growing a second copy of that flow — and the user confirms while
    /// LOOKING at the jobs and wakeups they are about to kill.
    static let marvinRequestActivityPopover = Notification.Name("marvin.requestActivityPopover")
    /// Posted by the Run-menu / palette "Stop Session & All Work" entry;
    /// observed by the chat view, which owns the confirmation and knows which
    /// session is on screen.
    static let marvinRequestStopAll = Notification.Name("marvin.requestStopAll")
}

/// Commands that act on the open editors.
enum FileCommand: String {
    case saveAll
    case revert
    case nextChange
    case previousChange
}

extension FileCommand {
    func post() {
        NotificationCenter.default.post(
            name: .marvinFileCommand, object: nil,
            userInfo: ["command": rawValue]
        )
    }

    /// The command carried by a `.marvinFileCommand` notification, if it is
    /// one this build understands.
    static func from(_ note: Notification) -> FileCommand? {
        guard let raw = note.userInfo?["command"] as? String else { return nil }
        return FileCommand(rawValue: raw)
    }
}
