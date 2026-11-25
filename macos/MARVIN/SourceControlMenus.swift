// SourceControlMenus — the two `…` menus of the Source Control header, one per
// scope. Everything that does not earn a visible slot lives here, and the acts
// that cannot be taken back sit at the END of their section, in the destructive
// role, so they are never the thing a hurried click lands on. Each one is
// confirmed with the target named (see `SourceControlConfirmText`).

import MARVINLogic
import SwiftUI

/// The first scope's menu: acts on the tree on screen, which the item titles
/// do not repeat — the header's "Viewing" line and every confirmation do.
@MainActor struct SourceControlTreeMenu: View {
    let model: SourceControlModel
    let target: SourceControlTarget?
    let pickBranch: () -> Void
    let expandAll: () -> Void
    let collapseAll: () -> Void

    var body: some View {
        Menu {
            Section("Changes") {
                Button("Stage All Changes") { model.stageEverything() }
                    .disabled(model.changeCount + model.untrackedCount == 0)
                Button("Unstage All") { model.unstageAll() }
                    .disabled(model.stagedCount == 0)
            }
            Section("Commit") {
                Button("Commit") { model.commit() }.disabled(!model.canCommit)
                Button("Commit (Amend)") { model.commit(amend: true) }.disabled(!model.canAmend)
                Button("Stage All & Commit") { model.stageAllAndCommit() }
                    .disabled(model.commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Section("Pull, Push") {
                Button("Sync") { model.sync() }.disabled(!model.hasUpstream)
                Button("Fetch") { model.fetchRemote() }
                Button("Pull") { model.pull() }
                Button("Pull (Rebase)") { model.pull(strategy: "rebase") }
                Button("Push") { model.push() }
                Button("Publish Branch") { model.publish() }.disabled(model.hasUpstream)
            }
            Section("Branch") {
                Button("Checkout to…") { pickBranch() }
                Button("Create Branch…") { pickBranch() }
            }
            Section("Stash") {
                Button("Stash Changes") { model.stashPush(includeUntracked: false) }.disabled(model.isClean)
                Button("Stash Changes (Include Untracked)") { model.stashPush(includeUntracked: true) }.disabled(model.isClean)
                Button("Pop Latest Stash") { model.stashAction("pop", index: nil) }.disabled(model.stashes.isEmpty)
                Button("Apply Latest Stash") { model.stashAction("apply", index: nil) }.disabled(model.stashes.isEmpty)
            }
            Section("Folders") {
                Button("Expand All Folders") { expandAll() }
                Button("Collapse All Folders") { collapseAll() }
            }
            // The acts that cannot be taken back, last, each confirmed by name.
            Section("Cannot be undone") {
                Button("Discard All Changes…", role: .destructive) { model.discardAllTracked() }
                    .disabled(model.changeCount == 0)
                Button("Delete All Untracked Files…", role: .destructive) { model.deleteAllUntracked() }
                    .disabled(model.untrackedCount == 0)
                Button("Push (Force with Lease)…", role: .destructive) { model.push(forceWithLease: true) }
                Button("Drop Latest Stash…", role: .destructive) { model.stashAction("drop", index: nil) }
                    .disabled(model.stashes.isEmpty)
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: 26, height: 26)
        .disabled(target == nil)
        .help(target.map { "More actions \($0.actionPhrase)" } ?? "More source control actions")
        .accessibilityLabel("More actions")
    }
}

/// The project scope's menu: the integrations, which touch every tab's branch.
/// Never a primary button; each asks first and names what it will do.
@MainActor struct SourceControlIntegrateMenu: View {
    let project: SourceControlProjectModel
    let mergeAll: () -> Void
    let prepareMR: () -> Void
    let sweep: () -> Void

    var body: some View {
        let a = WorktreeSections.integration(project.lines)
        Menu {
            Button("Merge \(a.readyCount) Ready Branches…") { mergeAll() }
                .disabled(!a.canMergeAll || project.integrationRunning)
            Button("Prepare Merge Request…") { prepareMR() }
                .disabled(!a.canPrepareMR || project.integrationRunning)
            Divider()
            Button("Reclaim \(a.spentCount) Spent Checkouts…", role: .destructive) { sweep() }
                .disabled(!a.canSweep || project.integrationRunning)
        } label: {
            Image(systemName: "arrow.triangle.merge")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: 26, height: 26)
        .help(project.integrationRunning
            ? "An integration is running — it finishes first."
            : "Integrate: merge ready branches, prepare a merge request, reclaim spent checkouts. Each asks first.")
        .accessibilityLabel("Integrate")
    }
}
