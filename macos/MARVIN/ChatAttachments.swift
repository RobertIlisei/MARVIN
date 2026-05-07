// ChatAttachments — Phase 5e. Compact toolbar that sits above the
// chat input bar to attach files, paste images, and reference text
// snippets. Each attachment becomes a fragment in the message text
// the chat send pipeline already understands:
//
//   • File mention      →  "@/abs/path/to/file"
//   • Image paste       →  "@/abs/path/to/saved.png"
//   • Text snippet      →  fenced code block ```\n<text>\n```
//
// Because every attachment serializes into the message string, we
// don't need an `attachments[]` field on /api/chat. The Claude
// agent sees `@<path>` and uses its Read / Image tools to ingest
// the content. No backend changes required.
//
// IDE convention this matches:
//   • Cursor / Continue / Aider / Zed: + button beside the input
//     opens a file picker. @-trigger in the input opens an inline
//     mention picker. Pasting from the screenshot keyboard auto-
//     attaches.
//   • The user explicitly asked for "tag files and text and paste
//     images" — this delivers all three.

import AppKit
import SwiftUI

/// Pre-send attachments collected by the user. Each one renders as
/// a chip above the input and serializes into the message text on
/// submit. State is owned by the parent (ChatPreviewView) so the
/// list survives the input editor's re-render cycle.
struct ChatAttachment: Identifiable, Equatable {
    enum Kind: Equatable {
        case file(absPath: String)
        case image(absPath: String)
        case snippet(label: String, body: String)
    }
    let id = UUID()
    let kind: Kind

    /// Display text for the chip.
    var label: String {
        switch kind {
        case .file(let p):
            return (p as NSString).lastPathComponent
        case .image(let p):
            return (p as NSString).lastPathComponent
        case .snippet(let label, _):
            return label
        }
    }

    var iconName: String {
        switch kind {
        case .file(let p):
            return FileTypeIcon.symbol(for: FileTypeIcon.kind(for: p))
        case .image:
            return "photo"
        case .snippet:
            return "text.alignleft"
        }
    }

    var iconTint: Color {
        switch kind {
        case .file(let p):
            return FileTypeIcon.color(for: FileTypeIcon.kind(for: p))
        case .image:
            return Color(red: 0.55, green: 0.75, blue: 0.55)
        case .snippet:
            return .accentColor
        }
    }

    /// Serialise into a message-text fragment.
    var messageFragment: String {
        switch kind {
        case .file(let absPath), .image(let absPath):
            return "@\(absPath)"
        case .snippet(let label, let body):
            return "```\n# \(label)\n\(body)\n```"
        }
    }
}

// MARK: - Attachments bar

/// Horizontal bar with a `+` button + chip list. Sits directly
/// above the ChatInputBar.
struct ChatAttachmentsBar: View {
    @Environment(MarvinBridge.self) private var bridge
    @Binding var attachments: [ChatAttachment]
    @State private var pickerOpen = false

    var body: some View {
        VStack(spacing: 4) {
            // Phase 5f — Cursor-style: a single small icon button on
            // the left, attachment chips inline. The `@ Mention`
            // button collapsed into the editor itself (typing `@`
            // at a word boundary opens the same picker), so one
            // entry point is enough. Borderless icon = matches the
            // rest of the chat surface; bordered controls read as
            // heavy in this context.
            HStack(spacing: 4) {
                iconButton(
                    icon: "paperclip",
                    help: "Attach file (or type @ in the message)"
                ) {
                    pickerOpen = true
                }
                .keyboardShortcut("a", modifiers: [.command, .shift])
                .disabled(bridge.projectWorkDir == nil)
                if !attachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(attachments) { att in
                                chip(att)
                            }
                        }
                    }
                    .frame(height: 26)
                }
                Spacer()
            }
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            // Drag a file from Finder / the file tree directly onto
            // the chat input — promotes to an attachment chip.
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in
                        attachments.append(
                            ChatAttachment(kind: .file(absPath: url.path))
                        )
                    }
                }
            }
            return !providers.isEmpty
        }
        .sheet(isPresented: $pickerOpen) {
            FileMentionPicker { picked in
                if let picked {
                    attachments.append(ChatAttachment(kind: .file(absPath: picked)))
                }
                pickerOpen = false
            }
            .environment(bridge)
        }
    }

    /// Small borderless icon button — Cursor / VS Code chat style.
    /// Hover state via `.buttonStyle(.plain)` + a soft fill on hover
    /// (achieved with `.background` + `.onHover`). Phase 5f.
    private func iconButton(
        icon: String,
        help: String,
        action: @escaping () -> Void
    ) -> some View {
        IconBarButton(icon: icon, help: help, action: action)
    }

    private func chip(_ att: ChatAttachment) -> some View {
        HStack(spacing: 4) {
            Image(systemName: att.iconName)
                .font(.system(size: 10))
                .foregroundStyle(att.iconTint)
            Text(att.label)
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(1)
            Button {
                attachments.removeAll { $0.id == att.id }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
            .buttonStyle(.borderless)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color(nsColor: .underPageBackgroundColor))
                .overlay(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                )
        )
    }
}

// MARK: - Borderless icon button

/// Borderless icon button used by the chat input's left rail —
/// Cursor / VS Code style. Plain SF Symbol with a soft hover fill.
/// Pulled out as its own struct so the hover @State works (a closure
/// passed into a function loses its identity each render).
private struct IconBarButton: View {
    let icon: String
    let help: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(.secondary)
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(hovering
                              ? Color(nsColor: .underPageBackgroundColor)
                              : .clear)
                )
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
    }
}

// MARK: - File mention picker

/// Reuses the QuickOpen tree-walk + filter logic but returns the
/// chosen path through a callback instead of opening it in a tab.
/// Keeps the IDE feel consistent — same fuzzy filter, same icons.
struct FileMentionPicker: View {
    @Environment(MarvinBridge.self) private var bridge
    @Environment(\.dismiss) private var dismiss

    let onPick: (String?) -> Void

    @State private var query: String = ""
    @State private var allFiles: [String] = []
    @State private var loadError: String? = nil
    @State private var selection: String? = nil
    @FocusState private var queryFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "at")
                    .foregroundStyle(.secondary)
                TextField("Mention a file…", text: $query)
                    .textFieldStyle(.plain)
                    .focused($queryFocused)
                    .onSubmit {
                        if let path = selection ?? filtered.first {
                            onPick(path)
                        }
                    }
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .font(.system(size: 14))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color(nsColor: .underPageBackgroundColor))
            Divider()
            if let err = loadError {
                Text("Failed to load tree: \(err)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.red)
                    .padding()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(filtered.prefix(150), id: \.self) { path in
                            row(path: path)
                        }
                    }
                }
                .frame(height: 360)
            }
            HStack {
                Text("\(filtered.count) match\(filtered.count == 1 ? "" : "es")")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                Spacer()
                Button("Cancel") { onPick(nil) }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color(nsColor: .underPageBackgroundColor))
        }
        .frame(width: 560)
        .onAppear {
            queryFocused = true
            Task { await loadTree() }
        }
        .onKeyPress(.escape) {
            onPick(nil)
            return .handled
        }
        .onKeyPress(.upArrow) {
            moveSelection(-1)
            return .handled
        }
        .onKeyPress(.downArrow) {
            moveSelection(1)
            return .handled
        }
    }

    private func row(path: String) -> some View {
        let kind = FileTypeIcon.kind(for: path)
        let name = (path as NSString).lastPathComponent
        let parent = (path as NSString).deletingLastPathComponent
        let cwd = bridge.projectWorkDir ?? ""
        let displayParent = parent.hasPrefix(cwd)
            ? String(parent.dropFirst(cwd.count).drop(while: { $0 == "/" }))
            : parent
        let isSelected = selection == path
        return Button {
            onPick(path)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: FileTypeIcon.symbol(for: kind))
                    .foregroundStyle(FileTypeIcon.color(for: kind))
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(name)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(.primary)
                    if !displayParent.isEmpty {
                        Text(displayParent)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(isSelected
                        ? Color.accentColor.opacity(0.18)
                        : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var filtered: [String] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return allFiles }
        var nameMatches: [String] = []
        var pathMatches: [String] = []
        for p in allFiles {
            let name = (p as NSString).lastPathComponent.lowercased()
            if name.contains(q) {
                nameMatches.append(p)
            } else if p.lowercased().contains(q) {
                pathMatches.append(p)
            }
        }
        return nameMatches + pathMatches
    }

    private func moveSelection(_ delta: Int) {
        let list = Array(filtered.prefix(150))
        guard !list.isEmpty else { return }
        if let current = selection, let i = list.firstIndex(of: current) {
            let next = max(0, min(list.count - 1, i + delta))
            selection = list[next]
        } else {
            selection = list[delta > 0 ? 0 : list.count - 1]
        }
    }

    private func loadTree() async {
        guard let cwd = bridge.projectWorkDir else {
            loadError = "no project active"
            return
        }
        do {
            let response = try await FilesService.shared.fetchTree(cwd: cwd)
            var collected: [String] = []
            collected.reserveCapacity(2_000)
            walk(nodes: response.tree, into: &collected)
            allFiles = collected
        } catch {
            loadError = "\(error)"
        }
    }

    private func walk(nodes: [FileNode], into out: inout [String]) {
        for node in nodes {
            if node.isDirectory {
                if let children = node.children { walk(nodes: children, into: &out) }
            } else {
                out.append(node.path)
            }
        }
    }
}

// MARK: - Image paste helper

/// Persist a clipboard image (or any NSImage) to disk under
/// ~/.marvin/attachments/<uuid>.png and return the absolute path.
/// Used by the chat input's overridden paste handler so the user
/// can ⌘V a screenshot directly into the message.
@MainActor
enum ClipboardImage {
    /// Folder where pasted images get stored. Per-project would be
    /// nicer but the bridge doesn't expose a stable per-project
    /// data dir today; the global folder is fine for the first cut.
    static var saveDirectory: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dir = home
            .appendingPathComponent(".marvin", isDirectory: true)
            .appendingPathComponent("attachments", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true
        )
        return dir
    }

    /// Pull an image off the pasteboard. Resolution order matters:
    ///
    /// 1. **Image file URL** — Universal Clipboard from iPhone /
    ///    Continuity Camera / drag-from-Photos often puts a file URL
    ///    on the pasteboard alongside a generic preview thumbnail.
    ///    Read the file's actual bytes so we get the screenshot, not
    ///    a 1024×1024 file-type icon.
    /// 2. **Raw `.png` / HEIC / JPEG / TIFF data** — direct image
    ///    bytes on the pasteboard. Real screenshots from macOS's
    ///    own ⌘⇧4 land here.
    /// 3. **`NSImage(pasteboard:)` fallback** — last resort. This
    ///    initialiser walks the pasteboard's registered classes and
    ///    can match a generic file-icon representation when the
    ///    real image data isn't surfaced through (1) or (2). Without
    ///    the earlier checks, this would silently win and the chat
    ///    would attach the icon every time the source app put one
    ///    on the clipboard — Phase 5f bug.
    static func fromPasteboard(_ pb: NSPasteboard) -> NSImage? {
        // 1. File URL pointing to an image. Read the file directly.
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: nil) as? [URL] {
            let imageExts: Set<String> = [
                "png", "jpg", "jpeg", "gif", "webp",
                "heic", "heif", "bmp", "tiff", "tif"
            ]
            for url in urls where url.isFileURL {
                let ext = url.pathExtension.lowercased()
                guard imageExts.contains(ext) else { continue }
                if let data = try? Data(contentsOf: url),
                   let image = NSImage(data: data),
                   image.size.width > 0 && image.size.height > 0 {
                    return image
                }
            }
        }

        // 2a. Try every type currently on the pasteboard whose name
        //     is a screenshot variant. Apple has shipped at least
        //     `com.apple.screenshot.png` and `com.apple.screenshot`;
        //     macOS 26 may add new ones. We prefix-match on
        //     `com.apple.screenshot` so future variants land in this
        //     branch automatically without another redeploy.
        if let types = pb.types {
            for type in types where type.rawValue.hasPrefix("com.apple.screenshot") {
                if let data = pb.data(forType: type),
                   let image = NSImage(data: data),
                   image.size.width > 0 && image.size.height > 0 {
                    return image
                }
            }
        }

        // 2b. Standard image types — PNG/HEIC/JPEG/TIFF. Real
        //     screenshots from ⌃⌘⇧4-to-clipboard land here too on
        //     `public.png`; non-screenshot copies (Photos, Universal
        //     Clipboard) usually carry these.
        let rawTypes: [NSPasteboard.PasteboardType] = [
            .png,
            NSPasteboard.PasteboardType("public.png"),
            NSPasteboard.PasteboardType("public.heic"),
            NSPasteboard.PasteboardType("public.heif"),
            NSPasteboard.PasteboardType("public.jpeg"),
            .tiff,
            NSPasteboard.PasteboardType("public.tiff"),
        ]
        for type in rawTypes {
            if let data = pb.data(forType: type),
               let image = NSImage(data: data),
               image.size.width > 0 && image.size.height > 0 {
                return image
            }
        }

        // 3. Last resort — pasteboard-init NSImage. Filter out tiny
        //    images (≤48 pt) which are almost certainly file-type icons,
        //    not real content the user wants to attach.
        if let img = NSImage(pasteboard: pb),
           img.size.width > 48 && img.size.height > 48 {
            return img
        }
        return nil
    }

    /// Save `image` as PNG and return its file URL. Fails silently
    /// (returns nil) if the encode or write doesn't go through —
    /// keeps the paste path resilient.
    static func savePNG(_ image: NSImage) -> URL? {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:])
        else { return nil }
        let url = saveDirectory.appendingPathComponent("\(UUID().uuidString).png")
        do {
            try png.write(to: url)
            return url
        } catch {
            return nil
        }
    }
}
