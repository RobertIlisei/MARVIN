// ShortcutsHelpSheet — the ⌘/ reference card.
//
// **This list is a claim about the app and it must stay true.** Audited
// 2026-08-31 against every `.keyboardShortcut` in `macos/MARVIN/` and
// rewritten; the previous version had drifted badly enough to be
// actively misleading:
//
//   • ⌘R "Reload", ⌘⇧R "Force Reload", ⌘0 / ⌘= / ⌘- zoom — all four were
//     WebView-era bindings, removed with the browser UI (ADR-0021 M5 /
//     ADR-0075). They had not existed for months.
//   • ⌘K was listed as "Open project picker"; it clears the terminal.
//   • ⌘J was listed as "Terminal"; it toggles the bottom panel, whatever
//     tab is showing.
//   • ⌘G appeared TWICE, as "Find next" and as "Graph" — which was not a
//     typo but a real double-binding in the menus. Find Next kept ⌘G;
//     the graph pane moved to ^⇧G.
//   • ⌘T (Go to Symbol), ⇧⌘B (Run Build Task), ⇧⌘M (Problems), ^`
//     (Terminal), ⇧⌘A (attach a file), ⇧⌘V (Markdown preview) were all
//     real and all missing from the card.
//
// When you add or change a `.keyboardShortcut` anywhere in the app, change
// it here and in `docs/reference/shortcuts.md` in the same commit.

import SwiftUI

struct ShortcutsHelpSheet: View {
    @Environment(\.dismiss) private var dismiss

    private struct Section: Identifiable {
        let id = UUID()
        let title: String
        let entries: [(keys: String, label: String)]
    }

    /// Built FROM `CommandRegistry`, plus the responder-chain bindings the
    /// registry deliberately does not own.
    ///
    /// The previous version was a hand-maintained second list, and it had
    /// drifted badly: five WebView-era entries that had not existed for
    /// months, ⌘K described as the project picker when it clears the
    /// terminal, ⌘J as "Terminal" when it toggles the panel, and ⌘G listed
    /// TWICE with two different meanings — which was not a typo but a real
    /// double-binding nothing had caught. Deriving removes the drift by
    /// construction: change a shortcut in the registry and this sheet, the
    /// menu and the palette all move together.
    private var sections: [Section] {
        var out: [Section] = []
        for slot in CommandMenuSlot.allCases where slot != .none {
            let entries = CommandRegistry.commands(in: slot)
                .compactMap { cmd -> (keys: String, label: String)? in
                    guard let s = cmd.shortcut else { return nil }
                    return (s, cmd.title)
                }
            if !entries.isEmpty {
                out.append(Section(title: slot.rawValue, entries: entries))
            }
        }
        // AppKit owns these — they act on whatever has focus, in any text
        // view, and MARVIN does not redeclare them (see CommandRegistry).
        out.append(Section(title: "Editing (any text view)", entries: [
            ("⌘Z", "Undo"), ("⇧⌘Z", "Redo"),
            ("⌘X", "Cut"), ("⌘C", "Copy"), ("⌘V", "Paste"),
            ("⌘F", "Find in file"), ("⌘G", "Find next"),
            ("⇧⌘G", "Find previous"), ("⌘E", "Use selection for find"),
            ("⌘S", "Save active file"), ("⌘W", "Close active editor tab"),
            ("⇧⌘V", "Toggle Markdown preview"),
        ]))
        out.append(Section(title: "Chat", entries: [
            ("⌘⏎", "Send message"), ("⌘.", "Cancel current turn"),
            ("⇧⌘A", "Attach a file"),
        ]))
        out.append(Section(title: "File tree", entries: [
            ("⌫", "Move selected row to Trash"),
            ("↩", "Rename selected row"),
            ("Space", "Quick Look"),
        ]))
        out.append(Section(title: "Terminal", entries: [
            ("⌘K", "Clear the terminal (when focused)"),
        ]))
        out.append(Section(title: "macOS", entries: [
            ("⌘,", "Open Settings"), ("⌘Q", "Quit MARVIN"),
            ("⌘H", "Hide MARVIN"), ("⌘⌥H", "Hide others"), ("⌘M", "Minimize"),
        ]))
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Keyboard Shortcuts")
                    .font(.title2.weight(.semibold))
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(20)
            .background(Color(nsColor: .underPageBackgroundColor))
            MarvinDivider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(sections) { section in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(section.title.uppercased())
                                .font(.system(size: 10, design: .monospaced))
                                .tracking(2)
                                .foregroundStyle(.tertiary)
                                .padding(.bottom, 2)
                            ForEach(section.entries, id: \.label) { entry in
                                HStack(spacing: 12) {
                                    Text(entry.keys)
                                        .font(.system(size: 12, design: .monospaced))
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 2)
                                        .background(
                                            RoundedRectangle(cornerRadius: 4, style: .continuous)
                                                .fill(Color(nsColor: .underPageBackgroundColor))
                                                .overlay(
                                                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                                                        .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                                                )
                                        )
                                        .frame(minWidth: 80, alignment: .leading)
                                    Text(entry.label)
                                        .font(.system(size: 12))
                                        .foregroundStyle(.primary)
                                    Spacer()
                                }
                            }
                        }
                    }
                }
                .padding(20)
            }
        }
        .frame(width: 540, height: 640)
    }
}
