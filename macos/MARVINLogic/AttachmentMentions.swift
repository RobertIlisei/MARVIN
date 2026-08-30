// AttachmentMentions — find the image attachments inside a sent message.
//
// A pasted image becomes an `@/abs/path.png` token in the message text
// (`ChatAttachment.messageFragment`), and that token is ALL the sent message
// carries. The composer chip renders a real thumbnail, but the sent bubble
// rendered the raw path — so the preview vanished at exactly the moment the
// user pressed send (user, 2026-08-30: "I can see an image, but when the agent
// starts working I see it as an attachment with the path and name, not the
// thumbnail as I was expecting").
//
// Pure (ADR-0022): this splits text, it does not touch the filesystem. Whether
// a path actually resolves to an image is the view's problem — it asks
// `AttachmentThumbnail` and falls back to the plain token when it gets nil, so
// a mention of a deleted or non-image file still reads correctly.

import Foundation

public enum AttachmentMentions {
    /// Extensions worth previewing. Matches the paste path's own list
    /// (`ClipboardImage`), minus the formats AppKit will not thumbnail.
    public static let imageExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tiff", "tif", "bmp",
    ]

    public enum Segment: Equatable {
        case text(String)
        case image(path: String)
    }

    /// Split message text into prose and image mentions, in order.
    ///
    /// A mention is `@` + an absolute path with an image extension. The token
    /// ends at whitespace, so a path containing spaces is NOT matched — those
    /// arrive from the file picker rather than the paste path, which writes
    /// UUID names under `~/.marvin/attachments/`. Treating such a path as
    /// prose is the safe direction: the user still sees the full path.
    public static func split(_ text: String) -> [Segment] {
        var segments: [Segment] = []
        var pending = ""
        var index = text.startIndex

        func flushPending() {
            if !pending.isEmpty {
                segments.append(.text(pending))
                pending = ""
            }
        }

        while index < text.endIndex {
            guard text[index] == "@" else {
                pending.append(text[index])
                index = text.index(after: index)
                continue
            }
            // A mention must start a token — `foo@/bar.png` is an email-ish
            // string, not an attachment.
            let atLineStart = index == text.startIndex
            let precededBySpace = !atLineStart && text[text.index(before: index)].isWhitespace
            let pathStart = text.index(after: index)
            guard
                atLineStart || precededBySpace,
                pathStart < text.endIndex,
                text[pathStart] == "/"
            else {
                pending.append(text[index])
                index = text.index(after: index)
                continue
            }
            let pathEnd = text[pathStart...].firstIndex(where: { $0.isWhitespace }) ?? text.endIndex
            let path = String(text[pathStart..<pathEnd])
            let ext = (path as NSString).pathExtension.lowercased()
            if imageExtensions.contains(ext) {
                flushPending()
                segments.append(.image(path: path))
                index = pathEnd
            } else {
                pending.append(text[index])
                index = text.index(after: index)
            }
        }
        flushPending()
        return segments
    }

    /// True when the text carries at least one image mention — lets a view
    /// keep its plain-Text fast path for the overwhelmingly common case.
    public static func containsImage(_ text: String) -> Bool {
        split(text).contains { if case .image = $0 { return true } else { return false } }
    }
}
