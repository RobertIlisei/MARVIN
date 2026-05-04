// LeftPane — Phase 3e. Two-tab native sidebar: Files | Source
// Control. Mirrors the web app's `LeftColumnTabs` shape so users
// switching between surfaces don't have to remap the affordance.
//
// The picker state lives in this view, not in either child model,
// because the tab choice is a UI concern that doesn't affect what
// either child fetches — both keep auto-loading on bridge changes
// regardless of which tab is currently selected. That trades a
// tiny bit of background work (the inactive child still polls its
// endpoint) for crisp tab switches with no fetch flash.

import SwiftUI

private enum LeftPaneTab: String, CaseIterable, Identifiable {
    case files
    case sourceControl
    var id: String { rawValue }

    /// Shown in the segmented control. Capitalised words match the
    /// web's "Files" / "Source Control" wording so the affordance
    /// is identical visually.
    var label: String {
        switch self {
        case .files: return "Files"
        case .sourceControl: return "Source Control"
        }
    }

    /// SF Symbol used in the picker. doc.text for files (matches
    /// macOS Finder), arrow.triangle.branch for SCM (matches Xcode
    /// + Apple's Source Control dock icon).
    var systemImage: String {
        switch self {
        case .files: return "doc.text"
        case .sourceControl: return "arrow.triangle.branch"
        }
    }
}

struct LeftPane: View {
    /// Picker selection persists across tab switches but not across
    /// app restarts — `@State` is sufficient. Phase 3e doesn't store
    /// it in @AppStorage because the daily-driver expectation is
    /// "files on launch, switch when you want SCM". Promote to
    /// AppStorage if user feedback says otherwise.
    @State private var tab: LeftPaneTab = .files

    var body: some View {
        VStack(spacing: 0) {
            tabPicker
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            Divider()
            // Both views are kept in the tree (just one is hidden)
            // so child @State (e.g. selectedPath, fetched response)
            // survives a tab switch. The opacity-based toggle is
            // 60fps-cheap; the alternative — `if/else` swapping —
            // would re-create the view on every flip and lose state.
            ZStack {
                FileTreeView()
                    .opacity(tab == .files ? 1 : 0)
                    .allowsHitTesting(tab == .files)
                SourceControlView()
                    .opacity(tab == .sourceControl ? 1 : 0)
                    .allowsHitTesting(tab == .sourceControl)
            }
        }
    }

    private var tabPicker: some View {
        Picker("Left pane tab", selection: $tab) {
            ForEach(LeftPaneTab.allCases) { t in
                Label(t.label, systemImage: t.systemImage)
                    .labelStyle(.titleAndIcon)
                    .tag(t)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }
}
