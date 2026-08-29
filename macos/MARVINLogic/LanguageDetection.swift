// LanguageDetection — filename/extension → language id (ADR-0022).
//
// Extracted from `RegexHighlighter` so it can be tested: an executable
// target cannot be linked from `MARVINTests`, and this is the half with the
// edge cases — extensionless files keyed by name (Makefile, Dockerfile,
// .env), extensions that lie, and the long tail the regex highlighter
// covers but tree-sitter does not.
//
// The bug that prompted the move: `FileViewerView` bailed on
// `fileExtension.isEmpty` before ever calling this, so every Makefile and
// Dockerfile rendered as plain text even though both are recognised here.

import Foundation

public enum LanguageDetection {
    public static func languageId(forExtension ext: String, filename: String? = nil) -> String? {
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
}
