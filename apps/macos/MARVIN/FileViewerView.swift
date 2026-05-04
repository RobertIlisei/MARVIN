// FileViewerView — Phase 5a foundation. AppKit-backed read-only file
// viewer wrapped in NSViewRepresentable, hosted inside a side preview
// Window scene during 5a. Reads file content via FilesService
// (Phase 3a) and observes `bridge.selectedFilePath` so a click in the
// native file tree updates the viewer in real time.
//
// 5b adds STTextView + tree-sitter syntax highlighting; 5c promotes
// the viewer from this preview window into the WebView's work-pane
// and adds editing + ⌘S save. Phase 5a is deliberately read-only and
// chrome-light — the goal is to validate the read path + the bridge
// wiring + the SwiftUI host shape before adding language tooling.
//
// ## Why AppKit's NSTextView, not SwiftUI's TextEditor
//
// SwiftUI TextEditor is a terrible code viewer: no monospace control,
// no horizontal scroll for long lines, no programmatic scroll-to-
// position, no selection notifications. AppKit NSTextView (and its
// scrollableTextView() factory) gives us all of those out of the box.
// We pay the NSViewRepresentable boilerplate cost once and keep
// everything else clean.
//
// Switching to STTextView at 5b is a one-screen edit — the
// NSTextView surface area we use here is the same surface STTextView
// implements with extra editor-shaped behaviour on top.

import AppKit
import STTextView
import SwiftUI

// MARK: - View-model

/// State machine for the file viewer's display. Drives a switch in
/// the view body — empty / loading / binary / loaded / failed each
/// render a different inner content. @Observable so SwiftUI tracks
/// the state field changes.
@Observable
@MainActor
final class FileViewerModel {
    enum DisplayState: Equatable {
        case empty
        case loading(path: String)
        case binary(size: Int, path: String)
        case loaded(content: String, path: String, truncated: Bool)
        case failed(message: String, path: String)
    }

    private(set) var state: DisplayState = .empty

    /// Outstanding load task, retained so a fast re-selection (user
    /// clicks file A, then file B 50 ms later) cancels A's response
    /// before it lands and overwrites B's.
    private var loadingTask: Task<Void, Never>?

    /// Fetch + display the file at `(cwd, path)`. Idempotent against
    /// the currently-loaded path: re-issuing for the same path while
    /// loading is a no-op (we already have the in-flight task);
    /// re-issuing for the same loaded path skips the round-trip.
    /// Caller is expected to gate via the bridge observers; this
    /// inner guard is the safety net.
    func load(cwd: String, path: String) {
        // Same path already in flight or loaded → nothing to do.
        switch state {
        case .loading(let p) where p == path:
            return
        case .loaded(_, let p, _) where p == path:
            return
        default:
            break
        }

        loadingTask?.cancel()
        state = .loading(path: path)
        loadingTask = Task { @MainActor in
            do {
                let response = try await FilesService.shared.fetchContent(
                    cwd: cwd,
                    path: path
                )
                if Task.isCancelled { return }
                if response.binary {
                    state = .binary(size: response.size, path: path)
                    return
                }
                if let content = response.content {
                    state = .loaded(
                        content: content,
                        path: path,
                        truncated: response.truncated
                    )
                    return
                }
                state = .failed(
                    message: "No content returned by /api/files/content.",
                    path: path
                )
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
                state = .failed(
                    message: error.localizedDescription,
                    path: path
                )
            }
        }
    }

    /// Reset to empty state (no file selected, project closed, etc.).
    /// Cancels any in-flight load so a stale response doesn't
    /// overwrite the empty state.
    func clear() {
        loadingTask?.cancel()
        loadingTask = nil
        state = .empty
    }
}

// MARK: - STTextView wrapper

/// Read-only STTextView in an NSScrollView with a line-number ruler,
/// displaying `content` in a monospaced system font. STTextView is
/// the TextKit 2-backed text view from krzyzanowskim/STTextView —
/// drop-in API-compatible with NSTextView for the surface area we
/// use (string / isEditable / font / scrollableTextView), with
/// editor-friendly extras (line numbers, soft wrap, future tree-
/// sitter highlight bindings) baked in.
///
/// 5b.2 onward layers tree-sitter syntax highlighting on top via
/// `addAttributes(_:range:)`; the read-only viewer surface itself
/// stays unchanged.
///
/// updateNSView only writes when `string` differs to avoid resetting
/// scroll position + cursor on every SwiftUI re-render.
struct FileViewerNSView: NSViewRepresentable {
    let content: String

    func makeNSView(context: Context) -> NSScrollView {
        // STTextView ships its own scrollableTextView() factory that
        // returns an NSScrollView wrapping an STTextView. Same shape
        // as NSTextView's factory; the wrapped view is an STTextView
        // instance so we cast to that.
        let scroll = STTextView.scrollableTextView()
        guard let textView = scroll.documentView as? STTextView else {
            return scroll
        }
        textView.isEditable = false
        textView.isSelectable = true
        textView.font = NSFont.monospacedSystemFont(
            ofSize: 12,
            weight: .regular
        )
        // Disable line wrap — code wants horizontal scroll for long
        // lines, not soft wrap. STTextView surfaces a top-level
        // `widthTracksTextView` flag (1.0.0 doesn't expose
        // `textContainerInset` yet — it's annotated as a TODO in the
        // upstream source). The container's own size is huge so
        // AppKit doesn't wrap; the scroll view shows a horizontal
        // scroller when content overflows.
        textView.widthTracksTextView = false
        textView.textContainer.containerSize = NSSize(
            width: 1_000_000,
            height: CGFloat.greatestFiniteMagnitude
        )
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder

        // Line-number gutter. STLineNumberRulerView is the NSRulerView
        // subclass STTextView ships for this. Attaching follows the
        // standard Cocoa idiom: install on the scroll view as the
        // vertical ruler, flip rulersVisible.
        let ruler = STLineNumberRulerView(textView: textView)
        ruler.drawSeparator = true
        ruler.highlightSelectedLine = false
        scroll.verticalRulerView = ruler
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = true

        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let textView = scroll.documentView as? STTextView else {
            return
        }
        if textView.string != content {
            textView.string = content
            // Move scroll back to origin on a fresh content load so
            // the user starts reading from the top, not from where
            // the last file's scroll was.
            textView.scroll(.zero)
        }
    }
}

// MARK: - Preview window

/// Phase 5a — the file viewer in a standalone "File Viewer (preview)"
/// Window scene. Selecting a file in the native tree (FileTreeView)
/// updates this viewer via `bridge.selectedFilePath`. The WebView's
/// Monaco still receives the same `select-file` dispatch in parallel,
/// so the user can side-by-side the two surfaces during 5a's
/// validation phase.
///
/// 5c retires this Window scene and promotes the viewer inline,
/// matching the 4c→4g progression the brain went through.
struct FileViewerPreviewView: View {
    @Environment(MarvinBridge.self) private var bridge
    @State private var model = FileViewerModel()

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .frame(minWidth: 360, idealWidth: 720, minHeight: 280, idealHeight: 480)
        .preferredColorScheme(bridge.preferredColorScheme)
        .onAppear { syncFromBridge() }
        .onChange(of: bridge.selectedFilePath) { _, _ in syncFromBridge() }
        .onChange(of: bridge.projectWorkDir) { _, _ in syncFromBridge() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.text")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text("File Viewer — Phase 5 preview")
                    .font(.callout.weight(.semibold))
                Text(headerSubtitle)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            if case .loaded(_, _, true) = model.state {
                // Truncation badge — sidecar capped the read at
                // FileContentResponse.maxSize. The user might want
                // to know the rest is missing. Same convention the
                // web Monaco uses (small tag in the title).
                Text("truncated")
                    .font(.caption2.monospaced())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.yellow.opacity(0.2))
                    .foregroundStyle(.secondary)
                    .clipShape(Capsule())
            }
        }
        .padding(12)
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .empty:
            placeholder("Select a file in the tree.")
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .binary(let size, _):
            placeholder(
                "Binary file (\(formattedBytes(size))) — preview not available."
            )
        case .failed(let msg, _):
            placeholder("Failed to load: \(msg)")
        case .loaded(let content, _, _):
            FileViewerNSView(content: content)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
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

    /// Header subtitle pulls the most-relevant path:
    /// loaded > loading > binary > failed > the bridge selection.
    /// Falls back to "—" when nothing's selected at all.
    private var headerSubtitle: String {
        switch model.state {
        case .loaded(_, let path, _),
             .loading(let path),
             .binary(_, let path),
             .failed(_, let path):
            return path
        case .empty:
            return bridge.selectedFilePath ?? "—"
        }
    }

    /// React to bridge changes: load when (cwd, path) both present;
    /// clear otherwise. The model's load() is itself idempotent
    /// against the current state, so redundant fires are no-ops.
    private func syncFromBridge() {
        guard let cwd = bridge.projectWorkDir,
              !cwd.isEmpty,
              let path = bridge.selectedFilePath,
              !path.isEmpty else {
            model.clear()
            return
        }
        model.load(cwd: cwd, path: path)
    }

    /// Pretty-print a byte count for the binary-file placeholder.
    /// ByteCountFormatter does the bytes → KB / MB conversion with
    /// the locale's number formatter; we use the file-friendly style
    /// (1.2 MB rather than 1.2 MiB).
    private func formattedBytes(_ size: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(size))
    }
}
