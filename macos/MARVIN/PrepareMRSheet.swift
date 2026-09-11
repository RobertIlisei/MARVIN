// PrepareMRSheet — pick the finished tab branches, squash them into one
// commit on an `mr/…` branch, push it, open the merge request.
//
// The alternative this replaces was watched on 2026-09-10: MARVIN, asked to
// integrate a day's tabs, merged them into a tab branch, pushed it and then
// sat at the metered-CI confirm for `glab mr create` until the user came
// back. Here the user is the one clicking, so the cost of opening a request
// is stated on the toggle instead of raised as a card mid-turn (ADR-0109).
//
// Open tabs are listed but cannot be ticked: their branch is decided at tab
// close (ADR-0107), never folded behind the tab.

import SwiftUI

struct PrepareMRSheet: View {
    let worktrees: [WorktreeEntry]
    /// ADR-0111 — dry-run verdicts by slug; a conflict is shown on the row
    /// before anything is squashed, so the first conflict is not discovered
    /// at the third fold.
    var preview: [String: IntegrationPreviewRow] = [:]
    /// (slugs, name, message, push, openMergeRequest)
    let onPrepare: ([String], String, String, Bool, Bool) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var picked: Set<String> = []
    @State private var name: String = ""
    @State private var message: String = ""
    @State private var push = true
    @State private var openMergeRequest = true
    @State private var messageEdited = false

    /// Newest first, as the label promises.
    private var ready: [WorktreeEntry] { worktrees.filter(\.isReady).sorted { ($0.lastCommitAt ?? "") > ($1.lastCommitAt ?? "") } }
    private var open: [WorktreeEntry] { worktrees.filter(\.isSession) }
    private var chosen: [WorktreeEntry] { ready.filter { picked.contains($0.slug) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            MarvinDivider()
            branchList
            fields
            Spacer(minLength: 0)
            footer
        }
        .padding(20)
        .frame(minWidth: 560, idealWidth: 620, minHeight: 460, idealHeight: 540)
        .onAppear {
            picked = Set(ready.map(\.slug))
            regenerateMessage()
        }
        .onChange(of: picked) { _, _ in if !messageEdited { regenerateMessage() } }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.triangle.merge")
                .font(.title2)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text("Prepare a merge request")
                    .font(.title3.weight(.semibold))
                Text("one squash commit on a new mr/… branch · tab branches untouched")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
    }

    private var branchList: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Branches, newest first")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(ready) { w in
                        let p = preview[w.slug]
                        Toggle(isOn: Binding(
                            get: { picked.contains(w.slug) },
                            set: { on in if on { picked.insert(w.slug) } else { picked.remove(w.slug) } }
                        )) {
                            HStack(spacing: 6) {
                                row(w, note: w.diffBadge.map { "\(w.summary) · \($0)" } ?? w.summary)
                                if let p {
                                    Text(p.verdictLabel)
                                        .font(.system(size: 9.5, design: .monospaced))
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(Capsule().fill((p.isConflict ? Color.orange : GitDecorationColor.added).opacity(0.16)))
                                        .foregroundStyle(p.isConflict ? Color.orange : GitDecorationColor.added)
                                        .lineLimit(1)
                                        .help(p.isConflict ? "Would conflict with the current branch in: \(p.conflicts.joined(separator: ", ")). Sync the tab first (Sessions pane)." : "Applies cleanly on the current branch.")
                                }
                            }
                        }
                        .toggleStyle(.checkbox)
                    }
                    ForEach(open) { w in
                        Toggle(isOn: .constant(false)) {
                            row(w, note: "open tab — close it (keeping the branch) to include it")
                        }
                        .toggleStyle(.checkbox)
                        .disabled(true)
                    }
                }
                .padding(.vertical, 2)
            }
            .frame(minHeight: 90, maxHeight: 180)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(MarvinTheme.elevated)
            )
        }
    }

    private func row(_ w: WorktreeEntry, note: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(w.task)
                .font(.system(size: 11.5))
                .lineLimit(1)
                .truncationMode(.tail)
            Text("\(w.branch) · \(note)")
                .font(.system(size: 9.5, design: .monospaced))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Branch")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 56, alignment: .trailing)
                TextField("mr/<today>-<name>", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
            }
            HStack(alignment: .top, spacing: 8) {
                Text("Message")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 56, alignment: .trailing)
                TextEditor(text: Binding(
                    get: { message },
                    set: { message = $0; messageEdited = true }
                ))
                .font(.system(size: 11.5, design: .monospaced))
                .frame(minHeight: 84, maxHeight: 120)
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.secondary.opacity(0.25), lineWidth: 1)
                )
            }
            Text("The squash commit runs the project's commit hooks in a temporary checkout prepared like a tab's — a compile-and-test band can take minutes.")
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Push the branch to the project's remote", isOn: $push)
                .font(.system(size: 12))
            Toggle("Open a merge request from the push", isOn: $openMergeRequest)
                .font(.system(size: 12))
                .disabled(!push)
            Text(openMergeRequest && push
                 ? "Opening a merge request starts the project's pipeline — one run for everything ticked, instead of one per branch."
                 : "Nothing leaves this machine. Push later from Source Control, or from a terminal.")
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var footer: some View {
        HStack {
            Text(chosen.isEmpty
                 ? "Nothing ticked."
                 : "\(chosen.count) branch\(chosen.count == 1 ? "" : "es"), \(chosen.reduce(0) { $0 + $1.commits }) commits, \(chosen.reduce(0) { $0 + $1.filesChanged }) files → 1 commit")
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
            Spacer()
            Button("Cancel") { dismiss() }
                .keyboardShortcut(.cancelAction)
            Button(push ? (openMergeRequest ? "Squash, push & open MR" : "Squash & push") : "Squash") {
                onPrepare(chosen.map(\.slug), name, message, push, push && openMergeRequest)
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
            .disabled(chosen.isEmpty)
        }
    }

    /// The same shape the sidecar generates when the message is empty, so the
    /// user sees what will be committed and can edit it before it is.
    private func regenerateMessage() {
        let rows = chosen.sorted { ($0.lastCommitAt ?? "") < ($1.lastCommitAt ?? "") }
        guard !rows.isEmpty else { message = ""; return }
        let subject = rows.count == 1
            ? "chore: integrate \(rows[0].task.prefix(50))"
            : "chore: integrate \(rows.count) branches"
        let body = rows.map { w in
            "- \(w.branch): \(w.task) (\(w.commits) commit\(w.commits == 1 ? "" : "s"), \(w.filesChanged) file\(w.filesChanged == 1 ? "" : "s"))"
        }.joined(separator: "\n")
        message = "\(subject.prefix(72))\n\n\(body)\n"
    }
}
