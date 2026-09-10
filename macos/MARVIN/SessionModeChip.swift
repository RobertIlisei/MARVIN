// SessionModeChip — the tab's tree, as a header chip with a popover (ADR-0107).
//
// `isolated: marvin/tab/x` or `shared` (with `· lane: N paths` when a lane is
// set). The popover switches the mode — gated by `TabCloseDecision` when the
// worktree holds work — edits the lane for a shared tab, and shows the
// worktree's facts with Reveal / Copy branch. Lives in the header next to
// the sessions menu rather than inside each 190pt tab, where a text chip
// would push the close button off the end.

import AppKit
import MARVINLogic
import SwiftUI

struct SessionModeChip: View {
    let entry: SessionEntry?
    let isDraft: Bool
    /// The default a draft tab will use on its first message.
    let draftIsolated: Bool
    let onSwitch: (SessionMode, TabCloseDecision.Action?) -> Void
    let onLane: ([String]) -> Void

    @State private var open = false

    private var mode: SessionMode {
        if let entry, !entry.isDraft { return entry.mode }
        // A draft tab that has already picked. Nothing exists on the server
        // until the first message, so `applyTreeSwitch` records the choice on
        // the entry and `treeFields` reads it back when that message is sent.
        // Read the same record here: without it the picker re-renders the
        // app-wide default, the segment snaps back to Isolated, and the click
        // looks ignored even though the choice was taken.
        if let chosen = entry?.tree?.mode { return chosen }
        return draftIsolated ? .worktree : .shared
    }

    private var label: String {
        switch mode {
        case .worktree:
            if let branch = entry?.tree?.branch, !branch.isEmpty { return "isolated: \(branch)" }
            return isDraft || entry?.tree == nil ? "isolated · pending" : "isolated"
        case .shared:
            let lane = entry?.tree?.lane ?? []
            return lane.isEmpty ? "shared" : "shared · lane: \(lane.count) path\(lane.count == 1 ? "" : "s")"
        }
    }

    var body: some View {
        Button {
            open.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: mode == .worktree ? "arrow.triangle.branch" : "rectangle.split.2x1")
                    .font(.system(size: 9, weight: .semibold))
                Text(label)
                    .font(.system(size: 10.5))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
                Capsule().fill(mode == .worktree ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.12))
            )
            .foregroundStyle(mode == .worktree ? Color.accentColor : Color.secondary)
        }
        .buttonStyle(.plain)
        .help(mode == .worktree ? "This tab runs in its own git worktree" : "This tab runs in the shared checkout")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            SessionModePopover(entry: entry, isDraft: isDraft, mode: mode, onSwitch: { m, a in
                open = false
                onSwitch(m, a)
            }, onLane: { lane in
                onLane(lane)
            })
            .frame(width: 360)
        }
    }
}

struct SessionModePopover: View {
    let entry: SessionEntry?
    let isDraft: Bool
    let mode: SessionMode
    let onSwitch: (SessionMode, TabCloseDecision.Action?) -> Void
    let onLane: ([String]) -> Void

    @State private var laneText: String = ""
    @State private var leaving: TabCloseDecision.Outcome? = nil

    private var tree: SessionTreeWire? { entry?.tree }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Where this tab works")
                .font(.system(size: 12, weight: .semibold))

            Picker("", selection: Binding(
                get: { mode },
                set: { requestSwitch(to: $0) }
            )) {
                Text("Isolated worktree").tag(SessionMode.worktree)
                Text("Shared checkout").tag(SessionMode.shared)
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            if let leaving, case .offer(let actions, let note) = leaving {
                VStack(alignment: .leading, spacing: 6) {
                    Text(note).font(.system(size: 10.5)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        ForEach(actions, id: \.rawValue) { action in
                            Button(actionLabel(action)) { onSwitch(.shared, action) }
                                .controlSize(.small)
                                .tint(action == .discard ? .red : nil)
                        }
                        Button("Cancel") { self.leaving = nil }.controlSize(.small)
                    }
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.orange.opacity(0.08)))
            } else if leaving == .stopTurnFirst {
                Text("Stop the running turn before switching trees.")
                    .font(.system(size: 10.5)).foregroundStyle(.orange)
            }

            if mode == .worktree, let tree, tree.mode == .worktree {
                facts(tree)
            } else if mode == .worktree {
                Text(isDraft ? "The worktree is cut from \(currentBranchLabel) when you send the first message."
                             : "Worktree details arrive after the first message.")
                    .font(.system(size: 10.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if mode == .shared {
                laneEditor
            }

            Text("The editor, terminal and file tree stay on the main checkout; only MARVIN's turns run in the worktree.")
                .font(.system(size: 10)).foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
            if mode == .worktree {
                Text("Dependencies (node_modules, .venv, …) are symlinked from the main checkout and ignored .env files copied, as .marvin/worktree.json says. MARVIN writes that file from the project the first time; edit it to change what a new tab gets. See docs/guides/worktrees.md.")
                    .font(.system(size: 10)).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .onAppear { laneText = (entry?.tree?.lane ?? []).joined(separator: "\n") }
    }

    private func requestSwitch(to next: SessionMode) {
        guard next != mode else { return }
        if next == .worktree {
            onSwitch(.worktree, nil)
            return
        }
        // Leaving a worktree: what happens to it?
        // ADR-0111 — decided from the sidecar's derived state (last snapshot);
        // a tree holding nothing is discarded, not kept.
        let outcome = TabCloseDecision.decide(
            isLive: entry?.isLive ?? false,
            mode: .worktree,
            worktree: entry?.tree?.mode == .worktree ? entry?.worktree : nil,
            target: nil
        )
        switch outcome {
        case .closeNow:
            onSwitch(.shared, .keepBranch)
        case .reclaimSilently:
            onSwitch(.shared, .discard)
        case .stopTurnFirst, .offer:
            leaving = outcome
        }
    }

    private func actionLabel(_ a: TabCloseDecision.Action) -> String {
        switch a {
        case .merge: return "Merge & switch"
        case .keepBranch: return "Keep branch & switch"
        case .discard: return "Discard & switch"
        }
    }

    @ViewBuilder
    private func facts(_ tree: SessionTreeWire) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            fact("Branch", tree.branch ?? "—")
            fact("Path", tree.path ?? "—")
            fact("Cut from", baseLabel(tree))
            if let diff = entry?.diff {
                fact("Changes", "+\(diff.added) −\(diff.removed) in \(diff.files) file\(diff.files == 1 ? "" : "s")")
            }
            HStack(spacing: 6) {
                if let path = tree.path {
                    Button("Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
                        .controlSize(.small)
                }
                if let branch = tree.branch {
                    Button("Copy branch") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(branch, forType: .string)
                    }
                    .controlSize(.small)
                }
            }
            .padding(.top, 2)
        }
    }

    /// "main @ 244d5a8" — the branch HEAD was on at the cut, then the
    /// commit. A sha alone answers "which commit", never "which branch",
    /// which is the question a user asks when a new tab's branch appears
    /// in the picker with no visible parent.
    private func baseLabel(_ tree: SessionTreeWire) -> String {
        let sha = tree.base.map { String($0.prefix(7)) }
        switch (tree.baseRef, sha) {
        case let (ref?, sha?): return "\(ref) @ \(sha)"
        case let (ref?, nil): return ref
        case let (nil, sha?): return sha
        case (nil, nil): return "—"
        }
    }

    /// Names the branch a draft tab's worktree will be cut from: the
    /// shared checkout's current branch, as the status bar shows it.
    private var currentBranchLabel: String {
        if let b = MarvinBridge.shared.branch, !b.isEmpty { return "`\(b)` (your current HEAD)" }
        return "your current HEAD"
    }

    private func fact(_ k: String, _ v: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(k).font(.system(size: 10)).foregroundStyle(.tertiary).frame(width: 52, alignment: .trailing)
            Text(v).font(.system(size: 10.5, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                .textSelection(.enabled)
        }
    }

    private var laneEditor: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Lane — paths this tab owns (one per line, repo-relative)")
                .font(.system(size: 10)).foregroundStyle(.secondary)
            TextEditor(text: $laneText)
                .font(.system(size: 10.5, design: .monospaced))
                .frame(height: 64)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(MarvinTheme.border, lineWidth: 1))
            HStack {
                Text("Edits outside the lane and HEAD-moving git raise a confirm.")
                    .font(.system(size: 9.5)).foregroundStyle(.tertiary)
                Spacer()
                Button("Save lane") {
                    let lane = laneText.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                    onLane(lane)
                }
                .controlSize(.small)
            }
        }
    }
}
