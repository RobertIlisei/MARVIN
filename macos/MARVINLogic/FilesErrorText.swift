// FilesErrorText — the sentence a person reads when the files service refuses.
//
// 2026-11-26: a link to a capture in /tmp opened the file viewer, which showed
// "Failed to load: The operation couldn't be completed.
// (MARVIN.FilesServiceError error 0.)". `FilesServiceError` is a Swift enum
// with no `LocalizedError`, so `localizedDescription` is the bridged NSError
// text — the enum's case index as an "error code" — and the sidecar's reason
// (`400 {"error":"path-escapes-cwd","message":"This file is outside the
// project and cannot be shown: …"}`) was in the body, unread.
//
// Pure logic, no AppKit — testable from MARVINTests.

import Foundation

public enum FilesErrorText {
    /// What to show for a non-2xx answer: the route's own `message` when it
    /// sent one, else its `reason` / `detail`, else a sentence for the code,
    /// else the status. Never the raw JSON, never an enum dump.
    public static func describe(status: Int, body: String?) -> String {
        let trimmed = (body ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let data = trimmed.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for key in ["message", "reason", "detail"] {
                if let s = obj[key] as? String, !s.isEmpty { return s }
            }
            if let code = obj["error"] as? String, !code.isEmpty {
                return known[code]
                    ?? "The files service refused the request (\(code), HTTP \(status))."
            }
        }
        if status == 404 { return "The file was not found." }
        return "The files service answered HTTP \(status)."
    }

    /// Codes an older sidecar sends without a `message`.
    private static let known: [String: String] = [
        "path-escapes-cwd": "This file is outside the project and cannot be shown.",
        "symlink-escapes-cwd": "This file is outside the project and cannot be shown.",
        "symlink-rejected": "This path is a symbolic link, which MARVIN does not follow.",
        "not-found": "This file does not exist (any more).",
        "is-directory": "This is a folder, not a file.",
        "cwd-not-registered": "This project is not registered with MARVIN, so its files cannot be shown.",
    ]
}
