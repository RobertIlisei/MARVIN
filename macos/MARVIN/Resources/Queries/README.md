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
| `go.scm` | [tree-sitter/tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go/blob/master/queries/highlights.scm) | Same procedure with `tree-sitter-go`. |
| `rust.scm` | [tree-sitter/tree-sitter-rust](https://github.com/tree-sitter/tree-sitter-rust/blob/master/queries/highlights.scm) | Same procedure with `tree-sitter-rust`. |

## Why vendor instead of loading from the language package's bundle

SPM's resource pipeline copies the `queries/` directory into a per-target
bundle (`TreeSitterSwift_TreeSitterSwift.bundle`), but `Bundle.module` is
only accessible from inside that target. From MARVIN's target we'd have to
locate the bundle by name + URL, and the SPM-mirror install path
(`bin/marvin install-macos-app`) doesn't currently copy SPM-generated
resource bundles into `Contents/Resources/`. Vendoring sidesteps both
problems for ~1000 lines of static query text.

## Phase 5b.4+ follow-up

`python.scm` and `markdown.scm` are intentionally absent. Both
languages from the ADR-0020 5b list are blocked by SPM-resolution
issues:

- **Python**: `tree-sitter-python`'s `Package.swift` uses a runtime
  `FileManager.fileExists("src/scanner.c")` to conditionally add
  the external scanner. The relative path resolves against SPM's
  cwd, which is the *transitively-loading* package (i.e. MARVIN),
  not the tree-sitter-python checkout. The check fails, scanner.c
  is omitted, the linker errors with undefined
  `_tree_sitter_python_external_scanner_*` symbols. Standalone
  builds work fine. Workarounds (vendor + patch / fork pin / wait
  for upstream fix) need their own commit.

- **Markdown**: `tree-sitter-markdown` depends on
  `tree-sitter/swift-tree-sitter` (a different Swift binding than
  the ChimeHQ `SwiftTreeSitter` we already pin) and ships a dual-
  grammar block + inline pair. Both wrinkles are real but solvable;
  the user-visible upside is small (markdown is mostly prose) so
  it's deferred.

When either lands, drop the `.scm` here, add the language to
`SyntaxHighlighter.HighlightLanguage`, add the SPM dep to
`Package.swift` + `project.yml`, no changes needed to the install
script (it copies the whole `Queries/` directory recursively).
