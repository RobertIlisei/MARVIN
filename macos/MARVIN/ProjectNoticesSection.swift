// ProjectNoticesSection — "Tell every tab…" in the Sessions pane (ADR-0131).
//
// A notice is one dated fact (the test machine moved, a config now lives in
// one file) every tab in the project carries in its next turns, and a tab
// opened later too. It is information, never consent. This section lists the
// live notices with a Retire chip on each and opens a small sheet to post one.
// The sidecar does not push notice changes, so the list reloads when the pane
// appears, the project changes and after each post or retire.

import MARVINLogic
import SwiftUI

@MainActor struct ProjectNoticesSection: View {
    let projectId: String
    @State private var notices: [ProjectNotice] = []
    @State private var composing = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !notices.isEmpty {
                PaneSectionHeader("Notices", count: notices.count).accessibilityAddTraits(.isHeader)
                ForEach(notices) { notice in noticeRow(notice) }
            }
            HStack(spacing: 8) {
                Button("Tell every tab…") { composing = true }
                    .chip(.neutral)
                    .help("Post a short note every tab in this project carries in its next turns. It is information, never consent.")
                Spacer()
            }
            .padding(.horizontal, 14)
            if let failure {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 14)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task(id: projectId) { await reload() }
        .sheet(isPresented: $composing) {
            ProjectNoticeSheet(
                onClose: { composing = false },
                onPost: { text, hours in
                    do {
                        try await SupervisorService.shared.postNotice(projectId: projectId, text: text, ttlHours: hours)
                        failure = nil
                        composing = false
                    } catch {
                        failure = error.localizedDescription
                        composing = false
                    }
                    await reload()
                }
            )
        }
    }

    private func noticeRow(_ notice: ProjectNotice) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(notice.text)
                    .font(.system(size: 11.5))
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(ProjectNotices.authorLabel(notice)) · \(ProjectNotices.remaining(notice, now: Date()))")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            Button("Retire") {
                Task {
                    do { try await SupervisorService.shared.retireNotice(projectId: projectId, id: notice.id); failure = nil }
                    catch { failure = error.localizedDescription }
                    await reload()
                }
            }
            .rowChip(.neutral)
            .accessibilityLabel("Retire notice: \(notice.text)")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 2)
    }

    private func reload() async {
        do { notices = try await SupervisorService.shared.notices(projectId: projectId) }
        catch { notices = []; if !(error is CancellationError) { failure = error.localizedDescription } }
    }
}

@MainActor struct ProjectNoticeSheet: View {
    let onClose: () -> Void
    let onPost: (String, Int) async -> Void
    @State private var text = ""
    @State private var lifetime: ProjectNoticeLifetime = .day
    @State private var posting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Tell every tab").font(.headline)
            Text("Every tab in this project carries this in its next turns, and so does a tab opened later. It is information about the environment, never your consent and never a change of scope.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $text)
                .font(.system(size: 12))
                .frame(height: 100)
                .overlay(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip).stroke(MarvinTheme.border, lineWidth: 1))
                .accessibilityLabel("Notice text")
            HStack {
                Picker("Lives for", selection: $lifetime) {
                    ForEach(ProjectNoticeLifetime.allCases) { Text($0.label).tag($0) }
                }
                .fixedSize()
                Spacer()
                Text("\(text.count)/\(ProjectNotices.maxChars)")
                    .font(.system(size: 10.5))
                    .foregroundStyle(text.count > ProjectNotices.maxChars ? .orange : .secondary)
            }
            HStack {
                Spacer()
                Button("Cancel", action: onClose).keyboardShortcut(.cancelAction)
                Button("Post to every tab") {
                    guard let t = ProjectNotices.postable(text) else { return }
                    posting = true
                    Task { await onPost(t, lifetime.hours); posting = false }
                }
                .disabled(ProjectNotices.postable(text) == nil || posting)
            }
        }
        .padding(20)
        .frame(width: 460)
    }
}
