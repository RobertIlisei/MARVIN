# tree-sitter-python — vendored

Upstream: https://github.com/tree-sitter/tree-sitter-python
Commit:   26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64

## Why vendored

Upstream's Package.swift uses the same runtime
`FileManager.fileExists(atPath: "src/scanner.c")` check we
documented as a blocker for tree-sitter-yaml and tree-sitter-css.
When loaded transitively, the cwd is MARVIN's repo root, not the
package checkout, so scanner.c gets dropped from the build →
undefined `_tree_sitter_python_external_scanner_*` symbols at link
time. Vendoring with an unconditional sources list bypasses the bug.

## Refreshing

```
cd /tmp && rm -rf tree-sitter-python
git clone --depth 1 https://github.com/tree-sitter/tree-sitter-python.git
cp /tmp/tree-sitter-python/src/{parser,scanner}.c macos/Vendored/tree-sitter-python/src/
cp /tmp/tree-sitter-python/src/tree_sitter/*.h    macos/Vendored/tree-sitter-python/src/tree_sitter/
cp /tmp/tree-sitter-python/bindings/swift/TreeSitterPython/python.h macos/Vendored/tree-sitter-python/bindings/swift/TreeSitterPython/
cp /tmp/tree-sitter-python/queries/highlights.scm macos/Vendored/tree-sitter-python/queries/
```

Update the commit line at the top of this file.
