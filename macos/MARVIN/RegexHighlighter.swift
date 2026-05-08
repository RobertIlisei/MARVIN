// RegexHighlighter — Phase 5e fallback. Tree-sitter is the
// preferred path for every supported language because it
// understands grammar, but when its `Query.init` fails (parser
// version drift, query file missing, predicate compatibility) the
// editor renders as undifferentiated monospace — and the user
// can't tell yaml from sql from html.
//
// This module gives every file SOMETHING. For each language we
// recognise we run a small set of NSRegularExpression passes
// (strings, numbers, comments, keywords) and return spans the
// existing applyHighlights pipeline can apply alongside (or
// instead of) tree-sitter spans.
//
// Why this is fine alongside tree-sitter:
//
//   • Tree-sitter spans land first in iteration order, regex
//     spans land after — but we explicitly fall back ONLY when
//     tree-sitter returned nil or no spans. No double-paint.
//   • The IDE convention (Sublime, Atom, Notepad++ historically,
//     even VS Code's TextMate grammars) is "regex with a couple
//     of capture groups + a token map". Tree-sitter is the
//     newer, better path; regex stays as the last-mile safety
//     net so the user always sees differentiated text.

import AppKit
import Foundation

enum RegexHighlighter {
    /// Token kinds the fallback emits. Each maps to a HighlightTheme
    /// capture name so the existing colouring pipeline picks them up
    /// without a parallel theme.
    private enum Token {
        case string
        case number
        case comment
        case keyword
        case typeRef
        case constant
        case function
        case tag
        case attribute
        case property

        var captureName: String {
            switch self {
            case .string:    return "string"
            case .number:    return "number"
            case .comment:   return "comment"
            case .keyword:   return "keyword"
            case .typeRef:   return "type"
            case .constant:  return "constant"
            case .function:  return "function"
            case .tag:       return "tag"
            case .attribute: return "attribute"
            case .property:  return "property"
            }
        }
    }

    /// Pattern set per language. Patterns are processed in order,
    /// so put more-specific ones first (e.g. comments before
    /// strings, since `// "string"` should be a comment, not a
    /// string-with-comment-text).
    private struct Pattern {
        let regex: String
        let token: Token
        /// Use this capture group instead of the whole match. Group 0
        /// is the whole match; group 1 is what most patterns want.
        let group: Int
    }

    /// Resolve a language id (matching SyntaxHighlighter's
    /// HighlightLanguage rawValue) into a list of regex patterns.
    /// Returns nil if we don't have a fallback (caller should
    /// render plain).
    private static func patterns(for languageId: String) -> [Pattern]? {
        switch languageId {
        case "json":
            return jsonPatterns
        case "yaml", "yml":
            return yamlPatterns
        case "toml":
            return tomlPatterns
        case "html", "xml", "svg":
            return htmlPatterns
        case "css", "scss":
            return cssPatterns
        case "sql":
            return sqlPatterns
        case "markdown", "md":
            return markdownPatterns
        case "python", "py":
            return pythonPatterns
        case "ruby":
            return rubyPatterns
        case "java":
            return javaPatterns
        case "swift":
            return swiftPatterns
        case "typescript", "javascript":
            return jsPatterns
        case "go":
            return goPatterns
        case "rust":
            return rustPatterns
        case "c":
            return cPatterns
        case "cpp":
            return cppPatterns
        case "bash", "shell":
            return bashPatterns
        case "dockerfile":
            return dockerPatterns
        case "makefile":
            return makefilePatterns
        case "ini", "properties":
            return iniPatterns
        case "lua":
            return luaPatterns
        case "perl":
            return perlPatterns
        case "kotlin":
            return kotlinPatterns
        case "php":
            return phpPatterns
        default:
            return nil
        }
    }

    /// Pick a language id from extension + optional filename.
    /// Mirrors SyntaxHighlighter.HighlightLanguage.forExtension but
    /// is broader — covers languages we have NO tree-sitter for
    /// (yaml, sql, python, dockerfile, …) but DO have a fallback
    /// for. That's the whole point: regex catches the long tail.
    static func languageId(forExtension ext: String, filename: String? = nil) -> String? {
        let lower = filename?.lowercased() ?? ""
        // Filename-keyed files (no extension or extension lies).
        if lower == "dockerfile" || lower.hasPrefix("dockerfile.") {
            return "dockerfile"
        }
        if lower == "makefile" || lower == "gnumakefile" || lower.hasPrefix("makefile.") {
            return "makefile"
        }
        if lower == ".gitignore" || lower == ".dockerignore"
            || lower == ".npmignore" || lower == ".prettierignore"
            || lower == ".eslintignore" {
            return "bash" // hash comments + simple words
        }
        if lower == ".env" || lower.hasPrefix(".env.") {
            return "bash"
        }
        if lower.hasPrefix(".bashrc") || lower.hasPrefix(".zshrc")
            || lower.hasPrefix(".profile") || lower.hasPrefix(".bash_profile") {
            return "bash"
        }
        switch ext.lowercased() {
        case "swift": return "swift"
        case "ts", "tsx", "mts", "cts": return "typescript"
        case "js", "jsx", "mjs", "cjs": return "javascript"
        case "go": return "go"
        case "rs": return "rust"
        case "json", "json5", "jsonc": return "json"
        case "yaml", "yml": return "yaml"
        case "toml": return "toml"
        case "html", "htm": return "html"
        case "xml", "svg", "plist": return "xml"
        case "css": return "css"
        case "scss", "sass", "less": return "scss"
        case "sql", "psql": return "sql"
        case "md", "markdown", "mdx": return "markdown"
        case "py", "pyi", "pyw": return "python"
        case "rb", "rake": return "ruby"
        case "java": return "java"
        case "kt", "kts": return "kotlin"
        case "c", "h": return "c"
        case "cpp", "cc", "cxx", "hpp", "hh", "hxx", "mm": return "cpp"
        case "sh", "bash", "zsh", "fish", "ksh": return "bash"
        case "mk": return "makefile"
        case "ini", "cfg", "conf", "properties": return "ini"
        case "lua": return "lua"
        case "pl", "pm": return "perl"
        case "php", "phtml": return "php"
        default: return nil
        }
    }

    /// Run all patterns for `languageId` against `content` and
    /// return a flat list of HighlightSpan (capture name + range).
    /// The caller (FileViewerNSView.applyHighlights) maps capture
    /// names to NSColors via HighlightTheme — same path tree-sitter
    /// spans take.
    static func highlight(
        content: String,
        languageId: String
    ) -> [HighlightSpan] {
        guard let pats = patterns(for: languageId), !content.isEmpty else {
            return []
        }
        var spans: [HighlightSpan] = []
        spans.reserveCapacity(128)
        let ns = content as NSString
        let fullRange = NSRange(location: 0, length: ns.length)
        for p in pats {
            // Multiline by default — comments + heredocs need it.
            // `dotMatchesLineSeparators` is OFF intentionally; each
            // pattern that needs `.` to span newlines uses `[\\s\\S]`.
            let opts: NSRegularExpression.Options = [.anchorsMatchLines]
            guard let regex = try? NSRegularExpression(pattern: p.regex, options: opts) else {
                continue
            }
            regex.enumerateMatches(in: content, options: [], range: fullRange) { match, _, _ in
                guard let match else { return }
                let groupIndex = p.group
                guard groupIndex < match.numberOfRanges else { return }
                let r = match.range(at: groupIndex)
                guard r.location != NSNotFound, r.length > 0 else { return }
                spans.append(HighlightSpan(range: r, captureName: p.token.captureName))
            }
        }
        return spans
    }

    // MARK: - Pattern libraries

    /// Common pieces reused across multiple languages.
    private static let cFamilyKeywords =
        "(?<![A-Za-z0-9_])" +
        "(?:return|if|else|for|while|do|switch|case|default|break|continue|" +
        "void|static|const|extern|inline|sizeof|typedef|struct|union|enum|" +
        "true|false|null|NULL|nullptr|this|new|delete|class|public|private|" +
        "protected|virtual|override|final|template|typename|namespace|using|" +
        "import|export|from|as|let|var|function|async|await|yield|throw|" +
        "try|catch|finally)" +
        "(?![A-Za-z0-9_])"
    private static let dqString = #""(?:\\.|[^"\\])*""#
    private static let sqString = "'(?:\\\\.|[^'\\\\])*'"
    private static let backtickString = "`(?:\\\\.|[^`\\\\])*`"
    private static let lineCommentSlash = "//[^\\n]*"
    private static let lineCommentHash = "(?:^|\\s)#[^\\n]*"
    private static let blockComment = "/\\*[\\s\\S]*?\\*/"
    private static let numberPattern =
        "(?<![A-Za-z0-9_])(?:0[xX][0-9A-Fa-f]+|[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)(?![A-Za-z0-9_])"

    private static let jsonPatterns: [Pattern] = [
        // Keys (string before colon).
        Pattern(regex: "(\"(?:\\\\.|[^\"\\\\])*\")\\s*:", token: .property, group: 1),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
        Pattern(regex: "\\b(?:true|false|null)\\b", token: .constant, group: 0),
    ]

    private static let yamlPatterns: [Pattern] = [
        Pattern(regex: "(?m)^(?:#.*)$", token: .comment, group: 0),
        Pattern(regex: "(?m)^([\\s-]*)([A-Za-z_][\\w-]*)\\s*:", token: .property, group: 2),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: "(?<![A-Za-z0-9_])(?:true|false|null|yes|no|on|off)(?![A-Za-z0-9_])", token: .constant, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let tomlPatterns: [Pattern] = [
        Pattern(regex: "(?m)^\\s*(#.*)$", token: .comment, group: 1),
        Pattern(regex: "(?m)^\\s*\\[([^\\]]+)\\]", token: .typeRef, group: 1),
        Pattern(regex: "(?m)^\\s*([A-Za-z_][\\w-]*)\\s*=", token: .property, group: 1),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: "\\b(?:true|false)\\b", token: .constant, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let htmlPatterns: [Pattern] = [
        Pattern(regex: "<!--[\\s\\S]*?-->", token: .comment, group: 0),
        // Tag names, both opening + closing.
        Pattern(regex: "</?([A-Za-z][\\w-]*)", token: .tag, group: 1),
        // Attribute names (NAME=)
        Pattern(regex: "\\s([A-Za-z_:][\\w:.-]*)\\s*=", token: .attribute, group: 1),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        // Doctype.
        Pattern(regex: "<!DOCTYPE[^>]*>", token: .constant, group: 0),
    ]

    private static let cssPatterns: [Pattern] = [
        Pattern(regex: blockComment, token: .comment, group: 0),
        // Selectors + at-rules (very loose, just for tinting).
        Pattern(regex: "(?m)^\\s*(@[A-Za-z-]+)", token: .keyword, group: 1),
        Pattern(regex: "([A-Za-z-]+)\\s*:", token: .property, group: 1),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: "#[0-9A-Fa-f]{3,8}\\b", token: .constant, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let sqlPatterns: [Pattern] = [
        Pattern(regex: "--[^\\n]*", token: .comment, group: 0),
        Pattern(regex: blockComment, token: .comment, group: 0),
        Pattern(regex: "(?i)\\b(SELECT|FROM|WHERE|GROUP\\s+BY|ORDER\\s+BY|HAVING|LIMIT|OFFSET|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|ON|AS|WITH|UNION|ALL|DISTINCT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|VIEW|INDEX|DROP|ALTER|ADD|COLUMN|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|UNIQUE|NULL|NOT|AND|OR|IN|LIKE|BETWEEN|CASE|WHEN|THEN|ELSE|END|EXISTS|RETURNING)\\b", token: .keyword, group: 0),
        Pattern(regex: "(?i)\\b(INTEGER|INT|BIGINT|VARCHAR|TEXT|BOOLEAN|TIMESTAMP|DATE|TIME|NUMERIC|DECIMAL|REAL|JSON|JSONB|UUID)\\b", token: .typeRef, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let markdownPatterns: [Pattern] = [
        // Code fences first so we don't mis-capture strings inside.
        Pattern(regex: "```[\\s\\S]*?```", token: .string, group: 0),
        Pattern(regex: "`[^`\\n]+`", token: .string, group: 0),
        Pattern(regex: "(?m)^(#{1,6}\\s.*)$", token: .keyword, group: 1),
        Pattern(regex: "\\*\\*([^*\\n]+)\\*\\*", token: .property, group: 1),
        Pattern(regex: "\\*([^*\\n]+)\\*", token: .typeRef, group: 1),
        Pattern(regex: "\\[([^\\]]+)\\]\\(([^)]+)\\)", token: .function, group: 1),
        Pattern(regex: "\\[[^\\]]+\\]\\(([^)]+)\\)", token: .string, group: 1),
        Pattern(regex: "(?m)^>\\s.*$", token: .comment, group: 0),
    ]

    private static let pythonPatterns: [Pattern] = [
        Pattern(regex: "\"\"\"[\\s\\S]*?\"\"\"", token: .string, group: 0),
        Pattern(regex: "'''[\\s\\S]*?'''", token: .string, group: 0),
        Pattern(regex: "(?m)#[^\\n]*", token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: "\\b(def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|global|nonlocal|async|await|self)\\b", token: .keyword, group: 0),
        Pattern(regex: "@[A-Za-z_][\\w]*", token: .function, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let rubyPatterns: [Pattern] = [
        Pattern(regex: "(?m)#[^\\n]*", token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: "\\b(def|end|class|module|if|elsif|else|unless|while|until|for|in|do|return|nil|true|false|self|require|require_relative|begin|rescue|ensure|raise|yield|attr_reader|attr_writer|attr_accessor)\\b", token: .keyword, group: 0),
        Pattern(regex: ":[A-Za-z_][\\w]*", token: .constant, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let javaPatterns: [Pattern] = [
        Pattern(regex: blockComment, token: .comment, group: 0),
        Pattern(regex: lineCommentSlash, token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: "\\b(public|private|protected|static|final|abstract|class|interface|extends|implements|new|return|if|else|for|while|do|switch|case|break|continue|throw|throws|try|catch|finally|import|package|void|null|true|false|this|super|enum)\\b", token: .keyword, group: 0),
        Pattern(regex: "\\b(int|long|short|byte|boolean|char|float|double|String|Integer|Long|Boolean|Character|Float|Double|List|Map|Set)\\b", token: .typeRef, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let swiftPatterns: [Pattern] = [
        Pattern(regex: blockComment, token: .comment, group: 0),
        Pattern(regex: lineCommentSlash, token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: "\\b(let|var|func|class|struct|enum|protocol|extension|return|if|else|guard|switch|case|default|for|in|while|repeat|do|try|catch|throw|throws|rethrows|async|await|public|private|internal|fileprivate|open|static|final|init|deinit|self|Self|nil|true|false|inout|where|associatedtype|typealias|some|any|@MainActor|@Observable|import)\\b", token: .keyword, group: 0),
        Pattern(regex: "\\b(String|Int|Double|Float|Bool|Array|Dictionary|Set|Optional|Result|Error)\\b", token: .typeRef, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let jsPatterns: [Pattern] = [
        Pattern(regex: blockComment, token: .comment, group: 0),
        Pattern(regex: lineCommentSlash, token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: backtickString, token: .string, group: 0),
        Pattern(regex: "\\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|throw|try|catch|finally|class|extends|new|this|super|null|undefined|true|false|import|export|from|as|default|async|await|yield|typeof|instanceof|of|in|delete|void|interface|type|enum|public|private|protected|readonly|static|abstract)\\b", token: .keyword, group: 0),
        Pattern(regex: "\\b(string|number|boolean|object|any|never|unknown|void|Promise|Array|Map|Set|Record|Partial|Required|Readonly|Pick|Omit)\\b", token: .typeRef, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let goPatterns: [Pattern] = [
        Pattern(regex: blockComment, token: .comment, group: 0),
        Pattern(regex: lineCommentSlash, token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: backtickString, token: .string, group: 0),
        Pattern(regex: "\\b(func|var|const|type|struct|interface|map|chan|return|if|else|for|range|switch|case|default|break|continue|fallthrough|go|defer|select|package|import|nil|true|false)\\b", token: .keyword, group: 0),
        Pattern(regex: "\\b(string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|byte|rune|float32|float64|bool|error|any)\\b", token: .typeRef, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let rustPatterns: [Pattern] = [
        Pattern(regex: blockComment, token: .comment, group: 0),
        Pattern(regex: lineCommentSlash, token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: "\\b(fn|let|mut|const|static|struct|enum|impl|trait|pub|use|mod|crate|return|if|else|for|while|loop|match|break|continue|move|ref|self|Self|where|as|in|async|await|dyn|true|false)\\b", token: .keyword, group: 0),
        Pattern(regex: "\\b(String|str|i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|Vec|Option|Result|Box|Rc|Arc|HashMap|HashSet)\\b", token: .typeRef, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let cPatterns: [Pattern] = [
        Pattern(regex: blockComment, token: .comment, group: 0),
        Pattern(regex: lineCommentSlash, token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: "(?m)^\\s*(#\\s*\\w+)", token: .keyword, group: 1),
        Pattern(regex: cFamilyKeywords, token: .keyword, group: 0),
        Pattern(regex: "\\b(int|long|short|char|float|double|bool|void|size_t|ssize_t|ptrdiff_t|FILE)\\b", token: .typeRef, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let cppPatterns: [Pattern] = cPatterns + [
        Pattern(regex: "\\b(std|string|vector|map|unordered_map|set|unordered_set|pair|tuple|shared_ptr|unique_ptr|weak_ptr|optional|variant|function|thread|mutex|atomic)\\b", token: .typeRef, group: 0),
    ]

    private static let bashPatterns: [Pattern] = [
        Pattern(regex: lineCommentHash, token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: backtickString, token: .string, group: 0),
        Pattern(regex: "\\$\\{[^}]+\\}", token: .property, group: 0),
        Pattern(regex: "\\$[A-Za-z_][\\w]*", token: .property, group: 0),
        Pattern(regex: "\\b(if|then|elif|else|fi|case|esac|for|while|until|do|done|in|function|return|break|continue|export|local|readonly|set|unset|source|alias|true|false)\\b", token: .keyword, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    private static let dockerPatterns: [Pattern] = [
        Pattern(regex: lineCommentHash, token: .comment, group: 0),
        Pattern(regex: "(?m)^(FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\\b", token: .keyword, group: 1),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: "\\$\\{[^}]+\\}", token: .property, group: 0),
        Pattern(regex: "\\$[A-Za-z_][\\w]*", token: .property, group: 0),
    ]

    /// Makefile — targets are `name:` at column 0, recipes start
    /// with TAB. Variables are `$(VAR)` / `${VAR}`. Includes the
    /// usual GNU make directives (`include`, `ifeq`, `endif`, …).
    private static let makefilePatterns: [Pattern] = [
        Pattern(regex: "(?m)^\\s*(#.*)$", token: .comment, group: 1),
        // Target rules — line that starts with non-whitespace, has
        // a colon. Capture the target name before the colon.
        Pattern(regex: "(?m)^([A-Za-z0-9_./%-]+)\\s*:(?!=)", token: .function, group: 1),
        // Variable assignments — capture the LHS name.
        Pattern(regex: "(?m)^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*[:?+]?=", token: .property, group: 1),
        // Variable references.
        Pattern(regex: "\\$\\([^)]+\\)", token: .property, group: 0),
        Pattern(regex: "\\$\\{[^}]+\\}", token: .property, group: 0),
        // Directives.
        Pattern(regex: "(?m)^\\s*(include|sinclude|-include|ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|export|unexport|override|vpath)\\b", token: .keyword, group: 1),
        // Common shell built-ins inside recipes.
        Pattern(regex: "\\b(@|-@|set|cd|echo|rm|mkdir|cp|mv|test)\\b", token: .typeRef, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
    ]

    /// INI / properties / .editorconfig / .conf — section headers,
    /// `key=value`, `;` or `#` comments.
    private static let iniPatterns: [Pattern] = [
        Pattern(regex: "(?m)^\\s*([;#].*)$", token: .comment, group: 1),
        Pattern(regex: "(?m)^\\s*\\[([^\\]]+)\\]\\s*$", token: .typeRef, group: 1),
        Pattern(regex: "(?m)^\\s*([A-Za-z_][\\w.-]*)\\s*[:=]", token: .property, group: 1),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: "\\b(?:true|false|yes|no|on|off)\\b", token: .constant, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    /// Lua — `--` line comments, `--[[ … ]]` block comments,
    /// `function`, `local`, `end`, etc.
    private static let luaPatterns: [Pattern] = [
        Pattern(regex: "--\\[\\[[\\s\\S]*?\\]\\]", token: .comment, group: 0),
        Pattern(regex: "(?m)--[^\\n]*", token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: "\\[\\[[\\s\\S]*?\\]\\]", token: .string, group: 0),
        Pattern(regex: "\\b(local|function|end|if|then|elseif|else|for|while|repeat|until|do|in|return|break|goto|and|or|not|nil|true|false|self)\\b", token: .keyword, group: 0),
        Pattern(regex: "\\b(string|table|math|io|os|coroutine|require|pairs|ipairs|tostring|tonumber|print|type|next|pcall|xpcall|setmetatable|getmetatable)\\b", token: .typeRef, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    /// Perl — `#` comments, sigil-prefixed variables (`$`, `@`, `%`),
    /// `sub`, `my`, `our`, regex-flavoured constants. Heredocs are
    /// not handled (regex would need stateful awareness); strings
    /// and comments cover ~90% of real-world Perl.
    private static let perlPatterns: [Pattern] = [
        Pattern(regex: "(?m)#[^\\n]*", token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: "\\b(my|our|local|sub|use|require|package|return|if|elsif|else|unless|while|until|for|foreach|do|last|next|redo|die|warn|print|printf|say|eq|ne|lt|gt|le|ge|cmp|and|or|not|xor)\\b", token: .keyword, group: 0),
        Pattern(regex: "[\\$@%][A-Za-z_][\\w]*", token: .property, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    /// Kotlin — superset of the Java set with Kotlin-specific
    /// keywords (`val`, `var`, `fun`, `data class`, `suspend`, …).
    private static let kotlinPatterns: [Pattern] = [
        Pattern(regex: blockComment, token: .comment, group: 0),
        Pattern(regex: lineCommentSlash, token: .comment, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: "\\b(fun|val|var|class|object|interface|data|sealed|enum|companion|abstract|open|final|override|internal|public|private|protected|inline|reified|suspend|tailrec|operator|infix|external|expect|actual|by|where|init|constructor|when|return|if|else|for|while|do|break|continue|throw|try|catch|finally|null|true|false|this|super|is|in|out|as|typealias|import|package)\\b", token: .keyword, group: 0),
        Pattern(regex: "\\b(Int|Long|Short|Byte|Boolean|Char|Float|Double|String|Unit|Any|Nothing|List|Map|Set|MutableList|MutableMap|MutableSet|Array|Result|Pair|Triple)\\b", token: .typeRef, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]

    /// PHP — `<?php`, `?>`, dollar-prefixed variables, `function`,
    /// `class`, etc. Comments use `//`, `#`, and `/* */`.
    private static let phpPatterns: [Pattern] = [
        Pattern(regex: blockComment, token: .comment, group: 0),
        Pattern(regex: lineCommentSlash, token: .comment, group: 0),
        Pattern(regex: "(?m)#[^\\n]*", token: .comment, group: 0),
        Pattern(regex: "<\\?php|\\?>", token: .keyword, group: 0),
        Pattern(regex: dqString, token: .string, group: 0),
        Pattern(regex: sqString, token: .string, group: 0),
        Pattern(regex: "\\$[A-Za-z_][\\w]*", token: .property, group: 0),
        Pattern(regex: "\\b(function|class|interface|trait|extends|implements|abstract|final|public|private|protected|static|readonly|const|var|new|return|if|elseif|else|for|foreach|while|do|switch|case|default|break|continue|throw|try|catch|finally|use|namespace|require|require_once|include|include_once|null|true|false|this|self|parent|as|instanceof|fn|match|yield|echo|print|array|isset|empty|unset)\\b", token: .keyword, group: 0),
        Pattern(regex: "\\b(int|integer|float|string|bool|boolean|array|object|callable|iterable|void|never|mixed|self|static|never)\\b", token: .typeRef, group: 0),
        Pattern(regex: numberPattern, token: .number, group: 0),
    ]
}
