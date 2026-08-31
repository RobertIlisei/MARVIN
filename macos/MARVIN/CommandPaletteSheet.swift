// CommandPaletteSheet — ⇧⌘P, the reference's "Show All Commands".
//
// A filter over `CommandRegistry.all`. The palette is the reason the
// registry exists: before it, a command was reachable only by knowing
// which menu it was filed under, which is exactly the discovery problem
// the palette solves in every editor that has one.
//
// Disabled commands are SHOWN, greyed, with their reason implied by the
// state — hiding them makes the palette lie about what the app can do
// ("there's no Run Diagnostics command") when the truth is "not until a
// project is open".

import AppKit
import SwiftUI

struct CommandPaletteSheet: View {
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var selection: String?
    @FocusState private var focused: Bool

    private var results: [AppCommand] { CommandRegistry.filter(query) }

    private var effectiveSelection: String? {
        if let selection, results.contains(where: { $0.id == selection }) { return selection }
        return results.first(where: { $0.isEnabled() })?.id ?? results.first?.id
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tertiary)
                TextField("Type a command…", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .focused($focused)
                    .onSubmit(runSelected)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(MarvinTheme.elevated)

            MarvinDivider()

            if results.isEmpty {
                Text("No matching command")
                    .font(.callout)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .frame(height: 300)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(results) { cmd in row(cmd).id(cmd.id) }
                        }
                    }
                    .frame(height: 340)
                    .onChange(of: effectiveSelection) { _, id in
                        guard let id else { return }
                        proxy.scrollTo(id, anchor: .center)
                    }
                }
            }

            MarvinDivider()
            HStack {
                Text("\(results.count) command\(results.count == 1 ? "" : "s")")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                Spacer()
                Text("↑↓ move · ↩ run · esc dismiss")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(MarvinTheme.elevated)
        }
        .frame(width: 620)
        .background(MarvinTheme.panel)
        .onAppear { focused = true }
        .onKeyPress(.escape) { dismiss(); return .handled }
        .onKeyPress(.upArrow) { move(-1); return .handled }
        .onKeyPress(.downArrow) { move(1); return .handled }
    }

    private func row(_ cmd: AppCommand) -> some View {
        let enabled = cmd.isEnabled()
        let selected = effectiveSelection == cmd.id
        return Button {
            guard enabled else { return }
            selection = cmd.id
            runSelected()
        } label: {
            HStack(spacing: 8) {
                if cmd.slot != .none {
                    Text(cmd.slot.rawValue)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.tertiary)
                        .frame(width: 58, alignment: .leading)
                }
                Text(cmd.title)
                    .font(.system(size: 13))
                    .foregroundStyle(enabled
                        ? AnyShapeStyle(MarvinTheme.textPrimary)
                        : AnyShapeStyle(.tertiary))
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let s = cmd.shortcut {
                    Text(s)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .background(selected ? MarvinTheme.rowSelected : Color.clear)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    /// Skips disabled rows, so holding ↓ never parks the cursor on
    /// something Enter will not run.
    private func move(_ delta: Int) {
        let list = results
        guard !list.isEmpty else { return }
        var i = effectiveSelection.flatMap { id in list.firstIndex { $0.id == id } } ?? 0
        var steps = 0
        repeat {
            i = min(max(i + delta, 0), list.count - 1)
            steps += 1
            if list[i].isEnabled() { break }
        } while steps < list.count && i > 0 && i < list.count - 1
        selection = list[i].id
    }

    private func runSelected() {
        guard let id = effectiveSelection,
              let cmd = results.first(where: { $0.id == id }),
              cmd.isEnabled() else { return }
        // Dismiss FIRST: several commands present their own sheet, and
        // macOS will not open a second sheet while this one is up.
        dismiss()
        DispatchQueue.main.async { cmd.run() }
    }
}

// MARK: - Go to Line

/// ^G. Accepts `120` or `120:8` — the `line:col` form is what every
/// citation in MARVIN's own output uses, so pasting one should just work.
struct GoToLineSheet: View {
    @Environment(MarvinBridge.self) private var bridge
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Go to Line")
                .font(.headline)
            TextField("Line, or line:column", text: $text)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit(go)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Go") { go() }
                    .buttonStyle(.borderedProminent)
                    .disabled(Self.parse(text) == nil)
            }
        }
        .padding(16)
        .frame(width: 300)
        .onAppear { focused = true }
        .onKeyPress(.escape) { dismiss(); return .handled }
    }

    static func parse(_ raw: String) -> Int? {
        let head = raw.split(separator: ":").first.map(String.init) ?? raw
        guard let n = Int(head.trimmingCharacters(in: .whitespaces)), n > 0 else { return nil }
        return n
    }

    private func go() {
        guard let line = Self.parse(text), let path = bridge.selectedFilePath else { return }
        bridge.openFileFromChat(path: path, line: line)
        dismiss()
    }
}

// MARK: - Problem navigation

/// F8 / ⇧F8 — walk the Problems list without leaving the keyboard.
@MainActor
enum ProblemNavigator {
    enum Direction { case next, previous }

    /// Index into the CURRENT diagnostics list. Held statically rather than
    /// on a view because the command runs from the menu bar, where no view
    /// is in scope.
    private static var cursor = -1

    static func go(_ direction: Direction) {
        let items = MarvinBridge.shared.diagnosticItems.filter { $0.line > 0 }
        guard !items.isEmpty else { return }
        // Re-anchor on the file the user is actually looking at, so F8 from
        // a fresh file walks THAT file's problems rather than resuming a
        // cursor left over from somewhere else.
        if cursor < 0 || cursor >= items.count {
            cursor = -1
        }
        cursor = direction == .next
            ? (cursor + 1) % items.count
            : (cursor - 1 + items.count) % items.count
        let item = items[cursor]
        NativePrefs.shared.revealPane(.problems)
        MarvinBridge.shared.openFileFromChat(path: item.filePath, line: item.line)
    }

    static func reset() { cursor = -1 }
}

// MARK: - Support report

/// Help ▸ Copy App Diagnostics — the reference calls it "Download
/// Diagnostics". One clipboard payload with what a bug report needs, so
/// the user does not have to hunt for a version string and a log path.
@MainActor
enum AppDiagnosticsReport {
    static func copyToPasteboard() {
        let b = MarvinBridge.shared
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        let lsp = LSPService.shared
        let lines: [String] = [
            "MARVIN \(version) (build \(build))",
            "macOS \(ProcessInfo.processInfo.operatingSystemVersionString)",
            "sidecar: \(ServerConfig.baseURLString)",
            "project: \(b.projectWorkDir ?? "(none)")",
            "branch: \(b.branch ?? "(none)")\(b.branchDirtyCount > 0 ? " (\(b.branchDirtyCount) dirty)" : "")",
            "open editors: \(b.openFiles.count)",
            "diagnostics: \(b.errorCount) error(s), \(b.warningCount) warning(s)",
            "language servers: \(lsp.readyServerIds.isEmpty ? "none ready" : lsp.readyServerIds.joined(separator: ", "))",
            "unavailable servers: \(lsp.unavailable.isEmpty ? "none" : lsp.unavailable.map { "\($0.key) (\($0.value))" }.joined(separator: ", "))",
            "logs: ~/Library/Logs/MARVIN/",
        ]
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
    }
}
