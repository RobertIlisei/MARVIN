// FileViewerView — Phase 5c IDE-grade inline editor.
//
// Sits as a ZStack overlay over `ContentView.webIsland` whenever the
// bridge reports an active tab (`selectedFilePath` non-nil). Stack:
//
//   ┌──────────────────────────────────────────┐
//   │  TabBar  · file1.swift • · file2.go ×    │   ← bridge.openFiles
//   ├──────────────────────────────────────────┤
//   │  Header  doc.text  /abs/path           ✕ │   ← active path + close
//   ├──────────────────────────────────────────┤
//   │                                          │
//   │  STTextView (editable, line-numbered,    │
//   │   tree-sitter highlighted)               │
//   │                                          │
//   └──────────────────────────────────────────┘
//
// Per-tab buffers live in `FileViewerModel.buffers` keyed by absolute
// path so unsaved edits survive tab switches. ⌘S on a dirty buffer
// posts to /api/files/write/save with the tracked mtime; 409 stale
// surfaces a reload-or-overwrite alert; success rolls the mtime
// forward and resets the dirty baseline.
//
// ## Why one model holds all buffers
//
// Per-buffer state in a dict gives O(1) tab switch (no re-fetch when
// the user toggles between two open files) and survives the SwiftUI
// re-render cycle without leaning on @State per row. The trade-off
// is memory — we hold every open file's full text in RAM. Acceptable
// for editor-shaped use (a dozen open files at most); the 4 MB
// /api/files/content cap means even 50 open files stay under 200 MB.
//
// ## Why STTextView's NSTextDelegate over polling
//
// Tracking dirty state by polling textView.string would race with
// SwiftUI's render loop. Hooking the textDidChange notification (via
// the Coordinator as NSTextDelegate) gives us push-based updates the
// moment the user types, which is what the dirty indicator + save
// gate actually need.

import AppKit
import STTextView
import SwiftUI

// MARK: - View-model

/// State machine for the file viewer's display + per-tab buffer
/// store. Each open tab has a Buffer entry; the active tab's buffer
/// is what the editor renders. Switching tabs is just a key change
/// — content survives the switch automatically.
@Observable
@MainActor
final class FileViewerModel {
    /// One open file's complete state. Captures both the on-disk
    /// snapshot (`originalContent`, `mtime`) and the in-memory edit
    /// state (`content`). `isDirty` is the diff between the two —
    /// what drives the tab dot + the ⌘S enable gate.
    struct Buffer: Equatable {
        /// Absolute path on disk. Stable identity for the buffer.
        let path: String
        /// Live editor contents (may be modified vs original).
        var content: String
        /// Snapshot at last load / save — the dirty baseline.
        var originalContent: String
        /// Last mtime returned by /api/files/content or save. Sent
        /// as `expectedMtime` on the next save for stale-detection.
        var mtime: Double
        /// Server-reported size. Used by the truncation badge.
        var size: Int
        /// Server-reported truncation. A truncated buffer is
        /// effectively read-only — saving would silently overwrite
        /// the unread tail.
        var truncated: Bool
        /// Marked when the sidecar reports the file is binary —
        /// we render a placeholder instead of the editor and gate
        /// out save.
        var isBinary: Bool
        /// Outstanding save in flight. Disables the save button
        /// + ⌘S so the user doesn't double-fire.
        var isSaving: Bool
        /// Last error surfaced by save / load. Cleared on the next
        /// successful operation.
        var error: String?

        var isDirty: Bool { content != originalContent }
        /// True when the buffer is in a state where the editor can
        /// display + edit it (not binary, not failed-to-load).
        var canEdit: Bool { !isBinary && error == nil && !truncated }
    }

    /// Per-path buffer cache. Keyed by absolute path. A switch from
    /// one open tab to another is just an `activePath` reassignment;
    /// content + scroll position are preserved by the underlying
    /// STTextView only when the SwiftUI view stays alive (it does —
    /// FileViewerNSView is the same instance across tab switches),
    /// but the *content* baseline lives here.
    private(set) var buffers: [String: Buffer] = [:]

    /// Per-path "loading" markers. Tracked separately from buffers
    /// because a loading entry shouldn't expose `content` yet (the
    /// editor would flash empty before the fetch lands).
    private(set) var loading: Set<String> = []

    /// In-flight load / save tasks per path so a fast retoggle
    /// cancels the stale work.
    private var inflight: [String: Task<Void, Never>] = [:]

    /// Snapshot the active tab's buffer if any. `nil` when no path
    /// is active or the active path hasn't loaded yet.
    func buffer(for path: String) -> Buffer? { buffers[path] }
    func isLoading(_ path: String) -> Bool { loading.contains(path) }

    /// Clear all state — called on project switch.
    func clearAll() {
        for (_, task) in inflight { task.cancel() }
        inflight.removeAll()
        buffers.removeAll()
        loading.removeAll()
    }

    /// Drop one buffer (close-tab side effect). Cancels its
    /// in-flight load if one exists.
    func dropBuffer(path: String) {
        inflight[path]?.cancel()
        inflight[path] = nil
        buffers[path] = nil
        loading.remove(path)
    }

    /// Fetch + cache the buffer for `path`. No-op when a buffer
    /// already exists for the path (tab switch reuses it). Caller
    /// is expected to drive this on (cwd, path) changes.
    func ensureLoaded(cwd: String, path: String) {
        guard buffers[path] == nil, !loading.contains(path) else {
            return
        }
        loading.insert(path)
        inflight[path]?.cancel()
        inflight[path] = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.loading.remove(path) }
            do {
                let res = try await FilesService.shared.fetchContent(
                    cwd: cwd,
                    path: path
                )
                if Task.isCancelled { return }
                if res.binary {
                    self.buffers[path] = Buffer(
                        path: path,
                        content: "",
                        originalContent: "",
                        mtime: res.mtime,
                        size: res.size,
                        truncated: false,
                        isBinary: true,
                        isSaving: false,
                        error: nil
                    )
                    return
                }
                let body = res.content ?? ""
                self.buffers[path] = Buffer(
                    path: path,
                    content: body,
                    originalContent: body,
                    mtime: res.mtime,
                    size: res.size,
                    truncated: res.truncated,
                    isBinary: false,
                    isSaving: false,
                    error: nil
                )
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
                self.buffers[path] = Buffer(
                    path: path,
                    content: "",
                    originalContent: "",
                    mtime: 0,
                    size: 0,
                    truncated: false,
                    isBinary: false,
                    isSaving: false,
                    error: error.localizedDescription
                )
            }
        }
    }

    /// Force a reload from disk — discards local edits. Used by the
    /// "Reload from disk" affordance the stale-save alert offers.
    func reload(cwd: String, path: String) {
        inflight[path]?.cancel()
        buffers[path] = nil
        loading.insert(path)
        inflight[path] = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.loading.remove(path) }
            do {
                let res = try await FilesService.shared.fetchContent(
                    cwd: cwd,
                    path: path
                )
                if Task.isCancelled { return }
                let body = res.content ?? ""
                self.buffers[path] = Buffer(
                    path: path,
                    content: body,
                    originalContent: body,
                    mtime: res.mtime,
                    size: res.size,
                    truncated: res.truncated,
                    isBinary: res.binary,
                    isSaving: false,
                    error: nil
                )
            } catch {
                if Task.isCancelled { return }
                self.buffers[path] = Buffer(
                    path: path,
                    content: "",
                    originalContent: "",
                    mtime: 0,
                    size: 0,
                    truncated: false,
                    isBinary: false,
                    isSaving: false,
                    error: error.localizedDescription
                )
            }
        }
    }

    /// Push the editor's live content into the buffer dict. Called
    /// on every textDidChange. Cheap (single dict write).
    func updateContent(path: String, content: String) {
        guard var buffer = buffers[path] else { return }
        if buffer.content == content { return }
        buffer.content = content
        // Clear any sticky error — editing represents user intent
        // to recover, and stale errors muddle the next save attempt.
        buffer.error = nil
        buffers[path] = buffer
    }

    /// Save outcome surfaced to the view layer so it can show a
    /// stale-overwrite alert when needed.
    enum SaveResult {
        case ok
        case stale(currentMtime: Double, size: Int)
        case failed(String)
    }

    /// Run the save flow for `path`. Updates buffer's mtime +
    /// originalContent on success so the dirty indicator clears.
    /// On 409 stale, surfaces the conflict to the caller without
    /// overwriting; the caller decides reload-vs-force.
    func save(cwd: String, path: String, force: Bool = false) async -> SaveResult {
        guard var buffer = buffers[path] else { return .failed("not loaded") }
        guard !buffer.isBinary else { return .failed("binary file") }
        guard buffer.canEdit else { return .failed("read-only") }
        // Mark saving for UI gate.
        buffer.isSaving = true
        buffers[path] = buffer

        // Compute cwd-relative path. The save route accepts both
        // absolute + relative but the project's web client emits
        // relative; mirror that for consistency.
        let relPath = Self.relativePath(path, in: cwd)
        let expectedMtime = force ? nil : buffer.mtime

        do {
            let outcome = try await FilesService.shared.saveFile(
                cwd: cwd,
                path: relPath,
                content: buffer.content,
                expectedMtime: expectedMtime
            )
            // Re-fetch the buffer in case the user typed during the
            // save round-trip — we want to keep their post-save edits.
            guard var refreshed = buffers[path] else {
                return .failed("buffer dropped mid-save")
            }
            refreshed.isSaving = false
            switch outcome {
            case .ok(let res):
                refreshed.mtime = res.mtime
                refreshed.size = res.size
                // Roll the dirty baseline forward to whatever we
                // actually wrote — content as of save start. If the
                // user typed after that, isDirty correctly stays true.
                refreshed.originalContent = buffer.content
                refreshed.error = nil
                buffers[path] = refreshed
                return .ok
            case .stale(let currentMtime, let size):
                refreshed.error = "On-disk file changed since open."
                buffers[path] = refreshed
                return .stale(currentMtime: currentMtime, size: size)
            case .needsConfirm(_, let reason, _):
                refreshed.error = "Refused: \(reason)"
                buffers[path] = refreshed
                return .failed(reason)
            }
        } catch {
            if var refreshed = buffers[path] {
                refreshed.isSaving = false
                refreshed.error = error.localizedDescription
                buffers[path] = refreshed
            }
            return .failed(error.localizedDescription)
        }
    }

    /// Static cwd-relative helper — mirror of FileTreeView's local
    /// helper. Lives here too so the model stays self-contained.
    private static func relativePath(_ absolute: String, in cwd: String) -> String {
        let cwdSlash = cwd.hasSuffix("/") ? cwd : cwd + "/"
        if absolute.hasPrefix(cwdSlash) {
            return String(absolute.dropFirst(cwdSlash.count))
        }
        return absolute
    }
}

// MARK: - STTextView wrapper

/// Editable STTextView with line-number ruler + tree-sitter highlight
/// re-application on every content change. The Coordinator forwards
/// textDidChange into the model so dirty tracking happens push-based.
struct FileViewerNSView: NSViewRepresentable {
    /// Path that owns this buffer — the Coordinator carries it back
    /// out to the model on every textDidChange. Must match the path
    /// the model is indexing under.
    let path: String
    let content: String
    let fileExtension: String
    let isDark: Bool
    let isEditable: Bool
    /// M5: git diff markers for the current file. Keys are 1-indexed
    /// line numbers; values are the status (added / modified / removed).
    var diffLines: [Int: DiffLineStatus] = [:]
    /// Push edits back into the model. Closure (instead of an
    /// @Binding) so the wrapper stays a simple value type and the
    /// model gets the updates synchronously on the main thread.
    let onContentChange: (String, String) -> Void
    /// Phase 5d — cursor position changes. (row, col, selection
    /// length). Drives the status bar at the bottom of the viewer.
    let onSelectionChange: (Int, Int, Int) -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = STTextView.scrollableTextView()
        guard let textView = scroll.documentView as? STTextView else {
            return scroll
        }
        textView.font = NSFont.monospacedSystemFont(
            ofSize: 12,
            weight: .regular
        )
        // No soft wrap — code prefers horizontal scroll for long
        // lines. STTextView's top-level `widthTracksTextView`
        // governs this; the container size is huge so AppKit can't
        // wrap.
        textView.widthTracksTextView = false
        textView.textContainer.containerSize = NSSize(
            width: 1_000_000,
            height: CGFloat.greatestFiniteMagnitude
        )
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder

        // Line-number gutter.
        let ruler = STLineNumberRulerView(textView: textView)
        ruler.drawSeparator = true
        ruler.highlightSelectedLine = false
        scroll.verticalRulerView = ruler
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = true

        // M5: diff gutter — 3px strip on the right edge of the ruler.
        let gutterBar = DiffGutterBar(textView: textView)
        ruler.addSubview(gutterBar)
        gutterBar.autoresizingMask = [.minXMargin, .height]
        gutterBar.frame = NSRect(x: ruler.bounds.width - 3, y: 0, width: 3, height: ruler.bounds.height)
        context.coordinator.diffGutterBar = gutterBar

        // Hook STTextView's `didChangeTextIn` delegate so we can
        // mirror edits into the model on every keystroke / paste /
        // undo. STTextView has its own `STTextViewDelegate` protocol
        // (separate from AppKit's NSTextDelegate); the relevant
        // method here is `didChangeTextIn`. The same Coordinator
        // also receives `textViewDidChangeSelection` which feeds the
        // cursor row:col into the status bar.
        context.coordinator.textView = textView
        textView.delegate = context.coordinator
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let textView = scroll.documentView as? STTextView else {
            return
        }
        // Update the path the coordinator tags edits with on every
        // SwiftUI render so a tab switch retargets the change pump.
        context.coordinator.path = path
        context.coordinator.onContentChange = onContentChange
        context.coordinator.onSelectionChange = onSelectionChange

        let pathChanged = context.coordinator.lastPath != path
        let contentDiffers = textView.string != content
        let highlightInputsChanged = context.coordinator.lastExtension != fileExtension
            || context.coordinator.lastIsDark != isDark

        // Editable flag tracks the buffer's canEdit. STTextView reads
        // this on every event hop; cheap to set unconditionally.
        textView.isEditable = isEditable
        textView.isSelectable = true

        if contentDiffers {
            // Refresh the editor only when the model's content
            // genuinely differs from what's in the editor (i.e. on
            // tab switch / reload). Re-setting `string` for our own
            // edits would clobber selection + undo stack.
            context.coordinator.suppressNextChange = true
            textView.string = content
            if pathChanged {
                // Fresh tab → scroll to top so the user reads from
                // the start. Otherwise (reload) leave scroll where
                // the user had it; users hate a forced top-jump on
                // model refresh of the same file.
                textView.scroll(.zero)
            }
        }
        if contentDiffers || highlightInputsChanged || pathChanged {
            applyHighlights(to: textView)
            context.coordinator.lastExtension = fileExtension
            context.coordinator.lastIsDark = isDark
            context.coordinator.lastPath = path
        }

        // M5: propagate diff markers to the gutter bar.
        context.coordinator.diffGutterBar?.diffLines = diffLines
        context.coordinator.diffGutterBar?.needsDisplay = true
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency STTextViewDelegate {
        weak var textView: STTextView?
        weak var diffGutterBar: DiffGutterBar?
        var path: String = ""
        var onContentChange: (String, String) -> Void = { _, _ in }
        var onSelectionChange: (Int, Int, Int) -> Void = { _, _, _ in }
        var lastExtension: String = ""
        var lastIsDark: Bool = false
        var lastPath: String = ""
        /// True for the immediate next change — set when WE
        /// programmatically reset `string` (tab switch / reload) so
        /// the resulting "change" doesn't echo back into the model.
        var suppressNextChange: Bool = false

        func textView(
            _ textView: STTextView,
            didChangeTextIn affectedCharRange: NSTextRange,
            replacementString: String
        ) {
            if suppressNextChange {
                suppressNextChange = false
                return
            }
            onContentChange(path, textView.string)
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView else { return }
            let range = textView.selectedRange()
            let (row, col) = Self.rowColumn(in: textView.string, at: range.location)
            onSelectionChange(row, col, range.length)
        }

        /// Walk the string up to the caret to compute (row, col).
        /// 1-indexed, matching the convention every IDE uses in its
        /// status bar. Cheap for files under ~10 MB; for bigger
        /// files we'd want a line-index, but the file viewer caps
        /// reads via /api/files/content's maxSize so we don't hit
        /// that regime here.
        static func rowColumn(in string: String, at utf16Offset: Int) -> (Int, Int) {
            let ns = string as NSString
            let safe = max(0, min(utf16Offset, ns.length))
            var row = 1
            var lineStart = 0
            var i = 0
            while i < safe {
                let ch = ns.character(at: i)
                // CR or LF — handles both \n and \r\n endings. \r\n
                // counts the \r as the line break and skips the \n
                // so the column doesn't end up off by one.
                if ch == 10 /* \n */ {
                    row += 1
                    lineStart = i + 1
                } else if ch == 13 /* \r */ {
                    row += 1
                    lineStart = i + 1
                    if i + 1 < safe && ns.character(at: i + 1) == 10 {
                        lineStart = i + 2
                        i += 1
                    }
                }
                i += 1
            }
            let col = safe - lineStart + 1
            return (row, col)
        }
    }

    /// Run tree-sitter over the current text + apply foreground
    /// colours from HighlightTheme. Same algorithm as 5b.2 — kept
    /// here verbatim because the editable mode shares it unchanged.
    @MainActor
    private func applyHighlights(to textView: STTextView) {
        let nsString = content as NSString
        let fullRange = NSRange(location: 0, length: nsString.length)
        textView.removeAttribute(.foregroundColor, range: fullRange)
        textView.addAttributes(
            [.foregroundColor: NSColor.labelColor],
            range: fullRange
        )

        guard !fileExtension.isEmpty else { return }
        // Pass the basename too so well-known extensionless files
        // (Dockerfile, Makefile, .gitignore, .env) pick up
        // language-aware highlighting.
        let filename = (path as NSString).lastPathComponent
        guard let spans = SyntaxHighlighter.highlight(
            content: content,
            fileExtension: fileExtension,
            filename: filename
        ) else { return }
        for span in spans {
            guard let color = HighlightTheme.color(
                forCapture: span.captureName,
                isDark: isDark
            ) else { continue }
            guard span.range.location >= 0,
                  span.range.location + span.range.length <= fullRange.length
            else { continue }
            textView.addAttributes(
                [.foregroundColor: color],
                range: span.range
            )
        }
    }
}

// MARK: - Inline file viewer

/// Phase 5c — the IDE-grade file viewer. TabBar at top, header in
/// the middle, editable STTextView below. Bridge owns the open-file
/// list + active path; the model owns per-buffer state. ⌘S in the
/// editor saves through the model's save flow with mtime stale
/// detection. ⌘W closes the active tab.
struct FileViewerView: View {
    @Environment(MarvinBridge.self) private var bridge
    @State private var model = FileViewerModel()
    /// M5: per-file diff markers. Refreshed on file open and save.
    @State private var diffLines: [Int: DiffLineStatus] = [:]
    /// M6: file history popover state.
    @State private var historyPopoverOpen = false
    @State private var historyCommits: [GitCommit] = []
    @State private var historyLoading = false
    /// Stale-save alert state. Set when /api/files/write/save
    /// returns 409 stale; the alert's actions decide whether to
    /// reload (discard local) or force-overwrite the disk.
    @State private var staleConflict: StaleConflict? = nil

    private struct StaleConflict: Identifiable {
        let id = UUID()
        let path: String
    }

    var body: some View {
        // Phase 5f — the per-editor status bar moved to the global
        // AppStatusBar at the bottom of the window. Cursor row:col,
        // file kind, encoding, line ending all read from the bridge
        // there, so this view shrinks back to tab bar + header +
        // editor content. One status surface across the whole app —
        // matches Cursor / VS Code / IntelliJ.
        VStack(spacing: 0) {
            tabBar
            Divider()
            header
            Divider()
            content
        }
        .background(Color(nsColor: .textBackgroundColor))
        .preferredColorScheme(bridge.preferredColorScheme)
        .onAppear { ensureActiveLoaded() }
        .onChange(of: bridge.selectedFilePath) { _, _ in ensureActiveLoaded() }
        .onChange(of: bridge.projectWorkDir) { _, _ in
            // Project switch — drop all buffers; the open-files list
            // on the bridge clears via the project-changed flow on
            // the web side, which propagates here.
            model.clearAll()
            ensureActiveLoaded()
        }
        // Stale-save resolution alert.
        .alert(
            "File changed on disk",
            isPresented: Binding(
                get: { staleConflict != nil },
                set: { if !$0 { staleConflict = nil } }
            ),
            presenting: staleConflict
        ) { conflict in
            Button("Reload from Disk", role: .destructive) {
                if let cwd = bridge.projectWorkDir {
                    model.reload(cwd: cwd, path: conflict.path)
                }
                staleConflict = nil
            }
            Button("Overwrite") {
                Task { await performSave(force: true) }
                staleConflict = nil
            }
            Button("Cancel", role: .cancel) { staleConflict = nil }
        } message: { _ in
            Text("Another process modified this file since you opened it. Reload to discard your edits, or Overwrite to keep them and replace the on-disk version.")
        }
    }

    // MARK: - Tab bar

    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 1) {
                ForEach(bridge.openFiles, id: \.self) { path in
                    tabButton(path: path)
                }
                Spacer(minLength: 0)
            }
        }
        .frame(height: 30)
        .background(Color(nsColor: .underPageBackgroundColor))
    }

    private func tabButton(path: String) -> some View {
        let isActive = bridge.selectedFilePath == path
        let buffer = model.buffer(for: path)
        let isDirty = buffer?.isDirty ?? false
        let kind = FileTypeIcon.kind(for: path)
        return HStack(spacing: 6) {
            Image(systemName: FileTypeIcon.symbol(for: kind))
                .font(.system(size: 11))
                .foregroundStyle(FileTypeIcon.color(for: kind))
            Text((path as NSString).lastPathComponent)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(isActive ? .primary : .secondary)
                .lineLimit(1)
            // Dirty marker — IDE convention is a bullet point that
            // replaces the close × until the user hovers, but we
            // keep both visible. Simpler, less hover-state surface.
            if isDirty {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 6, height: 6)
            }
            Button {
                bridge.closeFile(path)
                model.dropBuffer(path: path)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .help("Close \((path as NSString).lastPathComponent)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(
            Rectangle()
                .fill(isActive
                      ? Color(nsColor: .textBackgroundColor)
                      : Color.clear)
        )
        .overlay(alignment: .top) {
            // Active tab gets an accent stripe along its top edge —
            // standard IDE affordance for "this is the editor's
            // current file".
            Rectangle()
                .fill(isActive ? Color.accentColor : Color.clear)
                .frame(height: 2)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if !isActive {
                bridge.setSelectedFile(path)
            }
        }
        .help(path)
    }

    // Phase 5d — tab icon resolution moved to FileTypeIcon (shared
    // with the FileTreeRow for VS Code-style consistency across the
    // tree and the open-tabs bar).

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.text")
                .foregroundStyle(.secondary)
            Text(headerSubtitle)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            if let buffer = activeBuffer, buffer.truncated {
                Text("truncated")
                    .font(.caption2.monospaced())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.yellow.opacity(0.2))
                    .foregroundStyle(.secondary)
                    .clipShape(Capsule())
            }
            if let buffer = activeBuffer, buffer.isDirty {
                Text("modified")
                    .font(.caption2.monospaced())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.18))
                    .foregroundStyle(.secondary)
                    .clipShape(Capsule())
            }
            Spacer()
            // M6: file history popover.
            if bridge.selectedFilePath != nil {
                Button {
                    historyPopoverOpen.toggle()
                    if historyPopoverOpen, let path = bridge.selectedFilePath,
                       let cwd = bridge.projectWorkDir {
                        historyLoading = true
                        historyCommits = []
                        Task {
                            historyCommits = await GitHistoryService.fileHistory(path: path, workDir: cwd)
                            historyLoading = false
                        }
                    }
                } label: {
                    Label("File History", systemImage: "clock.arrow.circlepath")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
                .help("File git history")
                .popover(isPresented: $historyPopoverOpen, arrowEdge: .bottom) {
                    FileHistoryPopover(commits: historyCommits, isLoading: historyLoading)
                }
            }
            // Phase 5e — "Open in Browser" for HTML / SVG / PDF
            // tabs. Loads the file in the native PreviewPane via
            // the bridge's openInPreview hook, which also auto-
            // toggles the preview pane on if it isn't already.
            if let path = bridge.selectedFilePath,
               isBrowserPreviewable(path: path) {
                Button {
                    bridge.openInPreview(url: "file://\(path)")
                } label: {
                    Label("Open in Browser", systemImage: "safari")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
                .help("Open this file in the native browser preview")
            }
            // Save button — visible when the active buffer is dirty
            // and editable. ⌘S binds to it via SwiftUI's
            // .keyboardShortcut so the user has both pointer + key
            // affordance.
            Button {
                Task { await performSave(force: false) }
            } label: {
                if let buffer = activeBuffer, buffer.isSaving {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Label("Save", systemImage: "square.and.arrow.down")
                }
            }
            .buttonStyle(.borderless)
            .keyboardShortcut("s", modifiers: [.command])
            .disabled(!canSave)
            .help("Save the active file (⌘S)")
            // Close-active-tab button — ⌘W keyboard shortcut. Tabs
            // each have their own × already, but ⌘W is the
            // expected macOS shortcut for "close current document".
            Button {
                if let path = bridge.selectedFilePath {
                    bridge.closeFile(path)
                    model.dropBuffer(path: path)
                }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(.borderless)
            .keyboardShortcut("w", modifiers: [.command])
            .disabled(bridge.selectedFilePath == nil)
            .help("Close active tab (⌘W)")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(nsColor: .underPageBackgroundColor))
    }

    // MARK: - Content area

    private static let imageExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif",
    ]

    @ViewBuilder
    private var content: some View {
        if let path = bridge.selectedFilePath {
            if let buffer = model.buffer(for: path) {
                if buffer.isBinary {
                    let ext = (path as NSString).pathExtension.lowercased()
                    if Self.imageExtensions.contains(ext),
                       let nsImage = NSImage(contentsOfFile: path) {
                        ImageFilePreview(image: nsImage, filename: (path as NSString).lastPathComponent)
                    } else {
                        placeholder(
                            "Binary file (\(formattedBytes(buffer.size))) — preview not available."
                        )
                    }
                } else if let err = buffer.error, !buffer.canEdit {
                    placeholder("Failed to load: \(err)")
                } else {
                    FileViewerNSView(
                        path: path,
                        content: buffer.content,
                        fileExtension: (path as NSString).pathExtension,
                        isDark: bridge.preferredColorScheme != .light,
                        isEditable: buffer.canEdit && !buffer.isSaving,
                        diffLines: diffLines,
                        onContentChange: { p, c in
                            model.updateContent(path: p, content: c)
                            // Phase 5f — line count fed to global
                            // AppStatusBar via bridge so it can show
                            // "Ln X · N lines" alongside cursor pos.
                            bridge.setCursorTotalLines(lineCount(in: c))
                        },
                        onSelectionChange: { row, col, length in
                            // Phase 5f — global AppStatusBar reads
                            // cursor pos directly off the bridge.
                            bridge.setCursor(
                                row: row,
                                col: col,
                                selectionLength: length
                            )
                        }
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .onAppear {
                        bridge.setCursorTotalLines(lineCount(in: buffer.content))
                        if let cwd = bridge.projectWorkDir {
                            Task { diffLines = await DiffGutterService.load(path: path, workDir: cwd) }
                        }
                    }
                    .onChange(of: path) { _, newPath in
                        diffLines = [:]
                        if let cwd = bridge.projectWorkDir {
                            Task { diffLines = await DiffGutterService.load(path: newPath, workDir: cwd) }
                        }
                    }
                }
            } else if model.isLoading(path) {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                placeholder("Select a file in the tree.")
            }
        } else {
            placeholder("No file open.")
        }
    }

    // MARK: - Helpers

    private var activeBuffer: FileViewerModel.Buffer? {
        guard let path = bridge.selectedFilePath else { return nil }
        return model.buffer(for: path)
    }

    private var canSave: Bool {
        guard let buffer = activeBuffer else { return false }
        return buffer.isDirty && buffer.canEdit && !buffer.isSaving
    }

    private func isBrowserPreviewable(path: String) -> Bool {
        let ext = (path as NSString).pathExtension.lowercased()
        return ["html", "htm", "svg", "pdf"].contains(ext)
    }

    private var headerSubtitle: String {
        bridge.selectedFilePath ?? "—"
    }

    private func placeholder(_ text: String) -> some View {
        VStack {
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func formattedBytes(_ size: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(size))
    }

    // Phase 5f — status bar moved to global AppStatusBar. The line
    // count helper stays here because the editor's onContentChange
    // callback feeds it into bridge.setCursorTotalLines on every
    // edit so the global bar tracks the active buffer.
    private func lineCount(in s: String) -> Int {
        if s.isEmpty { return 1 }
        var count = 1
        for ch in s.unicodeScalars where ch.value == 10 { count += 1 }
        return count
    }

    private func ensureActiveLoaded() {
        guard let cwd = bridge.projectWorkDir, !cwd.isEmpty,
              let path = bridge.selectedFilePath, !path.isEmpty else {
            return
        }
        model.ensureLoaded(cwd: cwd, path: path)
    }

    private func performSave(force: Bool) async {
        guard let cwd = bridge.projectWorkDir,
              let path = bridge.selectedFilePath else { return }
        let result = await model.save(cwd: cwd, path: path, force: force)
        switch result {
        case .ok:
            // Refresh diff markers after a clean save — the new
            // content may have moved or closed hunks.
            diffLines = await DiffGutterService.load(path: path, workDir: cwd)
        case .stale:
            staleConflict = StaleConflict(path: path)
        case .failed:
            // Error is already surfaced on the buffer; the inline
            // header band picks it up via activeBuffer.error.
            break
        }
    }
}

// MARK: - Image file preview

/// Scrollable, fit-to-width image preview for binary image files.
/// Replaces the "Binary file — preview not available" placeholder
/// when the selected file has an image extension (png/jpg/webp/etc).
private struct ImageFilePreview: View {
    let image: NSImage
    let filename: String

    @State private var scale: CGFloat = 1.0

    var body: some View {
        GeometryReader { geo in
            ScrollView([.horizontal, .vertical]) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(
                        width: image.size.width * scale,
                        height: image.size.height * scale
                    )
                    .padding(16)
            }
            .onAppear {
                // Fit the image within the available width on first render.
                let ratio = geo.size.width / max(1, image.size.width)
                scale = min(1.0, ratio - 0.05)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            HStack(spacing: 6) {
                Button { scale = max(0.1, scale - 0.25) } label: {
                    Image(systemName: "minus.magnifyingglass")
                }
                Text("\(Int(scale * 100))%")
                    .font(.system(size: 11, design: .monospaced))
                Button { scale = min(8.0, scale + 0.25) } label: {
                    Image(systemName: "plus.magnifyingglass")
                }
                Button { scale = 1.0 } label: {
                    Text("1:1").font(.system(size: 11, design: .monospaced))
                }
                Text("\(Int(image.size.width))×\(Int(image.size.height))")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.thinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(10)
        }
        .background(Color(nsColor: .underPageBackgroundColor))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
