// SourceControlProjectView — the second scope: the PROJECT.
//
//   Atlas · 2 ready · 1 building · 4 open tabs · 7 spent
//   Acts on the project checkout (main), whichever tree the other view shows.
//   ▾ READY TO MERGE 2
//       ● Fix body replay                                          [Merge]
//         3 commits, 5 files · +61 −9
//   ▾ BUILDING 1
//   ▾ OPEN TABS 4
//   ▸ MERGED OR EMPTY 7
//
// The integrations (merge all, Prepare MR, reclaim) are in the header's
// Integrate menu and each asks first; the only button a row shows is the one
// thing that is safe to do with that branch — merge a finished one, or look at an
// open tab's changes. Rows are grouped by derived state (ADR-0103), the way a
// person decides what to do next, not by when the branch was cut.

import AppKit
import MARVINLogic
import SwiftUI

@MainActor struct SourceControlProjectView: View {
    let project: SourceControlProjectModel
    let projectName: String
    let collapsed: Set<String>
    let toggleCollapsed: (String) -> Void
    /// The chat tab that holds a worktree, by slug — "one name everywhere".
    let tabName: (String) -> String?
    let mergeAll: () -> Void
    let merge: (String) -> Void
    let view: (WorktreeEntry, String) -> Void
    let drop: (String, String) -> Void

    private var sections: [WorktreeSection] { WorktreeSections.make(project.lines) }

    private var mainBranch: String? { project.repos.first(where: { $0.isMain })?.branch }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                summary
                if let job = project.integrationJob, job.running { progress(job) }
                if let notice = project.notice {
                    PaneNoticeStrip(notice: notice, onDismiss: { project.notice = nil })
                        .padding(.bottom, 4)
                }
                content
            }
            .padding(.bottom, 8)
        }
        .frame(maxHeight: .infinity)
    }

    // MARK: Summary

    private var summary: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(projectName) · \(WorktreeSections.summary(project.lines))")
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(MarvinTheme.textPrimary)
                .lineLimit(2)
            Text("Acts on the project checkout\(mainBranch.map { " (\($0))" } ?? ""), whichever tree the other view shows. Every tab's branch is listed here.")
                .font(.system(size: 10))
                .foregroundStyle(MarvinTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    /// What the running integration is doing, refreshed about once a second. The
    /// elapsed time is the load-bearing part: it is what separates "working" from
    /// "wedged" for an operation that legitimately takes minutes (ADR-0109 amendment).
    private func progress(_ job: IntegrationJobEntry) -> some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.small).scaleEffect(0.55).frame(width: 12, height: 12)
            VStack(alignment: .leading, spacing: 1) {
                Text(job.kind == "merge-all" ? "Merge all" : "Prepare MR")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(MarvinTheme.textMuted)
                Text(job.progressLine)
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .help("This runs in the sidecar, not in the app: it keeps going if you switch project or close the window, and the result appears here when it lands.")
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if !project.hasLoaded {
            if let error = project.loadError, let root = project.root {
                PaneEmptyView(
                    state: PaneEmptyState(headline: "Could not list the worktrees", hint: error, symbol: "exclamationmark.triangle"),
                    actionTitle: "Try again", action: { project.refresh(root: root, force: true) })
            } else {
                SkeletonRows(count: 5, detailLines: 1).padding(.horizontal, 12).padding(.vertical, 10)
            }
        } else if sections.isEmpty && project.unmanagedRepos.isEmpty {
            PaneEmptyView(state: PaneEmptyState(
                headline: "No worktrees yet",
                hint: "Each chat tab works in its own worktree. They appear here, with what each one holds, once a tab has started.",
                symbol: "arrow.triangle.branch"))
        } else {
            ForEach(sections) { section in
                header(section.title, count: section.count, id: "worktrees.\(section.id)")
                if !collapsed.contains("worktrees.\(section.id)") {
                    ForEach(section.rows) { row in
                        if let entry = project.worktrees.first(where: { $0.slug == row.slug }) {
                            SourceControlWorktreeRow(
                                row: row, entry: entry,
                                title: row.state == "session" ? (tabName(row.slug) ?? row.title) : row.title,
                                busy: project.integrationRunning,
                                merge: { merge(row.slug) },
                                view: { view(entry, row.state == "session" ? (tabName(row.slug) ?? row.title) : row.title) },
                                drop: { drop(row.slug, row.branch) })
                        }
                    }
                }
            }
            if !project.unmanagedRepos.isEmpty {
                header("Other worktrees", count: project.unmanagedRepos.count, id: "worktrees.other")
                if !collapsed.contains("worktrees.other") {
                    ForEach(project.unmanagedRepos) { repo in otherRow(repo) }
                }
            }
        }
    }

    private func header(_ title: String, count: Int, id: String) -> some View {
        Button { toggleCollapsed(id) } label: {
            PaneSectionHeader(title, count: count, collapsed: collapsed.contains(id))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// A worktree git lists that MARVIN does not manage. Read-only: the row exists
    /// so a checkout made by hand is visible rather than silently absent.
    private func otherRow(_ repo: GitRepoEntry) -> some View {
        HStack(spacing: 6) {
            Circle().fill(Color.secondary.opacity(0.5)).frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
                Text(repo.name)
                    .font(.system(size: 11.5))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(1)
                Text(repo.detached ? "(detached)" : (repo.branch ?? "?"))
                    .font(.system(size: 10))
                    .foregroundStyle(MarvinTheme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 4)
            if repo.dirtyCount > 0 {
                Text("\(repo.dirtyCount) changed")
                    .font(.system(size: 10))
                    .foregroundStyle(GitDecorationColor.modified)
            }
        }
        .paneRow()
        .help("Linked worktree at \(repo.path)")
        .contextMenu {
            Button("Copy Path") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(repo.path, forType: .string)
            }
            Button("Reveal in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: repo.path) }
        }
    }
}

/// One worktree: a state dot, the title, one secondary line, ONE visible action.
@MainActor struct SourceControlWorktreeRow: View {
    let row: WorktreeSection.Row
    let entry: WorktreeEntry
    let title: String
    let busy: Bool
    let merge: () -> Void
    let view: () -> Void
    let drop: () -> Void

    @State private var hovering = false

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(tint).frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 11.5))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(row.subtitle)
                    .font(.system(size: 10))
                    .foregroundStyle(MarvinTheme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 4)
            switch row.primary {
            case .merge:
                Button("Merge", action: merge)
                    .rowChip(.tinted(GitDecorationColor.added))
                    .disabled(busy)
                    .help("Merge \(row.branch) into the project checkout, locally. Never pushes — the commits ride along in whatever pipeline that branch already runs.")
            case .viewChanges:
                Button("View", action: view)
                    .rowChip(.neutral)
                    .help("Show this worktree's changes in the first view")
            default:
                EmptyView()
            }
            if hovering {
                Menu { menu } label: { Image(systemName: "ellipsis") }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .frame(width: 22, height: 22)
                    .foregroundStyle(MarvinTheme.textMuted)
                    .accessibilityLabel("More actions")
            }
        }
        .paneRow(hovering: hovering)
        .onHover { hovering = $0 }
        .help("\(entry.task.isEmpty ? row.branch : entry.task)\n\(row.branch)\n\(entry.path)")
        .contextMenu { menu }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(row.subtitle)")
    }

    private var tint: Color {
        switch row.state {
        case "ready": return GitDecorationColor.added
        case "running": return GitDecorationColor.modified
        case "session": return Color.accentColor
        case "merged": return MarvinTheme.textMuted
        default: return .secondary
        }
    }

    @ViewBuilder
    private var menu: some View {
        ForEach(Array(row.menu.enumerated()), id: \.offset) { _, action in
            switch action {
            case .viewChanges:
                Button("View Changes", action: view)
            case .copyBranch:
                Button("Copy Branch Name") { copy(row.branch) }
            case .copyReviewCommand:
                Button("Copy Review Command") { copy("git diff \(entry.base)...\(row.branch)") }
            case .reveal:
                Button("Reveal in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: entry.path) }
            case .dropCheckout:
                Divider()
                Button("Remove Checkout (keep branch)…", role: .destructive, action: drop).disabled(busy)
            case .merge, .none:
                EmptyView()
            }
        }
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
