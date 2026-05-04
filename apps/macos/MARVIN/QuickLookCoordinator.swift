// QuickLookCoordinator — Phase 3h. macOS Quick Look preview for
// the native file tree.
//
// QLPreviewPanel is an AppKit singleton — `shared()` returns the
// app-global panel; the caller's only job is to:
//   1. Provide a data source (the URL to preview).
//   2. Call `makeKeyAndOrderFront(nil)` to show it.
// Subsequent space-bar presses on the panel iterate the data
// source. We only ever vend one URL at a time (the currently-
// selected file in the tree), so the data source is trivial.
//
// ## Why a singleton coordinator
//
// QLPreviewPanel.dataSource is a weak reference, which means the
// panel will null it out the moment its owner deallocates. A
// `@State` view-model on the FileTreeView would deallocate as soon
// as the view goes out of scope (e.g. tab switch). A singleton
// keeps the data source alive for the panel's lifetime. The trade-
// off is that we share one panel across the app — fine because
// macOS Quick Look is itself a singleton resource.

import AppKit
import Quartz
import SwiftUI

/// Adapts a file URL to QLPreviewItem. `URL` is a Swift value type
/// so it can't conform to the class-protocol QLPreviewItem directly
/// — we wrap in an NSObject subclass that holds the URL and vends
/// the QLPreviewItem-required properties. (NSURL also conforms
/// natively but using it in Swift code adds unnecessary toll-free
/// bridging dance compared to a tiny purpose-built wrapper.)
private final class FileQuickLookItem: NSObject, QLPreviewItem {
    let url: URL
    init(url: URL) { self.url = url }
    var previewItemURL: URL? { url }
    var previewItemTitle: String? { url.lastPathComponent }
}

/// App-global Quick Look coordinator. One URL, one panel. Set the
/// URL via `show(url:)` and the panel slides on; subsequent
/// `show(url:)` calls update the preview without closing.
@MainActor
final class QuickLookCoordinator: NSObject, @preconcurrency QLPreviewPanelDataSource, @preconcurrency QLPreviewPanelDelegate {
    static let shared = QuickLookCoordinator()

    private var url: URL?

    /// Show (or update) Quick Look for `url`. No-op when the
    /// panel is unavailable (headless / sandboxed test runs).
    func show(url: URL) {
        self.url = url
        guard let panel = QLPreviewPanel.shared() else { return }
        panel.dataSource = self
        panel.delegate = self
        // reloadData picks up the new URL when the panel is
        // already visible (subsequent space-bar on a different
        // row); makeKeyAndOrderFront opens it the first time.
        if panel.isVisible {
            panel.reloadData()
        } else {
            panel.makeKeyAndOrderFront(nil)
        }
    }

    /// Hide the panel — called from the row's "Hide preview"
    /// context-menu entry, mostly defensive (esc / panel close
    /// button does the same thing without going through us).
    func hide() {
        guard let panel = QLPreviewPanel.shared(), panel.isVisible else { return }
        panel.orderOut(nil)
    }

    // MARK: - QLPreviewPanelDataSource

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
        url == nil ? 0 : 1
    }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        // We only ever vend one item; index is always 0 here.
        // Wrap in FileQuickLookItem rather than handing back a raw
        // URL — see the wrapper's docstring for why.
        guard let url else { return nil }
        return FileQuickLookItem(url: url)
    }
}
