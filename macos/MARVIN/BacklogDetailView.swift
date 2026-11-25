// BacklogDetailView — the detail area of the Project Backlog window: the
// selected item, read first and edited second.
//
// The stored body is split by `MARVINLogic.BacklogBody` into what a person
// reads — the description, the dated `>` notes the resolve and note-append
// paths write, and the links — so a 40-line item with a year of notes is a
// description, a short dated list and a few links, not one grey block.
//
// Title stays read-only: the slug, id and filename derive from it, so a
// rename is a new item (backlog.ts `updateBacklogItem`). Classification
// (severity, kind, blocked) saves the moment it changes, as it always did —
// there is no Save for those and a silently dropped edit is worse than an
// eager write. The body has an explicit Save, and closing with unsaved
// edits asks first.

import MARVINLogic
import SwiftUI

@MainActor struct BacklogDetailView: View {
    let workDir: String
    let item: BacklogItem
    var findings: [BacklogFinding] = []
    let onPromote: (BacklogItem) -> Void
    /// Parent refreshes its list and the tray chip after any mutation.
    let onChanged: () -> Void
    /// The item left the list it was in (resolved, reopened): clear the selection.
    let onDismissSheet: () -> Void

    @State private var severity: String
    @State private var bodyText: String
    @State private var kind: String
    @State private var blocked: Bool
    @State private var blockedOn: String
    @State private var note = ""
    @State private var editing = false
    @State private var error: String?
    @State private var savedFlash = false

    init(workDir: String, item: BacklogItem, findings: [BacklogFinding] = [],
         onPromote: @escaping (BacklogItem) -> Void,
         onChanged: @escaping () -> Void,
         onDismissSheet: @escaping () -> Void) {
        self.workDir = workDir
        self.item = item
        self.findings = findings
        self.onPromote = onPromote
        self.onChanged = onChanged
        self.onDismissSheet = onDismissSheet
        _kind = State(initialValue: item.kindOrUnspecified)
        _blocked = State(initialValue: item.isBlocked)
        _blockedOn = State(initialValue: item.blockedOn ?? "")
        _severity = State(initialValue: item.severity)
        _bodyText = State(initialValue: item.body)
    }

    private var bodyDirty: Bool { bodyText != item.body }
    private var parts: BacklogBodyParts { BacklogBody.parse(item.body) }
    private var actions: BacklogRowActions { BacklogRowActions.forStatus(item.status) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                actionRow
                if !findings.isEmpty { findingsBlock }
                description
                if !parts.notes.isEmpty { notesBlock }
                if !parts.links.isEmpty { linksBlock }
                classification
                if let error {
                    Text(error).font(.system(size: 10.5)).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // Selecting another item, or closing the window, must not drop a body
        // the person was in the middle of editing: write it, as the severity
        // and kind pickers already do.
        .onDisappear {
            if editing && bodyDirty {
                let (dir, id, text) = (workDir, item.id, bodyText)
                Task { try? await BacklogService.shared.update(workDir: dir, id: id, body: text) }
            }
        }
    }

    // MARK: Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title)
                .font(.system(size: 14, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .help("Titles are immutable — the item's id derives from the title.")
            Text(BacklogRowText.secondary(item))
                .font(.system(size: 11))
                .foregroundStyle(MarvinTheme.textMuted)
        }
    }

    /// The primary action up front, the rest in a menu — the row's own rule.
    private var actionRow: some View {
        HStack(spacing: 8) {
            if let primary = actions.primary {
                Button(primary.title) { perform(primary) }
                    .chip(primary == .keep ? .primary : .neutral)
            }
            if !actions.menu.isEmpty {
                Menu {
                    ForEach(actions.menu, id: \.self) { a in
                        Button(a.title, role: a.isDestructive ? .destructive : nil) { perform(a) }
                    }
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                        .font(.system(size: 10.5, weight: .medium))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
            Spacer(minLength: 0)
            if savedFlash {
                Label("Saved", systemImage: "checkmark")
                    .font(.system(size: 10.5))
                    .foregroundStyle(MarvinTheme.textMuted)
            }
        }
    }

    private var findingsBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionTitle("Review findings")
            ForEach(findings, id: \.findingId) { f in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 9.5)).foregroundStyle(.orange)
                    Text("**\(f.badge)** — \(f.detail) → \(f.suggestion)")
                        .font(.system(size: 11))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text("Suggestions only — nothing was changed.")
                .font(.system(size: 10)).foregroundStyle(.tertiary)
        }
    }

    private var description: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                sectionTitle("Description")
                Spacer()
                if editing {
                    Button("Cancel") { bodyText = item.body; editing = false }.rowChip(.neutral)
                    Button("Save") { Task { await save(body: bodyText); editing = false } }
                        .rowChip(.primary).disabled(!bodyDirty)
                } else {
                    Button("Edit") { editing = true }.rowChip(.neutral)
                }
            }
            if editing {
                TextEditor(text: $bodyText)
                    .font(.system(size: 12))
                    .frame(minHeight: 180)
                    .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip)
                        .stroke(MarvinTheme.border, lineWidth: 1))
                Text("Keep dated notes on lines that start with “> ”; they are shown separately.")
                    .font(.system(size: 10)).foregroundStyle(.tertiary)
            } else if parts.text.isEmpty {
                Text("No description.").font(.system(size: 11.5)).foregroundStyle(.tertiary)
            } else {
                Text(rendered(parts.text))
                    .font(.system(size: 12))
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    private var notesBlock: some View {
        VStack(alignment: .leading, spacing: 5) {
            sectionTitle("Notes", count: parts.notes.count)
            ForEach(Array(parts.notes.enumerated()), id: \.offset) { _, n in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(n.date ?? n.label)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .frame(width: 78, alignment: .leading)
                    Text(n.date == nil || n.label == "note" ? n.text : "\(n.label) — \(n.text)")
                        .font(.system(size: 11.5))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
        }
    }

    private var linksBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionTitle("Links", count: parts.links.count)
            ForEach(parts.links, id: \.target) { link in
                if link.isWebURL, let url = URL(string: link.target) {
                    Link(destination: url) {
                        Label(link.label, systemImage: "arrow.up.right.square").font(.system(size: 11.5))
                    }
                } else if link.target.contains("/") || link.target.contains(".") {
                    Button {
                        MarvinBridge.shared.openFileFromChat(path: workDir + "/" + link.target, line: nil)
                    } label: {
                        Label(link.label, systemImage: "doc.text").font(.system(size: 11.5))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    .help(link.target)
                } else {
                    Label(link.label, systemImage: "link")
                        .font(.system(size: 11.5)).foregroundStyle(MarvinTheme.textMuted)
                }
            }
        }
    }

    private var classification: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Classification")
            HStack(spacing: 12) {
                Picker("Severity", selection: $severity) {
                    Text("Low").tag("low")
                    Text("Medium").tag("med")
                    Text("High").tag("high")
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 220)
                .onChange(of: severity) { _, next in
                    guard next != item.severity else { return }
                    Task { await save(severity: next) }
                }
                Picker("Kind", selection: $kind) {
                    ForEach(BacklogBrowse.kindOrder, id: \.self) { Text(BacklogBrowse.kindTitle($0)).tag($0) }
                }
                .frame(maxWidth: 190)
                .onChange(of: kind) { _, next in
                    guard next != item.kindOrUnspecified else { return }
                    Task { await classify(kind: next) }
                }
                Spacer(minLength: 0)
            }
            Toggle("Blocked — waiting on something outside the repo", isOn: $blocked)
                .font(.system(size: 11.5))
                .fixedSize(horizontal: false, vertical: true)
                .onChange(of: blocked) { _, next in
                    guard next != item.isBlocked else { return }
                    Task { await classify(blocked: next) }
                }
            if blocked {
                TextField("What unblocks it? (e.g. accountant sign-off)", text: $blockedOn)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 420)
                    .onSubmit { Task { await classify(blockedOn: blockedOn) } }
                Text("Recorded so the review can tell a waiting item from a forgotten one.")
                    .font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            if item.status != "done" && item.status != "dismissed" {
                TextField("Optional note, appended when you mark it done or dismiss it", text: $note)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11.5))
            }
        }
    }

    private func sectionTitle(_ title: String, count: Int? = nil) -> some View {
        HStack(spacing: 5) {
            Text(title)
                .font(.system(size: 9.5, weight: .semibold))
                .textCase(.uppercase)
                .tracking(0.4)
                .foregroundStyle(MarvinTheme.textMuted)
                .accessibilityAddTraits(.isHeader)
            if let count, PaneBadge.shows(count) {
                Text(PaneBadge.text(count)).font(.system(size: 9.5).monospacedDigit()).foregroundStyle(.tertiary)
            }
        }
    }

    private func rendered(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }

    // MARK: Actions

    private func perform(_ action: BacklogAction) {
        switch action {
        case .plan:
            onPromote(item)
        case .export:
            Task {
                do {
                    _ = try await BacklogService.shared.promoteIssue(workDir: workDir, id: item.id)
                    onChanged()
                } catch { self.error = "Export failed: \(error.localizedDescription)" }
            }
        default:
            if let status = action.targetStatus { Task { await resolve(status) } }
        }
    }

    private func classify(kind: String? = nil, blocked: Bool? = nil, blockedOn: String? = nil) async {
        do {
            try await BacklogService.shared.classify(workDir: workDir, id: item.id,
                                                     kind: kind, blocked: blocked, blockedOn: blockedOn)
            await flashSaved()
            onChanged()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save(severity: String? = nil, body: String? = nil) async {
        do {
            try await BacklogService.shared.update(workDir: workDir, id: item.id, severity: severity, body: body)
            onChanged()
            await flashSaved()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func flashSaved() async {
        savedFlash = true
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        savedFlash = false
    }

    private func resolve(_ status: String) async {
        do {
            // Persist an unsaved body edit first so it isn't lost, then
            // transition (the note appends to the just-saved body).
            if bodyDirty {
                try await BacklogService.shared.update(workDir: workDir, id: item.id, body: bodyText)
            }
            let trimmed = note.trimmingCharacters(in: .whitespaces)
            try await BacklogService.shared.setStatus(workDir: workDir, id: item.id, status: status,
                                                      note: trimmed.isEmpty ? nil : trimmed)
            onChanged()
            onDismissSheet()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
