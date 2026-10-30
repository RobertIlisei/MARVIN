// ReplacePattern — the one regular expression Replace All rewrites files with.
//
// Search honours "Aa", "\b" (whole word) and ".*" (regex) on the server, but
// Replace All rebuilt its own match from scratch and ignored whole word: with
// "foo" → "bar" and Whole word on, the list showed `foo` and the write also
// rewrote `foobar` and `food` on disk (audit L6). Replace and search must agree
// on what a match is, so the rule is stated once, here.

import Foundation

public struct ReplacePattern: Sendable {
    public let pattern: String
    public let template: String
    public let options: NSRegularExpression.Options

    /// - Literal mode escapes the query and the replacement, so `a.b` matches
    ///   `a.b` only and `$1` in the replacement stays the two characters `$1`.
    /// - Regex mode keeps the query and the template as typed.
    /// - Whole word wraps either in look-arounds rather than `\b`: `\b` fails
    ///   for a query that starts or ends with a symbol (`@foo`, `foo()`).
    public static func make(
        query: String,
        replacement: String,
        useRegex: Bool,
        wholeWord: Bool,
        caseSensitive: Bool
    ) -> ReplacePattern {
        var body = useRegex ? query : NSRegularExpression.escapedPattern(for: query)
        if wholeWord { body = "(?<!\\w)(?:\(body))(?!\\w)" }
        return ReplacePattern(
            pattern: body,
            template: useRegex ? replacement : NSRegularExpression.escapedTemplate(for: replacement),
            options: caseSensitive ? [] : [.caseInsensitive]
        )
    }

    public func apply(to text: String) throws -> String {
        let rx = try NSRegularExpression(pattern: pattern, options: options)
        let range = NSRange(text.startIndex..., in: text)
        return rx.stringByReplacingMatches(in: text, range: range, withTemplate: template)
    }
}
