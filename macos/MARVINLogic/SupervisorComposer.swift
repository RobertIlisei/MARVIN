import Foundation

/// ADR-0129 — one image of a user message, as `GET /api/supervisor/message`
/// returns it. `path` is added by the route for this app (same machine); the
/// stored record carries none.
public struct SupervisorChatAttachment: Decodable, Equatable, Hashable, Sendable {
    public let id: String
    public let mediaType: String
    public let bytes: Int
    public let path: String?
    public init(id: String, mediaType: String, bytes: Int, path: String?) {
        self.id = id; self.mediaType = mediaType; self.bytes = bytes; self.path = path
    }
}

/// ADR-0129 — the Supervisor tab's composer rules. The limits are the route's
/// (`supervisor-messages.ts`); an image, like text, is never consent.
public enum SupervisorComposer {
    public static let maxImages = 4
    /// Decoded bytes per image the route accepts (`MAX_IMAGE_BYTES`).
    public static let maxImageBytes = 3_750_000
    /// The long edge images are scaled to before they are sent — past it the
    /// model downsamples anyway, so the extra pixels cost bytes and buy nothing.
    public static let longEdge = 1_568

    /// The text the composer may send, trimmed; empty is allowed beside an image. nil when it may not send.
    public static func sendable(_ text: String, images: Int) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard images <= maxImages, t.count <= SupervisorChat.maxMessageChars else { return nil }
        if t.isEmpty { return images > 0 ? "" : nil }
        return t
    }

    /// The pixel size an image is sent at: never enlarged, the long edge at most `longEdge`.
    public static func targetSize(width: Int, height: Int) -> (width: Int, height: Int) {
        let long = max(width, height)
        guard long > longEdge, long > 0 else { return (width, height) }
        let s = Double(longEdge) / Double(long)
        return (max(1, Int((Double(width) * s).rounded())), max(1, Int((Double(height) * s).rounded())))
    }

    public enum Encoding: Equatable, Sendable {
        case png
        case jpeg(quality: Double)
    }

    /// PNG keeps a screenshot's text sharp; past the cap a photo-like image goes JPEG, then lower quality.
    public static func encodings(pngBytes: Int) -> [Encoding] {
        pngBytes <= maxImageBytes ? [.png] : [.jpeg(quality: 0.85), .jpeg(quality: 0.6), .jpeg(quality: 0.4)]
    }

    /// Non-image files travel as text the supervisor can read with `Read` — a
    /// project-relative path in backticks. Never an `@path` token: whatever the
    /// CLI does with one, it would not pass the supervisor's read check.
    public static func fileMentions(_ paths: [String], workDir: String?) -> String {
        guard !paths.isEmpty else { return "" }
        let root = workDir.map { $0.hasSuffix("/") ? $0 : $0 + "/" }
        let shown = paths.map { p -> String in
            if let root, p.hasPrefix(root) { return "`\(p.dropFirst(root.count))`" }
            return "`\(p)`"
        }
        return (paths.count == 1 ? "File: " : "Files: ") + shown.joined(separator: ", ")
    }

    /// The message text with the file mentions after it.
    public static func compose(_ text: String, files: [String], workDir: String?) -> String {
        let mentions = fileMentions(files, workDir: workDir)
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if mentions.isEmpty { return t }
        return t.isEmpty ? mentions : "\(t)\n\n\(mentions)"
    }

    /// What the user's bubble draws: their words, then each image as the
    /// `@/abs/path` token the transcript's bubble already renders as a picture.
    public static func bubbleText(_ text: String, imagePaths: [String]) -> String {
        let tokens = imagePaths.filter { !$0.contains(where: \.isWhitespace) }.map { "@\($0)" }
        return ([text] + tokens).filter { !$0.isEmpty }.joined(separator: "\n")
    }
}

/// ADR-0128 §3 — a supervisor reply renders as Markdown with no actionable
/// element. Every link run loses its link; a URL that was hidden behind other
/// text is kept visible after it, so nothing the reply points at is concealed.
public enum InertMarkdown {
    public static func stripLinks(_ input: AttributedString) -> AttributedString {
        var a = input
        var linked: [(Range<AttributedString.Index>, URL)] = []
        for run in a.runs { if let url = run.link { linked.append((run.range, url)) } }
        // Back to front, so earlier ranges stay valid as text is inserted after them.
        for (range, url) in linked.reversed() {
            a[range].link = nil
            let shown = String(a[range].characters)
            if shown != url.absoluteString { a.characters.insert(contentsOf: " (\(url.absoluteString))", at: range.upperBound) }
        }
        return a
    }
}
