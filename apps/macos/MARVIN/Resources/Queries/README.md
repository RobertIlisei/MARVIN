# Tree-sitter highlight queries

Vendored copies of `highlights.scm` from the per-language tree-sitter packages.
Loaded at runtime by `SyntaxHighlighter.swift` via `Bundle.main` so the SPM-
mirror install path doesn't need to extract resources from the language
packages' own bundles.

## Files

| File | Source | Refresh |
|---|---|---|
| `swift.scm` | [alex-pinkus/tree-sitter-swift @ `with-generated-files`](https://github.com/alex-pinkus/tree-sitter-swift/tree/with-generated-files/queries/highlights.scm) | Bump the package pin in `Package.swift` + `project.yml`, then `swift package update` to refresh the SPM cache, then re-copy from `.build/checkouts/tree-sitter-swift/queries/highlights.scm`. |
| `typescript.scm` | [tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript/blob/master/queries/highlights.scm) | Same procedure with `tree-sitter-typescript`. |

## Why vendor instead of loading from the language package's bundle

SPM's resource pipeline copies the `queries/` directory into a per-target
bundle (`TreeSitterSwift_TreeSitterSwift.bundle`), but `Bundle.module` is
only accessible from inside that target. From MARVIN's target we'd have to
locate the bundle by name + URL, and the SPM-mirror install path
(`bin/marvin install-macos-app`) doesn't currently copy SPM-generated
resource bundles into `Contents/Resources/`. Vendoring sidesteps both
problems for ~1000 lines of static query text.

## Phase 5b.3 follow-up

Add `python.scm`, `go.scm`, `rust.scm`, `markdown.scm` here when the
matching tree-sitter packages get added to `Package.swift`. The
`SyntaxHighlighter.languageFor(extension:)` switch picks them up by
filename. No changes needed to the install script — it copies the whole
`Queries/` directory recursively.
