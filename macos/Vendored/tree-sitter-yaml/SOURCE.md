# tree-sitter-yaml — vendored

Upstream: https://github.com/tree-sitter-grammars/tree-sitter-yaml
Tag:      v0.7.2

## Why vendored

Upstream's `Package.swift` has a runtime
`FileManager.fileExists(atPath: "src/scanner.c")` check that resolves
against the consumer's cwd (MARVIN's repo root), not the package's
checkout directory. The check fails when the package is loaded
transitively → `scanner.c` is dropped from the build → undefined
`_tree_sitter_yaml_external_scanner_*` symbols at link time. Same
class of bug documented in `Package.swift` for `tree-sitter-python`
and `tree-sitter-css`.

Vendoring with an unconditional sources list bypasses the check.

## What's here

- `src/parser.c`, `src/scanner.c` — compiled into `TreeSitterYAML`.
- `src/schema.{core,json,legacy}.c` — NOT compiled separately;
  `scanner.c` `#include`s one of them via the `YAML_SCHEMA` macro
  (defaults to `core`).
- `src/tree_sitter/{alloc,array,parser}.h` — internal headers
  scanner.c depends on.
- `bindings/swift/TreeSitterYAML/yaml.h` — public C header
  declaring `tree_sitter_yaml()`. SwiftTreeSitter's `Language(language: …)`
  bridges to this.
- `queries/highlights.scm` — capture rules for the highlighter.

## Refreshing

When upstream cuts a new tag worth picking up:

```
cd /tmp && rm -rf tree-sitter-yaml
git clone --depth 1 --branch v<NEW> https://github.com/tree-sitter-grammars/tree-sitter-yaml.git
cp /tmp/tree-sitter-yaml/src/{parser,scanner,schema.core,schema.json,schema.legacy}.c macos/Vendored/tree-sitter-yaml/src/
cp /tmp/tree-sitter-yaml/src/tree_sitter/*.h macos/Vendored/tree-sitter-yaml/src/tree_sitter/
cp /tmp/tree-sitter-yaml/bindings/swift/TreeSitterYAML/yaml.h macos/Vendored/tree-sitter-yaml/bindings/swift/TreeSitterYAML/
cp /tmp/tree-sitter-yaml/queries/highlights.scm macos/Vendored/tree-sitter-yaml/queries/
```

Update the tag line at the top of this file.
