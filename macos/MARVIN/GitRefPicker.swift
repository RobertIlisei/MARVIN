// GitRefPicker — the branch / tag quick-pick.
//
// The surface behind the branch name in the status bar and the branch
// chip in the Source Control panel. Before this, both were labels: the
// backend has had `/api/git/branch` (list), `/branch/create`,
// `/branch/switch` and `/branch/delete` since ADR-0012 M2, and no Swift
// code called any of them — the entire branch feature existed and was
// unreachable from the app.
//
// Modelled on the VS Code / Antigravity quick-pick rather than on a
// menu, for one concrete reason: a repo with fifty branches is
// unusable as a menu. A filter field plus a per-row last-commit line
// ("who touched it, when, saying what") is what lets someone pick
// `fix/adr0367-catalog-acl-regression` out of eight `fix/adr03…`
// siblings.
//
// ## Two modes, one field
//
// The search field doubles as the name field. `Create new branch…`
// flips `mode` to `.create`, the placeholder and footer change, and
// Enter creates instead of checking out. Keeping it in one field
// avoids a second sheet on top of a sheet, which macOS handles badly.
//
// Every mutation goes through `GitOpRunner`, so a dirty-tree switch
// (policy-denied) and a detached checkout (confirm-warn) both surface
// properly instead of failing silently.

import SwiftUI

/// What Enter does right now.
enum GitRefPickerMode: Equatable {
    /// Pick a ref and check it out.
    case checkout
    /// Type a name; create a branch from `base` (nil = current HEAD)
    /// and switch to it.
    case create(base: String?)
}

@MainActor
@Observable
final class GitRefPickerModel {
    private(set) var response: GitBranchListResponse? = nil
    private(set) var isLoading = false
    private(set) var loadError: String? = nil

    var query: String = ""
    var mode: GitRefPickerMode = .checkout
    /// Ref name under the keyboard cursor. Nil = the first match.
    var selection: String? = nil

    let runner = GitOpRunner()

    func load(cwd: String) {
        isLoading = true
        loadError = nil
        Task { @MainActor in
            defer { isLoading = false }
            do {
                response = try await FilesService.shared.fetchBranches(cwd: cwd)
            } catch {
                loadError = "\(error)"
            }
        }
    }

    // MARK: - Filtering

    private var needle: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Substring match on the ref name only — NOT on the commit
    /// subject. Typing "fix" should narrow to branches named `fix/…`,
    /// not surface every branch whose tip commit says "fix".
    private func matches(_ name: String) -> Bool {
        needle.isEmpty || name.lowercased().contains(needle)
    }

    var locals: [GitBranchEntry] {
        (response?.locals ?? []).filter { matches($0.name) }
    }

    var remotes: [GitRefEntry] {
        (response?.remotes ?? []).filter { matches($0.name) }
    }

    var tags: [GitRefEntry] {
        (response?.tags ?? []).filter { matches($0.name) }
    }

    /// Flat ordering used for ↑/↓ and for "what does Enter pick".
    /// Must stay in the same order the body renders.
    var orderedRefs: [String] {
        locals.map(\.name) + remotes.map(\.name) + tags.map(\.name)
    }

    var matchCount: Int { orderedRefs.count }

    /// The ref Enter would act on.
    var effectiveSelection: String? {
        if let selection, orderedRefs.contains(selection) { return selection }
        return orderedRefs.first
    }

    func moveSelection(by delta: Int) {
        let refs = orderedRefs
        guard !refs.isEmpty else { return }
        let current = effectiveSelection.flatMap { refs.firstIndex(of: $0) } ?? 0
        let next = min(max(current + delta, 0), refs.count - 1)
        selection = refs[next]
    }

    /// A local branch name is checked out with `git switch`; anything
    /// else — a tag, a remote-tracking ref — has to be detached,
    /// because git refuses a plain switch onto a non-branch.
    func isLocalBranch(_ name: String) -> Bool {
        (response?.locals ?? []).contains { $0.name == name }
    }
}

struct GitRefPickerSheet: View {
    let cwd: String
    /// Fired after any successful mutation so the host can refresh its
    /// own git state (status panel, status bar, file tree badges).
    var onChanged: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var model = GitRefPickerModel()
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            field
            MarvinDivider()
            listBody
            MarvinDivider()
            footer
        }
        .frame(width: 620)
        .background(MarvinTheme.panel)
        .onAppear {
            fieldFocused = true
            model.load(cwd: cwd)
            model.runner.onDidMutate = {
                onChanged()
            }
        }
        .onKeyPress(.escape) {
            if case .create = model.mode {
                // Back out of name-entry to the list rather than
                // closing the whole picker — Esc in a two-step flow
                // should undo the step, not the task.
                model.mode = .checkout
                model.query = ""
                return .handled
            }
            dismiss()
            return .handled
        }
        .onKeyPress(.upArrow) { model.moveSelection(by: -1); return .handled }
        .onKeyPress(.downArrow) { model.moveSelection(by: 1); return .handled }
        .sheet(item: Bindable(model.runner).pendingConfirm) { pending in
            GitConfirmSheet(
                actionVerb: pending.actionVerb,
                reason: pending.reason,
                severity: pending.severity,
                paths: pending.paths,
                onConfirm: pending.confirm,
                onCancel: pending.cancel
            )
        }
    }

    // MARK: - Field

    private var field: some View {
        HStack(spacing: 8) {
            Image(systemName: fieldIcon)
                .foregroundStyle(.secondary)
            TextField(placeholder, text: Bindable(model).query)
                .textFieldStyle(.plain)
                .focused($fieldFocused)
                .onSubmit(submit)
            if model.isLoading {
                ProgressView().controlSize(.small)
            }
        }
        .font(.system(size: 14))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(MarvinTheme.elevated)
    }

    private var fieldIcon: String {
        switch model.mode {
        case .checkout: return "magnifyingglass"
        case .create: return "plus"
        }
    }

    private var placeholder: String {
        switch model.mode {
        case .checkout:
            return "Select a branch or tag to checkout"
        case .create(let base):
            return base.map { "Branch name (from \($0))" }
                ?? "Branch name (from \(model.response?.current ?? "HEAD"))"
        }
    }

    // MARK: - List

    @ViewBuilder
    private var listBody: some View {
        if let err = model.loadError {
            Text("Failed to load branches: \(err)")
                .font(.caption.monospaced())
                .foregroundStyle(.red)
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    actionRows
                    if case .checkout = model.mode {
                        refSections
                    }
                }
            }
            .frame(height: 400)
        }
    }

    @ViewBuilder
    private var actionRows: some View {
        if case .checkout = model.mode {
            actionRow(
                icon: "plus",
                title: "Create new branch…",
                subtitle: "from \(model.response?.current ?? "HEAD")"
            ) {
                model.mode = .create(base: nil)
                model.query = ""
            }
            actionRow(
                icon: "plus",
                title: "Create new branch from…",
                subtitle: "pick a starting point, then name it"
            ) {
                // Two-step: the user first picks the base from the
                // list below, which then flips into name entry. We
                // signal that by parking the mode as `.create` only
                // once a ref is chosen — until then the row just
                // arms the behaviour.
                armCreateFrom = true
            }
            actionRow(
                icon: "point.3.connected.trianglepath.dotted",
                title: "Checkout detached…",
                subtitle: "pick a ref to check out with a detached HEAD"
            ) {
                armDetach = true
            }
            MarvinDivider().padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private var refSections: some View {
        if !model.locals.isEmpty {
            sectionHeader("branches", count: model.locals.count)
            ForEach(model.locals) { entry in
                branchRow(entry)
            }
        }
        if !model.remotes.isEmpty {
            sectionHeader("remote branches", count: model.remotes.count)
            ForEach(model.remotes) { entry in
                refRow(entry, icon: "cloud")
            }
        }
        if !model.tags.isEmpty {
            sectionHeader("tags", count: model.tags.count)
            ForEach(model.tags) { entry in
                refRow(entry, icon: "tag")
            }
        }
        if model.matchCount == 0 && !model.isLoading {
            Text("No branch or tag matches “\(model.query)”")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
        }
    }

    // Armed one-shot modifiers for the two "pick a ref first" actions.
    // @State on the view rather than the model because they only ever
    // live between one click and the next.
    @State private var armCreateFrom = false
    @State private var armDetach = false

    private func sectionHeader(_ title: String, count: Int) -> some View {
        HStack {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
            Spacer()
            Text("\(count)")
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 3)
    }

    private func actionRow(
        icon: String,
        title: String,
        subtitle: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 16)
                Text(title)
                    .font(.system(size: 13))
                    .foregroundStyle(MarvinTheme.textPrimary)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
        }
        .buttonStyle(GitPickerRowStyle(selected: false))
    }

    private func branchRow(_ entry: GitBranchEntry) -> some View {
        Button {
            choose(entry.name, isLocal: true)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Image(systemName: entry.isCurrent
                        ? "checkmark.circle.fill"
                        : "arrow.triangle.branch")
                        .font(.system(size: 11))
                        .foregroundStyle(entry.isCurrent
                            ? Color.accentColor : Color.secondary)
                        .frame(width: 16)
                    Text(entry.name)
                        .font(.system(size: 13))
                        .foregroundStyle(MarvinTheme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    trackingChips(ahead: entry.ahead, behind: entry.behind)
                    Spacer(minLength: 8)
                    if let rel = entry.relativeDate {
                        Text(rel)
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                commitLine(
                    author: entry.author,
                    sha: entry.sha,
                    subject: entry.subject
                )
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
        }
        .buttonStyle(
            GitPickerRowStyle(selected: model.effectiveSelection == entry.name)
        )
    }

    private func refRow(_ entry: GitRefEntry, icon: String) -> some View {
        Button {
            // A tag or remote ref can only be entered detached.
            choose(entry.name, isLocal: false)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Image(systemName: icon)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .frame(width: 16)
                    Text(entry.name)
                        .font(.system(size: 13))
                        .foregroundStyle(MarvinTheme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    if let rel = entry.relativeDate {
                        Text(rel)
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                    }
                }
                commitLine(
                    author: entry.author,
                    sha: entry.sha,
                    subject: entry.subject
                )
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
        }
        .buttonStyle(
            GitPickerRowStyle(selected: model.effectiveSelection == entry.name)
        )
    }

    /// `Robert Ilisei · 6c8f907 · chore: backlog audit — 8 easy wins`.
    /// Indented to line up under the ref name, matching the reference.
    @ViewBuilder
    private func commitLine(author: String?, sha: String?, subject: String?) -> some View {
        let parts = [author, sha, subject].compactMap { value -> String? in
            guard let value, !value.isEmpty else { return nil }
            return value
        }
        if !parts.isEmpty {
            Text(parts.joined(separator: "  ·  "))
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.leading, 24)
        }
    }

    @ViewBuilder
    private func trackingChips(ahead: Int?, behind: Int?) -> some View {
        HStack(spacing: 5) {
            if let behind, behind > 0 {
                Label("\(behind)", systemImage: "arrow.down")
                    .font(.system(size: 10).monospaced())
                    .foregroundStyle(GitDecorationColor.modified)
            }
            if let ahead, ahead > 0 {
                Label("\(ahead)", systemImage: "arrow.up")
                    .font(.system(size: 10).monospaced())
                    .foregroundStyle(GitDecorationColor.added)
            }
        }
        .labelStyle(.titleAndIcon)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            if model.runner.isBusy {
                ProgressView().controlSize(.small)
            }
            if let err = model.runner.lastError {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .lineLimit(2)
                    .textSelection(.enabled)
            } else if armCreateFrom {
                Text("pick a starting point for the new branch")
                    .font(.caption2)
                    .foregroundStyle(Color.accentColor)
            } else if armDetach {
                Text("pick a ref to check out detached")
                    .font(.caption2)
                    .foregroundStyle(Color.accentColor)
            } else if case .create = model.mode {
                Text("↩ create + switch · esc back")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            } else {
                Text("\(model.matchCount) ref\(model.matchCount == 1 ? "" : "s")")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Text("↑↓ move · ↩ select · esc dismiss")
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(MarvinTheme.elevated)
    }

    // MARK: - Actions

    /// Enter. In `.create` mode the field holds a branch name; in
    /// `.checkout` mode it holds a filter and the selection is what
    /// matters.
    private func submit() {
        switch model.mode {
        case .create(let base):
            let name = model.query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return }
            createAndSwitch(name: name, from: base)
        case .checkout:
            guard let ref = model.effectiveSelection else { return }
            choose(ref, isLocal: model.isLocalBranch(ref))
        }
    }

    /// A row was picked. What that means depends on which one-shot
    /// action (if any) is armed.
    private func choose(_ ref: String, isLocal: Bool) {
        if armCreateFrom {
            armCreateFrom = false
            model.mode = .create(base: ref)
            model.query = ""
            fieldFocused = true
            return
        }
        if armDetach {
            armDetach = false
            checkout(ref, detach: true)
            return
        }
        // A tag or a remote-tracking ref cannot be a plain switch
        // target — git would refuse — so those are always detached.
        checkout(ref, detach: !isLocal)
    }

    private func checkout(_ ref: String, detach: Bool) {
        model.runner.run(
            verb: detach ? "checkout detached" : "switch",
            key: ref,
            cwd: cwd,
            body: { token in
                try await FilesService.shared.switchBranch(
                    cwd: cwd, name: ref, detach: detach, confirmToken: token
                )
            },
            onSuccess: { dismiss() }
        )
    }

    private func createAndSwitch(name: String, from base: String?) {
        model.runner.run(
            verb: "create branch",
            key: name,
            cwd: cwd,
            body: { token in
                try await FilesService.shared.createBranch(
                    cwd: cwd, name: name, from: base, confirmToken: token
                )
            },
            onSuccess: {
                // Create and switch are separate routes on purpose —
                // only the switch needs a clean tree — so the picker
                // chains them. If the switch is refused the branch
                // still exists, which is the recoverable half.
                model.runner.run(
                    verb: "switch",
                    key: name,
                    cwd: cwd,
                    body: { token in
                        try await FilesService.shared.switchBranch(
                            cwd: cwd, name: name, confirmToken: token
                        )
                    },
                    onSuccess: { dismiss() }
                )
            }
        )
    }
}

/// Row chrome for the picker: hover + keyboard-selection fills that
/// match the file tree's, so the two lists feel like one app.
private struct GitPickerRowStyle: ButtonStyle {
    let selected: Bool
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                selected
                    ? MarvinTheme.rowSelected
                    : (hovering ? MarvinTheme.rowHover : Color.clear)
            )
            .onHover { hovering = $0 }
    }
}
