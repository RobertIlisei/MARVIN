// FileHistoryPopover — M6. Shows `git log --follow` for the active
// file. Opened from the FileViewerView header's history button.
// Each row: short SHA, commit message, author, relative date.
// Click copies the full SHA to the clipboard.

import SwiftUI

struct FileHistoryPopover: View {
    let commits: [GitCommit]
    let isLoading: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("File History")
                .font(.headline)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 8)

            Divider()

            if isLoading {
                ProgressView("Loading…")
                    .padding(16)
                    .frame(maxWidth: .infinity)
            } else if commits.isEmpty {
                Text("No commits found for this file.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(16)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(commits) { commit in
                            commitRow(commit)
                            Divider()
                        }
                    }
                }
                .frame(maxHeight: 340)
            }
        }
        .frame(width: 380)
    }

    private func commitRow(_ c: GitCommit) -> some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(c.sha, forType: .string)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                // SHA badge
                Text(c.id)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color(nsColor: .separatorColor).opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                    .frame(width: 52, alignment: .leading)

                VStack(alignment: .leading, spacing: 3) {
                    Text(c.message)
                        .font(.system(size: 12))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    HStack(spacing: 4) {
                        Image(systemName: "person.circle")
                            .font(.caption2)
                        Text(c.author)
                            .font(.caption)
                        Spacer()
                        Text(c.date)
                            .font(.caption)
                        Text("·")
                        Text(c.dateISO)
                            .font(.caption.monospaced())
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Click to copy full SHA to clipboard")
    }
}
