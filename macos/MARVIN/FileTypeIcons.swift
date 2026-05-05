// FileTypeIcons — Phase 5d. IDE-style file type recognition. Drives
// the icon + accent colour for file rows in the tree and for tabs in
// the file viewer.
//
// Design constraints:
//
//   • SF Symbols only — they auto-tint and respect the user's system
//     accent colour. Bundled icon sets (Seti, vscode-icons) would
//     bloat the .app and require licence consideration.
//   • Recognise BOTH extensions and well-known filenames
//     (Dockerfile, Makefile, .gitignore, .env). The web tree uses
//     extension-only resolution; we go a step further because
//     IDE-grade recognition is what the user asked for.
//   • One source of truth — both FileTreeRow and the tab bar in
//     FileViewerView call `FileTypeIcon.symbol(for:)` so adding a
//     new file type is one switch case, not two.
//   • Tint per-tier (code / config / data / image / doc) so the
//     tree reads as a colour-coded landscape — VS Code does the
//     same with monochrome icons + per-language tint.

import AppKit
import SwiftUI

enum FileTypeIcon {
    /// One discrete category of file. The case both selects an SF
    /// Symbol AND a tint colour so callers don't have to map twice.
    enum Kind {
        case directory
        case swiftCode
        case typescript
        case javascript
        case go
        case rust
        case python
        case ruby
        case java
        case csharp
        case cpp
        case c
        case php
        case kotlin
        case shell
        case sql
        case markdown
        case json
        case yaml
        case toml
        case xml
        case html
        case css
        case scss
        case dockerfile
        case makefile
        case envFile
        case gitFile
        case lockFile
        case license
        case readme
        case image
        case font
        case archive
        case binary
        case pdf
        case audio
        case video
        case data
        case text
        case unknown
    }

    /// SF Symbol name for the kind. Concrete picks aim for visual
    /// distinctness in a tree of similarly-named files: code uses
    /// `chevron.left.forwardslash.chevron.right`; configs use a
    /// `gearshape`-shaped doc; markup uses a `text.alignleft`-ish
    /// doc; images use `photo`; archives use `archivebox`; etc.
    static func symbol(for kind: Kind) -> String {
        switch kind {
        case .directory:    return "folder.fill"
        case .swiftCode,
             .typescript,
             .javascript,
             .go,
             .rust,
             .python,
             .ruby,
             .java,
             .csharp,
             .cpp,
             .c,
             .php,
             .kotlin:
            return "chevron.left.forwardslash.chevron.right"
        case .shell:        return "terminal.fill"
        case .sql:          return "cylinder.split.1x2"
        case .markdown:     return "doc.richtext"
        case .readme:       return "book.closed"
        case .json,
             .yaml,
             .toml,
             .xml:
            return "doc.badge.gearshape"
        case .html:         return "doc.text.below.ecg"
        case .css, .scss:   return "paintbrush"
        case .dockerfile:   return "shippingbox"
        case .makefile:     return "hammer"
        case .envFile:      return "lock.shield"
        case .gitFile:      return "arrow.triangle.branch"
        case .lockFile:     return "lock"
        case .license:      return "scroll"
        case .image:        return "photo"
        case .font:         return "textformat"
        case .archive:      return "archivebox"
        case .binary:       return "doc.zipper"
        case .pdf:          return "doc.richtext.fill"
        case .audio:        return "waveform"
        case .video:        return "film"
        case .data:         return "tablecells"
        case .text:         return "doc.text"
        case .unknown:      return "doc"
        }
    }

    /// Tint colour for the kind. Returned as SwiftUI Color so SwiftUI
    /// callers (tabs, rows) can apply directly via .foregroundStyle.
    /// The palette is deliberately muted — a directory full of files
    /// shouldn't read as a clown's pocket.
    static func color(for kind: Kind) -> Color {
        switch kind {
        case .directory:
            return .blue
        case .swiftCode:
            return Color(red: 0.95, green: 0.45, blue: 0.30)   // Swift orange
        case .typescript, .javascript:
            return Color(red: 0.30, green: 0.55, blue: 0.92)   // TS blue
        case .go:
            return Color(red: 0.30, green: 0.78, blue: 0.85)   // Gopher cyan
        case .rust:
            return Color(red: 0.85, green: 0.50, blue: 0.30)   // Rust orange
        case .python:
            return Color(red: 0.45, green: 0.65, blue: 0.85)   // Python blue
        case .ruby:
            return Color(red: 0.85, green: 0.25, blue: 0.30)
        case .java, .kotlin:
            return Color(red: 0.85, green: 0.55, blue: 0.20)
        case .csharp, .cpp, .c:
            return Color(red: 0.55, green: 0.45, blue: 0.85)
        case .php:
            return Color(red: 0.55, green: 0.50, blue: 0.80)
        case .shell:
            return Color(red: 0.55, green: 0.65, blue: 0.40)   // green for terminals
        case .sql:
            return Color(red: 0.65, green: 0.55, blue: 0.30)   // database brown
        case .markdown, .readme:
            return Color(red: 0.55, green: 0.65, blue: 0.55)
        case .json, .yaml, .toml, .xml:
            return Color(red: 0.75, green: 0.70, blue: 0.50)   // config tan
        case .html:
            return Color(red: 0.85, green: 0.45, blue: 0.30)
        case .css, .scss:
            return Color(red: 0.55, green: 0.55, blue: 0.85)
        case .dockerfile:
            return Color(red: 0.30, green: 0.55, blue: 0.85)   // Docker blue
        case .makefile:
            return Color(red: 0.55, green: 0.45, blue: 0.40)
        case .envFile:
            return Color(red: 0.85, green: 0.65, blue: 0.30)
        case .gitFile:
            return Color(red: 0.85, green: 0.45, blue: 0.30)
        case .lockFile:
            return .gray
        case .license:
            return Color(red: 0.65, green: 0.65, blue: 0.65)
        case .image:
            return Color(red: 0.55, green: 0.75, blue: 0.55)   // photo green
        case .font:
            return Color(red: 0.65, green: 0.55, blue: 0.65)
        case .archive:
            return Color(red: 0.65, green: 0.55, blue: 0.30)
        case .binary:
            return .gray
        case .pdf:
            return Color(red: 0.85, green: 0.30, blue: 0.30)
        case .audio:
            return Color(red: 0.55, green: 0.65, blue: 0.85)
        case .video:
            return Color(red: 0.65, green: 0.45, blue: 0.65)
        case .data:
            return Color(red: 0.70, green: 0.60, blue: 0.40)
        case .text:
            return .secondary
        case .unknown:
            return .secondary
        }
    }

    /// Resolve a path (or just a filename) into a Kind. The matching
    /// logic prefers special filenames first ("Dockerfile" wins over
    /// the empty extension fallback) and falls back to extension
    /// matching. Case-insensitive throughout because real-world
    /// projects use both `README.md` and `readme.md`.
    static func kind(for path: String) -> Kind {
        let name = (path as NSString).lastPathComponent
        let lower = name.lowercased()
        let ext = (name as NSString).pathExtension.lowercased()

        // Well-known filenames — match before extension. Some have
        // dots (".gitignore") so the extension-based path picks them
        // up as "unknown" otherwise.
        switch lower {
        case "dockerfile", "containerfile":
            return .dockerfile
        case "makefile", "gnumakefile":
            return .makefile
        case "readme", "readme.md", "readme.txt", "readme.rst":
            return .readme
        case "license", "licence", "license.md", "license.txt",
             "copying", "notice":
            return .license
        case ".gitignore", ".gitattributes", ".gitmodules", ".gitkeep":
            return .gitFile
        case ".env", ".env.local", ".env.development", ".env.production",
             ".env.example", ".env.test":
            return .envFile
        case "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
             "cargo.lock", "package.resolved", "gemfile.lock",
             "poetry.lock", "go.sum", "uv.lock", "bun.lockb":
            return .lockFile
        case ".npmignore", ".dockerignore", ".prettierrc",
             ".eslintrc", ".eslintrc.json", ".prettierrc.json",
             ".editorconfig":
            return .json
        default:
            break
        }
        // Dockerfile.<variant> (e.g. Dockerfile.dev, Dockerfile.prod).
        if lower.hasPrefix("dockerfile.") {
            return .dockerfile
        }
        // Makefile.<variant>.
        if lower.hasPrefix("makefile.") {
            return .makefile
        }

        switch ext {
        // Code
        case "swift":
            return .swiftCode
        case "ts", "tsx", "mts", "cts":
            return .typescript
        case "js", "jsx", "mjs", "cjs":
            return .javascript
        case "go":
            return .go
        case "rs":
            return .rust
        case "py", "pyi", "pyw":
            return .python
        case "rb", "rake":
            return .ruby
        case "java":
            return .java
        case "kt", "kts":
            return .kotlin
        case "cs":
            return .csharp
        case "cpp", "cc", "cxx", "hpp", "hh", "hxx":
            return .cpp
        case "c", "h":
            return .c
        case "php":
            return .php
        case "sh", "bash", "zsh", "fish":
            return .shell
        case "sql", "psql", "mysql":
            return .sql

        // Markup / docs
        case "md", "mdx", "markdown":
            return .markdown
        case "rst", "adoc":
            return .text

        // Configuration / data
        case "json", "json5", "jsonc":
            return .json
        case "yaml", "yml":
            return .yaml
        case "toml":
            return .toml
        case "xml", "plist":
            return .xml

        // Web
        case "html", "htm":
            return .html
        case "css":
            return .css
        case "scss", "sass", "less":
            return .scss

        // Images
        case "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp",
             "tiff", "heic", "heif", "icns":
            return .image

        // Fonts
        case "ttf", "otf", "woff", "woff2", "eot":
            return .font

        // Archives
        case "zip", "tar", "gz", "bz2", "xz", "7z", "rar":
            return .archive

        // Binaries / opaque
        case "exe", "dll", "so", "dylib", "a", "o", "wasm":
            return .binary

        // Documents
        case "pdf":
            return .pdf

        // Audio / video
        case "mp3", "wav", "flac", "aac", "ogg", "m4a":
            return .audio
        case "mp4", "mov", "avi", "mkv", "webm", "m4v":
            return .video

        // Data tables / notebooks
        case "csv", "tsv", "parquet", "ipynb":
            return .data

        // Text fallbacks
        case "txt", "log":
            return .text

        // Lock files via extension (catch any not picked up by name).
        case "lock":
            return .lockFile

        default:
            return .unknown
        }
    }
}
