// MarvinAccessibility — the VoiceOver layer the audit found missing (S1).
//
// The app is blind-by-default in one specific way: things appear. A tool confirm
// arrives in the tray, an error banner replaces the status line, and a sighted
// user sees both; a VoiceOver user hears nothing and the turn waits on them
// without telling them (C3). `announce` posts the same fact as speech.

import AppKit
import SwiftUI

enum VoiceOver {
    /// Speak `text` at high priority so it is not swallowed by the focus change
    /// that usually accompanies the thing appearing.
    @MainActor
    static func announce(_ text: String) {
        guard !text.isEmpty else { return }
        NSAccessibility.post(
            element: NSApp as Any,
            notification: .announcementRequested,
            userInfo: [
                .announcement: text,
                .priority: NSAccessibilityPriorityLevel.high.rawValue,
            ]
        )
    }
}

extension View {
    /// Announce when this view appears AND whenever `key` changes while it stays
    /// on screen. The tray rows are index-keyed (audit C10): a second confirm
    /// that replaces the first reuses the same view, so `onAppear` alone would
    /// speak for the first and stay silent for the next.
    @MainActor
    func announced<K: Equatable>(_ text: @autoclosure @escaping () -> String, when key: K) -> some View {
        task(id: key) { VoiceOver.announce(text()) }
    }
}
