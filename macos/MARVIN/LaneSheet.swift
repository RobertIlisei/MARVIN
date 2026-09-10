// LaneSheet — edit the repo-relative paths a shared tab owns (ADR-0107
// lanes). A sheet, not a popover: a text area with a Save button is a form,
// and forms live in sheets (ADR-0112).

import SwiftUI

struct LaneSheet: View {
    let initial: [String]
    let onSave: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Lane — paths this tab owns")
                .font(.headline)
            Text("One repo-relative path per line. Edits outside the lane and HEAD-moving git commands ask first, in every permission mode.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $text)
                .font(.system(size: 12, design: .monospaced))
                .frame(minHeight: 120)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.25), lineWidth: 1))
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") {
                    onSave(text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { text = initial.joined(separator: "\n") }
    }
}
